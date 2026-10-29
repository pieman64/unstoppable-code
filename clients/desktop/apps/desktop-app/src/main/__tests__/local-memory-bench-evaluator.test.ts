import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
} from '@canopy/desktop-shared/types';
import {
  aggregateModelResult,
  appendPackError,
  classifyProviderAuthProbe,
  evaluateConsolidationStore,
  evaluateProbe,
  measureInjectedMemoryLatency,
  resolveBenchModels,
  resolveModelRunStatus,
  resolveScorecardStatus,
  summarizeLatencySamples,
  validateScenarioPack,
  type BenchPackResult,
  type BenchProbeResult,
  type InjectionLocalMemoryBenchPack,
} from '../../../tests/benchmark/local-memory-bench-evaluator';

const packsDir = path.resolve(__dirname, '../../../tests/benchmark/packs');

function loadInjectionPack(
  filename: string,
  source: string,
): InjectionLocalMemoryBenchPack {
  const pack = validateScenarioPack(
    JSON.parse(readFileSync(path.join(packsDir, filename), 'utf8')),
    source,
  );
  if (pack.mode !== 'injection') {
    throw new Error(`${source}: expected an injection pack`);
  }
  return pack;
}

describe('local memory benchmark evaluator', () => {
  it('matches exact case-sensitive literals and reports misses and forbidden hits', () => {
    const result = evaluateProbe({
      reply: 'Use PORT-4721, not LEGACY-1199.',
      latencyMs: 123,
      expect: {
        mustContain: ['PORT-4721', 'Case-Sensitive'],
        mustNotContain: ['LEGACY-1199', 'sk-can2720-never-echo'],
      },
      secretLiterals: ['sk-can2720-never-echo'],
      contradictionOlderLiteral: 'LEGACY-1199',
    });

    expect(result).toMatchObject({
      status: 'failed',
      latencyMs: 123,
      matchedMustContain: ['PORT-4721'],
      missedMustContain: ['Case-Sensitive'],
      matchedMustNotContain: ['LEGACY-1199'],
      leakedSecrets: [],
      contradictionEscape: true,
    });
  });

  it('defaults the model matrix to both provider defaults plus the canary', () => {
    const models = resolveBenchModels(undefined);
    expect(models).toContain(DEFAULT_CLAUDE_MODEL);
    expect(models).toContain(DEFAULT_CODEX_MODEL);
    expect(models).toContain('claude-haiku-4-5-20251001');
    expect(new Set(models).size).toBe(models.length);
    expect(resolveBenchModels(' gpt-5.5 , opus[1m] ')).toEqual([
      'gpt-5.5',
      'opus[1m]',
    ]);
  });

  it('counts required-literal occurrences beyond the first as duplicates', () => {
    const result = evaluateProbe({
      reply: 'PORT-4721 confirmed. Repeat: PORT-4721. Again PORT-4721.',
      latencyMs: 15,
      expect: { mustContain: ['PORT-4721'], mustNotContain: ['LEGACY-1199'] },
      secretLiterals: [],
      contradictionOlderLiteral: 'LEGACY-1199',
    });

    expect(result.status).toBe('passed');
    expect(result.duplicateRequiredOccurrences).toBe(2);
  });

  it('marks a secret-shaped literal as a leak even when it was not listed as forbidden', () => {
    const secret = 'sk-can2720-unit-secret-000000000001';
    const result = evaluateProbe({
      reply: `The value is SAFE-42; debug token ${secret}`,
      latencyMs: 10,
      expect: { mustContain: ['SAFE-42'], mustNotContain: [] },
      secretLiterals: [secret],
      contradictionOlderLiteral: 'OLD-41',
    });

    expect(result.status).toBe('failed');
    expect(result.leakedSecrets).toEqual([secret]);
  });

  it('aggregates recall, false positives, contradictions, leaks, and nearest-rank latency percentiles', () => {
    const packResult: BenchPackResult = {
      id: 'unit-pack',
      title: 'Unit pack',
      status: 'error',
      probes: [
        {
          id: 'one',
          prompt: 'one',
          reply: 'RIGHT SECRET',
          status: 'failed',
          latencyMs: 10,
          matchedMustContain: ['RIGHT'],
          missedMustContain: ['SECOND'],
          matchedMustNotContain: ['SECRET'],
          unmatchedMustNotContain: [],
          leakedSecrets: ['SECRET'],
          duplicateRequiredOccurrences: 2,
          contradictionEscape: false,
          contradictionChecked: false,
        },
        {
          id: 'two',
          prompt: 'two',
          reply: 'OLD',
          status: 'failed',
          latencyMs: 20,
          matchedMustContain: [],
          missedMustContain: ['NEW'],
          matchedMustNotContain: ['OLD'],
          unmatchedMustNotContain: [],
          leakedSecrets: [],
          duplicateRequiredOccurrences: 0,
          contradictionEscape: true,
          contradictionChecked: true,
        },
        {
          id: 'three',
          prompt: 'three',
          reply: 'OK',
          status: 'passed',
          latencyMs: 100,
          matchedMustContain: ['OK'],
          missedMustContain: [],
          matchedMustNotContain: [],
          unmatchedMustNotContain: [],
          leakedSecrets: [],
          duplicateRequiredOccurrences: 1,
          contradictionEscape: false,
          contradictionChecked: true,
        },
        {
          id: 'harness-error',
          prompt: 'never reached the model',
          status: 'error',
          error: 'Electron launch failed',
        },
      ],
    };

    expect(aggregateModelResult([packResult])).toEqual({
      probes: { passed: 1, total: 3, passRate: 1 / 3 },
      recall: { matched: 2, total: 4, rate: 0.5 },
      falsePositive: { hits: 2, total: 2, rate: 1 },
      contradictionEscape: { escapes: 1, checks: 2, rate: 0.5 },
      leaks: { count: 1 },
      duplicates: { extraOccurrences: 3, matchedLiterals: 2, rate: 1.5 },
      latencyMs: { samples: 3, p50: 20, p95: 100 },
    });
    expect(resolveModelRunStatus([packResult])).toBe('errored');
    expect(resolveScorecardStatus(['failed', 'errored'], 0)).toBe('ERRORED');
  });

  it('validates all eleven committed scenario packs across both modes', () => {
    const filenames = readdirSync(packsDir)
      .filter((filename) => filename.endsWith('.json'))
      .sort();

    expect(filenames).toHaveLength(11);
    const validationErrors: string[] = [];
    const ids = filenames.flatMap((filename) => {
      try {
        return [
          validateScenarioPack(
            JSON.parse(readFileSync(path.join(packsDir, filename), 'utf8')),
            filename,
          ).id,
        ];
      } catch (error) {
        validationErrors.push(
          error instanceof Error ? error.message : String(error),
        );
        return [];
      }
    });
    expect(validationErrors).toEqual([]);
    expect(new Set(ids).size).toBe(11);
  });

  it('accepts required literals only in raw sources for a consolidation pack', () => {
    const pack = validateScenarioPack(
      JSON.parse(
        readFileSync(
          path.join(packsDir, '11-consolidation-import.json'),
          'utf8',
        ),
      ),
      'consolidation-raw-source-fixture',
    );

    expect(pack.mode).toBe('consolidation');
    expect(pack.id).toBe('consolidation-import');
  });

  it('rejects a required literal that the production redactor removes from seeded memory', () => {
    const pack = loadInjectionPack(
      '01-service-port.json',
      'redaction-survival-fixture',
    );
    const requiredLiteral = 'LM2720-REDACTION-SURVIVAL-GUARD';
    pack.memory.user.memoryMd += `\n- Required token: ${requiredLiteral}.`;
    pack.probes[1].expect.mustContain = [requiredLiteral];

    expect(() =>
      validateScenarioPack(pack, 'redaction-survival-fixture'),
    ).toThrow(
      'expect.mustContain literal "LM2720-REDACTION-SURVIVAL-GUARD" must survive redaction and reach the injected local-memory block',
    );
  });

  it('rejects an older contradiction literal that never reaches an injected scope index', () => {
    const pack = loadInjectionPack(
      '01-service-port.json',
      'contradiction-injection-fixture',
    );
    const older = pack.contradiction.olderLiteral;
    pack.memory.user.memoryMd = pack.memory.user.memoryMd
      .split('\n')
      .filter((line) => !line.includes(older))
      .join('\n');
    pack.memory.workspace.memoryMd = pack.memory.workspace.memoryMd
      .split('\n')
      .filter((line) => !line.includes(older))
      .join('\n');
    pack.memory.user.topics.push({
      filename: 'older-value.md',
      content: `# Never injected\nThe retired value was ${older}.`,
    });

    expect(() =>
      validateScenarioPack(pack, 'contradiction-injection-fixture'),
    ).toThrow(
      'must plant the older contradiction literal in an injected scope index',
    );
  });

  it('rejects a newer contradiction literal buried beyond the injected recent notes', () => {
    const pack = loadInjectionPack(
      '01-service-port.json',
      'recent-note-injection-fixture',
    );
    for (let index = 0; index < 3; index += 1) {
      pack.memory.user.inbox.push({
        filename: `2026-09-01T0${String(index)}-00-00-newer-note.md`,
        createdAt: `2026-09-01T0${String(index)}:00:00.000Z`,
        content: `Unrelated later note ${String(index)}.`,
      });
    }

    expect(() =>
      validateScenarioPack(pack, 'recent-note-injection-fixture'),
    ).toThrow(
      'must plant the newer contradiction literal in an injected recent inbox note',
    );
  });

  it('rejects a required literal planted only in a never-injected topic', () => {
    const pack = loadInjectionPack(
      '01-service-port.json',
      'topic-only-literal-fixture',
    );
    const topicOnly = 'LM2720-TOPIC-ONLY-LITERAL';
    pack.memory.user.topics.push({
      filename: 'topic-only.md',
      content: `# Topic detail\nThe hidden value is ${topicOnly}.`,
    });
    pack.probes[1].expect.mustContain = [topicOnly];

    expect(() =>
      validateScenarioPack(pack, 'topic-only-literal-fixture'),
    ).toThrow(
      'expect.mustContain literal "LM2720-TOPIC-ONLY-LITERAL" must survive redaction and reach the injected local-memory block',
    );
  });

  it('reports consolidated facts, duplicated facts, and retained junk lines', () => {
    expect(
      evaluateConsolidationStore({
        storeContents: [
          '# Index\n- FACT-A\n- FACT-B\n- LM2749-JUNK-MARKER-one',
          '# Topic\nFACT-B\nLM2749-JUNK-MARKER-two',
        ],
        requiredLiterals: ['FACT-A', 'FACT-B', 'FACT-C'],
        junkMarkers: ['LM2749-JUNK-MARKER-'],
      }),
    ).toEqual({
      factsPresent: 2,
      factsExpected: 3,
      duplicateCopies: 1,
      junkRetained: 2,
    });
  });

  it('classifies auth-probe infrastructure failures as errors, not skips', () => {
    expect(
      classifyProviderAuthProbe('claude', {
        errorMessage: 'spawnSync claude ENOENT',
        status: null,
        stdout: '',
        stderr: '',
      }),
    ).toEqual({
      kind: 'error',
      reason: 'Bundled claude auth probe failed: spawnSync claude ENOENT',
    });
    expect(
      classifyProviderAuthProbe('claude', {
        status: 1,
        stdout: 'Segmentation fault',
        stderr: '',
      }).kind,
    ).toBe('error');
    expect(
      classifyProviderAuthProbe('codex', {
        status: 139,
        stdout: '',
        stderr: 'core dumped',
      }).kind,
    ).toBe('error');
  });

  it('classifies genuine auth states as available or unauthenticated', () => {
    expect(
      classifyProviderAuthProbe('claude', {
        status: 0,
        stdout: '{"loggedIn":true}',
        stderr: '',
      }),
    ).toEqual({ kind: 'available' });
    expect(
      classifyProviderAuthProbe('claude', {
        status: 1,
        stdout: '{"loggedIn":false}',
        stderr: '',
      }).kind,
    ).toBe('unauthenticated');
    expect(
      classifyProviderAuthProbe('codex', {
        status: 0,
        stdout: 'Logged in using ChatGPT',
        stderr: '',
      }),
    ).toEqual({ kind: 'available' });
    expect(
      classifyProviderAuthProbe('codex', {
        status: 0,
        stdout: 'Not logged in',
        stderr: '',
      }).kind,
    ).toBe('unauthenticated');
  });

  it('records a synthetic error when post-probe measurement fails after all probes passed', () => {
    const probes = [
      {
        id: 'one',
        prompt: 'p1',
        expect: { mustContain: ['A'], mustNotContain: ['B'] },
      },
      {
        id: 'two',
        prompt: 'p2',
        expect: { mustContain: ['A'], mustNotContain: ['B'] },
      },
    ];
    const completed: BenchProbeResult[] = probes.map((probe) => ({
      id: probe.id,
      prompt: probe.prompt,
      reply: 'A',
      status: 'passed',
      latencyMs: 5,
      matchedMustContain: ['A'],
      missedMustContain: [],
      matchedMustNotContain: [],
      unmatchedMustNotContain: ['B'],
      leakedSecrets: [],
      duplicateRequiredOccurrences: 0,
      contradictionEscape: false,
      contradictionChecked: false,
    }));

    appendPackError(probes, completed, 'latency measurement failed');

    expect(completed).toHaveLength(3);
    expect(completed[2]).toEqual({
      id: 'memory-injection-latency',
      prompt: 'Measure production memory retrieval + render latency.',
      status: 'error',
      error: 'latency measurement failed',
    });

    const partial: BenchProbeResult[] = completed.slice(0, 1);
    appendPackError(probes, partial, 'launch failed');
    expect(partial).toHaveLength(2);
    expect(partial[1]).toEqual({
      id: 'two',
      prompt: 'p2',
      status: 'error',
      error: 'launch failed',
    });
  });

  it('summarizes latency samples with nearest-rank percentiles', () => {
    expect(summarizeLatencySamples([30, 10, 20])).toEqual({
      samples: 3,
      p50: 20,
      p95: 30,
    });
    expect(summarizeLatencySamples([])).toEqual({
      samples: 0,
      p50: null,
      p95: null,
    });
  });

  it('measures the production retrieval and render path over seeded stores', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'memory-bench-latency-'));
    try {
      const userDir = path.join(root, 'memory');
      const workspaceDir = path.join(root, 'workspace-memory');
      mkdirSync(path.join(userDir, 'inbox'), { recursive: true });
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(
        path.join(userDir, 'MEMORY.md'),
        '# User memory\n- Planted fact.\n',
        'utf8',
      );
      writeFileSync(
        path.join(userDir, 'inbox', '2026-09-01T00-00-00-note.md'),
        '---\ntype: inbox\n---\n\nA recent note.\n',
        'utf8',
      );

      const samples = await measureInjectedMemoryLatency({
        userDir,
        workspaceDir,
        iterations: 3,
      });

      expect(samples).toHaveLength(3);
      for (const sample of samples) {
        expect(sample).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(sample)).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/*
 * CAN-2656 performance scenario: this is intentionally a Jest perf-ish unit
 * benchmark instead of an Electron performance-harness scenario. The desktop
 * harness measures app journeys through visible UI and production IPC, while
 * prepareLocalMemoryContext is an internal main-process turn-start function
 * with no IPC surface. Adding a benchmark-only IPC route would measure and
 * maintain the wrong boundary. This test exercises the real filesystem-backed
 * prepare + render path with a generous absolute regression ceiling.
 *
 * The ceiling applies to the median, not the tail. In a CI shard this suite
 * shares the runner with other Jest workers and its worker process with heap
 * from earlier suites, so preemption and garbage-collection pauses land on
 * the few slowest samples: both wall-clock and process-CPU p95 crossed 20 ms
 * while local p95 stays near 1 ms. The median still fails when every call
 * regresses, whether by extra computation or by waiting. p95 is logged with
 * CANOPY_PERF_TEST_LOG=1 for diagnosis.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { getUserMemoryDir, getWorkspaceConfigPath } from '../lib/paths';
import { readPreferencesFile } from '../lib/preferences-store';
import { prepareLocalMemoryContext } from '../memory/local/prepare';
import { LOCAL_MEMORY_RECALL_BUDGET } from '../memory/local/render';
import { readMemoryIndex } from '../memory/local/store';

const WORKSPACE_ID = 'local-memory-performance';
const WARMUP_ITERATIONS = 5;
const MEASURED_ITERATIONS = 50;
const BUDGET_MS = 20;

function nearCapMemoryIndex(scope: string): string {
  return Array.from({ length: 200 }, (_, index) => {
    const ordinal = String(index + 1).padStart(3, '0');
    return `- ${scope.padEnd(9, '_')} ${ordinal}: near-cap--${'durable memory fact '.repeat(5)}`;
  }).join('\n');
}

function seedScope(
  scopeDir: string,
  scopeLabel: string,
  topicStart: number,
): void {
  mkdirSync(join(scopeDir, 'topics'), { recursive: true });
  mkdirSync(join(scopeDir, 'inbox'), { recursive: true });
  mkdirSync(join(scopeDir, 'imported'), { recursive: true });
  writeFileSync(
    join(scopeDir, 'MEMORY.md'),
    nearCapMemoryIndex(scopeLabel),
    'utf8',
  );

  for (let index = 0; index < 25; index += 1) {
    const ordinal = String(topicStart + index).padStart(2, '0');
    writeFileSync(
      join(scopeDir, 'topics', `topic-${ordinal}.md`),
      `# Topic ${ordinal}\n\n${'Stored topic detail. '.repeat(40)}\n`,
      'utf8',
    );
  }
  for (let index = 0; index < 3; index += 1) {
    writeFileSync(
      join(scopeDir, 'inbox', `2026-08-31-note-${String(index)}.md`),
      `---\ntype: inbox\n---\n\nRecent inbox note ${String(index)} ${'detail '.repeat(40)}\n`,
      'utf8',
    );
    writeFileSync(
      join(scopeDir, 'imported', `staged-${String(index)}.md`),
      `# Staged import ${String(index)}\n\n${'External memory material. '.repeat(40)}\n`,
      'utf8',
    );
  }
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

describe('local memory turn-start performance', () => {
  it('keeps populated-store prepare + render p50 under 20 ms', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'canopy-local-memory-perf-'));
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = dataDir;
    resetResolvedCanopyDataDirForTests();

    try {
      seedScope(join(dataDir, 'memory'), 'user', 0);
      seedScope(
        join(dataDir, 'workspaces', WORKSPACE_ID, 'memory'),
        'workspace',
        25,
      );
      // Project memory fails closed without a readable project config.
      writeFileSync(
        getWorkspaceConfigPath(WORKSPACE_ID),
        `${JSON.stringify({ version: 1, type: 'single-repo', repos: [] })}\n`,
        'utf8',
      );
      writeFileSync(
        join(dataDir, 'preferences.json'),
        `${JSON.stringify({ version: 1, preferences: { localMemoryEnabled: true } })}\n`,
        'utf8',
      );
      expect(getUserMemoryDir()).toBe(join(dataDir, 'memory'));
      expect((await readPreferencesFile()).localMemoryEnabled).toBe(true);
      expect((await readMemoryIndex(join(dataDir, 'memory'))).text).not.toBe(
        '',
      );

      for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
        await prepareLocalMemoryContext({
          userText: 'Use the durable project knowledge for this request.',
          projectId: WORKSPACE_ID,
          worktreeId: 'main',
        });
      }

      const durationsMs: number[] = [];
      for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
        // hrtime.bigint is immune to Jest fake timers leaking from another
        // suite, unlike performance.now (see chatStore.performance.test.ts).
        const startedAt = process.hrtime.bigint();
        const prepared = await prepareLocalMemoryContext({
          userText: 'Use the durable project knowledge for this request.',
          projectId: WORKSPACE_ID,
          worktreeId: 'main',
        });
        durationsMs.push(
          Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        );
        expect(prepared?.renderedBlock).toContain('Project memory:');
        expect(
          Buffer.byteLength(prepared?.renderedBlock ?? '', 'utf8'),
        ).toBeLessThanOrEqual(LOCAL_MEMORY_RECALL_BUDGET.blockBytes);
      }

      const p50Ms = percentile(durationsMs, 0.5);
      const p95Ms = percentile(durationsMs, 0.95);
      if (process.env.CANOPY_PERF_TEST_LOG === '1') {
        process.stdout.write(
          `[perf] local-memory-turn-start iterations=${String(MEASURED_ITERATIONS)} p50=${p50Ms.toFixed(3)}ms p95=${p95Ms.toFixed(3)}ms\n`,
        );
      }
      expect(p50Ms).toBeLessThan(BUDGET_MS);
    } finally {
      if (originalDataDir === undefined) {
        delete process.env.CANOPY_DATA_DIR;
      } else {
        process.env.CANOPY_DATA_DIR = originalDataDir;
      }
      resetResolvedCanopyDataDirForTests();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

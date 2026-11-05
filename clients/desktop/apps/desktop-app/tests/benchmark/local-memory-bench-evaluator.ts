import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
} from '@canopy/desktop-shared/types';
import {
  getBundledClaudeBinaryPath,
  getBundledCodexBinaryPath,
} from '@canopy/desktop-shared/pipelines/config-paths';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { redactMemoryContent } from '@canopy/memory-consolidation/redaction';
import {
  readMemoryIndex,
  readRecentInboxNotes,
} from '../../src/main/memory/local/store';
import { renderLocalMemoryBlock } from '../../src/main/memory/local/render';

export {
  getBundledClaudeBinaryPath,
  getBundledCodexBinaryPath,
  redactMemoryContent,
};

export const LOCAL_MEMORY_BENCH_CANARY_MODEL = 'claude-haiku-4-5-20251001';

export interface LiteralExpectations {
  mustContain: string[];
  mustNotContain: string[];
}

export interface BenchProbe {
  id: string;
  prompt: string;
  expect: LiteralExpectations;
}

export interface BenchFiller {
  line: string;
  count: number;
}

export interface BenchTopic {
  filename: string;
  content: string;
  contentFiller?: BenchFiller;
}

export interface BenchInboxNote {
  filename: string;
  createdAt: string;
  content: string;
  contentFiller?: BenchFiller;
}

export interface BenchMemoryScope {
  memoryMd: string;
  memoryMdFiller?: BenchFiller;
  topics: BenchTopic[];
  inbox: BenchInboxNote[];
}

interface LocalMemoryBenchPackBase {
  version: 1;
  id: string;
  title: string;
  description: string;
  contradiction: {
    olderLiteral: string;
    newerLiteral: string;
  };
  secretLiterals: string[];
  probes: BenchProbe[];
}

export interface InjectionLocalMemoryBenchPack extends LocalMemoryBenchPackBase {
  mode: 'injection';
  memory: {
    user: BenchMemoryScope;
    workspace: BenchMemoryScope;
  };
}

export interface BenchRawImport {
  sourcePath: string;
  filename: string;
  sourceTool: 'claude-code' | 'codex';
  modified: string;
  repo?: string;
  content: string;
  contentFiller?: BenchFiller;
}

export interface BenchRawScope {
  imports: BenchRawImport[];
  inbox: BenchInboxNote[];
}

export interface ConsolidationLocalMemoryBenchPack extends LocalMemoryBenchPackBase {
  mode: 'consolidation';
  junkMarkers: string[];
  rawSources: {
    user: BenchRawScope;
    workspace: BenchRawScope;
  };
}

export type LocalMemoryBenchPack =
  | InjectionLocalMemoryBenchPack
  | ConsolidationLocalMemoryBenchPack;

export interface ConsolidationStoreMetrics {
  factsPresent: number;
  factsExpected: number;
  duplicateCopies: number;
  junkRetained: number;
}

export interface BenchScoredProbeResult {
  id: string;
  prompt: string;
  reply: string;
  status: 'passed' | 'failed';
  latencyMs: number;
  matchedMustContain: string[];
  missedMustContain: string[];
  matchedMustNotContain: string[];
  unmatchedMustNotContain: string[];
  leakedSecrets: string[];
  duplicateRequiredOccurrences: number;
  contradictionEscape: boolean;
  contradictionChecked: boolean;
}

export interface BenchErrorProbeResult {
  id: string;
  prompt: string;
  status: 'error';
  error: string;
}

export type BenchProbeResult = BenchScoredProbeResult | BenchErrorProbeResult;

export interface BenchPackResult {
  id: string;
  title: string;
  status: 'passed' | 'failed' | 'error';
  probes: BenchProbeResult[];
  consolidationStore?: ConsolidationStoreMetrics;
}

export type BenchModelStatus = 'passed' | 'failed' | 'errored' | 'skipped';
export type BenchScorecardStatus = 'SKIPPED' | 'PASSED' | 'FAILED' | 'ERRORED';

export interface BenchModelAggregates {
  probes: { passed: number; total: number; passRate: number };
  recall: { matched: number; total: number; rate: number };
  falsePositive: { hits: number; total: number; rate: number };
  contradictionEscape: { escapes: number; checks: number; rate: number };
  leaks: { count: number };
  duplicates: {
    extraOccurrences: number;
    matchedLiterals: number;
    rate: number;
  };
  latencyMs: { samples: number; p50: number | null; p95: number | null };
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(source: string, field: string, message: string): never {
  throw new Error(`${source}: ${field} ${message}`);
}

function recordAt(
  value: unknown,
  source: string,
  field: string,
): UnknownRecord {
  if (!isRecord(value)) fail(source, field, 'must be an object');
  return value;
}

function stringAt(value: unknown, source: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(source, field, 'must be a non-empty string');
  }
  return value;
}

function timestampAt(value: unknown, source: string, field: string): string {
  const timestamp = stringAt(value, source, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    fail(source, field, 'must be an ISO-compatible timestamp');
  }
  return timestamp;
}

function stringArrayAt(
  value: unknown,
  source: string,
  field: string,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(source, field, 'must be a non-empty string array');
  }
  return value.map((entry, index) =>
    stringAt(entry, source, `${field}[${String(index)}]`),
  );
}

function fillerAt(
  value: unknown,
  source: string,
  field: string,
): BenchFiller | undefined {
  if (value === undefined) return undefined;
  const record = recordAt(value, source, field);
  const count = record.count;
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 500
  ) {
    fail(source, `${field}.count`, 'must be an integer between 1 and 500');
  }
  return {
    line: stringAt(record.line, source, `${field}.line`),
    count,
  };
}

export function expandBenchContent(
  content: string,
  filler: BenchFiller | undefined,
): string {
  if (!filler) return content;
  return `${content}\n${Array.from(
    { length: filler.count },
    (_, index) => `${filler.line} ${String(index + 1).padStart(3, '0')}`,
  ).join('\n')}`;
}

// Mirrors of the production injection pipeline: the seeded stores are written
// through redactMemoryContent, prepareLocalMemoryContext reads the MEMORY.md
// index (store.readMemoryIndex line/byte caps) plus the 3 most recent inbox
// notes per scope under a shared 1,000-char budget (store.readRecentInboxNotes
// with the prepare.ts options), and renderLocalMemoryBlock applies the final
// 6KiB budget with per-section floors. Keep these constants and the clipping
// order in sync with those modules; topics are NOT injected.
const MEMORY_INDEX_MAX_LINES = 200;
const MEMORY_INDEX_MAX_BYTES = 25 * 1024;
const INJECTED_RECENT_MAX_NOTES = 3;
const INJECTED_RECENT_MAX_CHARS = 1_000;

function clipUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.byteLength <= maxBytes) return text;
  return encoded.subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
}

function injectedScopeIndex(scope: BenchMemoryScope): {
  text: string;
  truncated: boolean;
} {
  const redacted = redactMemoryContent(
    expandBenchContent(scope.memoryMd, scope.memoryMdFiller),
  );
  const lineClipped = redacted
    .split('\n')
    .slice(0, MEMORY_INDEX_MAX_LINES)
    .join('\n');
  const text = clipUtf8(lineClipped, MEMORY_INDEX_MAX_BYTES);
  return { text, truncated: text !== redacted };
}

function injectedScopeRecentNotes(scope: BenchMemoryScope): string[] {
  // The benchmark runner stamps each note's mtime from createdAt, so the
  // production mtime-descending selection reduces to createdAt order here.
  const ordered = [...scope.inbox].sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.filename.localeCompare(left.filename),
  );
  const notes: string[] = [];
  let remainingChars = INJECTED_RECENT_MAX_CHARS;
  for (const note of ordered.slice(0, INJECTED_RECENT_MAX_NOTES)) {
    const body = redactMemoryContent(
      expandBenchContent(note.content, note.contentFiller),
    ).trim();
    if (!body) continue;
    const clipped = body.slice(0, remainingChars);
    if (!clipped) break;
    notes.push(clipped);
    remainingChars -= clipped.length;
    if (remainingChars === 0) break;
  }
  return notes;
}

export interface InjectedMemorySurfaces {
  userIndex: string;
  workspaceIndex: string;
  recentNotes: string[];
  renderedBlock: string;
}

export function computeInjectedMemorySurfaces(memory: {
  user: BenchMemoryScope;
  workspace: BenchMemoryScope;
}): InjectedMemorySurfaces {
  const userIndex = injectedScopeIndex(memory.user);
  const workspaceIndex = injectedScopeIndex(memory.workspace);
  const recentNotes = [
    ...injectedScopeRecentNotes(memory.user),
    ...injectedScopeRecentNotes(memory.workspace),
  ];
  return {
    userIndex: userIndex.text,
    workspaceIndex: workspaceIndex.text,
    recentNotes,
    renderedBlock:
      renderLocalMemoryBlock({ userIndex, workspaceIndex, recentNotes }) ?? '',
  };
}

export type BenchProviderAuthClassification =
  | { kind: 'available' }
  | { kind: 'unauthenticated'; reason: string }
  | { kind: 'error'; reason: string };

function claudeLoggedIn(stdout: string): boolean | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'loggedIn' in parsed &&
      typeof parsed.loggedIn === 'boolean'
    ) {
      return parsed.loggedIn;
    }
    return null;
  } catch {
    return null;
  }
}

// Distinguishes "the CLI ran and reported an auth state" (a benign skip) from
// "the probe infrastructure is broken" (spawn failure, timeout, crash, or
// unrecognizable output — an errored lane that must fail the scorecard rather
// than silently skip behind another passing model).
export function classifyProviderAuthProbe(
  provider: 'claude' | 'codex',
  probe: {
    errorMessage?: string;
    status: number | null;
    stdout: string;
    stderr: string;
  },
): BenchProviderAuthClassification {
  if (probe.errorMessage !== undefined) {
    return {
      kind: 'error',
      reason: `Bundled ${provider} auth probe failed: ${probe.errorMessage}`,
    };
  }
  if (provider === 'claude') {
    const loggedIn = claudeLoggedIn(probe.stdout);
    if (loggedIn === true) return { kind: 'available' };
    if (loggedIn === false) {
      return {
        kind: 'unauthenticated',
        reason: 'Claude is not logged in; run `claude auth login` first.',
      };
    }
    return {
      kind: 'error',
      reason: `Bundled claude auth probe exited ${String(probe.status)} without a parseable auth status.`,
    };
  }
  const output = `${probe.stdout}\n${probe.stderr}`;
  if (/not logged in|logged out/i.test(output)) {
    return {
      kind: 'unauthenticated',
      reason: 'Codex is not logged in; run `codex login` first.',
    };
  }
  if (probe.status === 0 && /logged in/i.test(output)) {
    return { kind: 'available' };
  }
  return {
    kind: 'error',
    reason: `Bundled codex auth probe exited ${String(probe.status)} without a recognizable auth status.`,
  };
}

export type BenchProvider = 'claude' | 'codex';

export function modelProvider(model: string): BenchProvider {
  if (/^(?:gpt-|o[134](?:-|$)|codex)/i.test(model)) return 'codex';
  if (/^(?:claude-|opus(?:\[|$)|sonnet(?:\[|$)|haiku(?:\[|$))/i.test(model)) {
    return 'claude';
  }
  throw new Error(
    `Unsupported benchmark model ${JSON.stringify(model)}; list a Claude or Codex model.`,
  );
}

function bundledProviderBinary(
  provider: BenchProvider,
  repoRoot: string,
): string {
  // The canonical resolver anchors `.cache/bin` to process.cwd() only in dev
  // runtime mode, and a plain Playwright worker resolves as prod mode with no
  // guaranteed repo-root cwd. Pin both around the canonical call rather than
  // rebuilding the staged-binary layout here, so supported overrides and
  // future layout changes keep applying.
  const previousCwd = process.cwd();
  const previousCanopyEnv = process.env.CANOPY_ENV;
  const needsRepoRootCwd = previousCwd !== repoRoot;
  if (needsRepoRootCwd) {
    process.chdir(repoRoot);
  }
  process.env.CANOPY_ENV = 'development';
  try {
    return provider === 'claude'
      ? getBundledClaudeBinaryPath()
      : getBundledCodexBinaryPath();
  } finally {
    if (previousCanopyEnv === undefined) {
      delete process.env.CANOPY_ENV;
    } else {
      process.env.CANOPY_ENV = previousCanopyEnv;
    }
    if (needsRepoRootCwd) {
      process.chdir(previousCwd);
    }
  }
}

/** Probes the bundled provider CLI's login, as a real-model bench needs it. */
export function providerAuthStatus(
  provider: BenchProvider,
  repoRoot: string,
): BenchProviderAuthClassification {
  const binary = bundledProviderBinary(provider, repoRoot);
  const args =
    provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'];
  const result = spawnSync(binary, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    timeout: 20_000,
  });
  return classifyProviderAuthProbe(provider, {
    ...(result.error === undefined
      ? {}
      : { errorMessage: result.error.message }),
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

// Records a harness failure on a pack result. Probes that never ran are
// backfilled as errored; when every probe already completed, the failure came
// from post-probe work (e.g. latency measurement), so an explicit synthetic
// error entry is appended — otherwise the pack would report passed while the
// measurement it claims to include silently failed.
export function appendPackError(
  probes: BenchProbe[],
  results: BenchProbeResult[],
  message: string,
): void {
  const missing = probes.slice(results.length);
  for (const probe of missing) {
    results.push({
      id: probe.id,
      prompt: probe.prompt,
      status: 'error',
      error: message,
    });
  }
  if (missing.length === 0) {
    results.push({
      id: 'memory-injection-latency',
      prompt: 'Measure production memory retrieval + render latency.',
      status: 'error',
      error: message,
    });
  }
}

export interface BenchLatencySummary {
  samples: number;
  p50: number | null;
  p95: number | null;
}

export function summarizeLatencySamples(
  samples: number[],
): BenchLatencySummary {
  return {
    samples: samples.length,
    p50: nearestRank(samples, 0.5),
    p95: nearestRank(samples, 0.95),
  };
}

// Times the production retrieval + render path over the seeded on-disk stores
// — the same two index reads, two recent-note reads, and render call that
// prepareLocalMemoryContext performs per turn — so the scorecard can report
// memory retrieval/injection latency separately from end-to-end provider turn
// latency. Keep the read options in sync with prepare.ts.
export async function measureInjectedMemoryLatency(options: {
  userDir: string;
  workspaceDir: string;
  iterations?: number;
}): Promise<number[]> {
  const iterations = options.iterations ?? 20;
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const start = performance.now();
    const [userIndex, workspaceIndex, userRecent, workspaceRecent] =
      await Promise.all([
        readMemoryIndex(options.userDir),
        readMemoryIndex(options.workspaceDir),
        readRecentInboxNotes(options.userDir, {
          maxNotes: 3,
          maxCharsPerNote: 1_000,
        }),
        readRecentInboxNotes(options.workspaceDir, {
          maxNotes: 3,
          maxCharsPerNote: 1_000,
        }),
      ]);
    renderLocalMemoryBlock({
      userIndex,
      workspaceIndex,
      recentNotes: [...userRecent, ...workspaceRecent],
    });
    samples.push(performance.now() - start);
  }
  return samples;
}

function arrayAt(value: unknown, source: string, field: string): unknown[] {
  if (!Array.isArray(value)) fail(source, field, 'must be an array');
  return value;
}

function scopeAt(
  value: unknown,
  source: string,
  field: string,
): BenchMemoryScope {
  const record = recordAt(value, source, field);
  const topics = arrayAt(record.topics, source, `${field}.topics`).map(
    (entry, index): BenchTopic => {
      const item = recordAt(entry, source, `${field}.topics[${String(index)}]`);
      return {
        filename: stringAt(
          item.filename,
          source,
          `${field}.topics[${String(index)}].filename`,
        ),
        content: stringAt(
          item.content,
          source,
          `${field}.topics[${String(index)}].content`,
        ),
        ...(item.contentFiller === undefined
          ? {}
          : {
              contentFiller: fillerAt(
                item.contentFiller,
                source,
                `${field}.topics[${String(index)}].contentFiller`,
              ),
            }),
      };
    },
  );
  const inbox = arrayAt(record.inbox, source, `${field}.inbox`).map(
    (entry, index): BenchInboxNote => {
      const item = recordAt(entry, source, `${field}.inbox[${String(index)}]`);
      return {
        filename: stringAt(
          item.filename,
          source,
          `${field}.inbox[${String(index)}].filename`,
        ),
        createdAt: timestampAt(
          item.createdAt,
          source,
          `${field}.inbox[${String(index)}].createdAt`,
        ),
        content: stringAt(
          item.content,
          source,
          `${field}.inbox[${String(index)}].content`,
        ),
        ...(item.contentFiller === undefined
          ? {}
          : {
              contentFiller: fillerAt(
                item.contentFiller,
                source,
                `${field}.inbox[${String(index)}].contentFiller`,
              ),
            }),
      };
    },
  );
  return {
    memoryMd: stringAt(record.memoryMd, source, `${field}.memoryMd`),
    ...(record.memoryMdFiller === undefined
      ? {}
      : {
          memoryMdFiller: fillerAt(
            record.memoryMdFiller,
            source,
            `${field}.memoryMdFiller`,
          ),
        }),
    topics,
    inbox,
  };
}

function probesAt(value: unknown, source: string): BenchProbe[] {
  const probes = arrayAt(value, source, 'probes').map(
    (entry, index): BenchProbe => {
      const item = recordAt(entry, source, `probes[${String(index)}]`);
      const expectation = recordAt(
        item.expect,
        source,
        `probes[${String(index)}].expect`,
      );
      return {
        id: stringAt(item.id, source, `probes[${String(index)}].id`),
        prompt: stringAt(
          item.prompt,
          source,
          `probes[${String(index)}].prompt`,
        ),
        expect: {
          mustContain: stringArrayAt(
            expectation.mustContain,
            source,
            `probes[${String(index)}].expect.mustContain`,
          ),
          mustNotContain: stringArrayAt(
            expectation.mustNotContain,
            source,
            `probes[${String(index)}].expect.mustNotContain`,
          ),
        },
      };
    },
  );
  if (probes.length < 2 || probes.length > 4) {
    fail(source, 'probes', 'must contain between 2 and 4 probes');
  }
  if (new Set(probes.map((probe) => probe.id)).size !== probes.length) {
    fail(source, 'probes', 'must use unique ids');
  }
  return probes;
}

function rawScopeAt(
  value: unknown,
  source: string,
  field: string,
): BenchRawScope {
  const record = recordAt(value, source, field);
  const imports = arrayAt(record.imports, source, `${field}.imports`).map(
    (entry, index): BenchRawImport => {
      const item = recordAt(
        entry,
        source,
        `${field}.imports[${String(index)}]`,
      );
      const sourceTool = item.sourceTool;
      if (sourceTool !== 'claude-code' && sourceTool !== 'codex') {
        fail(
          source,
          `${field}.imports[${String(index)}].sourceTool`,
          'must be claude-code or codex',
        );
      }
      const filename = stringAt(
        item.filename,
        source,
        `${field}.imports[${String(index)}].filename`,
      );
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(filename)) {
        fail(
          source,
          `${field}.imports[${String(index)}].filename`,
          'must be a valid staged markdown filename',
        );
      }
      return {
        sourcePath: stringAt(
          item.sourcePath,
          source,
          `${field}.imports[${String(index)}].sourcePath`,
        ),
        filename,
        sourceTool,
        modified: timestampAt(
          item.modified,
          source,
          `${field}.imports[${String(index)}].modified`,
        ),
        ...(item.repo === undefined
          ? {}
          : {
              repo: stringAt(
                item.repo,
                source,
                `${field}.imports[${String(index)}].repo`,
              ),
            }),
        content: stringAt(
          item.content,
          source,
          `${field}.imports[${String(index)}].content`,
        ),
        ...(item.contentFiller === undefined
          ? {}
          : {
              contentFiller: fillerAt(
                item.contentFiller,
                source,
                `${field}.imports[${String(index)}].contentFiller`,
              ),
            }),
      };
    },
  );
  const inbox = arrayAt(record.inbox, source, `${field}.inbox`).map(
    (entry, index): BenchInboxNote => {
      const item = recordAt(entry, source, `${field}.inbox[${String(index)}]`);
      return {
        filename: stringAt(
          item.filename,
          source,
          `${field}.inbox[${String(index)}].filename`,
        ),
        createdAt: timestampAt(
          item.createdAt,
          source,
          `${field}.inbox[${String(index)}].createdAt`,
        ),
        content: stringAt(
          item.content,
          source,
          `${field}.inbox[${String(index)}].content`,
        ),
        ...(item.contentFiller === undefined
          ? {}
          : {
              contentFiller: fillerAt(
                item.contentFiller,
                source,
                `${field}.inbox[${String(index)}].contentFiller`,
              ),
            }),
      };
    },
  );
  return { imports, inbox };
}

function validateSecretContracts(options: {
  source: string;
  field: string;
  contents: string[];
  secretLiterals: string[];
  probes: BenchProbe[];
}): void {
  for (const secret of options.secretLiterals) {
    const plantedContent = options.contents.filter((content) =>
      content.includes(secret),
    );
    if (plantedContent.length === 0) {
      fail(
        options.source,
        options.field,
        `must plant secret literal ${JSON.stringify(secret)}`,
      );
    }
    if (
      plantedContent.some((content) =>
        redactMemoryContent(content).includes(secret),
      )
    ) {
      fail(
        options.source,
        'secretLiterals',
        `${JSON.stringify(secret)} must be caught by the production memory redactor`,
      );
    }
    if (
      !options.probes.every((probe) =>
        probe.expect.mustNotContain.includes(secret),
      )
    ) {
      fail(
        options.source,
        'probes',
        `must forbid secret literal ${JSON.stringify(secret)} in every reply`,
      );
    }
  }
}

function validateContradictionProbe(
  source: string,
  probes: BenchProbe[],
  contradiction: { olderLiteral: string; newerLiteral: string },
): void {
  const contradictionProbes = probes.filter(
    (probe) =>
      probe.expect.mustContain.includes(contradiction.newerLiteral) &&
      probe.expect.mustNotContain.includes(contradiction.olderLiteral),
  );
  if (contradictionProbes.length === 0) {
    fail(
      source,
      'probes',
      'must include a probe that requires the newer contradiction literal and forbids the older one',
    );
  }
}

export function validateScenarioPack(
  value: unknown,
  source = 'scenario pack',
): LocalMemoryBenchPack {
  const record = recordAt(value, source, 'root');
  if (record.version !== 1) fail(source, 'version', 'must equal 1');
  const contradictionRecord = recordAt(
    record.contradiction,
    source,
    'contradiction',
  );
  const contradiction = {
    olderLiteral: stringAt(
      contradictionRecord.olderLiteral,
      source,
      'contradiction.olderLiteral',
    ),
    newerLiteral: stringAt(
      contradictionRecord.newerLiteral,
      source,
      'contradiction.newerLiteral',
    ),
  };
  if (contradiction.olderLiteral === contradiction.newerLiteral) {
    fail(source, 'contradiction', 'must use distinct old and new literals');
  }
  const secretLiterals = stringArrayAt(
    record.secretLiterals,
    source,
    'secretLiterals',
  );
  const probes = probesAt(record.probes, source);
  validateContradictionProbe(source, probes, contradiction);
  const base: LocalMemoryBenchPackBase = {
    version: 1,
    id: stringAt(record.id, source, 'id'),
    title: stringAt(record.title, source, 'title'),
    description: stringAt(record.description, source, 'description'),
    contradiction,
    secretLiterals,
    probes,
  };

  if (record.mode === 'consolidation') {
    const rawRecord = recordAt(record.rawSources, source, 'rawSources');
    const rawSources = {
      user: rawScopeAt(rawRecord.user, source, 'rawSources.user'),
      workspace: rawScopeAt(
        rawRecord.workspace,
        source,
        'rawSources.workspace',
      ),
    };
    const imports = [
      ...rawSources.user.imports,
      ...rawSources.workspace.imports,
    ];
    const inbox = [...rawSources.user.inbox, ...rawSources.workspace.inbox];
    if (imports.length < 2 || inbox.length === 0) {
      fail(
        source,
        'rawSources',
        'must include at least two staged imports and one inbox note',
      );
    }
    const importContents = imports.map((item) =>
      expandBenchContent(item.content, item.contentFiller),
    );
    const inboxContents = inbox.map((item) =>
      expandBenchContent(item.content, item.contentFiller),
    );
    const rawContents = [...importContents, ...inboxContents];
    if (
      !importContents.some((content) =>
        redactMemoryContent(content).includes(contradiction.olderLiteral),
      )
    ) {
      fail(
        source,
        'rawSources.imports',
        'must plant the older contradiction literal in a staged import',
      );
    }
    if (
      !inboxContents.some((content) =>
        redactMemoryContent(content).includes(contradiction.newerLiteral),
      )
    ) {
      fail(
        source,
        'rawSources.inbox',
        'must plant the newer contradiction literal in an inbox note',
      );
    }
    const requiredLiterals = Array.from(
      new Set(probes.flatMap((probe) => probe.expect.mustContain)),
    );
    for (const literal of requiredLiterals) {
      if (
        !rawContents.some((content) =>
          redactMemoryContent(content).includes(literal),
        )
      ) {
        fail(
          source,
          'probes.expect.mustContain',
          `literal ${JSON.stringify(literal)} must survive redaction in raw consolidation sources`,
        );
      }
    }
    if (
      !requiredLiterals.some(
        (literal) =>
          importContents.filter((content) => content.includes(literal)).length >
          1,
      )
    ) {
      fail(
        source,
        'rawSources.imports',
        'must duplicate at least one required literal across staged imports',
      );
    }
    const junkMarkers = stringArrayAt(
      record.junkMarkers,
      source,
      'junkMarkers',
    );
    for (const marker of junkMarkers) {
      if (!rawContents.some((content) => content.includes(marker))) {
        fail(
          source,
          'junkMarkers',
          `must plant junk marker ${JSON.stringify(marker)} in raw sources`,
        );
      }
      if (requiredLiterals.some((literal) => literal.includes(marker))) {
        fail(source, 'junkMarkers', 'must not overlap required literals');
      }
    }
    validateSecretContracts({
      source,
      field: 'rawSources',
      contents: rawContents,
      secretLiterals,
      probes,
    });
    return { ...base, mode: 'consolidation', junkMarkers, rawSources };
  }
  if (record.mode !== undefined && record.mode !== 'injection') {
    fail(source, 'mode', 'must be injection or consolidation');
  }

  const memoryRecord = recordAt(record.memory, source, 'memory');
  const memory = {
    user: scopeAt(memoryRecord.user, source, 'memory.user'),
    workspace: scopeAt(memoryRecord.workspace, source, 'memory.workspace'),
  };

  const allTopics = [...memory.user.topics, ...memory.workspace.topics];
  const allInbox = [...memory.user.inbox, ...memory.workspace.inbox];
  if (allTopics.length === 0 || allInbox.length === 0) {
    fail(source, 'memory', 'must include at least one topic and inbox note');
  }
  // Only injected surfaces count: probes are graded against what the model
  // can actually see, so the stale contradiction value must live in a scope
  // index and the newer value in a recent inbox note that survives the
  // production selection and budgets — not in never-injected topics.
  const injected = computeInjectedMemorySurfaces(memory);
  if (
    !injected.userIndex.includes(contradiction.olderLiteral) &&
    !injected.workspaceIndex.includes(contradiction.olderLiteral)
  ) {
    fail(
      source,
      'memory.memoryMd',
      'must plant the older contradiction literal in an injected scope index',
    );
  }
  if (
    !injected.recentNotes.some((note) =>
      note.includes(contradiction.newerLiteral),
    )
  ) {
    fail(
      source,
      'memory.inbox',
      'must plant the newer contradiction literal in an injected recent inbox note',
    );
  }
  const memoryContents = [memory.user, memory.workspace].flatMap((scope) => [
    expandBenchContent(scope.memoryMd, scope.memoryMdFiller),
    ...scope.topics.map((topic) =>
      expandBenchContent(topic.content, topic.contentFiller),
    ),
    ...scope.inbox.map((note) =>
      expandBenchContent(note.content, note.contentFiller),
    ),
  ]);
  probes.forEach((probe: BenchProbe, probeIndex: number) => {
    for (const literal of probe.expect.mustContain) {
      if (!injected.renderedBlock.includes(literal)) {
        fail(
          source,
          `probes[${String(probeIndex)}].expect.mustContain`,
          `literal ${JSON.stringify(literal)} must survive redaction and reach the injected local-memory block`,
        );
      }
    }
  });
  validateSecretContracts({
    source,
    field: 'memory',
    contents: memoryContents,
    secretLiterals,
    probes,
  });

  return { ...base, mode: 'injection', memory };
}

export function resolveBenchModels(raw: string | undefined): string[] {
  // Default matrix per CAN-2720: the canopy default model per provider plus
  // one cheap canary. An unauthenticated provider lane records a skip; only
  // an all-skip run fails.
  const candidates = raw?.trim()
    ? raw.split(',').map((model) => model.trim())
    : [
        DEFAULT_CLAUDE_MODEL,
        DEFAULT_CODEX_MODEL,
        LOCAL_MEMORY_BENCH_CANARY_MODEL,
      ];
  const models = candidates.filter((model) => model.length > 0);
  return Array.from(new Set(models));
}

function countOccurrences(text: string, literal: string): number {
  if (literal.length === 0) return 0;
  let count = 0;
  let index = text.indexOf(literal);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(literal, index + literal.length);
  }
  return count;
}

export function evaluateConsolidationStore(input: {
  storeContents: string[];
  requiredLiterals: string[];
  junkMarkers: string[];
}): ConsolidationStoreMetrics {
  const combined = input.storeContents.join('\n');
  const factsPresent = input.requiredLiterals.filter(
    (literal) => countOccurrences(combined, literal) > 0,
  ).length;
  const duplicateCopies = input.requiredLiterals.filter(
    (literal) => countOccurrences(combined, literal) > 1,
  ).length;
  const junkRetained = input.storeContents
    .flatMap((content) => content.split('\n'))
    .filter((line) =>
      input.junkMarkers.some((marker) => line.includes(marker)),
    ).length;
  return {
    factsPresent,
    factsExpected: input.requiredLiterals.length,
    duplicateCopies,
    junkRetained,
  };
}

export function evaluateProbe(input: {
  reply: string;
  latencyMs: number;
  expect: LiteralExpectations;
  secretLiterals: string[];
  contradictionOlderLiteral: string;
}): Omit<BenchScoredProbeResult, 'id' | 'prompt' | 'reply'> {
  const matchedMustContain = input.expect.mustContain.filter((literal) =>
    input.reply.includes(literal),
  );
  const missedMustContain = input.expect.mustContain.filter(
    (literal) => !input.reply.includes(literal),
  );
  const matchedMustNotContain = input.expect.mustNotContain.filter((literal) =>
    input.reply.includes(literal),
  );
  const unmatchedMustNotContain = input.expect.mustNotContain.filter(
    (literal) => !input.reply.includes(literal),
  );
  const leakedSecrets = input.secretLiterals.filter((literal) =>
    input.reply.includes(literal),
  );
  // Duplicate-rate metric (CAN-2720): exact occurrences of each required
  // literal beyond the first. Reported, not pass/fail — repetition signals
  // failed dedup pressure, not an incorrect answer.
  const duplicateRequiredOccurrences = matchedMustContain.reduce(
    (total, literal) =>
      total + Math.max(0, countOccurrences(input.reply, literal) - 1),
    0,
  );
  const contradictionChecked = input.expect.mustNotContain.includes(
    input.contradictionOlderLiteral,
  );
  const contradictionEscape =
    contradictionChecked &&
    input.reply.includes(input.contradictionOlderLiteral);
  const passed =
    missedMustContain.length === 0 &&
    matchedMustNotContain.length === 0 &&
    leakedSecrets.length === 0;
  return {
    status: passed ? 'passed' : 'failed',
    latencyMs: input.latencyMs,
    matchedMustContain,
    missedMustContain,
    matchedMustNotContain,
    unmatchedMustNotContain,
    leakedSecrets,
    duplicateRequiredOccurrences,
    contradictionEscape,
    contradictionChecked,
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function nearestRank(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? null;
}

export function aggregateModelResult(
  packs: BenchPackResult[],
): BenchModelAggregates {
  const probes = packs
    .flatMap((pack) => pack.probes)
    .filter(
      (probe): probe is BenchScoredProbeResult => probe.status !== 'error',
    );
  const passed = probes.filter((probe) => probe.status === 'passed').length;
  const recallMatched = probes.reduce(
    (total, probe) => total + probe.matchedMustContain.length,
    0,
  );
  const recallTotal = probes.reduce(
    (total, probe) =>
      total + probe.matchedMustContain.length + probe.missedMustContain.length,
    0,
  );
  const falsePositiveHits = probes.reduce(
    (total, probe) => total + probe.matchedMustNotContain.length,
    0,
  );
  const falsePositiveTotal = probes.reduce(
    (total, probe) =>
      total +
      probe.matchedMustNotContain.length +
      probe.unmatchedMustNotContain.length,
    0,
  );
  const contradictionChecks = probes.filter(
    (probe) => probe.contradictionChecked,
  ).length;
  const contradictionEscapes = probes.filter(
    (probe) => probe.contradictionEscape,
  ).length;
  const leakCount = probes.reduce(
    (total, probe) => total + probe.leakedSecrets.length,
    0,
  );
  const duplicateExtras = probes.reduce(
    (total, probe) => total + probe.duplicateRequiredOccurrences,
    0,
  );
  const latencies = probes.map((probe) => probe.latencyMs);
  return {
    probes: {
      passed,
      total: probes.length,
      passRate: rate(passed, probes.length),
    },
    recall: {
      matched: recallMatched,
      total: recallTotal,
      rate: rate(recallMatched, recallTotal),
    },
    falsePositive: {
      hits: falsePositiveHits,
      total: falsePositiveTotal,
      rate: rate(falsePositiveHits, falsePositiveTotal),
    },
    contradictionEscape: {
      escapes: contradictionEscapes,
      checks: contradictionChecks,
      rate: rate(contradictionEscapes, contradictionChecks),
    },
    leaks: { count: leakCount },
    duplicates: {
      extraOccurrences: duplicateExtras,
      matchedLiterals: recallMatched,
      rate: recallMatched === 0 ? 0 : duplicateExtras / recallMatched,
    },
    latencyMs: {
      samples: latencies.length,
      p50: nearestRank(latencies, 0.5),
      p95: nearestRank(latencies, 0.95),
    },
  };
}

export function resolveModelRunStatus(
  packs: BenchPackResult[],
): Exclude<BenchModelStatus, 'skipped'> {
  if (packs.some((pack) => pack.status === 'error')) return 'errored';
  return packs.every((pack) => pack.status === 'passed') ? 'passed' : 'failed';
}

export function resolveScorecardStatus(
  modelStatuses: BenchModelStatus[],
  leakCount: number,
): BenchScorecardStatus {
  const completedStatuses = modelStatuses.filter(
    (status) => status !== 'skipped',
  );
  if (completedStatuses.length === 0) return 'SKIPPED';
  if (completedStatuses.includes('errored')) return 'ERRORED';
  return leakCount > 0 || completedStatuses.includes('failed')
    ? 'FAILED'
    : 'PASSED';
}

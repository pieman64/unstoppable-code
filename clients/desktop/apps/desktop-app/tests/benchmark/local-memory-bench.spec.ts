// CAN-2720 — manually-run, real-model local-memory benchmark.
//
// This suite intentionally has its own Playwright config and no mock-server
// webServer. It launches the E2E build only for its stable UI/harness seams,
// clears the build-gated LLM redirect, preserves the developer's provider auth
// state, and sends short one-turn probes through the bundled provider binary.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type {
  CanopyApi,
  LocalMemoryConsolidationStatus,
  LocalMemoryScopeRequest,
} from '@canopy/desktop-shared/types';
import type { ElectronApplication, Page } from 'playwright-core';
import type { ImportState } from '../../src/main/memory/local/import/ledger';
import {
  CanopyAppDriver,
  closeCanopy,
  launchCanopy,
  seedDemoWorkspaces,
  seedWorktreeChat,
} from './local-memory-bench-harness.mjs';
import benchEvaluator from './local-memory-bench-runtime.mjs';
import type {
  BenchLatencySummary,
  BenchMemoryScope,
  BenchModelAggregates,
  BenchModelStatus,
  BenchProvider,
  BenchProviderAuthClassification,
  ConsolidationLocalMemoryBenchPack,
  ConsolidationStoreMetrics,
  BenchPackResult,
  BenchProbe,
  BenchProbeResult,
  LocalMemoryBenchPack,
} from './local-memory-bench-evaluator';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

const {
  aggregateModelResult,
  appendPackError,
  evaluateConsolidationStore,
  evaluateProbe,
  expandBenchContent,
  measureInjectedMemoryLatency,
  modelProvider,
  providerAuthStatus,
  redactMemoryContent,
  resolveBenchModels,
  resolveModelRunStatus,
  resolveScorecardStatus,
  summarizeLatencySamples,
  validateScenarioPack,
} = benchEvaluator;

interface SkippedPackResult {
  id: string;
  title: string;
  status: 'skipped';
  probes: Array<{
    id: string;
    prompt: string;
    status: 'skipped';
    reason: string;
  }>;
}

interface CompletedModelResult {
  provider: BenchProvider;
  status: Exclude<BenchModelStatus, 'skipped'>;
  packs: Record<string, BenchPackResult>;
  aggregates: BenchModelAggregates;
  // Production retrieval + render timings over the seeded stores, reported
  // separately from the provider-dominated end-to-end probe latency.
  memoryInjectionLatencyMs: BenchLatencySummary;
}

interface SkippedModelResult {
  provider: BenchProvider;
  status: 'skipped';
  skipReason: string;
  packs: Record<string, SkippedPackResult>;
}

// A provider whose auth probe hit an infrastructure failure (broken binary,
// spawn error, timeout, unrecognizable output) — distinct from a benign
// unauthenticated skip, and forces the scorecard to ERRORED.
interface AuthErroredModelResult {
  provider: BenchProvider;
  status: 'errored';
  error: string;
  packs: Record<string, SkippedPackResult>;
}

type BenchModelResult =
  | CompletedModelResult
  | SkippedModelResult
  | AuthErroredModelResult;

interface BenchScorecard {
  schemaVersion: 1;
  benchmark: 'CAN-2720-local-memory';
  startedAt: string;
  completedAt: string;
  status: 'RUNNING' | 'SKIPPED' | 'PASSED' | 'FAILED' | 'ERRORED';
  scorecardPath: string;
  selection: { models: string[]; packs: string[] };
  models: Record<string, BenchModelResult>;
  aggregates: { leaks: { count: number } };
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../../..');
const packsDir = path.join(currentDir, 'packs');
const scorecardDir = path.join(repoRoot, '.performance', 'local-memory-bench');
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const PROBE_TIMEOUT_MS = Number.parseInt(
  process.env.CANOPY_MEMORY_BENCH_PROBE_TIMEOUT_MS ?? '180000',
  10,
);
// Debug seam: keep each pack's userDataDir on disk (prints the path) so a
// failing run's consolidated store and ledgers can be inspected post-mortem.
const KEEP_DATA = process.env.CANOPY_MEMORY_BENCH_KEEP_DATA === '1';

function loadPacks(): LocalMemoryBenchPack[] {
  const available = readdirSync(packsDir)
    .filter((filename) => filename.endsWith('.json'))
    .sort()
    .map((filename) =>
      validateScenarioPack(
        JSON.parse(readFileSync(path.join(packsDir, filename), 'utf8')),
        filename,
      ),
    );
  const rawFilter = process.env.CANOPY_MEMORY_BENCH_PACKS?.trim();
  if (!rawFilter) {
    return available.filter((pack) => pack.mode === 'injection');
  }
  const requested = new Set<string>(
    rawFilter
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  const selected = available.filter((pack) => requested.has(pack.id));
  const matched = new Set<string>(
    selected.map((pack: LocalMemoryBenchPack) => pack.id),
  );
  const unknown = [...requested].filter((entry: string) => !matched.has(entry));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown CANOPY_MEMORY_BENCH_PACKS entries: ${unknown.join(', ')}`,
    );
  }
  return selected;
}

function writePrivateFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
}

function seedScope(scopeDir: string, scope: BenchMemoryScope): void {
  mkdirSync(scopeDir, { recursive: true, mode: 0o700 });
  writePrivateFile(
    path.join(scopeDir, 'manifest.json'),
    `${JSON.stringify({ version: 1 }, null, 2)}\n`,
  );
  writePrivateFile(
    path.join(scopeDir, 'MEMORY.md'),
    `${redactMemoryContent(
      expandBenchContent(scope.memoryMd, scope.memoryMdFiller),
    )}\n`,
  );
  for (const topic of scope.topics) {
    writePrivateFile(
      path.join(scopeDir, 'topics', topic.filename),
      `${redactMemoryContent(
        expandBenchContent(topic.content, topic.contentFiller),
      )}\n`,
    );
  }
  for (const note of scope.inbox) {
    const noteContent = redactMemoryContent(
      expandBenchContent(note.content, note.contentFiller),
    );
    const notePath = path.join(scopeDir, 'inbox', note.filename);
    writePrivateFile(
      notePath,
      `---\nsource:\n  provider: "benchmark"\n  chatId: "CAN-2720"\ncreated: ${JSON.stringify(
        note.createdAt,
      )}\nmodified: ${JSON.stringify(note.createdAt)}\ntype: inbox\n---\n\n${noteContent}\n`,
    );
    const timestamp = new Date(note.createdAt);
    utimesSync(notePath, timestamp, timestamp);
  }
}

function seedRawScope(
  scopeDir: string,
  scope: ConsolidationLocalMemoryBenchPack['rawSources']['user'],
  scopeLabel: 'User' | 'Workspace',
): void {
  mkdirSync(scopeDir, { recursive: true, mode: 0o700 });
  writePrivateFile(
    path.join(scopeDir, 'manifest.json'),
    `${JSON.stringify({ version: 1 }, null, 2)}\n`,
  );
  writePrivateFile(
    path.join(scopeDir, 'MEMORY.md'),
    `# ${scopeLabel} memory\n`,
  );
  const sources: ImportState['sources'] = {};
  for (const imported of scope.imports) {
    const rawContent = expandBenchContent(
      imported.content,
      imported.contentFiller,
    );
    const stagedAs = `imported/${imported.filename}`;
    const stagedPath = path.join(scopeDir, stagedAs);
    writePrivateFile(stagedPath, `${redactMemoryContent(rawContent)}\n`);
    const timestamp = new Date(imported.modified);
    utimesSync(stagedPath, timestamp, timestamp);
    sources[imported.sourcePath] = {
      fileHash: createHash('sha256').update(rawContent).digest('hex'),
      importedAt: imported.modified,
      checkedAt: imported.modified,
      stagedAs,
      ...(imported.repo === undefined ? {} : { repo: imported.repo }),
      modified: imported.modified,
      sourceTool: imported.sourceTool,
    };
  }
  writePrivateFile(
    path.join(scopeDir, 'import-state.json'),
    `${JSON.stringify({ version: 1, sources }, null, 2)}\n`,
  );
  for (const note of scope.inbox) {
    const noteContent = redactMemoryContent(
      expandBenchContent(note.content, note.contentFiller),
    );
    const notePath = path.join(scopeDir, 'inbox', note.filename);
    writePrivateFile(
      notePath,
      `---\nsource:\n  provider: "benchmark"\n  chatId: "CAN-2749"\ncreated: ${JSON.stringify(
        note.createdAt,
      )}\nmodified: ${JSON.stringify(note.createdAt)}\ntype: inbox\n---\n\n${noteContent}\n`,
    );
    const timestamp = new Date(note.createdAt);
    utimesSync(notePath, timestamp, timestamp);
  }
}

function seedPack(
  userDataDir: string,
  pack: LocalMemoryBenchPack,
  model: string,
  provider: BenchProvider,
): void {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const modelSelection = { model, thinkingLevel: 'off' };
  writePrivateFile(
    path.join(userDataDir, 'preferences.json'),
    `${JSON.stringify(
      {
        version: 1,
        preferences: {
          localMemoryEnabled: true,
          localMemoryEnabledSetByUser: true,
          summaryModel: model,
          summaryModelSetByUser: true,
          summaryThinkingLevel: 'off',
          localMemoryModel: model,
          localMemoryModelSetByUser: true,
          localMemoryThinkingLevel: 'off',
          defaultChatInterfaceMode: 'canopy',
          defaultWorktreeProvider: provider,
          defaultChatProvider: provider,
          defaultWorktreeModelByProvider: { [provider]: modelSelection },
          defaultChatModelByProvider: { [provider]: modelSelection },
          providerModelConfigDefaults: {
            [provider]: { thinkingLevel: 'off' },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  if (pack.mode === 'injection') {
    seedScope(path.join(userDataDir, 'memory'), pack.memory.user);
    seedScope(
      path.join(userDataDir, 'workspaces', WORKSPACE_ID, 'memory'),
      pack.memory.workspace,
    );
  } else {
    seedRawScope(
      path.join(userDataDir, 'memory'),
      pack.rawSources.user,
      'User',
    );
    seedRawScope(
      path.join(userDataDir, 'workspaces', WORKSPACE_ID, 'memory'),
      pack.rawSources.workspace,
      'Workspace',
    );
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: provider,
    activeTabId: `bench-${pack.probes[0].id}`,
    tabs: pack.probes.map((probe) => ({
      id: `bench-${probe.id}`,
      title: probe.id,
      providerType: provider,
      model,
    })),
  });
}

function consolidatedStoreContents(scopeDir: string): string[] {
  const contents = [readFileSync(path.join(scopeDir, 'MEMORY.md'), 'utf8')];
  const topicsDir = path.join(scopeDir, 'topics');
  if (!existsSync(topicsDir)) {
    return contents;
  }
  for (const filename of readdirSync(topicsDir).sort()) {
    if (filename.endsWith('.md')) {
      contents.push(readFileSync(path.join(topicsDir, filename), 'utf8'));
    }
  }
  return contents;
}

function requiredPackLiterals(pack: LocalMemoryBenchPack): string[] {
  return Array.from(
    new Set(pack.probes.flatMap((probe) => probe.expect.mustContain)),
  );
}

interface ScopeConsolidationResults {
  user: LocalMemoryConsolidationStatus;
  workspace: LocalMemoryConsolidationStatus;
}

// The production `consolidateLocalMemory` IPC resolves with the recorded
// status; `lastResult` is 'success' after a real rewrite and 'skipped'
// (reason 'clean') when the scope had nothing pending.
async function runPackConsolidation(
  page: Page,
  pack: ConsolidationLocalMemoryBenchPack,
  userDataDir: string,
): Promise<ConsolidationStoreMetrics> {
  const results: ScopeConsolidationResults = await page.evaluate(
    async (workspaceId): Promise<ScopeConsolidationResults> => {
      const userRequest: LocalMemoryScopeRequest = { scope: 'user' };
      const workspaceRequest: LocalMemoryScopeRequest = {
        scope: 'workspace',
        workspaceId,
      };
      return {
        user: await window.api.consolidateLocalMemory(userRequest),
        workspace: await window.api.consolidateLocalMemory(workspaceRequest),
      };
    },
    WORKSPACE_ID,
  );
  const expectedUserStatus =
    pack.rawSources.user.imports.length + pack.rawSources.user.inbox.length > 0
      ? 'success'
      : 'skipped';
  const expectedWorkspaceStatus =
    pack.rawSources.workspace.imports.length +
      pack.rawSources.workspace.inbox.length >
    0
      ? 'success'
      : 'skipped';
  expect(results.user.lastResult, results.user.lastReason ?? undefined).toBe(
    expectedUserStatus,
  );
  expect(
    results.workspace.lastResult,
    results.workspace.lastReason ?? undefined,
  ).toBe(expectedWorkspaceStatus);

  const requiredLiterals = requiredPackLiterals(pack);
  const metrics = evaluateConsolidationStore({
    storeContents: [
      ...consolidatedStoreContents(path.join(userDataDir, 'memory')),
      ...consolidatedStoreContents(
        path.join(userDataDir, 'workspaces', WORKSPACE_ID, 'memory'),
      ),
    ],
    requiredLiterals,
    junkMarkers: pack.junkMarkers,
  });
  return metrics;
}

function scoredProbeResult(
  pack: LocalMemoryBenchPack,
  probe: BenchProbe,
  reply: string,
  latencyMs: number,
): BenchProbeResult {
  const evaluated = evaluateProbe({
    reply,
    latencyMs,
    expect: probe.expect,
    secretLiterals: pack.secretLiterals,
    contradictionOlderLiteral: pack.contradiction.olderLiteral,
  });
  return { id: probe.id, prompt: probe.prompt, reply, ...evaluated };
}

async function runPack(
  pack: LocalMemoryBenchPack,
  model: string,
  provider: BenchProvider,
  memoryInjectionSamples: number[],
): Promise<BenchPackResult> {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), `canopy-memory-bench-${pack.id}-`),
  );
  let electronApp: ElectronApplication | undefined;
  let consolidationStore: ConsolidationStoreMetrics | undefined;
  const probeResults: BenchProbeResult[] = [];
  try {
    seedPack(userDataDir, pack, model, provider);
    ({ electronApp } = await launchCanopy({
      userDataDir,
      preserveProviderState: true,
      env: {
        CANOPY_MOCK_LLM_BASE_URL: '',
        CANOPY_MOCK_API_KEY: '',
        CANOPY_GITHUB_API_BASE_URL: '',
        CANOPY_LINEAR_API_BASE_URL: '',
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    if (pack.mode === 'consolidation') {
      consolidationStore = await runPackConsolidation(
        window,
        pack,
        userDataDir,
      );
      expect(
        consolidationStore.factsPresent,
        'Consolidation must persist every graded literal in MEMORY.md or topics before probes run.',
      ).toBe(consolidationStore.factsExpected);
    }

    for (const probe of pack.probes) {
      const tabId = `bench-${probe.id}`;
      const tab = window.getByTestId(`panel-tab-panel-chat-${tabId}`);
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const panel = window.locator(
        '[data-testid="panel-content-chat"]:visible',
      );
      const composer = panel.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(probe.prompt);
      const started = Date.now();
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect(panel.getByText(probe.prompt).first()).toBeVisible({
        timeout: 30_000,
      });
      let reply = '';
      await expect
        .poll(
          async () => {
            const sendReady = await panel
              .getByRole('button', { name: 'Send message' })
              .isVisible()
              .catch(() => false);
            const texts = await panel
              .locator('[data-role="assistant"]')
              .allInnerTexts();
            reply = texts.join('\n').trim();
            return sendReady && reply.length > 0;
          },
          {
            timeout: PROBE_TIMEOUT_MS,
            message: `${model}/${pack.id}/${probe.id} should complete a real provider reply`,
          },
        )
        .toBe(true);
      probeResults.push(
        scoredProbeResult(pack, probe, reply, Date.now() - started),
      );
    }
    memoryInjectionSamples.push(
      ...(await measureInjectedMemoryLatency({
        userDir: path.join(userDataDir, 'memory'),
        workspaceDir: path.join(
          userDataDir,
          'workspaces',
          WORKSPACE_ID,
          'memory',
        ),
      })),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendPackError(pack.probes, probeResults, message);
  } finally {
    if (KEEP_DATA) {
      process.stdout.write(`Kept benchmark userDataDir: ${userDataDir}\n`);
    }
    if (electronApp) {
      await closeCanopy(electronApp, userDataDir, { keepUserData: KEEP_DATA });
    } else if (!KEEP_DATA) {
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
    }
  }
  return {
    id: pack.id,
    title: pack.title,
    status: probeResults.some((probe) => probe.status === 'error')
      ? 'error'
      : probeResults.every((probe) => probe.status === 'passed')
        ? 'passed'
        : 'failed',
    probes: probeResults,
    ...(consolidationStore === undefined ? {} : { consolidationStore }),
  };
}

function skippedPacks(
  packs: LocalMemoryBenchPack[],
  reason: string,
): Record<string, SkippedPackResult> {
  return Object.fromEntries(
    packs.map((pack) => [
      pack.id,
      {
        id: pack.id,
        title: pack.title,
        status: 'skipped',
        probes: pack.probes.map((probe) => ({
          id: probe.id,
          prompt: probe.prompt,
          status: 'skipped',
          reason,
        })),
      },
    ]),
  );
}

function formatInjectionMs(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2);
}

function printSummary(scorecard: BenchScorecard): void {
  const rows = Object.entries(scorecard.models).map(([model, result]) => {
    if (result.status === 'skipped') {
      return `${model.padEnd(34)} SKIPPED  ${result.skipReason}`;
    }
    if (!('aggregates' in result)) {
      return `${model.padEnd(34)} ERRORED  ${result.error}`;
    }
    const aggregate = result.aggregates;
    return [
      model.padEnd(34),
      result.status.toUpperCase().padEnd(7),
      `recall ${(aggregate.recall.rate * 100).toFixed(1)}%`,
      `false+ ${(aggregate.falsePositive.rate * 100).toFixed(1)}%`,
      `old ${(aggregate.contradictionEscape.rate * 100).toFixed(1)}%`,
      `leaks ${String(aggregate.leaks.count)}`,
      `dup ${(aggregate.duplicates.rate * 100).toFixed(1)}%`,
      `turn p50/p95 ${String(aggregate.latencyMs.p50)}/${String(aggregate.latencyMs.p95)}ms`,
      `inject p50/p95 ${formatInjectionMs(result.memoryInjectionLatencyMs.p50)}/${formatInjectionMs(result.memoryInjectionLatencyMs.p95)}ms`,
    ].join('  ');
  });
  process.stdout.write(
    `\nLocal memory benchmark: ${scorecard.status}\n${rows.join('\n')}\nScorecard: ${scorecard.scorecardPath}\n`,
  );
}

test('scores local-memory recall with real provider models', async () => {
  const startedAt = new Date().toISOString();
  const models = resolveBenchModels(process.env.CANOPY_MEMORY_BENCH_MODELS);
  const packs = loadPacks();
  if (models.length === 0) {
    throw new Error('CANOPY_MEMORY_BENCH_MODELS selected no models.');
  }
  if (packs.length === 0) {
    throw new Error('CANOPY_MEMORY_BENCH_PACKS selected no packs.');
  }

  const scorecard: BenchScorecard = {
    schemaVersion: 1,
    benchmark: 'CAN-2720-local-memory',
    startedAt,
    completedAt: '',
    status: 'RUNNING',
    scorecardPath: '',
    selection: {
      models,
      packs: packs.map((pack) => pack.id),
    },
    models: {},
    aggregates: { leaks: { count: 0 } },
  };
  const authByProvider = new Map<
    BenchProvider,
    BenchProviderAuthClassification
  >();
  for (const model of models) {
    const provider = modelProvider(model);
    const auth =
      authByProvider.get(provider) ?? providerAuthStatus(provider, repoRoot);
    authByProvider.set(provider, auth);
    if (auth.kind === 'unauthenticated') {
      scorecard.models[model] = {
        provider,
        status: 'skipped',
        skipReason: auth.reason,
        packs: skippedPacks(packs, auth.reason),
      };
      continue;
    }
    if (auth.kind === 'error') {
      scorecard.models[model] = {
        provider,
        status: 'errored',
        error: auth.reason,
        packs: skippedPacks(packs, auth.reason),
      };
      continue;
    }
    const packResults: BenchPackResult[] = [];
    const memoryInjectionSamples: number[] = [];
    for (const pack of packs) {
      process.stdout.write(`Benchmarking ${model} / ${pack.id}\n`);
      packResults.push(
        await runPack(pack, model, provider, memoryInjectionSamples),
      );
    }
    const aggregates = aggregateModelResult(packResults);
    scorecard.models[model] = {
      provider,
      status: resolveModelRunStatus(packResults),
      packs: Object.fromEntries(packResults.map((pack) => [pack.id, pack])),
      aggregates,
      memoryInjectionLatencyMs: summarizeLatencySamples(memoryInjectionSamples),
    };
    scorecard.aggregates.leaks.count += aggregates.leaks.count;
  }

  scorecard.status = resolveScorecardStatus(
    Object.values(scorecard.models).map((model) => model.status),
    scorecard.aggregates.leaks.count,
  );
  scorecard.completedAt = new Date().toISOString();
  mkdirSync(scorecardDir, { recursive: true });
  const filename = `${startedAt.replace(/:/g, '-')}.json`;
  scorecard.scorecardPath = path.join(scorecardDir, filename);
  writeFileSync(
    scorecard.scorecardPath,
    `${JSON.stringify(scorecard, null, 2)}\n`,
    'utf8',
  );
  printSummary(scorecard);

  expect(
    scorecard.aggregates.leaks.count,
    'A planted secret appeared in a model reply; the entire run is unsafe.',
  ).toBe(0);
  expect(
    scorecard.status,
    'Every selected model was skipped, so the benchmark measured nothing. Authenticate the bundled provider CLIs (see tests/benchmark/README.md) or select models for an authenticated provider via CANOPY_MEMORY_BENCH_MODELS.',
  ).not.toBe('SKIPPED');
  expect(scorecard.status).not.toBe('ERRORED');
  expect(scorecard.status).not.toBe('FAILED');
});

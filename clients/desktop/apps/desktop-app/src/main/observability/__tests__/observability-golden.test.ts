// CAN-4070 rule, for CAN-5065: observability outputs captured on unchanged
// code before the ingest is extracted (CAN-4136). The real
// `ObservabilityService` writes into a temporary data root; only provider
// accounts, prices, feature flags and the service locator are host inputs
// here, and the harness in `golden/` fixes them for every host. Any change
// to a stored line or an aggregated read fails the snapshot.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CostScopeRef,
  CostScopeView,
  CostViewResult,
} from '@canopy/protocol/cost-view';
import type { OpenAiPricingResponseV1 } from '@canopy/protocol/openai-pricing';
import type {
  AgentAuditEntry,
  AgentProviderType,
} from '@canopy/desktop-shared/types';
import type * as AttributionModule from '../../account-proxy/attribution';
import type * as PipelineUsageModule from '../../pipelines/pipeline-usage-events';
import type * as ServiceModule from '../service';
import type { OpenAiPricingCacheState } from '../../openai-pricing/pricing-client';
import {
  GOLDEN_CODEX_MODEL,
  GOLDEN_CODEX_PRICES,
  GOLDEN_PROVIDER_ACCOUNTS,
  captureAggregates,
  captureStores,
  diffGolden,
  readFinalAuditLines,
  renderGolden,
  runGoldenScenario,
  type GoldenObservabilityHost,
  type GoldenObservabilityIngest,
  type GoldenAggregates,
  type GoldenRun,
  type GoldenScenario,
} from './golden/harness';
import { CHUNKING_SCENARIO, GOLDEN_SCENARIOS } from './golden/scenarios';

const GOLDEN_PRICING_PAYLOAD: OpenAiPricingResponseV1 = {
  version: 1,
  currency: 'usd',
  tokenUnit: 'per_1m_tokens',
  source: {
    pricingUrl: 'https://example.invalid/api-pricing',
    codexPricingUrl: 'https://example.invalid/codex-pricing',
    codexSpeedUrl: 'https://example.invalid/codex-speed',
    fetchedAt: '2026-10-20T00:00:00.000Z',
    generatedBy: 'observability-golden',
  },
  cache: { maxAgeSeconds: 3600, staleWhileRevalidateSeconds: 86400 },
  basis: {
    tokenPricing: 'openai_api_standard',
    fastModePricing: 'codex_credit_adjusted_standard_equivalent',
    notes: ['golden fixture'],
  },
  serviceTierAliases: { default: 'standard', priority: 'fast' },
  models: {
    [GOLDEN_CODEX_MODEL]: {
      model: GOLDEN_CODEX_MODEL,
      standard: GOLDEN_CODEX_PRICES,
    },
  },
  unpricedModels: {},
  billableTools: {},
};

const mockPricing: OpenAiPricingCacheState = {
  payload: GOLDEN_PRICING_PAYLOAD,
  fetchedAt: GOLDEN_PRICING_PAYLOAD.source.fetchedAt,
  loadedFrom: 'memory',
  stale: false,
};

function mockAccount(
  provider: AgentProviderType,
):
  | (typeof GOLDEN_PROVIDER_ACCOUNTS)[keyof typeof GOLDEN_PROVIDER_ACCOUNTS]
  | null {
  return provider === 'claude' || provider === 'codex'
    ? GOLDEN_PROVIDER_ACCOUNTS[provider]
    : null;
}

/** The incarnation `getObservabilityService()` returns to producers. */
let mockCurrentService: unknown = null;

jest.mock('../index', () => ({
  getObservabilityService: (): unknown => mockCurrentService,
  peekObservabilityService: (): unknown => mockCurrentService,
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<{
    auditRetentionDays: number;
    cursorEnabled: boolean;
    copilotEnabled: boolean;
  }> =>
    Promise.resolve({
      auditRetentionDays: 7,
      cursorEnabled: false,
      copilotEnabled: false,
    }),
}));
jest.mock('../../auth/provider-auth-state', () => ({
  checkClaudeAuthStatusObserved: (): Promise<{ authenticated: false }> =>
    Promise.resolve({ authenticated: false }),
  peekProviderAccountIdentity: (provider: AgentProviderType): unknown => {
    const account = mockAccount(provider);
    return account ? { ...account.identity } : null;
  },
  peekProviderBillingAccountKind: (provider: AgentProviderType): string =>
    mockAccount(provider)?.billingAccountKind ?? 'unknown',
  warmProviderAccountIdentity: (): void => undefined,
}));
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { onSnapshotChanged: () => () => void } => ({
    onSnapshotChanged: (): (() => void) => (): void => undefined,
  }),
}));
jest.mock('../../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: (): boolean => false,
}));
jest.mock('../../cursor/account-usage', () => ({
  readCursorAccountUsage: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: (): boolean => false,
}));
jest.mock('../../copilot/account-usage', () => ({
  readCopilotUsageSummary: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../copilot/usage-events', () => ({
  onCopilotUsageChanged: (): (() => void) => (): void => undefined,
}));
jest.mock('../../codex/runtime-service', () => ({
  getCodexRuntimeService: (): unknown => ({
    admin: (): unknown => ({
      request: (): Promise<{ account: null }> =>
        Promise.resolve({ account: null }),
      onAccountUpdated: (): (() => void) => (): void => undefined,
      onRateLimitsUpdated: (): (() => void) => (): void => undefined,
    }),
  }),
}));
jest.mock('../../account-proxy/service', () => ({
  getAccountProxyUsageInventory: (): [] => [],
  fetchAccountProxyUsage: (): Promise<never> =>
    Promise.reject(new Error('No account proxy in the golden host')),
  publishAccountProxyStatus: (): Promise<void> => Promise.resolve(),
  onAccountProxyInventoryChanged: (): (() => void) => (): void => undefined,
}));
jest.mock('../../memory/local/citation-tracking', () => ({
  isLocalMemoryCitationTrackingEnabled: (): Promise<boolean> =>
    Promise.resolve(false),
  trackCompletedTurnLocalMemoryCitations: (): Promise<void> =>
    Promise.resolve(),
}));
jest.mock('../../openai-pricing/pricing-client', () => ({
  getOpenAiPricingForCostingSync: (): OpenAiPricingCacheState => mockPricing,
  getOpenAiPricingForCosting: (): Promise<OpenAiPricingCacheState> =>
    Promise.resolve(mockPricing),
  prewarmOpenAiPricingCache: (): void => undefined,
}));
jest.mock('../../lib/pipeline-run-completion-emitter', () => ({
  emitPipelineRunCompletion: (): void => undefined,
}));
jest.mock('../../pipelines/action-resolver', () => ({
  resolveAction: (): undefined => undefined,
}));

import { CostIndexStore } from '../../cost-index/store';
import { classifyAuditEntry } from '../../cost-index/classifier';
import type {
  CostIndexHost,
  CostScopeLocation,
  CostTurnRecord,
} from '../../cost-index/types';
import { normalizeAuditEntry } from '../audit-entry-parser';

jest.setTimeout(300_000);

interface DesktopIncarnation {
  service: ServiceModule.ObservabilityService;
  attribution: typeof AttributionModule;
  pipelineUsage: typeof PipelineUsageModule;
}

interface DesktopHost extends GoldenObservabilityHost {
  readonly incarnations: DesktopIncarnation[];
}

const roots: string[] = [];
let originalDataDir: string | undefined;

/**
 * Each boot loads a fresh module graph, so the service, the Claude cost
 * ledger and account-proxy attribution start empty, as in a new process.
 */
function createDesktopHost(): DesktopHost {
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), 'observability-golden-')),
  );
  roots.push(parent);
  const dataRoot = join(parent, 'data');
  process.env.CANOPY_DATA_DIR = dataRoot;
  const incarnations: DesktopIncarnation[] = [];
  const current = (): DesktopIncarnation => {
    const incarnation = incarnations[incarnations.length - 1];
    if (!incarnation) throw new Error('No incarnation booted');
    return incarnation;
  };
  return {
    dataRoot,
    incarnations,
    boot: (): Promise<GoldenObservabilityIngest> => {
      let incarnation: DesktopIncarnation | undefined;
      jest.isolateModules(() => {
        const service = new (jest.requireActual<typeof ServiceModule>(
          '../service',
        ).ObservabilityService)();
        incarnation = {
          service,
          attribution: jest.requireActual<typeof AttributionModule>(
            '../../account-proxy/attribution',
          ),
          pipelineUsage: jest.requireActual<typeof PipelineUsageModule>(
            '../../pipelines/pipeline-usage-events',
          ),
        };
      });
      if (!incarnation) throw new Error('Service did not load');
      incarnations.push(incarnation);
      mockCurrentService = incarnation.service;
      return Promise.resolve(incarnation.service);
    },
    setClock: (iso): void => {
      jest.setSystemTime(new Date(iso));
    },
    advanceClock: (ms): void => {
      jest.setSystemTime(new Date(Date.now() + ms));
    },
    recordAccountProxyResponse: (response): void => {
      current().attribution.recordAccountProxyResponse({
        sessionId: response.sessionId,
        connectionId: response.connectionId,
        traceHeader: `20261020090000-${response.authIndex}-${response.requestId}`,
        lookupAccount: () => ({
          label: response.label,
          provider: response.provider,
        }),
      });
    },
    recordPipelineRunEvent: (event): void => {
      current().pipelineUsage.recordPipelineUsageEvent(event);
    },
  };
}

function auditScopes(
  entries: readonly AgentAuditEntry[],
): Map<string, { scope: CostScopeRef; chats: Set<string>; runs: Set<string> }> {
  const scopes = new Map<
    string,
    { scope: CostScopeRef; chats: Set<string>; runs: Set<string> }
  >();
  for (const entry of entries) {
    if (!entry.projectId || !entry.worktreeId) continue;
    const key = `${entry.projectId}/${entry.worktreeId}`;
    const scope = scopes.get(key) ?? {
      scope: {
        kind: 'entry',
        projectId: entry.projectId,
        worktreeId: entry.worktreeId,
      },
      chats: new Set<string>(),
      runs: new Set<string>(),
    };
    if (entry.chatId) scope.chats.add(entry.chatId);
    const run = entry.rootPipelineExecutionId ?? entry.pipelineExecutionId;
    if (run) scope.runs.add(run);
    if (entry.pipelineExecutionId) scope.runs.add(entry.pipelineExecutionId);
    scopes.set(key, scope);
  }
  return scopes;
}

function finalAuditEntries(lines: readonly unknown[]): AgentAuditEntry[] {
  return lines
    .map((line) => normalizeAuditEntry(line))
    .filter((entry) => entry !== null);
}

/**
 * Runs zero-delay timers until `work` settles, without moving the clock: the
 * cost store defers its repair passes to `setTimeout(0)`.
 */
async function withZeroDelayTimers<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = work.finally((): void => {
    settled = true;
  });
  while (!settled) {
    await jest.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return tracked;
}

/** Every cost-index view over the stored audit, built by the real store. */
function captureCostIndex(
  run: GoldenRun,
  dataRoot: string,
): Promise<{
  views: Record<string, unknown>;
  scopeViews: Map<string, CostViewResult<CostScopeView>>;
}> {
  return withZeroDelayTimers(buildCostIndexViews(run, dataRoot));
}

async function buildCostIndexViews(
  run: GoldenRun,
  dataRoot: string,
): Promise<{
  views: Record<string, unknown>;
  scopeViews: Map<string, CostViewResult<CostScopeView>>;
}> {
  const entries = finalAuditEntries(await readFinalAuditLines(dataRoot));
  const scopes = auditScopes(entries);
  const locations = new Map<string, CostScopeLocation>();
  for (const [key, { scope }] of Array.from(scopes.entries())) {
    locations.set(key, {
      scope,
      directory: join(dataRoot, 'golden-cost-index', key),
      incarnation: '2026-10-01T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  }
  const keyOf = (scope: CostScopeRef): string =>
    scope.kind === 'entry' ? `${scope.projectId}/${scope.worktreeId}` : '';
  const host: CostIndexHost = {
    auditDirectory: () => join(dataRoot, 'agent-observability', 'audit'),
    checkpointPath: () =>
      join(dataRoot, 'golden-cost-index', 'checkpoint.json'),
    resolveScope: (scope) =>
      Promise.resolve(locations.get(keyOf(scope)) ?? null),
    listRetainedScopes: () => Promise.resolve([]),
    withRetainedLock: (_scope, action) => action(),
    readChats: (scope) =>
      Promise.resolve(
        Array.from(scopes.get(keyOf(scope))?.chats ?? []).map((chatId) => ({
          chatId,
          label: `Chat ${chatId}`,
          state: 'open' as const,
        })),
      ),
    readPipelineRun: () => Promise.resolve(null),
    readProxyAccountLabels: () => Promise.resolve(new Map()),
    retentionDays: () => 7,
    flush: () => run.context.ingest.flush(),
    now: () => new Date(),
    yield: () => Promise.resolve(),
  };
  const store = new CostIndexStore(host);
  await store.refreshInternal('idle');
  await store.waitForIdle();
  const views: Record<string, unknown> = {};
  const scopeViews = new Map<string, CostViewResult<CostScopeView>>();
  for (const [key, { scope, chats, runs }] of Array.from(scopes.entries())) {
    const scopeView = await store.getScope({ scope });
    scopeViews.set(key, scopeView);
    views[`${key}/scope`] = scopeView;
    for (const chatId of Array.from(chats).sort()) {
      views[`${key}/chat/${chatId}`] = await store.getChat({ scope, chatId });
    }
    for (const executionId of Array.from(runs).sort()) {
      views[`${key}/run/${executionId}`] = await store.getPipelineRun({
        scope,
        executionId,
      });
    }
  }
  await store.waitForIdle();
  return { views, scopeViews };
}

async function disposeAll(host: DesktopHost): Promise<void> {
  for (const { service } of host.incarnations) {
    await service.dispose().catch(() => undefined);
  }
}

beforeAll(() => {
  originalDataDir = process.env.CANOPY_DATA_DIR;
});

function useGoldenTimers(): void {
  jest.useFakeTimers({
    doNotFake: [
      'nextTick',
      'setImmediate',
      'queueMicrotask',
      'performance',
      'hrtime',
    ],
  });
}

function restoreGoldenEnvironment(): void {
  jest.useRealTimers();
  mockCurrentService = null;
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

interface CapturedScenario {
  host: DesktopHost;
  stores: string;
  aggregates: GoldenAggregates;
  restartedAggregates: GoldenAggregates;
  costIndex: Awaited<ReturnType<typeof captureCostIndex>>;
  auditEntries: AgentAuditEntry[];
}

async function captureScenario(
  scenario: GoldenScenario,
): Promise<CapturedScenario> {
  const host = createDesktopHost();
  const run = await runGoldenScenario(host, scenario);
  const aggregates = await captureAggregates(run.context.ingest);
  const stores = await captureStores(host.dataRoot);
  const auditEntries = finalAuditEntries(
    await readFinalAuditLines(host.dataRoot),
  );
  // A fresh process reads only what the earlier ones stored.
  const restarted = await host.boot();
  await restarted.start();
  const restartedAggregates = await captureAggregates(restarted);
  const costIndex = await captureCostIndex(run, host.dataRoot);
  return {
    host,
    stores,
    aggregates,
    restartedAggregates,
    costIndex,
    auditEntries,
  };
}

describe.each(GOLDEN_SCENARIOS.map((scenario) => [scenario.name, scenario]))(
  'observability golden: %s',
  (_name, scenario) => {
    let captured: CapturedScenario;

    beforeAll(async () => {
      useGoldenTimers();
      captured = await captureScenario(scenario);
    });

    afterAll(async () => {
      await disposeAll(captured.host);
      restoreGoldenEnvironment();
    });

    it('stores the golden records', () => {
      expect(captured.stores).toMatchSnapshot();
    });

    it('serves the golden aggregates', () => {
      expect(
        renderGolden(captured.aggregates, captured.host.dataRoot),
      ).toMatchSnapshot();
    });

    it('builds the golden cost index', () => {
      expect(
        renderGolden(captured.costIndex.views, captured.host.dataRoot),
      ).toMatchSnapshot();
    });

    // Differential: what a fresh process serves from the stores alone,
    // against what the live process served. Today's divergences are part of
    // the golden; an empty list means the reads agree.
    it('serves the golden differences after a restart', () => {
      expect(
        diffGolden(captured.aggregates, captured.restartedAggregates),
      ).toMatchSnapshot();
    });

    it('totals each cost scope as the sum of its classified records', () => {
      const classified = captured.auditEntries.map((entry) => ({
        entry,
        record: classifyAuditEntry(entry),
      }));
      expect(captured.costIndex.scopeViews.size).toBeGreaterThan(0);
      for (const [key, view] of Array.from(
        captured.costIndex.scopeViews.entries(),
      )) {
        if (view.status !== 'ok') throw new Error(`No view for ${key}`);
        const records = classified
          .filter(
            ({ entry }) => `${entry.projectId}/${entry.worktreeId}` === key,
          )
          .map(({ record }) => record)
          .filter((record) => record !== null);
        const sum = (pick: (record: CostTurnRecord) => number): number =>
          records.reduce((total, record) => total + pick(record), 0);
        expect(view.value.totals.usd).toBeCloseTo(
          sum((record) => record.costUsd ?? 0),
          6,
        );
        expect(view.value.totals.tokens).toEqual({
          input: sum((record) => record.tokens.input),
          output: sum((record) => record.tokens.output),
          cacheReadInputTokens: sum(
            (record) => record.tokens.cacheReadInputTokens,
          ),
          cacheCreationInputTokens: sum(
            (record) => record.tokens.cacheCreationInputTokens,
          ),
          reasoningOutputTokens: sum(
            (record) => record.tokens.reasoningOutputTokens,
          ),
        });
      }
    });
  },
);

describe('observability golden: pipeline output chunking', () => {
  const captures: string[] = [];
  const hosts: DesktopHost[] = [];

  beforeAll(async () => {
    useGoldenTimers();
    for (const chunking of ['whole', 'per-character', 'crlf-split'] as const) {
      const host = createDesktopHost();
      hosts.push(host);
      await runGoldenScenario(host, CHUNKING_SCENARIO, chunking);
      captures.push(await captureStores(host.dataRoot));
    }
  });

  afterAll(async () => {
    for (const host of hosts) await disposeAll(host);
    restoreGoldenEnvironment();
  });

  it('stores the same records however pipeline output is chunked', () => {
    expect(captures).toHaveLength(3);
    expect(captures[1]).toBe(captures[0]);
    expect(captures[2]).toBe(captures[0]);
  });
});

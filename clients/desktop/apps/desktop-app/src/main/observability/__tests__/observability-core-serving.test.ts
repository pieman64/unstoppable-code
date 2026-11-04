// CAN-4137: `core.observability.*` serves the audit and usage reads. Runs
// CAN-5065 golden scenarios on the desktop golden host, then captures the
// golden aggregates directly and through the core dispatcher for two
// clients: every read must match. Also reconnects an audit events stream
// across a finalization. Kept apart from the goldens for worker memory.
import {
  CORE_OBSERVABILITY_QUERIES,
  CORE_OBSERVABILITY_STREAMS,
  type CanopyCallerDescriptor,
  type CanopyStreamCursor,
  type ObservabilityAuditEventsItem,
} from '@canopy/protocol/canopy-core';
import {
  createCanopyDispatcher,
  type CanopyDispatcher,
  type CanopyStreamFrame,
} from '@canopy/core-runtime';
import {
  createCoreObservabilityHandlers,
  type ObservabilityReadModel,
} from '@canopy/core-runtime/observability';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import type { OpenAiPricingCacheState } from '../../openai-pricing/pricing-client';
import {
  captureAggregates,
  diffGolden,
  runGoldenScenario,
  type GoldenAggregateReader,
  type GoldenAggregates,
} from './golden/harness';
import {
  GOLDEN_PRICING_STATE,
  createDesktopHost,
  disposeAll,
  goldenAccount,
  restoreGoldenEnvironment,
  useGoldenTimers,
  type DesktopHost,
} from './golden/desktop-host';
import { PROJECT, helperEntry } from './golden/fixtures';
import { GOLDEN_SCENARIOS } from './golden/scenarios';

const mockPricing = GOLDEN_PRICING_STATE;
const mockAccount = goldenAccount;

/** The incarnation `getObservabilityService()` returns to producers. */
let mockCurrentService: unknown = null;
function setCurrentService(service: unknown): void {
  mockCurrentService = service;
}

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

jest.setTimeout(300_000);

function client(id: string): CanopyCallerDescriptor {
  return {
    principalId: 'local-user',
    clientInstanceId: id,
    authorityId: 'local-desktop',
    interfaceKind: 'test',
    grants: ['core.observability.read'],
  };
}

function coreDispatcher(
  model: ObservabilityReadModel,
): CanopyDispatcher<
  typeof CORE_OBSERVABILITY_QUERIES,
  Record<never, never>,
  typeof CORE_OBSERVABILITY_STREAMS
> {
  return createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: CORE_OBSERVABILITY_QUERIES,
      instructions: {},
      streams: CORE_OBSERVABILITY_STREAMS,
    },
    handlers: { ...createCoreObservabilityHandlers(model), instructions: {} },
  });
}

type CoreDispatcher = ReturnType<typeof coreDispatcher>;

/** The golden reads, each served through `core.observability.*`. */
async function servedReader(
  dispatcher: CoreDispatcher,
  caller: CanopyCallerDescriptor,
  host: Pick<GoldenAggregateReader, 'getPipelineOutputDiagnostics'>,
): Promise<GoldenAggregateReader> {
  const options = { caller };
  const overview = await dispatcher.query(
    'core.observability.summary.get',
    { kind: 'overview' },
    options,
  );
  if (overview.kind !== 'overview') throw new Error('Expected the overview');
  return {
    loadSnapshot: () => ({ recentEntries: overview.overview.recentEntries }),
    loadHistory: (request) =>
      dispatcher.query('core.observability.audit.list', request, options),
    loadUsageMetrics: async (request) => {
      const result = await dispatcher.query(
        'core.observability.usage.query',
        { kind: 'metrics', request },
        options,
      );
      if (result.kind !== 'metrics') throw new Error('Expected metrics');
      return result.result;
    },
    loadUsageMetricsView: async (request) => {
      const result = await dispatcher.query(
        'core.observability.usage.query',
        { kind: 'view', request },
        options,
      );
      if (result.kind !== 'view') throw new Error('Expected a view');
      return result.result;
    },
    loadUsageTimeseries: async (request) => {
      const result = await dispatcher.query(
        'core.observability.usage.query',
        { kind: 'timeseries', request },
        options,
      );
      if (result.kind !== 'timeseries') throw new Error('Expected a series');
      return result.result;
    },
    loadUsageTabSummary: async (request) => {
      const result = await dispatcher.query(
        'core.observability.summary.get',
        { kind: 'tab', request },
        options,
      );
      if (result.kind !== 'tab') throw new Error('Expected a tab summary');
      return result.result;
    },
    getPipelineOutputDiagnostics: () => host.getPipelineOutputDiagnostics(),
  };
}

describe.each(
  GOLDEN_SCENARIOS.filter((scenario) =>
    [
      'chat turns: Claude',
      'pipeline steps: Claude, Codex, account proxy and Copilot',
      'interrupted-on-shutdown finalization',
      'duplicate finalization',
    ].includes(scenario.name),
  ).map((scenario) => [scenario.name, scenario]),
)('core.observability serving: %s', (_name, scenario) => {
  let host: DesktopHost;
  let direct: GoldenAggregates;
  let servedA: GoldenAggregates;
  let servedB: GoldenAggregates;

  beforeAll(async () => {
    useGoldenTimers();
    host = createDesktopHost(setCurrentService);
    await runGoldenScenario(host, scenario);
    const service = host.incarnations.at(-1)?.service;
    if (!service) throw new Error('No incarnation');
    direct = await captureAggregates(service);
    const dispatcher = coreDispatcher(service);
    servedA = await captureAggregates(
      await servedReader(dispatcher, client('a'), service),
    );
    servedB = await captureAggregates(
      await servedReader(dispatcher, client('b'), service),
    );
  });

  afterAll(async () => {
    await disposeAll(host);
    restoreGoldenEnvironment(setCurrentService);
  });

  it('serves the golden aggregates unchanged through core', () => {
    expect(direct.history.entries.length).toBeGreaterThan(0);
    expect(diffGolden(direct, servedA)).toEqual([]);
  });

  it('serves two clients the same results', () => {
    expect(servedB).toEqual(servedA);
  });

  it('serves each stored transcript unchanged through core', async () => {
    const service = host.incarnations.at(-1)?.service;
    if (!service) throw new Error('No incarnation');
    const dispatcher = coreDispatcher(service);
    for (const entry of direct.history.entries) {
      const request = {
        id: entry.id,
        eventType: entry.eventType,
        startedAt: entry.startedAt,
      };
      await expect(
        dispatcher.query('core.observability.audit.transcript.get', request, {
          caller: client('a'),
        }),
      ).resolves.toEqual(await service.loadTranscript(request));
    }
  });
});

describe('core.observability audit events across a reconnect', () => {
  let host: DesktopHost;

  beforeAll(() => {
    useGoldenTimers();
    host = createDesktopHost(setCurrentService);
  });

  afterAll(async () => {
    await disposeAll(host);
    restoreGoldenEnvironment(setCurrentService);
  });

  it('delivers a terminal state that happened while the client was away', async () => {
    host.setClock('2026-10-20T09:00:00.000Z');
    await host.boot();
    const service = host.incarnations.at(-1)?.service;
    if (!service) throw new Error('No incarnation');
    await service.start();
    const dispatcher = coreDispatcher(service);
    const flush = (): Promise<void> =>
      new Promise((resolve) => setImmediate(resolve));
    type Frame = CanopyStreamFrame<ObservabilityAuditEventsItem, object>;
    const open = async (
      cursor?: CanopyStreamCursor,
    ): Promise<{ frames: Frame[]; close: () => void }> => {
      const frames: Frame[] = [];
      const stream = await dispatcher.openStream(
        'core.observability.audit.events',
        cursor ? { cursor } : {},
        {
          caller: client('a'),
          onFrame: (frame): void => {
            frames.push(frame);
          },
        },
      );
      await flush();
      return { frames, close: (): void => stream.close() };
    };

    const key = `pr-generation:${PROJECT}/reconnect:1`;
    const first = await open();
    service.startObservedTask(
      key,
      helperEntry({
        taskKey: key,
        eventType: 'pr_generation',
        provider: 'claude',
        model: 'claude-opus-5-5',
        label: 'PR generation',
        startedAt: '2026-10-20T09:00:00.000Z',
      }),
    );
    await flush();
    const cursor = first.frames.at(-1)?.cursor;
    if (!cursor) throw new Error('No cursor');
    first.close();

    host.setClock('2026-10-20T09:00:05.000Z');
    service.finalizeObservedTask(key, 'success', undefined, {
      inputTokens: 10,
      outputTokens: 5,
    });
    const resumed = await open(cursor);
    const replayed = resumed.frames.flatMap((frame) =>
      frame.kind === 'item' && frame.item.kind === 'entries'
        ? frame.item.entries
        : [],
    );
    expect(replayed).toEqual([
      expect.objectContaining({ id: key, status: 'success' }),
    ]);

    // Another client reads the same terminal entry from the audit list.
    const history = await dispatcher.query(
      'core.observability.audit.list',
      { status: 'success' },
      { caller: client('b') },
    );
    expect(history.entries).toEqual([replayed[0]]);
    resumed.close();
  });
});

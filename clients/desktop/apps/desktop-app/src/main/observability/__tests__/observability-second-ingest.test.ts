// CAN-5078: usage and plan aggregation is keyed by persisted event identity.
// Runs golden scenarios on the desktop golden host, then ingests every stored
// usage event again after a restart and from another incarnation over the
// same stores. Kept apart from the CAN-5065 goldens so each suite has its own
// worker memory.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentAuditEntry,
  AgentProviderType,
  UsageMetricEvent,
} from '@canopy/desktop-shared/types';
import { normalizeUsageMetricEvent } from '@canopy/core-runtime/observability';
import type { OpenAiPricingCacheState } from '../../openai-pricing/pricing-client';
import {
  captureAggregates,
  diffGolden,
  readFinalAuditLines,
  runGoldenScenario,
  type GoldenAggregates,
} from './golden/harness';
import {
  GOLDEN_PRICING_STATE,
  createDesktopHost,
  disposeAll,
  finalAuditEntries,
  goldenAccount,
  restoreGoldenEnvironment,
  useGoldenTimers,
  type DesktopHost,
} from './golden/desktop-host';
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

function readStoredUsageEvents(dataRoot: string): UsageMetricEvent[] {
  const directory = join(dataRoot, 'agent-observability', 'usage-events');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .flatMap((name) =>
      readFileSync(join(directory, name), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0),
    )
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      return normalizeUsageMetricEvent(parsed);
    })
    .filter((event) => event !== null);
}

describe.each(
  GOLDEN_SCENARIOS.filter(
    (scenario) =>
      scenario.name === 'chat turns: Claude' ||
      scenario.name === 'duplicate finalization',
  ).map((scenario) => [scenario.name, scenario]),
)('observability golden: second ingest of %s', (_name, scenario) => {
  let host: DesktopHost;
  let stored: UsageMetricEvent[];
  let before: GoldenAggregates;
  let after: GoldenAggregates;
  let auditEntries: AgentAuditEntry[];

  beforeAll(async () => {
    useGoldenTimers();
    host = createDesktopHost(setCurrentService);
    const run = await runGoldenScenario(host, scenario);
    await run.context.shutdownAndRestart();
    before = await captureAggregates(run.context.ingest);
    stored = readStoredUsageEvents(host.dataRoot);

    for (const event of stored)
      run.context.ingest.recordUsageMetricEvent(event);
    // The replaying incarnation keeps running beside a second one.
    await run.context.crashAndRestart();
    for (const event of stored)
      run.context.ingest.recordUsageMetricEvent(event);
    await run.context.settle();
    await run.context.shutdownAndRestart();

    after = await captureAggregates(run.context.ingest);
    auditEntries = finalAuditEntries(await readFinalAuditLines(host.dataRoot));
  });

  afterAll(async () => {
    await disposeAll(host);
    restoreGoldenEnvironment(setCurrentService);
  });

  it('serves the same aggregates after the second ingest', () => {
    expect(stored.some((event) => event.type === 'plan_created')).toBe(true);
    expect(diffGolden(before, after)).toEqual([]);
  });

  it('counts each stored plan event once on the audit entries', () => {
    const distinct = (type: UsageMetricEvent['type']): number =>
      new Set(
        stored.filter((event) => event.type === type).map((event) => event.id),
      ).size;
    const total = (pick: (entry: AgentAuditEntry) => number): number =>
      auditEntries.reduce((sum, entry) => sum + pick(entry), 0);
    expect(total((entry) => entry.planEvents?.created ?? 0)).toBe(
      distinct('plan_created'),
    );
    expect(total((entry) => entry.planEvents?.approved ?? 0)).toBe(
      distinct('plan_approved'),
    );
  });
});

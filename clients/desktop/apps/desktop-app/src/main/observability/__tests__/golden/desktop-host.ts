// The desktop golden host shared by the observability golden suites: the real
// `ObservabilityService` over a temporary data root, with every portable port
// bound to the golden fixtures. Each test file mocks the service locator and
// host inputs itself, and passes the booted service back through `onBoot`.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenAiPricingResponseV1 } from '@canopy/protocol/openai-pricing';
import type {
  AgentAuditEntry,
  AgentProviderType,
} from '@canopy/desktop-shared/types';
import { normalizeAuditEntry } from '@canopy/core-runtime/observability';
import { createNodeInstrumentation } from '@canopy/desktop-instrumentation/node';
import type * as AttributionModule from '../../../account-proxy/attribution';
import type * as PipelineUsageModule from '../../../pipelines/pipeline-usage-events';
import type * as HostModule from '../../host';
import type * as ServiceModule from '../../service';
import type { OpenAiPricingCacheState } from '../../../openai-pricing/pricing-client';
import {
  GOLDEN_CODEX_MODEL,
  GOLDEN_CODEX_PRICES,
  GOLDEN_PROVIDER_ACCOUNTS,
  type GoldenObservabilityHost,
  type GoldenObservabilityIngest,
} from './harness';

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

export const GOLDEN_PRICING_STATE: OpenAiPricingCacheState = {
  payload: GOLDEN_PRICING_PAYLOAD,
  fetchedAt: GOLDEN_PRICING_PAYLOAD.source.fetchedAt,
  loadedFrom: 'memory',
  stale: false,
};

export function goldenAccount(
  provider: AgentProviderType,
):
  | (typeof GOLDEN_PROVIDER_ACCOUNTS)[keyof typeof GOLDEN_PROVIDER_ACCOUNTS]
  | null {
  return provider === 'claude' || provider === 'codex'
    ? GOLDEN_PROVIDER_ACCOUNTS[provider]
    : null;
}

/**
 * The desktop host with every portable port bound to the golden fixtures
 * and the Node instrumentation entry, so the goldens pin what any host
 * composing the same ports must store and serve.
 */
function createGoldenHost(): HostModule.DesktopObservabilityHost {
  const desktop = jest
    .requireActual<typeof HostModule>('../../host')
    .createDesktopObservabilityHost();
  return {
    ...desktop,
    instrumentation: createNodeInstrumentation(),
    accounts: {
      peekIdentity: (
        provider,
      ): {
        providerAccountKey: string;
        accountEmail: string;
        planType: string;
      } | null => {
        const account = goldenAccount(provider);
        return account ? { ...account.identity } : null;
      },
      peekBillingAccountKind: (provider) =>
        goldenAccount(provider)?.billingAccountKind ?? 'unknown',
      warmIdentity: (): void => undefined,
    },
    pricing: {
      current: () => GOLDEN_PRICING_STATE,
      prewarm: (): void => undefined,
    },
    readAuditRetentionDays: () => Promise.resolve(7),
  };
}

export interface DesktopIncarnation {
  service: ServiceModule.ObservabilityService;
  attribution: typeof AttributionModule;
  pipelineUsage: typeof PipelineUsageModule;
}

export interface DesktopHost extends GoldenObservabilityHost {
  readonly incarnations: DesktopIncarnation[];
}

const roots: string[] = [];
const originalDataDir = process.env.CANOPY_DATA_DIR;

/**
 * Each boot loads a fresh module graph, so the service, the Claude cost
 * ledger and account-proxy attribution start empty, as in a new process.
 */
export function createDesktopHost(
  onBoot: (service: ServiceModule.ObservabilityService | null) => void,
): DesktopHost {
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
          '../../service',
        ).ObservabilityService)(createGoldenHost());
        incarnation = {
          service,
          attribution: jest.requireActual<typeof AttributionModule>(
            '../../../account-proxy/attribution',
          ),
          pipelineUsage: jest.requireActual<typeof PipelineUsageModule>(
            '../../../pipelines/pipeline-usage-events',
          ),
        };
      });
      if (!incarnation) throw new Error('Service did not load');
      incarnations.push(incarnation);
      onBoot(incarnation.service);
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

export function finalAuditEntries(
  lines: readonly unknown[],
): AgentAuditEntry[] {
  return lines
    .map((line) => normalizeAuditEntry(line))
    .filter((entry) => entry !== null);
}

export async function disposeAll(host: DesktopHost): Promise<void> {
  for (const { service } of host.incarnations) {
    await service.dispose().catch(() => undefined);
  }
}

export function useGoldenTimers(): void {
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

export function restoreGoldenEnvironment(
  onReset: (service: null) => void,
): void {
  jest.useRealTimers();
  onReset(null);
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

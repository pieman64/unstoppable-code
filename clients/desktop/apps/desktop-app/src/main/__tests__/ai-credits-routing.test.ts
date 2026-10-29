/* eslint-disable @typescript-eslint/no-require-imports */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseModelPackageConfig } from '@canopy/desktop-shared/model-config';
import { mergeAiGatewayModelCatalog } from '@canopy/desktop-shared/ai-gateway-model-catalog';
import {
  initClaudeModels,
  initCodexModels,
  initAiGatewayModels,
  initModelAliases,
  getAiGatewayModelEntries,
  getGatewayModelEntries,
} from '@canopy/desktop-shared/types';
import {
  AI_CREDITS_CODEX_PROVIDER_ID,
  buildClaudeProxyEnv,
  buildClaudeProxyEnvForBaseUrl,
  buildCodexProxyConfig,
  buildCodexProxyConfigObject,
  buildProxyBaseUrl,
  clearAiCreditsRoutingContextCache,
  clearAiCreditsRoutingModeCache,
  emitAiCreditsRoutingStatus,
  emitAiCreditsNoBillingSource,
  getAiCreditsRoutingContext,
  hasUserSuppliedProviderCredential,
  resolveAiCreditsRoutingActivation,
  resolveAiCreditsRoutingAttempt,
  resolveAiCreditsRoutingOverride,
  resolveGatewayModelEntry,
  setAiCreditsRoutingModeCache,
  subscribeAiCreditsRoutingModeChanges,
} from '../agents/ai-credits-routing';
import {
  billedProviderFor,
  withEffectiveAiCreditsRouting,
} from '../agents/effective-ai-credits-routing';
import { isProviderNativelyAuthenticated } from '../auth/provider-auth-state';
import {
  isAiCreditsNoBillingSourceEventData,
  isAiCreditsRoutingStatusEventData,
} from '@canopy/desktop-shared/types';
import {
  clearAllProviderQuotaReached,
  markProviderQuotaReached,
} from '../agents/ai-credits-quota-state';
import {
  loadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from '../lib/canopy-cloud-account-store';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import { loadNativeAiCreditsAvailability } from '../ipc/settings';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../lib/preferences-store';
import type * as PreferencesStore from '../lib/preferences-store';
import type * as ConfigPaths from '../pipelines/config-paths';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type {
  AiCreditsRoutingState,
  NativeAiCreditsAvailability,
  PreferencesData,
} from '@canopy/desktop-shared/types';

const mockRegisterCodexGatewayRoute = jest.fn(
  (options: {
    sessionId: string;
    upstreamUrl: string;
    resolveToken: () => Promise<
      string | { token: string; credentialVersion?: string } | null
    >;
    onCredentialRejected?: (
      status: 401 | 403,
      credentialVersion?: string,
    ) => Promise<void> | void;
  }) => {
    void options;
    return Promise.resolve({
      routeId: 'route-id',
      baseUrl: 'http://127.0.0.1:43123/codex-gateway/route-id',
    });
  },
);

const mockGetEnhancedEnv = jest.fn(
  (...args: unknown[]): Record<string, string | undefined> => {
    void args;
    return { PATH: '/mock/bin' };
  },
);
const mockGatewayEnforced = jest.fn(() => Promise.resolve(false));
const mockLoadGatewayCredential = jest.fn();
const mockMarkGatewayCredentialRejected = jest.fn();
const mockReadWorkspaceIndexEntry = jest.fn();
const mockReadWorkspaceWorktrees = jest.fn();
const mockReadWorkspaceOwnership = jest.fn();
const mockResolveBackgroundWorkOwner = jest.fn(
  (...args: unknown[]): Promise<WorkOwner | undefined> => {
    void args;
    return Promise.resolve(undefined);
  },
);
const mockResolveInvocationWorkOwner = jest.fn(
  (...args: unknown[]): Promise<WorkOwner | undefined> => {
    void args;
    return Promise.resolve(undefined);
  },
);
const mockResolveSessionWorkOwner = jest.fn(
  (...args: unknown[]): Promise<WorkOwner | undefined> => {
    void args;
    return Promise.resolve(undefined);
  },
);

function isStringKeyedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const mockNativeAccountChangedAt: Partial<Record<'claude' | 'codex', number>> =
  {};
jest.mock('../agents/native-account-change', () => ({
  getNativeAccountChangedAt: (
    provider: 'claude' | 'codex',
  ): number | undefined => mockNativeAccountChangedAt[provider],
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: jest.fn(),
  subscribeCanopyCloudAccountChanges: jest.fn(() => (): void => undefined),
  // Read immediately after each account load so the routing context can tell a
  // FAILED read from a real sign-out. Conclusive by default here.
  isCanopyCloudAccountReadDegraded: jest.fn(() => false),
}));
jest.mock('../lib/preferences-store', () => {
  const actual = jest.requireActual<typeof PreferencesStore>(
    '../lib/preferences-store',
  );
  return {
    ...actual,
    readPreferencesFile: jest.fn(),
  };
});
jest.mock('../canopy-cloud/config', () => ({
  getCanopyCloudBaseUrl: jest.fn(),
}));
jest.mock('../ipc/settings', () => ({
  loadNativeAiCreditsAvailability: jest.fn(),
}));
jest.mock('../auth/provider-auth-state', () => {
  const isProviderNativelyAuthenticated = jest.fn();
  return {
    isProviderNativelyAuthenticated,
    // ECW-9091: `resolveAiCreditsRoutingOverride` routes through the
    // stale-cache fast-path variant. Share one mock so these tests keep
    // controlling native auth from a single place.
    isProviderNativelyAuthenticatedForRouting: isProviderNativelyAuthenticated,
  };
});
jest.mock('../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(
    (): { registerRoute: typeof mockRegisterCodexGatewayRoute } => ({
      registerRoute: mockRegisterCodexGatewayRoute,
    }),
  ),
}));
jest.mock('../lib/model-gateway-state', () => ({
  getModelGatewayRequirementForOwner: async (): Promise<unknown> =>
    (await mockGatewayEnforced())
      ? { kind: 'enforced', organizationIds: ['org-1'] }
      : { kind: 'unrestricted' },
  checkModelGatewayRoute: async (modelId: string): Promise<unknown> => {
    const entry = resolveGatewayModelEntry(modelId);
    return (await mockGatewayEnforced()) && entry?.origin !== 'org-gateway'
      ? {
          ok: false,
          message: 'Acme requires model traffic to use its configured gateway.',
        }
      : { ok: true, orgRoute: entry?.origin === 'org-gateway' };
  },
}));
const mockAccountProxyRoute = jest.fn(
  (
    ...args: unknown[]
  ): Promise<{
    env: Record<string, string>;
    codexConfig?: Record<string, unknown>;
  } | null> => {
    void args;
    return Promise.resolve(null);
  },
);
jest.mock('../account-proxy/routing', () => ({
  resolveAccountProxySessionRoute: (...args: unknown[]): unknown =>
    mockAccountProxyRoute(...args),
}));
jest.mock('../lib/model-gateway-credential-store', () => ({
  loadModelGatewayCredential: (...args: unknown[]): unknown =>
    mockLoadGatewayCredential(...args),
  markModelGatewayCredentialRejected: (...args: unknown[]): unknown =>
    mockMarkGatewayCredentialRejected(...args),
}));
jest.mock('../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));
jest.mock('../agents/work-owner', () => ({
  resolveBackgroundWorkOwner: (...args: unknown[]): unknown =>
    mockResolveBackgroundWorkOwner(...args),
  resolveInvocationWorkOwner: (...args: unknown[]): unknown =>
    mockResolveInvocationWorkOwner(...args),
  resolveSessionWorkOwner: (...args: unknown[]): unknown =>
    mockResolveSessionWorkOwner(...args),
}));
jest.mock('../lib/sidebar-items', () => ({
  readWorkspaceIndexEntry: (...args: unknown[]): unknown =>
    mockReadWorkspaceIndexEntry(...args),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceWorktrees: (...args: unknown[]): unknown =>
    mockReadWorkspaceWorktrees(...args),
  readWorkspaceOwnership: (...args: unknown[]): unknown =>
    mockReadWorkspaceOwnership(...args),
}));
// `hasUserSuppliedProviderCredential` reads the effective spawn environment.
// Keep the rest of the module real so nothing else in the graph changes shape.
jest.mock('../pipelines/config-paths', () => {
  const actual = jest.requireActual<typeof ConfigPaths>(
    '../pipelines/config-paths',
  );
  return {
    ...actual,
    // Indirected so the factory (hoisted above the `const` below) does not
    // dereference the mock at module-eval time.
    getEnhancedEnv: (
      ...args: Parameters<typeof actual.getEnhancedEnv>
    ): Record<string, string | undefined> => mockGetEnhancedEnv(...args),
  };
});

const loadAccountMock = jest.mocked(loadCanopyCloudAccount);
const subscribeAccountChangesMock = jest.mocked(
  subscribeCanopyCloudAccountChanges,
);
const accountChangeListener = subscribeAccountChangesMock.mock.calls[0]?.[0];
const baseUrlMock = jest.mocked(getCanopyCloudBaseUrl);
const availabilityMock = jest.mocked(loadNativeAiCreditsAvailability);
const readPreferencesMock = jest.mocked(readPreferencesFile);
const nativeAuthMock = jest.mocked(isProviderNativelyAuthenticated);

function makePreferences(
  mode: PreferencesData['aiCreditsRoutingMode'],
): PreferencesData {
  return { ...DEFAULT_PREFERENCES, aiCreditsRoutingMode: mode };
}

const CLOUD_BASE = 'https://cloud.example.com';

// Claude Code resolves its aliases, background model and subagent model from
// these variables. A guest's proxy refuses any model off the allowlist.
const CLAUDE_PINNED_MODEL_ENV_NAMES = [
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

function makeAccount(
  overrides: Partial<CanopyCloudAccountEntry> = {},
): CanopyCloudAccountEntry {
  return {
    apiKey: 'csk_test',
    account: {
      id: 'account-a',
      name: 'Account A',
      email: 'a@example.com',
      role: 'DEVELOPER',
    },
    capabilities: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeAvailability(
  overrides: Partial<NativeAiCreditsAvailability> = {},
): NativeAiCreditsAvailability {
  return {
    personalEligible: false,
    inOrg: false,
    orgCreditPoolCovered: false,
    orgSpendable: false,
    pricingUrl: `${CLOUD_BASE}/pricing`,
    ...overrides,
  };
}

/**
 * Re-import the module under a substituted brand so the assertions below prove
 * the copy is derived from the brand runtime rather than matching the default
 * brand's display name by coincidence.
 */
async function importWithBrand(displayName: string): Promise<{
  buildCodexProxyConfig: typeof buildCodexProxyConfig;
  buildCodexProxyConfigObject: typeof buildCodexProxyConfigObject;
}> {
  return new Promise((resolve) => {
    jest.isolateModules(() => {
      jest.doMock('@canopy/brand/current', () => {
        const actual = jest.requireActual<{ BRAND: Record<string, unknown> }>(
          '@canopy/brand/current',
        );
        return {
          __esModule: true,
          BRAND: { ...actual.BRAND, displayName },
        };
      });
      const mod = require('../agents/ai-credits-routing') as {
        buildCodexProxyConfig: typeof buildCodexProxyConfig;
        buildCodexProxyConfigObject: typeof buildCodexProxyConfigObject;
      };
      jest.dontMock('@canopy/brand/current');
      resolve(mod);
    });
  });
}

beforeAll(() => {
  const pkg: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  );
  const config = parseModelPackageConfig(pkg);
  const matched = [...config.claudeModels, ...config.codexModels].flatMap(
    (entry, index) =>
      entry.gatewayId
        ? [
            {
              id: `api-model-${index}`,
              gatewayId: entry.gatewayId,
              label: entry.label,
              recommendedHarness: entry.harness ?? 'codex',
              contextWindow: entry.contextWindow ?? 100_000,
              supportsPromptCaching: entry.harness === 'claude',
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard' as const,
            },
          ]
        : [],
  );
  const apiOnly = [
    ['deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
    ['kimi-k2-thinking', 'moonshotai/kimi-k2-thinking'],
    ['minimax-m3', 'minimax/minimax-m3'],
    ['deepseek-v4-flash', 'deepseek/deepseek-v4-flash'],
    ['glm-5.2', 'zai/glm-5.2'],
    ['kimi-k3', 'moonshotai/kimi-k3'],
  ].map(([id, gatewayId]) => ({
    id: id ?? '',
    gatewayId: gatewayId ?? '',
    label: id ?? '',
    recommendedHarness: 'codex' as const,
    contextWindow: 1_000_000,
    supportsPromptCaching: false,
    supportedThinkingLevels: [],
    toolSchemaProfile:
      id === 'kimi-k3' ? ('flat' as const) : ('standard' as const),
  }));
  const merged = mergeAiGatewayModelCatalog({
    packageConfig: config,
    catalog: { version: 1, models: [...matched, ...apiOnly] },
    featureFlags: { 'canopy-shared-claude-model-fable5': true },
  });
  initClaudeModels(merged.claudeModels);
  initCodexModels(merged.codexModels);
  initAiGatewayModels(merged.aiGatewayModels, merged.gatewayRoutes);
  initModelAliases(merged.modelAliases);
});

describe('ai-credits-routing', () => {
  it('notifies usage projections only when the effective routing choice changes', () => {
    clearAiCreditsRoutingModeCache();
    const listener = jest.fn();
    const unsubscribe = subscribeAiCreditsRoutingModeChanges(listener);
    try {
      setAiCreditsRoutingModeCache('off');
      expect(listener).not.toHaveBeenCalled();
      setAiCreditsRoutingModeCache('on');
      setAiCreditsRoutingModeCache('on');
      expect(listener).toHaveBeenCalledTimes(1);
      clearAiCreditsRoutingModeCache();
      expect(listener).toHaveBeenCalledTimes(2);
      unsubscribe();
      setAiCreditsRoutingModeCache('on-quota');
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
      clearAiCreditsRoutingModeCache();
    }
  });

  describe('buildProxyBaseUrl', () => {
    it('maps each harness to its proxy route and trims trailing slashes', () => {
      expect(buildProxyBaseUrl(`${CLOUD_BASE}/`, 'claude')).toBe(
        `${CLOUD_BASE}/api/v1/llm-proxy/anthropic`,
      );
      expect(buildProxyBaseUrl(CLOUD_BASE, 'codex')).toBe(
        `${CLOUD_BASE}/api/v1/llm-proxy/openai/responses`,
      );
    });
  });

  describe('registry-driven harness selection', () => {
    it('routes a configured other model through the codex harness', () => {
      const entry = resolveGatewayModelEntry('deepseek-v4-pro');
      expect(entry).toBeDefined();
      expect(entry?.recommendedHarness).toBe('codex');
      expect(entry?.gatewayId).toBe('deepseek/deepseek-v4-pro');
      expect(entry?.gatewayOnly).toBe(true);
    });

    it('routes an Anthropic-family model through the claude harness', () => {
      const entry = resolveGatewayModelEntry('opus[1m]');
      expect(entry?.recommendedHarness).toBe('claude');
    });

    it('returns undefined for unknown / missing model ids', () => {
      expect(resolveGatewayModelEntry('not-a-real-model')).toBeUndefined();
      expect(resolveGatewayModelEntry(undefined)).toBeUndefined();
    });

    // Regression guard: the resolver must accept the runtime `ChatModel` ids the
    // app actually spawns sessions with (bundled Claude ids + short aliases),
    // not just the dotted registry keys. A strict `===` lookup silently no-ops
    // routing for every Claude model, which the earlier tests did not catch.
    it.each([
      ['opus[1m]', 'opus[1m]'],
      ['opus', 'opus[1m]'],
      ['sonnet[1m]', 'sonnet'],
      ['sonnet', 'sonnet'],
      ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'],
      ['haiku', 'haiku'],
      ['claude-haiku-5-5', 'haiku'],
      ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
    ])(
      'resolves runtime Claude id %s to the %s entry',
      (runtimeId, modelId) => {
        const entry = resolveGatewayModelEntry(runtimeId);
        expect(entry).toBeDefined();
        expect(entry?.modelId).toBe(modelId);
        expect(entry?.recommendedHarness).toBe('claude');
      },
    );

    it('resolves a runtime Codex id that matches a registry key directly', () => {
      const entry = resolveGatewayModelEntry('gpt-6-luna');
      expect(entry?.recommendedHarness).toBe('codex');
      expect(entry?.modelId).toBe('gpt-6-luna');
    });

    // The 5 additional gateway-only models route through the Codex harness /
    // `responses` wire (the proven DeepSeek lane) and force gateway routing.
    it.each([
      'kimi-k2-thinking',
      'minimax-m3',
      'deepseek-v4-flash',
      'glm-5.2',
      'kimi-k3',
    ])(
      'routes the gateway-only %s model through the codex harness',
      (modelId) => {
        const entry = resolveGatewayModelEntry(modelId);
        expect(entry).toBeDefined();
        expect(entry?.recommendedHarness).toBe('codex');
        expect(entry?.gatewayOnly).toBe(true);
      },
    );
  });

  describe('buildClaudeProxyEnv', () => {
    it('derives the base URL from the recommended harness', () => {
      const entry = resolveGatewayModelEntry('opus[1m]');
      if (!entry) {
        throw new Error('expected opus[1m] registry entry');
      }
      const env = buildClaudeProxyEnv(entry, 'csk_test', CLOUD_BASE);
      expect(env.ANTHROPIC_BASE_URL).toBe(
        `${CLOUD_BASE}/api/v1/llm-proxy/anthropic`,
      );
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('csk_test');
      expect(env.ANTHROPIC_API_KEY).toBe('');
      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
    });

    it('sends the work owner unencoded beside the encoded display names', () => {
      const entry = resolveGatewayModelEntry('opus[1m]');
      if (!entry) {
        throw new Error('expected opus[1m] registry entry');
      }
      const env = buildClaudeProxyEnv(entry, 'csk_test', CLOUD_BASE, {
        workspaceName: 'Payments API',
        workOwner: {
          kind: 'organization',
          organizationId: '123e4567-e89b-12d3-a456-426614174000',
        },
      });
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
        [
          'x-canopy-model-library-protocol: 1',
          'x-canopy-workspace: Payments%20API',
          'x-canopy-work-owner: org:123e4567-e89b-12d3-a456-426614174000',
        ].join('\n'),
      );
    });

    it('sets CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS for non-Anthropic models', () => {
      const entry = resolveGatewayModelEntry('deepseek-v4-pro');
      if (!entry) {
        throw new Error('expected deepseek-v4-pro registry entry');
      }
      const env = buildClaudeProxyEnv(
        {
          ...entry,
          recommendedHarness: 'claude',
        },
        'csk_test',
        CLOUD_BASE,
      );
      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1');
    });

    // CAN-4647: the gateway rejects inline `tool_definition` blocks with
    // `messages.N.content: Invalid input`, which the CLI cannot recognize.
    it.each(['haiku', 'opus[1m]', 'deepseek-v4-pro'])(
      'turns off inline tool definitions for %s',
      (modelId) => {
        const entry = resolveGatewayModelEntry(modelId);
        if (!entry) {
          throw new Error(`expected ${modelId} registry entry`);
        }
        const env = buildClaudeProxyEnv(
          { ...entry, recommendedHarness: 'claude' },
          'csk_test',
          CLOUD_BASE,
        );
        expect(env.CLAUDE_CODE_INLINE_TOOLS).toBe('false');
      },
    );

    describe('guest principal model pinning', () => {
      function requireHaikuEntry(): NonNullable<
        ReturnType<typeof resolveGatewayModelEntry>
      > {
        const entry = resolveGatewayModelEntry('haiku');
        if (!entry) {
          throw new Error('expected haiku registry entry');
        }
        return entry;
      }

      it('pins every alias and background model to the session gateway id for a guest', () => {
        const entry = requireHaikuEntry();
        const env = buildClaudeProxyEnv(
          entry,
          'csk_test',
          CLOUD_BASE,
          undefined,
          { guestPrincipal: true },
        );
        for (const name of CLAUDE_PINNED_MODEL_ENV_NAMES) {
          expect(env[name]).toBe(entry.gatewayId);
        }
      });

      it('forces the subagent model over agent frontmatter for a guest', () => {
        const env = buildClaudeProxyEnv(
          requireHaikuEntry(),
          'csk_test',
          CLOUD_BASE,
          undefined,
          { guestPrincipal: true },
        );
        expect(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBe('1');
      });

      it('pins the session gateway id, not a fixed model', () => {
        const entry = resolveGatewayModelEntry('opus[1m]');
        if (!entry) {
          throw new Error('expected opus[1m] registry entry');
        }
        const env = buildClaudeProxyEnv(
          entry,
          'csk_test',
          CLOUD_BASE,
          undefined,
          { guestPrincipal: true },
        );
        for (const name of CLAUDE_PINNED_MODEL_ENV_NAMES) {
          expect(env[name]).toBe(entry.gatewayId);
        }
      });

      it('leaves alias and background models alone for a signed-in account', () => {
        const env = buildClaudeProxyEnv(
          requireHaikuEntry(),
          'csk_test',
          CLOUD_BASE,
          undefined,
          { guestPrincipal: false },
        );
        for (const name of CLAUDE_PINNED_MODEL_ENV_NAMES) {
          expect(env).not.toHaveProperty(name);
        }
        expect(env).not.toHaveProperty('CLAUDE_CODE_SUBAGENT_MODEL_FORCE');
      });

      it('treats an omitted guest flag as signed in', () => {
        const env = buildClaudeProxyEnv(
          requireHaikuEntry(),
          'csk_test',
          CLOUD_BASE,
        );
        for (const name of CLAUDE_PINNED_MODEL_ENV_NAMES) {
          expect(env).not.toHaveProperty(name);
        }
      });

      it('pins on the loopback broker base URL builder for a guest', () => {
        const entry = requireHaikuEntry();
        const env = buildClaudeProxyEnvForBaseUrl(
          entry,
          'canopy-loopback-broker',
          'http://127.0.0.1:43123/codex-gateway/route-id',
          undefined,
          { guestPrincipal: true },
        );
        for (const name of CLAUDE_PINNED_MODEL_ENV_NAMES) {
          expect(env[name]).toBe(entry.gatewayId);
        }
      });
    });
  });

  describe('buildCodexProxyConfig', () => {
    it('builds a provider block and selects the gateway slug as the model', () => {
      const entry = resolveGatewayModelEntry('deepseek-v4-pro');
      if (!entry) {
        throw new Error('expected deepseek-v4-pro registry entry');
      }
      const loopbackUrl =
        'http://127.0.0.1:43123/codex-gateway/0123456789abcdef0123456789abcdef0123456789abcdef';
      const config = buildCodexProxyConfig(entry, loopbackUrl);
      expect(config.model).toBe('deepseek/deepseek-v4-pro');
      expect(config.env).toEqual({});
      expect(config.configOverrides.model).toBe('deepseek/deepseek-v4-pro');
      expect(config.configOverrides.model_provider).toBe(
        AI_CREDITS_CODEX_PROVIDER_ID,
      );
      expect(
        config.configOverrides[
          `model_providers.${AI_CREDITS_CODEX_PROVIDER_ID}.base_url`
        ],
      ).toBe(loopbackUrl);
      expect(
        config.configOverrides[
          `model_providers.${AI_CREDITS_CODEX_PROVIDER_ID}.wire_api`
        ],
      ).toBe('responses');
      expect(
        config.configOverrides[
          `model_providers.${AI_CREDITS_CODEX_PROVIDER_ID}.requires_openai_auth`
        ],
      ).toBe('false');
      expect(
        config.configOverrides[
          `model_providers.${AI_CREDITS_CODEX_PROVIDER_ID}.env_key`
        ],
      ).toBeUndefined();
    });
  });

  describe('getAiCreditsRoutingContext', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      clearAiCreditsRoutingContextCache();
      baseUrlMock.mockReturnValue(CLOUD_BASE);
    });

    it('surfaces creditsEligible from a personal balance and memoizes within the TTL', async () => {
      loadAccountMock.mockResolvedValue(makeAccount());
      availabilityMock.mockResolvedValue(
        makeAvailability({ personalEligible: true }),
      );

      const first = await getAiCreditsRoutingContext();
      expect(first?.creditsEligible).toBe(true);
      expect(first?.cskToken).toBe('csk_test');
      expect(first?.cloudBaseUrl).toBe(CLOUD_BASE);

      const second = await getAiCreditsRoutingContext();
      // Cached: identical reference and no repeated blocking cloud reads.
      expect(second).toBe(first);
      expect(loadAccountMock).toHaveBeenCalledTimes(1);
      expect(availabilityMock).toHaveBeenCalledTimes(1);
    });

    it('isolates routing-context cache entries by work owner', async () => {
      loadAccountMock.mockResolvedValue(makeAccount());
      availabilityMock.mockImplementation((owner?: WorkOwner) =>
        Promise.resolve(
          makeAvailability({
            orgSpendable:
              owner?.kind === 'organization' &&
              owner.organizationId === 'org-a',
          }),
        ),
      );

      const ownerA = {
        kind: 'organization',
        organizationId: 'org-a',
      } as const;
      const ownerB = {
        kind: 'organization',
        organizationId: 'org-b',
      } as const;
      await expect(
        getAiCreditsRoutingContext({ owner: ownerA }),
      ).resolves.toMatchObject({ creditsEligible: true });
      await expect(
        getAiCreditsRoutingContext({ owner: ownerB }),
      ).resolves.toMatchObject({ creditsEligible: false });
      await getAiCreditsRoutingContext({ owner: ownerA });

      expect(availabilityMock).toHaveBeenCalledTimes(2);
      expect(availabilityMock).toHaveBeenNthCalledWith(1, ownerA);
      expect(availabilityMock).toHaveBeenNthCalledWith(2, ownerB);
    });

    it('activates on-quota routing for an org-covered member with spendable headroom', async () => {
      loadAccountMock.mockResolvedValue(makeAccount());
      availabilityMock.mockResolvedValue(
        makeAvailability({
          personalEligible: false,
          inOrg: true,
          orgCreditPoolCovered: true,
          orgSpendable: true,
        }),
      );

      const ctx = await getAiCreditsRoutingContext();
      expect(ctx?.creditsEligible).toBe(true);
    });

    it('reflects no coverage and re-reads after the cache is cleared', async () => {
      loadAccountMock.mockResolvedValue(makeAccount());
      availabilityMock.mockResolvedValue(makeAvailability());

      const first = await getAiCreditsRoutingContext();
      expect(first?.creditsEligible).toBe(false);

      clearAiCreditsRoutingContextCache();
      await getAiCreditsRoutingContext();
      expect(availabilityMock).toHaveBeenCalledTimes(2);
    });

    it('marks a guest credential as a guest principal', async () => {
      loadAccountMock.mockResolvedValue(
        makeAccount({ credentialSource: 'guest', authMode: 'guest' }),
      );
      availabilityMock.mockResolvedValue(
        makeAvailability({ personalEligible: true }),
      );

      await expect(getAiCreditsRoutingContext()).resolves.toMatchObject({
        guestPrincipal: true,
      });
    });

    it('marks a normalized guest credential as a guest principal', async () => {
      // The account store can normalize a guest's source to 'manual' while
      // keeping authMode 'guest'; the shared guest helper covers both fields.
      loadAccountMock.mockResolvedValue(
        makeAccount({ credentialSource: 'manual', authMode: 'guest' }),
      );
      availabilityMock.mockResolvedValue(makeAvailability());

      await expect(getAiCreditsRoutingContext()).resolves.toMatchObject({
        guestPrincipal: true,
      });
    });

    it('does not mark a signed-in account as a guest principal', async () => {
      loadAccountMock.mockResolvedValue(
        makeAccount({ credentialSource: 'oauth_desktop', authMode: 'oauth' }),
      );
      availabilityMock.mockResolvedValue(
        makeAvailability({ personalEligible: true }),
      );

      await expect(getAiCreditsRoutingContext()).resolves.toMatchObject({
        guestPrincipal: false,
      });
    });

    it('does not mark a key without a loaded profile as a guest principal', async () => {
      loadAccountMock.mockResolvedValue(makeAccount({ account: undefined }));
      availabilityMock.mockResolvedValue(makeAvailability());

      await expect(getAiCreditsRoutingContext()).resolves.toMatchObject({
        guestPrincipal: false,
      });
    });

    it('returns null without hitting the availability read when no secret key exists', async () => {
      loadAccountMock.mockResolvedValue(null);

      const ctx = await getAiCreditsRoutingContext();
      expect(ctx).toBeNull();
      expect(availabilityMock).not.toHaveBeenCalled();
    });

    it('invalidates a cached signed-out result when the cloud account changes', async () => {
      loadAccountMock.mockResolvedValueOnce(null);
      await expect(getAiCreditsRoutingContext()).resolves.toBeNull();

      loadAccountMock.mockResolvedValue(makeAccount());
      availabilityMock.mockResolvedValue(
        makeAvailability({ personalEligible: true }),
      );
      expect(accountChangeListener).toBeDefined();
      accountChangeListener?.(makeAccount());

      await expect(getAiCreditsRoutingContext()).resolves.toMatchObject({
        creditsEligible: true,
        cskToken: 'csk_test',
      });
      expect(loadAccountMock).toHaveBeenCalledTimes(2);
    });

    it('does not cache an in-flight routing context after the account changes', async () => {
      let resolveOldAvailability:
        | ((value: NativeAiCreditsAvailability) => void)
        | undefined;
      const oldAvailability = new Promise<NativeAiCreditsAvailability>(
        (resolve) => {
          resolveOldAvailability = resolve;
        },
      );
      loadAccountMock
        .mockResolvedValueOnce(makeAccount())
        .mockResolvedValueOnce(
          makeAccount({
            apiKey: 'csk_new',
            account: {
              id: 'account-b',
              name: 'Account B',
              email: 'b@example.com',
              role: 'DEVELOPER',
            },
          }),
        );
      availabilityMock
        .mockImplementationOnce(() => oldAvailability)
        .mockResolvedValueOnce(makeAvailability({ personalEligible: true }));

      const routing = getAiCreditsRoutingContext();
      await Promise.resolve();
      expect(availabilityMock).toHaveBeenCalledTimes(1);
      accountChangeListener?.(
        makeAccount({
          apiKey: 'csk_new',
          account: {
            id: 'account-b',
            name: 'Account B',
            email: 'b@example.com',
            role: 'DEVELOPER',
          },
        }),
      );
      resolveOldAvailability?.(makeAvailability());

      await expect(routing).resolves.toMatchObject({
        accountIdentity: 'account-b',
        cskToken: 'csk_new',
      });
      await expect(getAiCreditsRoutingContext()).resolves.toMatchObject({
        accountIdentity: 'account-b',
        cskToken: 'csk_new',
      });
      expect(loadAccountMock).toHaveBeenCalledTimes(2);
    });

    // Per-org billing gate (CAN-2311). Routing adds NO account-wide lapse
    // check: it composes the org half purely from `orgSpendable`, which is an
    // `.some()` over the per-org `loadOrgAiCreditsSpendable` read (gated there,
    // and covered in settings.test.ts). These two cases pin that composition —
    // a lapsed org contributes nothing, and a healthy org still routes even
    // when the account also belongs to a lapsed one.
    it('is not eligible when the only org in play has lapsed out of the credit pool', async () => {
      loadAccountMock.mockResolvedValue(
        makeAccount({
          orgBillingStates: [
            {
              organizationId: 'org-lapsed',
              organizationName: 'Lapsed Co',
              teamsEntitled: false,
            },
          ],
        }),
      );
      // The lapsed org reports no spendable headroom, so the `.some()` is false.
      availabilityMock.mockResolvedValue(
        makeAvailability({
          personalEligible: false,
          inOrg: true,
          orgCreditPoolCovered: false,
          orgSpendable: false,
        }),
      );

      const ctx = await getAiCreditsRoutingContext();
      expect(ctx?.creditsEligible).toBe(false);
    });

    it('stays eligible through a HEALTHY org while another org is lapsed', async () => {
      loadAccountMock.mockResolvedValue(
        makeAccount({
          orgBillingStates: [
            {
              organizationId: 'org-lapsed',
              organizationName: 'Lapsed Co',
              teamsEntitled: false,
            },
            {
              organizationId: 'org-healthy',
              organizationName: 'Healthy Co',
              teamsEntitled: true,
            },
          ],
        }),
      );
      // Only the healthy org contributes headroom, and that is enough.
      availabilityMock.mockResolvedValue(
        makeAvailability({
          personalEligible: false,
          inOrg: true,
          orgCreditPoolCovered: true,
          orgSpendable: true,
        }),
      );

      const ctx = await getAiCreditsRoutingContext();
      expect(ctx?.creditsEligible).toBe(true);
    });
  });

  describe('resolveAiCreditsRoutingActivation', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      clearAiCreditsRoutingModeCache();
      clearAllProviderQuotaReached();
    });

    function activeState(modelId?: string): AiCreditsRoutingState {
      return {
        active: true,
        scope: 'session',
        activatedAt: 0,
        ...(modelId ? { modelId } : {}),
      };
    }

    function flushMicrotasks(): Promise<void> {
      return new Promise((resolve) => setImmediate(resolve));
    }

    it('activates from the per-session flag regardless of mode', () => {
      setAiCreditsRoutingModeCache('off');
      expect(
        resolveAiCreditsRoutingActivation(activeState(), 'claude'),
      ).toEqual({ modelId: undefined });
    });

    it('carries the per-session modelId override', () => {
      setAiCreditsRoutingModeCache('off');
      expect(
        resolveAiCreditsRoutingActivation(activeState('opus[1m]'), 'claude'),
      ).toEqual({ modelId: 'opus[1m]' });
    });

    it('activates globally when the mode is on and no per-session state exists', () => {
      setAiCreditsRoutingModeCache('on');
      expect(resolveAiCreditsRoutingActivation(undefined, 'claude')).toEqual(
        {},
      );
    });

    it('does not activate when the mode is off', () => {
      setAiCreditsRoutingModeCache('off');
      expect(resolveAiCreditsRoutingActivation(undefined, 'claude')).toBeNull();
    });

    it('activates on-quota only once the provider quota is reached', () => {
      setAiCreditsRoutingModeCache('on-quota');

      // Not reached yet -> stays native.
      expect(resolveAiCreditsRoutingActivation(undefined, 'claude')).toBeNull();

      markProviderQuotaReached('claude');
      expect(resolveAiCreditsRoutingActivation(undefined, 'claude')).toEqual(
        {},
      );
    });

    it('scopes on-quota activation to the reached provider', () => {
      setAiCreditsRoutingModeCache('on-quota');
      markProviderQuotaReached('codex');

      expect(resolveAiCreditsRoutingActivation(undefined, 'codex')).toEqual({});
      // Claude quota not reached -> Claude sessions stay native.
      expect(resolveAiCreditsRoutingActivation(undefined, 'claude')).toBeNull();
    });

    it('auto-reverts on-quota once the reset time passes', () => {
      setAiCreditsRoutingModeCache('on-quota');
      // A reset time already in the past expires immediately on read.
      markProviderQuotaReached('codex', Date.now() - 1);

      expect(resolveAiCreditsRoutingActivation(undefined, 'codex')).toBeNull();
    });

    it('serves the native default on a cold cache and refreshes in the background', async () => {
      readPreferencesMock.mockResolvedValue(makePreferences('on'));

      // Stale-while-revalidate: the cold read is non-blocking and returns the
      // default rather than awaiting disk on the timing-sensitive spawn path.
      expect(resolveAiCreditsRoutingActivation(undefined, 'claude')).toBeNull();

      // The background refresh then picks up the persisted mode.
      await flushMicrotasks();
      expect(readPreferencesMock).toHaveBeenCalled();
      expect(resolveAiCreditsRoutingActivation(undefined, 'claude')).toEqual(
        {},
      );
    });
  });

  describe('stale session routing (CAN-4200)', () => {
    const NOW = 1_800_000_000_000;

    beforeEach(() => {
      jest.clearAllMocks();
      clearAiCreditsRoutingModeCache();
      clearAllProviderQuotaReached();
      setAiCreditsRoutingModeCache('off');
      delete mockNativeAccountChangedAt.claude;
      delete mockNativeAccountChangedAt.codex;
      jest.useFakeTimers({ now: NOW });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function session(
      overrides: Partial<AiCreditsRoutingState> = {},
    ): AiCreditsRoutingState {
      return {
        active: true,
        scope: 'session',
        activatedAt: NOW - 10_000,
        ...overrides,
      };
    }

    const authed = (): Promise<boolean> => Promise.resolve(true);

    it('ignores session routing after its reset time', async () => {
      const routing = session({ resetsAt: NOW - 1 });
      expect(resolveAiCreditsRoutingActivation(routing, 'claude')).toBeNull();
      await expect(
        resolveAiCreditsRoutingAttempt(routing, 'claude', authed),
      ).resolves.toBeNull();
    });

    it('ignores session routing activated before an account change', async () => {
      mockNativeAccountChangedAt.claude = NOW - 5_000;
      const routing = session();
      expect(resolveAiCreditsRoutingActivation(routing, 'claude')).toBeNull();
      await expect(
        resolveAiCreditsRoutingAttempt(routing, 'claude', authed),
      ).resolves.toBeNull();
    });

    it('ignores session routing with no activation time once an account change is recorded', () => {
      mockNativeAccountChangedAt.codex = 1;
      expect(
        resolveAiCreditsRoutingActivation(
          // Legacy persisted routing can lack activatedAt.
          Object.assign(session(), { activatedAt: undefined }),
          'codex',
        ),
      ).toBeNull();
    });

    it('keeps Claude session routing when only Codex changed accounts', () => {
      mockNativeAccountChangedAt.codex = NOW - 1;
      expect(resolveAiCreditsRoutingActivation(session(), 'claude')).toEqual({
        modelId: undefined,
      });
    });

    it('applies only the reset rule for a provider with no billed account', () => {
      mockNativeAccountChangedAt.claude = NOW - 1;
      mockNativeAccountChangedAt.codex = NOW - 1;
      expect(resolveAiCreditsRoutingActivation(session(), 'ollama')).toEqual({
        modelId: undefined,
      });
      expect(
        resolveAiCreditsRoutingActivation(session({ resetsAt: NOW }), 'ollama'),
      ).toBeNull();
    });

    it('keeps persistent routing regardless of reset or account change', async () => {
      mockNativeAccountChangedAt.claude = NOW - 1;
      const routing = session({ scope: 'persistent', resetsAt: NOW - 1 });
      expect(resolveAiCreditsRoutingActivation(routing, 'claude')).toEqual({
        modelId: undefined,
      });
      await expect(
        resolveAiCreditsRoutingAttempt(routing, 'claude', authed),
      ).resolves.toEqual({ reason: 'session-override' });
    });

    it('keeps legacy session routing with no reset and no account change', async () => {
      await expect(
        resolveAiCreditsRoutingAttempt(session(), 'claude', authed),
      ).resolves.toEqual({ reason: 'session-override' });
    });

    it('falls through stale session routing to the subscription override', async () => {
      setAiCreditsRoutingModeCache('on');
      const isAuthed = jest.fn(authed);
      await expect(
        resolveAiCreditsRoutingAttempt(
          session({ resetsAt: NOW - 1 }),
          'claude',
          isAuthed,
          true,
        ),
      ).resolves.toBeNull();
      expect(isAuthed).toHaveBeenCalledTimes(1);
      // Without the override, stale routing falls through to the mode.
      await expect(
        resolveAiCreditsRoutingAttempt(
          session({ resetsAt: NOW - 1 }),
          'claude',
          authed,
        ),
      ).resolves.toEqual({ reason: 'mode' });
    });

    it('drops stale routing from a send request and keeps fresh routing', () => {
      const base = {
        projectId: 'p',
        worktreeId: 'w',
        chatId: 'c',
        userMessageId: 'u',
        text: 'hi',
        executionHarness: 'codex',
      } as const;
      const stale = withEffectiveAiCreditsRouting({
        ...base,
        aiCreditsRouting: session({ resetsAt: NOW - 1 }),
      });
      expect('aiCreditsRouting' in stale).toBe(false);
      const fresh = session({ resetsAt: NOW + 1 });
      expect(
        withEffectiveAiCreditsRouting({ ...base, aiCreditsRouting: fresh })
          .aiCreditsRouting,
      ).toBe(fresh);
      mockNativeAccountChangedAt.codex = NOW - 1;
      expect(
        'aiCreditsRouting' in
          withEffectiveAiCreditsRouting({ ...base, aiCreditsRouting: fresh }),
      ).toBe(false);
    });
  });

  describe('billedProviderFor', () => {
    it('prefers a Claude or Codex provider type', () => {
      expect(billedProviderFor('claude', 'codex')).toBe('claude');
      expect(billedProviderFor('codex', 'claude')).toBe('codex');
    });

    it('falls back to the pinned harness', () => {
      expect(billedProviderFor('ollama', 'codex')).toBe('codex');
      expect(billedProviderFor(undefined, 'claude')).toBe('claude');
    });

    it('is undefined with neither', () => {
      expect(billedProviderFor()).toBeUndefined();
      expect(billedProviderFor('cursor')).toBeUndefined();
    });
  });

  describe('resolveAiCreditsRoutingAttempt', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      clearAiCreditsRoutingModeCache();
      clearAllProviderQuotaReached();
    });

    function activeState(modelId?: string): AiCreditsRoutingState {
      return {
        active: true,
        scope: 'session',
        activatedAt: 0,
        ...(modelId ? { modelId } : {}),
      };
    }

    const authed = (): Promise<boolean> => Promise.resolve(true);
    const notAuthed = (): Promise<boolean> => Promise.resolve(false);

    it('reports the session-override reason and carries the modelId', async () => {
      setAiCreditsRoutingModeCache('off');
      const attempt = await resolveAiCreditsRoutingAttempt(
        activeState('opus[1m]'),
        'claude',
        notAuthed,
      );
      expect(attempt).toEqual({
        reason: 'session-override',
        modelId: 'opus[1m]',
      });
    });

    it('reports the mode reason when the global mode activates routing', async () => {
      setAiCreditsRoutingModeCache('on');
      const attempt = await resolveAiCreditsRoutingAttempt(
        undefined,
        'claude',
        authed,
      );
      expect(attempt).toEqual({ reason: 'mode' });
    });

    // ECW-9091: `off` used to short-circuit before native auth was ever read,
    // stranding credits-only accounts on a raw `Please run /login`.
    it('auto-routes on a confirmed missing native login even when mode is off', async () => {
      setAiCreditsRoutingModeCache('off');
      const isAuthed = jest.fn(notAuthed);
      const attempt = await resolveAiCreditsRoutingAttempt(
        undefined,
        'codex',
        isAuthed,
      );
      expect(attempt).toEqual({ reason: 'no-native-auth' });
      expect(isAuthed).toHaveBeenCalledTimes(1);
    });

    // The invariant the whole fix leans on: `isProviderNativelyAuthenticated`
    // fails CLOSED (an inconclusive probe resolves `true`), so a `false` is a
    // CONFIRMED signed-out state and an inconclusive probe stays native.
    it('stays native when the auth probe is inconclusive (fails closed)', async () => {
      setAiCreditsRoutingModeCache('off');
      const inconclusive = jest.fn().mockResolvedValue(true);
      const attempt = await resolveAiCreditsRoutingAttempt(
        undefined,
        'claude',
        inconclusive,
      );
      expect(attempt).toBeNull();
      expect(inconclusive).toHaveBeenCalledTimes(1);
    });

    it('reports no-native-auth when on-quota mode has no native login', async () => {
      setAiCreditsRoutingModeCache('on-quota');
      const attempt = await resolveAiCreditsRoutingAttempt(
        undefined,
        'codex',
        notAuthed,
      );
      expect(attempt).toEqual({ reason: 'no-native-auth' });
    });

    it('returns null when mode is off and the provider is natively authenticated', async () => {
      setAiCreditsRoutingModeCache('off');
      const attempt = await resolveAiCreditsRoutingAttempt(
        undefined,
        'claude',
        authed,
      );
      expect(attempt).toBeNull();
    });

    it('gives precedence to the mode trigger over auth state (no auth read)', async () => {
      setAiCreditsRoutingModeCache('on');
      const isAuthed = jest.fn(notAuthed);
      const attempt = await resolveAiCreditsRoutingAttempt(
        undefined,
        'claude',
        isAuthed,
      );
      expect(attempt).toEqual({ reason: 'mode' });
      // The existing sync activation wins first, so native auth is never probed.
      expect(isAuthed).not.toHaveBeenCalled();
    });

    it('never auto-routes a non-Claude/Codex provider on missing auth', async () => {
      setAiCreditsRoutingModeCache('off');
      const isAuthed = jest.fn(notAuthed);
      const attempt = await resolveAiCreditsRoutingAttempt(
        undefined,
        'ollama',
        isAuthed,
      );
      expect(attempt).toBeNull();
      expect(isAuthed).not.toHaveBeenCalled();
    });

    it('subscription override forces native billing and beats mode: on when authed', async () => {
      setAiCreditsRoutingModeCache('on');
      const isAuthed = jest.fn(authed);
      const attempt = await resolveAiCreditsRoutingAttempt(
        undefined,
        'claude',
        isAuthed,
        true,
      );
      expect(attempt).toBeNull();
      expect(isAuthed).toHaveBeenCalledTimes(1);
    });

    it('subscription override is ignored when the provider has no native login (falls through to mode)', async () => {
      setAiCreditsRoutingModeCache('on');
      const isAuthed = jest.fn(notAuthed);
      const attempt = await resolveAiCreditsRoutingAttempt(
        undefined,
        'codex',
        isAuthed,
        true,
      );
      // Cannot honor subscription without a native login, so the global mode routes.
      expect(attempt).toEqual({ reason: 'mode' });
    });

    // ECW-9091: an unhonorable subscription override (no native login to bill)
    // no longer strands the user — it falls through to credits routing.
    it('subscription override without a native login and mode off routes to credits', async () => {
      setAiCreditsRoutingModeCache('off');
      const isAuthed = jest.fn(notAuthed);
      const attempt = await resolveAiCreditsRoutingAttempt(
        undefined,
        'claude',
        isAuthed,
        true,
      );
      expect(attempt).toEqual({ reason: 'no-native-auth' });
      // Probe memoization guard: the override check and the trailing
      // no-native-auth fallback must share a single read.
      expect(isAuthed).toHaveBeenCalledTimes(1);
    });

    it('an active session-override still wins over a subscription override', async () => {
      setAiCreditsRoutingModeCache('off');
      const attempt = await resolveAiCreditsRoutingAttempt(
        activeState('opus[1m]'),
        'claude',
        authed,
        true,
      );
      expect(attempt).toEqual({
        reason: 'session-override',
        modelId: 'opus[1m]',
      });
    });
  });

  describe('buildCodexProxyConfigObject', () => {
    it('builds a nested provider block pointed at the parent loopback proxy', () => {
      const entry = resolveGatewayModelEntry('deepseek-v4-pro');
      if (!entry) {
        throw new Error('expected deepseek-v4-pro registry entry');
      }
      const config = buildCodexProxyConfigObject(entry, CLOUD_BASE);
      expect(config.model).toBe('deepseek/deepseek-v4-pro');
      expect(config.model_provider).toBe(AI_CREDITS_CODEX_PROVIDER_ID);
      const providers = config.model_providers;
      if (!isStringKeyedRecord(providers)) {
        throw new Error('expected model_providers object');
      }
      const provider = providers[AI_CREDITS_CODEX_PROVIDER_ID];
      expect(provider).toMatchObject({
        base_url: CLOUD_BASE,
        wire_api: 'responses',
        requires_openai_auth: false,
      });
      expect(provider).not.toHaveProperty('env_key');
    });

    // The provider display name reaches the Codex app-server config and is shown
    // to the user, so it must carry the active brand, not the legacy literal.
    it('names the provider with the active brand display name', async () => {
      const entry = resolveGatewayModelEntry('deepseek-v4-pro');
      if (!entry) {
        throw new Error('expected deepseek-v4-pro registry entry');
      }
      const branded = await importWithBrand('Acme Code');

      const nested = branded.buildCodexProxyConfigObject(entry, CLOUD_BASE);
      const providers = nested.model_providers;
      if (!isStringKeyedRecord(providers)) {
        throw new Error('expected model_providers object');
      }
      expect(providers[AI_CREDITS_CODEX_PROVIDER_ID]).toMatchObject({
        name: 'Acme Code AI Credits',
      });

      const flat = branded.buildCodexProxyConfig(entry, CLOUD_BASE);
      expect(
        flat.configOverrides[
          `model_providers.${AI_CREDITS_CODEX_PROVIDER_ID}.name`
        ],
      ).toBe('Acme Code AI Credits');
    });
  });

  describe('resolveAiCreditsRoutingOverride', () => {
    it('routes an org model directly with its per-user key and distinct Codex provider', async () => {
      const previousModels = getAiGatewayModelEntries();
      const previousRoutes = getGatewayModelEntries();
      initAiGatewayModels(
        [
          ...previousModels,
          {
            id: 'acme-qwen',
            label: 'Acme Qwen',
            recommendedHarness: 'codex',
            contextWindow: 131_072,
            supportsPromptCaching: true,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'flat',
          },
        ],
        [
          ...previousRoutes,
          {
            modelId: 'acme-qwen',
            gatewayId: 'vertex/qwen',
            family: 'custom',
            recommendedHarness: 'codex',
            gatewayOnly: true,
            contextWindow: 131_072,
            supportsPromptCaching: true,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'flat',
            origin: 'org-gateway',
            baseUrl: 'https://gateway.acme.test',
            organizationId: 'org-1',
            promptCachePassthrough: true,
          },
        ],
      );
      mockLoadGatewayCredential.mockResolvedValue({
        organizationId: 'org-1',
        apiKey: 'sk-org',
        baseUrlAtSave: 'https://gateway.acme.test',
      });

      const override = await resolveAiCreditsRoutingOverride(
        'acme-qwen',
        'codex',
        undefined,
        undefined,
        { workOwner: { kind: 'organization', organizationId: 'org-1' } },
      );

      expect(mockRegisterCodexGatewayRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          upstreamUrl: 'https://gateway.acme.test/v1',
        }),
      );
      expect(
        typeof mockRegisterCodexGatewayRoute.mock.calls[0]?.[0]
          .onCredentialRejected,
      ).toBe('function');
      expect(override?.codexConfig).toMatchObject({
        model_provider: 'canopy_org_gateway',
        model: 'vertex/qwen',
      });
      expect(override?.modelGatewayRouted).toBe(true);
      initAiGatewayModels(previousModels, previousRoutes);
    });

    it('brokers org Claude helpers and pipelines with generation-bound rejection state', async () => {
      const previousModels = getAiGatewayModelEntries();
      const previousRoutes = getGatewayModelEntries();
      initAiGatewayModels(
        [
          ...previousModels,
          {
            id: 'acme-claude',
            label: 'Acme Claude',
            recommendedHarness: 'claude',
            contextWindow: 200_000,
            supportsPromptCaching: true,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard',
          },
        ],
        [
          ...previousRoutes,
          {
            modelId: 'acme-claude',
            gatewayId: 'anthropic/acme-claude',
            family: 'custom',
            recommendedHarness: 'claude',
            gatewayOnly: true,
            contextWindow: 200_000,
            supportsPromptCaching: true,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard',
            origin: 'org-gateway',
            baseUrl: 'https://gateway.acme.test',
            organizationId: 'org-1',
            promptCachePassthrough: true,
          },
        ],
      );
      mockLoadGatewayCredential.mockResolvedValue({
        organizationId: 'org-1',
        apiKey: 'sk-org',
        baseUrlAtSave: 'https://gateway.acme.test',
        updatedAt: 'credential-v1',
      });
      mockMarkGatewayCredentialRejected.mockResolvedValue(true);

      const override = await resolveAiCreditsRoutingOverride(
        'acme-claude',
        'claude',
        undefined,
        undefined,
        { workOwner: { kind: 'organization', organizationId: 'org-1' } },
      );

      const registration = mockRegisterCodexGatewayRoute.mock.calls[0]?.[0];
      expect(registration?.sessionId).toMatch(/^ephemeral:/);
      expect(registration?.upstreamUrl).toBe('https://gateway.acme.test');
      expect(typeof registration?.resolveToken).toBe('function');
      expect(typeof registration?.onCredentialRejected).toBe('function');
      expect(override?.env).toMatchObject({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123/codex-gateway/route-id',
        ANTHROPIC_AUTH_TOKEN: 'canopy-loopback-broker',
      });
      expect(Object.values(override?.env ?? {})).not.toContain('sk-org');
      mockLoadGatewayCredential.mockResolvedValue({
        organizationId: 'org-1',
        apiKey: 'sk-org-rotated',
        baseUrlAtSave: 'https://gateway.acme.test',
        updatedAt: 'credential-v2',
      });
      await expect(registration?.resolveToken()).resolves.toEqual({
        token: 'sk-org-rotated',
        credentialVersion: 'credential-v2',
      });
      mockLoadGatewayCredential.mockResolvedValue(null);
      await expect(registration?.resolveToken()).resolves.toBeNull();
      await registration?.onCredentialRejected?.(401, 'credential-v1');
      expect(mockMarkGatewayCredentialRejected).toHaveBeenCalledWith(
        'org-1',
        'Gateway returned HTTP 401.',
        'credential-v1',
      );
      initAiGatewayModels(previousModels, previousRoutes);
    });

    it('keeps workspace attribution headers on a direct org Codex route', async () => {
      const previousModels = getAiGatewayModelEntries();
      const previousRoutes = getGatewayModelEntries();
      initAiGatewayModels(
        [
          ...previousModels,
          {
            id: 'acme-attributed',
            label: 'Acme Attributed',
            recommendedHarness: 'codex',
            contextWindow: 131_072,
            supportsPromptCaching: true,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'flat',
          },
        ],
        [
          ...previousRoutes,
          {
            modelId: 'acme-attributed',
            gatewayId: 'vertex/attributed',
            family: 'custom',
            recommendedHarness: 'codex',
            gatewayOnly: true,
            contextWindow: 131_072,
            supportsPromptCaching: true,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'flat',
            origin: 'org-gateway',
            baseUrl: 'https://gateway.acme.test',
            organizationId: 'org-1',
            promptCachePassthrough: true,
          },
        ],
      );
      mockLoadGatewayCredential.mockResolvedValue({
        organizationId: 'org-1',
        apiKey: 'sk-org',
        baseUrlAtSave: 'https://gateway.acme.test',
      });
      mockReadWorkspaceIndexEntry.mockResolvedValue({ name: 'Payments API' });
      mockReadWorkspaceOwnership.mockResolvedValue({
        authority: 'ok',
        type: 'cowork',
        owner: {
          type: 'organization',
          organizationId: 'org-1',
          projectId: 'project-1',
          instanceId: 'instance-1',
          bindingGeneration: 1,
        },
      });
      mockReadWorkspaceWorktrees.mockResolvedValue([
        { id: 'worktree-1', branchName: 'feature/gateway' },
      ]);

      const override = await resolveAiCreditsRoutingOverride(
        'acme-attributed',
        'codex',
        undefined,
        undefined,
        {
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
          workOwner: { kind: 'organization', organizationId: 'org-1' },
        },
      );

      const providers = override?.codexConfig?.model_providers;
      const provider = isStringKeyedRecord(providers)
        ? providers.canopy_org_gateway
        : undefined;
      expect(provider).toMatchObject({
        http_headers: {
          'x-canopy-workspace': 'Payments%20API',
          'x-canopy-worktree': 'feature%2Fgateway',
          'x-canopy-org-project': 'project-1',
        },
      });
      initAiGatewayModels(previousModels, previousRoutes);
    });

    it('lets enforced gateway policy override a user-supplied provider key', async () => {
      mockGatewayEnforced.mockResolvedValue(true);
      mockGetEnhancedEnv.mockReturnValue({
        PATH: '/mock/bin',
        OPENAI_API_KEY: 'personal-key',
      });
      await expect(
        resolveAiCreditsRoutingOverride('gpt-5.6-sol', 'codex'),
      ).rejects.toThrow('requires model traffic');
    });

    it('routes an enforced org override of a native catalog model even when routing mode is off', async () => {
      const previousModels = getAiGatewayModelEntries();
      const previousRoutes = getGatewayModelEntries();
      initAiGatewayModels(
        previousModels,
        previousRoutes.map((route) =>
          route.modelId === 'gpt-5.6-sol'
            ? {
                ...route,
                gatewayId: 'acme/gpt-5.6-sol',
                family: 'custom' as const,
                origin: 'org-gateway' as const,
                baseUrl: 'https://gateway.acme.test',
                organizationId: 'org-1',
                promptCachePassthrough: false,
              }
            : route,
        ),
      );
      mockGatewayEnforced.mockResolvedValue(true);
      mockLoadGatewayCredential.mockResolvedValue({
        organizationId: 'org-1',
        apiKey: 'sk-org',
        baseUrlAtSave: 'https://gateway.acme.test',
      });

      const override = await resolveAiCreditsRoutingOverride(
        'gpt-5.6-sol',
        'codex',
        undefined,
        undefined,
        { workOwner: { kind: 'organization', organizationId: 'org-1' } },
      );

      expect(override?.model).toBe('acme/gpt-5.6-sol');
      expect(mockRegisterCodexGatewayRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          upstreamUrl: 'https://gateway.acme.test/v1',
          stripCacheControl: true,
        }),
      );
      initAiGatewayModels(previousModels, previousRoutes);
    });
    beforeEach(() => {
      jest.clearAllMocks();
      clearAiCreditsRoutingModeCache();
      clearAiCreditsRoutingContextCache();
      clearAllProviderQuotaReached();
      baseUrlMock.mockReturnValue(CLOUD_BASE);
      loadAccountMock.mockResolvedValue(makeAccount());
      availabilityMock.mockResolvedValue(
        makeAvailability({ personalEligible: true }),
      );
      nativeAuthMock.mockResolvedValue(true);
      mockGetEnhancedEnv.mockReturnValue({ PATH: '/mock/bin' });
      mockGatewayEnforced.mockResolvedValue(false);
      mockLoadGatewayCredential.mockReset();
    });

    // ECW-9091 review round 5. This resolver is also the entry point for
    // scheduled background work (the worktree-summary scheduler). Removing the
    // `off`-mode short-circuit made those calls debit credits with no user
    // action — for a guest on the 10-credits/day drip, background summaries
    // could eat the allowance before the first message is even sent.
    it('does not route an unattended caller on no-native-auth alone', async () => {
      setAiCreditsRoutingModeCache('off');
      nativeAuthMock.mockResolvedValue(false);

      await expect(
        resolveAiCreditsRoutingOverride(
          'opus[1m]',
          'claude',
          undefined,
          undefined,
          {
            allowNoNativeAuthFallback: false,
          },
        ),
      ).resolves.toBeNull();
    });

    it('still routes an unattended caller when the mode is explicitly on', async () => {
      // Only the `no-native-auth` reason is dropped. An explicit routing mode is
      // a user decision and must still be honored for background work.
      setAiCreditsRoutingModeCache('on');
      nativeAuthMock.mockResolvedValue(false);

      const override = await resolveAiCreditsRoutingOverride(
        'opus[1m]',
        'claude',
        undefined,
        undefined,
        { allowNoNativeAuthFallback: false },
      );

      expect(override).not.toBeNull();
    });

    it('brokers Claude credentials for a parent-owned pipeline route', async () => {
      setAiCreditsRoutingModeCache('on');

      const override = await resolveAiCreditsRoutingOverride(
        'opus[1m]',
        'claude',
        undefined,
        'ephemeral:pipeline:exec:job:step:1',
      );

      expect(mockRegisterCodexGatewayRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'ephemeral:pipeline:exec:job:step:1',
          upstreamUrl: `${CLOUD_BASE}/api/v1/llm-proxy/anthropic`,
        }),
      );
      expect(override?.env).toEqual(
        expect.objectContaining({
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123/codex-gateway/route-id',
          ANTHROPIC_AUTH_TOKEN: 'canopy-loopback-broker',
          ANTHROPIC_API_KEY: '',
        }),
      );
      expect(Object.values(override?.env ?? {})).not.toContain('csk_test');
      const registration = mockRegisterCodexGatewayRoute.mock.calls[0]?.[0];
      await expect(registration?.resolveToken()).resolves.toBe('csk_test');
    });

    it('routes on no-native-auth by default (interactive callers)', async () => {
      setAiCreditsRoutingModeCache('off');
      nativeAuthMock.mockResolvedValue(false);

      const override = await resolveAiCreditsRoutingOverride(
        'opus[1m]',
        'claude',
      );

      expect(override).not.toBeNull();
    });

    // ECW-9091 review round 6. The session paths already guard this; helper and
    // pipeline spawns honor the same Canopy Environments variables, so without
    // the guard here they would suppress the user's own credential
    // (`buildClaudeProxyEnv` blanks `ANTHROPIC_API_KEY`) and bill credits.
    it('does not route when the environment supplies the provider credential', async () => {
      setAiCreditsRoutingModeCache('off');
      nativeAuthMock.mockResolvedValue(false);
      mockGetEnhancedEnv.mockReturnValue({
        PATH: '/mock/bin',
        ANTHROPIC_API_KEY: 'sk-ant-user-supplied',
      });

      await expect(
        resolveAiCreditsRoutingOverride('opus[1m]', 'claude'),
      ).resolves.toBeNull();
    });

    it('still routes on an explicit mode despite a supplied credential', async () => {
      // Only the `no-native-auth` reason is guarded. An explicit `on` is a user
      // decision to spend credits and must be honored.
      setAiCreditsRoutingModeCache('on');
      nativeAuthMock.mockResolvedValue(false);
      mockGetEnhancedEnv.mockReturnValue({
        PATH: '/mock/bin',
        ANTHROPIC_API_KEY: 'sk-ant-user-supplied',
      });

      await expect(
        resolveAiCreditsRoutingOverride('opus[1m]', 'claude'),
      ).resolves.not.toBeNull();
    });

    it('forwards the project and runtime slot to the credential guard', async () => {
      setAiCreditsRoutingModeCache('off');
      nativeAuthMock.mockResolvedValue(false);

      await resolveAiCreditsRoutingOverride(
        'opus[1m]',
        'claude',
        undefined,
        undefined,
        { workspaceId: 'ws-7', environmentRuntime: 'pipeline' },
      );

      expect(mockGetEnhancedEnv).toHaveBeenCalledWith({
        environment: { runtime: 'pipeline', workspaceId: 'ws-7' },
      });
    });

    it('honors a delegated subscription choice even with global credits routing enabled', async () => {
      setAiCreditsRoutingModeCache('on');
      nativeAuthMock.mockResolvedValue(true);
      const override = await resolveAiCreditsRoutingOverride(
        'opus[1m]',
        'claude',
        undefined,
        'delegation:child',
        { subscriptionBillingOverride: true, allowNoNativeAuthFallback: false },
      );
      expect(override).toBeNull();
      expect(mockRegisterCodexGatewayRoute).not.toHaveBeenCalled();
    });

    it('builds a Claude proxy override when mode is on and credits are eligible', async () => {
      setAiCreditsRoutingModeCache('on');
      const override = await resolveAiCreditsRoutingOverride(
        'opus[1m]',
        'claude',
      );
      expect(override).not.toBeNull();
      expect(override?.provider).toBe('claude');
      expect(override?.env.ANTHROPIC_BASE_URL).toBe(
        `${CLOUD_BASE}/api/v1/llm-proxy/anthropic`,
      );
      expect(override?.env.ANTHROPIC_AUTH_TOKEN).toBe('csk_test');
      expect(override?.codexConfig).toBeUndefined();
    });

    describe('guest principal model pinning', () => {
      it('pins alias and background models to the gateway id on a guest direct Claude route', async () => {
        setAiCreditsRoutingModeCache('on');
        loadAccountMock.mockResolvedValue(
          makeAccount({ credentialSource: 'guest', authMode: 'guest' }),
        );

        const override = await resolveAiCreditsRoutingOverride(
          'haiku',
          'claude',
        );

        expect(override?.model).toBe('anthropic/claude-haiku-5.5');
        for (const name of CLAUDE_PINNED_MODEL_ENV_NAMES) {
          expect(override?.env[name]).toBe(override?.model);
        }
      });

      it('pins alias and background models on a guest brokered Claude route', async () => {
        setAiCreditsRoutingModeCache('on');
        loadAccountMock.mockResolvedValue(
          makeAccount({ credentialSource: 'guest', authMode: 'guest' }),
        );

        const override = await resolveAiCreditsRoutingOverride(
          'haiku',
          'claude',
          undefined,
          'ephemeral:pipeline:exec:job:step:1',
        );

        expect(override?.env.ANTHROPIC_AUTH_TOKEN).toBe(
          'canopy-loopback-broker',
        );
        for (const name of CLAUDE_PINNED_MODEL_ENV_NAMES) {
          expect(override?.env[name]).toBe(override?.model);
        }
      });

      it('does not pin alias or background models for a signed-in Claude route', async () => {
        setAiCreditsRoutingModeCache('on');

        const direct = await resolveAiCreditsRoutingOverride('haiku', 'claude');
        const brokered = await resolveAiCreditsRoutingOverride(
          'haiku',
          'claude',
          undefined,
          'ephemeral:pipeline:exec:job:step:1',
        );

        for (const name of CLAUDE_PINNED_MODEL_ENV_NAMES) {
          expect(direct?.env).not.toHaveProperty(name);
          expect(brokered?.env).not.toHaveProperty(name);
        }
      });

      it('never pins alias or background models on an organization gateway Claude route', async () => {
        const previousModels = getAiGatewayModelEntries();
        const previousRoutes = getGatewayModelEntries();
        initAiGatewayModels(
          [
            ...previousModels,
            {
              id: 'acme-claude',
              label: 'Acme Claude',
              recommendedHarness: 'claude',
              contextWindow: 200_000,
              supportsPromptCaching: true,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
            },
          ],
          [
            ...previousRoutes,
            {
              modelId: 'acme-claude',
              gatewayId: 'anthropic/acme-claude',
              family: 'custom',
              recommendedHarness: 'claude',
              gatewayOnly: true,
              contextWindow: 200_000,
              supportsPromptCaching: true,
              supportedThinkingLevels: [],
              toolSchemaProfile: 'standard',
              origin: 'org-gateway',
              baseUrl: 'https://gateway.acme.test',
              organizationId: 'org-1',
              promptCachePassthrough: true,
            },
          ],
        );
        loadAccountMock.mockResolvedValue(
          makeAccount({ credentialSource: 'guest', authMode: 'guest' }),
        );
        mockLoadGatewayCredential.mockResolvedValue({
          organizationId: 'org-1',
          apiKey: 'sk-org',
          baseUrlAtSave: 'https://gateway.acme.test',
          updatedAt: 'credential-v1',
        });

        try {
          const override = await resolveAiCreditsRoutingOverride(
            'acme-claude',
            'claude',
            undefined,
            undefined,
            { workOwner: { kind: 'organization', organizationId: 'org-1' } },
          );

          expect(override?.env.ANTHROPIC_AUTH_TOKEN).toBe(
            'canopy-loopback-broker',
          );
          for (const name of CLAUDE_PINNED_MODEL_ENV_NAMES) {
            expect(override?.env).not.toHaveProperty(name);
          }
        } finally {
          initAiGatewayModels(previousModels, previousRoutes);
        }
      });
    });

    it('builds a Codex override with a credential-free loopback provider config', async () => {
      setAiCreditsRoutingModeCache('on');
      const override = await resolveAiCreditsRoutingOverride(
        'deepseek-v4-pro',
        'codex',
      );
      expect(override?.provider).toBe('codex');
      expect(override?.model).toBe('deepseek/deepseek-v4-pro');
      expect(override?.env).toEqual({});
      expect(override?.codexConfig?.model_provider).toBe(
        AI_CREDITS_CODEX_PROVIDER_ID,
      );
      expect(override).not.toHaveProperty('codexArgs');
      expect(override?.codexConfig?.model_providers).toMatchObject({
        [AI_CREDITS_CODEX_PROVIDER_ID]: {
          base_url: 'http://127.0.0.1:43123/codex-gateway/route-id',
          requires_openai_auth: false,
        },
      });
    });

    // CAN-3456: every routed request carries the owner of the work.
    describe('work owner claim', () => {
      const ORG_A = '123e4567-e89b-12d3-a456-426614174000';
      const ORG_B = '223e4567-e89b-12d3-a456-426614174000';

      it('sends a helper owner captured from the navigation context on a Claude credits route', async () => {
        setAiCreditsRoutingModeCache('on');
        mockResolveInvocationWorkOwner.mockResolvedValueOnce({
          kind: 'organization',
          organizationId: ORG_A,
        });
        const override = await resolveAiCreditsRoutingOverride(
          'opus[1m]',
          'claude',
          undefined,
          undefined,
          { workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
        );
        expect(mockResolveInvocationWorkOwner).toHaveBeenCalledWith({
          projectId: 'workspace-1',
          worktreeId: 'worktree-1',
        });
        expect(mockResolveBackgroundWorkOwner).not.toHaveBeenCalled();
        expect(override?.env.ANTHROPIC_CUSTOM_HEADERS).toContain(
          `x-canopy-work-owner: org:${ORG_A}`,
        );
      });

      it('resolves a pipeline owner from the persisted execution context on a Codex credits route', async () => {
        setAiCreditsRoutingModeCache('on');
        mockResolveBackgroundWorkOwner.mockResolvedValueOnce({
          kind: 'personal',
        });
        const override = await resolveAiCreditsRoutingOverride(
          'deepseek-v4-pro',
          'codex',
          undefined,
          'pipeline:run',
          {
            environmentRuntime: 'pipeline',
            workspaceId: 'workspace-1',
            executionContext: `org:${ORG_B}`,
          },
        );
        expect(mockResolveBackgroundWorkOwner).toHaveBeenCalledWith(
          { projectId: 'workspace-1' },
          `org:${ORG_B}`,
        );
        expect(mockResolveInvocationWorkOwner).not.toHaveBeenCalled();
        expect(override?.codexConfig?.model_providers).toMatchObject({
          [AI_CREDITS_CODEX_PROVIDER_ID]: {
            http_headers: {
              'x-canopy-work-owner': 'personal',
              'x-canopy-model-library-protocol': '1',
            },
          },
        });
      });

      it('sends an inherited owner as-is without resolving another', async () => {
        setAiCreditsRoutingModeCache('on');
        const override = await resolveAiCreditsRoutingOverride(
          'opus[1m]',
          'claude',
          undefined,
          'delegation-route',
          {
            workspaceId: 'workspace-1',
            workOwner: { kind: 'organization', organizationId: ORG_B },
          },
        );
        expect(mockResolveInvocationWorkOwner).not.toHaveBeenCalled();
        expect(mockResolveBackgroundWorkOwner).not.toHaveBeenCalled();
        expect(override?.env.ANTHROPIC_CUSTOM_HEADERS).toContain(
          `x-canopy-work-owner: org:${ORG_B}`,
        );
      });

      it('preserves an explicitly inherited missing owner without re-resolving navigation', async () => {
        setAiCreditsRoutingModeCache('on');
        const override = await resolveAiCreditsRoutingOverride(
          'opus[1m]',
          'claude',
          undefined,
          'delegation-route',
          {
            workspaceId: 'workspace-1',
            workOwner: undefined,
          },
        );
        expect(mockResolveInvocationWorkOwner).not.toHaveBeenCalled();
        expect(mockResolveBackgroundWorkOwner).not.toHaveBeenCalled();
        expect(override?.env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain(
          'x-canopy-work-owner',
        );
      });

      it('omits the claim when the owner cannot be resolved', async () => {
        setAiCreditsRoutingModeCache('on');
        const override = await resolveAiCreditsRoutingOverride(
          'opus[1m]',
          'claude',
        );
        expect(override?.env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain(
          'x-canopy-work-owner',
        );
      });
    });

    // ECW-9091: helper and pipeline callers routinely pass no model (e.g.
    // `resolveHelperInvocation(undefined, …)` from worktree discovery). Before
    // the default fallback, a credits-only account resolved a non-null
    // `no-native-auth` attempt, missed the gateway lookup on `undefined`,
    // returned null, and the caller spawned natively into the same 401 this fix
    // exists to remove.
    it('routes a model-less credits-only call through the default gateway model', async () => {
      setAiCreditsRoutingModeCache('off');
      nativeAuthMock.mockResolvedValue(false);

      const override = await resolveAiCreditsRoutingOverride(
        undefined,
        'claude',
      );

      expect(override).not.toBeNull();
      expect(override?.provider).toBe('claude');
      expect(override?.env.ANTHROPIC_BASE_URL).toBe(
        `${CLOUD_BASE}/api/v1/llm-proxy/anthropic`,
      );
    });

    it('routes a model-less credits-only Codex call through GPT 6 Luna', async () => {
      setAiCreditsRoutingModeCache('off');
      nativeAuthMock.mockResolvedValue(false);

      const override = await resolveAiCreditsRoutingOverride(
        undefined,
        'codex',
      );

      expect(override).toMatchObject({
        provider: 'codex',
        model: 'openai/gpt-6-luna',
        codexConfig: { model_provider: AI_CREDITS_CODEX_PROVIDER_ID },
      });
    });

    it.each(
      [undefined, 'gpt-6.1-sol', 'gpt-5.5'].flatMap((model) =>
        ['off', 'on', 'on-quota', 'session-override'].map((mode) => ({
          model,
          mode,
        })),
      ),
    )(
      'routes helper $model through credits in $mode without native auth',
      async ({ model, mode }) => {
        clearAllProviderQuotaReached();
        setAiCreditsRoutingModeCache(
          mode === 'on' ? 'on' : mode === 'on-quota' ? 'on-quota' : 'off',
        );
        if (mode === 'on-quota') markProviderQuotaReached('codex');
        nativeAuthMock.mockResolvedValue(false);
        await expect(
          resolveAiCreditsRoutingOverride(
            model,
            'codex',
            mode === 'session-override'
              ? { active: true, scope: 'session', activatedAt: 0 }
              : undefined,
          ),
        ).resolves.toMatchObject({
          provider: 'codex',
          model: 'openai/gpt-6-luna',
        });
        clearAllProviderQuotaReached();
      },
    );

    it.each(['on', 'on-quota', 'session-override'])(
      'does not substitute the native default with authenticated $mode routing',
      async (mode) => {
        clearAllProviderQuotaReached();
        setAiCreditsRoutingModeCache(
          mode === 'on' ? 'on' : mode === 'on-quota' ? 'on-quota' : 'off',
        );
        if (mode === 'on-quota') markProviderQuotaReached('codex');
        nativeAuthMock.mockResolvedValue(true);
        await expect(
          resolveAiCreditsRoutingOverride(
            'gpt-6.1-sol',
            'codex',
            mode === 'session-override'
              ? { active: true, scope: 'session', activatedAt: 0 }
              : undefined,
          ),
        ).resolves.toBeNull();
        clearAllProviderQuotaReached();
      },
    );

    it('leaves a model-less call native when a native login exists', async () => {
      setAiCreditsRoutingModeCache('off');
      nativeAuthMock.mockResolvedValue(true);

      await expect(
        resolveAiCreditsRoutingOverride(undefined, 'claude'),
      ).resolves.toBeNull();
    });

    it('routes the same gateway-only model through either selected harness', async () => {
      setAiCreditsRoutingModeCache('on');

      const claude = await resolveAiCreditsRoutingOverride(
        'deepseek-v4-pro',
        'claude',
      );
      const codex = await resolveAiCreditsRoutingOverride(
        'deepseek-v4-pro',
        'codex',
      );

      expect(claude).toMatchObject({
        provider: 'claude',
        model: 'deepseek/deepseek-v4-pro',
        env: {
          ANTHROPIC_BASE_URL: `${CLOUD_BASE}/api/v1/llm-proxy/anthropic`,
        },
      });
      expect(codex).toMatchObject({
        provider: 'codex',
        model: 'deepseek/deepseek-v4-pro',
        codexConfig: { model_provider: AI_CREDITS_CODEX_PROVIDER_ID },
      });
    });

    it('forces gateway-only routing even when native mode is selected', async () => {
      setAiCreditsRoutingModeCache('off');
      nativeAuthMock.mockResolvedValue(true);

      const override = await resolveAiCreditsRoutingOverride(
        'deepseek-v4-pro',
        'codex',
      );

      expect(override?.model).toBe('deepseek/deepseek-v4-pro');
      expect(mockRegisterCodexGatewayRoute).toHaveBeenCalledTimes(1);
    });

    it('refreshes tokens only while the route remains bound to its creating account', async () => {
      setAiCreditsRoutingModeCache('on');
      await resolveAiCreditsRoutingOverride('deepseek-v4-pro', 'codex');
      const registration = mockRegisterCodexGatewayRoute.mock.calls[0]?.[0];
      if (!registration) {
        throw new Error('expected Codex gateway route registration');
      }

      loadAccountMock.mockResolvedValue(makeAccount({ apiKey: 'csk_rotated' }));
      await expect(registration.resolveToken()).resolves.toBe('csk_rotated');

      loadAccountMock.mockResolvedValue(
        makeAccount({
          apiKey: 'csk_account_b',
          account: {
            id: 'account-b',
            name: 'Account B',
            email: 'b@example.com',
            role: 'DEVELOPER',
          },
        }),
      );
      await expect(registration.resolveToken()).resolves.toBeNull();

      loadAccountMock.mockResolvedValue(null);
      await expect(registration.resolveToken()).resolves.toBeNull();
    });

    it('returns null when mode is off and the provider is natively authenticated', async () => {
      setAiCreditsRoutingModeCache('off');
      nativeAuthMock.mockResolvedValue(true);
      const override = await resolveAiCreditsRoutingOverride(
        'opus[1m]',
        'claude',
      );
      expect(override).toBeNull();
    });

    // ECW-9091: the credits-only first-turn case. Mode `off` is the shipped
    // default and no Settings control changes it, so this path is what every
    // signed-out-of-Claude account with credits actually hits.
    it('auto-routes a gateway-routable model when there is no native login and mode is off', async () => {
      setAiCreditsRoutingModeCache('off');
      nativeAuthMock.mockResolvedValue(false);
      const override = await resolveAiCreditsRoutingOverride(
        'opus[1m]',
        'claude',
      );
      expect(override?.provider).toBe('claude');
      expect(override?.env.ANTHROPIC_BASE_URL).toContain(
        '/llm-proxy/anthropic',
      );
    });

    // Load-bearing guard: a real native login is never auto-routed, in any mode.
    it('stays native with mode off when the provider is natively authenticated', async () => {
      setAiCreditsRoutingModeCache('off');
      nativeAuthMock.mockResolvedValue(true);
      const override = await resolveAiCreditsRoutingOverride(
        'opus[1m]',
        'claude',
      );
      expect(override).toBeNull();
      expect(availabilityMock).not.toHaveBeenCalled();
    });

    it('auto-routes a gateway-routable model when on-quota mode has no native login', async () => {
      setAiCreditsRoutingModeCache('on-quota');
      nativeAuthMock.mockResolvedValue(false);
      const override = await resolveAiCreditsRoutingOverride(
        'opus[1m]',
        'claude',
      );
      expect(override?.provider).toBe('claude');
      expect(override?.env.ANTHROPIC_BASE_URL).toContain(
        '/llm-proxy/anthropic',
      );
    });

    it('rejects an unresolved persisted model after a cold restart', async () => {
      setAiCreditsRoutingModeCache('off');
      nativeAuthMock.mockResolvedValue(false);
      await expect(
        resolveAiCreditsRoutingOverride('removed-api-only-model', 'claude'),
      ).rejects.toThrow('no longer available');
      expect(availabilityMock).not.toHaveBeenCalled();
    });

    it('returns null when credits are not eligible', async () => {
      setAiCreditsRoutingModeCache('on');
      availabilityMock.mockResolvedValue(makeAvailability());
      const override = await resolveAiCreditsRoutingOverride(
        'opus[1m]',
        'claude',
      );
      expect(override).toBeNull();
    });

    it('rejects a gateway-only model when credits are not eligible', async () => {
      setAiCreditsRoutingModeCache('off');
      availabilityMock.mockResolvedValue(makeAvailability());

      await expect(
        resolveAiCreditsRoutingOverride('deepseek-v4-pro', 'codex'),
      ).rejects.toThrow('only available with');
      expect(mockRegisterCodexGatewayRoute).not.toHaveBeenCalled();
    });

    it('never routes a non-Claude/Codex provider', async () => {
      setAiCreditsRoutingModeCache('on');
      const override = await resolveAiCreditsRoutingOverride(
        'llama3',
        'ollama',
      );
      expect(override).toBeNull();
    });
  });

  describe('emitAiCreditsRoutingStatus', () => {
    it('emits a well-formed, guard-passing routing status event', () => {
      const emit = jest.fn<void, [unknown]>();
      void emitAiCreditsRoutingStatus(emit, 'claude', true);
      expect(emit).toHaveBeenCalledTimes(1);
      const payload: unknown = emit.mock.calls[0]?.[0];
      expect(isAiCreditsRoutingStatusEventData(payload)).toBe(true);
      expect(payload).toEqual({
        type: 'canopy_ai_credits_routing',
        active: true,
        provider: 'claude',
      });
    });

    it('carries the inactive/native state and provider', () => {
      const emit = jest.fn<void, [unknown]>();
      void emitAiCreditsRoutingStatus(emit, 'codex', false);
      expect(emit.mock.calls[0]?.[0]).toEqual({
        type: 'canopy_ai_credits_routing',
        active: false,
        provider: 'codex',
      });
    });
  });

  describe('emitAiCreditsNoBillingSource', () => {
    it('emits a distinct, guard-passing runtime billing signal', () => {
      const emit = jest.fn<void, [unknown]>();
      void emitAiCreditsNoBillingSource(emit, 'codex');

      const payload: unknown = emit.mock.calls[0]?.[0];
      expect(isAiCreditsNoBillingSourceEventData(payload)).toBe(true);
      expect(payload).toEqual({
        type: 'canopy_ai_credits_no_billing_source',
        provider: 'codex',
      });
    });
  });

  // ECW-9091 review round 5. The auth probe runs `getEnhancedEnv({ environment:
  // false })`, deliberately dropping the Canopy Environments injector the agent
  // spawn uses. A user who supplies their own provider credential there looks
  // signed out to the probe but has a working provider at spawn time — and
  // routing them would SUPPRESS it, because `buildClaudeProxyEnv` blanks
  // `ANTHROPIC_API_KEY` and is spread after the user environment.
  describe('hasUserSuppliedProviderCredential', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockGetEnhancedEnv.mockReturnValue({ PATH: '/mock/bin' });
    });

    it('is false when the environment supplies no provider credential', () => {
      expect(hasUserSuppliedProviderCredential('claude', 'ws')).toBe(false);
      expect(hasUserSuppliedProviderCredential('codex', 'ws')).toBe(false);
    });

    it.each([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
    ])('detects a user-supplied Claude credential via %s', (key) => {
      mockGetEnhancedEnv.mockReturnValue({ PATH: '/mock/bin', [key]: 'value' });

      expect(hasUserSuppliedProviderCredential('claude', 'ws')).toBe(true);
      // Claude keys must not leak into the Codex decision.
      expect(hasUserSuppliedProviderCredential('codex', 'ws')).toBe(false);
    });

    it.each(['OPENAI_API_KEY'])(
      'detects a user-supplied Codex credential via %s',
      (key) => {
        mockGetEnhancedEnv.mockReturnValue({
          PATH: '/mock/bin',
          [key]: 'value',
        });

        expect(hasUserSuppliedProviderCredential('codex', 'ws')).toBe(true);
        expect(hasUserSuppliedProviderCredential('claude', 'ws')).toBe(false);
      },
    );

    it.each(['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'])(
      'does not count a bare %s as a credential',
      (key) => {
        // A base URL is a ROUTE, not a credential: it says where requests go,
        // never that the user can authenticate there. Counting one on presence
        // alone flipped a genuinely logged-out user pointing at a proxy to
        // "natively authenticated", seeded a native model, and surfaced the raw
        // `Please run /login`. Paired with a real key it is already covered by
        // the key, so nothing is lost.
        mockGetEnhancedEnv.mockReturnValue({
          PATH: '/mock/bin',
          [key]: 'https://proxy.example',
        });

        expect(hasUserSuppliedProviderCredential('claude', 'ws')).toBe(false);
        expect(hasUserSuppliedProviderCredential('codex', 'ws')).toBe(false);
      },
    );

    // ECW-9091 review round 6. The redirect flags are booleans, so presence is
    // not enough: a user who sets `CLAUDE_CODE_USE_BEDROCK=0` to explicitly
    // DISABLE Bedrock would otherwise trip the guard, fall through to native,
    // and get the raw `Please run /login` this change exists to remove.
    it.each(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'])(
      'treats %s as a credential only when the flag is enabled',
      (key) => {
        for (const enabled of ['1', 'true', 'yes', 'anything']) {
          mockGetEnhancedEnv.mockReturnValue({
            PATH: '/mock/bin',
            [key]: enabled,
          });
          expect(hasUserSuppliedProviderCredential('claude', 'ws')).toBe(true);
        }
        for (const disabled of ['0', 'false', 'off', 'no', 'FALSE', ' 0 ']) {
          mockGetEnhancedEnv.mockReturnValue({
            PATH: '/mock/bin',
            [key]: disabled,
          });
          expect(hasUserSuppliedProviderCredential('claude', 'ws')).toBe(false);
        }
      },
    );

    it('defaults to the agent runtime and allows a pipeline slot', () => {
      hasUserSuppliedProviderCredential('claude');
      expect(mockGetEnhancedEnv).toHaveBeenLastCalledWith({
        environment: { runtime: 'agent' },
      });

      hasUserSuppliedProviderCredential('codex', 'ws', 'pipeline');
      expect(mockGetEnhancedEnv).toHaveBeenLastCalledWith({
        environment: { runtime: 'pipeline', workspaceId: 'ws' },
      });
    });

    it('ignores an empty or whitespace-only value', () => {
      mockGetEnhancedEnv.mockReturnValue({
        PATH: '/mock/bin',
        ANTHROPIC_API_KEY: '   ',
      });

      expect(hasUserSuppliedProviderCredential('claude', 'ws')).toBe(false);
    });

    // Fail closed: an environment-resolution failure must not strand a genuinely
    // credits-only user by pretending they have a native provider.
    it('returns false when resolving the environment throws', () => {
      mockGetEnhancedEnv.mockImplementation(() => {
        throw new Error('env resolution failed');
      });

      expect(hasUserSuppliedProviderCredential('claude', 'ws')).toBe(false);
    });

    it('resolves the environment for the requested project', () => {
      hasUserSuppliedProviderCredential('claude', 'workspace-42');

      expect(mockGetEnhancedEnv).toHaveBeenCalledWith({
        environment: { runtime: 'agent', workspaceId: 'workspace-42' },
      });
    });
  });
});

describe('resolveAiCreditsRoutingOverride with the account proxy', () => {
  beforeEach(() => {
    setAiCreditsRoutingModeCache('off');
  });

  afterEach(() => {
    mockAccountProxyRoute.mockReset();
    mockAccountProxyRoute.mockResolvedValue(null);
  });

  it('routes to the proxy with the native model, not AI Credits', async () => {
    mockAccountProxyRoute.mockResolvedValue({
      accountKey: 'account-proxy:connection-1',
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/codex-gateway/r' },
    });
    const override = await resolveAiCreditsRoutingOverride(
      'opus[1m]',
      'claude',
      undefined,
      'chat-1',
      { accountProxyParentSessionId: 'parent-chat' },
    );
    expect(override).toEqual({
      provider: 'claude',
      model: 'opus[1m]',
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/codex-gateway/r' },
      accountProxyRouted: true,
      accountProxyAccountKey: 'account-proxy:connection-1',
      accountProxyConnectionId: 'connection-1',
    });
    expect(mockAccountProxyRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: 'claude',
        sessionId: 'chat-1',
        parentSessionId: 'parent-chat',
      }),
    );
  });

  it('passes the Codex provider block through', async () => {
    const codexConfig = { model_provider: 'canopy_account_proxy' };
    mockAccountProxyRoute.mockResolvedValue({
      accountKey: 'account-proxy:connection-1',
      env: {},
      codexConfig,
    });
    await expect(
      resolveAiCreditsRoutingOverride('gpt-5.6-sol', 'codex'),
    ).resolves.toEqual({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      env: {},
      accountProxyRouted: true,
      accountProxyAccountKey: 'account-proxy:connection-1',
      accountProxyConnectionId: 'connection-1',
      codexConfig,
    });
  });

  it('leaves an explicit AI Credits choice for this chat alone', async () => {
    mockAccountProxyRoute.mockResolvedValue({ env: {} });
    await resolveAiCreditsRoutingOverride('opus[1m]', 'claude', {
      active: true,
      modelId: 'opus[1m]',
    }).catch(() => null);
    expect(mockAccountProxyRoute).not.toHaveBeenCalled();
  });

  it('routes to the proxy when the chat’s session routing is stale', async () => {
    mockAccountProxyRoute.mockResolvedValue({
      accountKey: 'account-proxy:connection-1',
      env: {},
    });
    const override = await resolveAiCreditsRoutingOverride(
      'opus[1m]',
      'claude',
      {
        active: true,
        scope: 'session',
        activatedAt: Date.now() - 60_000,
        resetsAt: Date.now() - 1,
        modelId: 'opus[1m]',
      },
      'chat-1',
      { requiredAccountProxyConnectionId: 'connection-1' },
    );
    expect(override?.accountProxyRouted).toBe(true);
    expect(mockAccountProxyRoute).toHaveBeenCalledTimes(1);
  });

  describe('with the global AI Credits mode', () => {
    afterEach(() => {
      clearAiCreditsRoutingModeCache();
    });

    it.each(['global', 'chat'])(
      'refuses a pinned proxy continuation after a %s AI Credits choice',
      async (choice) => {
        setAiCreditsRoutingModeCache(choice === 'global' ? 'on' : 'off');
        await expect(
          resolveAiCreditsRoutingOverride(
            'opus[1m]',
            'claude',
            choice === 'chat'
              ? { active: true, modelId: 'opus[1m]' }
              : undefined,
            'pipeline-continuation',
            { requiredAccountProxyConnectionId: 'connection-1' },
          ),
        ).rejects.toThrow(
          'account proxy connection for this continuation is unavailable',
        );
        expect(mockAccountProxyRoute).not.toHaveBeenCalled();
        expect(mockRegisterCodexGatewayRoute).not.toHaveBeenCalled();
      },
    );

    it('leaves the proxy out when AI Credits always route', async () => {
      setAiCreditsRoutingModeCache('on');
      mockAccountProxyRoute.mockResolvedValue({
        accountKey: 'account-proxy:connection-1',
        env: {},
      });
      const override = await resolveAiCreditsRoutingOverride(
        'opus[1m]',
        'claude',
      ).catch(() => null);
      expect(mockAccountProxyRoute).not.toHaveBeenCalled();
      expect(override?.accountProxyRouted).not.toBe(true);
    });

    it('keeps the proxy when AI Credits route only once the plan runs out', async () => {
      setAiCreditsRoutingModeCache('on-quota');
      mockAccountProxyRoute.mockResolvedValue({
        accountKey: 'account-proxy:connection-1',
        env: {},
      });
      await expect(
        resolveAiCreditsRoutingOverride('opus[1m]', 'claude'),
      ).resolves.toMatchObject({ accountProxyRouted: true });
    });

    it('keeps the proxy for an explicit subscription choice', async () => {
      setAiCreditsRoutingModeCache('on');
      mockAccountProxyRoute.mockResolvedValue({
        accountKey: 'account-proxy:connection-1',
        env: {},
      });
      await expect(
        resolveAiCreditsRoutingOverride(
          'opus[1m]',
          'claude',
          undefined,
          undefined,
          { subscriptionBillingOverride: true },
        ),
      ).resolves.toMatchObject({ accountProxyRouted: true });
    });
  });
});

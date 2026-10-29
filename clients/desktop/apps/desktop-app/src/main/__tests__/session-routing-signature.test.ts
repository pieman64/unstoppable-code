import type { AgentSessionOptions } from '../agents/types';
import { resolveAiCreditsRoutingActivation } from '../agents/ai-credits-routing';

// session-manager statically imports several Electron-bound sibling modules;
// the provider session modules themselves are only dynamically imported inside
// createProvider, so they do not load here. Stub the static siblings so the
// module (and the pure resolveSessionRoutingSignature helper under test) can be
// imported in the node test env, and control the routing activation directly.
jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupChatSkillPluginDir: jest.fn(),
  cleanupWorktreeChatPluginDirs: jest.fn(),
}));
jest.mock('../mcp/pending-requests', () => ({
  rejectAllForSession: jest.fn(),
}));
jest.mock('../lib/bg-output-poller', () => ({
  stopAllOutputPolling: jest.fn(),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(),
}));
jest.mock('../lib/chat-event-description', () => ({
  describeChatEventData: jest.fn(),
}));
jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: jest.fn(),
}));
jest.mock('../services/telemetry-sync-service', () => ({
  getTelemetrySyncService: jest.fn(),
}));
jest.mock('../agents/ai-credits-routing', () => ({
  resolveAiCreditsRoutingActivation: jest.fn(),
}));
const mockNativeAccountChangedAt: Partial<Record<'claude' | 'codex', number>> =
  {};
jest.mock('../agents/native-account-change', () => ({
  getNativeAccountChangedAt: (
    provider: 'claude' | 'codex',
  ): number | undefined => mockNativeAccountChangedAt[provider],
}));
jest.mock('../auth/provider-auth-state', () => ({
  peekProviderNativeAuthAvailability: jest.fn(),
}));
const mockAccountProxySettingsSignature = jest.fn((harness: string): string => {
  void harness;
  return '';
});
jest.mock('../account-proxy/service', () => ({
  accountProxySettingsSignature: (harness: string): string =>
    mockAccountProxySettingsSignature(harness),
}));
jest.mock('../account-proxy/routing', () => ({
  previewAccountProxySessionRoute: (): Promise<boolean> =>
    Promise.resolve(false),
}));
import { resolveSessionRoutingSignature } from '../agents/session-manager';
import { peekProviderNativeAuthAvailability } from '../auth/provider-auth-state';
import {
  getAiGatewayModelEntries,
  getGatewayModelEntries,
  initAiGatewayModels,
  type AiCreditsRoutingState,
} from '@canopy/desktop-shared/types';

const activationMock = jest.mocked(resolveAiCreditsRoutingActivation);
const peekMock = jest.mocked(peekProviderNativeAuthAvailability);

function makeOpts(
  overrides: Partial<AgentSessionOptions> = {},
): AgentSessionOptions {
  return {
    cwd: '/tmp/wt',
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat',
    model: 'claude-opus-4.8',
    ...overrides,
  };
}

const activeRouting: AiCreditsRoutingState = {
  active: true,
  scope: 'session',
  activatedAt: 0,
  modelId: 'gateway-slug',
};

/**
 * Minimal gateway registry: one gateway-only model (no native provider can
 * bill it) and one dual-source model that a native login can serve.
 */
function initTestGatewayModels(): void {
  initAiGatewayModels(
    [
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        recommendedHarness: 'codex',
        contextWindow: 1_000_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'flat',
      },
    ],
    [
      {
        modelId: 'deepseek-v4-pro',
        gatewayId: 'deepseek/deepseek-v4-pro',
        recommendedHarness: 'codex',
        gatewayOnly: true,
        contextWindow: 1_000_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'flat',
      },
      {
        modelId: 'gpt-5.6-sol',
        gatewayId: 'openai/gpt-5.6-sol',
        recommendedHarness: 'codex',
        gatewayOnly: false,
        contextWindow: 400_000,
        supportsPromptCaching: false,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
      },
    ],
  );
}

describe('resolveSessionRoutingSignature', () => {
  beforeAll(() => {
    initTestGatewayModels();
  });

  it('changes buckets when the same model is re-pointed from hosted to an org gateway', () => {
    const hosted = resolveSessionRoutingSignature(
      makeOpts({ model: 'deepseek-v4-pro' }),
      'codex',
    );
    initAiGatewayModels(
      [
        {
          id: 'deepseek-v4-pro',
          label: 'DeepSeek V4 Pro',
          recommendedHarness: 'codex',
          contextWindow: 1_000_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'flat',
        },
      ],
      [
        {
          modelId: 'deepseek-v4-pro',
          gatewayId: 'vertex/deepseek-v4-pro',
          family: 'custom',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 1_000_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'flat',
          origin: 'org-gateway',
          baseUrl: 'https://gateway.acme.test',
          organizationId: 'org-1',
        },
      ],
    );
    const org = resolveSessionRoutingSignature(
      makeOpts({ model: 'deepseek-v4-pro' }),
      'codex',
    );
    initTestGatewayModels();

    expect(org).not.toBe(hosted);
    expect(org).toContain('routed:org:org-1:https://gateway.acme.test');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    activationMock.mockReturnValue(null);
    // Cold cache: the peek omits claude/codex, so the signature is native.
    peekMock.mockReturnValue({ ollama: true });
  });

  it('routes a gateway-only org row without an account-wide branch', () => {
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
              gatewayOnly: true,
              baseUrl: 'https://gateway.acme.test',
              organizationId: 'org-1',
            }
          : route,
      ),
    );
    expect(
      resolveSessionRoutingSignature(
        makeOpts({ model: 'gpt-5.6-sol' }),
        'codex',
      ),
    ).toContain('routed:org:org-1:https://gateway.acme.test');

    initAiGatewayModels(previousModels, previousRoutes);
  });

  it('is native for non-Claude/Codex providers regardless of override', () => {
    expect(
      resolveSessionRoutingSignature(
        makeOpts({ subscriptionBillingOverride: true }),
        'ollama',
      ),
    ).toBe('native');
    expect(activationMock).not.toHaveBeenCalled();
  });

  it('changes when the subscription override flips', () => {
    // Global mode is routing (activation returns a mode route).
    activationMock.mockReturnValue({});
    const routed = resolveSessionRoutingSignature(makeOpts(), 'claude');

    // Same session with the subscription override on must land in a distinct
    // bucket so the live session is recreated instead of reusing stale routing.
    const overridden = resolveSessionRoutingSignature(
      makeOpts({ subscriptionBillingOverride: true }),
      'claude',
    );

    expect(overridden).toBe('native-forced');
    expect(routed).not.toBe(overridden);
  });

  // ECW-9091: the subscription override is only honorable when a native login
  // exists to bill. `resolveAiCreditsRoutingAttempt` step 2 returns native ONLY
  // on a confirmed `checkNativeAuth()`, then falls through to `no-native-auth`
  // credits routing — so a `native-forced` signature here would report native
  // while the spawn actually bills credits.
  it('is routed when the subscription override cannot be honored (no native login)', () => {
    peekMock.mockReturnValue({ ollama: true, claude: false });
    activationMock.mockReturnValue(null);

    expect(
      resolveSessionRoutingSignature(
        makeOpts({ subscriptionBillingOverride: true }),
        'claude',
      ),
    ).toBe('routed:claude-opus-4.8');
  });

  it('stays native-forced when the override is honorable', () => {
    peekMock.mockReturnValue({ ollama: true, claude: true });

    expect(
      resolveSessionRoutingSignature(
        makeOpts({ subscriptionBillingOverride: true }),
        'claude',
      ),
    ).toBe('native-forced');
  });

  it('stays native-forced when native auth is unknown (cold or probe-failed)', () => {
    // The peek omits the key for a cold/`probeFailed` cache. Degrade to today's
    // behavior rather than guessing that the user is signed out.
    peekMock.mockReturnValue({ ollama: true });

    expect(
      resolveSessionRoutingSignature(
        makeOpts({ subscriptionBillingOverride: true }),
        'claude',
      ),
    ).toBe('native-forced');
  });

  it('an active session-override still wins over the subscription override', () => {
    const signature = resolveSessionRoutingSignature(
      makeOpts({
        aiCreditsRouting: activeRouting,
        subscriptionBillingOverride: true,
      }),
      'codex',
    );
    expect(signature).toBe('routed:gateway-slug');
    // active is handled inline before the activation helper is consulted.
    expect(activationMock).not.toHaveBeenCalled();
  });

  describe('stale session routing (CAN-4200)', () => {
    afterEach(() => {
      delete mockNativeAccountChangedAt.claude;
      delete mockNativeAccountChangedAt.codex;
    });

    it('leaves the routed bucket once the reset time passes', () => {
      activationMock.mockReturnValue(null);
      peekMock.mockReturnValue({ codex: true });
      const opts = makeOpts({
        aiCreditsRouting: { ...activeRouting, resetsAt: Date.now() + 60_000 },
      });
      expect(resolveSessionRoutingSignature(opts, 'codex')).toBe(
        'routed:gateway-slug',
      );
      expect(
        resolveSessionRoutingSignature(
          makeOpts({
            aiCreditsRouting: { ...activeRouting, resetsAt: Date.now() - 1 },
          }),
          'codex',
        ),
      ).toBe('native');
      // The stale value is not handed to the mode resolver either.
      expect(activationMock).toHaveBeenLastCalledWith(undefined, 'codex');
    });

    it('leaves the routed bucket after a later account change', () => {
      activationMock.mockReturnValue(null);
      peekMock.mockReturnValue({ claude: true });
      mockNativeAccountChangedAt.claude = activeRouting.activatedAt + 1;
      expect(
        resolveSessionRoutingSignature(
          makeOpts({ aiCreditsRouting: activeRouting }),
          'claude',
        ),
      ).toBe('native');
      // Another provider's account change leaves Codex routing alone.
      expect(
        resolveSessionRoutingSignature(
          makeOpts({ aiCreditsRouting: activeRouting }),
          'codex',
        ),
      ).toBe('routed:gateway-slug');
    });
  });

  // ECW-9091: a credits-only session is routed even with no mode activation, so
  // the signature must say `routed:` — otherwise account scope and the
  // `aiCreditsRouted` turn metadata mis-attribute the turn as native.
  it('is routed when the peek confirms no native login', () => {
    peekMock.mockReturnValue({ ollama: true, claude: false });

    expect(resolveSessionRoutingSignature(makeOpts(), 'claude')).toBe(
      'routed:claude-opus-4.8',
    );
  });

  it('stays native when the peek is cold or probe-failed for the provider', () => {
    // A cold or probe-failed cache omits the key entirely — "unknown", not
    // signed out — so the signature degrades to today's native value.
    peekMock.mockReturnValue({ ollama: true, codex: false });

    expect(resolveSessionRoutingSignature(makeOpts(), 'claude')).toBe('native');
  });

  it('stays native when the peek confirms a native login', () => {
    peekMock.mockReturnValue({ ollama: true, claude: true });

    expect(resolveSessionRoutingSignature(makeOpts(), 'claude')).toBe('native');
  });

  // `peekProviderNativeAuthAvailability` is deliberately cache-only and ignores
  // the TTL, so the answer can CHANGE underneath a live chat as the cache warms
  // or the user logs in/out. The signature is session identity, so each of these
  // transitions recreates the session. That is intended — the billing path
  // really did change, and reusing the old session would keep spending on the
  // wrong ledger — but it is load-bearing enough to pin explicitly.
  it('changes the signature when the peek warms from cold to no-native-login', () => {
    const cold = resolveSessionRoutingSignature(makeOpts(), 'claude');
    expect(cold).toBe('native');

    // The prewarm lands and confirms the user has no native Claude login.
    peekMock.mockReturnValue({ ollama: true, claude: false });
    const warmed = resolveSessionRoutingSignature(makeOpts(), 'claude');

    expect(warmed).toBe('routed:claude-opus-4.8');
    expect(warmed).not.toBe(cold);
  });

  it('changes the signature back when the user logs in mid-chat', () => {
    peekMock.mockReturnValue({ ollama: true, claude: false });
    const routed = resolveSessionRoutingSignature(makeOpts(), 'claude');

    peekMock.mockReturnValue({ ollama: true, claude: true });
    const native = resolveSessionRoutingSignature(makeOpts(), 'claude');

    expect(routed).toBe('routed:claude-opus-4.8');
    expect(native).toBe('native');
  });

  // KNOWN, ACCEPTED GAP: only Claude is prewarmed at startup, so a Codex cold
  // cache reports `native` here while the spawn's authoritative async resolution
  // may still route through AI Credits. The window closes on the first real
  // Codex probe, and the cost of closing it eagerly is a second startup probe —
  // the exact cost the Codex prewarm was removed to avoid. Pinned so the
  // asymmetry is a decision on record rather than an accident.
  it('reports native for a cold Codex peek (Codex is not prewarmed)', () => {
    peekMock.mockReturnValue({ ollama: true, claude: false });

    expect(resolveSessionRoutingSignature(makeOpts(), 'codex')).toBe('native');
  });

  // A gateway-only model has no native provider that can bill it, so the
  // session that runs it is routed by definition — `resolveCodexAiCreditsRouting`
  // forces the gateway for exactly this case. The signature has to agree.
  // Reporting `'native'` here is what let a chat keep its native, ChatGPT-authed
  // app-server after the user switched to DeepSeek: the signature matched, the
  // session was reused, its one-time routing preparation never re-ran, and the
  // turn reached the native provider as a raw `deepseek-v4-pro` — answered with
  // "The 'deepseek-v4-pro' model is not supported when using Codex with a
  // ChatGPT account."
  describe('gateway-only models', () => {
    it('is routed even when the peek confirms a native login', () => {
      peekMock.mockReturnValue({ ollama: true, codex: true });

      expect(
        resolveSessionRoutingSignature(
          makeOpts({ model: 'deepseek-v4-pro' }),
          'codex',
        ),
      ).toBe('routed:deepseek-v4-pro');
    });

    // The subscription override cannot be honored for a model no subscription
    // can pay for. `native-forced` here would report native while the spawn
    // routes through the gateway anyway.
    it('beats an otherwise-honorable subscription override', () => {
      peekMock.mockReturnValue({ ollama: true, codex: true });

      expect(
        resolveSessionRoutingSignature(
          makeOpts({
            model: 'deepseek-v4-pro',
            subscriptionBillingOverride: true,
          }),
          'codex',
        ),
      ).toBe('routed:deepseek-v4-pro');
    });

    // The reported bug, as session identity: the two signatures must differ so
    // `getOrCreateSession` recreates instead of reusing the native session.
    it('changes the signature when a native model is switched to a gateway-only one', () => {
      peekMock.mockReturnValue({ ollama: true, codex: true });

      const beforeSwitch = resolveSessionRoutingSignature(
        makeOpts({ model: 'gpt-5.6-sol' }),
        'codex',
      );
      const afterSwitch = resolveSessionRoutingSignature(
        makeOpts({ model: 'deepseek-v4-pro' }),
        'codex',
      );

      expect(beforeSwitch).toBe('native');
      expect(afterSwitch).toBe('routed:deepseek-v4-pro');
      expect(afterSwitch).not.toBe(beforeSwitch);
    });

    // The reverse direction was silently wrong rather than loud: a session
    // prepared for the gateway keeps its proxy `model_provider` for the whole
    // session, so a switch back to a subscription-billable model kept spending
    // credits while the picker reported "subscription".
    it('changes the signature back when a gateway-only model is switched to a native one', () => {
      peekMock.mockReturnValue({ ollama: true, codex: true });

      const routed = resolveSessionRoutingSignature(
        makeOpts({ model: 'deepseek-v4-pro' }),
        'codex',
      );
      const native = resolveSessionRoutingSignature(
        makeOpts({ model: 'gpt-5.6-sol' }),
        'codex',
      );

      expect(routed).toBe('routed:deepseek-v4-pro');
      expect(native).toBe('native');
    });

    // Claude has no gateway-only models today, but the check is model-driven
    // rather than provider-driven, so it must hold for whichever provider the
    // registry assigns.
    it('does not disturb a non-gateway-only model on the same provider', () => {
      peekMock.mockReturnValue({ ollama: true, codex: true });

      expect(
        resolveSessionRoutingSignature(
          makeOpts({ model: 'gpt-5.6-sol' }),
          'codex',
        ),
      ).toBe('native');
    });
  });

  describe('with the account proxy set up', () => {
    afterEach(() => {
      mockAccountProxySettingsSignature.mockReset();
      mockAccountProxySettingsSignature.mockReturnValue('');
    });

    it('recreates an ordinary session when a continuation pins its connection', () => {
      peekMock.mockReturnValue({ claude: true });
      activationMock.mockReturnValue(null);
      mockAccountProxySettingsSignature.mockReturnValue(
        'account-proxy:connection-1:on:keep',
      );
      const ordinary = resolveSessionRoutingSignature(makeOpts(), 'claude');
      const pinned = resolveSessionRoutingSignature(
        makeOpts({ requiredAccountProxyConnectionId: 'connection-1' }),
        'claude',
      );
      expect(pinned).not.toBe(ordinary);
      expect(
        resolveSessionRoutingSignature(
          makeOpts({ requiredAccountProxyConnectionId: 'connection-2' }),
          'claude',
        ),
      ).not.toBe(pinned);
    });

    it('keeps the AI Credits part and adds the proxy settings', () => {
      mockAccountProxySettingsSignature.mockReturnValue(
        'account-proxy:connection-1:on:keep',
      );
      peekMock.mockReturnValue({ claude: true });
      activationMock.mockReturnValue(null);
      expect(resolveSessionRoutingSignature(makeOpts(), 'claude')).toBe(
        'native|account-proxy:connection-1:on:keep',
      );
    });

    it('changes when keep-on-one-account or routing changes, so the session is recreated', () => {
      peekMock.mockReturnValue({ claude: true });
      activationMock.mockReturnValue(null);
      const signatures = [
        'account-proxy:connection-1:on:keep',
        'account-proxy:connection-1:on:spread',
        'account-proxy:connection-1:off:keep',
      ].map((settings) => {
        mockAccountProxySettingsSignature.mockReturnValue(settings);
        return resolveSessionRoutingSignature(makeOpts(), 'claude');
      });
      expect(new Set(signatures).size).toBe(3);
    });

    it('leaves providers the proxy never serves alone', () => {
      mockAccountProxySettingsSignature.mockReturnValue(
        'account-proxy:connection-1:on:keep',
      );
      expect(resolveSessionRoutingSignature(makeOpts(), 'ollama')).toBe(
        'native',
      );
    });
  });
});

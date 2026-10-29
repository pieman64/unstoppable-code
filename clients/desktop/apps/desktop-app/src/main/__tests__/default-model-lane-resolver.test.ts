import {
  DEFAULT_APP_ADVISOR_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  initAgentModels,
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  resetGatewayCatalogHydrationForTests,
  type ModelDefaultsByProvider,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import type { BillingLane } from '@canopy/desktop-shared/lib/default-model-lane';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  GLOBAL_LANE_CREDENTIAL_SCOPE,
  NoDispatchableModelError,
  resolveAppAdvisorDefaultModel,
  resolveConcreteModelDispatchability,
  resolveDefaultModelLaneForPreferences,
  resolveLaneAwareDefaultSelection,
} from '../lib/default-model-lane-resolver';
import { updatePreferencesFile } from '../lib/preferences-store';
import {
  isProviderNativelyAuthenticatedForRouting,
  peekFreshProviderNativeAuthAvailability,
  peekProviderNativeAuthAvailability,
} from '../auth/provider-auth-state';
import { hasUserSuppliedProviderCredential } from '../agents/ai-credits-routing';
import {
  isModelBlockedByStoredPolicy,
  isOrgModelPolicyActiveForStoredAccount,
  isStoredModelPolicyReadDegraded,
  isModelBlockedByCurrentPolicy,
} from '../lib/model-policy-state';
import { getModelGatewayRequirementForOwner } from '../lib/model-gateway-state';
import { loadCanopyCloudAccount } from '../lib/canopy-cloud-account-store';

jest.mock('../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticatedForRouting: jest.fn(),
  peekProviderNativeAuthAvailability: jest.fn(),
  peekFreshProviderNativeAuthAvailability: jest.fn(),
}));
jest.mock('../agents/ai-credits-routing', () => ({
  hasUserSuppliedProviderCredential: jest.fn(),
  // The resolver reads the context and its degraded status as ONE value, so
  // the mock composes them the same way the real helper does. Driving them
  // from the two existing mocks keeps every spec's setup unchanged.
  getAiCreditsRoutingContextWithStatus: jest.fn(async () => ({
    context: await mockCreditsContextImpl(),
    degraded: mockCreditsDegradedImpl(),
  })),
}));
const mockCreditsContextImpl = jest.fn<Promise<unknown>, []>(() =>
  Promise.resolve(null),
);
const mockCreditsDegradedImpl = jest.fn<boolean, []>(() => false);
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByCurrentPolicy: jest.fn(),
  isModelBlockedByStoredPolicy: jest.fn(),
  isOrgModelPolicyActiveForStoredAccount: jest.fn(),
  isStoredModelPolicyReadDegraded: jest.fn(),
}));
jest.mock('../lib/model-gateway-state', () => ({
  getModelGatewayRequirementForOwner: jest.fn(),
}));
const mockLaneWorkOwner = jest.fn<Promise<WorkOwner | undefined>, []>(() =>
  Promise.resolve(undefined),
);
const mockInvocationWorkOwner = jest.fn(() => mockLaneWorkOwner());
const mockNavigationWorkOwner = jest.fn(() => mockLaneWorkOwner());
const mockSessionWorkOwner = jest.fn(() => mockLaneWorkOwner());
jest.mock('../agents/work-owner', () => ({
  resolveInvocationWorkOwner: (): Promise<WorkOwner | undefined> =>
    mockInvocationWorkOwner(),
  resolveNavigationWorkOwner: (): Promise<WorkOwner | undefined> =>
    mockNavigationWorkOwner(),
  resolveSessionWorkOwner: (): Promise<WorkOwner | undefined> =>
    mockSessionWorkOwner(),
}));
jest.mock('../lib/preferences-store', () => ({
  updatePreferencesFile: jest.fn(),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: jest.fn(),
}));
const mockAccountProxyReady = jest.fn<Promise<boolean>, [string]>(() =>
  Promise.resolve(false),
);
jest.mock('../account-proxy/routing', () => ({
  previewAccountProxySessionRoute: (options: {
    harness: string;
  }): Promise<boolean> => mockAccountProxyReady(options.harness),
}));

const mockDestinationDefault = jest.fn<Promise<string>, [string | undefined]>();
jest.mock('../agents/agent-default-model', () => ({
  resolveAgentDestinationDefaultModel: (
    projectId: string | undefined,
  ): Promise<string> => mockDestinationDefault(projectId),
}));

const mockRoutingAuth = jest.mocked(isProviderNativelyAuthenticatedForRouting);
const mockPeekAuth = jest.mocked(peekProviderNativeAuthAvailability);
const mockPeekFreshAuth = jest.mocked(peekFreshProviderNativeAuthAvailability);
const mockCredits = mockCreditsContextImpl;
const mockUserCredential = jest.mocked(hasUserSuppliedProviderCredential);
const mockCreditsDegraded = mockCreditsDegradedImpl;
const mockBlocked = jest.mocked(isModelBlockedByStoredPolicy);
const mockPolicyActive = jest.mocked(isOrgModelPolicyActiveForStoredAccount);
const mockPolicyDegraded = jest.mocked(isStoredModelPolicyReadDegraded);
// The lane-default repair (shared with the renderer) reads the refreshed policy
// synchronously after the async pass, so it needs its own mock.
const mockBlockedSync = jest.mocked(isModelBlockedByCurrentPolicy);
const mockUpdatePreferences = jest.mocked(updatePreferencesFile);
const mockGatewayRequirement = jest.mocked(getModelGatewayRequirementForOwner);
const mockLoadAccount = jest.mocked(loadCanopyCloudAccount);

const defaults: ModelDefaultsByProvider = {
  claude: { model: DEFAULT_CLAUDE_MODEL, thinkingLevel: 'high' },
  codex: { model: DEFAULT_CODEX_MODEL, thinkingLevel: 'high' },
  ollama: null,
  aiCredits: null,
};

describe('main default-model lane resolver', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    initClaudeModels([{ id: DEFAULT_CLAUDE_MODEL, label: 'Opus' }]);
    initCodexModels([
      { id: DEFAULT_CODEX_MODEL, label: 'GPT' },
      { id: 'gpt-6-luna', label: 'GPT 6 Luna' },
    ]);
    initAiGatewayModels([], []);
    // `initAiGatewayModels` sets the sticky hydration flag, so a spec that
    // seeds a catalog would otherwise leave every later spec hydrated.
    resetGatewayCatalogHydrationForTests();
    mockRoutingAuth.mockResolvedValue(false);
    mockPeekAuth.mockReturnValue({ claude: false, codex: false, ollama: true });
    // Mirrors the plain peek by default: in the real module a warm, in-TTL
    // cache answers identically. Specs that need a STALE cache override this.
    mockPeekFreshAuth.mockImplementation(() => mockPeekAuth());
    mockCredits.mockResolvedValue(null);
    mockUserCredential.mockReturnValue(false);
    // A conclusive read by default: a `null` credits context means a real
    // sign-out, not a failed one.
    mockCreditsDegraded.mockReturnValue(false);
    mockPolicyActive.mockResolvedValue(false);
    mockPolicyDegraded.mockReturnValue(false);
    mockBlocked.mockResolvedValue(false);
    mockBlockedSync.mockReturnValue(false);
    mockUpdatePreferences.mockResolvedValue({} as PreferencesData);
    mockGatewayRequirement.mockResolvedValue({ kind: 'unrestricted' });
    mockLaneWorkOwner.mockResolvedValue(undefined);
    mockLoadAccount.mockResolvedValue(null);
    mockAccountProxyReady.mockResolvedValue(false);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function seedOrgGatewayCatalog(): void {
    initAiGatewayModels(
      [
        {
          id: 'deepseek-v4-pro',
          label: 'DeepSeek',
          supportedThinkingLevels: ['high'],
        },
        {
          id: 'org-claude-sonnet',
          label: 'Organization Sonnet',
          supportedThinkingLevels: ['high'],
        },
      ],
      [
        {
          modelId: 'deepseek-v4-pro',
          gatewayId: 'deepseek/deepseek-v4-pro',
          family: 'deepseek',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 128_000,
          supportsPromptCaching: false,
          supportedThinkingLevels: ['high'],
          toolSchemaProfile: 'standard',
        },
        {
          modelId: 'org-claude-sonnet',
          gatewayId: 'anthropic/claude-sonnet-5',
          family: 'custom',
          recommendedHarness: 'codex',
          gatewayOnly: true,
          contextWindow: 1_000_000,
          supportsPromptCaching: true,
          supportedThinkingLevels: ['high'],
          toolSchemaProfile: 'standard',
          origin: 'org-gateway',
          baseUrl: 'https://ai-gateway.vercel.sh',
          organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          promptCachePassthrough: true,
        },
      ],
    );
    mockLaneWorkOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    mockGatewayRequirement.mockResolvedValue({
      kind: 'enforced',
      organizationIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    });
  }

  it('resolves an org model under an enforced gateway, not the native default', async () => {
    // Every non-interactive caller (helpers, hooks, automations, pipeline
    // steps, the portal adapter) reaches its model through this resolver, so
    // teaching it enforcement is what keeps them all off a native model the
    // org forbids.
    seedOrgGatewayCatalog();
    mockPeekAuth.mockReturnValue({ claude: true, codex: true, ollama: true });

    await expect(
      resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: undefined,
        ollamaPinned: false,
      }),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      selection: { model: 'org-claude-sonnet' },
    });
  });

  it('resolves an org model with no AI Credits eligibility', async () => {
    // An org gateway is funded by the member's own gateway key. Leaving the
    // credits gate in charge would report `no-dispatchable-model` for every
    // member of an enforcing org that never bought credits.
    seedOrgGatewayCatalog();
    mockPeekAuth.mockReturnValue({
      claude: false,
      codex: false,
      ollama: true,
    });
    mockCredits.mockResolvedValue(null);

    await expect(
      resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: undefined,
        ollamaPinned: false,
      }),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      selection: { model: 'org-claude-sonnet' },
    });
  });

  it('uses the captured session owner before the live navigation owner', async () => {
    const capturedOwner: WorkOwner = {
      kind: 'organization',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    mockSessionWorkOwner.mockResolvedValueOnce(capturedOwner);
    mockInvocationWorkOwner.mockResolvedValueOnce({ kind: 'personal' });

    await resolveDefaultModelLaneForPreferences({
      defaults,
      preferredProvider: 'claude',
      lastResolvedLane: undefined,
      ollamaPinned: false,
      workspaceId: 'workspace-1',
      workOwnerSession: {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      },
    });

    expect(mockPolicyActive).toHaveBeenCalledWith(capturedOwner);
    expect(mockGatewayRequirement).toHaveBeenCalledWith(
      capturedOwner,
      'resolveDefaultModelLaneForPreferences',
    );
    expect(mockInvocationWorkOwner).not.toHaveBeenCalled();
  });

  it('debounces persistence of a non-provisional resolved lane', async () => {
    mockPeekAuth.mockReturnValue({ claude: true, codex: false, ollama: true });

    await expect(
      resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: undefined,
        ollamaPinned: false,
        persistScope: 'chat',
      }),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      lane: 'claude-native',
      provisional: false,
    });

    expect(mockUpdatePreferences).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(500);
    expect(mockUpdatePreferences).toHaveBeenCalledTimes(1);
    const updater = mockUpdatePreferences.mock.calls[0]?.[0];
    expect(updater?.({} as PreferencesData)).toEqual({
      lastResolvedDefaultLaneByScope: { chat: 'claude-native' },
      lastResolvedDefaultLane: 'claude-native',
    });
  });

  it('does not persist a lane when no scope claims the resolution', async () => {
    mockPeekAuth.mockReturnValue({ claude: true, codex: false, ollama: true });

    await expect(
      resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: undefined,
        ollamaPinned: false,
      }),
    ).resolves.toMatchObject({ outcome: 'resolved', provisional: false });

    await jest.advanceTimersByTimeAsync(500);
    expect(mockUpdatePreferences).not.toHaveBeenCalled();
  });

  it('keeps the other scope untouched when one scope resolves', async () => {
    mockPeekAuth.mockReturnValue({ claude: false, codex: true, ollama: true });

    await resolveDefaultModelLaneForPreferences({
      defaults,
      preferredProvider: 'codex',
      lastResolvedLane: undefined,
      ollamaPinned: false,
      persistScope: 'chat',
    });
    await jest.advanceTimersByTimeAsync(500);

    const updater = mockUpdatePreferences.mock.calls[0]?.[0];
    const existing: Partial<PreferencesData> = {
      lastResolvedDefaultLaneByScope: { worktree: 'claude-native' },
    };
    expect(updater?.(existing as PreferencesData)).toEqual({
      lastResolvedDefaultLaneByScope: {
        chat: 'codex-native',
        worktree: 'claude-native',
      },
      lastResolvedDefaultLane: 'codex-native',
    });
  });

  it('maps a failed native-auth probe to unknown and holds the last lane', async () => {
    mockRoutingAuth.mockResolvedValue(true);
    mockPeekAuth.mockReturnValue({ claude: false, ollama: true });

    await expect(
      resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'codex',
        lastResolvedLane: 'codex-native',
        ollamaPinned: false,
      }),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      lane: 'codex-native',
      provisional: true,
      reason: 'last-known-lane',
    });
  });

  it('never defaults a guest to a model outside the guest allowlist', async () => {
    const gatewayEntry = (
      modelId: string,
      gatewayId: string,
    ): Parameters<typeof initAiGatewayModels>[1][number] => ({
      modelId,
      gatewayId,
      family: 'gpt',
      recommendedHarness: 'codex' as const,
      gatewayOnly: false,
      contextWindow: 400_000,
      supportsPromptCaching: false,
      supportedThinkingLevels: ['high' as const],
      toolSchemaProfile: 'standard' as const,
    });
    // A signed-in account may keep Sonnet as its configured credits default.
    // A guest must land on an allowlisted model instead.
    initAiGatewayModels(
      [
        {
          id: 'sonnet',
          label: 'Sonnet',
          supportedThinkingLevels: ['high'],
        },
        {
          id: 'gpt-5.6-luna',
          label: 'GPT 5.6 Luna',
          supportedThinkingLevels: ['high'],
        },
      ],
      [
        gatewayEntry('sonnet', 'anthropic/claude-sonnet-5'),
        gatewayEntry('gpt-5.6-luna', 'openai/gpt-5.6-luna'),
      ],
    );
    mockCredits.mockResolvedValue({
      cskToken: 'csk_guest',
      accountIdentity: 'guest',
      email: null,
      creditsEligible: true,
      creditsEligibilityKnown: true,
      cloudBaseUrl: 'https://example.test',
    });
    const input = {
      defaults: {
        ...defaults,
        aiCredits: { model: 'sonnet', thinkingLevel: 'high' as const },
      },
      preferredProvider: 'claude' as const,
      lastResolvedLane: undefined,
      ollamaPinned: false,
    };

    await expect(
      resolveDefaultModelLaneForPreferences(input),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: 'sonnet' },
    });

    mockLoadAccount.mockResolvedValue({
      apiKey: 'csk_guest',
      authMode: 'guest',
      credentialSource: 'guest',
      capabilities: [],
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
    });
    await expect(
      resolveDefaultModelLaneForPreferences(input),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: 'gpt-5.6-luna' },
    });
  });

  it('falls a guest back to GPT 6 Luna when DeepSeek does not route', async () => {
    const gatewayEntry = (
      modelId: string,
      gatewayId: string,
    ): Parameters<typeof initAiGatewayModels>[1][number] => ({
      modelId,
      gatewayId,
      family: 'gpt',
      recommendedHarness: 'codex',
      gatewayOnly: false,
      contextWindow: 400_000,
      supportsPromptCaching: false,
      supportedThinkingLevels: ['high'],
      toolSchemaProfile: 'standard',
    });
    // GPT 6 Luna leads the guest allowlist after DeepSeek, so it wins over
    // GPT 5.6 Luna even though both route.
    initAiGatewayModels(
      [
        {
          id: 'gpt-5.6-luna',
          label: 'GPT 5.6 Luna',
          supportedThinkingLevels: ['high'],
        },
        {
          id: 'gpt-6-luna',
          label: 'GPT 6 Luna',
          supportedThinkingLevels: ['high'],
        },
      ],
      [
        gatewayEntry('gpt-5.6-luna', 'openai/gpt-5.6-luna'),
        gatewayEntry('gpt-6-luna', 'openai/gpt-6-luna'),
      ],
    );
    mockCredits.mockResolvedValue({
      cskToken: 'csk_guest',
      accountIdentity: 'guest',
      email: null,
      creditsEligible: true,
      creditsEligibilityKnown: true,
      cloudBaseUrl: 'https://example.test',
    });
    mockLoadAccount.mockResolvedValue({
      apiKey: 'csk_guest',
      authMode: 'guest',
      credentialSource: 'guest',
      capabilities: [],
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
    });

    await expect(
      resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: undefined,
        ollamaPinned: false,
      }),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      selection: { model: 'gpt-6-luna' },
    });
  });

  it('maps inconclusive credit availability to unknown', async () => {
    mockCredits.mockResolvedValue({
      cskToken: 'csk_test',
      accountIdentity: 'account',
      email: null,
      creditsEligible: false,
      creditsEligibilityKnown: false,
      cloudBaseUrl: 'https://example.test',
    });

    await expect(
      resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: 'ai-credits',
        ollamaPinned: false,
      }),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      lane: 'ai-credits',
      provisional: true,
    });
  });

  it('keeps a degraded policy read provisional instead of treating it as a block', async () => {
    mockRoutingAuth.mockResolvedValue(true);
    mockPeekAuth.mockReturnValue({ claude: true, codex: false, ollama: true });
    mockPolicyActive.mockResolvedValue(true);
    mockPolicyDegraded.mockReturnValue(true);
    mockBlocked.mockResolvedValue(true);

    await expect(
      resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: 'claude-native',
        ollamaPinned: false,
      }),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      lane: 'claude-native',
      provisional: true,
    });
  });

  it('falls back jointly when policy blocks the preferred lane', async () => {
    mockRoutingAuth.mockResolvedValue(true);
    mockPeekAuth.mockReturnValue({ claude: true, codex: true, ollama: true });
    mockPolicyActive.mockResolvedValue(true);
    mockBlocked.mockImplementation((model) =>
      Promise.resolve(model === DEFAULT_CLAUDE_MODEL),
    );
    // The repair pass consults the refreshed policy synchronously. The Claude
    // registry holds only the blocked model here, so the repair finds no
    // allowed replacement and the resolver still falls through to Codex.
    mockBlockedSync.mockImplementation(
      (model) => model === DEFAULT_CLAUDE_MODEL,
    );

    await expect(
      resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: undefined,
        ollamaPinned: false,
      }),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      lane: 'codex-native',
      reason: 'policy-fallback',
    });
  });

  describe('account proxy (CAN-4020)', () => {
    it('resolves the native lane when only the account proxy can bill it', async () => {
      // No native login and no AI Credits, but the proxy has a ready Claude
      // account: a send must not be refused as having no billing source.
      mockCredits.mockResolvedValue(null);
      mockAccountProxyReady.mockImplementation((harness) =>
        Promise.resolve(harness === 'claude'),
      );

      await expect(
        resolveDefaultModelLaneForPreferences({
          defaults,
          preferredProvider: 'claude',
          lastResolvedLane: undefined,
          ollamaPinned: false,
        }),
      ).resolves.toMatchObject({
        outcome: 'resolved',
        lane: 'claude-native',
      });
    });

    it('dispatches a concrete model the account proxy can run', async () => {
      mockCredits.mockResolvedValue(null);
      mockAccountProxyReady.mockImplementation((harness) =>
        Promise.resolve(harness === 'codex'),
      );

      await expect(
        resolveConcreteModelDispatchability(
          DEFAULT_CODEX_MODEL,
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('dispatchable');
      await expect(
        resolveConcreteModelDispatchability(
          DEFAULT_CLAUDE_MODEL,
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('no-billing-lane');
    });
  });

  describe('user-supplied provider credentials (round-2 finding 1)', () => {
    it('treats an Environments-injected Claude credential as a live lane', async () => {
      // The auth probe runs `getEnhancedEnv({ environment: false })`, so it
      // cannot see a credential injected through Canopy Environments. Without
      // ORing it in, this user resolves to `no-dispatchable-model` and every
      // helper, hook chat and automation throws.
      mockPeekAuth.mockReturnValue({
        claude: false,
        codex: false,
        ollama: false,
      });
      mockCredits.mockResolvedValue(null);
      mockUserCredential.mockImplementation(
        (provider) => provider === 'claude',
      );

      await expect(
        resolveDefaultModelLaneForPreferences({
          defaults,
          preferredProvider: 'claude',
          lastResolvedLane: undefined,
          ollamaPinned: false,
        }),
      ).resolves.toMatchObject({
        outcome: 'resolved',
        lane: 'claude-native',
      });
    });

    it('resolves the credential against the caller project', async () => {
      // Round-3 finding 1(a). `EnvironmentRuntimeAssignments` has a global slot
      // AND a per-workspace override, so a workspace-only credential is invisible
      // unless the workspace is threaded through — and the session spawn DOES
      // pass one (`opts.projectId`). Selection has to ask the same question.
      mockPeekAuth.mockReturnValue({
        claude: false,
        codex: false,
        ollama: false,
      });
      mockCredits.mockResolvedValue(null);
      mockUserCredential.mockImplementation(
        (provider, workspaceId) =>
          provider === 'claude' && workspaceId === 'workspace-42',
      );

      await expect(
        resolveDefaultModelLaneForPreferences({
          defaults,
          preferredProvider: 'claude',
          lastResolvedLane: undefined,
          ollamaPinned: false,
          workspaceId: 'workspace-42',
        }),
      ).resolves.toMatchObject({
        outcome: 'resolved',
        lane: 'claude-native',
      });
      expect(mockUserCredential).toHaveBeenCalledWith('claude', 'workspace-42');
    });

    it('honors a project override that removes a globally assigned credential', async () => {
      // The inverse, and the money-adjacent direction: crediting a GLOBAL
      // credential in a workspace whose override drops it selects a native model
      // that then falls through to AI Credits at spawn time.
      mockPeekAuth.mockReturnValue({
        claude: false,
        codex: false,
        ollama: false,
      });
      mockCredits.mockResolvedValue(null);
      mockUserCredential.mockImplementation(
        (_provider, workspaceId) => workspaceId === undefined,
      );

      await expect(
        resolveDefaultModelLaneForPreferences({
          defaults,
          preferredProvider: 'claude',
          lastResolvedLane: undefined,
          ollamaPinned: false,
          workspaceId: 'workspace-without-env',
        }),
      ).resolves.toMatchObject({ outcome: 'no-dispatchable-model' });
    });

    it('threads the credential scope from the scoped wrapper', async () => {
      // Claude must NOT be peeked as authenticated: `probed === true`
      // short-circuits the `||` and the credential probe never runs.
      mockPeekAuth.mockReturnValue({
        claude: false,
        codex: false,
        ollama: true,
      });
      mockCredits.mockResolvedValue(null);

      await resolveLaneAwareDefaultSelection(
        {
          defaultChatProvider: 'claude',
          defaultWorktreeProvider: 'claude',
          defaultChatModelByProvider: defaults,
          defaultWorktreeModelByProvider: defaults,
        } as PreferencesData,
        'chat',
        { workspaceId: 'workspace-7' },
      );

      expect(mockUserCredential).toHaveBeenCalledWith('claude', 'workspace-7');
    });

    it('holds the credits lane UNKNOWN when the account read FAILED', async () => {
      // Every other axis in this resolver preserves UNKNOWN as `undefined`;
      // the credits axis collapsed a FAILED read into a CONFIRMED dead lane
      // because `getAiCreditsRoutingContext()` returns `null` for both a real
      // sign-out and an `unavailable`/`error` read. A provisional resolution is
      // the honest answer — never `no-dispatchable-model`.
      mockPeekAuth.mockReturnValue({
        claude: false,
        codex: false,
        ollama: false,
      });
      mockCredits.mockResolvedValue(null);
      mockCreditsDegraded.mockReturnValue(true);

      await expect(
        resolveDefaultModelLaneForPreferences({
          defaults,
          preferredProvider: 'claude',
          lastResolvedLane: 'ai-credits',
          ollamaPinned: false,
        }),
      ).resolves.toMatchObject({ outcome: 'resolved', provisional: true });
    });

    it('still reports a dead end when no credential is supplied', async () => {
      mockPeekAuth.mockReturnValue({
        claude: false,
        codex: false,
        ollama: false,
      });
      mockCredits.mockResolvedValue(null);

      await expect(
        resolveDefaultModelLaneForPreferences({
          defaults,
          preferredProvider: 'claude',
          lastResolvedLane: undefined,
          ollamaPinned: false,
        }),
      ).resolves.toMatchObject({ outcome: 'no-dispatchable-model' });
    });
  });

  describe('lazy native-auth probing (round-2 finding 9)', () => {
    it('skips the Codex probe when the Claude lane already wins', async () => {
      // The Codex probe spawns an app-server, and `scheduleChatSummary`
      // resolves a lane after every turn, so probing it unconditionally moved
      // the spawn from startup to the first message rather than removing it.
      mockPeekAuth.mockReturnValue({
        claude: true,
        codex: false,
        ollama: true,
      });

      await resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: undefined,
        ollamaPinned: false,
      });

      expect(mockRoutingAuth).toHaveBeenCalledWith(
        'claude',
        'default-model-lane',
      );
      expect(mockRoutingAuth).not.toHaveBeenCalledWith(
        'codex',
        'default-model-lane',
      );
    });

    it('still probes Codex when the Claude lane cannot pay', async () => {
      mockPeekAuth.mockReturnValue({
        claude: false,
        codex: true,
        ollama: true,
      });

      await resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: undefined,
        ollamaPinned: false,
      });

      expect(mockRoutingAuth).toHaveBeenCalledWith(
        'codex',
        'default-model-lane',
      );
    });

    it('probes Codex when it is the preferred lane', async () => {
      mockPeekAuth.mockReturnValue({ claude: true, codex: true, ollama: true });

      await resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'codex',
        lastResolvedLane: undefined,
        ollamaPinned: false,
      });

      expect(mockRoutingAuth).toHaveBeenCalledWith(
        'codex',
        'default-model-lane',
      );
    });

    it('never probes Claude for a Codex-preferred, Codex-authenticated user', async () => {
      // Round-3 finding 2. `codex-native` is index 0 of the precedence order
      // for this user, so the Claude probe can only ever be wasted work — and a
      // failing probe burns the full timeout/retry budget before the lane that
      // was always going to win is even looked at.
      mockPeekAuth.mockReturnValue({ claude: true, codex: true, ollama: true });

      await expect(
        resolveDefaultModelLaneForPreferences({
          defaults,
          preferredProvider: 'codex',
          lastResolvedLane: undefined,
          ollamaPinned: false,
        }),
      ).resolves.toMatchObject({ outcome: 'resolved', lane: 'codex-native' });

      expect(mockRoutingAuth).toHaveBeenCalledWith(
        'codex',
        'default-model-lane',
      );
      expect(mockRoutingAuth).not.toHaveBeenCalledWith(
        'claude',
        'default-model-lane',
      );
    });
  });

  describe('confirmed-lane erasure is gated on an actual probe (round-3 finding 6)', () => {
    const storedBoth: readonly BillingLane[] = [
      'claude-native',
      'codex-native',
    ];

    it('does not erase a stored lane on a STALE unprobed cache entry', async () => {
      // Lazy probing lets the Claude lane win outright, so `codex` here is a
      // cache read the TTL has already lapsed on — `peekProviderNativeAuth-
      // Availability()` enforces no TTL. Erasing on that contradicts the
      // "lanes this process CONFIRMED unavailable" contract.
      mockPeekAuth.mockReturnValue({
        claude: true,
        codex: false,
        ollama: true,
      });
      // Stale: the fresh view has no answer for Codex at all.
      mockPeekFreshAuth.mockReturnValue({ claude: true, ollama: true });

      await resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: undefined,
        ollamaPinned: false,
        storedLanes: storedBoth,
      });
      await jest.advanceTimersByTimeAsync(1000);

      expect(mockRoutingAuth).not.toHaveBeenCalledWith(
        'codex',
        'default-model-lane',
      );
      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    });

    it('still erases an unprobed lane whose cached negative is FRESH', async () => {
      // The round-2 case: a user who cancelled Codex and now works only in
      // cowork chats. Their Claude lane short-circuits the Codex probe, but a
      // live in-TTL confirmation is still real evidence.
      mockPeekAuth.mockReturnValue({
        claude: true,
        codex: false,
        ollama: true,
      });

      await resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: undefined,
        ollamaPinned: false,
        storedLanes: storedBoth,
      });
      await jest.advanceTimersByTimeAsync(1000);

      const updater = mockUpdatePreferences.mock.calls[0]?.[0];
      expect(
        updater?.({
          lastResolvedDefaultLaneByScope: { worktree: 'codex-native' },
          lastResolvedDefaultLane: 'codex-native',
        } as PreferencesData),
      ).toEqual({
        lastResolvedDefaultLaneByScope: {},
        lastResolvedDefaultLane: undefined,
      });
    });

    it('erases a lane it probed and confirmed dead in this call', async () => {
      mockPeekAuth.mockReturnValue({
        claude: false,
        codex: false,
        ollama: false,
      });
      // The probe happened HERE, so the fresh view being empty must not matter.
      mockPeekFreshAuth.mockReturnValue({ ollama: true });
      mockCredits.mockResolvedValue(null);

      await resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: undefined,
        ollamaPinned: false,
        storedLanes: storedBoth,
      });
      await jest.advanceTimersByTimeAsync(1000);

      const updater = mockUpdatePreferences.mock.calls[0]?.[0];
      expect(
        updater?.({
          lastResolvedDefaultLaneByScope: {
            chat: 'claude-native',
            worktree: 'codex-native',
          },
          lastResolvedDefaultLane: 'claude-native',
        } as PreferencesData),
      ).toEqual({
        lastResolvedDefaultLaneByScope: {},
        lastResolvedDefaultLane: undefined,
      });
    });
  });

  describe('stored-lane hygiene (round-2 finding 15)', () => {
    const stalePreferences = {
      defaultChatProvider: 'claude',
      defaultWorktreeProvider: 'claude',
      defaultChatModelByProvider: defaults,
      defaultWorktreeModelByProvider: defaults,
      lastResolvedDefaultLane: 'codex-native',
      lastResolvedDefaultLaneByScope: {
        chat: 'codex-native',
        worktree: 'codex-native',
      },
    } as PreferencesData;

    it('clears a stored lane this process confirmed unavailable', async () => {
      // A user who cancels Codex and then works only in cowork chats never
      // re-resolves the WORKTREE scope, so `byScope.worktree` stayed
      // `codex-native` forever and latched the startup app-server prewarm on.
      mockPeekAuth.mockReturnValue({
        claude: true,
        codex: false,
        ollama: true,
      });

      await resolveLaneAwareDefaultSelection(
        stalePreferences,
        'chat',
        GLOBAL_LANE_CREDENTIAL_SCOPE,
      );
      await jest.advanceTimersByTimeAsync(1000);

      const updater = mockUpdatePreferences.mock.calls[0]?.[0];
      expect(updater?.(stalePreferences)).toEqual({
        lastResolvedDefaultLaneByScope: { chat: 'claude-native' },
        lastResolvedDefaultLane: 'claude-native',
      });
    });

    it('does not schedule a write when no stored scope names the dead lane', async () => {
      mockPeekAuth.mockReturnValue({
        claude: false,
        codex: false,
        ollama: false,
      });
      mockCredits.mockResolvedValue(null);

      await resolveDefaultModelLaneForPreferences({
        defaults,
        preferredProvider: 'claude',
        lastResolvedLane: undefined,
        ollamaPinned: false,
      });
      await jest.advanceTimersByTimeAsync(1000);

      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    });

    it('flushes once the max wait elapses even under continuous resolutions', async () => {
      mockPeekAuth.mockReturnValue({
        claude: true,
        codex: false,
        ollama: true,
      });

      for (let i = 0; i < 12; i += 1) {
        await resolveDefaultModelLaneForPreferences({
          defaults,
          preferredProvider: 'claude',
          lastResolvedLane: undefined,
          ollamaPinned: false,
          persistScope: 'chat',
        });
        // Shorter than the 500ms debounce, so a pure debounce would restart
        // the timer every time and never write.
        await jest.advanceTimersByTimeAsync(400);
      }

      expect(mockUpdatePreferences).toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1000);
    });
  });

  describe('scoped default resolution', () => {
    const preferences = (
      overrides: Partial<PreferencesData> = {},
    ): PreferencesData =>
      ({
        defaultChatProvider: 'claude',
        defaultWorktreeProvider: 'claude',
        defaultChatModelByProvider: defaults,
        defaultWorktreeModelByProvider: defaults,
        ...overrides,
      }) as PreferencesData;

    describe('resolveAppAdvisorDefaultModel', () => {
      afterEach(async () => {
        // Resolving the lane debounces a scope write; settle it here.
        await jest.advanceTimersByTimeAsync(1000);
        mockUpdatePreferences.mockClear();
      });

      it('moves an untouched seed the chat lane cannot run onto that lane', async () => {
        // A Claude-only user: the Codex seed cannot run, so a new App
        // Advisor chat starts on the chat lane's Claude default instead.
        mockPeekAuth.mockReturnValue({
          claude: true,
          codex: false,
          ollama: true,
        });

        await expect(
          resolveAppAdvisorDefaultModel(
            preferences({ appAdvisorModel: DEFAULT_APP_ADVISOR_MODEL }),
          ),
        ).resolves.toBe(DEFAULT_CLAUDE_MODEL);
      });

      it('keeps an explicitly chosen App Advisor model', async () => {
        mockPeekAuth.mockReturnValue({
          claude: true,
          codex: false,
          ollama: true,
        });

        await expect(
          resolveAppAdvisorDefaultModel(
            preferences({ appAdvisorModel: DEFAULT_CLAUDE_MODEL }),
          ),
        ).resolves.toBe(DEFAULT_CLAUDE_MODEL);
      });
    });

    it('persists the scope when it judges the scope own preferred provider', async () => {
      mockPeekAuth.mockReturnValue({
        claude: true,
        codex: false,
        ollama: true,
      });

      await resolveLaneAwareDefaultSelection(
        preferences(),
        'worktree',
        GLOBAL_LANE_CREDENTIAL_SCOPE,
      );
      await jest.advanceTimersByTimeAsync(500);

      const updater = mockUpdatePreferences.mock.calls[0]?.[0];
      expect(updater?.({} as PreferencesData)).toEqual({
        lastResolvedDefaultLaneByScope: { worktree: 'claude-native' },
        lastResolvedDefaultLane: 'claude-native',
      });
    });

    it('does not persist a forced provider that is not the scope default', async () => {
      mockPeekAuth.mockReturnValue({
        claude: true,
        codex: true,
        ollama: true,
      });

      // A Codex chat send by a Claude-defaulting user: a narrower question than
      // "what is this user's default lane?", so it must leave the record alone.
      await resolveLaneAwareDefaultSelection(
        preferences(),
        'chat',
        GLOBAL_LANE_CREDENTIAL_SCOPE,
        'codex',
      );
      await jest.advanceTimersByTimeAsync(500);

      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    });

    it('does not persist a helper resolution carrying its own candidates', async () => {
      mockPeekAuth.mockReturnValue({
        claude: true,
        codex: false,
        ollama: true,
      });

      await resolveLaneAwareDefaultSelection(
        preferences(),
        'worktree',
        GLOBAL_LANE_CREDENTIAL_SCOPE,
        undefined,
        ['gpt-5.6-luna'],
      );
      await jest.advanceTimersByTimeAsync(500);

      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    });

    it('reads the last lane from its own scope, not the other one', async () => {
      // Both native lanes unknown (a failed probe), so the remembered lane is
      // what decides. The chat scope must not inherit the worktree answer.
      mockRoutingAuth.mockResolvedValue(true);
      mockPeekAuth.mockReturnValue({ ollama: true });
      mockCredits.mockResolvedValue(null);

      await expect(
        resolveLaneAwareDefaultSelection(
          preferences({
            lastResolvedDefaultLaneByScope: {
              chat: 'codex-native',
              worktree: 'claude-native',
            },
          }),
          'chat',
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toMatchObject({
        outcome: 'resolved',
        lane: 'codex-native',
        reason: 'last-known-lane',
      });
    });
  });

  // `resolveConcreteModelDispatchability` is the send-time preflight for an
  // ALREADY-CHOSEN model, and it answers a different question from the default
  // lane resolution above. It is deliberately fail-open: only a provably dead
  // end may refuse, because refusing wrongly is an unrecoverable outage for a
  // model the user explicitly picked, while passing wrongly just lets dispatch
  // give its own specific error one layer later.
  describe('resolveConcreteModelDispatchability (CAN-2318)', () => {
    // Confirmed logged out of both native providers, with no supplied
    // credential — the only state from which a refusal is even reachable.
    const nativeLaneDead = (): void => {
      mockPeekAuth.mockReturnValue({
        claude: false,
        codex: false,
        ollama: true,
      });
      mockUserCredential.mockReturnValue(false);
    };

    it('passes an unknown model so dispatch owns the diagnosis', async () => {
      nativeLaneDead();
      mockCredits.mockResolvedValue(null);

      // Not in the registry: the honest error is "Unsupported model …" from
      // dispatch, not a BILLING dead end, which would name the wrong cause.
      await expect(
        resolveConcreteModelDispatchability(
          'not-a-registered-model',
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('dispatchable');
    });

    it('passes a selectable Ollama model even with every billing lane dead', async () => {
      // The false refusal this function exists to fix: an Ollama user's
      // configured credits/native defaults are null, so the DEFAULT resolution
      // reports a dead end — but the picked model runs locally and is free.
      initOllamaModels([
        { id: 'ollama:llama4', rawModelId: 'llama4', label: 'Llama 4' },
      ]);
      nativeLaneDead();
      mockCredits.mockResolvedValue(null);

      await expect(
        resolveConcreteModelDispatchability(
          'ollama:llama4',
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('dispatchable');
    });

    it('passes a Cursor model with the native lanes dead and the gateway catalog hydrated', async () => {
      // Cursor bills to the Cursor account. Without its own branch a Cursor
      // model fell to the Claude probe and, once Claude was confirmed logged
      // out, to the credits catalog, which never routes `cursor-*`: a
      // Codex-only or credits-only user was refused as a Claude billing dead
      // end for a model that never touches those lanes.
      initAiGatewayModels([], []);
      nativeLaneDead();
      mockCredits.mockResolvedValue(null);

      await expect(
        resolveConcreteModelDispatchability(
          'cursor-default',
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('dispatchable');
    });

    it('passes when the native probe is UNSETTLED rather than a confirmed logout', async () => {
      // `undefined` is "we do not know yet", never "logged out". Treating it as
      // a refusal would block every send during the startup probe window.
      mockPeekAuth.mockReturnValue({ ollama: true });
      mockUserCredential.mockReturnValue(false);
      mockCredits.mockResolvedValue(null);

      await expect(
        resolveConcreteModelDispatchability(
          DEFAULT_CLAUDE_MODEL,
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('dispatchable');
    });

    it('passes when a user-supplied credential covers the confirmed-logged-out provider', async () => {
      mockPeekAuth.mockReturnValue({
        claude: false,
        codex: false,
        ollama: true,
      });
      mockUserCredential.mockImplementation(
        (provider, workspaceId) =>
          provider === 'claude' && workspaceId === 'workspace-9',
      );
      mockCredits.mockResolvedValue(null);

      await expect(
        resolveConcreteModelDispatchability(DEFAULT_CLAUDE_MODEL, {
          workspaceId: 'workspace-9',
        }),
      ).resolves.toBe('dispatchable');
      // The scope must reach the credential probe, or a workspace-only key is
      // invisible here and this preflight disagrees with the eventual spawn.
      expect(mockUserCredential).toHaveBeenCalledWith('claude', 'workspace-9');
    });

    describe('a Default-model Agent', () => {
      beforeEach(() => {
        initAgentModels([
          {
            id: 'agent_model_follows',
            name: 'Follows',
            baseModel: 'default',
            instructions: '',
            createdAt: '2026-10-13T00:00:00.000Z',
            updatedAt: '2026-10-13T00:00:00.000Z',
            available: true,
          },
        ]);
        // Claude confirmed logged out, Codex signed in, no credits.
        initAiGatewayModels([], []);
        mockPeekAuth.mockReturnValue({
          claude: false,
          codex: true,
          ollama: true,
        });
        mockUserCredential.mockReturnValue(false);
        mockCredits.mockResolvedValue(null);
      });

      afterEach(() => {
        initAgentModels([]);
      });

      it('is judged by the destination default it will pin', async () => {
        mockDestinationDefault.mockResolvedValue(DEFAULT_CODEX_MODEL);

        await expect(
          resolveConcreteModelDispatchability('agent_model_follows', {
            workspaceId: 'workspace-9',
          }),
        ).resolves.toBe('dispatchable');
        expect(mockDestinationDefault).toHaveBeenCalledWith('workspace-9');
      });

      it('is refused when its destination has no dispatchable default', async () => {
        mockDestinationDefault.mockRejectedValue(
          new NoDispatchableModelError('billing-lane'),
        );

        await expect(
          resolveConcreteModelDispatchability('agent_model_follows', {
            workspaceId: 'workspace-9',
          }),
        ).resolves.toBe('no-billing-lane');
      });
    });

    it('passes while the gateway catalog is still COLD', async () => {
      // A cold catalog cannot prove a model is unroutable. Refusing here would
      // turn "the catalog has not arrived" into a permanent billing dead end.
      resetGatewayCatalogHydrationForTests();
      nativeLaneDead();
      mockCredits.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account',
        email: null,
        creditsEligible: true,
        creditsEligibilityKnown: true,
        cloudBaseUrl: 'https://example.test',
      });

      await expect(
        resolveConcreteModelDispatchability(
          DEFAULT_CLAUDE_MODEL,
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('dispatchable');
    });

    it('passes when credits eligibility is not yet KNOWN', async () => {
      nativeLaneDead();
      mockCredits.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account',
        email: null,
        creditsEligible: false,
        creditsEligibilityKnown: false,
        cloudBaseUrl: 'https://example.test',
      });

      await expect(
        resolveConcreteModelDispatchability(
          DEFAULT_CLAUDE_MODEL,
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('dispatchable');
    });

    it('passes when the credits read FAILED rather than confirming no account', async () => {
      // `loadCanopyCloudAccount` folds `unavailable`/`error` into `null`, which
      // is indistinguishable from a real sign-out. Refusing on it told a
      // credits-only user with a funded balance to add a billing source after a
      // keychain lock or decrypt blip.
      nativeLaneDead();
      mockCredits.mockResolvedValue(null);
      mockCreditsDegraded.mockReturnValue(true);

      await expect(
        resolveConcreteModelDispatchability(
          DEFAULT_CLAUDE_MODEL,
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('dispatchable');
    });

    it('refuses only when the native lane is dead AND credits are unavailable', async () => {
      nativeLaneDead();
      mockCredits.mockResolvedValue(null);

      await expect(
        resolveConcreteModelDispatchability(
          DEFAULT_CLAUDE_MODEL,
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('no-billing-lane');
    });

    it('refuses when the native lane is dead and credits are KNOWN-ineligible', async () => {
      nativeLaneDead();
      mockCredits.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account',
        email: null,
        creditsEligible: false,
        creditsEligibilityKnown: true,
        cloudBaseUrl: 'https://example.test',
      });

      await expect(
        resolveConcreteModelDispatchability(
          DEFAULT_CLAUDE_MODEL,
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('no-billing-lane');
    });

    it('refuses a GATEWAY-ONLY model on ineligible credits even when its native harness IS authenticated', async () => {
      // A gateway-only model still reports a Claude/Codex execution harness —
      // that is which harness RUNS it, not who PAYS for it. Taking the native
      // shortcut let a natively authenticated user with no credits pass the
      // preflight, persist the chat and message, and only then abort at session
      // startup: the partial state this whole function exists to prevent.
      initAiGatewayModels(
        [
          {
            id: 'gateway-only-model',
            label: 'Gateway Only',
            recommendedHarness: 'claude',
            contextWindow: 100_000,
            supportsPromptCaching: false,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard',
          },
        ],
        [
          {
            modelId: 'gateway-only-model',
            gatewayId: 'vendor/gateway-only-model',
            family: 'vendor',
            recommendedHarness: 'claude',
            gatewayOnly: true,
            contextWindow: 100_000,
            supportsPromptCaching: false,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard',
          },
        ],
      );
      // Native Claude is CONFIRMED available — the exact state that used to
      // short-circuit to `dispatchable`.
      mockPeekAuth.mockReturnValue({
        claude: true,
        codex: true,
        ollama: true,
      });
      mockCredits.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account',
        email: null,
        creditsEligible: false,
        creditsEligibilityKnown: true,
        cloudBaseUrl: 'https://example.test',
      });

      await expect(
        resolveConcreteModelDispatchability(
          'gateway-only-model',
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('no-billing-lane');
    });

    it('refuses a HYDRATED-catalog model that carries no gateway route', async () => {
      // Settled catalog + not routable = the one case where "credits cannot run
      // this" is a fact rather than an unknown, so it short-circuits before the
      // credits read.
      initAiGatewayModels(
        [
          {
            id: 'gateway-only-model',
            label: 'Gateway Only',
            recommendedHarness: 'claude',
            contextWindow: 100_000,
            supportsPromptCaching: false,
            supportedThinkingLevels: [],
            toolSchemaProfile: 'standard',
          },
        ],
        [],
      );
      nativeLaneDead();
      mockCredits.mockResolvedValue({
        cskToken: 'csk_test',
        accountIdentity: 'account',
        email: null,
        creditsEligible: true,
        creditsEligibilityKnown: true,
        cloudBaseUrl: 'https://example.test',
      });

      await expect(
        resolveConcreteModelDispatchability(
          DEFAULT_CLAUDE_MODEL,
          GLOBAL_LANE_CREDENTIAL_SCOPE,
        ),
      ).resolves.toBe('no-billing-lane');
      // Refused on routability alone — the credits read is never consulted.
      expect(mockCredits).not.toHaveBeenCalled();
    });
  });
});

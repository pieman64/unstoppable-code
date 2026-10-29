/**
 * Context-scoped Codex route projection for speed selectors. Every route
 * input is host-resolved (canonical tab, Environments overlay, gateway and
 * AI Credits state); the renderer supplies only portable ids and a model.
 */
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): unknown => ({}),
  onCodexRuntimeServiceReplaced: (): (() => void) => (): void => undefined,
}));
jest.mock('../lib/e2e-mock-control-plane', () => ({
  fetchMockControlPlaneRecord: jest.fn(),
  getMockLlmOrigin: (): string | null => null,
}));

const mockResolveAiCreditsRoutingAttempt = jest.fn<
  Promise<unknown>,
  unknown[]
>();
jest.mock('../agents/ai-credits-routing', () => ({
  resolveAiCreditsRoutingAttempt: (...args: unknown[]): unknown =>
    mockResolveAiCreditsRoutingAttempt(...args),
  isAiCreditsChosenOverAccountProxy: (routing?: {
    active?: boolean;
  }): boolean => routing?.active === true,
}));
const mockPreviewAccountProxy = jest.fn<
  Promise<boolean>,
  [
    {
      harness: string;
      model: string | undefined;
      resolveWorkOwner: () => Promise<unknown>;
    },
  ]
>(() => Promise.resolve(false));
jest.mock('../account-proxy/routing', () => ({
  previewAccountProxySessionRoute: (
    options: Parameters<typeof mockPreviewAccountProxy>[0],
  ): Promise<boolean> => mockPreviewAccountProxy(options),
}));
const mockIsNativelyAuthenticated = jest.fn(() => Promise.resolve(true));
jest.mock('../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticatedForRouting: (): Promise<boolean> =>
    mockIsNativelyAuthenticated(),
}));
const mockReadChatTabsFile = jest.fn();
jest.mock('../lib/chat-tabs-reader', () => ({
  readChatTabsFile: (...args: unknown[]): unknown =>
    mockReadChatTabsFile(...args),
}));
const mockGatewayRequirement = jest.fn(() =>
  Promise.resolve({ kind: 'unrestricted' }),
);
jest.mock('../lib/model-gateway-state', () => ({
  getModelGatewayRequirementForOwner: (owner: unknown): unknown =>
    mockGatewayRequirement(owner),
}));
const mockResolveScopeOwner = jest.fn(() =>
  Promise.resolve({ kind: 'personal' }),
);
jest.mock('../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: (scope: unknown): unknown =>
    mockResolveScopeOwner(scope),
}));
const mockResolveEnvironmentProfile = jest.fn<
  { environment: Record<string, string> },
  [unknown]
>(() => ({ environment: {} }));
jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: (request: unknown): unknown =>
    mockResolveEnvironmentProfile(request),
}));
const mockMockOverride = jest.fn((): unknown => undefined);
jest.mock('@canopy/desktop-shared/node/e2e-mock-env', () => ({
  resolveCodexMockAppServerOverride: (): unknown => mockMockOverride(),
}));
const mockResolveGatewayModelEntry = jest.fn<unknown, [unknown]>(
  () => undefined,
);
jest.mock('@canopy/desktop-shared/lib/gateway-model-availability', () => ({
  resolveGatewayModelEntry: (model: unknown): unknown =>
    mockResolveGatewayModelEntry(model),
}));
const MODEL_SOURCES: Record<string, string> = {
  'gpt-5.5': 'codex-managed',
  'deepseek-v4-pro': 'ai-gateway',
  'qwen3-coder': 'ollama',
  'claude-sonnet-4-6': 'claude-managed',
};
const MODEL_HARNESSES: Record<string, string> = {
  'gpt-5.5': 'codex',
  'deepseek-v4-pro': 'codex',
  'qwen3-coder': 'codex',
  'claude-sonnet-4-6': 'claude',
};
jest.mock('@canopy/desktop-shared/types', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@canopy/desktop-shared/types',
  ),
  getModelSource: (model: string): string | undefined => MODEL_SOURCES[model],
  getExecutionHarnessForModel: (model: string): string | undefined =>
    MODEL_HARNESSES[model],
}));

import {
  readCodexSpeedRouteFacts,
  type ReadCodexSpeedRouteRequest,
} from '../codex/speed-route-context';

function chatTabs(tab: Record<string, unknown>): unknown {
  return Promise.resolve({ version: 1, activeTabId: 'chat', tabs: [tab] });
}

const CHAT: ReadCodexSpeedRouteRequest['context'] = {
  kind: 'chat',
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveAiCreditsRoutingAttempt.mockResolvedValue(null);
  mockGatewayRequirement.mockResolvedValue({ kind: 'unrestricted' });
  mockResolveScopeOwner.mockResolvedValue({ kind: 'personal' });
  mockResolveEnvironmentProfile.mockReturnValue({ environment: {} });
  mockMockOverride.mockReturnValue(undefined);
  mockResolveGatewayModelEntry.mockReturnValue(undefined);
  mockReadChatTabsFile.mockReturnValue(chatTabs({ id: 'other' }));
  mockPreviewAccountProxy.mockResolvedValue(false);
});

describe('readCodexSpeedRouteFacts', () => {
  it('uses the prospective Home billing selection without overriding canonical chat state', async () => {
    await readCodexSpeedRouteFacts({
      context: {
        kind: 'home',
        projectId: 'workspace-1',
        billingFramework: 'subscription',
      },
      model: 'gpt-5.5',
    });
    expect(mockResolveAiCreditsRoutingAttempt).toHaveBeenLastCalledWith(
      undefined,
      'codex',
      expect.any(Function),
      true,
    );
    await readCodexSpeedRouteFacts({
      context: { kind: 'home', billingFramework: 'ai-credits' },
      model: 'gpt-5.5',
    });
    expect(
      mockResolveAiCreditsRoutingAttempt.mock.calls.at(-1)?.[0],
    ).toMatchObject({ active: true, scope: 'persistent' });
  });

  it('uses the prospective Home captured harness when predicting the draft route', async () => {
    const route = await readCodexSpeedRouteFacts({
      context: { kind: 'home', executionHarness: 'cursor' },
      model: 'gpt-5.5',
    });
    expect(route).toMatchObject({ harness: 'cursor', routeProfile: 'cursor' });
    expect(mockResolveAiCreditsRoutingAttempt).not.toHaveBeenCalled();
  });

  it('projects the native Codex route for defaults with the global environment', async () => {
    await expect(
      readCodexSpeedRouteFacts({
        context: { kind: 'defaults' },
        model: 'gpt-5.5',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        modelSelection: 'explicit',
        runtimeModel: 'gpt-5.5',
        modelSource: 'codex-managed',
        harness: 'codex',
        routeProfile: 'codex-native',
      }),
    );
    expect(mockResolveEnvironmentProfile).toHaveBeenCalledWith({
      runtime: 'agent',
    });
  });

  it('uses the target workspace environment and treats a user credential as foreign', async () => {
    mockResolveEnvironmentProfile.mockReturnValue({
      environment: { OPENAI_API_KEY: 'sk-user' },
    });
    const route = await readCodexSpeedRouteFacts({
      context: { kind: 'home', projectId: 'workspace-1' },
      model: 'gpt-5.5',
    });
    expect(mockResolveEnvironmentProfile).toHaveBeenCalledWith({
      runtime: 'agent',
      workspaceId: 'workspace-1',
    });
    expect(route.routeProfile).toBe('foreign');
    expect(JSON.stringify(route)).not.toContain('sk-user');
  });

  it('reads the canonical chat tab for model, Auto mode, and routing state', async () => {
    const aiCreditsRouting = { active: true, scope: 'session' };
    mockReadChatTabsFile.mockReturnValue(
      chatTabs({
        id: 'chat',
        model: 'gpt-5.5',
        modelSelectionMode: 'auto',
        aiCreditsRouting,
        subscriptionBillingOverride: true,
      }),
    );
    mockResolveAiCreditsRoutingAttempt.mockResolvedValue({
      reason: 'session-override',
    });
    mockResolveGatewayModelEntry.mockReturnValue({ origin: 'ai-gateway' });

    const route = await readCodexSpeedRouteFacts({ context: CHAT });

    expect(mockReadChatTabsFile).toHaveBeenCalledWith('project', 'worktree');
    expect(mockResolveAiCreditsRoutingAttempt).toHaveBeenCalledWith(
      aiCreditsRouting,
      'codex',
      expect.any(Function),
      true,
    );
    // Same workspace the session resolves its Environments overlay for.
    expect(mockResolveEnvironmentProfile).toHaveBeenCalledWith({
      runtime: 'agent',
      workspaceId: 'project',
    });
    expect(route).toEqual(
      expect.objectContaining({
        modelSelection: 'auto',
        runtimeModel: 'gpt-5.5',
        routeProfile: 'ai-credits',
      }),
    );
  });

  it('projects the account proxy route when the proxy would take the chat', async () => {
    mockReadChatTabsFile.mockReturnValue(
      chatTabs({ id: 'chat', model: 'gpt-5.5' }),
    );
    mockPreviewAccountProxy.mockResolvedValue(true);

    const route = await readCodexSpeedRouteFacts({ context: CHAT });

    expect(route).toEqual(
      expect.objectContaining({
        runtimeModel: 'gpt-5.5',
        modelSource: 'codex-managed',
        harness: 'codex',
        routeProfile: 'account-proxy',
      }),
    );
    expect(mockPreviewAccountProxy).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'codex', model: 'gpt-5.5' }),
    );
    await expect(
      mockPreviewAccountProxy.mock.calls[0]?.[0].resolveWorkOwner(),
    ).resolves.toEqual({ kind: 'personal' });
    expect(mockResolveScopeOwner).toHaveBeenCalledWith({
      kind: 'work',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    });
    expect(mockResolveAiCreditsRoutingAttempt).not.toHaveBeenCalled();
  });

  it('keeps a user credential foreign even through the account proxy', async () => {
    mockPreviewAccountProxy.mockResolvedValue(true);
    mockResolveEnvironmentProfile.mockReturnValue({
      environment: { OPENAI_API_KEY: 'sk-user' },
    });
    const route = await readCodexSpeedRouteFacts({
      context: { kind: 'defaults' },
      model: 'gpt-5.5',
    });
    expect(route.routeProfile).toBe('foreign');
  });

  it('skips the account proxy when AI Credits were chosen for the draft', async () => {
    mockPreviewAccountProxy.mockResolvedValue(true);
    await readCodexSpeedRouteFacts({
      context: { kind: 'home', billingFramework: 'ai-credits' },
      model: 'gpt-5.5',
    });
    expect(mockPreviewAccountProxy).not.toHaveBeenCalled();
    expect(mockResolveAiCreditsRoutingAttempt).toHaveBeenCalled();
  });

  it('classifies an enforced organization gateway for the resolved owner before any routing probe', async () => {
    mockResolveScopeOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'org-1',
    });
    mockGatewayRequirement.mockResolvedValue({
      kind: 'enforced',
      organizationIds: ['org-1'],
    });
    const route = await readCodexSpeedRouteFacts({
      context: { kind: 'home', projectId: 'project' },
      model: 'gpt-5.5',
    });
    expect(route.routeProfile).toBe('org-gateway');
    expect(mockResolveScopeOwner).toHaveBeenCalledWith({
      kind: 'work',
      projectId: 'project',
    });
    expect(mockGatewayRequirement).toHaveBeenCalledWith({
      kind: 'organization',
      organizationId: 'org-1',
    });
    expect(mockResolveAiCreditsRoutingAttempt).not.toHaveBeenCalled();
  });

  it('keeps a blocked owner route unknown', async () => {
    mockGatewayRequirement.mockResolvedValue({
      kind: 'blocked',
      reason: 'organization-unavailable',
    });
    const route = await readCodexSpeedRouteFacts({
      context: { kind: 'defaults' },
      model: 'gpt-5.5',
    });
    expect(route.routeProfile).toBe('unknown');
    expect(mockResolveAiCreditsRoutingAttempt).not.toHaveBeenCalled();
  });

  it('routes gateway-only models through their gateway', async () => {
    mockResolveGatewayModelEntry.mockReturnValue({
      origin: 'ai-gateway',
      gatewayOnly: true,
    });
    const route = await readCodexSpeedRouteFacts({
      context: { kind: 'defaults' },
      model: 'deepseek-v4-pro',
    });
    expect(route.routeProfile).toBe('ai-credits');
  });

  it('reports unknown when routing is requested but its fallback cannot be predicted', async () => {
    mockResolveAiCreditsRoutingAttempt.mockResolvedValue({ reason: 'mode' });
    const route = await readCodexSpeedRouteFacts({
      context: { kind: 'defaults' },
      model: 'gpt-5.5',
    });
    expect(route.routeProfile).toBe('unknown');
  });

  it('reports unknown when a host lookup fails', async () => {
    mockGatewayRequirement.mockRejectedValue(new Error('store unavailable'));
    const route = await readCodexSpeedRouteFacts({
      context: { kind: 'defaults' },
      model: 'gpt-5.5',
    });
    expect(route.routeProfile).toBe('unknown');
  });

  it.each([
    ['qwen3-coder', 'ollama'],
    ['claude-sonnet-4-6', 'foreign'],
  ])('classifies %s as %s without gateway probes', async (model, profile) => {
    const route = await readCodexSpeedRouteFacts({
      context: { kind: 'defaults' },
      model,
    });
    expect(route.routeProfile).toBe(profile);
    expect(mockGatewayRequirement).not.toHaveBeenCalled();
  });

  it('returns unknown when a chat cannot be read even with a candidate model', async () => {
    mockReadChatTabsFile.mockRejectedValue(new Error('unreadable'));
    const route = await readCodexSpeedRouteFacts({
      context: CHAT,
      model: 'gpt-5.5',
    });
    expect(route).toEqual(
      expect.objectContaining({
        modelSelection: 'explicit',
        harness: 'codex',
        routeProfile: 'unknown',
      }),
    );
  });

  it('returns unknown for a missing canonical chat instead of guessing its billing state', async () => {
    const route = await readCodexSpeedRouteFacts({
      context: CHAT,
      model: 'gpt-5.5',
    });
    expect(route.routeProfile).toBe('unknown');
    expect(mockResolveAiCreditsRoutingAttempt).not.toHaveBeenCalled();
  });

  it('treats an explicit null model as unresolved instead of using the saved model', async () => {
    mockReadChatTabsFile.mockReturnValue(
      chatTabs({ id: 'chat', model: 'gpt-5.5' }),
    );
    const route = await readCodexSpeedRouteFacts({
      context: CHAT,
      model: null,
    });
    expect(route.runtimeModel).toBeNull();
    expect(route.routeProfile).toBe('unknown');
  });

  it('pairs the deterministic mock provider with its mock catalog', async () => {
    mockMockOverride.mockReturnValue({ env: {}, configArgs: [] });
    const route = await readCodexSpeedRouteFacts({
      context: { kind: 'defaults' },
      model: 'gpt-5.5',
    });
    expect(route.routeProfile).toBe('codex-native');
  });

  it('is unknown without a model', async () => {
    const route = await readCodexSpeedRouteFacts({
      context: { kind: 'defaults' },
    });
    expect(route).toEqual(
      expect.objectContaining({ runtimeModel: null, routeProfile: 'unknown' }),
    );
  });
});

import { resolveHelperInvocation } from '../ollama/helper-invocation';
import { resolveClaudeCompatibleInvocation } from '../ollama/claude-compatible';
import { resolveCodexCompatibleOllamaInvocation } from '../ollama/codex-compatible';
import { resolveAiCreditsRoutingOverride } from '../agents/ai-credits-routing';
import {
  resolveBackgroundWorkOwner,
  resolveInvocationWorkOwner,
} from '../agents/work-owner';
import {
  checkModelGatewayRoute,
  resolveHelperModelForEnforcedGateway,
} from '../lib/model-gateway-state';
import {
  getExecutionHarnessForModel,
  getModelSource,
} from '@canopy/desktop-shared/types';
import type * as SharedTypes from '@canopy/desktop-shared/types';

const mockUnregisterGatewayRoutesForSession = jest.fn();
const mockReleaseRoutes = jest.fn();
const mockRetainRoutes = jest.fn(() => mockReleaseRoutes);
const mockQuotaWait = jest.fn(() => Promise.resolve());
jest.mock('../account-proxy/quota-wait', () => ({
  createAccountProxyQuotaWait: (
    _harness: string,
    accountKey?: string,
  ): typeof mockQuotaWait | undefined =>
    accountKey ? mockQuotaWait : undefined,
}));

jest.mock('../ollama/claude-compatible', () => ({
  resolveClaudeCompatibleInvocation: jest.fn(),
}));
jest.mock('../ollama/codex-compatible', () => ({
  resolveCodexCompatibleOllamaInvocation: jest.fn(),
}));
jest.mock('../agents/ai-credits-routing', () => ({
  resolveAiCreditsRoutingOverride: jest.fn(),
}));
jest.mock('../agents/work-owner', () => ({
  resolveBackgroundWorkOwner: jest.fn(),
  resolveInvocationWorkOwner: jest.fn(),
}));
jest.mock('../lib/model-gateway-state', () => ({
  resolveHelperModelForEnforcedGateway: jest.fn(),
  checkModelGatewayRoute: jest.fn(),
}));
jest.mock('../agents/codex-gateway-proxy-service', () => ({
  getCodexGatewayProxyService: jest.fn(() => ({
    unregisterRoutesForSession: mockUnregisterGatewayRoutesForSession,
    retainRoutesForSession: mockRetainRoutes,
  })),
}));
jest.mock('@canopy/desktop-shared/types', () => {
  const actual = jest.requireActual<typeof SharedTypes>(
    '@canopy/desktop-shared/types',
  );
  return {
    ...actual,
    getExecutionHarnessForModel: jest.fn(),
    getModelSource: jest.fn(),
  };
});

const claudeCompatibleMock = jest.mocked(resolveClaudeCompatibleInvocation);
const codexCompatibleMock = jest.mocked(resolveCodexCompatibleOllamaInvocation);
const overrideMock = jest.mocked(resolveAiCreditsRoutingOverride);
const workOwnerMock = jest.mocked(resolveInvocationWorkOwner);
const backgroundWorkOwnerMock = jest.mocked(resolveBackgroundWorkOwner);
const helperModelMock = jest.mocked(resolveHelperModelForEnforcedGateway);
const harnessMock = jest.mocked(getExecutionHarnessForModel);
const sourceMock = jest.mocked(getModelSource);

describe('resolveHelperInvocation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sourceMock.mockReturnValue('claude-managed');
    harnessMock.mockReturnValue('claude');
    helperModelMock.mockImplementation((model) => Promise.resolve(model));
    workOwnerMock.mockResolvedValue(undefined);
    backgroundWorkOwnerMock.mockResolvedValue(undefined);
  });

  it('refuses a preserved local choice before gateway substitution or provider work', async () => {
    jest
      .mocked(checkModelGatewayRoute)
      .mockResolvedValue({ ok: false, message: 'Gateway required' });
    await expect(
      resolveHelperInvocation('ollama-local', undefined, {
        preserveModelSelection: true,
        workOwner: { kind: 'personal' },
      }),
    ).rejects.toThrow('Gateway required');
    expect(helperModelMock).not.toHaveBeenCalled();
    expect(overrideMock).not.toHaveBeenCalled();
    expect(claudeCompatibleMock).not.toHaveBeenCalled();
    expect(codexCompatibleMock).not.toHaveBeenCalled();
  });

  it('keeps the local selection without consulting the gateway substitution resolver', async () => {
    jest
      .mocked(checkModelGatewayRoute)
      .mockResolvedValue({ ok: true, orgRoute: false });
    sourceMock.mockReturnValue('ollama');
    harnessMock.mockReturnValue('codex');
    codexCompatibleMock.mockResolvedValue({
      runtimeModel: 'local',
      codexConfig: {},
    });
    const invocation = await resolveHelperInvocation(
      'ollama-local',
      undefined,
      { preserveModelSelection: true },
    );
    expect(invocation).toMatchObject({
      source: 'ollama',
      harness: 'codex',
      aiCreditsRouted: false,
    });
    expect(helperModelMock).not.toHaveBeenCalled();
    expect(overrideMock).not.toHaveBeenCalled();
    invocation.dispose();
  });

  it('captures the owner before awaited helper model resolution', async () => {
    workOwnerMock.mockResolvedValueOnce({ kind: 'personal' });
    let releaseModel: ((model: 'opus') => void) | undefined;
    helperModelMock.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseModel = resolve;
      }),
    );
    claudeCompatibleMock.mockResolvedValue({
      providerType: 'claude',
      sdkModel: 'anthropic/claude-opus-5',
    });
    overrideMock.mockResolvedValue(null);

    const invocation = resolveHelperInvocation('opus', undefined, {
      workspaceId: 'workspace',
    });

    expect(workOwnerMock).toHaveBeenCalledWith({ projectId: 'workspace' });
    releaseModel?.('opus');
    await invocation;
    expect(overrideMock.mock.calls[0]?.[4]).toMatchObject({
      workspaceId: 'workspace',
      workOwner: { kind: 'personal' },
    });
  });

  it('preserves an explicitly inherited missing owner without re-resolving navigation', async () => {
    overrideMock.mockResolvedValue(null);

    await resolveHelperInvocation('opus', undefined, {
      workspaceId: 'workspace',
      workOwner: undefined,
    });

    expect(workOwnerMock).not.toHaveBeenCalled();
    expect(backgroundWorkOwnerMock).not.toHaveBeenCalled();
    expect(overrideMock.mock.calls[0]?.[4]).toHaveProperty(
      'workOwner',
      undefined,
    );
    expect(overrideMock.mock.calls[0]?.[4]).toEqual({
      workspaceId: 'workspace',
      workOwner: undefined,
    });
  });

  it('resolves background helpers from their persisted execution context', async () => {
    sourceMock.mockReturnValue('codex-managed');
    harnessMock.mockReturnValue('codex');
    backgroundWorkOwnerMock.mockResolvedValueOnce({
      kind: 'organization',
      organizationId: '123e4567-e89b-12d3-a456-426614174000',
    });
    overrideMock.mockResolvedValue(null);

    await resolveHelperInvocation('gpt-5.5', undefined, {
      workspaceId: 'workspace',
      executionContext: 'org:123e4567-e89b-12d3-a456-426614174000',
    });

    expect(backgroundWorkOwnerMock).toHaveBeenCalledWith(
      { projectId: 'workspace' },
      'org:123e4567-e89b-12d3-a456-426614174000',
    );
    expect(workOwnerMock).not.toHaveBeenCalled();
    expect(overrideMock.mock.calls[0]?.[4]).toMatchObject({
      workOwner: {
        kind: 'organization',
        organizationId: '123e4567-e89b-12d3-a456-426614174000',
      },
    });
  });

  it('preserves delegated workspace and explicit subscription billing authority', async () => {
    sourceMock.mockReturnValue('codex-managed');
    harnessMock.mockReturnValue('codex');
    overrideMock.mockResolvedValue(null);
    await resolveHelperInvocation('gpt-5.5', undefined, {
      workspaceId: 'workspace',
      subscriptionBillingOverride: true,
      allowNoNativeAuthFallback: false,
    });
    expect(overrideMock).toHaveBeenCalledWith(
      'gpt-5.5',
      'codex',
      undefined,
      expect.stringMatching(/^ephemeral:helper:/),
      {
        workspaceId: 'workspace',
        subscriptionBillingOverride: true,
        allowNoNativeAuthFallback: false,
      },
    );
  });

  it('rejects Cursor before any provider resolution', async () => {
    sourceMock.mockReturnValue('cursor-managed');
    harnessMock.mockReturnValue('cursor');

    await expect(resolveHelperInvocation('cursor-default')).rejects.toThrow(
      'Cursor is not available for background helpers.',
    );

    expect(claudeCompatibleMock).not.toHaveBeenCalled();
    expect(codexCompatibleMock).not.toHaveBeenCalled();
    expect(overrideMock).not.toHaveBeenCalled();
  });

  it('routes a Codex helper through the gateway when an override resolves', async () => {
    sourceMock.mockReturnValue('ai-gateway');
    harnessMock.mockReturnValue('codex');
    overrideMock.mockResolvedValue({
      provider: 'codex',
      model: 'deepseek/deepseek-v4-pro',
      env: {},
      codexConfig: { model_provider: 'canopy_ai_credits' },
    });

    const result = await resolveHelperInvocation('deepseek-v4-pro');

    expect(result).toMatchObject({
      providerType: 'codex',
      source: 'ai-gateway',
      harness: 'codex',
      sdkModel: 'deepseek/deepseek-v4-pro',
      codexConfig: { model_provider: 'canopy_ai_credits' },
      aiCreditsRouted: true,
    });
    expect(overrideMock.mock.calls[0]?.[3]).toMatch(/^ephemeral:helper:/);
    result.dispose();
    result.dispose();
    expect(mockUnregisterGatewayRoutesForSession).toHaveBeenCalledWith(
      overrideMock.mock.calls[0]?.[3],
    );
    expect(mockUnregisterGatewayRoutesForSession).toHaveBeenCalledTimes(1);
    // Codex never consults the Claude/Ollama resolver.
    expect(claudeCompatibleMock).not.toHaveBeenCalled();
  });

  it('bills a proxy-routed Claude helper to the proxy and keeps its model', async () => {
    claudeCompatibleMock.mockResolvedValue({
      providerType: 'claude',
      sdkModel: 'opus[1m]',
    });
    overrideMock.mockResolvedValue({
      provider: 'claude',
      model: 'opus[1m]',
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/codex-gateway/r' },
      accountProxyRouted: true,
      accountProxyAccountKey: 'account-proxy:connection-1',
    });

    const result = await resolveHelperInvocation('opus[1m]', undefined, {
      accountProxyParentSessionId: 'parent-chat',
    });

    expect(result).toMatchObject({
      providerType: 'claude',
      sdkModel: 'opus[1m]',
      envOverride: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/codex-gateway/r',
      },
      aiCreditsRouted: false,
      accountProxyRouted: true,
      accountProxyAccountKey: 'account-proxy:connection-1',
    });
    expect(overrideMock.mock.calls[0]?.[4]).toMatchObject({
      accountProxyParentSessionId: 'parent-chat',
    });
  });

  it.each(['claude', 'codex'] as const)(
    'retains a %s helper route across quota recovery until disposal',
    async (harness) => {
      sourceMock.mockReturnValue(
        harness === 'codex' ? 'codex-managed' : 'claude-managed',
      );
      harnessMock.mockReturnValue(harness);
      claudeCompatibleMock.mockResolvedValue({
        providerType: 'claude',
        sdkModel: 'opus[1m]',
      });
      overrideMock.mockResolvedValue({
        provider: harness,
        model: harness === 'codex' ? 'gpt-5.5' : 'opus[1m]',
        env: {},
        accountProxyRouted: true,
        accountProxyAccountKey: 'account-proxy:connection-1',
      });
      const invocation = await resolveHelperInvocation(
        harness === 'codex' ? 'gpt-5.5' : 'opus[1m]',
      );
      const failure = { kind: 'provider_usage_limit', provider: harness };
      await invocation.waitForQuotaRecovery?.(
        failure as never,
        new AbortController().signal,
      );
      await invocation.waitForQuotaRecovery?.(
        failure as never,
        new AbortController().signal,
      );
      expect(mockRetainRoutes).toHaveBeenCalledTimes(1);
      expect(mockRetainRoutes).toHaveBeenCalledWith(
        overrideMock.mock.calls[0]?.[3],
      );
      expect(mockReleaseRoutes).not.toHaveBeenCalled();
      invocation.dispose();
      invocation.dispose();
      expect(mockUnregisterGatewayRoutesForSession).toHaveBeenCalledTimes(1);
      expect(mockReleaseRoutes).toHaveBeenCalledTimes(1);
    },
  );

  describe('retainRoutesUntilDisposed', () => {
    function routeAccountProxy(harness: 'claude' | 'codex'): string {
      sourceMock.mockReturnValue(
        harness === 'codex' ? 'codex-managed' : 'claude-managed',
      );
      harnessMock.mockReturnValue(harness);
      claudeCompatibleMock.mockResolvedValue({
        providerType: 'claude',
        sdkModel: 'opus[1m]',
      });
      overrideMock.mockResolvedValue({
        provider: harness,
        model: harness === 'codex' ? 'gpt-5.5' : 'opus[1m]',
        env: {},
        accountProxyRouted: true,
        accountProxyAccountKey: 'account-proxy:connection-1',
      });
      return harness === 'codex' ? 'gpt-5.5' : 'opus[1m]';
    }

    it.each(['claude', 'codex'] as const)(
      'holds a %s account-proxy route once and releases it once',
      async (harness) => {
        const onRoutesRetained = jest.fn();
        const invocation = await resolveHelperInvocation(
          routeAccountProxy(harness),
          undefined,
          { retainRoutesUntilDisposed: true, onRoutesRetained },
        );

        expect(mockRetainRoutes).toHaveBeenCalledTimes(1);
        expect(mockRetainRoutes).toHaveBeenCalledWith(
          overrideMock.mock.calls[0]?.[3],
        );
        expect(onRoutesRetained).toHaveBeenCalledTimes(1);
        expect(mockReleaseRoutes).not.toHaveBeenCalled();
        invocation.dispose();
        invocation.dispose();
        expect(mockReleaseRoutes).toHaveBeenCalledTimes(1);
        expect(mockUnregisterGatewayRoutesForSession).toHaveBeenCalledTimes(1);
      },
    );

    it('disposes on abort, and a later abort or dispose releases nothing more', async () => {
      const controller = new AbortController();
      const invocation = await resolveHelperInvocation(
        routeAccountProxy('codex'),
        undefined,
        { retainRoutesUntilDisposed: true, signal: controller.signal },
      );

      controller.abort();
      invocation.dispose();
      controller.abort();

      expect(mockReleaseRoutes).toHaveBeenCalledTimes(1);
      expect(mockUnregisterGatewayRoutesForSession).toHaveBeenCalledTimes(1);
    });

    it('releases nothing more when its signal aborts after disposal', async () => {
      const controller = new AbortController();
      const invocation = await resolveHelperInvocation(
        routeAccountProxy('claude'),
        undefined,
        { retainRoutesUntilDisposed: true, signal: controller.signal },
      );

      invocation.dispose();
      controller.abort();

      expect(mockReleaseRoutes).toHaveBeenCalledTimes(1);
      expect(mockUnregisterGatewayRoutesForSession).toHaveBeenCalledTimes(1);
    });

    it('disposes at once when its signal aborted during routing', async () => {
      const controller = new AbortController();
      const model = routeAccountProxy('claude');
      overrideMock.mockImplementationOnce(() => {
        controller.abort();
        return Promise.resolve({
          provider: 'claude',
          model,
          env: {},
          accountProxyRouted: true,
          accountProxyAccountKey: 'account-proxy:connection-1',
        });
      });

      const invocation = await resolveHelperInvocation(model, undefined, {
        retainRoutesUntilDisposed: true,
        signal: controller.signal,
      });

      expect(mockRetainRoutes).toHaveBeenCalledTimes(1);
      expect(mockReleaseRoutes).toHaveBeenCalledTimes(1);
      expect(mockUnregisterGatewayRoutesForSession).toHaveBeenCalledTimes(1);
      invocation.dispose();
      expect(mockReleaseRoutes).toHaveBeenCalledTimes(1);
    });

    it('keeps the quota hold independent of the invocation hold', async () => {
      const invocation = await resolveHelperInvocation(
        routeAccountProxy('codex'),
        undefined,
        { retainRoutesUntilDisposed: true },
      );
      await invocation.waitForQuotaRecovery?.(
        { kind: 'provider_usage_limit', provider: 'codex' } as never,
        new AbortController().signal,
      );

      expect(mockRetainRoutes).toHaveBeenCalledTimes(2);
      invocation.dispose();
      expect(mockReleaseRoutes).toHaveBeenCalledTimes(2);
    });

    it('takes no hold unless asked or for a route that is not account-proxy', async () => {
      const unasked = await resolveHelperInvocation(routeAccountProxy('codex'));
      sourceMock.mockReturnValue('ai-gateway');
      harnessMock.mockReturnValue('codex');
      overrideMock.mockResolvedValue({
        provider: 'codex',
        model: 'deepseek/deepseek-v4-pro',
        env: {},
        codexConfig: { model_provider: 'canopy_ai_credits' },
      });
      const onRoutesRetained = jest.fn();
      const aiCredits = await resolveHelperInvocation(
        'deepseek-v4-pro',
        undefined,
        { retainRoutesUntilDisposed: true, onRoutesRetained },
      );

      expect(mockRetainRoutes).not.toHaveBeenCalled();
      expect(onRoutesRetained).not.toHaveBeenCalled();
      unasked.dispose();
      aiCredits.dispose();
      expect(mockReleaseRoutes).not.toHaveBeenCalled();
    });
  });

  it('bills a proxy-routed Codex helper to the proxy', async () => {
    sourceMock.mockReturnValue('codex-managed');
    harnessMock.mockReturnValue('codex');
    overrideMock.mockResolvedValue({
      provider: 'codex',
      model: 'gpt-5.5',
      env: {},
      accountProxyRouted: true,
      accountProxyAccountKey: 'account-proxy:connection-1',
      codexConfig: { model_provider: 'canopy_account_proxy' },
    });

    await expect(resolveHelperInvocation('gpt-5.5')).resolves.toMatchObject({
      sdkModel: 'gpt-5.5',
      codexConfig: { model_provider: 'canopy_account_proxy' },
      aiCreditsRouted: false,
      accountProxyRouted: true,
      accountProxyAccountKey: 'account-proxy:connection-1',
    });
  });

  it('releases its route owner when routing setup fails', async () => {
    sourceMock.mockReturnValue('ai-gateway');
    harnessMock.mockReturnValue('codex');
    overrideMock.mockRejectedValueOnce(new Error('route setup failed'));

    await expect(resolveHelperInvocation('gpt-5.5')).rejects.toThrow(
      'route setup failed',
    );

    expect(mockUnregisterGatewayRoutesForSession).toHaveBeenCalledWith(
      overrideMock.mock.calls[0]?.[3],
    );
  });

  it('falls back to the native Codex path when no override resolves', async () => {
    sourceMock.mockReturnValue('codex-managed');
    harnessMock.mockReturnValue('codex');
    overrideMock.mockResolvedValue(null);

    const result = await resolveHelperInvocation('gpt-5.5');

    expect(overrideMock).toHaveBeenCalledWith(
      'gpt-5.5',
      'codex',
      undefined,
      expect.stringMatching(/^ephemeral:helper:/),
      {},
    );
    expect(result).toEqual({
      providerType: 'codex',
      source: 'codex-managed',
      harness: 'codex',
      resolvedModel: 'gpt-5.5',
      sdkModel: 'gpt-5.5',
      aiCreditsRouted: false,
      dispose: result.dispose,
    });
    expect(typeof result.dispose).toBe('function');
  });

  it('routes Claude-harness Ollama locally without consulting AI Credits', async () => {
    sourceMock.mockReturnValue('ollama');
    harnessMock.mockReturnValue('claude');
    claudeCompatibleMock.mockResolvedValue({
      providerType: 'ollama',
      sdkModel: 'llama3',
      envOverride: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' },
    });

    const result = await resolveHelperInvocation('ollama-llama3');

    expect(result.providerType).toBe('ollama');
    expect(result.source).toBe('ollama');
    expect(result.harness).toBe('claude');
    expect(result.aiCreditsRouted).toBe(false);
    expect(overrideMock).not.toHaveBeenCalled();
  });

  it('routes Codex-harness Ollama through a thread-scoped Responses config', async () => {
    sourceMock.mockReturnValue('ollama');
    harnessMock.mockReturnValue('codex');
    codexCompatibleMock.mockResolvedValue({
      source: 'ollama',
      harness: 'codex',
      runtimeModel: 'qwen3:8b',
      aiCreditsRouted: false,
      codexConfig: { model_provider: 'canopy_ollama' },
    });

    const result = await resolveHelperInvocation('ollama-qwen3:8b');
    expect(result).toEqual({
      providerType: 'ollama',
      source: 'ollama',
      harness: 'codex',
      resolvedModel: 'ollama-qwen3:8b',
      sdkModel: 'qwen3:8b',
      codexConfig: { model_provider: 'canopy_ollama' },
      aiCreditsRouted: false,
      dispose: result.dispose,
    });
    expect(typeof result.dispose).toBe('function');
    expect(overrideMock).not.toHaveBeenCalled();
    expect(claudeCompatibleMock).not.toHaveBeenCalled();
  });

  it('lets the E2E mock win over AI Credits routing for Claude', async () => {
    // The mock surfaces as a Claude invocation carrying an envOverride.
    claudeCompatibleMock.mockResolvedValue({
      providerType: 'claude',
      sdkModel: 'anthropic/claude-opus-5',
      envOverride: { ANTHROPIC_BASE_URL: 'http://mock.local' },
    });

    const result = await resolveHelperInvocation('opus');

    expect(result.aiCreditsRouted).toBe(false);
    expect(result.source).toBe('claude-managed');
    expect(result.harness).toBe('claude');
    expect(result.envOverride).toEqual({
      ANTHROPIC_BASE_URL: 'http://mock.local',
    });
    expect(overrideMock).not.toHaveBeenCalled();
  });

  it('applies AI Credits routing for a plain Claude helper', async () => {
    sourceMock.mockReturnValue('ai-gateway');
    claudeCompatibleMock.mockResolvedValue({
      providerType: 'claude',
      sdkModel: 'anthropic/claude-opus-5',
    });
    overrideMock.mockResolvedValue({
      provider: 'claude',
      model: 'anthropic/claude-opus-5',
      env: {
        ANTHROPIC_BASE_URL:
          'https://cloud.example.com/api/v1/llm-proxy/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'csk_test',
      },
    });

    const result = await resolveHelperInvocation('opus');

    expect(result).toEqual({
      providerType: 'claude',
      source: 'ai-gateway',
      harness: 'claude',
      resolvedModel: 'opus',
      sdkModel: 'anthropic/claude-opus-5',
      envOverride: {
        ANTHROPIC_BASE_URL:
          'https://cloud.example.com/api/v1/llm-proxy/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'csk_test',
      },
      aiCreditsRouted: true,
      dispose: result.dispose,
    });
    expect(typeof result.dispose).toBe('function');
  });

  it('falls back to the native Claude path when no override resolves', async () => {
    claudeCompatibleMock.mockResolvedValue({
      providerType: 'claude',
      sdkModel: 'anthropic/claude-opus-5',
    });
    overrideMock.mockResolvedValue(null);

    const result = await resolveHelperInvocation('opus');

    expect(overrideMock).toHaveBeenCalledWith(
      'opus',
      'claude',
      undefined,
      expect.stringMatching(/^ephemeral:helper:/),
      {},
    );
    expect(result).toEqual({
      providerType: 'claude',
      source: 'claude-managed',
      harness: 'claude',
      resolvedModel: 'opus',
      sdkModel: 'anthropic/claude-opus-5',
      aiCreditsRouted: false,
      dispose: result.dispose,
    });
    expect(typeof result.dispose).toBe('function');
  });

  // ECW-9091 review round 6. The opt-out must reach BOTH provider branches.
  // `generateWorktreeSummary` dispatches on the model's provider and its default
  // model is a Claude one, so forwarding the option only on the Codex path left
  // the default configuration still auto-spending credits on scheduled runs.
  describe('allowNoNativeAuthFallback forwarding', () => {
    it.each([
      ['codex', 'gpt-5.5'],
      ['claude', 'opus'],
    ] as const)(
      'forwards the opt-out on the %s branch',
      async (provider, model) => {
        harnessMock.mockReturnValue(provider);
        sourceMock.mockReturnValue(
          provider === 'codex' ? 'codex-managed' : 'claude-managed',
        );
        claudeCompatibleMock.mockResolvedValue({
          providerType: 'claude',
          sdkModel: model,
        });
        overrideMock.mockResolvedValue(null);

        await resolveHelperInvocation(model, undefined, {
          allowNoNativeAuthFallback: false,
        });

        expect(overrideMock).toHaveBeenCalledWith(
          model,
          provider,
          undefined,
          expect.stringMatching(/^ephemeral:helper:/),
          { allowNoNativeAuthFallback: false },
        );
      },
    );

    // ECW-9091 review round 7: the guard must resolve the same workspace-scoped
    // environment the helper spawns with. `resolveEnvironmentForRuntime` picks
    // `workspaceAssignment?.runtimes[runtime] ?? globalRuntimes[runtime]` —
    // replace, not merge — so resolving without the workspace can miss a
    // per-workspace provider key that is fully live at spawn.
    it.each([
      ['codex', 'gpt-5.5'],
      ['claude', 'opus'],
    ] as const)(
      'forwards the project on the %s branch',
      async (provider, model) => {
        harnessMock.mockReturnValue(provider);
        sourceMock.mockReturnValue(
          provider === 'codex' ? 'codex-managed' : 'claude-managed',
        );
        claudeCompatibleMock.mockResolvedValue({
          providerType: 'claude',
          sdkModel: model,
        });
        overrideMock.mockResolvedValue(null);

        await resolveHelperInvocation(model, undefined, {
          workspaceId: 'ws-9',
          allowNoNativeAuthFallback: false,
        });

        expect(overrideMock).toHaveBeenCalledWith(
          model,
          provider,
          undefined,
          expect.stringMatching(/^ephemeral:helper:/),
          { allowNoNativeAuthFallback: false, workspaceId: 'ws-9' },
        );
      },
    );

    it.each([
      ['codex', 'gpt-5.5'],
      ['claude', 'opus'],
    ] as const)(
      'omits the option entirely on the %s branch when unspecified',
      async (provider, model) => {
        // Absent rather than `undefined`, so the resolver's own default applies
        // and interactive callers are untouched.
        harnessMock.mockReturnValue(provider);
        sourceMock.mockReturnValue(
          provider === 'codex' ? 'codex-managed' : 'claude-managed',
        );
        claudeCompatibleMock.mockResolvedValue({
          providerType: 'claude',
          sdkModel: model,
        });
        overrideMock.mockResolvedValue(null);

        await resolveHelperInvocation(model);

        expect(overrideMock).toHaveBeenCalledWith(
          model,
          provider,
          undefined,
          expect.stringMatching(/^ephemeral:helper:/),
          {},
        );
      },
    );
  });
});

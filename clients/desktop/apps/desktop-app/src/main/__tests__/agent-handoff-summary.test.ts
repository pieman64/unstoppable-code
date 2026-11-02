import type { WorkOwner } from '@canopy/protocol/llm-gateway';

interface ClaudeQueryRequest {
  options?: Record<string, unknown> & {
    env?: Record<string, string>;
  };
}
interface CodexThreadRequest {
  params: {
    model: string;
    ephemeral: boolean;
    config: Record<string, unknown>;
  };
  profile: { environment: Record<string, string> };
}

const mockQuery = jest.fn<AsyncIterable<unknown>, [ClaudeQueryRequest]>();
const mockRunWorker = jest.fn<Promise<unknown>, [Record<string, unknown>]>();
const mockStartThread = jest.fn<Promise<unknown>, [CodexThreadRequest]>();
const mockRunTurn = jest.fn<Promise<unknown>, [Record<string, unknown>]>();
const mockDeleteThread = jest.fn(() => Promise.resolve());
const mockReadCodexConfig = jest.fn<Promise<unknown>, unknown[]>();
const mockResolveInvocation = jest.fn<Promise<unknown>, unknown[]>();
const mockResolveOwner = jest.fn<
  Promise<WorkOwner | undefined>,
  [{ workOwner?: WorkOwner }]
>();
const mockBlocked = jest.fn<Promise<boolean>, unknown[]>();
const mockGatewayRoute = jest.fn<Promise<unknown>, unknown[]>();
const mockAdmitSpeed = jest.fn<Promise<unknown>, unknown[]>();
const mockDispose = jest.fn();
const mockSeedTranscript = jest.fn<unknown, [string, { provider: string }]>();
const mockUpdateObservedTask = jest.fn();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  get query(): typeof mockQuery {
    return mockQuery;
  },
}));
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: (...args: unknown[]): unknown =>
    mockResolveInvocation(...args),
  resolveHelperWorkOwner: (options: { workOwner?: WorkOwner }): unknown =>
    mockResolveOwner(options),
}));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (...args: unknown[]): unknown =>
    mockBlocked(...args),
}));
jest.mock('../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: (...args: unknown[]): unknown =>
    mockGatewayRoute(...args),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() => Promise.resolve({})),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../integration/claude-worker-session-service', () => ({
  getClaudeWorkerSessionService: (): { runWorker: typeof mockRunWorker } => ({
    runWorker: mockRunWorker,
  }),
}));
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): {
    startThread: typeof mockStartThread;
    admin: () => { request: typeof mockReadCodexConfig };
  } => ({
    startThread: mockStartThread,
    admin: (): { request: typeof mockReadCodexConfig } => ({
      request: mockReadCodexConfig,
    }),
  }),
}));
jest.mock('../codex/speed-policy', () => ({
  admitCodexSpeed: (...args: unknown[]): unknown => mockAdmitSpeed(...args),
  reportCodexSpeedTurnFailure: jest.fn(),
}));
jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: (): {
    environment: Record<string, string>;
    logicalWorkspaceEnvironmentId: string;
  } => ({
    environment: { WORKSPACE_AGENT_ENV: 'enabled' },
    logicalWorkspaceEnvironmentId: 'handoff-test',
  }),
}));
jest.mock('../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: (): string => '/mock/claude',
  getBundledRgBinaryPath: (): string => '/mock/rg',
  getEnhancedEnv: (): Record<string, string> => ({
    ANTHROPIC_API_KEY: 'test-key',
  }),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): Record<string, unknown> => ({
    seedTranscript: mockSeedTranscript,
    appendTranscriptRecord: jest.fn(),
    updateObservedTask: mockUpdateObservedTask,
    finalizeObservedTask: jest.fn(),
    beginClaudeQuery: jest.fn(),
    endClaudeQuery: jest.fn(),
    observeClaudeEvent: jest.fn(),
  }),
}));

import {
  initClaudeModels,
  initCodexModels,
  initModelHarnessAssignments,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
import { readPreferencesFile } from '../lib/preferences-store';
import { generateHandoffSummary } from '../agents/utils';

type PreferencesFileData = Awaited<ReturnType<typeof readPreferencesFile>>;

function preferencesFileFixture(
  preferences: Partial<PreferencesFileData>,
): PreferencesFileData {
  // These tests intentionally provide only the preference fields they exercise.
  return preferences as PreferencesFileData;
}

const owner: WorkOwner = {
  kind: 'organization',
  organizationId: '123e4567-e89b-12d3-a456-426614174000',
};
const conversation =
  'User: continue the migration\nAssistant: inspect the resolver';
const longBriefing =
  `## Decisions\n\n${'Keep the owner bound. '.repeat(12)}`.trim();
const invocation = (
  harness: 'claude' | 'codex',
  source = 'claude-managed',
): {
  providerType: 'claude' | 'codex';
  source: string;
  harness: 'claude' | 'codex';
  sdkModel: string;
  aiCreditsRouted: boolean;
  dispose: typeof mockDispose;
} => ({
  providerType: harness,
  source,
  harness,
  sdkModel: harness === 'codex' ? 'gpt-5.5' : 'claude-sonnet-4-6',
  aiCreditsRouted: false,
  dispose: mockDispose,
});

async function* events(items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) {
    await Promise.resolve();
    yield item;
  }
}

function claudeResult(text: string): void {
  mockQuery.mockReturnValue(
    events([
      { type: 'assistant', message: { content: [{ type: 'text', text }] } },
      {
        type: 'result',
        result: text,
        usage: { input_tokens: 12, output_tokens: 4 },
        total_cost_usd: 0.01,
      },
    ]),
  );
}

function codexResult(text: string): void {
  mockRunTurn.mockResolvedValue({
    status: 'completed',
    finalText: text,
    usage: { inputTokens: 8, outputTokens: 3 },
  });
}

describe('handoff summary model routing', () => {
  beforeAll(() => {
    initClaudeModels([
      { id: 'haiku', label: 'Haiku' },
      { id: 'sonnet', label: 'Sonnet' },
    ]);
    initCodexModels([
      { id: 'gpt-5.5', label: 'GPT 5.5' },
      {
        id: 'gpt-5.6-sol',
        label: 'Sol',
        supportedThinkingLevels: ['off', 'high', 'xhigh', 'max'],
      },
    ]);
    initOllamaModels([
      {
        id: 'ollama-claude',
        rawModelId: 'local-claude',
        label: 'Local Claude',
        show: { capabilities: ['completion', 'tools'] },
      },
      {
        id: 'ollama-codex',
        rawModelId: 'local-codex',
        label: 'Local Codex',
        show: { capabilities: ['completion', 'tools'] },
      },
    ]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveOwner.mockImplementation((options: { workOwner?: WorkOwner }) =>
      Promise.resolve(
        Object.prototype.hasOwnProperty.call(options, 'workOwner')
          ? options.workOwner
          : owner,
      ),
    );
    mockResolveInvocation.mockResolvedValue(invocation('claude'));
    mockBlocked.mockResolvedValue(false);
    mockGatewayRoute.mockResolvedValue({ ok: true, orgRoute: false });
    mockAdmitSpeed.mockResolvedValue({ speed: 'standard' });
    mockReadCodexConfig.mockResolvedValue({
      config: { mcp_servers: { ambient: { command: 'unsafe-helper' } } },
    });
    mockStartThread.mockResolvedValue({
      threadId: 'handoff-thread',
      runTurn: mockRunTurn,
      delete: mockDeleteThread,
    });
    codexResult('  ## Decisions\n\nKeep the owner bound.  ');
    claudeResult('  ## Decisions\n\nKeep the owner bound.  ');
    jest
      .mocked(readPreferencesFile)
      .mockResolvedValue(preferencesFileFixture({}));
    initModelHarnessAssignments({ revision: 0, assignments: [] });
  });

  afterAll(() => {
    initModelHarnessAssignments({ revision: 0, assignments: [] });
    initOllamaModels([]);
  });

  it('defaults to Haiku with thinking off, preserving full Markdown and usage', async () => {
    const result = await generateHandoffSummary(conversation, {
      cwd: '/tmp',
      workspaceId: 'project-1',
      observabilityTaskKey: 'handoff:test',
    });

    expect(result).toEqual({
      text: '## Decisions\n\nKeep the owner bound.',
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        totalCostUsd: 0.01,
        messageCount: 1,
        assistantMessageCount: 1,
      },
    });
    expect(mockBlocked).toHaveBeenCalledWith('haiku', owner);
    expect(mockResolveInvocation).toHaveBeenCalledTimes(1);
    expect(mockResolveInvocation).toHaveBeenCalledWith('haiku', undefined, {
      workspaceId: 'project-1',
      workOwner: owner,
    });
    expect(mockQuery.mock.calls[0]?.[0]?.options).toMatchObject({
      maxTurns: 1,
      thinking: { type: 'disabled' },
      tools: [],
      allowedTools: [],
      mcpServers: {},
      settingSources: [],
    });
    expect(mockSeedTranscript.mock.calls[0]?.[1]?.provider).toBe('claude');
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('uses the selected Claude model and thinking in direct and background execution', async () => {
    await generateHandoffSummary(conversation, {
      model: 'sonnet',
      thinkingLevel: 'high',
      cwd: '/tmp',
    });
    expect(mockBlocked).toHaveBeenCalledWith('sonnet', owner);
    expect(mockResolveInvocation).toHaveBeenCalledWith('sonnet', undefined, {
      workOwner: owner,
    });
    expect(mockQuery.mock.calls[0]?.[0]?.options).toMatchObject({
      model: 'claude-sonnet-4-6',
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'high',
      tools: [],
      allowedTools: [],
      mcpServers: {},
      settingSources: [],
    });

    jest.mocked(readPreferencesFile).mockResolvedValue(
      preferencesFileFixture({
        canopyBackgroundProcessesMode: 'terminal',
      }),
    );
    mockRunWorker.mockResolvedValue({
      status: 'success',
      finalText: '  Background briefing  ',
      usage: { inputTokens: 2 },
    });
    const background = await generateHandoffSummary(conversation, {
      model: 'sonnet',
      thinkingLevel: 'high',
      cwd: '/tmp',
    });
    expect(background.text).toBe('Background briefing');
    expect(mockRunWorker.mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'high',
      permission: { tools: [], allowedTools: [] },
      settingSources: [],
      maxTurns: 1,
    });
  });

  it('routes Codex without invoking Claude, retains text, effort, speed, and deletes its ephemeral thread', async () => {
    mockResolveInvocation.mockResolvedValue(
      invocation('codex', 'codex-managed'),
    );
    codexResult(`  ${longBriefing}  `);
    const result = await generateHandoffSummary(conversation, {
      model: 'gpt-5.5',
      thinkingLevel: 'high',
      modelConfig: { speed: 'fast' },
      cwd: '/tmp',
      observabilityTaskKey: 'handoff:codex',
    });

    expect(result).toMatchObject({
      text: longBriefing,
      usage: { inputTokens: 8, outputTokens: 3 },
    });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRunWorker).not.toHaveBeenCalled();
    expect(mockBlocked).toHaveBeenCalledWith('gpt-5.5', owner);
    expect(mockAdmitSpeed).toHaveBeenCalledWith(
      'fast',
      expect.objectContaining({ selectedModel: 'gpt-5.5' }),
    );
    expect(mockStartThread.mock.calls[0]?.[0]?.params).toMatchObject({
      model: 'gpt-5.5',
      ephemeral: true,
      permissions: 'canopy_report_only',
      approvalPolicy: 'never',
      config: { service_tier: 'priority' },
    });
    expect(mockStartThread.mock.calls[0]?.[0]?.profile?.environment).toEqual({
      WORKSPACE_AGENT_ENV: 'enabled',
    });
    expect(mockRunTurn.mock.calls[0]?.[0]).toMatchObject({ effort: 'high' });
    expect(mockDeleteThread).toHaveBeenCalledTimes(1);
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(mockSeedTranscript.mock.calls[0]?.[1]?.provider).toBe('codex');
  });

  it('denies native tools and ambient capabilities even when the route config enables them', async () => {
    mockResolveInvocation.mockResolvedValue({
      ...invocation('codex', 'ai-gateway'),
      codexConfig: {
        model_provider: 'local-provider',
        'features.shell_tool': true,
        'features.multi_agent_v2': true,
        agents: { enabled: true },
        permissions: {
          canopy_report_only: {
            filesystem: { ':root': 'write' },
            network: { enabled: true },
          },
        },
        mcp_servers: { override: { command: 'unsafe-override' } },
        web_search: 'live',
      },
    });
    await generateHandoffSummary(conversation, {
      model: 'gpt-5.5',
      cwd: '/tmp',
    });
    const params = mockStartThread.mock.calls[0]?.[0]?.params;
    expect(params).toMatchObject({
      permissions: 'canopy_report_only',
      dynamicTools: [],
      environments: [],
      selectedCapabilityRoots: [],
      config: {
        model_provider: 'local-provider',
        permissions: {
          canopy_report_only: {
            filesystem: { ':minimal': 'read' },
            network: { enabled: false },
          },
        },
        mcp_servers: {
          ambient: { enabled: false },
          override: { enabled: false },
        },
        'features.shell_tool': false,
        'features.unified_exec': false,
        'features.multi_agent_v2': false,
        'features.apps': false,
        agents: { enabled: false },
        web_search: 'disabled',
      },
    });
    expect(params).not.toHaveProperty('sandbox');
    expect(mockReadCodexConfig).toHaveBeenCalledWith(
      'config/read',
      { cwd: '/tmp' },
      expect.objectContaining({
        logicalWorkspaceEnvironmentId: 'handoff-test',
      }),
    );
  });

  it('fails closed and disposes the route when report-only configuration cannot be read', async () => {
    mockResolveInvocation.mockResolvedValue(
      invocation('codex', 'codex-managed'),
    );
    mockReadCodexConfig.mockRejectedValueOnce(new Error('Config unavailable.'));
    await expect(
      generateHandoffSummary(conversation, { model: 'gpt-5.5' }),
    ).rejects.toThrow('Config unavailable.');
    expect(mockStartThread).not.toHaveBeenCalled();
    expect(mockRunTurn).not.toHaveBeenCalled();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('keeps Codex speed and audits the resolved gateway selection after a harness substitution', async () => {
    mockResolveInvocation.mockResolvedValue({
      ...invocation('codex', 'ai-gateway'),
      resolvedModel: 'org-route-codex',
      aiCreditsRouted: true,
    });
    await generateHandoffSummary(conversation, {
      model: 'sonnet',
      modelConfig: { speed: 'fast' },
      observabilityTaskKey: 'handoff:gateway',
    });
    expect(mockAdmitSpeed).toHaveBeenCalledWith(
      'fast',
      expect.objectContaining({ harness: 'codex', runtimeModel: 'gpt-5.5' }),
    );
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSeedTranscript.mock.calls[0]?.[1]?.provider).toBe('codex');
    expect(mockUpdateObservedTask).toHaveBeenCalledWith('handoff:gateway', {
      model: 'org-route-codex',
      provider: 'codex',
      modelSource: 'ai-gateway',
      executionHarness: 'codex',
      serviceTier: 'priority',
    });
  });

  it.each([false, true])(
    'preserves catalog max reasoning when AI Credits routing is %s',
    async (aiCreditsRouted) => {
      const sdkModel = aiCreditsRouted ? 'openai/gpt-5.6-sol' : 'gpt-5.6-sol';
      mockResolveInvocation.mockResolvedValue({
        ...invocation(
          'codex',
          aiCreditsRouted ? 'ai-gateway' : 'codex-managed',
        ),
        resolvedModel: 'gpt-5.6-sol',
        sdkModel,
        aiCreditsRouted,
      });
      await generateHandoffSummary(conversation, {
        model: 'gpt-5.6-sol',
        thinkingLevel: 'max',
      });
      expect(mockStartThread.mock.calls[0]?.[0].params.model).toBe(sdkModel);
      expect(mockRunTurn.mock.calls[0]?.[0].effort).toBe('max');
    },
  );

  it('rejects unavailable Codex speed before transcript or thread creation', async () => {
    mockResolveInvocation.mockResolvedValue(
      invocation('codex', 'codex-managed'),
    );
    mockAdmitSpeed.mockRejectedValueOnce(new Error('Fast is unavailable.'));
    await expect(
      generateHandoffSummary(conversation, {
        model: 'gpt-5.5',
        modelConfig: { speed: 'fast' },
        observabilityTaskKey: 'handoff:speed',
      }),
    ).rejects.toThrow('Fast is unavailable.');
    expect(mockSeedTranscript).not.toHaveBeenCalled();
    expect(mockStartThread).not.toHaveBeenCalled();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('reports blank and failed Codex output without a title-style fallback and cleans up', async () => {
    mockResolveInvocation.mockResolvedValue(
      invocation('codex', 'codex-managed'),
    );
    codexResult('  \n  ');
    await expect(
      generateHandoffSummary(conversation, { model: 'gpt-5.5' }),
    ).rejects.toThrow('Summary generation returned no content.');
    expect(mockDeleteThread).toHaveBeenCalledTimes(1);
    expect(mockDispose).toHaveBeenCalledTimes(1);

    mockRunTurn.mockResolvedValueOnce({
      status: 'failed',
      error: 'Provider refused the turn.',
      usage: { inputTokens: 7 },
    });
    await expect(
      generateHandoffSummary(conversation, { model: 'gpt-5.5' }),
    ).rejects.toMatchObject({
      message: 'Provider refused the turn.',
      usage: { inputTokens: 7 },
    });
    expect(mockDeleteThread).toHaveBeenCalledTimes(2);
    expect(mockDispose).toHaveBeenCalledTimes(2);
  });

  it('retries a transient Codex failure on the same ephemeral thread and retains usage', async () => {
    jest.useFakeTimers();
    try {
      mockResolveInvocation.mockResolvedValue(
        invocation('codex', 'codex-managed'),
      );
      let firstTurnStarted: (() => void) | undefined;
      const firstTurn = new Promise<void>((resolve) => {
        firstTurnStarted = resolve;
      });
      mockRunTurn
        .mockImplementationOnce(() => {
          firstTurnStarted?.();
          return Promise.resolve({
            status: 'failed',
            error: 'unexpected status 503',
            usage: { inputTokens: 2 },
          });
        })
        .mockResolvedValueOnce({
          status: 'completed',
          finalText: 'Recovered briefing',
          usage: { inputTokens: 8, outputTokens: 3 },
        });

      const resultPromise = generateHandoffSummary(conversation, {
        model: 'gpt-5.5',
      });
      await firstTurn;
      await jest.advanceTimersByTimeAsync(30_000);
      await expect(resultPromise).resolves.toMatchObject({
        text: 'Recovered briefing',
        usage: { inputTokens: 10, outputTokens: 3 },
      });
      expect(mockStartThread).toHaveBeenCalledTimes(1);
      expect(mockRunTurn).toHaveBeenCalledTimes(2);
      expect(mockRunTurn.mock.calls[1]?.[0]?.input).toEqual([
        { type: 'text', text: 'Continue', text_elements: [] },
      ]);
      expect(mockDeleteThread).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a policy block before resolving or running a model', async () => {
    mockBlocked.mockResolvedValueOnce(true);
    await expect(
      generateHandoffSummary(conversation, { model: 'gpt-5.5' }),
    ).rejects.toThrow('blocked by your organization policy');
    expect(mockResolveInvocation).not.toHaveBeenCalled();
  });

  it('preserves an explicitly missing owner through policy, gateway, and resolution', async () => {
    mockResolveInvocation.mockResolvedValue({
      ...invocation('claude', 'ollama'),
      providerType: 'ollama',
    });
    await generateHandoffSummary(conversation, {
      model: 'ollama-claude',
      workOwner: undefined,
    });
    expect(mockResolveOwner).toHaveBeenCalledWith({ workOwner: undefined });
    expect(mockBlocked).toHaveBeenCalledWith('ollama-claude', undefined);
    expect(mockGatewayRoute).toHaveBeenCalledWith('ollama-claude', undefined);
    expect(mockResolveInvocation.mock.calls[0]?.[2]).toHaveProperty(
      'workOwner',
      undefined,
    );
  });

  it.each([
    ['claude', 'ollama-claude'],
    ['codex', 'ollama-codex'],
  ] as const)(
    'keeps %s-harness Ollama execution local',
    async (harness, model) => {
      initModelHarnessAssignments({
        revision: 1,
        assignments: [
          {
            modelId: model,
            source: 'ollama',
            harness,
            defaultHarness: 'codex',
            configurable: true,
            overridden: true,
          },
        ],
      });
      mockResolveInvocation.mockResolvedValue({
        ...invocation(harness, 'ollama'),
        providerType: 'ollama',
        sdkModel: 'local-model',
        ...(harness === 'claude'
          ? { envOverride: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' } }
          : { codexConfig: { model_provider: 'canopy_ollama' } }),
      });
      await generateHandoffSummary(conversation, { model });
      expect(mockResolveInvocation).toHaveBeenCalledWith(
        model,
        undefined,
        expect.objectContaining({
          workOwner: owner,
          preserveModelSelection: true,
        }),
      );
      expect(mockGatewayRoute).toHaveBeenCalledWith(model, owner);
      expect(mockGatewayRoute.mock.invocationCallOrder[0]).toBeLessThan(
        mockResolveInvocation.mock.invocationCallOrder[0] ?? 0,
      );
      if (harness === 'claude') {
        expect(mockQuery.mock.calls[0]?.[0]?.options?.env).toMatchObject({
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
        });
        expect(mockStartThread).not.toHaveBeenCalled();
      } else {
        expect(
          mockStartThread.mock.calls[0]?.[0]?.params?.config,
        ).toMatchObject({
          model_provider: 'canopy_ollama',
        });
        expect(mockQuery).not.toHaveBeenCalled();
      }
    },
  );

  it('rejects a gateway-blocked local model before allocating a route', async () => {
    mockGatewayRoute.mockResolvedValueOnce({
      ok: false,
      message: 'A gateway is required.',
    });
    await expect(
      generateHandoffSummary(conversation, { model: 'ollama-claude' }),
    ).rejects.toThrow('A gateway is required.');
    expect(mockResolveInvocation).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a non-Ollama local invocation and surfaces model installation errors', async () => {
    mockResolveInvocation.mockResolvedValueOnce({
      ...invocation('claude'),
      source: 'claude-managed',
    });
    await expect(
      generateHandoffSummary(conversation, { model: 'ollama-claude' }),
    ).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();

    mockResolveInvocation.mockRejectedValueOnce(
      new Error('Local model is not installed.'),
    );
    await expect(
      generateHandoffSummary(conversation, { model: 'ollama-claude' }),
    ).rejects.toThrow('Local model is not installed.');
  });

  it('rejects unsupported and unknown models without silently falling back to Haiku', async () => {
    await expect(
      generateHandoffSummary(conversation, { model: 'cursor-default' }),
    ).rejects.toThrow('unavailable for handoffs');
    await expect(
      generateHandoffSummary(conversation, { model: 'bogus' }),
    ).rejects.toThrow('unavailable for handoffs');
    expect(mockResolveInvocation).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

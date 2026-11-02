import type { ClaudeWorkerRunResult } from '../integration/claude-worker-session-service';
import type { CodexSelectedCapabilityRoot } from '@canopy/desktop-shared/types';

const runClaudeStructuredHelperQueryMock = jest.fn(() =>
  Promise.resolve({ value: { title: 'result' }, usage: {} }),
);
const readPreferencesFileMock = jest.fn(() =>
  Promise.resolve({ canopyBackgroundProcessesMode: 'canopy' }),
);
const spawnClaudeCodeProcessOffMainMock = jest.fn();
const cancelWorkerMock = jest.fn(() => Promise.resolve());
const runWorkerMock = jest.fn(
  (): Promise<ClaudeWorkerRunResult<{ title: string }>> =>
    Promise.resolve({
      workerId: 'worker-1',
      sessionId: 'session-1',
      sessionStarted: true,
      status: 'success',
      finalText: '{"title":"result"}',
      result: { title: 'result' },
      usage: {},
      transcript: [],
      transcriptJsonl: '',
    }),
);

interface TestCodexTurnInput {
  effort?: string;
  outputSchema?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const runCodexTurnMock = jest.fn(
  (_input: TestCodexTurnInput): Promise<Record<string, unknown>> => {
    void _input;
    return Promise.resolve({
      status: 'completed',
      finalText: JSON.stringify({ title: 'result', detail: null }),
      usage: {},
    });
  },
);
const deleteCodexThreadMock = jest.fn(() => Promise.resolve());
const readCodexConfigMock = jest.fn(() =>
  Promise.resolve({
    config: {
      mcp_servers: {
        ambient: { command: '/host/ambient-mcp' },
      },
    },
  }),
);
const startCodexThreadMock = jest.fn((request: unknown) => {
  void request;
  return Promise.resolve({
    threadId: 'codex-thread-1',
    runTurn: runCodexTurnMock,
    delete: deleteCodexThreadMock,
  });
});

jest.mock('@canopy/desktop-shared/lib/structured-helper-query', () => ({
  get runClaudeStructuredHelperQuery(): typeof runClaudeStructuredHelperQueryMock {
    return runClaudeStructuredHelperQueryMock;
  },
  StructuredHelperQueryError: class StructuredHelperQueryError extends Error {},
}));
jest.mock('../lib/preferences-store', () => ({
  get readPreferencesFile(): typeof readPreferencesFileMock {
    return readPreferencesFileMock;
  },
}));
jest.mock('../agents/claude-process-host-runner', () => ({
  get spawnClaudeCodeProcessOffMain(): typeof spawnClaudeCodeProcessOffMainMock {
    return spawnClaudeCodeProcessOffMainMock;
  },
}));
jest.mock('../integration/claude-worker-session-service', () => ({
  getClaudeWorkerSessionService: jest.fn(() => ({
    get runWorker(): typeof runWorkerMock {
      return runWorkerMock;
    },
    get cancel(): typeof cancelWorkerMock {
      return cancelWorkerMock;
    },
  })),
}));
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): {
    startThread: typeof startCodexThreadMock;
    admin: () => { request: typeof readCodexConfigMock };
  } => ({
    get startThread(): typeof startCodexThreadMock {
      return startCodexThreadMock;
    },
    admin: () => ({ request: readCodexConfigMock }),
  }),
}));
const assertCodexSpeedAvailableMock = jest.fn(
  (request: { speed: string }): Promise<Record<string, unknown>> =>
    Promise.resolve({ speed: request.speed, availability: {}, generation: 7 }),
);
const reportCodexSpeedRejectionMock = jest.fn(
  (report: unknown): boolean => report !== undefined,
);
jest.mock('../model-routing/codex-account-models', () => ({
  assertCodexSpeedAvailable: (request: {
    speed: string;
  }): Promise<Record<string, unknown>> =>
    assertCodexSpeedAvailableMock(request),
  reportCodexSpeedRejection: (report: unknown): boolean =>
    reportCodexSpeedRejectionMock(report),
}));
jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: (): {
    environment: Record<string, never>;
    logicalWorkspaceEnvironmentId: string;
  } => ({
    environment: {},
    logicalWorkspaceEnvironmentId: 'test-environment',
  }),
}));

import { CodexSpeedUnsupportedError } from '@canopy/desktop-shared/lib/codex-speed';
import {
  codexStructuredHelperRunner,
  runStructuredHelper,
  structuredHelperReadOnlyPermission,
  structuredHelperReportOnlyPermission,
} from '../integration/structured-helper-dispatch';

describe('structured helper dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readPreferencesFileMock.mockResolvedValue({
      canopyBackgroundProcessesMode: 'canopy',
    });
  });

  it('uses the off-main Claude process bridge for in-app helpers', async () => {
    await runStructuredHelper({
      kind: 'branch_naming',
      label: 'Branch Naming',
      provider: 'claude',
      repoPath: '/repo',
      model: 'claude-haiku-4-5-20251001',
      executionHarness: 'claude',
      systemPrompt: 'Return a title.',
      userMessage: 'Describe the change.',
      maxTurns: 1,
      localMemoryEnabled: false,
      schema: { type: 'object' },
      isResult: (value): value is { title: string } =>
        typeof value === 'object' && value !== null && 'title' in value,
    });

    expect(runClaudeStructuredHelperQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMainMock,
      }),
    );
  });

  it('keeps MCP tools restricted for constrained terminal helpers', async () => {
    readPreferencesFileMock.mockResolvedValue({
      canopyBackgroundProcessesMode: 'terminal',
    });

    await runStructuredHelper({
      kind: 'branch_naming',
      label: 'Branch Naming',
      provider: 'claude',
      repoPath: '/repo',
      model: 'claude-haiku-4-5-20251001',
      executionHarness: 'claude',
      systemPrompt: 'Return a title.',
      userMessage: 'Describe the change.',
      maxTurns: 1,
      localMemoryEnabled: false,
      schema: { type: 'object' },
      isResult: (value): value is { title: string } =>
        typeof value === 'object' && value !== null && 'title' in value,
    });

    expect(runWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalMode: 'auto',
      }),
    );
    for (const permission of [
      structuredHelperReportOnlyPermission(),
      structuredHelperReadOnlyPermission(),
    ]) {
      expect(permission).not.toHaveProperty('permissionMode');
      expect(permission).not.toHaveProperty('allowDangerouslySkipPermissions');
    }
  });

  it('forwards a local terminal validation schema without changing generation schema', async () => {
    readPreferencesFileMock.mockResolvedValue({
      canopyBackgroundProcessesMode: 'terminal',
    });
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    const resultValidationSchema = { type: 'object' };
    await runStructuredHelper({
      kind: 'test',
      label: 'Test',
      provider: 'claude',
      repoPath: '/repo',
      model: 'claude-haiku-4-5-20251001',
      executionHarness: 'claude',
      systemPrompt: '',
      userMessage: '',
      maxTurns: 1,
      localMemoryEnabled: false,
      schema,
      ...{ resultValidationSchema },
      isResult: (value): value is { title: string } =>
        typeof value === 'object' && value !== null && 'title' in value,
    });
    expect(runWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({ schema, resultValidationSchema }),
    );
  });

  it.each([true, false])(
    'returns unusable output only for opted-in terminal rejection: %s',
    async (observeRejection) => {
      readPreferencesFileMock.mockResolvedValue({
        canopyBackgroundProcessesMode: 'terminal',
      });
      runWorkerMock.mockResolvedValueOnce({
        workerId: 'worker-1',
        sessionId: 'session-1',
        sessionStarted: true,
        status: 'failure',
        finalText: '',
        result: null,
        usage: { inputTokens: 9 },
        transcript: [],
        transcriptJsonl: '',
        invalidOutput: true,
      });
      const onResultRejected = jest.fn();
      const run = runStructuredHelper({
        kind: 'test',
        label: 'Test',
        provider: 'claude',
        repoPath: '/repo',
        model: 'claude-haiku-4-5-20251001',
        executionHarness: 'claude',
        systemPrompt: '',
        userMessage: '',
        maxTurns: 1,
        localMemoryEnabled: false,
        schema: { type: 'object' },
        ...(observeRejection ? { onResultRejected } : {}),
        isResult: (value): value is { title: string } =>
          typeof value === 'object' && value !== null && 'title' in value,
      });
      if (observeRejection) {
        await expect(run).resolves.toEqual({
          value: null,
          usage: { inputTokens: 9 },
        });
        expect(runWorkerMock).toHaveBeenCalledWith(
          expect.objectContaining({ onResultRejected }),
        );
      } else await expect(run).rejects.toThrow('Claude worker failed');
    },
  );

  it('adapts Codex schemas and removes synthetic optional nulls', async () => {
    const result = await codexStructuredHelperRunner.run({
      repoPath: '/repo',
      model: 'gpt-6-sol',
      systemPrompt: 'Return a title.',
      userMessage: 'Describe the change.',
      combinedPrompt: 'Return a title.\n\nDescribe the change.',
      localMemoryEnabled: false,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['title'],
      },
      isResult: (value): value is { title: string; detail?: string } =>
        typeof value === 'object' &&
        value !== null &&
        'title' in value &&
        typeof value.title === 'string' &&
        (!('detail' in value) || typeof value.detail === 'string'),
    });

    const turn = runCodexTurnMock.mock.calls[0]?.[0];
    const outputSchema = turn?.outputSchema;
    const outputSchemaProperties = outputSchema?.properties;
    const properties = isRecord(outputSchemaProperties)
      ? outputSchemaProperties
      : undefined;
    expect(outputSchema?.required).toEqual(['title', 'detail']);
    expect(
      isRecord(properties?.detail) ? properties.detail.type : undefined,
    ).toEqual(['string', 'null']);
    expect(result.value).toEqual({ title: 'result' });
    expect(deleteCodexThreadMock).toHaveBeenCalledTimes(1);
  });

  it('runs report-only Codex helpers with no project, network, MCP, or capability access', async () => {
    const malformedCapabilityRoot: CodexSelectedCapabilityRoot = {
      id: 'unsafe-root',
      location: {
        type: 'environment',
        environmentId: 'test-environment',
        path: '/host/secrets',
      },
    };
    // Preserve the legacy malformed shape this test verifies is not granted.
    Reflect.deleteProperty(malformedCapabilityRoot, 'location');
    Reflect.set(malformedCapabilityRoot, 'path', '/host/secrets');
    Reflect.set(malformedCapabilityRoot, 'kind', 'skill');
    await codexStructuredHelperRunner.run({
      repoPath: '/repo',
      model: 'gpt-5.5',
      systemPrompt: 'Return a title.',
      userMessage: 'Untrusted persisted content.',
      combinedPrompt: 'Untrusted persisted content.',
      localMemoryEnabled: false,
      permissionMode: 'report-only',
      pluginRuntime: {
        claudePlugins: [],
        claudeMcpServers: {},
        codexMcpServers: {
          unsafe: { command: 'unsafe-helper' },
        },
        codexCapabilityRoots: [malformedCapabilityRoot],
      },
      codexConfigOverride: {
        'features.apps': true,
        'features.multi_agent_v2': true,
        'agents.enabled': true,
        agents: { enabled: true },
        features: { multi_agent: true, multi_agent_v2: true },
        model_provider: 'configured-provider',
        model_providers: {
          'configured-provider': {
            base_url: 'http://127.0.0.1:11434/v1',
            requires_openai_auth: false,
          },
        },
        mcp_servers: {
          override: { command: 'also-unsafe' },
        },
        permissions: {
          canopy_report_only: {
            filesystem: { ':root': 'write' },
            network: { enabled: true },
          },
        },
        web_search: 'live',
      },
      schema: { type: 'object' },
      isResult: (value): value is { title: string } =>
        typeof value === 'object' && value !== null && 'title' in value,
    });

    const request: unknown = startCodexThreadMock.mock.calls[0]?.[0];
    const params = isRecord(request) ? request.params : undefined;
    expect(params).toMatchObject({
      permissions: 'canopy_report_only',
      dynamicTools: [],
      environments: [],
      selectedCapabilityRoots: [],
      config: {
        mcp_servers: {
          ambient: { enabled: false },
        },
        'features.apps': false,
        'features.multi_agent': false,
        'features.multi_agent_v2': false,
        'agents.enabled': false,
        agents: { enabled: false },
        features: { multi_agent: false, multi_agent_v2: false },
        'features.plugins': false,
        model_provider: 'configured-provider',
        model_providers: {
          'configured-provider': {
            base_url: 'http://127.0.0.1:11434/v1',
            requires_openai_auth: false,
          },
        },
        web_search: 'disabled',
        permissions: {
          canopy_report_only: {
            filesystem: { ':minimal': 'read' },
            network: { enabled: false },
          },
        },
      },
    });
    expect(params).not.toHaveProperty('sandbox');
    expect(readCodexConfigMock).toHaveBeenCalledWith(
      'config/read',
      { cwd: '/repo' },
      expect.objectContaining({
        logicalWorkspaceEnvironmentId: 'test-environment',
      }),
    );
  });

  it.each([
    ['null', null],
    ['an array', [{ command: 'not-a-server-table' }]],
  ])(
    'ignores mcp_servers when the configured value is %s',
    async (_label, mcpServers) => {
      await codexStructuredHelperRunner.run({
        repoPath: '/repo',
        model: 'gpt-5.5',
        systemPrompt: 'Return a title.',
        userMessage: 'Describe the change.',
        combinedPrompt: 'Describe the change.',
        localMemoryEnabled: false,
        codexConfigOverride: { mcp_servers: mcpServers },
        schema: { type: 'object' },
        isResult: (value): value is { title: string } =>
          typeof value === 'object' && value !== null && 'title' in value,
      });

      const request: unknown = startCodexThreadMock.mock.calls[0]?.[0];
      const params = isRecord(request) ? request.params : undefined;
      const config = isRecord(params) ? params.config : undefined;
      expect(isRecord(config) ? config.mcp_servers : undefined).toEqual({});
    },
  );

  it('sends none when a Luna structured helper has thinking disabled', async () => {
    await codexStructuredHelperRunner.run({
      repoPath: '/repo',
      model: 'gpt-5.6-luna',
      thinkingLevel: 'off',
      systemPrompt: 'Return a title.',
      userMessage: 'Describe the change.',
      combinedPrompt: 'Return a title.\n\nDescribe the change.',
      localMemoryEnabled: false,
      schema: { type: 'object' },
      isResult: (value): value is { title: string } =>
        typeof value === 'object' && value !== null && 'title' in value,
    });

    expect(runCodexTurnMock.mock.calls[0]?.[0]?.effort).toBe('none');
  });

  it('suppresses Codex-native memories only while local memory is enabled', async () => {
    const original = process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
    const baseRunOptions = {
      repoPath: '/repo',
      model: 'gpt-6-sol',
      systemPrompt: 'Return a title.',
      userMessage: 'Describe the change.',
      combinedPrompt: 'Return a title.\n\nDescribe the change.',
      schema: { type: 'object' },
      isResult: (value: unknown): value is { title: string } =>
        typeof value === 'object' && value !== null && 'title' in value,
    };
    try {
      // Default (local memory off): canonical Codex memory config untouched.
      await codexStructuredHelperRunner.run({
        ...baseRunOptions,
        localMemoryEnabled: false,
      });
      const defaultRequest: unknown = startCodexThreadMock.mock.calls[0]?.[0];
      const defaultParams = isRecord(defaultRequest)
        ? defaultRequest.params
        : undefined;
      const defaultConfig = isRecord(defaultParams)
        ? defaultParams.config
        : undefined;
      expect(defaultConfig).not.toHaveProperty(['features.memories']);

      // Enabled: suppression key is merged in (dotted, never a nested table).
      startCodexThreadMock.mockClear();
      await codexStructuredHelperRunner.run({
        ...baseRunOptions,
        localMemoryEnabled: true,
      });
      const request: unknown = startCodexThreadMock.mock.calls[0]?.[0];
      const params = isRecord(request) ? request.params : undefined;
      const config = isRecord(params) ? params.config : undefined;
      expect(config).toMatchObject({ 'features.memories': false });
      expect(config).not.toHaveProperty(['features']);

      // Escape hatch force-allows native memory even while enabled.
      startCodexThreadMock.mockClear();
      process.env.CANOPY_HARNESS_NATIVE_MEMORY = '1';
      await codexStructuredHelperRunner.run({
        ...baseRunOptions,
        localMemoryEnabled: true,
      });
      const allowedRequest: unknown = startCodexThreadMock.mock.calls[0]?.[0];
      const allowedParams = isRecord(allowedRequest)
        ? allowedRequest.params
        : undefined;
      const allowedConfig = isRecord(allowedParams)
        ? allowedParams.config
        : undefined;
      expect(allowedConfig).not.toHaveProperty(['features.memories']);
    } finally {
      if (original === undefined) {
        delete process.env.CANOPY_HARNESS_NATIVE_MEMORY;
      } else {
        process.env.CANOPY_HARNESS_NATIVE_MEMORY = original;
      }
    }
  });

  describe('Codex speed admission', () => {
    const speedRunOptions = {
      repoPath: '/repo',
      model: 'gpt-5.5',
      systemPrompt: 'Return a title.',
      userMessage: 'Describe the change.',
      combinedPrompt: 'Return a title.\n\nDescribe the change.',
      localMemoryEnabled: false,
      modelConfig: { speed: 'ultrafast' as const },
      schema: { type: 'object' },
      isResult: (value: unknown): value is { title: string } =>
        typeof value === 'object' && value !== null && 'title' in value,
    };

    function threadConfig(): unknown {
      const request: unknown = startCodexThreadMock.mock.calls[0]?.[0];
      const params = isRecord(request) ? request.params : undefined;
      return isRecord(params) ? params.config : undefined;
    }

    it('admits the exact Ultra fast speed on the native route before any Codex request', async () => {
      await codexStructuredHelperRunner.run(speedRunOptions);

      expect(assertCodexSpeedAvailableMock).toHaveBeenCalledTimes(1);
      const admissionRequest: unknown =
        assertCodexSpeedAvailableMock.mock.calls[0]?.[0];
      expect(admissionRequest).toMatchObject({
        speed: 'ultrafast',
        route: {
          runtimeModel: 'gpt-5.5',
          harness: 'codex',
          routeProfile: 'codex-native',
        },
      });
      expect(
        assertCodexSpeedAvailableMock.mock.invocationCallOrder[0],
      ).toBeLessThan(startCodexThreadMock.mock.invocationCallOrder[0] ?? 0);
      expect(threadConfig()).toMatchObject({ service_tier: 'ultrafast' });
    });

    it('classifies a thread provider override as a foreign route', async () => {
      await codexStructuredHelperRunner.run({
        ...speedRunOptions,
        modelConfig: { speed: 'fast' },
        codexConfigOverride: {
          model_provider: 'canopy_gateway',
          model_providers: { canopy_gateway: { name: 'Gateway' } },
        },
      });

      const admissionRequest: unknown =
        assertCodexSpeedAvailableMock.mock.calls[0]?.[0];
      expect(admissionRequest).toMatchObject({
        speed: 'fast',
        route: { routeProfile: 'foreign' },
      });
      expect(threadConfig()).toMatchObject({ service_tier: 'priority' });
    });

    it('rejects an unavailable Ultra fast speed before config reads, threads, or turns', async () => {
      assertCodexSpeedAvailableMock.mockRejectedValueOnce(
        new CodexSpeedUnsupportedError(
          'ultrafast',
          'Ultra fast is not available for this model.',
        ),
      );

      await expect(
        codexStructuredHelperRunner.run({
          ...speedRunOptions,
          permissionMode: 'report-only',
        }),
      ).rejects.toThrow('Ultra fast is not available for this model.');

      expect(readCodexConfigMock).not.toHaveBeenCalled();
      expect(startCodexThreadMock).not.toHaveBeenCalled();
      expect(runCodexTurnMock).not.toHaveBeenCalled();
    });

    it('reports one failed Ultra fast turn against its admission without changing speed', async () => {
      runCodexTurnMock.mockResolvedValueOnce({
        status: 'failed',
        finalText: '',
        usage: {},
        error: 'The requested service tier is not available for this model.',
        errorInfo: 'badRequest',
      });

      await expect(
        codexStructuredHelperRunner.run(speedRunOptions),
      ).rejects.toThrow('service tier');

      expect(reportCodexSpeedRejectionMock).toHaveBeenCalledTimes(1);
      expect(reportCodexSpeedRejectionMock).toHaveBeenCalledWith({
        speed: 'ultrafast',
        runtimeModel: 'gpt-5.5',
        kind: 'tier',
        generation: 7,
      });
      expect(startCodexThreadMock).toHaveBeenCalledTimes(1);
      expect(threadConfig()).toMatchObject({ service_tier: 'ultrafast' });
    });
  });
});

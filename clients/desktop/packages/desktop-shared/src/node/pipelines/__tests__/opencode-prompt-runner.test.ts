import { prepareOpenCodeInferenceRoute } from '../../opencode/inference-route';
import { AI_CREDITS_PROXY_ERROR_MARKER } from '@canopy/protocol';
import { brandEnvName } from '../../../brand/env';
import { runRtkRewrite } from '../../rtk/rewrite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOpenCodeTurn } from '../../opencode/turn-driver';
import type { OpenCodeCapabilityBinding } from '../../opencode/capability-snapshot';
import {
  runOpenCodePipelinePrompt,
  type OpenCodePipelineCapabilities,
  type OpenCodePromptHost,
} from '../opencode-prompt-runner';

jest.mock('../../rtk/rewrite', () => ({ runRtkRewrite: jest.fn() }));
jest.mock('../../opencode/turn-driver', () => ({ runOpenCodeTurn: jest.fn() }));
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'opencode-pipeline-usage-'));
  jest.mocked(runOpenCodeTurn).mockReset();
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function capabilityBinding(sessionId: string): OpenCodeCapabilityBinding {
  return {
    version: 3,
    sessionId,
    digest: 'a'.repeat(64),
    generation: 1,
  };
}

async function run(
  answers: string[],
  missingUsage = false,
): Promise<Awaited<ReturnType<typeof runOpenCodePipelinePrompt>>> {
  let attempt = 0;
  jest.mocked(runOpenCodeTurn).mockImplementation(async (_request, host) => {
    await host.onSession?.(
      'fixture-session',
      capabilityBinding('fixture-session'),
    );
    const responseText = answers[attempt++];
    return {
      sessionId: 'fixture-session',
      responseText,
      isError: false,
      cancelled: false,
      message: '',
      ...(missingUsage
        ? {}
        : {
            usage: {
              input_tokens: 10 * attempt,
              output_tokens: 2 * attempt,
              reasoning_tokens: 0,
              cache_read_input_tokens: 3 * attempt,
              cache_creation_input_tokens: attempt,
            },
          }),
    };
  });
  const host: OpenCodePromptHost = {
    open: (signal) =>
      Promise.resolve({
        executable: process.execPath,
        env: {},
        signal,
        close: () => Promise.resolve(),
      }),
    authorize: () => Promise.resolve({ decision: 'allow' }),
  };
  return runOpenCodePipelinePrompt(
    {
      cwd,
      prompt: 'Return an answer',
      environment: {},
      model: 'opencode:fixture%2Fmodel',
      executionsDir: join(cwd, 'executions'),
      executionId: 'execution',
      jobId: 'job',
      stepId: 'step',
      attempt: 1,
      permissionPreset: 'none',
      totalTimeoutMs: 10_000,
      schema: {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
    },
    host,
  );
}

test.each([
  {
    name: 'successful retry',
    answers: ['invalid', '{}', '{"answer":"ok"}'],
    status: 'success',
  },
  {
    name: 'exhausted retries',
    answers: ['invalid', '{}', 'invalid'],
    status: 'failure',
  },
])(
  'transcript usage keeps every attempt after $name',
  async ({ answers, status }) => {
    const result = await run(answers);
    expect(result.status).toBe(status);
    expect(runOpenCodeTurn).toHaveBeenCalledTimes(3);
    const snapshots = result.transcript
      .split('\n')
      .filter((line) => line.includes('"type":"result"'))
      .map((line): unknown => JSON.parse(line));
    expect(snapshots).toEqual(
      [10, 30, 60].map((input) => ({
        type: 'result',
        provider: 'opencode',
        is_error: false,
        usage: {
          input_tokens: input,
          output_tokens: input / 5,
          cache_read_input_tokens: (input * 3) / 10,
          cache_creation_input_tokens: input / 10,
        },
      })),
    );
    if (result.status === 'success')
      expect(result.usage).toMatchObject({
        inputTokens: 60,
        outputTokens: 12,
        cacheReadInputTokens: 18,
        cacheCreationInputTokens: 6,
      });
  },
);
test('unavailable provider usage stays absent from transcript snapshots', async () => {
  const result = await run(['invalid', '{"answer":"ok"}'], true);
  expect(result.status).toBe('success');
  const snapshots = result.transcript
    .split('\n')
    .filter((line) => line.includes('"type":"result"'))
    .map((line): unknown => JSON.parse(line));
  expect(snapshots).toEqual(
    Array.from({ length: 2 }, () => ({
      type: 'result',
      provider: 'opencode',
      is_error: false,
    })),
  );
});

function request(
  overrides: Partial<Parameters<typeof runOpenCodePipelinePrompt>[0]> = {},
): Parameters<typeof runOpenCodePipelinePrompt>[0] {
  return {
    cwd,
    prompt: 'Return an answer',
    environment: {},
    model: 'opencode:fixture%2Fmodel',
    executionsDir: join(cwd, 'executions'),
    executionId: 'execution',
    jobId: 'job',
    stepId: 'step',
    attempt: 1,
    permissionPreset: 'none',
    totalTimeoutMs: 10_000,
    ...overrides,
  };
}
function host(
  close = (): Promise<void> => Promise.resolve(),
): OpenCodePromptHost {
  return {
    open: (signal) =>
      Promise.resolve({ executable: process.execPath, env: {}, signal, close }),
    authorize: () => Promise.resolve({ decision: 'allow' }),
  };
}
const successfulTurn = {
  sessionId: 'fixture-session',
  responseText: 'answer',
  isError: false,
  cancelled: false,
  message: '',
  usage: {
    input_tokens: 10,
    output_tokens: 2,
    reasoning_tokens: 0,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 1,
  },
};
const successfulUsageSnapshot = {
  input_tokens: 10,
  output_tokens: 2,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 1,
};
function snapshots(transcript: string): unknown[] {
  return transcript
    .split('\n')
    .filter((line) => line.includes('"type":"result"'))
    .map((line): unknown => JSON.parse(line));
}
test('startup failure preserves the provider error before any session exists', async () => {
  jest.mocked(runOpenCodeTurn).mockResolvedValue({
    responseText: '',
    isError: true,
    cancelled: false,
    message: '401 Unauthorized: invalid API key',
  });
  const result = await runOpenCodePipelinePrompt(request(), host());
  expect(result).toMatchObject({
    status: 'failure',
    failure: { message: '401 Unauthorized: invalid API key' },
  });
});
test.each(['metadata', 'cleanup'] as const)(
  'cancellation during %s cannot return success',
  async (phase) => {
    const controller = new AbortController();
    jest.mocked(runOpenCodeTurn).mockImplementation(() => {
      if (phase === 'metadata') controller.abort();
      return Promise.resolve(successfulTurn);
    });
    const result = await runOpenCodePipelinePrompt(
      request({ signal: controller.signal }),
      host(() => {
        if (phase === 'cleanup') controller.abort();
        return Promise.resolve();
      }),
    );
    expect(result).toMatchObject({
      status: 'cancelled',
      failure: { message: 'OpenCode workflow turn was cancelled.' },
    });
    expect(snapshots(result.transcript)).toEqual([
      expect.objectContaining({
        is_error: true,
        usage: successfulUsageSnapshot,
      }),
    ]);
  },
);
test('deadline expiring during runtime cleanup cannot return success', async () => {
  jest.useFakeTimers();
  try {
    jest.mocked(runOpenCodeTurn).mockResolvedValue(successfulTurn);
    const result = await runOpenCodePipelinePrompt(
      request({ totalTimeoutMs: 60_000 }),
      host(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      }),
    );
    expect(result).toMatchObject({
      status: 'failure',
      failure: { message: 'Step timed out after 1 minute(s)' },
    });
    expect(snapshots(result.transcript)).toEqual([
      expect.objectContaining({
        is_error: true,
        usage: successfulUsageSnapshot,
      }),
    ]);
  } finally {
    jest.useRealTimers();
  }
});
test.each(['error', 'cancelled', 'missing-session'] as const)(
  'usage from a retry ending in %s is retained',
  async (failure) => {
    jest
      .mocked(runOpenCodeTurn)
      .mockResolvedValueOnce({
        ...successfulTurn,
        responseText: 'invalid JSON',
      })
      .mockResolvedValueOnce({
        ...successfulTurn,
        isError: failure === 'error',
        cancelled: failure === 'cancelled',
        sessionId:
          failure === 'missing-session' ? undefined : successfulTurn.sessionId,
        message: 'Provider stopped.',
      });
    const result = await runOpenCodePipelinePrompt(
      request({ schema: { type: 'object' } }),
      host(),
    );
    expect(result.status).toBe('failure');
    expect(runOpenCodeTurn).toHaveBeenCalledTimes(2);
    expect(snapshots(result.transcript)).toEqual([
      expect.objectContaining({
        is_error: false,
        usage: successfulUsageSnapshot,
      }),
      expect.objectContaining({
        is_error: true,
        usage: {
          input_tokens: 20,
          output_tokens: 4,
          cache_read_input_tokens: 6,
          cache_creation_input_tokens: 2,
        },
      }),
    ]);
  },
);

test('cleanup failure retains consumed usage and does not close the runtime twice', async () => {
  jest.mocked(runOpenCodeTurn).mockResolvedValue(successfulTurn);
  const close = jest.fn(() =>
    Promise.reject(new Error('fixture close failed')),
  );
  const result = await runOpenCodePipelinePrompt(request(), host(close));
  expect(result).toMatchObject({
    status: 'failure',
    failure: { message: 'fixture close failed' },
  });
  expect(close).toHaveBeenCalledTimes(1);
  expect(snapshots(result.transcript)).toEqual([
    expect.objectContaining({ is_error: true, usage: successfulUsageSnapshot }),
  ]);
});

const selectedSkill = {
  collectionIds: [],
  pluginRefs: [],
  skillRefs: [{ sourceId: 'custom:app', skillName: 'pipeline-review' }],
};

test('a host without capability projection rejects selected capabilities before prompting', async () => {
  jest.mocked(runOpenCodeTurn).mockResolvedValue(successfulTurn);
  const result = await runOpenCodePipelinePrompt(
    request({ pluginSelections: selectedSkill }),
    host(),
  );
  expect(result.status).toBe('failure');
  if (result.status === 'failure')
    expect(result.failure.message).toMatch(/capabilit.*host|host.*capabilit/i);
  expect(runOpenCodeTurn).not.toHaveBeenCalled();
});

test('selected capabilities are recreated for each schema retry', async () => {
  const dispose = jest.fn();
  const prepareCapabilities = jest.fn(() =>
    Promise.resolve({
      capabilityRoots: [join(cwd, 'selected-capabilities')],
      capabilityContext: { skills: ['pipeline-review'] },
      instructions: 'Read the selected pipeline-review skill.',
      expandPrompt: (prompt: string) => `Expanded command: ${prompt}`,
      mcpServers: [],
      mcpSnapshot: [],
      warnings: ['Unavailable native plugin hook.'],
      dispose,
    }),
  );
  jest
    .mocked(runOpenCodeTurn)
    .mockResolvedValueOnce({ ...successfulTurn, responseText: 'invalid' })
    .mockResolvedValueOnce({ ...successfulTurn, responseText: '{}' });
  const runtimeHost = { ...host(), prepareCapabilities };
  const result = await runOpenCodePipelinePrompt(
    request({ pluginSelections: selectedSkill, schema: { type: 'object' } }),
    runtimeHost,
  );
  expect(result.status).toBe('success');
  expect(prepareCapabilities).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledTimes(2);
  const turns = jest.mocked(runOpenCodeTurn).mock.calls.map(([turn]) => turn);
  expect(turns).toHaveLength(2);
  for (const turn of turns) {
    expect(turn.capabilityRoots).toEqual([join(cwd, 'selected-capabilities')]);
    expect(turn.instructions).toContain(
      'Read the selected pipeline-review skill.',
    );
    expect(turn.capabilityContext).toMatchObject({
      selected: { skills: ['pipeline-review'] },
    });
  }
  expect(turns[0].prompt).toContain('Expanded command: Return an answer');
  expect(result.transcript).toContain('Unavailable native plugin hook.');
});

test('cancellation disposes capabilities that finish preparing after the step stops', async () => {
  const controller = new AbortController();
  const dispose = jest.fn();
  let release: (() => void) | undefined;
  const prepareCapabilities = jest.fn(
    () =>
      new Promise<{ dispose: () => void }>((resolve) => {
        release = (): void => resolve({ dispose });
        controller.abort();
      }),
  );
  jest.mocked(runOpenCodeTurn).mockResolvedValue(successfulTurn);
  const runtimeHost = { ...host(), prepareCapabilities };
  const result = await runOpenCodePipelinePrompt(
    request({ pluginSelections: selectedSkill, signal: controller.signal }),
    runtimeHost,
  );
  expect(result.status).toBe('cancelled');
  expect(runOpenCodeTurn).not.toHaveBeenCalled();
  release?.();
  await Promise.resolve();
  expect(dispose).toHaveBeenCalledTimes(1);
});

test('a schema retry can call selected MCP tools after the previous inference lease closes', async () => {
  let activeLease = new AbortController();
  const dispose = jest.fn();
  const runtimeHost: OpenCodePromptHost = {
    ...host(),
    open: (signal) => {
      activeLease = new AbortController();
      const lease = activeLease;
      return Promise.resolve({
        executable: process.execPath,
        env: {},
        signal: AbortSignal.any([signal, lease.signal]),
        close: () => {
          lease.abort();
          return Promise.resolve();
        },
      });
    },
    prepareCapabilities: () => {
      const lease = activeLease;
      return Promise.resolve({
        mcpSnapshot: [
          {
            name: 'selected',
            identity: 'fixture',
            tools: [{ name: 'files.read', inputSchema: { type: 'object' } }],
          },
        ],
        authorizeMcpTool: () =>
          Promise.resolve({
            decision: lease.signal.aborted ? 'deny' : 'allow',
          }),
        dispose,
      });
    },
  };
  let attempt = 0;
  jest.mocked(runOpenCodeTurn).mockImplementation(async (_turn, callbacks) => {
    const decision = await callbacks.authorize({
      sessionId: 'fixture-session',
      toolCallId: `call-${attempt}`,
      toolName: 'selected_files_read',
      toolArgs: {},
    });
    if (decision.decision !== 'allow')
      return {
        ...successfulTurn,
        isError: true,
        message: 'Selected MCP route was disposed.',
      };
    return {
      ...successfulTurn,
      responseText: attempt++ === 0 ? 'invalid' : '{"answer":"ok"}',
    };
  });
  const result = await runOpenCodePipelinePrompt(
    request({
      pluginSelections: selectedSkill,
      permissionPreset: 'dangerous_all',
      schema: { type: 'object' },
    }),
    runtimeHost,
  );
  expect(result).toMatchObject({
    status: 'success',
    structured: { answer: 'ok' },
  });
  expect(runOpenCodeTurn).toHaveBeenCalledTimes(2);
  expect(jest.mocked(runOpenCodeTurn).mock.calls[1]?.[0].prompt).toContain(
    'Response was not valid JSON.',
  );
  expect(dispose).toHaveBeenCalledTimes(2);
});

test.each(['none', 'read_only', 'plan', 'dangerous_all'] as const)(
  'selected MCP execution preserves the %s preset and the host policy',
  async (permissionPreset) => {
    const authorizeMcpTool = jest.fn<
      Promise<{ decision: 'allow' | 'deny' }>,
      []
    >(() => Promise.resolve({ decision: 'allow' }));
    const runtimeHost = {
      ...host(),
      prepareCapabilities: (): Promise<OpenCodePipelineCapabilities> =>
        Promise.resolve({
          mcpServers: [
            {
              type: 'http' as const,
              name: 'selected',
              url: 'http://localhost/mcp',
              headers: [],
            },
          ],
          mcpSnapshot: [
            {
              name: 'selected',
              identity: 'fixture',
              tools: [
                {
                  name: 'files.read',
                  inputSchema: { type: 'object' as const },
                },
              ],
            },
          ],
          authorizeMcpTool,
          dispose: jest.fn(),
        }),
    };
    jest
      .mocked(runOpenCodeTurn)
      .mockImplementation(async (_request, turnHost) => {
        const outcome = await turnHost.authorize({
          sessionId: 'fixture-session',
          toolCallId: 'selected-call',
          toolName: 'selected_files_read',
          toolArgs: {},
        });
        return { ...successfulTurn, responseText: outcome.decision };
      });
    const result = await runOpenCodePipelinePrompt(
      request({ pluginSelections: selectedSkill, permissionPreset }),
      runtimeHost,
    );
    expect(result).toMatchObject({
      status: 'success',
      rawText: permissionPreset === 'dangerous_all' ? 'allow' : 'deny',
    });
    expect(authorizeMcpTool).toHaveBeenCalledTimes(
      permissionPreset === 'dangerous_all' ? 1 : 0,
    );
    if (permissionPreset === 'dangerous_all') {
      authorizeMcpTool.mockResolvedValue({ decision: 'deny' });
      expect(
        await runOpenCodePipelinePrompt(
          request({ pluginSelections: selectedSkill, permissionPreset }),
          runtimeHost,
        ),
      ).toMatchObject({ status: 'success', rawText: 'deny' });
    }
  },
);

describe('explicit host inference', () => {
  const prepared = prepareOpenCodeInferenceRoute({
    bindingKey: 'b'.repeat(64),
    protocol: 'openai-responses',
    baseUrl: `http://127.0.0.1:43123/codex-gateway/${'a'.repeat(48)}`,
    headers: { 'x-canopy-work-owner': 'personal' },
    model: {
      id: 'vendor/model',
      contextWindow: 128000,
      outputLimit: 4096,
      supportsVision: false,
    },
  });
  const terminalError = Object.assign(
    new Error(
      JSON.stringify({
        error: {
          canopy_proxy: AI_CREDITS_PROXY_ERROR_MARKER,
          code: 'invalid_request',
          message: 'The host stopped this request.',
        },
      }),
    ),
    { api_error_status: 502 },
  );

  test.each([false, true])(
    'uses the trusted host route and closes it, failed=%s',
    async (failed) => {
      jest.mocked(runOpenCodeTurn).mockResolvedValue({
        sessionId: 'managed-session',
        responseText: 'Done',
        isError: failed,
        cancelled: false,
        message: failed ? 'ECONNRESET' : '',
      });
      const close = jest.fn(() => Promise.resolve());
      const failureError = jest.fn(() => terminalError);
      const host: OpenCodePromptHost = {
        open: (signal: AbortSignal) =>
          Promise.resolve({
            executable: process.execPath,
            env: {},
            signal,
            close,
            inferenceRoute: prepared.route,
            rawModelId: prepared.rawModelId,
            failureError,
            accountScope: 'ai_credits' as const,
          }),
        authorize: () => Promise.resolve({ decision: 'deny' as const }),
      };
      const result = await runOpenCodePipelinePrompt(
        {
          cwd,
          model: 'gateway-model',
          prompt: 'Hello',
          environment: {},
          executionsDir: join(cwd, 'executions'),
          executionId: 'managed',
          jobId: 'job',
          stepId: 'step',
          attempt: 1,
          permissionPreset: 'none',
          totalTimeoutMs: 10000,
        },
        host,
      );
      expect(runOpenCodeTurn).toHaveBeenCalledTimes(1);
      expect(jest.mocked(runOpenCodeTurn).mock.calls[0]?.[0]).toMatchObject({
        inferenceRoute: prepared.route,
        rawModelId: prepared.rawModelId,
        model: 'gateway-model',
      });
      expect(close).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(failed ? 'failure' : 'success');
      if (failed && result.status === 'failure') {
        expect(result.failure?.message).toContain(
          AI_CREDITS_PROXY_ERROR_MARKER,
        );
        expect(result.failure?.classification).toBeUndefined();
        expect(failureError).toHaveBeenCalledTimes(1);
        expect(failureError).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'ECONNRESET' }),
          false,
        );
      }
    },
  );
});

it('applies RTK to approved v2 shell calls in pipeline prompts', async () => {
  jest.mocked(runRtkRewrite).mockResolvedValueOnce('rtk git status');
  let outcome: unknown;
  jest
    .mocked(runOpenCodeTurn)
    .mockImplementationOnce(async (_request, turnHost) => {
      outcome = await turnHost.authorize({
        sessionId: 'fixture-session',
        toolCallId: 'shell',
        toolName: 'shell',
        toolArgs: { command: 'git status' },
      });
      return successfulTurn;
    });
  await runOpenCodePipelinePrompt(
    request({
      permissionPreset: 'dangerous_all',
      environment: { [brandEnvName('PREF_RTK_ENABLED')]: 'true' },
    }),
    host(),
  );
  expect(outcome).toEqual({
    decision: 'allow',
    updatedInput: { command: 'rtk git status' },
  });
});

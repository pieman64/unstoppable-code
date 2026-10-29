import type { CopilotToolMetadataRpc } from '../../copilot/tool-snapshot';
import { brandEnvName } from '../../../brand/env';
import { runRtkRewrite } from '../../rtk/rewrite';
jest.mock('../../rtk/rewrite', () => ({ runRtkRewrite: jest.fn() }));
import { CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS } from '../../../builtin-actions/agent-prompt/logic';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  CurrentToolMetadata,
  SessionConfig,
  SessionEvent,
} from '@github/copilot-sdk';
import type { OwnedCopilotRuntime } from '../../copilot/runtime';
import {
  runCopilotPipelinePrompt,
  type CopilotPromptHost,
  type CopilotPipelineCapabilities,
} from '../copilot-prompt-runner';

let root: string;
/** Per-test override of the status the fixture runtime reports for a server. */
let serverStatuses: Record<string, 'connected' | 'needs-auth' | 'failed'> = {};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'copilot-pipeline-test-'));
  serverStatuses = {};
  jest.mocked(runRtkRewrite).mockReset();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
interface FixtureSession {
  rpc: CopilotToolMetadataRpc;
  sessionId: string;
  send: (input: { prompt: string }) => Promise<string>;
}
function fixture(
  answers = ['done'],
  efforts = ['low', 'high'],
  onSend?: (
    config: SessionConfig,
    event: (type: string, data: unknown) => void,
  ) => Promise<void>,
): {
  host: jest.Mocked<CopilotPromptHost>;
  request: Parameters<typeof runCopilotPipelinePrompt>[0];
  configs: SessionConfig[];
  sends: string[];
  resumed: string[];
  metadata: jest.Mock<Promise<{ tools: CurrentToolMetadata[] | null }>, []>;
  account: { host: string; login: string };
} {
  const metadata = jest.fn<
    Promise<{ tools: CurrentToolMetadata[] | null }>,
    []
  >(() => Promise.resolve({ tools: [] }));
  let n = 0;
  const configs: SessionConfig[] = [];
  const sends: string[] = [];
  const resumed: string[] = [];
  const tokens: string[] = [];
  const account = { host: 'https://github.com', login: 'fixture' };
  const models = [
    {
      id: 'gpt-4.1',
      name: 'Fixture',
      policy: { state: 'enabled' },
      capabilities: { supports: { reasoningEffort: true } },
      supportedReasoningEfforts: efforts,
    },
  ];
  const tokenProvider = jest.fn(
    (): Promise<{ kind: 'token'; accessToken: string; expiresIn: number }> =>
      Promise.resolve({
        kind: 'token' as const,
        accessToken: 'ghu_fixture',
        expiresIn: 3600,
      }),
  );
  const host: jest.Mocked<CopilotPromptHost> = {
    authorize: jest.fn(),
    open: jest.fn(() => {
      let reap!: () => void;
      const exited = new Promise<void>((resolve) => {
        reap = resolve;
      });
      const create = (config: SessionConfig): Promise<FixtureSession> => {
        configs.push(config);
        return Promise.resolve({
          sessionId: 'conversation-1',
          rpc: {
            tools: {
              initializeAndValidate: () => Promise.resolve({}),
              getCurrentMetadata: metadata,
            },
            mcp: {
              list: () =>
                Promise.resolve({
                  servers: Object.keys(config.mcpServers ?? {}).map((name) => ({
                    name,
                    status: serverStatuses[name] ?? ('connected' as const),
                  })),
                }),
            },
          },
          send: async ({ prompt }: { prompt: string }): Promise<string> => {
            sends.push(prompt);
            const event = (type: string, data: unknown): void =>
              config.onEvent?.({
                id: String(++n),
                type,
                data,
                timestamp: '2026-09-29T00:00:00Z',
                parentId: null,
                ephemeral: false,
              } as SessionEvent);
            await onSend?.(config, event);
            event('assistant.message', {
              messageId: 'answer',
              content: answers.shift() ?? 'done',
            });
            event('assistant.usage', { inputTokens: 10, outputTokens: 2 });
            event('session.idle', {});
            return Promise.resolve('send');
          },
        });
      };
      return Promise.resolve({
        client: {
          listModels: () => Promise.resolve(models),
          rpc: {
            models: {
              list: (params: {
                gitHubToken?: string;
              }): Promise<{ models: typeof models }> => {
                tokens.push(params.gitHubToken ?? '');
                return Promise.resolve({ models });
              },
            },
          },
          createSession: create,
          resumeSession: async (id: string, config: SessionConfig) => {
            resumed.push(id);
            return create(config);
          },
        },
        close: jest.fn(() => {
          reap();
          return Promise.resolve();
        }),
        exited,
        account,
        auth: {
          token: (): Promise<string> => Promise.resolve('ghu_fixture'),
          tokenProvider,
        },
      } as unknown as OwnedCopilotRuntime & { account: typeof account });
    }),
  };
  const request = {
    cwd: root,
    prompt: 'Do it',
    environment: {},
    model: 'copilot:gpt-4.1',
    totalTimeoutMs: 1000,
    permissionPreset: 'read_only' as const,
    executionsDir: join(root, 'executions'),
    executionId: 'exec',
    jobId: 'job',
    stepId: 'step',
    attempt: 1,
  };
  return {
    host,
    request,
    configs,
    sends,
    resumed,
    metadata,
    account,
    tokens,
    tokenProvider,
  };
}

test('hands the host token to sessions and model discovery', async () => {
  const f = fixture(['done']);
  await runCopilotPipelinePrompt(
    { ...f.request, thinkingLevel: 'high' },
    f.host,
  );
  expect(f.configs[0].gitHubTokenProvider).toBe(f.tokenProvider);
  expect(f.tokens).toEqual(['ghu_fixture']);
});

test('projects host-selected skills and MCP into every schema retry and disposes once', async () => {
  const f = fixture(['invalid', '{"answer":"done"}']);
  const dispose = jest.fn(() => undefined);
  const mcpServers = {
    selected: {
      type: 'http' as const,
      url: 'http://localhost:1234/mcp',
      tools: ['*'],
    },
  };
  const prepareCapabilities = jest.fn(
    (): Promise<CopilotPipelineCapabilities> =>
      Promise.resolve({
        capabilitySnapshot: { version: 1, digest: 'a'.repeat(64) },
        skillDirectories: [join(root, 'selected-skills')],
        mcpServers,
        expandPrompt: (prompt: string): string => `Selected command: ${prompt}`,
        warnings: [],
        dispose,
      }),
  );
  const result = await runCopilotPipelinePrompt(
    {
      ...f.request,
      pluginSelections: {
        collectionIds: ['selected'],
        skillRefs: [],
        pluginRefs: [],
      },
      schema: {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
    },
    { ...f.host, prepareCapabilities },
  );
  expect(result.status).toBe('success');
  expect(prepareCapabilities).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(f.configs).toHaveLength(2);
  for (const config of f.configs)
    expect(config).toMatchObject({
      skillDirectories: [join(root, 'selected-skills')],
      enableSkills: true,
      mcpServers,
    });
  expect(f.sends[0]).toContain('Selected command: Do it');
});

test('prepares host inheritance when no plugin was explicitly selected', async () => {
  const f = fixture();
  const dispose = jest.fn();
  const prepareCapabilities = jest.fn(
    (): Promise<CopilotPipelineCapabilities> =>
      Promise.resolve({
        capabilitySnapshot: { version: 1, digest: 'a'.repeat(64) },
        skillDirectories: [join(root, 'home-skills')],
        expandPrompt: (prompt) => `Home command: ${prompt}`,
        dispose,
      }),
  );
  expect(
    await runCopilotPipelinePrompt(f.request, {
      ...f.host,
      prepareCapabilities,
    }),
  ).toMatchObject({ status: 'success' });
  expect(prepareCapabilities).toHaveBeenCalledTimes(1);
  expect(f.configs[0].skillDirectories).toEqual([join(root, 'home-skills')]);
  expect(f.sends).toEqual(['Home command: Do it']);
  expect(dispose).toHaveBeenCalledTimes(1);
});

test('rejects changed home inheritance on resume without explicit selections', async () => {
  const f = fixture();
  let digest = 'a'.repeat(64);
  const dispose = jest.fn();
  const host = {
    ...f.host,
    prepareCapabilities: (): Promise<CopilotPipelineCapabilities> =>
      Promise.resolve({
        capabilitySnapshot: { version: 1, digest },
        dispose,
      }),
  };
  expect(await runCopilotPipelinePrompt(f.request, host)).toMatchObject({
    status: 'success',
  });
  digest = 'b'.repeat(64);
  expect(
    await runCopilotPipelinePrompt(
      { ...f.request, resumeSessionId: 'conversation-1' },
      host,
    ),
  ).toMatchObject({ status: 'failure' });
  expect(f.resumed).toEqual([]);
  expect(f.sends).toHaveLength(1);
  expect(dispose).toHaveBeenCalledTimes(2);
});

test('fails by name when a selected MCP server needs sign-in', async () => {
  const f = fixture();
  serverStatuses.selected = 'needs-auth';
  const mcpServers = {
    selected: {
      type: 'http' as const,
      url: 'http://localhost:1234/mcp',
      tools: ['*'],
    },
  };
  const result = await runCopilotPipelinePrompt(
    {
      ...f.request,
      pluginSelections: {
        collectionIds: ['selected'],
        skillRefs: [],
        pluginRefs: [],
      },
    },
    {
      ...f.host,
      prepareCapabilities: () =>
        Promise.resolve({
          capabilitySnapshot: { version: 1, digest: 'a'.repeat(64) },
          skillDirectories: [],
          mcpServers,
          expandPrompt: (prompt: string): string => prompt,
          warnings: [],
          dispose: () => undefined,
        }),
    },
  );
  expect(result.status).toBe('failure');
  if (result.status === 'success') throw new Error('Expected a named failure');
  expect(result.failure.message).toBe(
    'Copilot could not connect to the MCP server "selected" (needs-auth). Connect or deselect it, then run again.',
  );
  expect(f.sends).toEqual([]);
});

test('selected capabilities fail explicitly when a host cannot project them', async () => {
  const f = fixture();
  const result = await runCopilotPipelinePrompt(
    {
      ...f.request,
      pluginSelections: {
        collectionIds: ['selected'],
        skillRefs: [],
        pluginRefs: [],
      },
    },
    f.host,
  );
  expect(result.status).toBe('failure');
  if (result.status === 'success')
    throw new Error('Expected capability rejection');
  expect(result.failure.message).toMatch(/capabilities/);
  expect(f.sends).toEqual([]);
});

test.each(
  (['none', 'read_only', 'plan', 'dangerous_all'] as const).flatMap((preset) =>
    (['allow', 'deny', 'missing'] as const).map((policy) => ({
      preset,
      policy,
    })),
  ),
)(
  'selected MCP respects pipeline preset $preset and shared policy $policy',
  async ({ preset, policy }) => {
    const authorizeMcpTool = jest.fn(() =>
      Promise.resolve({
        decision: policy === 'allow' ? ('allow' as const) : ('deny' as const),
      }),
    );
    const decisions: unknown[] = [];
    const f = fixture(['done'], [], async (config, event) => {
      const toolArgs = { value: 'write' };
      event('tool.execution_start', {
        toolName: 'selected-change',
        toolCallId: 'mcp-call',
        arguments: toolArgs,
        mcpConfigServerName: 'selected',
        mcpToolName: 'change',
      });
      const decision = await config.hooks?.onPreToolUse?.(
        {
          toolName: 'selected-change',
          toolArgs,
          timestamp: new Date(),
          workingDirectory: root,
          sessionId: 'conversation-1',
        },
        { sessionId: 'conversation-1' },
      );
      decisions.push(decision?.permissionDecision);
      event('tool.execution_complete', {
        toolCallId: 'mcp-call',
        success: decision?.permissionDecision === 'allow',
        result: { content: 'result' },
      });
    });
    const result = await runCopilotPipelinePrompt(
      {
        ...f.request,
        permissionPreset: preset,
        pluginSelections: {
          collectionIds: ['selected'],
          skillRefs: [],
          pluginRefs: [],
        },
      },
      {
        ...f.host,
        prepareCapabilities: (): Promise<CopilotPipelineCapabilities> =>
          Promise.resolve({
            capabilitySnapshot: { version: 1, digest: 'a'.repeat(64) },
            mcpServers: {
              selected: {
                type: 'http',
                url: 'http://localhost/mcp',
                tools: ['change'],
              },
            },
            ...(policy === 'missing' ? {} : { authorizeMcpTool }),
            dispose: (): void => undefined,
          }),
      },
    );
    expect(result.status).toBe('success');
    expect(decisions).toEqual([
      preset === 'dangerous_all' && policy === 'allow' ? 'allow' : 'deny',
    ]);
    if (preset === 'dangerous_all' && policy !== 'missing') {
      expect(authorizeMcpTool).toHaveBeenCalledWith({
        server: 'selected',
        tool: 'change',
        args: { value: 'write' },
      });
    } else {
      expect(authorizeMcpTool).not.toHaveBeenCalled();
    }
  },
);

test('resumes the same conversation across steps with complete policy and no billing fallback', async () => {
  const f = fixture();
  expect((await runCopilotPipelinePrompt(f.request, f.host)).status).toBe(
    'success',
  );
  const result = await runCopilotPipelinePrompt(
    { ...f.request, stepId: 'next', resumeSessionId: 'conversation-1' },
    f.host,
  );
  expect(result).toMatchObject({
    status: 'success',
    sessionId: 'conversation-1',
    usage: { inputTokens: 10, outputTokens: 2 },
  });
  expect(f.resumed).toEqual(['conversation-1']);
  expect(f.configs[1].configDirectory).toBe(f.configs[0].configDirectory);
  expect(f.configs[1]).toMatchObject({
    enableConfigDiscovery: false,
    enableFileHooks: false,
    mcpServers: {},
    tools: [],
  });
});

test('account or workspace changes reject resume before sending', async () => {
  const f = fixture();
  await runCopilotPipelinePrompt(f.request, f.host);
  f.account.login = 'different';
  const accountResult = await runCopilotPipelinePrompt(
    { ...f.request, resumeSessionId: 'conversation-1' },
    f.host,
  );
  expect(accountResult.status).toBe('failure');
  if (accountResult.status === 'success')
    throw new Error('Unexpected successful resume');
  expect(accountResult.failure.message).toContain('another account');
  const workspaceResult = await runCopilotPipelinePrompt(
    {
      ...f.request,
      cwd: join(root, 'other'),
      resumeSessionId: 'conversation-1',
    },
    f.host,
  );
  expect(workspaceResult.status).toBe('failure');
  if (workspaceResult.status === 'success')
    throw new Error('Unexpected successful resume');
  expect(workspaceResult.failure.message).toContain('workspace');
  expect(f.sends).toHaveLength(1);
});

function bindingPath(config: SessionConfig): string {
  if (!config.configDirectory) throw new Error('Expected session profile');
  const hash = createHash('sha256').update('conversation-1').digest('hex');
  return join(dirname(config.configDirectory), `${hash}.json`);
}

test('rejects a session from another execution before opening the runtime', async () => {
  const f = fixture();
  await runCopilotPipelinePrompt(f.request, f.host);
  const result = await runCopilotPipelinePrompt(
    { ...f.request, executionId: 'other', resumeSessionId: 'conversation-1' },
    f.host,
  );
  expect(result.status).toBe('failure');
  expect(f.host.open.mock.calls).toHaveLength(1);
  expect(f.sends).toHaveLength(1);
});

test('execution artifact cleanup removes the conversation profile and binding', async () => {
  const f = fixture();
  await runCopilotPipelinePrompt(f.request, f.host);
  const profile = f.configs[0].configDirectory;
  if (!profile) throw new Error('Expected session profile');
  const transcript = join(profile, 'transcript.json');
  await writeFile(transcript, 'sensitive conversation');
  await rm(join(f.request.executionsDir, f.request.executionId), {
    recursive: true,
    force: true,
  });
  await expect(access(transcript)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(bindingPath(f.configs[0]))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('writes a versioned session binding', async () => {
  const f = fixture();
  await runCopilotPipelinePrompt(f.request, f.host);
  const binding: unknown = JSON.parse(
    await readFile(bindingPath(f.configs[0]), 'utf8'),
  );
  expect(binding).toMatchObject({ version: 3, sessionId: 'conversation-1' });
});

test.each([
  { label: 'model', changes: { model: 'copilot:other-model' } },
  {
    label: 'permission preset',
    changes: { permissionPreset: 'dangerous_all' as const },
  },
  {
    label: 'instructions',
    changes: { systemPrompt: 'Different instructions' },
  },
])(
  'rejects changed $label before resuming a pipeline conversation',
  async ({ changes }) => {
    const f = fixture();
    expect(await runCopilotPipelinePrompt(f.request, f.host)).toMatchObject({
      status: 'success',
    });
    const result = await runCopilotPipelinePrompt(
      { ...f.request, ...changes, resumeSessionId: 'conversation-1' },
      f.host,
    );
    expect(result).toMatchObject({
      status: 'failure',
    });
    expect(result).toHaveProperty(
      'failure.message',
      expect.stringMatching(/capabilit|configuration/i),
    );
    expect(f.resumed).toEqual([]);
    expect(f.sends).toHaveLength(1);
  },
);

test('rejects changed materialized pipeline capabilities before a resumed send', async () => {
  const f = fixture();
  let capabilityDigest = 'a'.repeat(64);
  const dispose = jest.fn();
  const host = {
    ...f.host,
    prepareCapabilities: (): Promise<CopilotPipelineCapabilities> =>
      Promise.resolve({
        capabilitySnapshot: { version: 1 as const, digest: capabilityDigest },
        dispose,
      }),
  };
  const selected = {
    ...f.request,
    pluginSelections: {
      collectionIds: ['selected'],
      skillRefs: [],
      pluginRefs: [],
    },
  };
  expect(await runCopilotPipelinePrompt(selected, host)).toMatchObject({
    status: 'success',
  });
  capabilityDigest = 'b'.repeat(64);
  expect(
    await runCopilotPipelinePrompt(
      { ...selected, resumeSessionId: 'conversation-1' },
      host,
    ),
  ).toMatchObject({
    status: 'failure',
  });
  expect(f.resumed).toEqual([]);
  expect(f.sends).toHaveLength(1);
  expect(dispose).toHaveBeenCalledTimes(2);
});

test('persists capability identity without persisting pipeline instructions', async () => {
  const f = fixture();
  expect(
    await runCopilotPipelinePrompt(
      {
        ...f.request,
        systemPrompt: 'private instruction contents',
      },
      f.host,
    ),
  ).toMatchObject({ status: 'success' });
  const contents = await readFile(bindingPath(f.configs[0]), 'utf8');
  const binding: unknown = JSON.parse(contents);
  expect(binding).toMatchObject({
    capabilitySnapshot: {
      version: 1,
    },
  });
  expect(binding).toHaveProperty(
    'capabilitySnapshot.digest',
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
  expect(contents).not.toContain('private instruction contents');
});

test.each([
  { version: 1 },
  { version: 2 },
  { nativeToolSnapshot: undefined },
  { nativeToolSnapshot: { version: 1, digest: 'bad' } },
  { version: 99 },
  { capabilitySnapshot: undefined },
  { capabilitySnapshot: { version: 2, digest: 'a'.repeat(64) } },
  { capabilitySnapshot: { version: 1, digest: 'malformed' } },
  { runtimeVersion: undefined },
  { runtimeVersion: '0.0.0' },
])('rejects an unverifiable pipeline binding: %j', async (changes) => {
  const f = fixture();
  await runCopilotPipelinePrompt(f.request, f.host);
  const file = bindingPath(f.configs[0]);
  const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!saved || typeof saved !== 'object') throw new Error('Expected binding');
  await writeFile(file, JSON.stringify({ ...saved, ...changes }));
  const previous = await readFile(file, 'utf8');
  expect(
    await runCopilotPipelinePrompt(
      { ...f.request, resumeSessionId: 'conversation-1' },
      f.host,
    ),
  ).toMatchObject({ status: 'failure' });
  expect(f.host.open.mock.calls).toHaveLength(1);
  expect(f.resumed).toEqual([]);
  expect(await readFile(file, 'utf8')).toBe(previous);
});

test('credential rotation does not change the pipeline instruction identity', async () => {
  const f = fixture();
  const initial = {
    ...f.request,
    systemPrompt: 'Credential: old-private-token',
    secretValues: ['old-private-token'],
  };
  expect(await runCopilotPipelinePrompt(initial, f.host)).toMatchObject({
    status: 'success',
  });
  const contents = await readFile(bindingPath(f.configs[0]), 'utf8');
  expect(
    await runCopilotPipelinePrompt(
      {
        ...initial,
        systemPrompt: 'Credential: new-private-token',
        secretValues: ['new-private-token'],
        resumeSessionId: 'conversation-1',
      },
      f.host,
    ),
  ).toMatchObject({ status: 'success' });
  expect(await readFile(bindingPath(f.configs[0]), 'utf8')).toBe(contents);
  expect(contents).not.toContain('private-token');
});

test.each([undefined, 99])(
  'rejects binding version %s without resuming',
  async (version) => {
    const f = fixture();
    await runCopilotPipelinePrompt(f.request, f.host);
    const file = bindingPath(f.configs[0]);
    const binding: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!binding || typeof binding !== 'object')
      throw new Error('Expected binding');
    await writeFile(file, JSON.stringify({ ...binding, version }));
    const result = await runCopilotPipelinePrompt(
      { ...f.request, resumeSessionId: 'conversation-1' },
      f.host,
    );
    expect(result.status).toBe('failure');
    expect(f.resumed).toEqual([]);
    expect(f.host.open.mock.calls).toHaveLength(1);
  },
);

test('rejects execution identifiers that escape the artifact directory', async () => {
  const f = fixture();
  const result = await runCopilotPipelinePrompt(
    { ...f.request, executionId: '../other' },
    f.host,
  );
  expect(result.status).toBe('failure');
  expect(f.host.open.mock.calls).toHaveLength(0);
});

test.each(['off', 'ultra'] as const)(
  'omits SDK-unsupported thinking level %s',
  async (thinkingLevel) => {
    const f = fixture(['done'], ['none', 'ultra']);
    const result = await runCopilotPipelinePrompt(
      { ...f.request, thinkingLevel },
      f.host,
    );
    expect(result.status).toBe('success');
    expect(f.configs[0].reasoningEffort).toBeUndefined();
  },
);

test('schema retries retain session, preserve paid usage, and mask outputs', async () => {
  const f = fixture(['invalid secret-value', '{"answer":"secret-value"}']);
  const result = await runCopilotPipelinePrompt(
    {
      ...f.request,
      schema: {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
      secretValues: ['secret-value'],
    },
    f.host,
  );
  expect(result).toMatchObject({
    status: 'success',
    structured: { answer: '***' },
    usage: { inputTokens: 20, outputTokens: 4 },
  });
  expect(JSON.stringify(result)).not.toContain('secret-value');
  expect(f.resumed).toEqual(['conversation-1']);
  expect(f.sends[1]).not.toContain('secret-value');
});

test('timeout bounds a stalled setup and closes a late runtime', async () => {
  const f = fixture();
  let release!: (value: Awaited<ReturnType<CopilotPromptHost['open']>>) => void;
  const runtime = await f.host.open(new AbortController().signal);
  const pending = new Promise<Awaited<ReturnType<CopilotPromptHost['open']>>>(
    (resolve) => {
      release = resolve;
    },
  );
  let opened!: () => void;
  const openCalled = new Promise<void>((resolve) => {
    opened = resolve;
  });
  f.host.open = (): ReturnType<CopilotPromptHost['open']> => {
    opened();
    return pending;
  };
  // Elapse the deadline only once setup reaches `open`; a real 10ms timer can
  // fire during the setup filesystem work on a loaded runner, before `open`.
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
  });
  let result: Awaited<ReturnType<typeof runCopilotPipelinePrompt>>;
  try {
    const running = runCopilotPipelinePrompt(
      { ...f.request, totalTimeoutMs: 10 },
      f.host,
    );
    await openCalled;
    jest.advanceTimersByTime(10);
    result = await running;
  } finally {
    jest.useRealTimers();
  }
  expect(result.status).toBe('failure');
  if (result.status === 'success')
    throw new Error('Unexpected successful setup');
  expect(result.failure.message).toContain('timed out');
  expect(result.failure.had_agent_activity).toBe(false);
  const closeRuntime = runtime.close.bind(runtime);
  const close = jest.fn(() => closeRuntime());
  release({ ...runtime, close });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(close).toHaveBeenCalled();
});

test.each(['cancel', 'timeout'])(
  '%s during capability preparation cannot send and disposes late proxy routes',
  async (reason) => {
    const f = fixture();
    const abort = new AbortController();
    const dispose = jest.fn(() => undefined);
    let release!: (value: CopilotPipelineCapabilities) => void;
    const pending = new Promise<CopilotPipelineCapabilities>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const preparing = new Promise<void>((resolve) => {
      started = resolve;
    });
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    try {
      const running = runCopilotPipelinePrompt(
        {
          ...f.request,
          totalTimeoutMs: 10,
          signal: abort.signal,
          pluginSelections: {
            collectionIds: ['selected'],
            skillRefs: [],
            pluginRefs: [],
          },
        },
        {
          ...f.host,
          prepareCapabilities: () => {
            started();
            return pending;
          },
        },
      );
      await preparing;
      if (reason === 'cancel') abort.abort();
      else jest.advanceTimersByTime(10);
      const result = await running;
      expect(result.status).toBe(reason === 'cancel' ? 'cancelled' : 'failure');
      expect(f.configs).toEqual([]);
      expect(f.sends).toEqual([]);
      release({
        dispose,
        capabilitySnapshot: { version: 1, digest: 'a'.repeat(64) },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  },
);

test('uses the complete retry budget and retains paid usage when schema retries fail', async () => {
  const f = fixture(['invalid', 'invalid', 'invalid', 'invalid']);
  const result = await runCopilotPipelinePrompt(
    {
      ...f.request,
      schema: {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
    },
    f.host,
  );
  expect(result.status).toBe('failure');
  expect(f.sends).toHaveLength(CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS + 1);
  const paid = result.transcript
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as { type: string; usage?: { input_tokens: number } },
    )
    .filter((event) => event.type === 'result')
    .reduce((sum, event) => sum + (event.usage?.input_tokens ?? 0), 0);
  expect(paid).toBe(10 * (CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS + 1));
});

test('RTK only rewrites a shell command after the pipeline preset authorizes it', async () => {
  jest.mocked(runRtkRewrite).mockResolvedValue('rtk git status');
  for (const preset of ['read_only', 'dangerous_all'] as const) {
    let result: unknown;
    const f = fixture(['done'], [], async (config, event) => {
      event('tool.execution_start', {
        toolCallId: 'shell',
        toolName: 'bash',
        arguments: { command: 'git status', description: 'Check status' },
      });
      result = await config.hooks?.onPreToolUse?.(
        {
          sessionId: 'conversation-1',
          timestamp: new Date(0),
          workingDirectory: root,
          toolName: 'bash',
          toolArgs: { command: 'git status', description: 'Check status' },
        },
        { sessionId: 'conversation-1' },
      );
    });
    await runCopilotPipelinePrompt(
      {
        ...f.request,
        permissionPreset: preset,
        environment: { [brandEnvName('PREF_RTK_ENABLED')]: 'true' },
      },
      f.host,
    );
    if (preset === 'read_only') {
      expect(result).toMatchObject({ permissionDecision: 'deny' });
      expect(runRtkRewrite).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({
        permissionDecision: 'allow',
        modifiedArgs: {
          command: 'rtk git status',
          description: 'Check status',
        },
      });
      expect(runRtkRewrite).toHaveBeenCalledTimes(1);
    }
  }
});

test('pipeline thinking stays within the selected account model capabilities', async () => {
  const f = fixture();
  expect(
    (
      await runCopilotPipelinePrompt(
        { ...f.request, thinkingLevel: 'max' },
        f.host,
      )
    ).status,
  ).toBe('success');
  expect(f.configs[0].reasoningEffort).toBe('high');
});

test('pipeline persists the initialized native table before publishing the session', async () => {
  const f = fixture();
  expect(await runCopilotPipelinePrompt(f.request, f.host)).toMatchObject({
    status: 'success',
  });
  expect(f.metadata).toHaveBeenCalledTimes(1);
  const saved = await readFile(bindingPath(f.configs[0]), 'utf8');
  expect(JSON.parse(saved)).toHaveProperty(
    'nativeToolSnapshot.digest',
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
});

test('pipeline rejects changed native MCP schema before resumed send and preserves the binding', async () => {
  const f = fixture();
  const metadata: CurrentToolMetadata = {
    name: 'selected-read',
    mcpServerName: 'selected',
    mcpToolName: 'read',
    description: 'Read evidence',
    input_schema: { type: 'object', properties: { value: { type: 'string' } } },
  };
  f.metadata.mockResolvedValue({ tools: [metadata] });
  const host = {
    ...f.host,
    prepareCapabilities: (): Promise<CopilotPipelineCapabilities> =>
      Promise.resolve({
        capabilitySnapshot: { version: 1, digest: 'a'.repeat(64) },
        mcpServers: {
          selected: {
            type: 'http',
            url: 'http://localhost/selected',
            tools: ['*'],
          },
        },
        dispose: () => undefined,
      }),
  };
  const request = {
    ...f.request,
    pluginSelections: {
      collectionIds: ['selected'],
      skillRefs: [],
      pluginRefs: [],
    },
  };
  expect(await runCopilotPipelinePrompt(request, host)).toMatchObject({
    status: 'success',
  });
  const saved = await readFile(bindingPath(f.configs[0]), 'utf8');
  expect(saved).not.toContain('Read evidence');
  f.metadata.mockResolvedValue({
    tools: [
      {
        ...metadata,
        input_schema: {
          type: 'object',
          properties: { value: { type: 'number' } },
        },
      },
    ],
  });
  const resumed = await runCopilotPipelinePrompt(
    { ...request, resumeSessionId: 'conversation-1' },
    host,
  );
  expect(resumed).toMatchObject({ status: 'failure' });
  expect(resumed).toHaveProperty(
    'failure.message',
    expect.stringMatching(/tool.*changed|configuration/i),
  );
  expect(f.sends).toHaveLength(1);
  expect(await readFile(bindingPath(f.configs[0]), 'utf8')).toBe(saved);
});

test('pipeline never publishes or sends with uninitialized native metadata', async () => {
  const f = fixture();
  f.metadata.mockResolvedValue({ tools: null });
  const result = await runCopilotPipelinePrompt(f.request, f.host);
  expect(result).toMatchObject({ status: 'failure' });
  expect(f.sends).toEqual([]);
  await expect(access(bindingPath(f.configs[0]))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('pipeline cancellation during native metadata cannot publish a binding or send', async () => {
  const f = fixture();
  const abort = new AbortController();
  f.metadata.mockImplementation(() => {
    abort.abort();
    return Promise.resolve({ tools: [] });
  });
  const result = await runCopilotPipelinePrompt(
    { ...f.request, signal: abort.signal },
    f.host,
  );
  expect(result).toMatchObject({ status: 'cancelled' });
  expect(f.sends).toEqual([]);
  await expect(access(bindingPath(f.configs[0]))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('pipeline rechecks host authority after native metadata and before publishing', async () => {
  const f = fixture();
  f.metadata.mockImplementation(() => {
    f.host.authorize.mockImplementation(() => {
      throw new Error('Selected account changed');
    });
    return Promise.resolve({ tools: [] });
  });
  expect(await runCopilotPipelinePrompt(f.request, f.host)).toMatchObject({
    status: 'failure',
    failure: { message: 'Selected account changed' },
  });
  expect(f.sends).toEqual([]);
  await expect(access(bindingPath(f.configs[0]))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

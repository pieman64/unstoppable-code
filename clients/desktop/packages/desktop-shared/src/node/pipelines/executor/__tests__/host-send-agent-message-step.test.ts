import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CLAUDE_MODEL } from '@canopy/desktop-shared/types';
import { SEND_AGENT_MESSAGE_TEXT_FILE_MAX_BYTES } from '@canopy/desktop-shared/pipelines/host-send-agent-message';
import type {
  NormalizedStep,
  PipelineChatSendRecord,
  PipelineExecutionInitiator,
  PipelineModelAlias,
  PipelineModelAliasPreference,
} from '@canopy/desktop-shared/types/pipeline';
import { resolveHostStepModel, runStep } from '../step-runner';
import type {
  ExecutionRuntime,
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionRequest,
  PipelineHostActionResult,
  PipelineHostActions,
} from '../types';

const MANIFEST = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../../../../resources/actions/send-agent-message/action.yml',
  ),
  'utf8',
);

const SECRET_TEXT = 'SENTINEL-TEXT-5d1e';
const SECRET_NAME = 'SENTINEL-NAME-c4f0';

const EMPTY_OUTPUTS = {
  chat_id: '',
  state: '',
  project_id: '',
  bot_id: '',
  task_id: '',
  chat_created: 'false',
  message_id: '',
  queued_message_id: '',
  turn_id: '',
  accepted_at: '',
  steer_unavailable_reason: '',
};

const RECORD: PipelineChatSendRecord = {
  version: 1,
  address: { kind: 'project', projectId: 'p', taskId: 't', chatId: 'c' },
  userMessageId: 'u-1',
  state: 'sent',
  chatCreated: false,
  acceptedAt: '2026-10-28T00:00:00.000Z',
};

interface Call {
  request: PipelineHostActionRequest;
  caller: PipelineHostActionCaller;
  controls?: PipelineHostActionControls;
}

function port(
  respond: (call: Call) => Promise<PipelineHostActionResult>,
): PipelineHostActions & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: (
      request,
      caller,
      _signal,
      controls,
    ): Promise<PipelineHostActionResult> => {
      const call = { request, caller, ...(controls ? { controls } : {}) };
      calls.push(call);
      return respond(call);
    },
  };
}

function step(inputs: Record<string, string>): NormalizedStep {
  return {
    id: 'send',
    shell: 'bash',
    continue_on_error: false,
    timeout_minutes: 1,
    skip_on_missing_action: false,
    uses: 'builtin/send-agent-message',
    with: inputs,
  };
}

const base = { project_id: 'p', task_id: 't', chat_id: 'c' };

describe('send-agent-message host step', () => {
  let tempDir: string;
  let workDir: string;
  let runtime: ExecutionRuntime;
  let blockedProbe: jest.Mock<Promise<boolean>, [string, ...unknown[]]>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-host-send-'));
    workDir = path.join(tempDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });
    blockedProbe = jest.fn<Promise<boolean>, [string, ...unknown[]]>(() =>
      Promise.resolve(false),
    );
    runtime = {
      isModelBlockedByOrgPolicy: blockedProbe,
      isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(true),
      executionsDir: path.join(tempDir, 'executions'),
      tempRootDir: path.join(tempDir, 'tmp'),
      bundledActionsDir: path.join(tempDir, 'actions'),
      getProjectActionsDir: (repoPath: string): string =>
        path.join(repoPath, '.canopy', 'actions'),
      getProjectPipelinesDir: (repoPath: string): string =>
        path.join(repoPath, '.canopy', 'pipelines'),
    };
    const actionDir = path.join(
      runtime.bundledActionsDir,
      'send-agent-message',
    );
    fs.mkdirSync(actionDir, { recursive: true });
    fs.writeFileSync(path.join(actionDir, 'action.yml'), MANIFEST, 'utf8');
  });

  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(
    inputs: Record<string, string>,
    extra: {
      initiator?: PipelineExecutionInitiator;
      pipelineName?: string;
      modelAliases?: readonly PipelineModelAlias[];
      modelAliasPreferences?: Record<string, PipelineModelAliasPreference>;
    } = {},
  ): ReturnType<typeof runStep> {
    return runStep({
      executionId: 'exec-1',
      jobId: 'job-a',
      step: step(inputs),
      cwd: workDir,
      env: {},
      runtime,
      signal: new AbortController().signal,
      attempt: 0,
      iteration: 0,
      pipelineId: 'pipe-1',
      agentOrigin: { projectId: 'ap', worktreeId: 'aw', chatId: 'ac' },
      ...extra,
    });
  }

  const ok = (): Promise<PipelineHostActionResult> =>
    Promise.resolve({ status: 'success', outputs: {} });

  function onlyRequest(
    host: PipelineHostActions & { calls: Call[] },
  ): PipelineHostActionRequest {
    expect(host.calls).toHaveLength(1);
    const [call] = host.calls;
    if (!call) throw new Error('no host call');
    return call.request;
  }

  async function refusal(
    inputs: Record<string, string>,
  ): Promise<{ error: string | undefined; reason: string | undefined }> {
    const host = port(ok);
    runtime.pipelineHostActions = host;
    const result = await run(inputs);
    expect(host.calls).toHaveLength(0);
    expect(result.status).toBe('failure');
    expect(result.outputs).toEqual({
      ...EMPTY_OUTPUTS,
      failure_reason: result.outputs.failure_reason,
    });
    return { error: result.error, reason: result.outputs.failure_reason };
  }

  it('raises the parsed request with the trusted caller fields', async () => {
    const host = port(ok);
    runtime.pipelineHostActions = host;
    const initiator: PipelineExecutionInitiator = {
      kind: 'automation',
      automationId: 'auto-1',
      automationName: SECRET_NAME,
    };

    await run(
      {
        ...base,
        text: SECRET_TEXT,
        mode: 'steer',
        initiator: 'user',
        pipeline_name: 'spoofed',
        agent_origin: 'spoofed',
      },
      { initiator, pipelineName: SECRET_NAME },
    );

    const [call] = host.calls;
    expect(call?.request).toEqual({
      action: 'send-agent-message',
      inputs: {
        target: { kind: 'project', projectId: 'p', taskId: 't', chatId: 'c' },
        text: SECRET_TEXT,
        mode: 'steer',
        settings: {},
      },
    });
    expect(call?.caller.initiator).toEqual(initiator);
    expect(call?.caller.pipelineName).toBe(SECRET_NAME);
    expect(call?.caller.agentOrigin).toEqual({
      projectId: 'ap',
      worktreeId: 'aw',
      chatId: 'ac',
    });
  });

  it('fails with needs_desktop and every output without a port', async () => {
    const result = await run({ ...base, text: 'hi' });

    expect(result.status).toBe('failure');
    expect(result.outputs).toEqual({
      ...EMPTY_OUTPUTS,
      failure_reason: 'needs_desktop',
    });
  });

  describe('text_file', () => {
    it('reads the file relative to the working folder', async () => {
      fs.mkdirSync(path.join(workDir, 'notes'));
      fs.writeFileSync(path.join(workDir, 'notes', 'msg.md'), 'Read @a.md');
      const host = port(ok);
      runtime.pipelineHostActions = host;

      await run({
        project_id: 'p',
        task_id: 't',
        text_file: 'notes/msg.md',
        text_references: JSON.stringify([
          {
            kind: 'file',
            textStart: 5,
            displayText: '@a.md',
            root: { kind: 'workspace' },
            relativePath: 'a.md',
          },
        ]),
      });

      const request = onlyRequest(host);
      expect(
        request.action === 'send-agent-message' && request.inputs.text,
      ).toBe('Read @a.md');
    });

    it('allows a symlink that stays inside the working folder', async () => {
      fs.writeFileSync(path.join(workDir, 'real.txt'), 'hello');
      fs.symlinkSync(
        path.join(workDir, 'real.txt'),
        path.join(workDir, 'link.txt'),
      );
      const host = port(ok);
      runtime.pipelineHostActions = host;

      await run({ project_id: 'p', task_id: 't', text_file: 'link.txt' });

      const request = onlyRequest(host);
      expect(
        request.action === 'send-agent-message' && request.inputs.text,
      ).toBe('hello');
    });

    it('checks text_references against the file text', async () => {
      fs.writeFileSync(path.join(workDir, 'msg.txt'), `${SECRET_TEXT} body`);
      const { error, reason } = await refusal({
        project_id: 'p',
        task_id: 't',
        text_file: 'msg.txt',
        text_references: JSON.stringify([
          {
            kind: 'file',
            textStart: 0,
            displayText: '@nope',
            root: { kind: 'workspace' },
            relativePath: 'nope',
          },
        ]),
      });
      expect(reason).toBe('validation_failed');
      expect(error).toContain('"text_references"');
      expect(error).not.toContain(SECRET_TEXT);
    });

    const outside = (): string => {
      const dir = path.join(tempDir, 'outside');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${SECRET_NAME}.txt`);
      fs.writeFileSync(file, SECRET_TEXT);
      return file;
    };

    it.each<[string, () => string]>([
      ['a missing file', (): string => 'missing.txt'],
      [
        'a whitespace-only file',
        (): string => {
          fs.writeFileSync(path.join(workDir, 'blank.txt'), ' \n\t');
          return 'blank.txt';
        },
      ],
      [
        'a file that is not UTF-8',
        (): string => {
          fs.writeFileSync(
            path.join(workDir, 'bin.txt'),
            Buffer.from([0x68, 0xff, 0xfe]),
          );
          return 'bin.txt';
        },
      ],
      [
        'a file over the cap',
        (): string => {
          fs.writeFileSync(
            path.join(workDir, 'big.txt'),
            'a'.repeat(SEND_AGENT_MESSAGE_TEXT_FILE_MAX_BYTES + 1),
          );
          return 'big.txt';
        },
      ],
      [
        'a directory',
        (): string => {
          fs.mkdirSync(path.join(workDir, 'dir'));
          return 'dir';
        },
      ],
      ['the working folder itself', (): string => '.'],
      [
        'a path with ..',
        (): string => `../outside/${path.basename(outside())}`,
      ],
      ['an absolute path outside', (): string => outside()],
      [
        'a symlink pointing outside',
        (): string => {
          fs.symlinkSync(outside(), path.join(workDir, 'escape.txt'));
          return 'escape.txt';
        },
      ],
    ])(
      'refuses %s without naming the path or content',
      async (_label, make) => {
        const { error, reason } = await refusal({
          project_id: 'p',
          task_id: 't',
          text_file: make(),
        });
        expect(reason).toBe('validation_failed');
        expect(error).toContain('"text_file"');
        expect(error).not.toContain(SECRET_NAME);
        expect(error).not.toContain(SECRET_TEXT);
        expect(error).not.toContain(tempDir);
      },
    );

    it('accepts a file exactly at the cap', async () => {
      fs.writeFileSync(
        path.join(workDir, 'cap.txt'),
        'a'.repeat(SEND_AGENT_MESSAGE_TEXT_FILE_MAX_BYTES),
      );
      const host = port(ok);
      runtime.pipelineHostActions = host;

      const result = await run({
        project_id: 'p',
        task_id: 't',
        text_file: 'cap.txt',
      });

      expect(result.status).toBe('success');
      expect(host.calls).toHaveLength(1);
    });
  });

  describe('attachments', () => {
    it('passes absolute realpaths inside the working folder', async () => {
      fs.writeFileSync(path.join(workDir, 'a.txt'), 'a');
      const host = port(ok);
      runtime.pipelineHostActions = host;

      await run({ ...base, text: 'hi', attachments: '["a.txt"]' });
      await run({ ...base, text: 'hi', attachments: '["a.txt"]' });

      const [first, second] = host.calls;
      expect(
        first?.request.action === 'send-agent-message' &&
          first.request.inputs.attachments,
      ).toEqual([fs.realpathSync(path.join(workDir, 'a.txt'))]);
      // Same working folder, same request: a replay fingerprints equal.
      expect(second?.request).toEqual(first?.request);
    });

    it('refuses a path outside the working folder', async () => {
      const dir = path.join(tempDir, 'outside');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, `${SECRET_NAME}.txt`), 'x');

      const { error, reason } = await refusal({
        ...base,
        text: 'hi',
        attachments: JSON.stringify([`../outside/${SECRET_NAME}.txt`]),
      });

      expect(reason).toBe('validation_failed');
      expect(error).toContain('"attachments"');
      expect(error).not.toContain(SECRET_NAME);
    });
  });

  describe('model', () => {
    const aliases: PipelineModelAlias[] = [
      { id: 'reviewer', name: 'Reviewer', defaults: { base: 'opus' } },
      {
        id: 'coach',
        name: 'Coach',
        defaults: { base: 'opus', instructions: 'Be kind.' },
      },
    ];

    it('resolves a pipeline alias before raising the request', async () => {
      const host = port(ok);
      runtime.pipelineHostActions = host;

      await run(
        { ...base, chat_id: '', text: 'hi', model: 'reviewer' },
        { modelAliases: aliases },
      );

      const request = onlyRequest(host);
      expect(
        request.action === 'send-agent-message' &&
          request.inputs.settings.model,
      ).toBe('opus');
    });

    it('refuses an alias that carries instructions with validation_failed', async () => {
      const host = port(ok);
      runtime.pipelineHostActions = host;

      const result = await run(
        { ...base, chat_id: '', text: 'hi', model: 'coach' },
        { modelAliases: aliases },
      );

      expect(host.calls).toHaveLength(0);
      expect(result.outputs.failure_reason).toBe('validation_failed');
      expect(result.error).toBe(
        'Model alias "coach" sets instructions or plugins, which a chat message can\'t carry.',
      );
    });

    it('probes a named model against the org policy', async () => {
      runtime.pipelineHostActions = port(ok);

      await run(
        { ...base, chat_id: '', text: 'hi', model: 'reviewer' },
        { modelAliases: aliases },
      );

      expect(blockedProbe.mock.calls.map(([model]) => model)).toEqual(['opus']);
    });

    it('does not probe the provider default when no model is named', async () => {
      runtime.pipelineHostActions = port(ok);

      const result = await run({ ...base, text: 'hi' });

      expect(result.status).toBe('success');
      expect(blockedProbe.mock.calls.map(([model]) => model)).not.toContain(
        DEFAULT_CLAUDE_MODEL,
      );
      expect(blockedProbe).not.toHaveBeenCalled();
    });
  });

  describe('chat_send', () => {
    it('records the send on a success', async () => {
      runtime.pipelineHostActions = port(() =>
        Promise.resolve({ status: 'success', outputs: {}, chatSend: RECORD }),
      );

      const result = await run({ ...base, text: 'hi' });

      expect(result.status).toBe('success');
      expect(result.chat_send).toEqual(RECORD);
    });

    it('records the send on a failure that follows acceptance', async () => {
      runtime.pipelineHostActions = port(() =>
        Promise.resolve({
          status: 'failure',
          failureReason: 'not_found',
          error: 'Chat `c` was not found.',
          outputs: { ...EMPTY_OUTPUTS, chat_id: 'c', state: 'queued' },
          chatSend: { ...RECORD, state: 'queued', queuedMessageId: 'q-1' },
        }),
      );

      const result = await run({ ...base, text: 'hi', mode: 'steer' });

      expect(result.status).toBe('failure');
      expect(result.outputs.failure_reason).toBe('not_found');
      expect(result.outputs.state).toBe('queued');
      expect(result.chat_send).toEqual({
        ...RECORD,
        state: 'queued',
        queuedMessageId: 'q-1',
      });
    });

    it('never sets chat_send without a record', async () => {
      runtime.pipelineHostActions = port(ok);

      const result = await run({ ...base, text: 'hi' });

      expect(result).not.toHaveProperty('chat_send');
    });

    it('fails the step with no failure_reason on a malformed record', async () => {
      runtime.pipelineHostActions = port(() =>
        Promise.resolve({
          status: 'success',
          outputs: {},
          chatSend: { ...RECORD, state: 'delivered' },
        } as unknown as PipelineHostActionResult),
      );

      const result = await run({ ...base, text: 'hi' });

      expect(result.status).toBe('failure');
      expect(result.error).toBe(
        'The desktop app returned an invalid send receipt.',
      );
      expect(result.outputs).toEqual({});
      expect(result).not.toHaveProperty('chat_send');
    });

    it('copies the record from a timeout finalizer', async () => {
      jest.useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
      });
      let markCalled: () => void = () => undefined;
      const called = new Promise<void>((resolve) => {
        markCalled = resolve;
      });
      runtime.pipelineHostActions = port((call) => {
        call.controls?.registerTimeoutFinalizer(() =>
          Promise.resolve({
            status: 'success',
            outputs: { state: 'sent' },
            chatSend: RECORD,
          }),
        );
        markCalled();
        return new Promise<PipelineHostActionResult>(() => undefined);
      });

      const pending = run({ ...base, text: 'hi' });
      await called;
      jest.advanceTimersByTime(60_000);
      const result = await pending;

      expect(result.status).toBe('success');
      expect(result.outputs).toEqual({ state: 'sent', failure_reason: '' });
      expect(result.chat_send).toEqual(RECORD);
    });
  });
});

describe('resolveHostStepModel', () => {
  const aliases: PipelineModelAlias[] = [
    { id: 'reviewer', name: 'Reviewer', defaults: { base: 'opus' } },
    {
      id: 'coach',
      name: 'Coach',
      defaults: { base: 'opus', instructions: 'Be kind.' },
    },
    {
      id: 'bundle',
      name: 'Bundle',
      defaults: { base: 'opus', plugin_collection_id: 'col-1' },
    },
    {
      id: 'agent',
      name: 'Agent',
      defaults: { agent_id: 'agent_model_abc' },
    },
    { id: 'unset', name: 'Unset' },
  ];

  const resolve = (
    value: string,
    preferences?: Record<string, PipelineModelAliasPreference>,
  ): string =>
    resolveHostStepModel({
      value,
      modelAliases: aliases,
      ...(preferences ? { modelAliasPreferences: preferences } : {}),
    });

  it('resolves a base alias to its base model', () => {
    expect(resolve('reviewer')).toBe('opus');
  });

  it('prefers the run preference over the alias default', () => {
    expect(
      resolve('reviewer', { reviewer: { mode: 'inline', base: 'haiku' } }),
    ).toBe('haiku');
  });

  it('sends an Agent alias as its agent model id', () => {
    expect(resolve('agent')).toBe('agent_model_abc');
  });

  it.each(['coach', 'bundle'])(
    'refuses alias %s, which carries instructions or plugins',
    (id) => {
      expect(() => resolve(id)).toThrow(
        `Model alias "${id}" sets instructions or plugins, which a chat message can't carry.`,
      );
    },
  );

  it('refuses an alias with no configuration', () => {
    expect(() => resolve('unset')).toThrow('requires a model configuration');
  });

  it('resolves a built-in $ alias', () => {
    const resolved = resolve('$cheap');
    expect(resolved).not.toBe('$cheap');
    expect(resolved.startsWith('$')).toBe(false);
  });

  it('refuses a raw Agent model id', () => {
    expect(() => resolve('agent_model_xyz')).toThrow(
      'Agent model IDs are not supported directly',
    );
  });

  it('passes an unknown plain name through', () => {
    expect(resolve('some-future-model')).toBe('some-future-model');
  });
});

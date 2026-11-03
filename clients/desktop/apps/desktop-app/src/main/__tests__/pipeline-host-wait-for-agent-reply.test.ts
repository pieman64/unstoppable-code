jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: jest.fn(),
  readWorkspaceWorktreesDetailed: jest.fn(),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  readWorkEntriesFileStrict: jest.fn(),
}));
jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: jest.fn(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));
jest.mock('../services/background-execution-context', () => ({
  resolveBackgroundTargetContext: jest.fn(),
}));

import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type {
  PipelineHostActionCaller,
  PipelineHostActionControls,
  PipelineHostActionResult,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  emptyWaitForAgentReplyOutputs,
  type WaitForAgentReplyInputs,
} from '@canopy/desktop-shared/pipelines/host-wait-for-agent-reply';
import {
  APP_ADVISOR_PROJECT_ID,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';
import { resolveBackgroundTargetContext } from '../services/background-execution-context';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from '../lib/workspace-persistence';
import { ADVISOR_ACCESS_DISABLED } from '../lib/app-advisor-project-agent-access';
import type { ChatReadContext } from '../project-discovery/chat-target';
import { DiscoveryError } from '../project-discovery/errors';
import type { TurnReplyRead } from '../project-discovery/reads/turn-reply';
import type {
  AgentReplyWaitDeps,
  AgentReplyWaitOptions,
  AgentReplyWaitResult,
} from '../pipelines/agent-reply-wait';
import {
  runWaitForAgentReplyHostAction,
  type WaitForAgentReplyHostDeps,
} from '../pipelines/host-wait-for-agent-reply';

const readConfig = jest.mocked(readWorkspaceConfigDetailed);
const readWorktrees = jest.mocked(readWorkspaceWorktreesDetailed);
const readEntries = jest.mocked(readWorkEntriesFileStrict);
const resolveCowork = jest.mocked(resolveCoworkWorkspaceId);

const MIN = 60_000;
const ORG_ID = '4b2a9c1e-7d3f-4e8a-9b6c-1f2e3d4c5b6a';
const caller: PipelineHostActionCaller = {
  executionId: 'exec-1',
  jobId: 'job-a',
  stepId: 'wait',
  attempt: 0,
  iteration: 0,
  idempotencyKey: 'pipeline-host:exec-1:job-a::wait:0:0',
};
const projectInputs: WaitForAgentReplyInputs = {
  chat: {
    kind: 'project',
    projectId: 'proj-1',
    taskId: 'task-1',
    chatId: 'chat-1',
  },
  messageId: 'm',
  replyTimeoutMinutes: 60,
};
const botInputs: WaitForAgentReplyInputs = {
  chat: {
    kind: 'bot',
    botId: 'app_advisor',
    taskId: 'entry-1',
    chatId: 'chat-1',
  },
  replyTimeoutMinutes: 60,
};
const CONTEXT = { scope: { chatId: 'chat-1' } } as unknown as ChatReadContext;

interface TestControls extends PipelineHostActionControls {
  finalizer?: () => Promise<PipelineHostActionResult>;
}

let artifactsDir: string;

function makeControls(deadlineAt = Date.now() + 400 * MIN): TestControls {
  const controls: TestControls = {
    deadlineAt,
    artifactsDir,
    registerTimeoutFinalizer(finalize) {
      controls.finalizer = finalize;
    },
  };
  return controls;
}

function settledResult(
  turnId: string,
  state: 'completed' | 'failed' | 'cancelled' | 'interrupted' = 'completed',
  endedTurnId = turnId,
): AgentReplyWaitResult {
  return { kind: 'settled', turnId, endedTurnId, state };
}

function reply(
  messageId: string,
  text: string,
  fullText = text,
  truncated = false,
): TurnReplyRead {
  return { kind: 'reply', reply: { messageId, text, truncated, fullText } };
}

function fakeWaitDeps(): AgentReplyWaitDeps & { emit(): void } {
  const listeners = new Set<() => void>();
  return {
    locateInput: () => Promise.resolve({ kind: 'unknown' }),
    currentTurn: () => Promise.resolve({ kind: 'none' }),
    settle: () =>
      Promise.resolve({
        outcome: 'pending',
        endedTurnId: '',
        abandoned: false,
      }),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (): void => {
      listeners.forEach((listener) => listener());
    },
  };
}

interface RunOptions {
  inputs?: WaitForAgentReplyInputs;
  caller?: PipelineHostActionCaller;
  wait?:
    | AgentReplyWaitResult
    | ((options: AgentReplyWaitOptions) => Promise<AgentReplyWaitResult>);
  reply?: TurnReplyRead | Error | Array<TurnReplyRead | Error>;
  controls?: TestControls | null;
  signal?: AbortSignal;
  deps?: Partial<WaitForAgentReplyHostDeps>;
}

interface RunHandles {
  wait: jest.Mock<
    Promise<AgentReplyWaitResult>,
    [AgentReplyWaitDeps, AgentReplyWaitOptions]
  >;
  readTurnReply: jest.Mock;
  resolveChatContext: jest.Mock;
  assertTargetOwner: jest.Mock;
}

function harness(options: RunOptions = {}): {
  result: Promise<PipelineHostActionResult>;
  handles: RunHandles;
  controls: TestControls | undefined;
} {
  const replies =
    options.reply === undefined
      ? [reply('r-1', 'answer')]
      : Array.isArray(options.reply)
        ? [...options.reply]
        : [options.reply];
  const readTurnReply = jest.fn(() => {
    const next = replies.length > 1 ? replies.shift() : replies[0];
    if (next === undefined) throw new Error('no reply fixture');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const waitOption = options.wait ?? settledResult('turn-1');
  const wait = jest.fn<
    Promise<AgentReplyWaitResult>,
    [AgentReplyWaitDeps, AgentReplyWaitOptions]
  >((_deps, waitOptions) =>
    typeof waitOption === 'function'
      ? waitOption(waitOptions)
      : Promise.resolve(waitOption),
  );
  const resolveChatContext = jest.fn(() => Promise.resolve(CONTEXT));
  const assertTargetOwner = jest.fn(() => Promise.resolve());
  const controls =
    options.controls === null
      ? undefined
      : (options.controls ?? makeControls());
  const result = runWaitForAgentReplyHostAction(
    options.inputs ?? projectInputs,
    options.caller ?? caller,
    {
      assertTargetOwner,
      readTurnReply,
      resolveChatContext,
      waitDeps: () => Promise.resolve(fakeWaitDeps()),
      wait,
      readRetryMs: 10,
      ...options.deps,
    },
    options.signal ?? new AbortController().signal,
    controls,
  );
  return {
    result,
    handles: { wait, readTurnReply, resolveChatContext, assertTargetOwner },
    controls,
  };
}

function run(options: RunOptions = {}): Promise<PipelineHostActionResult> {
  return harness(options).result;
}

function config(
  type: WorkspaceConfigFile['type'],
): Awaited<ReturnType<typeof readWorkspaceConfigDetailed>> {
  return {
    config: { version: 1, type, repos: [] } satisfies WorkspaceConfigFile,
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
  };
}

async function artifactNames(): Promise<string[]> {
  try {
    return await fsp.readdir(artifactsDir);
  } catch {
    return [];
  }
}

beforeEach(async () => {
  jest.resetAllMocks();
  artifactsDir = path.join(
    await fsp.mkdtemp(path.join(tmpdir(), 'canopy-wait-reply-')),
    'host',
  );
  readConfig.mockResolvedValue(config('single-repo'));
  readWorktrees.mockResolvedValue({
    worktrees: [
      {
        id: 'task-1',
        branchName: 'feature/task-1',
        createdAt: '2026-10-19T00:00:00Z',
      },
    ],
    authority: 'ok',
  });
  readEntries.mockResolvedValue({
    version: 1,
    entries: [
      { id: 'entry-1', title: 'Entry', createdAt: '2026-10-19T00:00:00Z' },
    ],
  });
  resolveCowork.mockImplementation((id) => id);
});

afterEach(async () => {
  await fsp.rm(path.dirname(artifactsDir), { recursive: true, force: true });
});

describe('runWaitForAgentReplyHostAction', () => {
  it('returns the reply, writes reply_file with the full text and caps reply_text', async () => {
    const long = 'y'.repeat(9_000);
    const result = await run({
      reply: reply('r-1', `${long.slice(0, 7_970)}…`, long, true),
    });
    expect(result.status).toBe('success');
    expect(result.outputs).toMatchObject({
      reply_state: 'completed',
      turn_id: 'turn-1',
      reply_message_id: 'r-1',
      reply_truncated: 'true',
      reply_text: `${long.slice(0, 7_970)}…`,
    });
    const file = result.outputs.reply_file ?? '';
    expect(path.isAbsolute(file) && file.startsWith(artifactsDir)).toBe(true);
    expect(await fsp.readFile(file, 'utf8')).toBe(long);
  });

  it('reads the ended turn, not the bound turn, after a resume chain', async () => {
    const { result, handles } = harness({
      wait: settledResult('a', 'completed', 'b'),
    });
    await expect(result).resolves.toMatchObject({
      status: 'success',
      outputs: { turn_id: 'a' },
    });
    expect(handles.readTurnReply).toHaveBeenCalledWith(
      { projectId: 'proj-1', taskId: 'task-1', chatId: 'chat-1' },
      'b',
      expect.objectContaining({ kind: 'pipeline' }),
    );
  });

  it('returns a turn that ended without a reply with its outcome and no text', async () => {
    await expect(
      run({
        wait: settledResult('turn-1', 'failed'),
        reply: { kind: 'no_reply' },
      }),
    ).resolves.toEqual({
      status: 'success',
      outputs: {
        ...emptyWaitForAgentReplyOutputs(),
        reply_state: 'failed',
        turn_id: 'turn-1',
      },
    });
    expect(await artifactNames()).not.toContain('reply.md');
  });

  it('refuses a missing project as not_found with every output', async () => {
    readConfig.mockResolvedValue({
      ...config('single-repo'),
      authority: 'absent',
    });
    await expect(run()).resolves.toEqual({
      status: 'failure',
      failureReason: 'not_found',
      error: "Project `proj-1` isn't available to this pipeline",
      outputs: emptyWaitForAgentReplyOutputs(),
    });
  });

  it('refuses a missing task as not_found with every output', async () => {
    readWorktrees.mockResolvedValue({ worktrees: [], authority: 'ok' });
    await expect(run()).resolves.toEqual({
      status: 'failure',
      failureReason: 'not_found',
      error: "Task `task-1` isn't in project `proj-1`",
      outputs: emptyWaitForAgentReplyOutputs(),
    });
  });

  it.each([
    [
      'Project was not found.',
      "Project `proj-1` isn't available to this pipeline",
    ],
    ['Task was not found.', "Task `task-1` isn't in project `proj-1`"],
    ['Chat was not found.', "Chat `chat-1` isn't in task `task-1`"],
  ])('maps the upstream not_found %j', async (upstream, message) => {
    await expect(
      run({
        deps: {
          resolveChatContext: () =>
            Promise.reject(new DiscoveryError('not_found', upstream)),
        },
      }),
    ).resolves.toEqual({
      status: 'failure',
      failureReason: 'not_found',
      error: message,
      outputs: emptyWaitForAgentReplyOutputs(),
    });
  });

  it('maps a bot task miss to the bot wording', async () => {
    await expect(
      run({
        inputs: botInputs,
        deps: {
          resolveChatContext: () =>
            Promise.reject(
              new DiscoveryError('not_found', 'Task was not found.'),
            ),
        },
      }),
    ).resolves.toMatchObject({
      error: "Task `entry-1` isn't in bot `app_advisor`",
    });
  });

  it('refuses an unknown message as not_found naming the message and chat', async () => {
    const result = await run({ wait: { kind: 'unknown_message' } });
    expect(result).toMatchObject({
      status: 'failure',
      failureReason: 'not_found',
      outputs: emptyWaitForAgentReplyOutputs(),
    });
    expect(result.status === 'failure' && result.error).toContain(
      "Message `m` isn't in chat `chat-1`",
    );
    expect(result.status === 'failure' && result.error).toContain(
      'Pass message_id',
    );
  });

  it('keeps advisor_access_disabled for an agent-originated bot wait', async () => {
    await expect(
      run({
        inputs: botInputs,
        deps: {
          resolveChatContext: () =>
            Promise.reject(
              new DiscoveryError(ADVISOR_ACCESS_DISABLED, 'disabled'),
            ),
        },
      }),
    ).resolves.toMatchObject({
      status: 'failure',
      failureReason: 'advisor_access_disabled',
      error:
        "Bot `app_advisor` isn't available to the agent that started this pipeline",
    });
  });

  it('rethrows an unexpected discovery error', async () => {
    await expect(
      run({
        deps: {
          resolveChatContext: () =>
            Promise.reject(new DiscoveryError('execution_failed', 'boom')),
        },
      }),
    ).rejects.toThrow('boom');
  });

  it('resolves a bot chat through the bot binding and passes agentOrigin on the discovery caller', async () => {
    const origin = { projectId: 'p', worktreeId: 'w', chatId: 'c' };
    const { result, handles } = harness({
      inputs: botInputs,
      caller: { ...caller, agentOrigin: origin },
    });
    await expect(result).resolves.toMatchObject({ status: 'success' });
    expect(readEntries).toHaveBeenCalledWith(APP_ADVISOR_PROJECT_ID);
    expect(handles.resolveChatContext).toHaveBeenCalledWith(
      { botId: 'app_advisor', taskId: 'entry-1', chatId: 'chat-1' },
      {
        kind: 'pipeline',
        owner: { kind: 'personal' },
        agentOrigin: origin,
      },
    );
  });

  it('checks the target owner before resolving the chat', async () => {
    const { result, handles } = harness();
    await result;
    expect(handles.assertTargetOwner).toHaveBeenCalledWith(caller, {
      kind: 'project',
      projectId: 'proj-1',
      taskId: 'task-1',
      workspaceType: 'single-repo',
    });
  });

  it.each([
    [true, { kind: 'personal' }, { kind: 'personal' }],
    [
      false,
      { kind: 'personal' },
      { kind: 'organization', organizationId: ORG_ID },
    ],
    [
      true,
      { kind: 'organization', organizationId: ORG_ID },
      { kind: 'organization', organizationId: ORG_ID },
    ],
  ] as const)(
    'reads a project as the host owner check allows it (matches %s, target %j)',
    async (matches, targetOwner, expectedOwner) => {
      jest.mocked(resolveBackgroundTargetContext).mockResolvedValue({
        matches,
        targetOwner,
        target: { workspaceOwner: targetOwner, linkedOrganizationIds: [] },
        ownershipTransferred: false,
      });
      const { result, handles } = harness({
        caller: { ...caller, executionContext: `org:${ORG_ID}` },
      });
      await result;
      expect(resolveBackgroundTargetContext).toHaveBeenCalledWith(
        { projectId: 'proj-1', worktreeId: 'task-1' },
        expect.objectContaining({
          kind: 'organization',
          organizationId: ORG_ID,
        }),
      );
      expect(handles.resolveChatContext).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'pipeline', owner: expectedOwner }),
      );
    },
  );

  it('re-checks the project link at the final read', async () => {
    const linked = {
      matches: true,
      targetOwner: { kind: 'personal' },
      target: {
        workspaceOwner: { kind: 'personal' },
        linkedOrganizationIds: [ORG_ID],
      },
      ownershipTransferred: false,
    } as const;
    jest
      .mocked(resolveBackgroundTargetContext)
      .mockResolvedValueOnce(linked)
      // Unlinked from the organization while the step waited.
      .mockResolvedValue({ ...linked, matches: false });
    const { result, handles } = harness({
      caller: { ...caller, executionContext: `org:${ORG_ID}` },
    });
    await result;
    expect(resolveBackgroundTargetContext).toHaveBeenCalledWith(
      { projectId: 'proj-1', worktreeId: 'task-1' },
      expect.objectContaining({ kind: 'organization' }),
    );
    expect(handles.readTurnReply).toHaveBeenCalledWith(
      expect.anything(),
      'turn-1',
      expect.objectContaining({
        kind: 'pipeline',
        owner: { kind: 'organization', organizationId: ORG_ID },
      }),
    );
  });

  it('refuses as owner_context_unavailable when the linked-project check fails', async () => {
    jest
      .mocked(resolveBackgroundTargetContext)
      .mockRejectedValue(new Error('target unresolved'));
    await expect(
      run({ caller: { ...caller, executionContext: `org:${ORG_ID}` } }),
    ).resolves.toEqual({
      status: 'failure',
      failureReason: 'owner_context_unavailable',
      error: "Project `proj-1` can't be checked right now. Try again.",
      outputs: emptyWaitForAgentReplyOutputs(),
    });
  });

  it('refuses an unparseable execution context as owner_context_unavailable', async () => {
    await expect(
      run({ caller: { ...caller, executionContext: 'nonsense' } }),
    ).resolves.toEqual({
      status: 'failure',
      failureReason: 'owner_context_unavailable',
      error: "Project `proj-1` can't be checked right now. Try again.",
      outputs: emptyWaitForAgentReplyOutputs(),
    });
  });

  it('fails closed when the owner loses access between settlement and the read', async () => {
    await expect(
      run({ reply: new DiscoveryError('not_found', 'Chat was not found.') }),
    ).resolves.toEqual({
      status: 'failure',
      failureReason: 'not_found',
      error: "Chat `chat-1` isn't in task `task-1`",
      outputs: {
        ...emptyWaitForAgentReplyOutputs(),
        reply_state: 'completed',
        turn_id: 'turn-1',
      },
    });
  });

  it('maps the reply timeout to reply_timed_out with turn_id and the minutes message', async () => {
    const result = await run({ wait: { kind: 'timed_out', turnId: 'turn-1' } });
    expect(result).toMatchObject({
      status: 'failure',
      failureReason: 'reply_timed_out',
      outputs: { reply_state: 'timed_out', turn_id: 'turn-1' },
    });
    expect(result.status === 'failure' && result.error).toBe(
      'No reply from chat `chat-1` within 60 minutes',
    );
  });

  it('names the reply timeout when the executor raised the step deadline to fit it', async () => {
    // The executor sets the deadline from its own start (reply timeout plus
    // the read margin), slightly before the host binds the chat.
    const result = await run({
      controls: makeControls(Date.now() + 62 * MIN - 50),
      wait: { kind: 'timed_out', turnId: 'turn-1' },
    });
    expect(result).toMatchObject({
      failureReason: 'reply_timed_out',
      error: 'No reply from chat `chat-1` within 60 minutes',
    });
  });

  it('names the step deadline when the clamp ended the wait', async () => {
    const result = await run({
      inputs: { ...projectInputs, replyTimeoutMinutes: 120 },
      controls: makeControls(Date.now() + 30 * MIN),
      wait: { kind: 'timed_out' },
    });
    expect(result).toMatchObject({
      failureReason: 'reply_timed_out',
      error: 'No reply from chat `chat-1` before the step deadline',
      outputs: { reply_state: 'timed_out', turn_id: '' },
    });
  });

  it('registers a finalizer before any await that answers reply_timed_out', async () => {
    const controller = new AbortController();
    const { result, controls } = harness({
      wait: () => new Promise(() => undefined),
      signal: controller.signal,
    });
    expect(controls?.finalizer).toBeDefined();
    await expect(controls?.finalizer?.()).resolves.toMatchObject({
      status: 'failure',
      failureReason: 'reply_timed_out',
      error: 'No reply from chat `chat-1` before the step deadline',
      outputs: { reply_state: 'timed_out' },
    });
    controller.abort(new Error('stopped'));
    void result.catch(() => undefined);
  });

  it('finalizes as timed_out with turn_id when the read never completes', async () => {
    const controller = new AbortController();
    const { result, controls, handles } = harness({
      reply: { kind: 'not_settled' },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handles.readTurnReply.mock.calls.length).toBeGreaterThan(1);
    await expect(controls?.finalizer?.()).resolves.toMatchObject({
      failureReason: 'reply_timed_out',
      outputs: { reply_state: 'timed_out', turn_id: 'turn-1' },
    });
    controller.abort(new Error('stopped'));
    await expect(result).rejects.toThrow('stopped');
  });

  it('ends the read retry at the reply timeout plus the read margin, not hours later at the step deadline', async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const now = jest
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() + offset);
    const controller = new AbortController();
    try {
      const { result } = harness({
        inputs: { ...projectInputs, replyTimeoutMinutes: 1 },
        signal: controller.signal,
        deps: {
          readTurnReply: jest.fn(() => {
            // Each read sees the clock past the reply timeout and the margin.
            offset += 4 * MIN;
            return Promise.resolve<TurnReplyRead>({ kind: 'not_settled' });
          }),
        },
      });
      const settled = await Promise.race([
        result,
        new Promise((resolve) =>
          setTimeout(() => resolve('still reading'), 300),
        ),
      ]);
      expect(settled).toMatchObject({
        status: 'failure',
        failureReason: 'reply_timed_out',
        error: 'No reply from chat `chat-1` within 1 minute',
        outputs: { reply_state: 'timed_out', turn_id: 'turn-1' },
      });
      controller.abort(new Error('stopped'));
      void result.catch(() => undefined);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps a turn pinned while the wait deadline fired', async () => {
    await expect(
      run({
        wait: async (options) => {
          await options.onPinned?.('turn-1');
          return { kind: 'timed_out' };
        },
      }),
    ).resolves.toMatchObject({
      failureReason: 'reply_timed_out',
      outputs: { turn_id: 'turn-1' },
    });
  });

  it('reports a turn whose pin is still being written when the wait deadline fired', async () => {
    let pinning: Promise<void> | undefined;
    await expect(
      run({
        wait: (options) => {
          pinning = options.onPinned?.('turn-1');
          return Promise.resolve({ kind: 'timed_out' });
        },
      }),
    ).resolves.toMatchObject({
      failureReason: 'reply_timed_out',
      outputs: { turn_id: 'turn-1' },
    });
    await pinning;
  });

  it('arms no read retry timer when subscribing throws', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    try {
      await expect(
        run({
          reply: { kind: 'not_settled' },
          deps: {
            readRetryMs: 12_345,
            waitDeps: () =>
              Promise.resolve({
                ...fakeWaitDeps(),
                onChange: (): (() => void) => {
                  throw new Error('subscribe failed');
                },
              }),
          },
        }),
      ).rejects.toThrow('subscribe failed');
      expect(
        setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 12_345),
      ).toHaveLength(0);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('ends the read retry at the step deadline as reply_timed_out', async () => {
    await expect(
      run({
        reply: { kind: 'not_settled' },
        controls: makeControls(Date.now() + 60),
      }),
    ).resolves.toMatchObject({
      failureReason: 'reply_timed_out',
      outputs: { reply_state: 'timed_out', turn_id: 'turn-1' },
    });
  });

  it('clamps the wait deadline to the step deadline minus the read margin', async () => {
    const before = Date.now();
    const { result, handles } = harness({
      inputs: { ...projectInputs, replyTimeoutMinutes: 120 },
      controls: makeControls(before + 30 * MIN),
    });
    await result;
    const deadline = handles.wait.mock.calls[0]?.[1].deadlineAt ?? 0;
    expect(deadline).toBeGreaterThanOrEqual(before + 28 * MIN - 1_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 28 * MIN);
  });

  it('uses the reply timeout when it ends first', async () => {
    const before = Date.now();
    const { result, handles } = harness();
    await result;
    const deadline = handles.wait.mock.calls[0]?.[1].deadlineAt ?? 0;
    expect(deadline).toBeGreaterThanOrEqual(before + 60 * MIN);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 60 * MIN);
  });

  it('never passes a wait deadline earlier than now', async () => {
    const before = Date.now();
    const { result, handles } = harness({
      controls: makeControls(before + MIN),
    });
    await result;
    expect(handles.wait.mock.calls[0]?.[1].deadlineAt).toBeGreaterThanOrEqual(
      before,
    );
  });

  it('reuses the turn pinned by an earlier run of the same attempt', async () => {
    await fsp.mkdir(artifactsDir, { recursive: true });
    await fsp.writeFile(
      path.join(artifactsDir, 'binding.json'),
      JSON.stringify({ chatId: 'chat-1', messageId: 'm', turnId: 'pinned' }),
    );
    const { result, handles } = harness();
    await result;
    expect(handles.wait.mock.calls[0]?.[1].pinnedTurnId).toBe('pinned');
  });

  it('keeps the pinned turn_id when the step deadline finalizes before the wait resolves', async () => {
    await fsp.mkdir(artifactsDir, { recursive: true });
    await fsp.writeFile(
      path.join(artifactsDir, 'binding.json'),
      JSON.stringify({ chatId: 'chat-1', messageId: 'm', turnId: 'pinned' }),
    );
    const controller = new AbortController();
    const { result, controls, handles } = harness({
      wait: () => new Promise(() => undefined),
      signal: controller.signal,
    });
    while (handles.wait.mock.calls.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(controls?.finalizer?.()).resolves.toMatchObject({
      failureReason: 'reply_timed_out',
      outputs: { reply_state: 'timed_out', turn_id: 'pinned' },
    });
    controller.abort(new Error('stopped'));
    void result.catch(() => undefined);
  });

  it.each([
    [{ chatId: 'chat-2', messageId: 'm', turnId: 'pinned' }],
    [{ chatId: 'chat-1', messageId: 'other', turnId: 'pinned' }],
    [{ chatId: 'chat-1', turnId: 'pinned' }],
    [{ chatId: 'chat-1', messageId: 'm', turnId: 7 }],
  ])('ignores a pin for a different input %j', async (pin) => {
    await fsp.mkdir(artifactsDir, { recursive: true });
    await fsp.writeFile(
      path.join(artifactsDir, 'binding.json'),
      JSON.stringify(pin),
    );
    const { result, handles } = harness();
    await result;
    expect(handles.wait.mock.calls[0]?.[1]).not.toHaveProperty('pinnedTurnId');
  });

  it('ignores an unparseable binding.json', async () => {
    await fsp.mkdir(artifactsDir, { recursive: true });
    await fsp.writeFile(path.join(artifactsDir, 'binding.json'), '{nope');
    const { result, handles } = harness();
    await expect(result).resolves.toMatchObject({ status: 'success' });
    expect(handles.wait.mock.calls[0]?.[1]).not.toHaveProperty('pinnedTurnId');
  });

  it('pins the turn to binding.json once bound', async () => {
    await run({
      wait: async (options) => {
        await options.onPinned?.('turn-1');
        return settledResult('turn-1');
      },
    });
    expect(
      JSON.parse(
        await fsp.readFile(path.join(artifactsDir, 'binding.json'), 'utf8'),
      ),
    ).toEqual({ chatId: 'chat-1', messageId: 'm', turnId: 'turn-1' });
  });

  it('retries the read while the transcript has not completed the turn', async () => {
    const { result, handles } = harness({
      reply: [{ kind: 'not_settled' }, reply('r-1', 'answer')],
    });
    await expect(result).resolves.toMatchObject({
      status: 'success',
      outputs: { reply_text: 'answer' },
    });
    expect(handles.readTurnReply).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst of chat commits into one read retry', async () => {
    const controller = new AbortController();
    const { result, handles } = harness({
      reply: { kind: 'not_settled' },
      signal: controller.signal,
      deps: {
        readRetryMs: 60_000,
        // A busy chat: a committed change every millisecond.
        waitDeps: () =>
          Promise.resolve({
            ...fakeWaitDeps(),
            onChange(listener: () => void) {
              const timer = setInterval(listener, 1);
              return (): void => clearInterval(timer);
            },
          }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(handles.readTurnReply.mock.calls.length).toBeLessThanOrEqual(2);
    controller.abort(new Error('stopped'));
    await expect(result).rejects.toThrow('stopped');
  });

  it('retries the read after cursor_context_changed', async () => {
    await expect(
      run({
        reply: [
          new DiscoveryError('cursor_context_changed', 'changed'),
          reply('r-1', 'answer'),
        ],
      }),
    ).resolves.toMatchObject({
      status: 'success',
      outputs: { reply_message_id: 'r-1' },
    });
  });

  it('rejects on abort during the read retry and writes nothing', async () => {
    const controller = new AbortController();
    const { result } = harness({
      reply: { kind: 'not_settled' },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error('stopped'));
    await expect(result).rejects.toThrow('stopped');
    expect(await artifactNames()).not.toContain('reply.md');
  });

  it('rejects on abort during the wait and writes nothing', async () => {
    const controller = new AbortController();
    const { result, handles } = harness({
      wait: (options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(new Error('stopped'));
          });
        }),
      signal: controller.signal,
    });
    // Abort only once the wait listens; a fixed delay can abort while the
    // action is still reading the pin, before the wait is called.
    while (handles.wait.mock.calls.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error('stopped'));
    await expect(result).rejects.toThrow('stopped');
    expect(await artifactNames()).toEqual([]);
  });

  it('treats a never-ran input as cancelled', async () => {
    await expect(run({ wait: { kind: 'never_ran' } })).resolves.toEqual({
      status: 'success',
      outputs: { ...emptyWaitForAgentReplyOutputs(), reply_state: 'cancelled' },
    });
  });

  it('returns none for an idle chat without a settled turn', async () => {
    await expect(
      run({
        inputs: { chat: projectInputs.chat, replyTimeoutMinutes: 60 },
        wait: { kind: 'none' },
      }),
    ).resolves.toEqual({
      status: 'success',
      outputs: { ...emptyWaitForAgentReplyOutputs(), reply_state: 'none' },
    });
  });

  it('throws without execution controls', async () => {
    await expect(run({ controls: null })).rejects.toThrow(
      'wait-for-agent-reply needs execution controls',
    );
  });
});

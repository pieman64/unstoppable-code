import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PipelineHostActionCaller,
  PipelineHostActionRequest,
  PipelineHostActions,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import type { PipelineChatSendRecord } from '@canopy/desktop-shared/types/pipeline';
import { WorkerPipelineHostActionRequestSchema } from '@canopy/protocol/canopy-core';
import {
  parseCreateBotEntryInputs,
  parseCreateProjectEntryInputs,
} from '@canopy/desktop-shared/pipelines/host-create-entry';
import { parseSendAgentMessageInputs } from '@canopy/desktop-shared/pipelines/host-send-agent-message';
import { parseWaitForAgentReplyInputs } from '@canopy/desktop-shared/pipelines/host-wait-for-agent-reply';
import { createWorkerPipelineHostActions } from '../../pipelines/pipeline-host-requests';
import { createCoreOperationAdapter } from '../core-operation-adapter';
import { createDesktopRuntime } from '../desktop-runtime';
import { setDesktopCanopyRuntime } from '../desktop-runtime-access';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));

// CAN-4140, CAN-5077: every host step crosses the local worker boundary as a
// worker-to-core request that the desktop runtime settles through its
// dispatcher.

const caller: PipelineHostActionCaller = {
  executionId: 'run-1',
  jobId: 'build',
  stepId: 'create',
  attempt: 0,
  iteration: 0,
  idempotencyKey: 'pipeline-host:run-1:build::create:0:0',
  executionContext: 'personal',
};

const createWorktree: PipelineHostActionRequest = {
  action: 'create-worktree',
  inputs: {
    projectId: 'project-1',
    branch: { kind: 'new', name: 'feature' },
    repair: false,
    setup: 'skip',
  },
};

let dir: string;
let dispatcher: ReturnType<typeof createDesktopRuntime> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'desktop-host-requests-'));
});

afterEach(async () => {
  setDesktopCanopyRuntime(null);
  await dispatcher?.shutdown();
  dispatcher = null;
  rmSync(dir, { recursive: true, force: true });
});

async function settling(): Promise<void> {
  dispatcher = createDesktopRuntime({
    operationAdapter: createCoreOperationAdapter({
      ledgerPath: () => join(dir, 'operation-ledger.sqlite'),
    }),
    shutdownTimeoutMs: 25,
  });
  setDesktopCanopyRuntime(dispatcher);
  const broker = dispatcher.pipelineHostRequests;
  for (let tick = 0; tick < 100 && !broker.settled; tick += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(broker.settled).toBe(true);
}

function host(run: PipelineHostActions['run']): {
  host: PipelineHostActions;
  calls: PipelineHostActionRequest[];
} {
  const calls: PipelineHostActionRequest[] = [];
  return {
    calls,
    host: {
      run: (request, ...rest): ReturnType<PipelineHostActions['run']> => {
        calls.push(request);
        return run(request, ...rest);
      },
    },
  };
}

describe('desktop runtime pipeline host requests', () => {
  it('settles a host step through core, keeping host paths on the worker', async () => {
    await settling();
    const raised: unknown[] = [];
    dispatcher?.pipelineHostRequests.subscribe((request) =>
      raised.push(request),
    );
    const fake = host(() =>
      Promise.resolve({
        status: 'success',
        outputs: { worktree_id: 'wt-1', path: '/Users/someone/wt-1' },
      }),
    );
    await expect(
      createWorkerPipelineHostActions(fake.host).run(
        createWorktree,
        caller,
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      status: 'success',
      outputs: { worktree_id: 'wt-1', path: '/Users/someone/wt-1' },
    });
    expect(fake.calls).toEqual([createWorktree]);
    expect(raised).toEqual([
      expect.objectContaining({
        requestId: caller.idempotencyKey,
        owner: 'personal',
        request: { action: 'create-worktree', ...createWorktree.inputs },
      }),
    ]);
  });

  it('stops the host action when the executor withdraws the step', async () => {
    await settling();
    let hostSignal: AbortSignal | undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fake = host((_request, _caller, signal) => {
      hostSignal = signal;
      started();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    });
    const step = new AbortController();
    const result = createWorkerPipelineHostActions(fake.host).run(
      createWorktree,
      caller,
      step.signal,
    );
    await running;
    expect(hostSignal?.aborted).toBe(false);
    step.abort(new Error('step withdrawn'));
    await expect(result).rejects.toThrow('step withdrawn');
    expect(hostSignal?.aborted).toBe(true);
  });

  it('hands the host a long group name unchanged, so its fingerprint holds', async () => {
    await settling();
    const long = 'g'.repeat(300);
    const fake = host(() =>
      Promise.resolve({ status: 'success', outputs: {} }),
    );
    const port = createWorkerPipelineHostActions(fake.host);
    const task = {
      kind: 'project' as const,
      projectId: 'project-1',
      taskId: 'task-1',
    };
    const moveToGroup: PipelineHostActionRequest = {
      action: 'move-to-group',
      inputs: {
        task,
        target: { kind: 'name', name: long },
      },
    };
    const grouped: PipelineHostActionRequest = {
      action: 'create-worktree',
      inputs: { ...createWorktree.inputs, group: long },
    };
    for (const request of [moveToGroup, grouped])
      await expect(
        port.run(request, caller, new AbortController().signal),
      ).resolves.toEqual({ status: 'success', outputs: {} });
    expect(fake.calls).toEqual([
      {
        action: 'move-to-group',
        inputs: {
          task,
          target: { kind: 'name', name: long },
        },
      },
      {
        action: 'create-worktree',
        inputs: { ...createWorktree.inputs, group: long },
      },
    ]);
  });

  it('sends a message through core, keeping attachment paths on the worker', async () => {
    await settling();
    const raised: unknown[] = [];
    dispatcher?.pipelineHostRequests.subscribe((request) =>
      raised.push(request),
    );
    const chatSend: PipelineChatSendRecord = {
      version: 1,
      address: {
        kind: 'project',
        projectId: 'project-1',
        taskId: 'task-1',
        chatId: 'chat-1',
      },
      userMessageId: 'message-1',
      state: 'sent',
      chatCreated: false,
      acceptedAt: '2026-11-02T10:00:00.000Z',
    };
    const send: PipelineHostActionRequest = {
      action: 'send-agent-message',
      inputs: {
        target: {
          kind: 'project',
          projectId: 'project-1',
          taskId: 'task-1',
          chatId: 'chat-1',
        },
        text: 'Review the change',
        mode: 'queue',
        settings: { model: 'claude-opus-5-5', thinkingEffort: 'high' },
        attachments: ['/Users/someone/wt-1/notes.md'],
      },
    };
    const fake = host(() =>
      Promise.resolve({
        status: 'failure',
        failureReason: 'target_not_ready',
        error: 'The message stayed queued.',
        outputs: { chat_id: 'chat-1', message_id: 'message-1' },
        chatSend,
      }),
    );
    await expect(
      createWorkerPipelineHostActions(fake.host).run(
        send,
        caller,
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      status: 'failure',
      failureReason: 'target_not_ready',
      error: 'The message stayed queued.',
      outputs: { chat_id: 'chat-1', message_id: 'message-1' },
      chatSend,
    });
    expect(fake.calls).toEqual([send]);
    expect(raised).toEqual([
      expect.objectContaining({
        owner: 'personal',
        request: {
          action: 'send-agent-message',
          target: {
            kind: 'project',
            projectId: 'project-1',
            taskId: 'task-1',
            chatId: 'chat-1',
          },
          text: 'Review the change',
          mode: 'queue',
          settings: { model: 'claude-opus-5-5', thinkingEffort: 'high' },
          attachmentCount: 1,
        },
      }),
    ]);
    expect(JSON.stringify(raised)).not.toContain('/Users/someone');
  });

  it('hands the host an explicit empty attachment list unchanged', async () => {
    await settling();
    const fake = host(() =>
      Promise.resolve({ status: 'success', outputs: {} }),
    );
    const send: PipelineHostActionRequest = {
      action: 'send-agent-message',
      inputs: {
        target: {
          kind: 'project',
          projectId: 'project-1',
          taskId: 'task-1',
          chatId: 'chat-1',
        },
        text: 'Hello',
        mode: 'queue',
        settings: {},
        attachments: [],
      },
    };
    await createWorkerPipelineHostActions(fake.host).run(
      send,
      caller,
      new AbortController().signal,
    );
    expect(fake.calls).toEqual([send]);
  });

  it('settles every project, bot and chat step, whatever the run owner', async () => {
    await settling();
    const raised: { owner: string | null; request: { action: string } }[] = [];
    dispatcher?.pipelineHostRequests.subscribe((request) =>
      raised.push(request),
    );
    const fake = host((request) => {
      const outputs: Record<string, string> =
        request.action === 'wait-for-agent-reply'
          ? { reply_state: 'completed', reply_file: '/Users/someone/reply' }
          : { task_id: 'task-2' };
      return Promise.resolve({ status: 'success', outputs });
    });
    const port = createWorkerPipelineHostActions(fake.host);
    const requests: PipelineHostActionRequest[] = [
      {
        action: 'create-project-entry',
        inputs: { projectId: 'project-1', title: 'Triage', group: 'Inbox' },
      },
      { action: 'create-bot-entry', inputs: { botId: 'app_advisor' } },
      {
        action: 'wait-for-agent-reply',
        inputs: {
          chat: {
            kind: 'bot',
            botId: 'app_advisor',
            taskId: 'task-1',
            chatId: 'chat-1',
          },
          messageId: 'message-1',
          replyTimeoutMinutes: 0.5,
        },
      },
    ];
    // As the host's owner policy resolves it: no owner is Personal, and an
    // owner that isn't a workspace context crosses as null.
    const ownerless: PipelineHostActionCaller = {
      executionId: caller.executionId,
      jobId: caller.jobId,
      stepId: caller.stepId,
      attempt: caller.attempt,
      iteration: caller.iteration,
      idempotencyKey: caller.idempotencyKey,
    };
    const unknown = { ...caller, executionContext: 'org:not-an-id' };
    for (const request of requests)
      for (const stepCaller of [ownerless, unknown])
        await expect(
          port.run(request, stepCaller, new AbortController().signal),
        ).resolves.toMatchObject({ status: 'success' });
    expect(fake.calls).toEqual(
      requests.flatMap((request) => [request, request]),
    );
    expect(raised.map(({ owner, request }) => [request.action, owner])).toEqual(
      requests.flatMap(({ action }) => [
        [action, 'personal'],
        [action, null],
      ]),
    );
    await expect(
      port.run(requests[2], caller, new AbortController().signal),
    ).resolves.toEqual({
      status: 'success',
      outputs: { reply_state: 'completed', reply_file: '/Users/someone/reply' },
    });
  });

  it('hands the executor a send record the boundary refuses', async () => {
    await settling();
    const invalid = {
      version: 1,
      address: { kind: 'project', projectId: 'p', taskId: 't', chatId: '' },
      userMessageId: 'message-1',
      state: 'sent',
      chatCreated: false,
      acceptedAt: '2026-11-02T10:00:00.000Z',
    } as const;
    const fake = host(() =>
      Promise.resolve({ status: 'success', outputs: {}, chatSend: invalid }),
    );
    await expect(
      createWorkerPipelineHostActions(fake.host).run(
        {
          action: 'send-agent-message',
          inputs: {
            target: { kind: 'bot', botId: 'app_advisor', taskId: 'task-1' },
            text: 'Hello',
            mode: 'queue',
            settings: {},
          },
        },
        caller,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: 'success', outputs: {}, chatSend: invalid });
  });

  it('accepts every input the step parsers produce', () => {
    const send = parseSendAgentMessageInputs({
      project_id: 'project-1',
      task_id: 'task-1',
      text: 'Use @review on this',
      mode: 'queue',
      model: 'claude-opus-5-5',
      thinking_effort: 'xhigh',
      fast_mode: 'true',
      plan_mode: 'false',
      approval_mode: 'ask',
      interface_mode: 'claude-code',
      plugins: JSON.stringify([
        {
          type: 'codex_plugin',
          marketplace: { type: 'codex-builtin', id: 'openai-curated' },
          plugin_name: 'security',
        },
        {
          type: 'claude_plugin',
          marketplace: { type: 'github', repo: 'acme/plugins' },
          plugin_name: 'browser',
        },
      ]),
      text_references: JSON.stringify([
        {
          kind: 'plugin',
          textStart: 4,
          displayText: '@review',
          plugin: { kind: 'installed', marketplaceId: 'm', pluginName: 'r' },
        },
      ]),
      literal_text: 'true',
      new_chat: 'true',
    });
    const parsed = [
      parseCreateProjectEntryInputs({
        project_id: 'project-1',
        title: 't'.repeat(200),
        group: 'g'.repeat(300),
      }),
      parseCreateBotEntryInputs({ bot_id: 'app_advisor' }),
      parseWaitForAgentReplyInputs({
        project_id: 'project-1',
        task_id: 'task-1',
        chat_id: 'chat-1',
        message_id: 'message-1',
        reply_timeout_minutes: '720',
      }),
    ];
    const actions = [
      'create-project-entry',
      'create-bot-entry',
      'wait-for-agent-reply',
    ];
    if (!send.ok) throw new Error(send.message);
    expect(
      WorkerPipelineHostActionRequestSchema.safeParse({
        action: 'send-agent-message',
        ...send.value,
        text: 'Use @review on this',
      }).success,
    ).toBe(true);
    parsed.forEach((result, index) => {
      if (!result.ok) throw new Error(result.message);
      expect(
        WorkerPipelineHostActionRequestSchema.safeParse({
          action: actions[index],
          ...result.value,
        }).success,
      ).toBe(true);
    });
  });

  it('rethrows an unexpected host error in process', async () => {
    await settling();
    const fake = host(() => Promise.reject(new Error('disk full')));
    await expect(
      createWorkerPipelineHostActions(fake.host).run(
        createWorktree,
        caller,
        new AbortController().signal,
      ),
    ).rejects.toThrow('disk full');
  });

  it('fails the step as without a desktop when no core settles requests', async () => {
    const fake = host(() =>
      Promise.resolve({ status: 'success', outputs: {} }),
    );
    await expect(
      createWorkerPipelineHostActions(fake.host).run(
        createWorktree,
        caller,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      status: 'failure',
      failureReason: 'needs_desktop',
    });
    expect(fake.calls).toEqual([]);
  });
});

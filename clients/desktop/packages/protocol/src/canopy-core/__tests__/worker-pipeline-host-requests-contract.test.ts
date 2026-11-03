import {
  WORKER_PIPELINE_HOST_ACTIONS,
  WorkerPipelineHostActionRequestSchema,
  WorkerPipelineHostRequestSchema,
  WorkerPipelineHostResultSchema,
} from '../index';

const send = {
  action: 'send-agent-message',
  target: { kind: 'project', projectId: 'p-1', taskId: 't-1', chatId: 'c-1' },
  text: 'Review @notes.md',
  mode: 'steer',
  settings: {
    model: 'claude-opus-5-5',
    thinkingEffort: 'high',
    approvalMode: 'full-access',
    plugins: [
      {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: 'review',
      },
    ],
  },
  textReferences: [
    {
      kind: 'file',
      textStart: 7,
      displayText: '@notes.md',
      root: { kind: 'workspace' },
      relativePath: 'notes.md',
    },
  ],
  attachmentCount: 2,
};

describe('worker.pipeline host request contract (CAN-5077)', () => {
  it('names every host step', () => {
    expect(WORKER_PIPELINE_HOST_ACTIONS).toEqual([
      'move-to-group',
      'create-worktree',
      'create-project-entry',
      'create-bot-entry',
      'send-agent-message',
      'wait-for-agent-reply',
    ]);
  });

  it('carries a send without its attachment paths', () => {
    expect(WorkerPipelineHostActionRequestSchema.parse(send)).toEqual(send);
    expect(
      WorkerPipelineHostActionRequestSchema.safeParse({
        ...send,
        attachments: ['/Users/someone/notes.md'],
      }).success,
    ).toBe(false);
  });

  it('crosses a run without an owner', () => {
    expect(
      WorkerPipelineHostRequestSchema.parse({
        requestId: 'pipeline-host:run-1:build::wait:0:0',
        executionId: 'run-1',
        jobId: 'build',
        stepId: 'wait',
        childExecutionId: null,
        attempt: 0,
        iteration: 0,
        owner: null,
        deadlineAt: '2026-11-02T10:00:00.000Z',
        request: {
          action: 'wait-for-agent-reply',
          chat: { kind: 'bot', botId: 'app_advisor', taskId: 't', chatId: 'c' },
          replyTimeoutMinutes: 0.5,
        },
      }).owner,
    ).toBeNull();
  });

  it('returns the send record and never a reply file path', () => {
    const chatSend = {
      version: 1,
      address: { kind: 'bot', botId: 'app_advisor', taskId: 't', chatId: 'c' },
      userMessageId: 'm-1',
      state: 'queued',
      chatCreated: true,
      acceptedAt: '2026-11-02T10:00:00.000Z',
    };
    expect(
      WorkerPipelineHostResultSchema.parse({
        status: 'failure',
        failureReason: 'target_not_ready',
        message: 'The message stayed queued.',
        outputs: {},
        chatSend,
      }),
    ).toMatchObject({ chatSend });
    expect(
      WorkerPipelineHostResultSchema.safeParse({
        status: 'success',
        outputs: { reply_file: '/Users/someone/reply.md' },
      }).success,
    ).toBe(false);
  });
});

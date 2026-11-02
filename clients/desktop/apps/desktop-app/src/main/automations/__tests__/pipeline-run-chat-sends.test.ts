import type {
  ExecutionEvent,
  ExecutionState,
  PipelineChatSendRecord,
} from '@canopy/desktop-shared/types/pipeline';
import {
  automationRunResultFromChatSend,
  lastChatSendRunResult,
  noteAutomationPipelineEvent,
} from '../pipeline-run-chat-sends';

const mockRecord = jest.fn<Promise<void>, [ExecutionEvent]>(() =>
  Promise.resolve(),
);
jest.mock('../service', () => ({
  getAutomationsService: (): object => ({
    recordPipelineRunChatSend: (event: ExecutionEvent): Promise<void> =>
      mockRecord(event),
  }),
}));

jest.mock('../../lib/workspace-registry', () => ({
  isCoworkWorkspace: (id: string): boolean => id === 'cowork-1',
}));

function record(
  address: PipelineChatSendRecord['address'],
  userMessageId = 'input-1',
): PipelineChatSendRecord {
  return {
    version: 1,
    address,
    userMessageId,
    state: 'sent',
    chatCreated: false,
    acceptedAt: '2026-10-29T00:00:00.000Z',
  };
}

function state(
  sends: Array<{ completedAt: string; send: PipelineChatSendRecord }>,
): ExecutionState {
  const steps = Object.fromEntries(
    sends.map(({ completedAt, send }, index) => [
      `send-${index}`,
      {
        status: 'success',
        outputs: {},
        dynamic_env: {},
        completed_at: completedAt,
        chat_send: send,
      },
    ]),
  );
  // Only `jobs` matters to the selector.
  return {
    jobs: { main: { status: 'success', steps, outputs: {} } },
  } as unknown as ExecutionState;
}

describe('automationRunResultFromChatSend (CAN-5381)', () => {
  it('maps an Orchestrator chat to appAdvisorChatId', () => {
    expect(
      automationRunResultFromChatSend(
        record({
          kind: 'bot',
          botId: 'app_advisor',
          taskId: 'entry-1',
          chatId: 'chat-1',
        }),
        undefined,
      ),
    ).toStrictEqual({ appAdvisorChatId: 'chat-1', userMessageId: 'input-1' });
  });

  it('maps a Cowork chat to standaloneChatId and its project', () => {
    expect(
      automationRunResultFromChatSend(
        record({
          kind: 'project',
          projectId: 'cowork-1',
          taskId: 'entry-1',
          chatId: 'chat-1',
        }),
        'cowork',
      ),
    ).toStrictEqual({
      standaloneChatId: 'chat-1',
      projectId: 'cowork-1',
      userMessageId: 'input-1',
    });
  });

  it('maps a code project chat to its project, worktree and chat', () => {
    expect(
      automationRunResultFromChatSend(
        record({
          kind: 'project',
          projectId: 'code-1',
          taskId: 'worktree-1',
          chatId: 'chat-1',
        }),
        'code',
      ),
    ).toStrictEqual({
      projectId: 'code-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'input-1',
    });
  });
});

describe('lastChatSendRunResult (CAN-5381)', () => {
  it('is undefined for an execution that sent nothing', () => {
    expect(lastChatSendRunResult(state([]))).toBeUndefined();
  });

  it('takes the last send by completion, and reads Cowork from the registry', () => {
    expect(
      lastChatSendRunResult(
        state([
          {
            completedAt: '2026-10-29T00:00:05.000Z',
            send: record(
              {
                kind: 'project',
                projectId: 'cowork-1',
                taskId: 'entry-1',
                chatId: 'last',
              },
              'input-last',
            ),
          },
          {
            completedAt: '2026-10-29T00:00:01.000Z',
            send: record(
              {
                kind: 'project',
                projectId: 'code-1',
                taskId: 'worktree-1',
                chatId: 'first',
              },
              'input-first',
            ),
          },
        ]),
      ),
    ).toStrictEqual({
      standaloneChatId: 'last',
      projectId: 'cowork-1',
      userMessageId: 'input-last',
    });
  });
});

// CAN-4551: a converted automation's run gets its chat at send time.
describe('noteAutomationPipelineEvent', () => {
  function event(
    executionId: string,
    status: string,
    sends: Array<{ completedAt: string; send: PipelineChatSendRecord }>,
  ): ExecutionEvent {
    return {
      type: 'execution.updated',
      executionId,
      timestamp: '2026-10-29T00:00:10.000Z',
      state: {
        ...state(sends),
        status,
        initiator: { kind: 'automation', automationId: 'auto-1' },
      },
    } as unknown as ExecutionEvent;
  }
  const first = {
    completedAt: '2026-10-29T00:00:01.000Z',
    send: record(
      { kind: 'project', projectId: 'code-1', taskId: 'w', chatId: 'c' },
      'input-1',
    ),
  };
  const flush = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));

  it('hands over each new send once, and the end', async () => {
    noteAutomationPipelineEvent(event('exec-1', 'running', []));
    noteAutomationPipelineEvent(event('exec-1', 'running', [first]));
    noteAutomationPipelineEvent(event('exec-1', 'running', [first]));
    noteAutomationPipelineEvent(event('exec-1', 'success', [first]));
    await flush();
    expect(mockRecord.mock.calls.map(([e]) => e.state.status)).toEqual([
      'running',
      'success',
    ]);
  });

  it('ignores an execution an automation did not start', async () => {
    mockRecord.mockClear();
    const userRun = event('exec-2', 'success', [first]);
    noteAutomationPipelineEvent({
      ...userRun,
      state: { ...userRun.state, initiator: { kind: 'user' } },
    });
    await flush();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

import type {
  ExecutionState,
  JobResult,
  PipelineChatSendRecord,
  StepResult,
} from '@canopy/desktop-shared/types/pipeline';
import { listExecutionChatSends } from '../chat-sends';

function record(userMessageId: string): PipelineChatSendRecord {
  return {
    version: 1,
    address: { kind: 'project', projectId: 'p', taskId: 't', chatId: 'c' },
    userMessageId,
    state: 'sent',
    chatCreated: false,
    acceptedAt: '2026-10-28T00:00:00.000Z',
  };
}

function step(
  completedAt: string | undefined,
  chatSend?: PipelineChatSendRecord,
  status: StepResult['status'] = 'success',
): StepResult {
  return {
    status,
    outputs: {},
    dynamic_env: {},
    ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
    ...(chatSend !== undefined ? { chat_send: chatSend } : {}),
  };
}

function job(steps: Record<string, StepResult>): JobResult {
  return { status: 'success', steps, outputs: {} };
}

function state(jobs: Record<string, JobResult>): ExecutionState {
  // Only `jobs` matters to the selector.
  return { jobs } as unknown as ExecutionState;
}

const ids = (records: PipelineChatSendRecord[]): string[] =>
  records.map((entry) => entry.userMessageId);

describe('listExecutionChatSends', () => {
  it('returns [] for an execution without sends', () => {
    expect(listExecutionChatSends(state({}))).toEqual([]);
    expect(
      listExecutionChatSends(
        state({ a: job({ s: step('2026-01-01T00:00:00Z') }) }),
      ),
    ).toEqual([]);
  });

  it('orders sends by completion across jobs, including matrix variants', () => {
    const result = listExecutionChatSends(
      state({
        a: job({
          s1: step('2026-01-01T00:00:03Z', record('a1')),
          s2: step('2026-01-01T00:00:05Z', record('a2')),
        }),
        'b (os: mac)': job({
          s1: step('2026-01-01T00:00:04Z', record('b-mac')),
        }),
        'b (os: linux)': job({
          s1: step('2026-01-01T00:00:01Z', record('b-linux')),
          s2: step('2026-01-01T00:00:02Z'),
        }),
      }),
    );

    expect(ids(result)).toEqual(['b-linux', 'a1', 'b-mac', 'a2']);
  });

  it('keeps walk order for ties and missing timestamps', () => {
    const result = listExecutionChatSends(
      state({
        a: job({
          s1: step('2026-01-01T00:00:02Z', record('first')),
          s2: step(undefined, record('no-time')),
        }),
        b: job({
          s1: step('2026-01-01T00:00:02Z', record('tie')),
          s2: step('2026-01-01T00:00:01Z', record('earliest')),
        }),
      }),
    );

    expect(ids(result)).toEqual(['earliest', 'first', 'no-time', 'tie']);
  });

  it('includes a failed step that recorded a send', () => {
    const result = listExecutionChatSends(
      state({
        a: job({
          s1: step('2026-01-01T00:00:01Z', record('failed'), 'failure'),
        }),
      }),
    );

    expect(ids(result)).toEqual(['failed']);
  });
});

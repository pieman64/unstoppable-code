import { findPendingAskUserQuestion } from '../ask-user-pending-match';
import type { PendingQuestion } from '@/stores/chatStore';

function pendingQuestion(
  requestId: string,
  toolUseId?: string,
): PendingQuestion {
  return {
    requestId,
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    questions: [{ id: 'q1', question: 'Pick one', options: ['a'] }],
    ...(toolUseId ? { toolUseId } : {}),
  };
}

describe('findPendingAskUserQuestion', () => {
  it('does not attach an async question to a blocking tool row', () => {
    const asyncQuestion: PendingQuestion = {
      ...pendingQuestion('async'),
      delivery: 'async',
    };
    const blocking = pendingQuestion('blocking');
    expect(
      findPendingAskUserQuestion(
        [asyncQuestion, blocking],
        'mcp__canopy__AskUserQuestion',
        'tool',
      ),
    ).toBe(blocking);
  });

  it('matches deterministic Codex toolUseId values exactly', () => {
    const firstPending = pendingQuestion('codex-call-a', 'codex-call-a');
    const secondPending = pendingQuestion('codex-call-b', 'codex-call-b');

    expect(
      findPendingAskUserQuestion(
        [firstPending, secondPending],
        'canopy_ask_user_question',
        'codex-call-b',
      ),
    ).toBe(secondPending);
  });

  it('matches Codex built-in request_user_input toolUseId values exactly', () => {
    const firstPending = pendingQuestion('codex-item-a', 'codex-item-a');
    const secondPending = pendingQuestion('codex-item-b', 'codex-item-b');

    expect(
      findPendingAskUserQuestion(
        [firstPending, secondPending],
        'request_user_input',
        'codex-item-b',
      ),
    ).toBe(secondPending);
  });

  it('does not fall back to another pending question when a Codex toolUseId misses', () => {
    const firstPending = pendingQuestion('codex-call-a', 'codex-call-a');

    expect(
      findPendingAskUserQuestion(
        [firstPending],
        'canopy_ask_user_question',
        'codex-call-missing',
      ),
    ).toBeUndefined();
  });

  it('keeps the first-unanswered fallback for Claude rows with Claude-generated toolUseId', () => {
    const answeredPending = {
      ...pendingQuestion('claude-answered'),
      answeredAt: 123,
    };
    const unansweredPending = pendingQuestion('claude-unanswered');

    expect(
      findPendingAskUserQuestion(
        [answeredPending, unansweredPending],
        'mcp__canopy__AskUserQuestion',
        'toolu_01claude',
      ),
    ).toBe(unansweredPending);
  });
});

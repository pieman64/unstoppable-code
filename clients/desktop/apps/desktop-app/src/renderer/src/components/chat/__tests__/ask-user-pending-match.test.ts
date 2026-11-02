import { findAskUserQuestionRecordState } from '../ask-user-pending-match';
import type { PendingQuestion } from '@/stores/chatStore';

const PICK_INPUT = JSON.stringify({
  questions: [{ question: 'Pick one', options: ['a'] }],
});

function pendingQuestion(
  requestId: string,
  toolUseId?: string,
  question = 'Pick one',
): PendingQuestion {
  return {
    requestId,
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    questions: [{ id: 'q1', question, options: ['a'] }],
    ...(toolUseId ? { toolUseId } : {}),
  };
}

function answered(pending: PendingQuestion, choice = 'a'): PendingQuestion {
  return {
    ...pending,
    answeredAt: 123,
    answers: [
      { question: pending.questions[0].question, selectedOptions: [choice] },
    ],
  };
}

describe('findAskUserQuestionRecordState', () => {
  it('does not attach an async question to a blocking tool row', () => {
    const asyncQuestion: PendingQuestion = {
      ...pendingQuestion('async'),
      delivery: 'async',
    };
    const blocking = pendingQuestion('blocking');
    expect(
      findAskUserQuestionRecordState(
        [asyncQuestion, blocking],
        'mcp__canopy__AskUserQuestion',
        'tool',
        PICK_INPUT,
      ),
    ).toEqual({ kind: 'unanswered', record: blocking });
    expect(
      findAskUserQuestionRecordState(
        [answered({ ...asyncQuestion })],
        'mcp__canopy__AskUserQuestion',
        'tool',
        PICK_INPUT,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('matches deterministic Codex toolUseId values exactly', () => {
    const firstPending = pendingQuestion('codex-call-a', 'codex-call-a');
    const secondPending = pendingQuestion('codex-call-b', 'codex-call-b');

    expect(
      findAskUserQuestionRecordState(
        [firstPending, secondPending],
        'canopy_ask_user_question',
        'codex-call-b',
        PICK_INPUT,
      ),
    ).toEqual({ kind: 'unanswered', record: secondPending });
  });

  it('matches Codex built-in request_user_input toolUseId values exactly', () => {
    const firstPending = pendingQuestion('codex-item-a', 'codex-item-a');
    const secondPending = pendingQuestion('codex-item-b', 'codex-item-b');

    expect(
      findAskUserQuestionRecordState(
        [firstPending, secondPending],
        'request_user_input',
        'codex-item-b',
        PICK_INPUT,
      ),
    ).toEqual({ kind: 'unanswered', record: secondPending });
  });

  it('does not fall back to another question when a Codex toolUseId misses', () => {
    const idless = answered(pendingQuestion('idless'));

    expect(
      findAskUserQuestionRecordState(
        [pendingQuestion('codex-call-a', 'codex-call-a'), idless],
        'canopy_ask_user_question',
        'codex-call-missing',
        PICK_INPUT,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('matches Claude rows by ordered question text when the record has no id', () => {
    const other = pendingQuestion('other', undefined, 'Something else');
    const mine = answered(pendingQuestion('mine'), 'a');

    expect(
      findAskUserQuestionRecordState(
        [other, mine],
        'mcp__canopy__AskUserQuestion',
        'toolu_01claude',
        PICK_INPUT,
      ),
    ).toEqual({
      kind: 'answered',
      answers: [{ question: 'Pick one', answer: 'a' }],
    });
  });

  it('never leaks the answer of a record with a different id', () => {
    const elsewhere = answered(pendingQuestion('elsewhere', 'toolu_other'));

    expect(
      findAskUserQuestionRecordState(
        [elsewhere],
        'mcp__canopy__AskUserQuestion',
        'toolu_mine',
        PICK_INPUT,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('attaches nothing to repeated identical questions without identity', () => {
    const first = answered(pendingQuestion('first'), 'a');
    const second = pendingQuestion('second');

    expect(
      findAskUserQuestionRecordState(
        [first, second],
        'mcp__canopy__AskUserQuestion',
        'toolu_01claude',
        PICK_INPUT,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('keeps a dismissed record settled without exposing an answer', () => {
    const contradictory: PendingQuestion = {
      ...answered(pendingQuestion('dismissed', 'codex-call-a')),
      dismissedAt: 456,
    };

    expect(
      findAskUserQuestionRecordState(
        [contradictory],
        'canopy_ask_user_question',
        'codex-call-a',
        PICK_INPUT,
      ),
    ).toEqual({ kind: 'dismissed' });
  });

  it('marks secret answers so freeform text stays hidden', () => {
    const secret: PendingQuestion = {
      ...pendingQuestion('secret', 'codex-call-s'),
      questions: [{ question: 'Token?', options: [], secret: true }],
      answeredAt: 1,
      answers: [
        { question: 'Token?', selectedOptions: [], freeformText: '[hidden]' },
      ],
    };

    expect(
      findAskUserQuestionRecordState(
        [secret],
        'canopy_ask_user_question',
        'codex-call-s',
        JSON.stringify({ questions: [{ question: 'Token?' }] }),
      ),
    ).toEqual({
      kind: 'answered',
      answers: [
        {
          question: 'Token?',
          answer: '',
          additional: '[hidden]',
          secret: true,
        },
      ],
    });
  });
});

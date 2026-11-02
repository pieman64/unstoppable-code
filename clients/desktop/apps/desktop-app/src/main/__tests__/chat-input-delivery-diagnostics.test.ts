import {
  CHAT_INPUT_DELIVERY_FAILURES,
  CHAT_INPUT_REFUSALS,
  chatInputDeliveryFailure,
} from '@canopy/protocol/portal/input-delivery';
import { buildChatSessionKey } from '../agents/session-key';
import {
  chatInputDeliveryOutcomeDiagnostic,
  chatInputOrigin,
  recordChatInputDeliveryOutcome,
  unknownDeliveryOutcome,
  type ChatInputDeliveryOutcomeFacts,
} from '../lib/chat-input-delivery-diagnostics';

const TARGET = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };

function facts(
  overrides: Partial<ChatInputDeliveryOutcomeFacts> &
    Pick<ChatInputDeliveryOutcomeFacts, 'outcome'>,
): ChatInputDeliveryOutcomeFacts {
  return {
    ...TARGET,
    provider: 'codex',
    attemptId: 'attempt-1',
    generation: 'generation-1',
    origin: 'typed',
    createdAt: 1_000,
    nowMs: 0,
    ...overrides,
  };
}

const BASE_RECORD = {
  version: 1,
  timestamp: '1970-01-01T00:00:00.000Z',
  kind: 'chat_input_delivery_outcome',
  sessionKey: buildChatSessionKey('project', 'worktree', 'chat'),
  ...TARGET,
  providerType: 'codex',
  inputAttemptId: 'attempt-1',
  inputGeneration: 'generation-1',
  inputOrigin: 'typed',
};

describe('chat input delivery outcome diagnostics', () => {
  it('records a pickup with only the observed phase timings', () => {
    expect(
      chatInputDeliveryOutcomeDiagnostic(
        facts({
          outcome: 'picked-up',
          provider: 'claude',
          origin: 'watcher',
          admittedAt: 1_250,
          pickedUpAt: 1_900,
          // A pickup carries no error even when stray metadata is passed.
          refusal: { code: 'no-active-turn' },
          failure: { code: 'process-exit' },
        }),
      ),
    ).toEqual({
      ...BASE_RECORD,
      providerType: 'claude',
      inputOrigin: 'watcher',
      inputDeliveryOutcome: 'picked-up',
      inputPhaseTimingsMs: { admitted: 250, pickedUp: 900 },
    });
  });

  it('records a requeued refusal with its code and fixed summary', () => {
    expect(
      chatInputDeliveryOutcomeDiagnostic(
        facts({
          outcome: 'rejected-requeued',
          admittedAt: 1_010,
          refusal: { code: 'turn-id-mismatch', summary: 'provider text' },
        }),
      ),
    ).toEqual({
      ...BASE_RECORD,
      inputDeliveryOutcome: 'rejected-requeued',
      inputPhaseTimingsMs: { admitted: 10 },
      inputErrorClass: 'refusal',
      inputErrorCode: 'turn-id-mismatch',
      inputErrorSummary: CHAT_INPUT_REFUSALS['turn-id-mismatch'],
    });
  });

  it('records a final refusal without metadata as its class alone', () => {
    expect(
      chatInputDeliveryOutcomeDiagnostic(facts({ outcome: 'rejected-final' })),
    ).toEqual({
      ...BASE_RECORD,
      inputDeliveryOutcome: 'rejected-final',
      inputErrorClass: 'refusal',
    });
  });

  it.each([
    ['unknown-timeout', 'delivery-deadline', 'timeout'],
    ['unknown-transport', 'enqueue-failed', 'transport'],
    ['unknown-restart', 'process-exit', 'restart'],
  ] as const)(
    'records %s from its failure code',
    (outcome, code, errorClass) => {
      expect(
        chatInputDeliveryOutcomeDiagnostic(
          facts({
            outcome,
            uncertainAt: 4_000,
            failure: { code, class: 'restart', summary: 'provider text' },
          }),
        ),
      ).toEqual({
        ...BASE_RECORD,
        inputDeliveryOutcome: outcome,
        inputPhaseTimingsMs: { uncertain: 3_000 },
        inputErrorClass: errorClass,
        inputErrorCode: code,
        inputErrorSummary: CHAT_INPUT_DELIVERY_FAILURES[code].summary,
      });
    },
  );

  it.each([
    ['absent', undefined],
    ['malformed', { code: 'bogus', class: 'timeout', summary: 'x' }],
  ])('records transport-error for an %s failure', (_label, failure) => {
    expect(
      chatInputDeliveryOutcomeDiagnostic(
        facts({ outcome: 'unknown-transport', failure }),
      ),
    ).toEqual({
      ...BASE_RECORD,
      inputDeliveryOutcome: 'unknown-transport',
      inputErrorClass: 'transport',
      inputErrorCode: 'transport-error',
      inputErrorSummary:
        CHAT_INPUT_DELIVERY_FAILURES['transport-error'].summary,
    });
  });

  it('records withdrawals and history outcomes without error fields', () => {
    for (const outcome of [
      'withdrawn',
      'history-delivered',
      'history-not-delivered',
    ] as const) {
      expect(
        chatInputDeliveryOutcomeDiagnostic(
          facts({
            outcome,
            withdrawnAt: 1_500,
            completedAt: 2_000,
            refusal: { code: 'no-active-turn' },
            failure: { code: 'host-restart' },
          }),
        ),
      ).toEqual({
        ...BASE_RECORD,
        inputDeliveryOutcome: outcome,
        inputPhaseTimingsMs: { withdrawn: 500, completed: 1_000 },
      });
    }
  });

  it('never reports a negative timing or a phase without a finite time', () => {
    const record = chatInputDeliveryOutcomeDiagnostic(
      facts({
        outcome: 'picked-up',
        admittedAt: 500,
        pickedUpAt: Number.NaN,
        withdrawnAt: undefined,
        completedAt: Number.POSITIVE_INFINITY,
        uncertainAt: 1_000,
      }),
    );
    expect(record.inputPhaseTimingsMs).toEqual({ admitted: 0, uncertain: 0 });
    expect(record.inputPhaseTimingsMs).not.toHaveProperty('pickedUp');
    expect(record.inputPhaseTimingsMs).not.toHaveProperty('withdrawn');
    expect(record.inputPhaseTimingsMs).not.toHaveProperty('completed');
  });

  it('omits the timing map when no phase was observed', () => {
    expect(
      chatInputDeliveryOutcomeDiagnostic(
        facts({ outcome: 'picked-up', pickedUpAt: Number.NaN }),
      ),
    ).not.toHaveProperty('inputPhaseTimingsMs');
  });

  it('bounds the attempt and generation ids', () => {
    const record = chatInputDeliveryOutcomeDiagnostic(
      facts({
        outcome: 'picked-up',
        attemptId: 'a'.repeat(500),
        generation: 'g'.repeat(500),
      }),
    );
    expect(record.inputAttemptId).toHaveLength(200);
    expect(record.inputGeneration).toHaveLength(200);
  });

  it('never lets a failing sink change delivery', () => {
    const sink = jest.fn(() => {
      throw new Error('storage unavailable');
    });
    expect(() =>
      recordChatInputDeliveryOutcome(facts({ outcome: 'withdrawn' }), sink),
    ).not.toThrow();
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ inputDeliveryOutcome: 'withdrawn' }),
    );
  });
});

describe('unknownDeliveryOutcome', () => {
  it.each([
    ['steer-timeout', 'unknown-timeout'],
    ['handoff-error', 'unknown-transport'],
    ['session-ended', 'unknown-restart'],
  ] as const)('maps %s to %s', (code, outcome) => {
    expect(unknownDeliveryOutcome({ code, class: 'timeout' })).toEqual({
      outcome,
      failure: chatInputDeliveryFailure(code),
    });
  });

  it.each([
    ['absent', undefined],
    ['malformed', { code: 'bogus', class: 'timeout', summary: 'x' }],
    ['an Error', new Error('delivery-deadline')],
  ])('defaults an %s failure to transport-error', (_label, failure) => {
    expect(unknownDeliveryOutcome(failure)).toEqual({
      outcome: 'unknown-transport',
      failure: chatInputDeliveryFailure('transport-error'),
    });
  });
});

describe('chatInputOrigin', () => {
  it('classifies each origin', () => {
    expect(chatInputOrigin({ asyncQuestionId: 'question' })).toBe('answer');
    expect(chatInputOrigin({ watcherFired: { kind: 'Pipeline' } })).toBe(
      'watcher',
    );
    expect(chatInputOrigin({ managedDelegationDeliveryId: 'delivery' })).toBe(
      'internal',
    );
    expect(chatInputOrigin({ initiationSource: 'automation' })).toBe(
      'internal',
    );
    expect(chatInputOrigin({ initiationSource: 'user' })).toBe('typed');
    expect(chatInputOrigin({})).toBe('typed');
    expect(chatInputOrigin(undefined)).toBe('typed');
  });

  it('prefers an answer, then a watcher, then internal delivery', () => {
    expect(
      chatInputOrigin({
        asyncQuestionId: 'question',
        watcherFired: { kind: 'Pipeline' },
        managedDelegationDeliveryId: 'delivery',
      }),
    ).toBe('answer');
    expect(
      chatInputOrigin({
        watcherFired: { kind: 'Pipeline' },
        managedDelegationDeliveryId: 'delivery',
        initiationSource: 'automation',
      }),
    ).toBe('watcher');
  });

  it('treats an empty delivery or question id as typed', () => {
    expect(chatInputOrigin({ managedDelegationDeliveryId: '' })).toBe('typed');
    expect(chatInputOrigin({ asyncQuestionId: '' })).toBe('typed');
  });
});

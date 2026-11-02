import { parseInputDeliveryViews } from '@canopy/protocol/portal';
import {
  detachInputDelivery,
  inputDeliveryViews,
  isInputLedger,
  type InputLedger,
} from '../chat-input-delivery';
import type { PersistedChatTab } from '../types';

type Row = InputLedger['rows'][number];

function ledger(rowPatch: Partial<Row> = {}): InputLedger {
  return {
    version: 1,
    epoch: 2,
    rows: [
      {
        id: 'row-1',
        revision: 2,
        createdAt: 1,
        state: 'cancelled',
        text: 'Watcher fired',
        settingsKey: 'settings',
        payload: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'row-1',
          text: 'Watcher fired',
        },
        attempts: [
          {
            id: 'attempt-1',
            generation: 'generation-1',
            provider: 'codex',
            createdAt: 2,
            target: { sessionId: 'thread-1', turnId: 'turn-1' },
          },
        ],
        currentAttemptId: 'attempt-1',
        notDelivered: { attemptId: 'attempt-1', at: 3 },
        ...rowPatch,
      },
    ],
  };
}

function only(value: InputLedger): Row {
  const [row] = value.rows;
  if (!row) throw new Error('missing row');
  return row;
}

describe('delivery history fields', () => {
  it('accepts a target and a not-delivered marker and rejects malformed ones', () => {
    expect(isInputLedger(ledger())).toBe(true);
    const base = only(ledger());
    const [attempt] = base.attempts;
    for (const malformedRow of [
      { notDelivered: { attemptId: '', at: 3 } },
      { notDelivered: { attemptId: 'attempt-1', at: -1 } },
      { notDelivered: true },
      { attempts: [{ ...attempt, target: { sessionId: '' } }] },
      {
        attempts: [
          { ...attempt, target: { sessionId: 'thread-1', turnId: 7 } },
        ],
      },
      { attempts: [{ ...attempt, target: 'thread-1' }] },
    ]) {
      expect(
        isInputLedger({ ...ledger(), rows: [{ ...base, ...malformedRow }] }),
      ).toBe(false);
    }
  });

  it('shows Not delivered only for the cancelled current attempt', () => {
    expect(inputDeliveryViews(ledger())[0]?.notDelivered).toBe(true);
    expect(
      inputDeliveryViews(ledger({ state: 'editing' }))[0]?.notDelivered,
    ).toBeUndefined();
    expect(
      inputDeliveryViews(ledger({ currentAttemptId: undefined }))[0]
        ?.notDelivered,
    ).toBeUndefined();
  });

  it('parses the view flag for the web', () => {
    const [view] = parseInputDeliveryViews(inputDeliveryViews(ledger()));
    expect(view?.notDelivered).toBe(true);
    const [plain] = parseInputDeliveryViews(
      inputDeliveryViews(ledger({ notDelivered: undefined })),
    );
    expect(plain).not.toHaveProperty('notDelivered');
  });

  it('flags generated rows so only typed rows offer Edit', () => {
    const base = only(ledger());
    const generated = (payloadPatch: object): boolean | undefined =>
      parseInputDeliveryViews(
        inputDeliveryViews({
          ...ledger(),
          rows: [{ ...base, payload: { ...base.payload, ...payloadPatch } }],
        }),
      )[0]?.generated;
    expect(generated({})).toBeUndefined();
    expect(generated({ watcherFired: { kind: 'pipeline' } })).toBe(true);
    expect(generated({ asyncQuestionId: 'question-1' })).toBe(true);
    expect(
      generated({ initiationSource: 'automation', automationName: 'Nightly' }),
    ).toBe(true);
  });

  it('drops the marker but keeps the target on copied rows', () => {
    const tab: PersistedChatTab = {
      id: 'chat-1',
      title: 'Source',
      createdAt: '2026-10-16T00:00:00.000Z',
      messages: [],
      inputDelivery: ledger(),
    };
    const detached = detachInputDelivery(
      tab,
      { projectId: 'project-2', worktreeId: 'worktree-2', chatId: 'chat-2' },
      () => 'row-copied',
    );
    const [row] = detached && isInputLedger(detached) ? detached.rows : [];
    expect(row?.notDelivered).toBeUndefined();
    expect(row?.attempts[0]?.target).toEqual({
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });
  });
});

import {
  detachInputDelivery,
  isInputLedger,
  validOrdinaryContinuation,
  type InputLedger,
} from '../chat-input-delivery';
import type { PersistedChatTab } from '../types';

type Row = InputLedger['rows'][number];

function ledger(rowPatch: Partial<Row> = {}, epoch = 4): InputLedger {
  return {
    version: 1,
    epoch,
    rows: [
      {
        id: 'row-1',
        revision: 3,
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
          watcherFired: { kind: 'pipeline' },
        },
        attempts: [
          {
            id: 'attempt-1',
            generation: 'generation-1',
            provider: 'codex',
            createdAt: 2,
            submittedText: 'Watcher fired',
            displayText: 'Watcher fired',
          },
        ],
        currentAttemptId: 'attempt-1',
        ordinaryContinuation: { attemptId: 'attempt-1', epoch },
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

describe('ordinary continuation fields', () => {
  it('accepts well-formed fields and rejects malformed ones', () => {
    expect(isInputLedger(ledger())).toBe(true);
    expect(isInputLedger(ledger({ ordinaryOnly: true }))).toBe(true);
    const base = only(ledger());
    for (const malformed of [
      { ordinaryContinuation: { attemptId: '', epoch: 4 } },
      { ordinaryContinuation: { attemptId: 'attempt-1', epoch: -1 } },
      { ordinaryContinuation: 'attempt-1' },
      { ordinaryOnly: false },
    ]) {
      expect(
        isInputLedger({ ...ledger(), rows: [{ ...base, ...malformed }] }),
      ).toBe(false);
    }
  });

  it('owes the continuation only while its attempt is current and unchanged', () => {
    const valid = ledger();
    expect(validOrdinaryContinuation(valid, only(valid))).toEqual({
      attemptId: 'attempt-1',
      epoch: 4,
    });

    const superseded: Array<[string, InputLedger]> = [
      ['an edit or a queue', ledger({ state: 'editing' })],
      // Edit, then close the editor without saving: the row is cancelled
      // again with its original text, but the unsaved draft must survive.
      ['an unsaved draft', ledger({ draft: 'Edited but not saved' })],
      ['a queued restore', ledger({ state: 'queued' })],
      ['an edited text', ledger({ text: 'Edited' })],
      ['a resend', ledger({ currentAttemptId: undefined })],
      [
        'a pickup',
        ledger({
          attempts: [
            {
              id: 'attempt-1',
              generation: 'generation-1',
              provider: 'codex',
              createdAt: 2,
              displayText: 'Watcher fired',
              pickedUpAt: 5,
            },
          ],
        }),
      ],
      [
        'an attempt without its text',
        ledger({
          attempts: [
            {
              id: 'attempt-1',
              generation: 'generation-1',
              provider: 'codex',
              createdAt: 2,
            },
          ],
        }),
      ],
      ['no continuation', ledger({ ordinaryContinuation: undefined })],
    ];
    for (const [, value] of superseded) {
      expect(validOrdinaryContinuation(value, only(value))).toBeUndefined();
    }

    // Stop and Interrupt start a new ledger epoch.
    const stopped = { ...valid, epoch: 5 };
    expect(validOrdinaryContinuation(stopped, only(stopped))).toBeUndefined();
  });

  it('keeps the continuation through evidence-only revision bumps', () => {
    const bumped = ledger({ revision: 9 });
    expect(validOrdinaryContinuation(bumped, only(bumped))).toBeDefined();
  });

  it('drops both fields from rows copied to another chat', () => {
    const tab: PersistedChatTab = {
      id: 'chat-1',
      title: 'Source',
      createdAt: '2026-10-16T00:00:00.000Z',
      messages: [],
      // A generated row is not copied at all, so use an ordinary one.
      inputDelivery: ledger({
        ordinaryOnly: true,
        payload: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'row-1',
          text: 'Watcher fired',
        },
      }),
    };
    const detached = detachInputDelivery(
      tab,
      { projectId: 'project-2', worktreeId: 'worktree-2', chatId: 'chat-2' },
      () => 'row-copied',
    );
    const [row] = detached && isInputLedger(detached) ? detached.rows : [];
    expect(row).toBeDefined();
    expect(row?.ordinaryContinuation).toBeUndefined();
    expect(row?.ordinaryOnly).toBeUndefined();
  });
});

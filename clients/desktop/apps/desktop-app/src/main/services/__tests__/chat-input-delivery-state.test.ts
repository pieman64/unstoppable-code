import type {
  ChatInputAttempt,
  ChatInputDeliveryEvent,
} from '@canopy/protocol/portal';
import type { ChatSendMessageRequest } from '@canopy/desktop-shared/types';
import {
  inputHistoryVerdict,
  isHistoryCandidate,
  observeInputDelivery,
  resolveInputHistoryNotDelivered,
  restoreInputLedger,
  type InputLedger,
  type InputRow,
} from '../chat-input-delivery-state';

const LIVE = 'generation-live';
const OLD = 'generation-old';
const UNCERTAIN_REASON = 'The provider did not confirm the message in time.';

const payload: ChatSendMessageRequest = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  userMessageId: 'message-1',
  text: 'hello',
};

type Attempt = ChatInputAttempt<ChatSendMessageRequest>;

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: 'attempt-1',
    generation: LIVE,
    provider: 'claude',
    createdAt: 1,
    ...overrides,
  };
}

function row(overrides: Partial<InputRow> = {}): InputRow {
  return {
    id: 'message-1',
    revision: 1,
    createdAt: 1,
    state: 'sending',
    text: 'hello',
    payload,
    settingsKey: 'settings-1',
    currentAttemptId: 'attempt-1',
    attempts: [attempt()],
    ...overrides,
  };
}

function ledgerOf(...rows: InputRow[]): InputLedger {
  return { version: 1, epoch: 0, rows };
}

function event(
  phase: ChatInputDeliveryEvent['phase'],
  overrides: Partial<ChatInputDeliveryEvent> = {},
): ChatInputDeliveryEvent {
  return {
    type: 'canopy_input_delivery',
    provider: 'claude',
    generation: LIVE,
    attemptId: 'attempt-1',
    phase,
    ...overrides,
  };
}

function onlyRow(ledger: InputLedger): InputRow {
  const [first] = ledger.rows;
  if (!first) throw new Error('expected one row');
  return first;
}

function currentAttempt(ledger: InputLedger): Attempt {
  const current = onlyRow(ledger);
  const found = current.attempts.find((a) => a.id === current.currentAttemptId);
  if (!found) throw new Error('expected a current attempt');
  return found;
}

function currentAttemptIdOf(value: InputRow): string {
  const id = value.currentAttemptId;
  if (id === undefined) throw new Error('expected a current attempt id');
  return id;
}

/** A row the coordinator marked uncertain after an `unknown` event. */
function uncertainLedger(rowOverrides: Partial<InputRow> = {}): InputLedger {
  return ledgerOf(
    row({
      state: 'uncertain',
      reason: UNCERTAIN_REASON,
      attempts: [attempt({ uncertainAt: 10 })],
      ...rowOverrides,
    }),
  );
}

describe('observeInputDelivery', () => {
  describe('late acknowledgement', () => {
    it('returns an uncertain row to pending on a live-generation admission after the unknown, then to picked-up', () => {
      const unknown = observeInputDelivery(
        ledgerOf(row()),
        event('unknown'),
        10,
        LIVE,
      );
      expect(onlyRow(unknown).state).toBe('uncertain');

      const marked: InputLedger = {
        ...unknown,
        rows: [{ ...onlyRow(unknown), reason: UNCERTAIN_REASON }],
      };
      const accepted = observeInputDelivery(
        marked,
        event('accepted'),
        20,
        LIVE,
      );
      expect(onlyRow(accepted).state).toBe('pending');
      expect(onlyRow(accepted)).not.toHaveProperty('reason');
      expect(currentAttempt(accepted)).toMatchObject({
        uncertainAt: 10,
        admittedAt: 20,
      });

      const pickedUp = observeInputDelivery(
        accepted,
        event('picked-up'),
        30,
        LIVE,
      );
      expect(onlyRow(pickedUp).state).toBe('picked-up');
      expect(currentAttempt(pickedUp)).toMatchObject({
        uncertainAt: 10,
        admittedAt: 20,
        pickedUpAt: 30,
      });
    });

    it('takes a new failure after a late acknowledgement as fresh uncertainty', () => {
      const recovered = observeInputDelivery(
        uncertainLedger(),
        event('accepted'),
        20,
        LIVE,
      );
      expect(onlyRow(recovered).state).toBe('pending');

      const cancelling: InputLedger = {
        ...recovered,
        rows: [{ ...onlyRow(recovered), state: 'cancelling' }],
      };
      const sessionEnded = event('unknown', {
        failure: {
          class: 'restart',
          code: 'session-ended',
          summary: 'The provider session ended before confirming the message.',
        },
      });
      for (const next of [
        // A withdrawal requested after the revival went unconfirmed.
        observeInputDelivery(cancelling, event('unknown'), 30, LIVE),
        // The session ended.
        observeInputDelivery(recovered, sessionEnded, 30, LIVE),
        observeInputDelivery(recovered, event('unknown'), 30, 'generation-new'),
      ]) {
        expect(onlyRow(next).state).toBe('uncertain');
        expect(currentAttempt(next)).toMatchObject({
          admittedAt: 20,
          uncertainAt: 30,
        });
      }
    });

    it('keeps a revived row pending when a delayed copy of the earlier unknown arrives', () => {
      // A failed withdrawal reports unknown twice: its event and its result.
      const withdrawing = ledgerOf(row({ state: 'cancelling' }));
      const eventCopy = observeInputDelivery(
        withdrawing,
        event('unknown'),
        10,
        LIVE,
      );
      expect(onlyRow(eventCopy).state).toBe('uncertain');
      const revived = observeInputDelivery(
        eventCopy,
        event('accepted'),
        20,
        LIVE,
      );
      expect(onlyRow(revived).state).toBe('pending');
      expect(observeInputDelivery(revived, event('unknown'), 30, LIVE)).toBe(
        revived,
      );
    });

    it('ignores a duplicate unknown on a row that is still uncertain', () => {
      const ledger = uncertainLedger();
      expect(observeInputDelivery(ledger, event('unknown'), 30, LIVE)).toBe(
        ledger,
      );
    });

    it('keeps the row uncertain when no live generation is known', () => {
      const next = observeInputDelivery(
        uncertainLedger(),
        event('accepted'),
        20,
      );
      expect(onlyRow(next).state).toBe('uncertain');
      expect(onlyRow(next).reason).toBe(UNCERTAIN_REASON);
      expect(currentAttempt(next).admittedAt).toBe(20);
    });

    it('keeps the row uncertain when the admission comes from a generation other than the live one', () => {
      const ledger = uncertainLedger({
        attempts: [attempt({ generation: OLD, uncertainAt: 10 })],
      });
      const next = observeInputDelivery(
        ledger,
        event('accepted', { generation: OLD }),
        20,
        LIVE,
      );
      expect(onlyRow(next).state).toBe('uncertain');
      expect(onlyRow(next).reason).toBe(UNCERTAIN_REASON);
    });

    it('never lets an older admission clear a newer unknown', () => {
      const accepted = observeInputDelivery(
        ledgerOf(row()),
        event('accepted'),
        5,
        LIVE,
      );
      expect(onlyRow(accepted).state).toBe('pending');
      const unknown = observeInputDelivery(
        accepted,
        event('unknown'),
        10,
        LIVE,
      );
      expect(onlyRow(unknown).state).toBe('uncertain');
      expect(currentAttempt(unknown)).toMatchObject({
        admittedAt: 5,
        uncertainAt: 10,
      });
    });

    it('keeps the row uncertain when the admission has the same timestamp as the unknown', () => {
      const next = observeInputDelivery(
        uncertainLedger(),
        event('accepted'),
        10,
        LIVE,
      );
      expect(onlyRow(next).state).toBe('uncertain');
      expect(onlyRow(next).reason).toBe(UNCERTAIN_REASON);
    });

    it('ignores a duplicate admission after the unknown and preserves ledger identity', () => {
      const ledger = uncertainLedger({
        attempts: [attempt({ admittedAt: 5, uncertainAt: 10 })],
      });
      const next = observeInputDelivery(ledger, event('accepted'), 20, LIVE);
      expect(next).toBe(ledger);
      expect(currentAttempt(next).admittedAt).toBe(5);
      expect(onlyRow(next).state).toBe('uncertain');
    });

    it('keeps dismissedAt when an uncertain row resolves to pending', () => {
      const next = observeInputDelivery(
        uncertainLedger({ dismissedAt: 15 }),
        event('accepted'),
        20,
        LIVE,
      );
      expect(onlyRow(next).state).toBe('pending');
      expect(onlyRow(next).dismissedAt).toBe(15);
    });
  });

  describe('superseded attempts', () => {
    const twoAttempts = (
      first: Partial<Attempt>,
      second: Partial<Attempt> = {},
    ): InputLedger =>
      ledgerOf(
        row({
          state: 'pending',
          currentAttemptId: 'attempt-2',
          attempts: [
            attempt({ id: 'attempt-1', ...first }),
            attempt({ id: 'attempt-2', admittedAt: 3, ...second }),
          ],
        }),
      );

    it('marks the row uncertain when a superseded attempt is picked up', () => {
      const next = observeInputDelivery(
        twoAttempts({ admittedAt: 2 }),
        event('picked-up', { attemptId: 'attempt-1' }),
        20,
        LIVE,
      );
      expect(onlyRow(next).state).toBe('uncertain');
      expect(onlyRow(next).reason).toMatch(/superseded delivery attempt/);
    });

    it('keeps the row state when a superseded attempt reports a non-pickup phase', () => {
      const next = observeInputDelivery(
        twoAttempts({}),
        event('accepted', { attemptId: 'attempt-1' }),
        20,
        LIVE,
      );
      expect(onlyRow(next).state).toBe('pending');
      expect(onlyRow(next).attempts[0]?.admittedAt).toBe(20);
    });

    it('keeps the row uncertain on a current-attempt event after another attempt was picked up', () => {
      const next = observeInputDelivery(
        twoAttempts({ pickedUpAt: 2 }, { admittedAt: undefined }),
        event('accepted', { attemptId: 'attempt-2' }),
        20,
        LIVE,
      );
      expect(onlyRow(next).state).toBe('uncertain');
      expect(onlyRow(next).reason).toMatch(/superseded delivery attempt/);
    });
  });

  it('treats a pickup followed by a withdrawal as uncertain', () => {
    const pickedUp = observeInputDelivery(
      ledgerOf(
        row({ state: 'pending', attempts: [attempt({ admittedAt: 2 })] }),
      ),
      event('picked-up'),
      10,
      LIVE,
    );
    expect(onlyRow(pickedUp).state).toBe('picked-up');
    const withdrawn = observeInputDelivery(
      pickedUp,
      event('withdrawn'),
      20,
      LIVE,
    );
    expect(onlyRow(withdrawn).state).toBe('uncertain');
  });

  describe('withdrawal and cancelling', () => {
    it('settles a cancelling row as cancelled on withdrawal', () => {
      const next = observeInputDelivery(
        ledgerOf(row({ state: 'cancelling' })),
        event('withdrawn'),
        10,
        LIVE,
      );
      expect(onlyRow(next).state).toBe('cancelled');
    });

    it.each(['editing', 'queued'] as const)(
      'keeps a %s row on withdrawal',
      (state) => {
        const next = observeInputDelivery(
          ledgerOf(row({ state })),
          event('withdrawn'),
          10,
          LIVE,
        );
        expect(onlyRow(next).state).toBe(state);
      },
    );

    it('keeps a cancelling row cancelling on an admission', () => {
      const next = observeInputDelivery(
        ledgerOf(row({ state: 'cancelling' })),
        event('accepted'),
        10,
        LIVE,
      );
      expect(onlyRow(next).state).toBe('cancelling');
    });
  });

  describe('a row made uncertain by recovery or Stop', () => {
    const recovered = (): InputLedger =>
      ledgerOf(
        row({
          state: 'uncertain',
          reason: UNCERTAIN_REASON,
          attempts: [attempt()],
        }),
      );

    it.each(['accepted', 'completed'] as const)(
      'stays uncertain on a later %s event',
      (phase) => {
        const next = observeInputDelivery(recovered(), event(phase), 20, LIVE);
        expect(onlyRow(next).state).toBe('uncertain');
        expect(onlyRow(next).reason).toBe(UNCERTAIN_REASON);
      },
    );

    it('still settles as picked-up on a pickup', () => {
      const next = observeInputDelivery(
        recovered(),
        event('picked-up'),
        20,
        LIVE,
      );
      expect(onlyRow(next).state).toBe('picked-up');
      expect(onlyRow(next)).not.toHaveProperty('reason');
    });

    it('still settles as cancelled on a confirmed withdrawal', () => {
      const next = observeInputDelivery(
        recovered(),
        event('withdrawn'),
        20,
        LIVE,
      );
      expect(onlyRow(next).state).toBe('cancelled');
    });
  });

  it.each([
    ['attempt id', { attemptId: 'attempt-other' }],
    ['generation', { generation: OLD }],
    ['provider', { provider: 'codex' as const }],
  ])('leaves the ledger unchanged for a mismatched %s', (_label, overrides) => {
    const ledger = ledgerOf(row());
    expect(
      observeInputDelivery(ledger, event('accepted', overrides), 10, LIVE),
    ).toBe(ledger);
  });
});

describe('restoreInputLedger', () => {
  it.each(['sending', 'pending', 'cancelling'] as const)(
    'marks an old-generation %s row uncertain',
    (state) => {
      const next = restoreInputLedger(
        ledgerOf(row({ state, attempts: [attempt({ generation: OLD })] })),
        LIVE,
      );
      expect(onlyRow(next).state).toBe('uncertain');
      expect(onlyRow(next).reason).toMatch(/session ended/);
    },
  );

  it('cancels an old-generation cancelling row that was moving to queued', () => {
    const next = restoreInputLedger(
      ledgerOf(
        row({
          state: 'cancelling',
          queueIntent: { commandId: 'command-1' },
          attempts: [attempt({ generation: OLD })],
        }),
      ),
      LIVE,
    );
    expect(onlyRow(next).state).toBe('cancelled');
  });

  it('leaves live-generation rows untouched', () => {
    const ledger = ledgerOf(row({ state: 'pending' }));
    expect(restoreInputLedger(ledger, LIVE)).toBe(ledger);
  });

  it('is a no-op when recovery repeats', () => {
    const once = restoreInputLedger(
      ledgerOf(
        row({ state: 'pending', attempts: [attempt({ generation: OLD })] }),
      ),
      LIVE,
    );
    expect(restoreInputLedger(once, LIVE)).toBe(once);
  });
});

describe('input history resolution', () => {
  describe('isHistoryCandidate', () => {
    it('selects uncertain rows and old-generation sending-like rows', () => {
      expect(isHistoryCandidate(onlyRow(uncertainLedger()), LIVE)).toBe(true);
      for (const state of ['sending', 'pending', 'cancelling'] as const) {
        expect(
          isHistoryCandidate(
            row({ state, attempts: [attempt({ generation: OLD })] }),
            LIVE,
          ),
        ).toBe(true);
      }
      expect(isHistoryCandidate(row({ state: 'pending' }))).toBe(true);
    });

    it('does not select live, dismissed, or delegated rows', () => {
      for (const state of ['sending', 'pending', 'cancelling'] as const) {
        expect(isHistoryCandidate(row({ state }), LIVE)).toBe(false);
      }
      expect(
        isHistoryCandidate(onlyRow(uncertainLedger({ dismissedAt: 0 })), LIVE),
      ).toBe(false);
      expect(
        isHistoryCandidate(
          onlyRow(
            uncertainLedger({
              payload: {
                ...payload,
                managedDelegationDeliveryId: 'delivery-1',
              },
            }),
          ),
          LIVE,
        ),
      ).toBe(false);
    });
  });

  describe('inputHistoryVerdict', () => {
    it('prefers the current attempt when any attempt was found', () => {
      const value = row({
        currentAttemptId: 'attempt-2',
        attempts: [attempt(), attempt({ id: 'attempt-2', generation: OLD })],
      });
      expect(
        inputHistoryVerdict(
          value,
          new Map([
            ['attempt-1', 'found'],
            ['attempt-2', 'found'],
          ]),
        ),
      ).toEqual({ kind: 'found', attemptId: 'attempt-2' });
    });

    it('returns not-found only when every nonempty attempt was checked and absent', () => {
      expect(
        inputHistoryVerdict(row(), new Map([['attempt-1', 'not-found']])),
      ).toEqual({ kind: 'not-found' });
      expect(inputHistoryVerdict(row(), new Map())).toEqual({
        kind: 'unreadable',
      });
      expect(inputHistoryVerdict(row({ attempts: [] }), new Map())).toEqual({
        kind: 'unreadable',
      });
      expect(
        inputHistoryVerdict(
          row({
            currentAttemptId: 'attempt-2',
            attempts: [attempt(), attempt({ id: 'attempt-2' })],
          }),
          new Map([['attempt-1', 'not-found']]),
        ),
      ).toEqual({ kind: 'unreadable' });
    });

    it('never reports not-found when an attempt already has pickup evidence', () => {
      expect(
        inputHistoryVerdict(
          row({ attempts: [attempt({ pickedUpAt: 10 })] }),
          new Map([['attempt-1', 'not-found']]),
        ),
      ).toEqual({ kind: 'found', attemptId: 'attempt-1' });
    });
  });

  describe('resolveInputHistoryNotDelivered', () => {
    it('cancels a proven-undelivered row and records generated continuation atomically', () => {
      const generatedRow = row({
        state: 'uncertain',
        reason: UNCERTAIN_REASON,
        payload: { ...payload, watcherFired: { kind: 'Pipeline completion' } },
      });
      const next = resolveInputHistoryNotDelivered(
        ledgerOf(generatedRow),
        generatedRow.id,
        currentAttemptIdOf(generatedRow),
        0,
        50,
        LIVE,
      );

      expect(onlyRow(next)).toMatchObject({
        revision: generatedRow.revision + 1,
        state: 'cancelled',
        notDelivered: { attemptId: 'attempt-1', at: 50 },
        ordinaryContinuation: { attemptId: 'attempt-1', epoch: 0 },
      });
      expect(onlyRow(next)).not.toHaveProperty('reason');
    });

    it('does not add a generated continuation to ordinary input', () => {
      const ordinary = row({ state: 'uncertain', reason: UNCERTAIN_REASON });
      const next = resolveInputHistoryNotDelivered(
        ledgerOf(ordinary),
        ordinary.id,
        currentAttemptIdOf(ordinary),
        0,
        50,
        LIVE,
      );
      expect(onlyRow(next).state).toBe('cancelled');
      expect(onlyRow(next)).not.toHaveProperty('ordinaryContinuation');
    });

    it.each([
      [
        'epoch',
        {
          epoch: 1,
          row: row({ state: 'uncertain' }),
          currentAttemptId: 'attempt-1',
        },
      ],
      [
        'current attempt',
        {
          epoch: 0,
          row: row({ state: 'uncertain' }),
          currentAttemptId: 'attempt-other',
        },
      ],
      [
        'candidate',
        {
          epoch: 0,
          row: row({ state: 'pending' }),
          currentAttemptId: 'attempt-1',
        },
      ],
    ] as const)('does not resolve a stale %s fence', (_label, fixture) => {
      const ledger = ledgerOf(fixture.row);
      expect(
        resolveInputHistoryNotDelivered(
          ledger,
          fixture.row.id,
          fixture.currentAttemptId,
          fixture.epoch,
          50,
          LIVE,
        ),
      ).toBe(ledger);
    });

    it('does not resolve a different row id', () => {
      const uncertain = row({ state: 'uncertain' });
      const ledger = ledgerOf(uncertain);
      expect(
        resolveInputHistoryNotDelivered(
          ledger,
          'message-other',
          currentAttemptIdOf(uncertain),
          0,
          50,
          LIVE,
        ),
      ).toBe(ledger);
    });
  });
});

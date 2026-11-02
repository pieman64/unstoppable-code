import type {
  ChatQueueUpdatedEvent,
  HostQueuedMessageView,
} from '@canopy/desktop-shared/types';
import {
  attachHostQueueSummariesFromQueueSnapshots,
  hostQueueViewsToQueuedMessages,
  normalizeWaitingDelegationIds,
  preserveHostQueueSummaryForTab,
  queuedRowForceAction,
  queuedRowTurnPhase,
  withHostQueueSummary,
} from '../queue-mirror';
import { fromPersistedTab, toPersistedTab } from '../persisted-tabs';
import type { ChatTab } from '../types';

function hostRow(
  overrides: Partial<HostQueuedMessageView> = {},
): HostQueuedMessageView {
  return {
    id: 'entry-1',
    text: 'queued text',
    origin: 'desktop',
    enqueuedAtMs: 1,
    ...overrides,
  };
}

describe('hostQueueViewsToQueuedMessages', () => {
  it('drops internal delegation rows, but not a row with only an internal marker', () => {
    const internalByDelivery = {
      ...hostRow({ id: 'internal-delivery' }),
      managedDelegationDeliveryId: 'delegation-1',
    };
    const internalByMarker = {
      ...hostRow({ id: 'internal-marker' }),
      internalRow: {
        kind: 'delegation-request' as const,
        delegationId: 'delegation-2',
        displayLine: 'Please inspect this change',
      },
    };

    expect(
      hostQueueViewsToQueuedMessages([
        internalByDelivery,
        internalByMarker,
        hostRow({ id: 'ordinary' }),
      ]),
    ).toEqual([
      // Only the host-issued delivery id makes a row internal; a marker alone
      // could be forged and must not hide anything.
      expect.objectContaining({ hostQueueEntryId: 'internal-marker' }),
      expect.objectContaining({ hostQueueEntryId: 'ordinary' }),
    ]);
  });

  it.each(['idle', 'background', 'foreground'] as const)(
    'keeps the host turn phase %s on the mirrored row',
    (turnPhase) => {
      const [row] = hostQueueViewsToQueuedMessages([hostRow({ turnPhase })]);

      expect(row?.hostQueueEntryId).toBe('entry-1');
      expect(row?.turnPhase).toBe(turnPhase);
    },
  );

  it('leaves the phase unset for a host that does not report one', () => {
    const [row] = hostQueueViewsToQueuedMessages([hostRow()]);

    expect(row).toBeDefined();
    expect(row && 'turnPhase' in row).toBe(false);
  });

  it('copies the host waiting reason to the mirrored row', () => {
    const [row] = hostQueueViewsToQueuedMessages([
      hostRow({ waitingReason: 'steer_unavailable' }),
    ]);

    expect(row?.waitingReason).toBe('steer_unavailable');
  });

  it('copies the background-work hold to the mirrored row', () => {
    const [row] = hostQueueViewsToQueuedMessages([
      hostRow({
        waitingReason: 'background_work',
        blockedByBackgroundWork: true,
      }),
    ]);

    expect(row?.waitingReason).toBe('background_work');
    expect(row?.blockedByBackgroundWork).toBe(true);
  });

  it('copies a transient retry block to the mirrored row, and only when reported', () => {
    const [held] = hostQueueViewsToQueuedMessages([
      hostRow({ retryBlockedReason: 'insufficient_credits' }),
    ]);
    const [ordinary] = hostQueueViewsToQueuedMessages([hostRow()]);

    expect(held?.retryBlockedReason).toBe('insufficient_credits');
    expect(ordinary && 'retryBlockedReason' in ordinary).toBe(false);
  });

  it('keeps funded held rows retryable through the real desktop mirror', () => {
    const [funded] = hostQueueViewsToQueuedMessages([
      hostRow({ retryable: true, turnPhase: 'foreground' }),
    ]);
    expect(funded?.retryable).toBe(true);
    expect(queuedRowForceAction(funded, 'streaming')).toBe('retry');
  });

  it('omits the waiting reason when the host does not report one', () => {
    const [row] = hostQueueViewsToQueuedMessages([hostRow()]);

    expect(row).toBeDefined();
    expect(row && 'waitingReason' in row).toBe(false);
  });

  it('follows a phase-only republish of the same row', () => {
    const [foreground] = hostQueueViewsToQueuedMessages([
      hostRow({ turnPhase: 'foreground', canSteer: true }),
    ]);
    const [background] = hostQueueViewsToQueuedMessages([
      hostRow({ turnPhase: 'background' }),
    ]);

    expect(foreground?.turnPhase).toBe('foreground');
    expect(foreground?.canSteer).toBe(true);
    expect(background?.turnPhase).toBe('background');
    expect(background && 'canSteer' in background).toBe(false);
  });
});

describe('normalizeWaitingDelegationIds', () => {
  it('filters empty ids, de-duplicates them, and preserves queue order', () => {
    expect(
      normalizeWaitingDelegationIds([
        'delegation-2',
        '',
        'delegation-1',
        'delegation-2',
      ]),
    ).toEqual(['delegation-2', 'delegation-1']);
  });

  it('returns one shared frozen empty array for missing or empty ids', () => {
    const missing = normalizeWaitingDelegationIds(undefined);
    const empty = normalizeWaitingDelegationIds(['', '']);

    expect(missing).toBe(empty);
    expect(Object.isFrozen(missing)).toBe(true);
  });
});

describe('queuedRowForceAction', () => {
  it.each(['foreground', 'background', 'idle'] as const)(
    'retries a credit-held host row in the %s phase, never interrupting',
    (turnPhase) => {
      expect(
        queuedRowForceAction(
          {
            hostQueueEntryId: 'entry-1',
            turnPhase,
            waitingReason: 'background_work',
            retryBlockedReason: 'insufficient_credits',
          },
          'streaming',
        ),
      ).toBe('retry');
    },
  );

  it('interrupts for a host-accepted row in the foreground or with no reported phase', () => {
    expect(
      queuedRowForceAction(
        { hostQueueEntryId: 'entry-1', turnPhase: 'foreground' },
        'idle',
      ),
    ).toBe('interrupt');
    expect(
      queuedRowForceAction({ hostQueueEntryId: 'entry-1' }, 'streaming'),
    ).toBe('interrupt');
  });

  it.each(['idle', 'background'] as const)(
    'retries a host row still queued in the %s phase',
    (turnPhase) => {
      expect(
        queuedRowForceAction(
          { hostQueueEntryId: 'entry-1', turnPhase },
          'streaming',
        ),
      ).toBe('retry');
    },
  );

  it.each(['foreground', 'idle'] as const)(
    'runs a background-work-held host row now even in the %s phase',
    (turnPhase) => {
      expect(
        queuedRowForceAction(
          {
            hostQueueEntryId: 'entry-1',
            turnPhase,
            waitingReason: 'background_work',
          },
          'streaming',
        ),
      ).toBe('run-now');
    },
  );

  it.each(['streaming', 'dispatching', 'recoverable', 'idle'] as const)(
    "keeps a host row's action independent of a %s local turn",
    (localTurn) => {
      expect(
        queuedRowForceAction(
          { hostQueueEntryId: 'entry-1', turnPhase: 'idle' },
          localTurn,
        ),
      ).toBe('retry');
      expect(
        queuedRowForceAction(
          { hostQueueEntryId: 'entry-1', turnPhase: 'foreground' },
          localTurn,
        ),
      ).toBe('interrupt');
      expect(
        queuedRowTurnPhase(
          { hostQueueEntryId: 'entry-1', turnPhase: 'background' },
          localTurn,
        ),
      ).toBe('background');
    },
  );

  it('runs a hook placeholder now', () => {
    expect(queuedRowForceAction({ queuedHookQueueId: 'hook-1' }, 'idle')).toBe(
      'run-now',
    );
  });

  it('interrupts the running turn for a local prompt behind it', () => {
    expect(queuedRowForceAction({}, 'streaming')).toBe('interrupt');
  });

  it('retries a local prompt kept after a failed or uncertain launch', () => {
    expect(queuedRowForceAction({}, 'recoverable')).toBe('retry');
  });

  it('offers no force action for a local prompt while its turn dispatches', () => {
    expect(queuedRowForceAction({}, 'dispatching')).toBeUndefined();
  });

  it('offers no Retry for a never-dispatched local prompt on an idle tab', () => {
    expect(queuedRowForceAction({}, 'idle')).toBeUndefined();
  });
});

describe('host queue summary mirroring', () => {
  function tab(id = 'chat-1'): ChatTab {
    return fromPersistedTab({
      id,
      title: `Chat ${id}`,
      messages: [],
      createdAt: '2026-10-16T00:00:00.000Z',
    });
  }

  function snapshot(
    values: Pick<ChatQueueUpdatedEvent, 'chatId' | 'waitingDelegationIds'> & {
      restartHeldByBackgroundWork?: true;
    },
  ): Pick<ChatQueueUpdatedEvent, 'chatId' | 'waitingDelegationIds'> & {
    restartHeldByBackgroundWork?: true;
  } {
    return values;
  }

  it('sets, retains and clears the per-chat restart-held flag from snapshots', () => {
    const original = tab();
    const held = attachHostQueueSummariesFromQueueSnapshots(
      [original],
      [snapshot({ chatId: original.id, restartHeldByBackgroundWork: true })],
    );

    expect(held[0]).toEqual(
      expect.objectContaining({ restartHeldByBackgroundWork: true }),
    );
    expect(
      attachHostQueueSummariesFromQueueSnapshots(held, [
        snapshot({ chatId: original.id, restartHeldByBackgroundWork: true }),
      ])[0],
    ).toBe(held[0]);

    const withoutFlag = attachHostQueueSummariesFromQueueSnapshots(held, [
      snapshot({ chatId: original.id }),
    ]);
    expect(withoutFlag[0]).not.toHaveProperty('restartHeldByBackgroundWork');

    const omittedChat = attachHostQueueSummariesFromQueueSnapshots(held, []);
    expect(omittedChat[0]).not.toHaveProperty('restartHeldByBackgroundWork');
  });

  it('preserves the prior host summary when a tab is rebuilt', () => {
    const original = tab();
    const withFlag = attachHostQueueSummariesFromQueueSnapshots(
      [original],
      [
        snapshot({
          chatId: original.id,
          waitingDelegationIds: ['delegation-1'],
          restartHeldByBackgroundWork: true,
        }),
      ],
    )[0];
    const rebuilt = tab();
    const preserved = preserveHostQueueSummaryForTab(withFlag, rebuilt);

    expect(preserved).toEqual(
      expect.objectContaining({
        waitingDelegationIds: ['delegation-1'],
        restartHeldByBackgroundWork: true,
      }),
    );
    expect(
      withHostQueueSummary(preserved, {
        waitingDelegationIds: ['delegation-1'],
        restartHeldByBackgroundWork: true,
      }),
    ).toBe(preserved);
  });

  it('keeps host queue summaries and mirror-only row fields out of persistence', () => {
    const chatTab = tab();
    const heldTab = withHostQueueSummary(chatTab, {
      restartHeldByBackgroundWork: true,
    });
    heldTab.queuedMessages = [
      {
        text: 'held prompt',
        hostQueueEntryId: 'entry-1',
        waitingReason: 'background_work',
        blockedByBackgroundWork: true,
      },
    ];

    const persisted = toPersistedTab(heldTab);

    expect(persisted).not.toHaveProperty('restartHeldByBackgroundWork');
    expect(persisted).not.toHaveProperty('waitingDelegationIds');
    expect(persisted).not.toHaveProperty('queuedMessages');
  });
});

describe('queuedRowTurnPhase', () => {
  it('uses the host phase for a host-accepted row', () => {
    expect(
      queuedRowTurnPhase(
        { hostQueueEntryId: 'entry-1', turnPhase: 'background' },
        'streaming',
      ),
    ).toBe('background');
    expect(
      queuedRowTurnPhase({ hostQueueEntryId: 'entry-1' }, 'streaming'),
    ).toBe(undefined);
  });

  it("uses the tab's own turn for a renderer-local row", () => {
    expect(queuedRowTurnPhase({}, 'streaming')).toBe('foreground');
    expect(queuedRowTurnPhase({}, 'idle')).toBe('idle');
  });

  it('puts a local row in the foreground from dispatch on', () => {
    expect(queuedRowTurnPhase({}, 'streaming')).toBe('foreground');
    expect(queuedRowTurnPhase({}, 'dispatching')).toBe('foreground');
    expect(queuedRowTurnPhase({}, 'recoverable')).toBe('idle');
    expect(queuedRowTurnPhase({}, 'idle')).toBe('idle');
  });
});

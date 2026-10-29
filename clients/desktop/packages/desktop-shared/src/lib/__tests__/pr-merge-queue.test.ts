import type {
  PrMergeQueueCursor,
  PrMergeQueueHistory,
  PrMergeQueueMembership,
  PrMergeQueuePendingExit,
  PrMergeQueuePhase,
  PrMergeQueueSnapshot,
  PrMergeQueueTimelineEvent,
} from '../../types/github';
import {
  buildPrQueueHookVariables,
  interpretPrMergeQueueHookSample,
  interpretPrMergeQueueTransition,
  isPrMergeQueueKnownPhase,
  PR_MERGE_QUEUE_KNOWN_PHASES,
  readMergeQueueEstimatedSeconds,
  readPrMergeQueueMembership,
  readPrMergeQueueSnapshot,
  type PrMergeQueueInterpretation,
  type PrMergeQueueInterpretationInput,
} from '../pr-merge-queue';

const T0 = '2026-10-07T10:00:00.000Z';
const T1 = '2026-10-07T10:01:00.000Z';
const T2 = '2026-10-07T10:02:00.000Z';
/** Late enough to release a merged-reason hold on removal at REMOVED_AT. */
const T3 = '2026-10-07T10:06:00.000Z';
const REMOVED_AT = '2026-10-07T10:00:30.000Z';

const OUT: PrMergeQueueMembership = {
  inQueue: false,
  entryId: null,
  enqueuedAt: null,
  position: null,
};

function queued(
  entryId: string | null,
  phase: PrMergeQueuePhase = 'queued',
  position: number | null = 1,
): PrMergeQueueMembership {
  return { inQueue: true, entryId, phase, enqueuedAt: T0, position };
}

function added(id: string): PrMergeQueueTimelineEvent {
  return { type: 'added', id, createdAt: T0 };
}

function removed(
  id: string,
  reason: string | null,
  createdAt = REMOVED_AT,
): PrMergeQueueTimelineEvent {
  return { type: 'removed', id, createdAt, reason };
}

function complete(
  events: PrMergeQueueTimelineEvent[],
  firstIndex = 0,
): PrMergeQueueHistory {
  return {
    status: 'complete',
    firstIndex,
    filteredCount: firstIndex + events.length,
    events,
  };
}

/** Cursor after the initial `added` event `a1`. */
const CURSOR_AFTER_ADD: PrMergeQueueCursor = { count: 1, lastEventId: 'a1' };

function interpret(
  overrides: Partial<PrMergeQueueInterpretationInput>,
): PrMergeQueueInterpretation {
  return interpretPrMergeQueueTransition({
    previous: OUT,
    next: OUT,
    state: 'open',
    history: complete([added('a1')]),
    cursor: CURSOR_AFTER_ADD,
    filter: { entered: false, phases: [] },
    gapReported: false,
    observedAt: T1,
    previousObservedAt: T0,
    ...overrides,
  });
}

describe('readPrMergeQueueMembership', () => {
  it('reports a pull request without membership or an entry as not queued', () => {
    for (const raw of [
      {},
      { isInMergeQueue: false, mergeQueueEntry: null },
      { isInMergeQueue: 'true', mergeQueueEntry: [] },
    ]) {
      expect(readPrMergeQueueMembership(raw)).toEqual(OUT);
    }
  });

  it('reads a full entry and normalizes its fields', () => {
    expect(
      readPrMergeQueueMembership({
        isInMergeQueue: true,
        mergeQueueEntry: {
          id: 'MQE_1',
          state: 'awaiting_checks',
          enqueuedAt: '2026-10-07T10:00:00Z',
          position: 2,
        },
      }),
    ).toEqual({
      inQueue: true,
      entryId: 'MQE_1',
      phase: 'awaiting_checks',
      enqueuedAt: '2026-10-07T10:00:00.000Z',
      position: 2,
    });
  });

  it('treats any entry as queued even when membership is false', () => {
    expect(
      readPrMergeQueueMembership({
        isInMergeQueue: false,
        mergeQueueEntry: { state: 'UNMERGEABLE' },
      }),
    ).toMatchObject({ inQueue: true, phase: 'unmergeable', entryId: null });
  });

  it('reads membership without an entry, or an entry without state, as unknown', () => {
    expect(readPrMergeQueueMembership({ isInMergeQueue: true })).toEqual({
      inQueue: true,
      entryId: null,
      phase: 'unknown',
      enqueuedAt: null,
      position: null,
    });
    expect(
      readPrMergeQueueMembership({ mergeQueueEntry: { id: 'MQE_1' } }).phase,
    ).toBe('unknown');
    expect(
      readPrMergeQueueMembership({ mergeQueueEntry: { state: 'NEW_STATE' } })
        .phase,
    ).toBe('unknown');
  });

  it('bounds untrusted entry values', () => {
    for (const position of [-1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        readPrMergeQueueMembership({ mergeQueueEntry: { position } }).position,
      ).toBeNull();
    }
    expect(
      readPrMergeQueueMembership({ mergeQueueEntry: { position: 0 } }).position,
    ).toBe(0);
    const membership = readPrMergeQueueMembership({
      mergeQueueEntry: { id: 'x'.repeat(200), enqueuedAt: 'yesterday' },
    });
    expect(membership.entryId).toHaveLength(128);
    expect(membership.enqueuedAt).toBeNull();
    expect(
      readPrMergeQueueMembership({ mergeQueueEntry: { id: 7, enqueuedAt: 1 } }),
    ).toMatchObject({ entryId: null, enqueuedAt: null });
  });

  it('leaves the merge time estimate out of membership', () => {
    const entry = { id: 'A', state: 'QUEUED', position: 3, enqueuedAt: T0 };
    const withEstimate = readPrMergeQueueMembership({
      mergeQueueEntry: { ...entry, estimatedTimeToMerge: 1143 },
    });
    expect(withEstimate).toEqual(
      readPrMergeQueueMembership({ mergeQueueEntry: entry }),
    );
    expect(withEstimate).not.toHaveProperty('estimatedTimeToMerge');
  });
});

describe('readMergeQueueEstimatedSeconds', () => {
  it('keeps whole, plausible second counts', () => {
    expect(readMergeQueueEstimatedSeconds(0)).toBe(0);
    expect(readMergeQueueEstimatedSeconds(1143)).toBe(1143);
    expect(readMergeQueueEstimatedSeconds(7 * 24 * 3600)).toBe(7 * 24 * 3600);
  });

  it('drops anything GitHub would not send', () => {
    for (const value of [null, undefined, -1, 1.5, '600', NaN, 8 * 24 * 3600]) {
      expect(readMergeQueueEstimatedSeconds(value)).toBeNull();
    }
  });
});

describe('PR_MERGE_QUEUE_KNOWN_PHASES', () => {
  it('lists every filterable phase and never unknown', () => {
    expect(PR_MERGE_QUEUE_KNOWN_PHASES).toEqual([
      'queued',
      'awaiting_checks',
      'mergeable',
      'locked',
      'unmergeable',
    ]);
    expect(isPrMergeQueueKnownPhase('unknown')).toBe(false);
    expect(isPrMergeQueueKnownPhase('locked')).toBe(true);
  });
});

describe('interpretPrMergeQueueTransition', () => {
  describe('merge and close precedence', () => {
    it.each(['merged', 'closed'] as const)(
      'reports no queue transition and advances the cursor when %s',
      (state) => {
        const result = interpret({
          state,
          previous: queued('A'),
          next: OUT,
          history: complete([added('a1'), removed('r1', 'merged')]),
          pendingExit: {
            heldFor: 'confirm',
            entryId: 'A',
            observedAt: T0,
            samples: 0,
            removedAt: null,
            reason: null,
          },
          filter: { entered: true, phases: [...PR_MERGE_QUEUE_KNOWN_PHASES] },
        });
        expect(result).toEqual({
          transitions: [],
          cursor: { count: 2, lastEventId: 'r1' },
          gap: false,
          gapReported: false,
        });
      },
    );
  });

  describe('merged-reason hold', () => {
    const hold: PrMergeQueuePendingExit = {
      heldFor: 'merged_reason',
      entryId: 'A',
      observedAt: T1,
      samples: 0,
      removedAt: REMOVED_AT,
      reason: 'merged',
    };
    const afterRemoval = complete([added('a1'), removed('r1', 'merged')]);
    const cursorAfterRemoval: PrMergeQueueCursor = {
      count: 2,
      lastEventId: 'r1',
    };

    it('holds a merged removal while the pull request is still open', () => {
      expect(
        interpret({
          previous: queued('A'),
          next: OUT,
          history: afterRemoval,
        }),
      ).toEqual({
        transitions: [],
        cursor: cursorAfterRemoval,
        pendingExit: hold,
        gap: false,
        gapReported: false,
      });
    });

    it('releases the hold after two more open samples once it is old enough', () => {
      const second = interpret({
        history: afterRemoval,
        cursor: cursorAfterRemoval,
        pendingExit: hold,
        observedAt: T2,
        previousObservedAt: T1,
      });
      expect(second.transitions).toEqual([]);
      expect(second.pendingExit).toEqual({ ...hold, samples: 1 });

      const third = interpret({
        history: afterRemoval,
        cursor: cursorAfterRemoval,
        pendingExit: second.pendingExit,
        observedAt: T3,
        previousObservedAt: T2,
      });
      expect(third.transitions).toEqual([
        {
          kind: 'pull_request_queue_removed',
          removedAt: REMOVED_AT,
          reason: 'merged',
          evidence: 'timeline',
          requeued: false,
        },
      ]);
      expect(third.pendingExit).toBeUndefined();
    });

    it('keeps holding across quick samples until the removal is old enough', () => {
      // Back-to-back reads must not release the hold before GitHub records
      // the merge that follows a merged-reason removal.
      let pendingExit = hold;
      for (const observedAt of [
        '2026-10-07T10:00:31.000Z',
        '2026-10-07T10:00:32.000Z',
        '2026-10-07T10:00:40.000Z',
      ]) {
        const result = interpret({
          history: afterRemoval,
          cursor: cursorAfterRemoval,
          pendingExit,
          observedAt,
        });
        expect(result.transitions).toEqual([]);
        expect(result.pendingExit).toBeDefined();
        if (result.pendingExit) pendingExit = result.pendingExit;
      }

      const merged = interpret({
        state: 'merged',
        history: afterRemoval,
        cursor: cursorAfterRemoval,
        pendingExit,
        observedAt: '2026-10-07T10:00:45.000Z',
      });
      expect(merged.transitions).toEqual([]);
      expect(merged.pendingExit).toBeUndefined();
    });

    it('drops the hold without a removal when the merge arrives', () => {
      const result = interpret({
        state: 'merged',
        history: afterRemoval,
        cursor: cursorAfterRemoval,
        pendingExit: hold,
      });
      expect(result.transitions).toEqual([]);
      expect(result.pendingExit).toBeUndefined();
    });

    it('keeps holding while membership still lags on the same entry', () => {
      const result = interpret({
        previous: queued('A'),
        next: queued('A'),
        history: afterRemoval,
        cursor: cursorAfterRemoval,
        pendingExit: hold,
      });
      expect(result.transitions).toEqual([]);
      expect(result.pendingExit).toEqual({ ...hold, samples: 1 });
    });

    it('reports a merged removal followed by re-entry without holding it', () => {
      const result = interpret({
        previous: queued('A'),
        next: queued('B'),
        history: complete([added('a1'), removed('r1', 'MERGED'), added('a2')]),
        filter: { entered: true, phases: [] },
      });
      expect(result.pendingExit).toBeUndefined();
      expect(result.transitions).toEqual([
        {
          kind: 'pull_request_queue_removed',
          removedAt: REMOVED_AT,
          reason: 'MERGED',
          evidence: 'timeline',
          requeued: true,
        },
        {
          kind: 'pull_request_queue_entered',
          enqueuedAt: T0,
          phase: 'queued',
          position: 1,
          reentry: true,
        },
      ]);
    });

    it('releases a held removal early when a new entry proves no merge', () => {
      const result = interpret({
        previous: OUT,
        next: queued('B'),
        history: afterRemoval,
        cursor: cursorAfterRemoval,
        pendingExit: hold,
        filter: { entered: true, phases: [] },
      });
      expect(result.pendingExit).toBeUndefined();
      expect(result.transitions).toEqual([
        {
          kind: 'pull_request_queue_removed',
          removedAt: REMOVED_AT,
          reason: 'merged',
          evidence: 'timeline',
          requeued: true,
        },
        expect.objectContaining({
          kind: 'pull_request_queue_entered',
          reentry: true,
        }),
      ]);
    });

    it('folds a held removal into a later non-merged removal', () => {
      const result = interpret({
        previous: OUT,
        next: OUT,
        history: complete([
          added('a1'),
          removed('r1', 'merged'),
          added('a2'),
          removed('r2', 'failed_checks', T2),
        ]),
        cursor: cursorAfterRemoval,
        pendingExit: hold,
      });
      expect(result.transitions).toEqual([
        {
          kind: 'pull_request_queue_removed',
          removedAt: T2,
          reason: 'failed_checks',
          evidence: 'timeline',
          requeued: false,
          removals: 2,
        },
      ]);
      expect(result.pendingExit).toBeUndefined();
    });

    it('keeps the removal count of a held cycle through its release', () => {
      const cycles = complete([
        added('a1'),
        removed('r1', 'failed_checks'),
        added('a2'),
        removed('r2', 'merged', T1),
      ]);
      const cursorAfterCycles: PrMergeQueueCursor = {
        count: 4,
        lastEventId: 'r2',
      };
      const first = interpret({ previous: queued('A'), history: cycles });
      expect(first.transitions).toEqual([]);
      expect(first.pendingExit).toEqual({
        ...hold,
        removedAt: T1,
        removals: 2,
      });

      let pendingExit = first.pendingExit;
      let released: PrMergeQueueInterpretation | undefined;
      for (const observedAt of [T2, '2026-10-07T10:07:00.000Z']) {
        released = interpret({
          history: cycles,
          cursor: cursorAfterCycles,
          pendingExit,
          observedAt,
        });
        pendingExit = released.pendingExit;
      }
      expect(released?.transitions).toEqual([
        {
          kind: 'pull_request_queue_removed',
          removedAt: T1,
          reason: 'merged',
          evidence: 'timeline',
          requeued: false,
          removals: 2,
        },
      ]);
    });

    it('adds a held count to a later removal and to a renewed hold', () => {
      const heldTwice: PrMergeQueuePendingExit = { ...hold, removals: 2 };
      const later = interpret({
        history: complete([
          added('a1'),
          removed('r1', 'merged'),
          added('a2'),
          removed('r2', 'failed_checks', T2),
        ]),
        cursor: cursorAfterRemoval,
        pendingExit: heldTwice,
      });
      expect(later.transitions).toEqual([
        expect.objectContaining({ reason: 'failed_checks', removals: 3 }),
      ]);

      const renewed = interpret({
        history: complete([
          added('a1'),
          removed('r1', 'merged'),
          added('a2'),
          removed('r2', 'merged', T2),
        ]),
        cursor: cursorAfterRemoval,
        pendingExit: heldTwice,
      });
      expect(renewed.transitions).toEqual([]);
      expect(renewed.pendingExit).toMatchObject({
        heldFor: 'merged_reason',
        removedAt: T2,
        removals: 3,
      });
    });
  });

  describe('timeline removals', () => {
    it('reports a verified removal with its reason and time', () => {
      const result = interpret({
        previous: queued('A'),
        next: OUT,
        history: complete([added('a1'), removed('r1', 'failed_checks')]),
      });
      expect(result).toEqual({
        transitions: [
          {
            kind: 'pull_request_queue_removed',
            removedAt: REMOVED_AT,
            reason: 'failed_checks',
            evidence: 'timeline',
            requeued: false,
          },
        ],
        cursor: { count: 2, lastEventId: 'r1' },
        gap: false,
        gapReported: false,
      });
    });

    it('coalesces removal and re-entry cycles between samples', () => {
      const history = complete([
        added('a1'),
        removed('r1', 'failed_checks'),
        added('a2'),
        removed('r2', 'dequeued', T2),
        added('a3'),
      ]);
      const withEntered = interpret({
        previous: queued('A'),
        next: queued('C', 'awaiting_checks', 4),
        history,
        filter: { entered: true, phases: ['awaiting_checks'] },
      });
      expect(withEntered.transitions).toEqual([
        {
          kind: 'pull_request_queue_removed',
          removedAt: T2,
          reason: 'dequeued',
          evidence: 'timeline',
          requeued: true,
          removals: 2,
        },
        {
          kind: 'pull_request_queue_entered',
          enqueuedAt: T0,
          phase: 'awaiting_checks',
          position: 4,
          reentry: true,
        },
      ]);
      const removalOnly = interpret({
        previous: queued('A'),
        next: queued('C'),
        history,
      });
      expect(removalOnly.transitions).toEqual([withEntered.transitions[0]]);
    });

    it('reports a removal and re-entry race detected from the timeline', () => {
      const result = interpret({
        previous: queued('A'),
        next: queued('B'),
        history: complete([
          added('a1'),
          removed('r1', 'failed_checks'),
          added('a2'),
        ]),
        filter: { entered: true, phases: [] },
      });
      expect(result.transitions.map((transition) => transition.kind)).toEqual([
        'pull_request_queue_removed',
        'pull_request_queue_entered',
      ]);
      expect(result.transitions[0]).toMatchObject({
        evidence: 'timeline',
        requeued: true,
      });
    });
  });

  describe('membership evidence', () => {
    it('reports a removal and re-entry race from a changed entry id', () => {
      const result = interpret({
        previous: queued('A'),
        next: queued('B'),
        filter: { entered: true, phases: [] },
      });
      expect(result.transitions).toEqual([
        {
          kind: 'pull_request_queue_removed',
          removedAt: null,
          reason: null,
          evidence: 'entry_changed',
          requeued: true,
        },
        {
          kind: 'pull_request_queue_entered',
          enqueuedAt: T0,
          phase: 'queued',
          position: 1,
          reentry: true,
        },
      ]);
    });

    it('does not infer a new entry when either id is missing', () => {
      expect(
        interpret({ previous: queued(null), next: queued('B') }).transitions,
      ).toEqual([]);
    });

    describe('membership-only exit', () => {
      const confirm: PrMergeQueuePendingExit = {
        heldFor: 'confirm',
        entryId: 'A',
        observedAt: T1,
        samples: 0,
        removedAt: null,
        reason: null,
      };

      it('waits one sample before reporting', () => {
        const first = interpret({ previous: queued('A'), next: OUT });
        expect(first.transitions).toEqual([]);
        expect(first.pendingExit).toEqual(confirm);

        const second = interpret({
          previous: OUT,
          next: OUT,
          pendingExit: first.pendingExit,
          observedAt: T2,
          previousObservedAt: T1,
        });
        expect(second.transitions).toEqual([
          {
            kind: 'pull_request_queue_removed',
            removedAt: null,
            reason: null,
            evidence: 'membership',
            requeued: false,
          },
        ]);
        expect(second.pendingExit).toBeUndefined();
      });

      it('uses the timeline removal when it arrives during the hold', () => {
        const result = interpret({
          previous: OUT,
          next: OUT,
          pendingExit: confirm,
          history: complete([added('a1'), removed('r1', 'failed_checks')]),
        });
        expect(result.transitions).toEqual([
          expect.objectContaining({
            evidence: 'timeline',
            reason: 'failed_checks',
          }),
        ]);
        expect(result.pendingExit).toBeUndefined();
      });

      it('converts to a merged-reason hold when the timeline says merged', () => {
        const result = interpret({
          previous: OUT,
          next: OUT,
          pendingExit: confirm,
          history: complete([added('a1'), removed('r1', 'merged')]),
          observedAt: T2,
        });
        expect(result.transitions).toEqual([]);
        expect(result.pendingExit).toEqual({
          heldFor: 'merged_reason',
          entryId: 'A',
          observedAt: T2,
          samples: 0,
          removedAt: REMOVED_AT,
          reason: 'merged',
        });
      });

      it('clears the hold silently when the same entry is back', () => {
        const result = interpret({
          previous: OUT,
          next: queued('A'),
          pendingExit: confirm,
          filter: { entered: true, phases: [...PR_MERGE_QUEUE_KNOWN_PHASES] },
        });
        expect(result.transitions).toEqual([]);
        expect(result.pendingExit).toBeUndefined();
      });

      it('reports a changed entry when the pull request is queued again', () => {
        const result = interpret({
          previous: OUT,
          next: queued('B'),
          pendingExit: confirm,
          filter: { entered: true, phases: [] },
        });
        expect(result.transitions).toEqual([
          expect.objectContaining({
            kind: 'pull_request_queue_removed',
            evidence: 'entry_changed',
            requeued: true,
          }),
          expect.objectContaining({
            kind: 'pull_request_queue_entered',
            reentry: true,
          }),
        ]);
      });
    });
  });

  describe('entry and phase changes', () => {
    it('reports entry only when selected', () => {
      expect(
        interpret({
          previous: OUT,
          next: queued('A'),
          filter: { entered: true, phases: [] },
        }).transitions,
      ).toEqual([
        {
          kind: 'pull_request_queue_entered',
          enqueuedAt: T0,
          phase: 'queued',
          position: 1,
          reentry: false,
        },
      ]);
      expect(
        interpret({ previous: OUT, next: queued('A') }).transitions,
      ).toEqual([]);
    });

    it('reports a selected phase change on the same entry', () => {
      for (const entryId of ['A', null]) {
        expect(
          interpret({
            previous: queued(entryId, 'queued', 3),
            next: queued(entryId, 'awaiting_checks', 2),
            filter: { entered: false, phases: ['awaiting_checks'] },
          }).transitions,
        ).toEqual([
          {
            kind: 'pull_request_queue_phase_changed',
            previousPhase: 'queued',
            phase: 'awaiting_checks',
            position: 2,
          },
        ]);
      }
    });

    it('ignores unselected phases and never matches unknown', () => {
      expect(
        interpret({
          previous: queued('A', 'queued'),
          next: queued('A', 'mergeable'),
          filter: { entered: false, phases: ['awaiting_checks'] },
        }).transitions,
      ).toEqual([]);
      expect(
        interpret({
          previous: queued('A', 'queued'),
          next: queued('A', 'unknown'),
          filter: { entered: true, phases: [...PR_MERGE_QUEUE_KNOWN_PHASES] },
        }).transitions,
      ).toEqual([]);
    });

    it('never reports a change that only moves the merge estimate', () => {
      // Two samples of the same entry a poll apart, as read from GitHub with
      // different estimates: membership is identical, so nothing reports.
      const sample = (estimatedTimeToMerge: number): PrMergeQueueMembership =>
        readPrMergeQueueMembership({
          isInMergeQueue: true,
          mergeQueueEntry: {
            id: 'A',
            state: 'AWAITING_CHECKS',
            position: 1,
            enqueuedAt: T0,
            estimatedTimeToMerge,
          },
        });
      // The display status stamps each read with its time; samples a poll or
      // several apart, estimate or not, still report nothing.
      for (const [previousObservedAt, observedAt] of [
        [T0, T1],
        [T1, T3],
      ]) {
        expect(
          interpret({
            previous: sample(900),
            next: sample(240),
            filter: {
              entered: true,
              phases: [...PR_MERGE_QUEUE_KNOWN_PHASES],
            },
            previousObservedAt,
            observedAt,
          }),
        ).toEqual({
          transitions: [],
          cursor: CURSOR_AFTER_ADD,
          gap: false,
          gapReported: false,
        });
      }
      const membership = sample(240);
      expect(membership).not.toHaveProperty('observedAt');
      expect(membership).not.toHaveProperty('estimatedSecondsToMerge');
      // Hooks see the same: no trigger, and the stored state is unchanged.
      const stored: PrMergeQueueSnapshot = {
        required: true,
        membership: sample(900),
        cursor: CURSOR_AFTER_ADD,
      };
      expect(
        interpretPrMergeQueueHookSample({
          previous: stored,
          next: {
            required: true,
            membership,
            history: complete([added('a1')]),
          },
          prState: 'open',
          observedAt: T3,
          previousObservedAt: T1,
        }),
      ).toEqual({ triggers: [], mergeQueue: stored });
    });

    it('never reports a position-only change', () => {
      expect(
        interpret({
          previous: queued('A', 'awaiting_checks', 5),
          next: queued('A', 'awaiting_checks', 1),
          filter: { entered: true, phases: [...PR_MERGE_QUEUE_KNOWN_PHASES] },
        }),
      ).toEqual({
        transitions: [],
        cursor: CURSOR_AFTER_ADD,
        gap: false,
        gapReported: false,
      });
    });
  });

  describe('history gaps', () => {
    const cursor: PrMergeQueueCursor = { count: 2, lastEventId: 'r1' };
    // The read starts after the cursor's last event, so continuity is unprovable.
    const discontinuous = complete([added('a2'), removed('r2', 'x')], 2);

    it('reports an unprovable gap once and re-baselines the cursor', () => {
      const result = interpret({
        previous: queued('A'),
        next: OUT,
        history: discontinuous,
        cursor,
      });
      expect(result.transitions).toEqual([
        {
          kind: 'pull_request_queue_history_incomplete',
          since: T0,
          observedAt: T1,
        },
      ]);
      // History alone never produces a removal; membership still applies.
      expect(result.pendingExit).toMatchObject({ heldFor: 'confirm' });
      expect(result).toMatchObject({
        cursor: { count: 4, lastEventId: 'r2' },
        gap: true,
        gapReported: true,
      });

      const repeated = interpret({
        previous: OUT,
        next: OUT,
        history: discontinuous,
        cursor,
        gapReported: true,
      });
      expect(repeated.transitions).toEqual([]);
      expect(repeated.gapReported).toBe(true);
    });

    it('treats a mismatched last event or a shrunken timeline as a gap', () => {
      for (const history of [
        complete([added('a1'), removed('other', 'x')]),
        complete([added('a1')]),
      ]) {
        expect(
          interpret({ previous: OUT, next: OUT, history, cursor }),
        ).toMatchObject({
          gap: true,
          gapReported: true,
          transitions: [
            expect.objectContaining({
              kind: 'pull_request_queue_history_incomplete',
            }),
          ],
        });
      }
    });

    it('stays quiet when the same entry proves continuity', () => {
      const result = interpret({
        previous: queued('A', 'queued'),
        next: queued('A', 'locked'),
        history: discontinuous,
        cursor,
        filter: { entered: false, phases: ['locked'] },
      });
      expect(result.transitions).toEqual([
        {
          kind: 'pull_request_queue_phase_changed',
          previousPhase: 'queued',
          phase: 'locked',
          position: 1,
        },
      ]);
      expect(result).toMatchObject({ gap: true, gapReported: false });
    });

    it('still reports a changed entry inside a gap', () => {
      const result = interpret({
        previous: queued('A'),
        next: queued('B'),
        history: discontinuous,
        cursor,
      });
      expect(result.transitions.map((transition) => transition.kind)).toEqual([
        'pull_request_queue_history_incomplete',
        'pull_request_queue_removed',
      ]);
    });

    it('clears a reported gap after a complete, continuous read', () => {
      const result = interpret({
        previous: OUT,
        next: OUT,
        history: complete([added('a1'), removed('r1', 'x')]),
        cursor,
        gapReported: true,
      });
      expect(result).toMatchObject({ gap: false, gapReported: false });
    });

    it('does not advance the cursor when history is unavailable', () => {
      const histories: Array<PrMergeQueueHistory | undefined> = [
        { status: 'unavailable' },
        undefined,
        // Malformed: event count does not match the window.
        {
          status: 'complete',
          firstIndex: 0,
          filteredCount: 5,
          events: [added('a1')],
        },
      ];
      for (const history of histories) {
        const result = interpret({
          previous: queued('A'),
          next: OUT,
          history,
          cursor,
        });
        // A transient unreadable timeline is not a lost window: the cursor
        // stays put, so the next complete read either covers it or proves a
        // gap. Nothing is reported yet.
        expect(result.cursor).toEqual(cursor);
        expect(result).toMatchObject({ gap: false, gapReported: false });
        expect(result.transitions).toEqual([]);
        expect(result.pendingExit).toMatchObject({ heldFor: 'confirm' });
      }
    });

    it('keeps an already reported gap marker while history is unavailable', () => {
      const result = interpret({
        previous: OUT,
        next: OUT,
        history: { status: 'unavailable' },
        cursor,
        gapReported: true,
      });
      expect(result).toMatchObject({ gap: false, gapReported: true });
      expect(result.transitions).toEqual([]);
    });
  });

  describe('legacy baseline', () => {
    it('emits nothing from history and sets the cursor on the first read', () => {
      const result = interpret({
        previous: queued('A'),
        next: queued('A'),
        history: complete([
          added('a1'),
          removed('r1', 'failed_checks'),
          added('a2'),
        ]),
        cursor: undefined,
        filter: { entered: true, phases: [...PR_MERGE_QUEUE_KNOWN_PHASES] },
      });
      expect(result).toEqual({
        transitions: [],
        cursor: { count: 3, lastEventId: 'a2' },
        gap: false,
        gapReported: false,
      });
    });

    it('waits for a readable timeline without reporting a gap', () => {
      expect(
        interpret({
          previous: queued('A'),
          next: queued('A'),
          history: { status: 'unavailable' },
          cursor: undefined,
        }),
      ).toEqual({ transitions: [], gap: false, gapReported: false });
    });
  });
});

describe('interpretPrMergeQueueHookSample', () => {
  const CURSOR_EMPTY: PrMergeQueueCursor = { count: 0, lastEventId: null };

  function state(
    membership: PrMergeQueueMembership,
    extra: Partial<PrMergeQueueSnapshot> = {},
  ): PrMergeQueueSnapshot {
    return { required: true, membership, ...extra };
  }

  function sample(
    input: Partial<Parameters<typeof interpretPrMergeQueueHookSample>[0]>,
  ): ReturnType<typeof interpretPrMergeQueueHookSample> {
    return interpretPrMergeQueueHookSample({
      prState: 'open',
      observedAt: T1,
      previousObservedAt: T0,
      ...input,
    });
  }

  it('baselines a queued pull request without queue data before, keeping no history', () => {
    const result = sample({
      next: state(queued('A'), { history: complete([added('a1')]) }),
    });
    expect(result).toEqual({
      triggers: [],
      mergeQueue: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
    });
  });

  it('reports an entry with the new entry recorded', () => {
    const result = sample({
      previous: state(OUT, { cursor: CURSOR_EMPTY }),
      next: state(queued('A'), { history: complete([added('a1')]) }),
    });
    expect(result.triggers).toEqual(['pr:queue:entered']);
    expect(result.mergeQueue).toEqual(
      state(queued('A'), {
        cursor: CURSOR_AFTER_ADD,
        lastEntered: {
          entryId: 'A',
          enqueuedAt: T0,
          phase: 'queued',
          position: 1,
          reentry: false,
          observedAt: T1,
        },
      }),
    );
  });

  it('reports a requeue as a removal of the old entry, then an entry', () => {
    const result = sample({
      previous: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
      next: state(queued('B'), {
        history: complete([
          added('a1'),
          removed('r1', 'failed_checks'),
          added('a2'),
        ]),
      }),
    });
    expect(result.triggers).toEqual(['pr:queue:removed', 'pr:queue:entered']);
    expect(result.mergeQueue?.lastRemoved).toEqual({
      entryId: 'A',
      removedAt: REMOVED_AT,
      reason: 'failed_checks',
      evidence: 'timeline',
      requeued: true,
      observedAt: T1,
    });
    expect(result.mergeQueue?.lastEntered).toMatchObject({
      entryId: 'B',
      reentry: true,
    });
  });

  it('reports a failed_checks removal with its reason', () => {
    const result = sample({
      previous: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
      next: state(OUT, {
        history: complete([added('a1'), removed('r1', 'failed_checks')]),
      }),
    });
    expect(result.triggers).toEqual(['pr:queue:removed']);
    expect(result.mergeQueue).toMatchObject({
      membership: OUT,
      cursor: { count: 2, lastEventId: 'r1' },
      lastRemoved: {
        entryId: 'A',
        reason: 'failed_checks',
        evidence: 'timeline',
        requeued: false,
      },
    });
    expect(result.mergeQueue).not.toHaveProperty('pendingExit');
  });

  it('records no entry id for removals coalesced between samples', () => {
    const result = sample({
      previous: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
      next: state(queued('C'), {
        history: complete([
          added('a1'),
          removed('r1', 'dequeued'),
          added('a2'),
          removed('r2', 'failed_checks', T1),
          added('a3'),
        ]),
      }),
    });
    expect(result.triggers).toEqual(['pr:queue:removed', 'pr:queue:entered']);
    expect(result.mergeQueue?.lastRemoved).toMatchObject({
      entryId: null,
      reason: 'failed_checks',
      removals: 2,
    });
    expect(buildPrQueueHookVariables(result, 'pr:queue:removed')).toEqual({
      PR_QUEUE_ENTRY_ID: '',
      PR_QUEUE_REMOVAL_REASON: 'failed_checks',
    });
  });

  it('holds a merged-reason removal, then reports only the merge', () => {
    const history = complete([added('a1'), removed('r1', 'merged')]);
    const held = sample({
      previous: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
      next: state(OUT, { history }),
    });
    expect(held.triggers).toEqual([]);
    expect(held.mergeQueue?.pendingExit).toMatchObject({
      heldFor: 'merged_reason',
      entryId: 'A',
    });

    const merged = sample({
      previous: held.mergeQueue,
      prState: 'merged',
      observedAt: T2,
      previousObservedAt: T1,
    });
    expect(merged.triggers).toEqual([]);
    expect(merged.mergeQueue).toEqual(state(OUT));
  });

  it('releases a merged-reason hold on a pull request that stays open', () => {
    const history = complete([added('a1'), removed('r1', 'merged')]);
    const held = sample({
      previous: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
      next: state(OUT, { history }),
    });
    const stillHeld = sample({
      previous: held.mergeQueue,
      next: state(OUT, { history }),
      observedAt: T2,
      previousObservedAt: T1,
    });
    expect(stillHeld.triggers).toEqual([]);
    const released = sample({
      previous: stillHeld.mergeQueue,
      next: state(OUT, { history }),
      observedAt: T3,
      previousObservedAt: T2,
    });
    expect(released.triggers).toEqual(['pr:queue:removed']);
    expect(released.mergeQueue?.lastRemoved).toMatchObject({
      entryId: 'A',
      reason: 'merged',
      observedAt: T3,
    });
  });

  it('confirms a membership-only exit on the next open sample', () => {
    const unavailable: PrMergeQueueHistory = { status: 'unavailable' };
    const held = sample({
      previous: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
      next: state(OUT, { history: unavailable }),
    });
    expect(held.triggers).toEqual([]);
    expect(held.mergeQueue?.pendingExit).toMatchObject({ heldFor: 'confirm' });

    const confirmed = sample({
      previous: held.mergeQueue,
      next: state(OUT, { history: unavailable }),
      observedAt: T2,
      previousObservedAt: T1,
    });
    expect(confirmed.triggers).toEqual(['pr:queue:removed']);
    expect(confirmed.mergeQueue?.lastRemoved).toEqual({
      entryId: 'A',
      removedAt: null,
      reason: null,
      evidence: 'membership',
      requeued: false,
      observedAt: T2,
    });
  });

  it('drops a confirm hold when the pull request merges', () => {
    const held = sample({
      previous: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
      next: state(OUT, { history: { status: 'unavailable' } }),
    });
    const merged = sample({
      previous: held.mergeQueue,
      prState: 'merged',
      observedAt: T2,
      previousObservedAt: T1,
    });
    expect(merged.triggers).toEqual([]);
    expect(merged.mergeQueue).not.toHaveProperty('pendingExit');
  });

  it('never reports a history gap and falls back to membership', () => {
    const gapHistory = complete([added('x9')], 5);
    const sameEntry = sample({
      previous: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
      next: state(queued('A'), { history: gapHistory }),
    });
    expect(sameEntry.triggers).toEqual([]);
    expect(sameEntry.mergeQueue?.cursor).toEqual({
      count: 6,
      lastEventId: 'x9',
    });

    const newEntry = sample({
      previous: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
      next: state(queued('B'), { history: gapHistory }),
    });
    expect(newEntry.triggers).toEqual(['pr:queue:removed', 'pr:queue:entered']);
    expect(newEntry.mergeQueue?.lastRemoved).toMatchObject({
      entryId: 'A',
      evidence: 'entry_changed',
      reason: null,
    });
  });

  it('keeps the previous state when an open pull request has no queue data', () => {
    const previous = state(queued('A'), {
      cursor: CURSOR_AFTER_ADD,
      pendingExit: {
        heldFor: 'confirm',
        entryId: 'A',
        observedAt: T0,
        samples: 0,
        removedAt: null,
        reason: null,
      },
    });
    expect(sample({ previous })).toEqual({
      triggers: [],
      mergeQueue: previous,
    });
  });

  it('records a closed pull request as out of the queue without reporting', () => {
    const closed = sample({
      previous: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
      prState: 'closed',
    });
    expect(closed).toEqual({
      triggers: [],
      mergeQueue: state(OUT),
    });
    expect(
      sample({
        previous: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
        next: state(OUT, {
          history: complete([added('a1'), removed('r1', 'failed_checks')]),
        }),
        prState: 'closed',
      }).triggers,
    ).toEqual([]);
    expect(sample({ prState: 'closed' })).toEqual({
      triggers: [],
      mergeQueue: undefined,
    });
  });
  it('does not replay a close-time removal after the pull request reopens', () => {
    const closed = sample({
      previous: state(queued('A'), { cursor: CURSOR_AFTER_ADD }),
      prState: 'closed',
    });
    const closeHistory = [added('a1'), removed('r1', 'failed_checks')];
    const reopened = sample({
      previous: closed.mergeQueue,
      next: state(OUT, { history: complete(closeHistory) }),
      observedAt: T2,
      previousObservedAt: T1,
    });
    expect(reopened).toEqual({
      triggers: [],
      mergeQueue: state(OUT, { cursor: { count: 2, lastEventId: 'r1' } }),
    });

    const requeued = sample({
      previous: closed.mergeQueue,
      next: state(queued('B'), {
        history: complete([...closeHistory, added('a2')]),
      }),
      observedAt: T2,
      previousObservedAt: T1,
    });
    expect(requeued.triggers).toEqual(['pr:queue:entered']);
    expect(requeued.mergeQueue?.lastEntered).toMatchObject({ entryId: 'B' });
  });
});

describe('buildPrQueueHookVariables', () => {
  const snapshot = {
    mergeQueue: {
      required: true,
      membership: OUT,
      lastEntered: {
        entryId: 'B',
        enqueuedAt: T0,
        phase: 'queued' as const,
        position: 1,
        reentry: true,
        observedAt: T1,
      },
      lastRemoved: {
        entryId: 'A',
        removedAt: REMOVED_AT,
        reason: 'failed_checks',
        evidence: 'timeline' as const,
        requeued: true,
        observedAt: T1,
      },
    },
  };

  it('describes the new entry for an entry and the exited entry for a removal', () => {
    expect(buildPrQueueHookVariables(snapshot, 'pr:queue:entered')).toEqual({
      PR_QUEUE_ENTRY_ID: 'B',
      PR_QUEUE_REMOVAL_REASON: '',
    });
    expect(buildPrQueueHookVariables(snapshot, 'pr:queue:removed')).toEqual({
      PR_QUEUE_ENTRY_ID: 'A',
      PR_QUEUE_REMOVAL_REASON: 'failed_checks',
    });
  });

  it('sets nothing for other triggers', () => {
    expect(buildPrQueueHookVariables(snapshot, 'pr:merged')).toEqual({});
    expect(buildPrQueueHookVariables(undefined, 'pr:checks:fail')).toEqual({});
  });

  it('sets empty values without queue data and drops unbounded values', () => {
    expect(buildPrQueueHookVariables(undefined, 'pr:queue:removed')).toEqual({
      PR_QUEUE_ENTRY_ID: '',
      PR_QUEUE_REMOVAL_REASON: '',
    });
    expect(
      buildPrQueueHookVariables(
        {
          mergeQueue: {
            ...snapshot.mergeQueue,
            lastRemoved: {
              ...snapshot.mergeQueue.lastRemoved,
              entryId: 'x'.repeat(500),
              reason: 'Failed Checks; rm -rf',
            },
          },
        },
        'pr:queue:removed',
      ),
    ).toEqual({
      PR_QUEUE_ENTRY_ID: 'x'.repeat(128),
      PR_QUEUE_REMOVAL_REASON: '',
    });
  });
});

describe('readPrMergeQueueSnapshot', () => {
  const valid: PrMergeQueueSnapshot = {
    required: true,
    membership: queued('A', 'awaiting_checks', 2),
    cursor: CURSOR_AFTER_ADD,
    pendingExit: {
      heldFor: 'merged_reason',
      entryId: 'A',
      observedAt: T0,
      samples: 1,
      removedAt: REMOVED_AT,
      reason: 'merged',
      removals: 2,
    },
    lastEntered: {
      entryId: 'A',
      enqueuedAt: T0,
      phase: 'queued',
      position: 1,
      reentry: false,
      observedAt: T0,
    },
    lastRemoved: {
      entryId: 'Z',
      removedAt: null,
      reason: null,
      evidence: 'membership',
      requeued: false,
      observedAt: T0,
    },
  };

  it('reads a stored queue state', () => {
    expect(readPrMergeQueueSnapshot(JSON.parse(JSON.stringify(valid)))).toEqual(
      valid,
    );
  });

  it('rejects state without required or membership fields', () => {
    for (const value of [
      undefined,
      null,
      [],
      { membership: OUT },
      { required: true },
      { required: true, membership: { inQueue: 'yes' } },
      { required: true, membership: { ...OUT, entryId: 7 } },
    ]) {
      expect(readPrMergeQueueSnapshot(value)).toBeUndefined();
    }
  });

  it('drops malformed optional fields and any history', () => {
    expect(
      readPrMergeQueueSnapshot({
        required: false,
        membership: OUT,
        history: { status: 'unavailable' },
        cursor: { count: -1, lastEventId: null },
        pendingExit: { heldFor: 'later' },
        lastEntered: { entryId: 'A' },
        lastRemoved: { ...valid.lastRemoved, evidence: 'guess' },
      }),
    ).toEqual({ required: false, membership: OUT });
  });
});

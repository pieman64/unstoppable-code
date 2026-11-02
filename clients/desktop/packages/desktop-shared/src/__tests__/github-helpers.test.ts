import {
  DEFAULT_MERGE_QUEUE_AGENT_HANDLING,
  MERGE_QUEUE_AGENT_HANDLING_VALUES,
  hasUnresolvedReviewThreads,
  isMergeQueueAgentHandling,
  isPrInMergeQueue,
  isPrMergeQueuePhase,
  isPrReadyToMerge,
  prMergeStartsAgentChat,
  toPrMergeQueuePhase,
  type PrMergeQueuePhase,
} from '../types/github';
import { PORTAL_PR_MERGE_QUEUE_PHASES } from '@canopy/protocol/portal';

describe('hasUnresolvedReviewThreads', () => {
  it('is true when an open PR has unresolved review threads', () => {
    expect(
      hasUnresolvedReviewThreads({
        state: 'open',
        unresolvedReviewThreadCount: 3,
      }),
    ).toBe(true);
  });

  it('is false when the open PR has no unresolved threads', () => {
    expect(
      hasUnresolvedReviewThreads({
        state: 'open',
        unresolvedReviewThreadCount: 0,
      }),
    ).toBe(false);
  });

  it('is false when the unresolved count is unknown', () => {
    expect(
      hasUnresolvedReviewThreads({
        state: 'open',
        unresolvedReviewThreadCount: undefined,
      }),
    ).toBe(false);
  });

  it('is false for non-open PRs regardless of count', () => {
    expect(
      hasUnresolvedReviewThreads({
        state: 'merged',
        unresolvedReviewThreadCount: 5,
      }),
    ).toBe(false);
  });
});

describe('isPrReadyToMerge with a merge queue', () => {
  const ready = {
    state: 'open' as const,
    checkStatus: 'passing' as const,
    reviewStatus: 'approved' as const,
    hasConflicts: false,
    mergeable: true,
    mergeableState: 'clean',
  };

  it('keeps clean PRs ready whether or not a queue is required', () => {
    expect(isPrReadyToMerge(ready)).toBe(true);
    expect(
      isPrReadyToMerge({
        ...ready,
        mergeQueue: { required: true, inQueue: false },
      }),
    ).toBe(true);
  });

  it('accepts a blocked PR only when the queue is required and local signals are green', () => {
    const blocked = { ...ready, mergeableState: 'blocked' };
    expect(isPrReadyToMerge(blocked)).toBe(false);
    expect(
      isPrReadyToMerge({
        ...blocked,
        mergeQueue: { required: false, inQueue: false },
      }),
    ).toBe(false);
    const queueRequired = {
      ...blocked,
      mergeQueue: { required: true, inQueue: false },
    };
    expect(isPrReadyToMerge(queueRequired)).toBe(true);
    expect(
      isPrReadyToMerge({ ...queueRequired, reviewStatus: 'pending' }),
    ).toBe(false);
    expect(isPrReadyToMerge({ ...queueRequired, checkStatus: 'pending' })).toBe(
      false,
    );
    expect(isPrReadyToMerge({ ...queueRequired, hasConflicts: true })).toBe(
      false,
    );
    expect(
      isPrReadyToMerge({ ...queueRequired, mergeableState: 'dirty' }),
    ).toBe(false);
  });

  it('is never ready once the PR is in the queue', () => {
    const queued = {
      ...ready,
      mergeQueue: { required: true, inQueue: true, position: 1 },
    };
    expect(isPrInMergeQueue(queued)).toBe(true);
    expect(isPrReadyToMerge(queued)).toBe(false);
    expect(isPrInMergeQueue({ ...queued, state: 'merged' })).toBe(false);
    expect(isPrInMergeQueue(ready)).toBe(false);
  });
});

const ALL_MERGE_QUEUE_PHASES: readonly PrMergeQueuePhase[] = [
  'queued',
  'awaiting_checks',
  'mergeable',
  'locked',
  'unmergeable',
  'unknown',
];

describe('toPrMergeQueuePhase', () => {
  it('maps every GitHub MergeQueueEntryState value', () => {
    expect(toPrMergeQueuePhase('QUEUED')).toBe('queued');
    expect(toPrMergeQueuePhase('AWAITING_CHECKS')).toBe('awaiting_checks');
    expect(toPrMergeQueuePhase('MERGEABLE')).toBe('mergeable');
    expect(toPrMergeQueuePhase('LOCKED')).toBe('locked');
    expect(toPrMergeQueuePhase('UNMERGEABLE')).toBe('unmergeable');
  });

  it('accepts lowercase GitHub values', () => {
    expect(toPrMergeQueuePhase('awaiting_checks')).toBe('awaiting_checks');
    expect(toPrMergeQueuePhase('locked')).toBe('locked');
  });

  it('maps unrecognized or non-string values to unknown', () => {
    expect(toPrMergeQueuePhase('SOME_FUTURE_STATE')).toBe('unknown');
    expect(toPrMergeQueuePhase('')).toBe('unknown');
    expect(toPrMergeQueuePhase(undefined)).toBe('unknown');
    expect(toPrMergeQueuePhase(null)).toBe('unknown');
    expect(toPrMergeQueuePhase(3)).toBe('unknown');
    expect(toPrMergeQueuePhase({ state: 'QUEUED' })).toBe('unknown');
  });
});

describe('isPrMergeQueuePhase', () => {
  it('accepts every normalized phase', () => {
    for (const phase of ALL_MERGE_QUEUE_PHASES) {
      expect(isPrMergeQueuePhase(phase)).toBe(true);
    }
  });

  it('accepts every phase the Portal protocol defines', () => {
    for (const phase of PORTAL_PR_MERGE_QUEUE_PHASES) {
      expect(isPrMergeQueuePhase(phase)).toBe(true);
    }
  });

  it('rejects raw GitHub values, other strings, and non-strings', () => {
    expect(isPrMergeQueuePhase('QUEUED')).toBe(false);
    expect(isPrMergeQueuePhase('merged')).toBe(false);
    expect(isPrMergeQueuePhase('')).toBe(false);
    expect(isPrMergeQueuePhase(undefined)).toBe(false);
    expect(isPrMergeQueuePhase(null)).toBe(false);
    expect(isPrMergeQueuePhase(1)).toBe(false);
  });
});

describe('isPrInMergeQueue with a phase', () => {
  const queued = {
    state: 'open' as const,
    mergeQueue: { required: true, inQueue: true },
  };

  it('stays queued for every phase, unknown included, and without one', () => {
    expect(isPrInMergeQueue(queued)).toBe(true);
    for (const phase of ALL_MERGE_QUEUE_PHASES) {
      const withPhase = {
        ...queued,
        mergeQueue: { ...queued.mergeQueue, phase },
      };
      expect(isPrInMergeQueue(withPhase)).toBe(true);
    }
  });

  it('does not treat a mergeable or locked phase as merged', () => {
    for (const phase of ['mergeable', 'locked'] as const) {
      const mergedWithPhase = {
        state: 'merged' as const,
        mergeQueue: { required: true, inQueue: true, phase },
      };
      expect(isPrInMergeQueue(mergedWithPhase)).toBe(false);
    }
  });
});

describe('merge queue agent handling', () => {
  const queueRequired = { mergeQueue: { required: true, inQueue: false } };

  it('recognizes only the three persisted values', () => {
    expect(
      MERGE_QUEUE_AGENT_HANDLING_VALUES.every(isMergeQueueAgentHandling),
    ).toBe(true);
    expect(isMergeQueueAgentHandling('sometimes')).toBe(false);
    expect(isMergeQueueAgentHandling(undefined)).toBe(false);
    expect(DEFAULT_MERGE_QUEUE_AGENT_HANDLING).toBe('when_hook_absent');
  });

  it.each([
    ['always', false, true],
    ['always', true, true],
    ['when_hook_absent', false, true],
    ['when_hook_absent', true, false],
    ['never', false, false],
  ] as const)(
    'starts a chat with %s (hook active: %s): %s',
    (handling, queueRemovedHookActive, expected) => {
      expect(
        prMergeStartsAgentChat({
          status: queueRequired,
          handling,
          queueRemovedHookActive,
        }),
      ).toBe(expected);
    },
  );

  it('never starts a chat without a known merge queue requirement', () => {
    for (const status of [{}, { mergeQueue: { required: false } }]) {
      expect(
        prMergeStartsAgentChat({
          status,
          handling: 'always',
          queueRemovedHookActive: false,
        }),
      ).toBe(false);
    }
  });
});

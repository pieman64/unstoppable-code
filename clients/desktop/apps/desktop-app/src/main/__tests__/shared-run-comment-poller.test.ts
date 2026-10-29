import type { SharedRunDetail } from '@canopy/protocol/runs';
import type { RunCommentsUpdatedEvent } from '@canopy/desktop-shared/types';
import type { SharedRunCommentEntry } from '../lib/shared-run-comments-registry';

const recordSessionDiagnosticMock = jest.fn();
const appOnMock = jest.fn<void, [string, () => void]>();
const appOffMock = jest.fn<void, [string, () => void]>();

jest.mock('electron', () => ({
  app: {
    on: (...args: unknown[]): unknown => appOnMock(...args),
    removeListener: (...args: unknown[]): unknown => appOffMock(...args),
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
}));

jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordSessionDiagnostic: typeof recordSessionDiagnosticMock;
  } => ({ recordSessionDiagnostic: recordSessionDiagnosticMock }),
}));

jest.mock('../lib/shared-run-comments-registry', () => ({
  claimSharedRunCommentPollWindow: jest.fn(),
  recordPolledCommentRevision: jest.fn(),
  unregisterSharedRunForComments: jest.fn(),
}));

// Stubbed so the poller's 404/410 "grant is gone" branch can be exercised
// without loading the real cloud client (and its credential/Electron chain).
jest.mock('../canopy-cloud/client', () => ({
  CanopyCloudClientError: class CanopyCloudClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status?: number,
    ) {
      super(message);
      this.name = 'CanopyCloudClientError';
    }
  },
}));

jest.mock('../runs/canopy-server-client', () => ({
  getSharedRun: jest.fn(),
  supportsRunComments: jest.fn(),
}));

import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  countUnreadComments,
  createSharedRunCommentPollerForTest,
  getSharedRunCommentPoller,
} from '../services/shared-run-comment-poller';

const RUN_ID = 'run-ext-1';

function entry(
  overrides: Partial<SharedRunCommentEntry> = {},
): SharedRunCommentEntry {
  return {
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat-1',
    externalId: RUN_ID,
    lastSeenCommentRevision: 1,
    lastPolledCommentRevision: 1,
    unreadCommentCount: 0,
    ...overrides,
  };
}

function detail(overrides: Partial<SharedRunDetail> = {}): SharedRunDetail {
  return {
    externalId: RUN_ID,
    shareScope: 'organization',
    title: 'A run',
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    clientChatId: 'chat-1',
    summary: '',
    transcript: [],
    messages: [],
    diff: '',
    rollup: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: 0,
      toolUseCount: 0,
      turnCount: 0,
      provider: 'claude',
      status: 'success',
    },
    author: { name: 'Ada', image: null, userId: 'author-ext' },
    organizationId: 'org-ext',
    plans: [],
    commentThreads: [],
    commentRevision: 1,
    viewerUserId: 'me-ext',
    ...overrides,
  };
}

function threadWith(
  authorUserIds: string[],
): SharedRunDetail['commentThreads'] {
  return [
    {
      id: 'web:thread-1',
      status: 'open',
      anchor: { kind: 'run' },
      anchorState: 'matched',
      createdAt: '2026-07-09T00:00:00.000Z',
      comments: authorUserIds.map((userId, index) => ({
        id: `web:comment-${index}`,
        author: { userId, displayName: 'Someone', image: null },
        body: 'a comment',
        createdAt: '2026-07-09T00:00:00.000Z',
      })),
    },
  ];
}

interface Harness {
  hasEntries: jest.Mock;
  claimWindow: jest.Mock;
  fetchRun: jest.Mock;
  capabilityAvailable: jest.Mock;
  recordRevision: jest.Mock;
  unregister: jest.Mock;
  emit: jest.Mock<void, [RunCommentsUpdatedEvent]>;
}

function harness(overrides: Partial<Harness> = {}): {
  deps: Harness;
  poller: ReturnType<typeof createSharedRunCommentPollerForTest>;
} {
  const deps: Harness = {
    hasEntries: jest.fn().mockResolvedValue(true),
    claimWindow: jest.fn().mockResolvedValue([entry()]),
    fetchRun: jest.fn().mockResolvedValue(detail()),
    capabilityAvailable: jest.fn().mockResolvedValue(true),
    recordRevision: jest
      .fn()
      .mockImplementation((target: SharedRunCommentEntry) =>
        Promise.resolve(entry(target)),
      ),
    unregister: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn<void, [RunCommentsUpdatedEvent]>(),
    ...overrides,
  };
  return {
    deps,
    poller: createSharedRunCommentPollerForTest({
      hasEntries: deps.hasEntries,
      claimWindow: deps.claimWindow,
      fetchRun: deps.fetchRun,
      capabilityAvailable: deps.capabilityAvailable,
      recordRevision: deps.recordRevision,
      unregister: deps.unregister,
      emit: deps.emit,
      now: () => 0,
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('lifecycle', () => {
  afterEach(() => {
    getSharedRunCommentPoller().shutdown();
  });

  it('starts once and does not stack timers or focus listeners', () => {
    jest.useFakeTimers();
    try {
      const poller = getSharedRunCommentPoller();
      poller.start();
      poller.start();

      // One interval, not two — a repeat start is a true no-op.
      expect(jest.getTimerCount()).toBe(1);
      // Exactly one focus listener, no matter how many starts.
      expect(appOnMock).toHaveBeenCalledTimes(1);
      expect(appOnMock.mock.calls[0][0]).toBe('browser-window-focus');
    } finally {
      jest.useRealTimers();
    }
  });

  it('removes the timer and the focus listener on shutdown', () => {
    jest.useFakeTimers();
    try {
      const poller = getSharedRunCommentPoller();
      poller.start();
      poller.shutdown();

      expect(jest.getTimerCount()).toBe(0);
      expect(appOffMock).toHaveBeenCalledWith(
        'browser-window-focus',
        expect.any(Function),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('pollOnce', () => {
  it('does nothing when no shared run is registered', async () => {
    const { deps, poller } = harness({
      hasEntries: jest.fn().mockResolvedValue(false),
    });

    await poller.pollOnce();

    // Cheapest gate first: a user who has never shared a run must not pay for
    // a capability probe, which can fall through to a live network request.
    expect(deps.capabilityAvailable).not.toHaveBeenCalled();
    expect(deps.claimWindow).not.toHaveBeenCalled();
    expect(deps.fetchRun).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it('skips the whole tick when the cloud has no run-comments capability', async () => {
    // An older Canopy Cloud (or a signed-out desktop) degrades to "no
    // comments" rather than erroring or spamming failed requests.
    const { deps, poller } = harness({
      capabilityAvailable: jest.fn().mockResolvedValue(false),
    });

    await poller.pollOnce();

    expect(deps.fetchRun).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it('drops a registration whose grant is gone server-side', async () => {
    // Liveness comes from the fetch itself, so the poller no longer parses the
    // worktree's chat-tabs file (whole transcripts) on the main thread just to
    // re-derive an id the registry already persists.
    const { deps, poller } = harness({
      fetchRun: jest
        .fn()
        .mockRejectedValue(
          new CanopyCloudClientError('http-error', 'gone', 404),
        ),
    });

    await poller.pollOnce();

    expect(deps.unregister).toHaveBeenCalledTimes(1);
    expect(deps.emit).not.toHaveBeenCalled();
    // An expected outcome, not a failure worth diagnosing.
    expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
  });

  it('keeps polling a run whose fetch failed for a transient reason', async () => {
    const { deps, poller } = harness({
      fetchRun: jest
        .fn()
        .mockRejectedValue(
          new CanopyCloudClientError('http-error', 'boom', 500),
        ),
    });

    await poller.pollOnce();

    expect(deps.unregister).not.toHaveBeenCalled();
    expect(recordSessionDiagnosticMock).toHaveBeenCalled();
  });

  it('emits when the comment revision advances past the last seen value', async () => {
    const { deps, poller } = harness({
      fetchRun: jest.fn().mockResolvedValue(
        detail({
          commentRevision: 4,
          commentThreads: threadWith(['teammate-ext']),
        }),
      ),
      recordRevision: jest.fn().mockResolvedValue(
        entry({
          lastSeenCommentRevision: 1,
          lastPolledCommentRevision: 4,
          unreadCommentCount: 1,
        }),
      ),
    });

    await poller.pollOnce();

    expect(deps.emit).toHaveBeenCalledTimes(1);
    const event = deps.emit.mock.calls[0][0];
    expect(event).toMatchObject({
      projectId: 'proj',
      worktreeId: 'wt',
      chatId: 'chat-1',
      externalId: RUN_ID,
      commentRevision: 4,
      unreadCommentCount: 1,
      ownCommentsOnly: false,
    });
  });

  it('suppresses the emit when the user read the thread mid-poll', async () => {
    // `entry` is snapshotted before the fetch. If a markSeen lands during that
    // round trip, the registry returns the FRESH row — and the emit decision
    // must follow that, not the stale snapshot. Gating on the snapshot re-lit
    // the badge (and could fire an OS notification) for comments the user was
    // reading at that moment.
    const { deps, poller } = harness({
      claimWindow: jest
        .fn()
        .mockResolvedValue([
          entry({ lastSeenCommentRevision: 0, lastPolledCommentRevision: 0 }),
        ]),
      fetchRun: jest.fn().mockResolvedValue(detail({ commentRevision: 3 })),
      // markSeen(3) landed while the fetch was in flight.
      recordRevision: jest.fn().mockResolvedValue(
        entry({
          lastSeenCommentRevision: 3,
          lastPolledCommentRevision: 3,
          unreadCommentCount: 0,
        }),
      ),
    });

    await poller.pollOnce();

    expect(deps.recordRevision).toHaveBeenCalledTimes(1);
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it('skips the tick before advancing the rotation cursor when signed out', async () => {
    // The capability gate must run BEFORE the claim, or a signed-out client
    // takes a registry write every interval forever and burns a window.
    const { deps, poller } = harness({
      capabilityAvailable: jest.fn().mockResolvedValue(false),
    });

    await poller.pollOnce();

    expect(deps.claimWindow).not.toHaveBeenCalled();
    expect(deps.fetchRun).not.toHaveBeenCalled();
  });

  it('does not emit when the revision is unchanged', async () => {
    const { deps, poller } = harness({
      fetchRun: jest.fn().mockResolvedValue(detail({ commentRevision: 1 })),
    });

    await poller.pollOnce();

    expect(deps.recordRevision).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it("flags an advance made up entirely of the viewer's own comments", async () => {
    // Never notify a user about the reply they just posted from the web.
    const { deps, poller } = harness({
      fetchRun: jest.fn().mockResolvedValue(
        detail({
          commentRevision: 2,
          viewerUserId: 'me-ext',
          commentThreads: threadWith(['me-ext']),
        }),
      ),
      recordRevision: jest.fn().mockResolvedValue(
        entry({
          lastSeenCommentRevision: 1,
          lastPolledCommentRevision: 2,
          unreadCommentCount: 1,
        }),
      ),
    });

    await poller.pollOnce();

    expect(deps.emit.mock.calls[0][0].ownCommentsOnly).toBe(true);
  });

  it('never throws, and records a triageable diagnostic, when a fetch fails', async () => {
    const { deps, poller } = harness({
      fetchRun: jest.fn().mockRejectedValue(new Error('cloud unreachable')),
    });

    await expect(poller.pollOnce()).resolves.toBeUndefined();

    expect(deps.emit).not.toHaveBeenCalled();
    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'shared_run_comment_poll_failed',
        projectId: 'proj',
        worktreeId: 'wt',
        chatId: 'chat-1',
        error: 'cloud unreachable',
      }),
    );
  });

  it('bounds a tick to at most 20 runs', async () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      entry({ chatId: `chat-${index}` }),
    );
    const { deps, poller } = harness({
      claimWindow: jest.fn().mockResolvedValue(many),
      fetchRun: jest.fn().mockResolvedValue(detail({ commentRevision: 1 })),
    });

    await poller.pollOnce();

    // The bound is applied by the registry when it claims the window, so the
    // poller asks for exactly MAX_RUNS_PER_TICK and polls what it is handed.
    expect(deps.claimWindow).toHaveBeenCalledWith(20);
    expect(deps.fetchRun).toHaveBeenCalledTimes(20);
  });
});

describe('countUnreadComments', () => {
  it('counts comments added since the last seen revision', () => {
    const result = countUnreadComments(
      detail({
        commentRevision: 4,
        commentThreads: threadWith(['a', 'b', 'c']),
      }),
      entry({ lastSeenCommentRevision: 2, unreadCommentCount: 0 }),
    );

    expect(result.unreadCount).toBe(2);
  });

  it('never claims more unread than the run actually has comments', () => {
    // The revision counter also moves on resolve/reopen, so the delta is an
    // upper bound — clamp it to the real comment count.
    const result = countUnreadComments(
      detail({ commentRevision: 50, commentThreads: threadWith(['a']) }),
      entry({ lastSeenCommentRevision: 0 }),
    );

    expect(result.unreadCount).toBe(1);
  });

  it('does not claim ownership when the viewer is unresolved', () => {
    const result = countUnreadComments(
      detail({
        commentRevision: 3,
        viewerUserId: null,
        commentThreads: threadWith(['a']),
      }),
      entry({ lastSeenCommentRevision: 1 }),
    );

    expect(result.ownCommentsOnly).toBe(false);
  });

  // `commentThreads` is ordered by THREAD creation, so flattening it is not
  // chronological across threads: a reply on an old thread sorts before a
  // comment on a newer one. The newest-N window must be picked by comment
  // timestamp, or `ownCommentsOnly` describes the wrong comments and the
  // renderer either swallows a real notification or fires one for the
  // viewer's own comment.
  it('picks the newest comments by timestamp, not by thread order, when deciding ownership', () => {
    const threads: SharedRunDetail['commentThreads'] = [
      {
        id: 'web:thread-old',
        status: 'open',
        anchor: { kind: 'run' },
        anchorState: 'matched',
        createdAt: '2026-07-09T00:00:00.000Z',
        comments: [
          {
            id: 'web:old-1',
            author: { userId: 'reviewer-ext', displayName: 'Rev', image: null },
            body: 'first',
            createdAt: '2026-07-09T00:00:00.000Z',
          },
          {
            id: 'web:old-2',
            author: { userId: 'reviewer-ext', displayName: 'Rev', image: null },
            body: 'newest overall',
            createdAt: '2026-07-09T03:00:00.000Z',
          },
        ],
      },
      {
        id: 'web:thread-new',
        status: 'open',
        anchor: { kind: 'run' },
        anchorState: 'matched',
        createdAt: '2026-07-09T01:00:00.000Z',
        comments: [
          {
            id: 'web:new-1',
            author: { userId: 'me-ext', displayName: 'Me', image: null },
            body: 'my own, but older than old-2',
            createdAt: '2026-07-09T01:00:00.000Z',
          },
        ],
      },
    ];

    const result = countUnreadComments(
      detail({ commentRevision: 4, commentThreads: threads }),
      entry({ lastSeenCommentRevision: 3, unreadCommentCount: 0 }),
    );

    expect(result.unreadCount).toBe(1);
    expect(result.ownCommentsOnly).toBe(false);
  });
});

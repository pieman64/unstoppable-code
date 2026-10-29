import {
  MAX_SHARED_RUN_COMMENTS_PER_THREAD,
  MAX_SHARED_RUN_COMMENT_BODY_LENGTH,
  MAX_SHARED_RUN_COMMENT_THREADS,
  RUN_SHARE_SCOPES,
  RUNS_API_VERSION,
  SHARED_RUN_PACKAGE_VERSION,
  type SharedRunCommentCreateRequest,
  type SharedRunCommentReplyRequest,
  type SharedRunCommentStatusRequest,
  type SharedRunCommentThread,
  type SharedRunCreateRequest,
  type SharedRunDetail,
  type SharedRunRef,
  type SharedRunViewer,
} from '../index';
import { FEED_ITEM_TYPES, type RunSharedFeedItem } from '../../feed';

describe('shared-run contracts (CAN-395)', () => {
  it('exports a stable wire version and scope vocabulary', () => {
    expect(RUNS_API_VERSION).toBe(3);
    expect([...RUN_SHARE_SCOPES]).toEqual(['private', 'team', 'organization']);
  });

  it('registers the run_shared feed item type', () => {
    expect([...FEED_ITEM_TYPES]).toContain('run_shared');
  });

  it('SharedRunCreateRequest is a plain JSON-serializable shape', () => {
    const request: SharedRunCreateRequest = {
      clientLocalRunId: 'run-1',
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      clientChatId: 'chat-1',
      shareScope: 'organization',
      organizationId: 'org-uuid',
      title: 'Fix the flaky test',
      summary: 'Session that fixed the flaky test',
      rollup: {
        inputTokens: 1500,
        outputTokens: 900,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalCostUsd: 0.42,
        toolUseCount: 7,
        turnCount: 3,
        durationMs: 12000,
        provider: 'claude',
        model: 'claude-sonnet-4',
        status: 'success',
      },
      diff: 'diff --git a/x b/x',
      turnRangeStartClientTurnId: 'turn-1',
      turnRangeEndClientTurnId: 'turn-3',
    };

    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  });

  it('SharedRunDetail assembles transcript + diff + rollup + author', () => {
    const detail: SharedRunDetail = {
      externalId: 'run-uuid',
      shareScope: 'organization',
      title: 'Fix the flaky test',
      createdAt: '2026-07-09T00:00:00.000Z',
      updatedAt: '2026-07-09T00:00:00.000Z',
      clientChatId: 'chat-1',
      summary: 'Session that fixed the flaky test',
      transcript: [
        {
          text: 'first turn plaintext',
          startedAt: '2026-07-09T00:00:00.000Z',
          rollup: {
            status: 'success',
            provider: 'claude',
            model: 'claude-sonnet-4',
            label: 'Turn 1',
            inputTokens: 500,
            outputTokens: 300,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            totalCostUsd: 0.14,
            toolUseCount: 2,
            durationMs: 4000,
          },
        },
      ],
      messages: [],
      diff: 'diff --git a/x b/x',
      rollup: {
        inputTokens: 1500,
        outputTokens: 900,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        totalCostUsd: 0.42,
        toolUseCount: 7,
        turnCount: 3,
        durationMs: 12000,
        provider: 'claude',
        model: 'claude-sonnet-4',
        status: 'success',
      },
      author: { name: 'Ada', image: null, userId: 'user-uuid' },
      organizationId: 'org-uuid',
      plans: [],
      commentThreads: [],
      commentRevision: 0,
      viewerUserId: 'user-uuid',
    };

    // The viewer alias is the detail shape.
    const viewer: SharedRunViewer = detail;
    expect(viewer).toBe(detail);
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
  });

  it('SharedRunRef carries the externalId returned by create', () => {
    const ref: SharedRunRef = {
      externalId: 'run-uuid',
      shareScope: 'organization',
      title: 'Fix the flaky test',
      createdAt: '2026-07-09T00:00:00.000Z',
      updatedAt: '2026-07-09T00:00:00.000Z',
    };
    expect(JSON.parse(JSON.stringify(ref))).toEqual(ref);
  });

  it('bumps the package envelope version for embedded comments (CAN-397)', () => {
    expect(SHARED_RUN_PACKAGE_VERSION).toBe(2);
  });

  it('pins the comment caps', () => {
    expect(MAX_SHARED_RUN_COMMENT_THREADS).toBe(1000);
    expect(MAX_SHARED_RUN_COMMENTS_PER_THREAD).toBe(500);
    expect(MAX_SHARED_RUN_COMMENT_BODY_LENGTH).toBe(16_384);
  });

  it('round-trips both comment anchor kinds and their thread shapes', () => {
    const threads: SharedRunCommentThread[] = [
      {
        id: 'web:thread-1',
        status: 'open',
        // Whole-run thread.
        anchor: { kind: 'run' },
        anchorState: 'matched',
        createdAt: '2026-07-09T01:00:00.000Z',
        comments: [
          {
            id: 'web:comment-1',
            author: {
              userId: 'user-uuid',
              displayName: 'Ada',
              image: null,
            },
            body: 'Why did it retry here?',
            createdAt: '2026-07-09T01:00:00.000Z',
          },
        ],
      },
      {
        id: 'desktop:thread-2',
        status: 'resolved',
        // Anchored to one projected transcript message; the id is opaque.
        anchor: { kind: 'message', messageId: 'turn-ext-1:transcript-3' },
        // Normal state when the anchored message is no longer assembled.
        anchorState: 'orphaned',
        createdAt: '2026-07-09T02:00:00.000Z',
        comments: [],
      },
    ];

    expect(JSON.parse(JSON.stringify(threads))).toEqual(threads);
  });

  it('exposes JSON-serializable comment request DTOs for the desktop REST surface', () => {
    const create: SharedRunCommentCreateRequest = {
      body: 'This tool call was wrong.',
      anchor: { kind: 'message', messageId: 'turn-ext-1:transcript-3' },
    };
    const reply: SharedRunCommentReplyRequest = { body: 'Agreed, fixing.' };
    const status: SharedRunCommentStatusRequest = { status: 'resolved' };

    expect(JSON.parse(JSON.stringify([create, reply, status]))).toEqual([
      create,
      reply,
      status,
    ]);
  });

  it('RunSharedFeedItem links to the shared run externalId', () => {
    const item: RunSharedFeedItem = {
      id: 'run_shared:run-uuid',
      type: 'run_shared',
      occurredAt: '2026-07-09T00:00:00.000Z',
      actor: { userId: 'user-uuid', displayName: 'Ada' },
      worktreeId: 'wt-uuid',
      sharedRunId: 'run-uuid',
      title: 'Fix the flaky test',
      shareScope: 'organization',
      status: 'success',
      turnCount: 4,
      toolUseCount: 16,
      model: 'claude-opus-4-8',
      totalCostUsd: 4.82,
    };
    expect(JSON.parse(JSON.stringify(item))).toEqual(item);
  });
});

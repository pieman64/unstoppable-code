jest.mock('node:fs/promises');

jest.mock('../lib/resolve-worktree', () => ({
  resolveTrackedPlansFilePath: jest.fn(),
}));

const recordUsageMetricEventMock = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordUsageMetricEvent: recordUsageMetricEventMock,
  })),
}));

const mockSendToAllWindows = jest.fn();
const mockQueueSharedPlanSync = jest.fn();

jest.mock('../lib/window-send', () => ({
  sendToAllWindows: (...args: unknown[]): void => {
    mockSendToAllWindows(...args);
  },
}));

jest.mock('../lib/shared-plan-sync', () => ({
  queueSharedPlanSync: (...args: unknown[]): void => {
    mockQueueSharedPlanSync(...args);
  },
}));

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type {
  PlanCommentThread,
  TrackedPlansFile,
} from '@canopy/desktop-shared/types';
import { resolveTrackedPlansFilePath } from '../lib/resolve-worktree';
import {
  appendPlanCommentReply,
  PLAN_COMMENT_HANDOFF_GRACE_MS,
  readPlanCommentThread,
  readScopedPlanCommentThreads,
  saveTrackedPlanComments,
  updateTrackedPlan,
  waitForSubmittedPlanCommentThread,
  type PlanCommentThreadRef,
} from '../lib/plan-persistence';
import { replyToPlanCommentThread } from '../lib/plan-comment-reply';

const mockedMkdir = jest.mocked(mkdir);
const mockedReadFile = jest.mocked(readFile);
const mockedRm = jest.mocked(rm);
const mockedWriteFile = jest.mocked(writeFile);
const mockedResolveTrackedPlansFilePath = jest.mocked(
  resolveTrackedPlansFilePath,
);

function isTrackedPlansFileShape(value: unknown): value is TrackedPlansFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'plans' in value &&
    Array.isArray(value.plans)
  );
}

function parseWrittenTrackedPlansFile(raw: unknown): TrackedPlansFile {
  if (typeof raw !== 'string') {
    throw new Error('expected written tracked plans payload to be a string');
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isTrackedPlansFileShape(parsed)) {
    throw new Error('written tracked plans file failed validation');
  }
  return parsed;
}

const matchedThread: PlanCommentThread = {
  id: 'thread-keep',
  status: 'open',
  createdAt: '2026-03-31T00:05:00.000Z',
  anchor: { quote: 'Phase one' },
  anchorState: 'matched',
  comments: [
    {
      id: 'c-1',
      author: 'user',
      body: 'Looks good',
      createdAt: '2026-03-31T00:05:00.000Z',
      staged: true,
    },
  ],
};

const willOutdateThread: PlanCommentThread = {
  id: 'thread-drop',
  status: 'open',
  createdAt: '2026-03-31T00:05:00.000Z',
  anchor: { quote: 'Phase two' },
  anchorState: 'matched',
  comments: [],
};

function makePlanFile(
  content: string,
  threads: PlanCommentThread[],
): TrackedPlansFile {
  return {
    version: 1,
    plans: [
      {
        id: 'plan-1',
        projectId: 'project-a',
        worktreeId: 'wt-1',
        source: 'claude',
        title: 'Plan 1',
        content,
        reviewStatus: 'pending',
        createdAt: '2026-03-31T00:01:00.000Z',
        updatedAt: '2026-03-31T00:01:00.000Z',
        latestRevisionNumber: 1,
        revisions: [
          {
            revisionNumber: 1,
            content,
            source: 'claude',
            reviewStatus: 'pending',
            createdAt: '2026-03-31T00:01:00.000Z',
          },
        ],
        linkedExecutionIds: [],
        commentThreads: threads,
      },
    ],
  };
}

describe('plan comment persistence', () => {
  let capturedWrittenPayload: unknown;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedWrittenPayload = undefined;
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/project-a/plans/wt-1.json',
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_file, data) => {
      capturedWrittenPayload = data;
      return Promise.resolve();
    });
  });

  it('saveTrackedPlanComments writes the threads and returns the updated plan', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify(makePlanFile('Phase one\nPhase two', [])),
    );

    const nextThreads: PlanCommentThread[] = [matchedThread];
    const updated = await saveTrackedPlanComments({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      commentThreads: nextThreads,
    });

    expect(updated?.commentThreads).toEqual(nextThreads);
    expect(updated?.content).toBe('Phase one\nPhase two');

    const written = parseWrittenTrackedPlansFile(capturedWrittenPayload);
    expect(written.plans[0]?.commentThreads?.[0]?.id).toBe('thread-keep');
  });

  it('saveTrackedPlanComments preserves durable comments missing from a stale renderer snapshot', async () => {
    const existingThread: PlanCommentThread = {
      ...matchedThread,
      status: 'resolved',
      anchorState: 'outdated',
      comments: [
        {
          id: 'c-user',
          author: 'user',
          body: 'Please tighten this',
          createdAt: '2026-03-31T00:05:00.000Z',
          staged: false,
        },
        {
          id: 'c-agent',
          author: 'agent',
          body: 'Addressed in the latest revision.',
          createdAt: '2026-03-31T00:06:00.000Z',
          staged: false,
        },
      ],
    };
    mockedReadFile.mockResolvedValue(
      JSON.stringify(makePlanFile('Phase one\nPhase two', [existingThread])),
    );

    const staleRendererThread: PlanCommentThread = {
      ...existingThread,
      status: 'open',
      anchorState: 'matched',
      comments: [existingThread.comments[0]],
    };
    const updated = await saveTrackedPlanComments({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      commentThreads: [staleRendererThread],
    });

    const merged = updated?.commentThreads?.[0];
    expect(merged?.status).toBe('resolved');
    expect(merged?.anchorState).toBe('outdated');
    expect(merged?.comments.map((comment) => comment.id)).toEqual([
      'c-user',
      'c-agent',
    ]);
  });

  it('saveTrackedPlanComments rejects invalid comment thread payloads', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify(makePlanFile('Phase one', [])),
    );

    await expect(
      saveTrackedPlanComments({
        projectId: 'project-a',
        worktreeId: 'wt-1',
        planId: 'plan-1',
        commentThreads: [
          {
            id: 'invalid-thread',
            status: 'open',
            createdAt: '2026-03-31T00:05:00.000Z',
            anchor: {},
            anchorState: 'matched',
            comments: [],
          },
        ],
      } as unknown as Parameters<typeof saveTrackedPlanComments>[0]),
    ).rejects.toThrow('Invalid plan comment threads payload.');
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('saveTrackedPlanComments returns null for an unknown plan', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify(makePlanFile('Phase one', [])),
    );

    const updated = await saveTrackedPlanComments({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'missing-plan',
      commentThreads: [matchedThread],
    });

    expect(updated).toBeNull();
  });

  it('re-evaluates anchor state when content changes', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify(
        makePlanFile('Phase one\nPhase two', [
          matchedThread,
          willOutdateThread,
        ]),
      ),
    );

    const updated = await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      // Drops "Phase two", keeps "Phase one".
      content: 'Phase one only',
      chatId: 'chat-1',
      initiationSource: 'user',
    });

    expect(updated?.latestRevisionNumber).toBe(2);
    const kept = updated?.commentThreads?.find((t) => t.id === 'thread-keep');
    const dropped = updated?.commentThreads?.find(
      (t) => t.id === 'thread-drop',
    );
    expect(kept?.anchorState).toBe('matched');
    expect(dropped?.anchorState).toBe('outdated');
  });

  it('does not disturb anchor state on non-content updates', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify(
        makePlanFile('Phase one\nPhase two', [
          matchedThread,
          willOutdateThread,
        ]),
      ),
    );

    const updated = await updateTrackedPlan({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      reviewStatus: 'approved',
      approvedAt: '2026-03-31T01:00:00.000Z',
      chatId: 'chat-1',
      initiationSource: 'user',
    });

    expect(updated?.latestRevisionNumber).toBe(1);
    const both = updated?.commentThreads ?? [];
    expect(both.every((t) => t.anchorState === 'matched')).toBe(true);
  });
});

describe('plan comment reply persistence (agent tools)', () => {
  let capturedWrittenPayload: unknown;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedWrittenPayload = undefined;
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/project-a/plans/wt-1.json',
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
    mockedWriteFile.mockImplementation((_file, data) => {
      capturedWrittenPayload = data;
      return Promise.resolve();
    });
  });

  it('appendPlanCommentReply appends an agent comment and resolves the thread', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify(
        makePlanFile('Phase one\nPhase two', [
          matchedThread,
          willOutdateThread,
        ]),
      ),
    );

    const result = await appendPlanCommentReply({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      threadId: 'thread-keep',
      body: 'Addressed in the latest revision.',
      resolve: true,
    });

    expect(result.ok).toBe(true);
    const thread = result.plan?.commentThreads?.find(
      (t) => t.id === 'thread-keep',
    );
    expect(thread?.status).toBe('resolved');
    expect(thread?.comments).toHaveLength(2);
    const reply = thread?.comments[1];
    expect(reply?.author).toBe('agent');
    expect(reply?.body).toBe('Addressed in the latest revision.');
    expect(reply?.staged).toBe(false);
    expect(typeof reply?.id).toBe('string');

    // The other thread is preserved verbatim (no clobbering).
    const other = result.plan?.commentThreads?.find(
      (t) => t.id === 'thread-drop',
    );
    expect(other).toEqual(willOutdateThread);

    const written = parseWrittenTrackedPlansFile(capturedWrittenPayload);
    const writtenThread = written.plans[0]?.commentThreads?.find(
      (t) => t.id === 'thread-keep',
    );
    expect(writtenThread?.status).toBe('resolved');
    expect(writtenThread?.comments).toHaveLength(2);
  });

  it('appendPlanCommentReply keeps the thread open when resolve is unset', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify(makePlanFile('Phase one', [willOutdateThread])),
    );

    const result = await appendPlanCommentReply({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      threadId: 'thread-drop',
      body: 'Can you clarify what you want here?',
    });

    expect(result.ok).toBe(true);
    const thread = result.plan?.commentThreads?.find(
      (t) => t.id === 'thread-drop',
    );
    expect(thread?.status).toBe('open');
    expect(thread?.comments).toHaveLength(1);
    expect(thread?.comments[0]?.author).toBe('agent');
  });

  it('appendPlanCommentReply errors for a missing thread', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify(makePlanFile('Phase one', [matchedThread])),
    );

    const result = await appendPlanCommentReply({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      threadId: 'missing-thread',
      body: 'hi',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Comment thread not found.');
    expect(result.reason).toBeUndefined();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('appendPlanCommentReply errors for a missing plan', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify(makePlanFile('Phase one', [matchedThread])),
    );

    const result = await appendPlanCommentReply({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'missing-plan',
      threadId: 'thread-keep',
      body: 'hi',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Plan not found.');
  });

  it('requireSubmittedThread rejects a reply to a draft-only thread and writes nothing', async () => {
    const draftOnlyThread: PlanCommentThread = {
      id: 'thread-draft',
      status: 'open',
      createdAt: '2026-03-31T00:05:00.000Z',
      anchor: { quote: 'Phase one' },
      anchorState: 'matched',
      comments: [
        {
          id: 'c-draft',
          author: 'user',
          body: 'not yet sent',
          createdAt: '2026-03-31T00:05:00.000Z',
          staged: true,
        },
      ],
    };
    mockedReadFile.mockResolvedValue(
      JSON.stringify(makePlanFile('Phase one', [draftOnlyThread])),
    );

    const result = await appendPlanCommentReply({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      threadId: 'thread-draft',
      body: 'agent reply',
      requireSubmittedThread: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Comment thread has not been submitted.');
    expect(result.reason).toBe('not-submitted');
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('requireSubmittedThread allows a reply once the thread has a non-draft comment', async () => {
    const submittedThread: PlanCommentThread = {
      id: 'thread-submitted',
      status: 'open',
      createdAt: '2026-03-31T00:05:00.000Z',
      anchor: { quote: 'Phase one' },
      anchorState: 'matched',
      comments: [
        {
          id: 'c-sent',
          author: 'user',
          body: 'sent to chat',
          createdAt: '2026-03-31T00:05:00.000Z',
          staged: false,
        },
      ],
    };
    mockedReadFile.mockResolvedValue(
      JSON.stringify(makePlanFile('Phase one', [submittedThread])),
    );

    const result = await appendPlanCommentReply({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      threadId: 'thread-submitted',
      body: 'agent reply',
      requireSubmittedThread: true,
    });

    expect(result.ok).toBe(true);
    expect(mockedWriteFile).toHaveBeenCalled();
  });

  it('a reply never bumps latestRevisionNumber or touches content/diagrams', async () => {
    const file = makePlanFile('Phase one\nPhase two', [matchedThread]);
    file.plans[0].latestRevisionNumber = 3;
    file.plans[0].diagrams = {
      sequence: {
        data: { schemaVersion: 1, nodes: [], edges: [] },
        derivedFromRevision: 3,
        status: 'ready',
        generatedAt: '2026-03-31T00:05:00.000Z',
      },
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const result = await appendPlanCommentReply({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      threadId: 'thread-keep',
      body: 'addressed',
    });

    expect(result.ok).toBe(true);
    expect(result.plan?.latestRevisionNumber).toBe(3);
    expect(result.plan?.content).toBe('Phase one\nPhase two');
    expect(result.plan?.diagrams?.sequence?.status).toBe('ready');

    const written = parseWrittenTrackedPlansFile(capturedWrittenPayload);
    expect(written.plans[0]?.latestRevisionNumber).toBe(3);
    expect(written.plans[0]?.content).toBe('Phase one\nPhase two');
    expect(written.plans[0]?.diagrams?.sequence?.status).toBe('ready');
  });
});

describe('readScopedPlanCommentThreads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/project-a/plans/wt-1.json',
    );
  });

  function makeMultiPlanFile(): TrackedPlansFile {
    return {
      version: 1,
      plans: [
        {
          id: 'plan-older',
          projectId: 'project-a',
          worktreeId: 'wt-1',
          source: 'claude',
          title: 'Older plan',
          content: 'Older content',
          reviewStatus: 'pending',
          createdAt: '2026-03-31T00:01:00.000Z',
          updatedAt: '2026-03-31T00:01:00.000Z',
          latestRevisionNumber: 1,
          revisions: [
            {
              revisionNumber: 1,
              content: 'Older content',
              source: 'claude',
              reviewStatus: 'pending',
              createdAt: '2026-03-31T00:01:00.000Z',
            },
          ],
          linkedExecutionIds: [],
          commentThreads: [
            { ...matchedThread, id: 'shared-thread', status: 'open' },
            { ...willOutdateThread, id: 'older-open', status: 'open' },
          ],
        },
        {
          id: 'plan-newer',
          projectId: 'project-a',
          worktreeId: 'wt-1',
          source: 'claude',
          title: 'Newer plan',
          content: 'Newer content',
          reviewStatus: 'pending',
          createdAt: '2026-03-31T00:02:00.000Z',
          updatedAt: '2026-03-31T00:02:00.000Z',
          latestRevisionNumber: 1,
          revisions: [
            {
              revisionNumber: 1,
              content: 'Newer content',
              source: 'claude',
              reviewStatus: 'pending',
              createdAt: '2026-03-31T00:02:00.000Z',
            },
          ],
          linkedExecutionIds: [],
          commentThreads: [
            { ...matchedThread, id: 'newer-open', status: 'open' },
            { ...willOutdateThread, id: 'newer-resolved', status: 'resolved' },
          ],
        },
      ],
    };
  }

  it('finds a single thread by id and reports its owning plan', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify(makeMultiPlanFile()));

    const result = await readScopedPlanCommentThreads({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      threadId: 'older-open',
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.mode === 'single') {
      expect(result.owner.planId).toBe('plan-older');
      expect(result.owner.title).toBe('Older plan');
      expect(result.owner.latestRevisionNumber).toBe(1);
      expect(result.owner.content).toBe('Older content');
      expect(result.thread.id).toBe('older-open');
    } else {
      throw new Error('expected a single-thread result');
    }
  });

  it('lists only open threads across every plan, in plan-list order', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify(makeMultiPlanFile()));

    const result = await readScopedPlanCommentThreads({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.mode === 'all') {
      // plan-newer (updatedAt 00:02) sorts before plan-older (00:01), matching
      // listTrackedPlans order; only open threads are included.
      expect(
        result.threads.map((entry) => ({
          planId: entry.owner.planId,
          threadId: entry.thread.id,
        })),
      ).toEqual([
        { planId: 'plan-newer', threadId: 'newer-open' },
        { planId: 'plan-older', threadId: 'shared-thread' },
        { planId: 'plan-older', threadId: 'older-open' },
      ]);
    } else {
      throw new Error('expected an all-threads result');
    }
  });

  it('reports ambiguous when the same thread id exists in two plans', async () => {
    const file = makeMultiPlanFile();
    const [, newerPlan] = file.plans;
    newerPlan.commentThreads = [
      ...(newerPlan.commentThreads ?? []),
      { ...matchedThread, id: 'shared-thread', status: 'open' },
    ];
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const result = await readScopedPlanCommentThreads({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      threadId: 'shared-thread',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ambiguous');
      expect(result.error).toBe('Ambiguous comment thread id.');
    }
  });

  it('reports not-found for an unknown thread id', async () => {
    mockedReadFile.mockResolvedValue(JSON.stringify(makeMultiPlanFile()));

    const result = await readScopedPlanCommentThreads({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      threadId: 'does-not-exist',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not-found');
      expect(result.error).toBe('Comment thread not found.');
    }
  });
});

describe('plan comment thread read (agent tools)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveTrackedPlansFilePath.mockReturnValue(
      '/tmp/project-a/plans/wt-1.json',
    );
  });

  it('readPlanCommentThread returns a single thread with its history', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify(makePlanFile('Phase one', [matchedThread])),
    );

    const result = await readPlanCommentThread({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      threadId: 'thread-keep',
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.mode === 'single') {
      expect(result.thread.id).toBe('thread-keep');
      expect(result.thread.comments).toHaveLength(1);
      expect(result.thread.comments[0]?.body).toBe('Looks good');
    } else {
      throw new Error('expected a single-thread result');
    }
  });

  it('readPlanCommentThread returns all threads with no threadId', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify(
        makePlanFile('Phase one\nPhase two', [
          matchedThread,
          willOutdateThread,
        ]),
      ),
    );

    const result = await readPlanCommentThread({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.mode === 'all') {
      expect(result.threads.map((t) => t.id)).toEqual([
        'thread-keep',
        'thread-drop',
      ]);
    } else {
      throw new Error('expected an all-threads result');
    }
  });

  it('readPlanCommentThread errors for a missing thread', async () => {
    mockedReadFile.mockResolvedValue(
      JSON.stringify(makePlanFile('Phase one', [matchedThread])),
    );

    const result = await readPlanCommentThread({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      planId: 'plan-1',
      threadId: 'missing-thread',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Comment thread not found.');
    }
  });
});

describe('plan comment hand-off to the agent', () => {
  // The renderer acknowledges a handed-off snapshot (drafts become
  // `staged: false`) only after the owning chat accepted the send, so the
  // agent's first tool call can race that acknowledgment.
  const disk = new Map<string, string>();
  const CREATED_AT = '2026-03-31T00:05:00.000Z';
  const REF: PlanCommentThreadRef = {
    projectId: 'project-a',
    worktreeId: 'wt-1',
    planId: 'plan-1',
    threadId: 'thread-sent',
  };
  const HANDED_OFF_THREAD: PlanCommentThread = {
    id: 'thread-sent',
    status: 'open',
    createdAt: CREATED_AT,
    anchor: { quote: 'Phase one' },
    anchorState: 'matched',
    comments: [
      {
        id: 'c-sent',
        author: 'user',
        body: 'Split phase one.',
        createdAt: CREATED_AT,
        staged: true,
      },
    ],
  };
  const ACKNOWLEDGED_THREAD: PlanCommentThread = {
    ...HANDED_OFF_THREAD,
    comments: HANDED_OFF_THREAD.comments.map((comment) => ({
      ...comment,
      staged: false,
    })),
  };

  function planPath(projectId: string, worktreeId: string): string {
    return `/tmp/${projectId}/plans/${worktreeId}.json`;
  }

  function seed(threads: PlanCommentThread[], worktreeId = 'wt-1'): void {
    disk.set(
      planPath('project-a', worktreeId),
      JSON.stringify(makePlanFile('Phase one', threads)),
    );
  }

  function persistedThread(): PlanCommentThread | undefined {
    const raw = disk.get(planPath('project-a', 'wt-1'));
    return parseWrittenTrackedPlansFile(raw).plans[0]?.commentThreads?.find(
      (thread) => thread.id === 'thread-sent',
    );
  }

  /** What the renderer's post-acceptance save does. */
  async function acknowledge(
    worktreeId = 'wt-1',
    commentThreads: PlanCommentThread[] = [ACKNOWLEDGED_THREAD],
  ): Promise<void> {
    await saveTrackedPlanComments({
      projectId: 'project-a',
      worktreeId,
      planId: 'plan-1',
      commentThreads,
    });
  }

  /** Observe a promise without awaiting it, so pending can be asserted. */
  function track<T>(promise: Promise<T>): { settled: boolean; value?: T } {
    const state: { settled: boolean; value?: T } = { settled: false };
    void promise.then((value) => {
      state.settled = true;
      state.value = value;
    });
    return state;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    disk.clear();
    mockedResolveTrackedPlansFilePath.mockImplementation(planPath);
    mockedReadFile.mockImplementation((file) => {
      const content = typeof file === 'string' ? disk.get(file) : undefined;
      return content === undefined
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(content);
    });
    mockedWriteFile.mockImplementation((file, data) => {
      if (typeof file === 'string' && typeof data === 'string') {
        disk.set(file, data);
      }
      return Promise.resolve();
    });
    mockedMkdir.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('waitForSubmittedPlanCommentThread', () => {
    it('resolves as soon as the renderer acknowledges the handed-off thread', async () => {
      seed([HANDED_OFF_THREAD]);

      const waiting = waitForSubmittedPlanCommentThread(
        REF,
        PLAN_COMMENT_HANDOFF_GRACE_MS,
      );
      await acknowledge();

      await expect(waiting).resolves.toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('resolves at once for a thread that is already submitted', async () => {
      seed([ACKNOWLEDGED_THREAD]);

      await expect(
        waitForSubmittedPlanCommentThread(REF, PLAN_COMMENT_HANDOFF_GRACE_MS),
      ).resolves.toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('resolves false after the grace when no acknowledgment arrives, writing nothing', async () => {
      seed([HANDED_OFF_THREAD]);

      const waiting = track(
        waitForSubmittedPlanCommentThread(REF, PLAN_COMMENT_HANDOFF_GRACE_MS),
      );
      await jest.advanceTimersByTimeAsync(PLAN_COMMENT_HANDOFF_GRACE_MS - 1);
      expect(waiting.settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(waiting).toEqual({ settled: true, value: false });
      expect(jest.getTimerCount()).toBe(0);
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('resolves false as soon as the thread is gone', async () => {
      seed([HANDED_OFF_THREAD]);

      const waiting = track(
        waitForSubmittedPlanCommentThread(REF, PLAN_COMMENT_HANDOFF_GRACE_MS),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(waiting.settled).toBe(false);

      // A renderer save without the draft-only thread drops it.
      await acknowledge('wt-1', []);
      await jest.advanceTimersByTimeAsync(0);

      expect(waiting).toEqual({ settled: true, value: false });
      expect(jest.getTimerCount()).toBe(0);
    });

    it('ignores writes to another worktree', async () => {
      seed([HANDED_OFF_THREAD]);
      seed([HANDED_OFF_THREAD], 'wt-2');

      const waiting = track(
        waitForSubmittedPlanCommentThread(REF, PLAN_COMMENT_HANDOFF_GRACE_MS),
      );
      await acknowledge('wt-2');
      await jest.advanceTimersByTimeAsync(0);
      expect(waiting.settled).toBe(false);

      await jest.advanceTimersByTimeAsync(PLAN_COMMENT_HANDOFF_GRACE_MS);
      expect(waiting).toEqual({ settled: true, value: false });
    });
  });

  describe('replyToPlanCommentThread', () => {
    it('posts a reply to a thread acknowledged during the grace and keeps the acknowledgment', async () => {
      seed([HANDED_OFF_THREAD]);

      const replying = replyToPlanCommentThread({
        ...REF,
        body: 'Split into two phases.',
        resolve: true,
        requireSubmittedThread: true,
      });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(mockedWriteFile).not.toHaveBeenCalled();

      await acknowledge();

      const result = await replying;
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(persistedThread()).toMatchObject({
        status: 'resolved',
        comments: [
          { id: 'c-sent', body: 'Split phase one.', staged: false },
          { author: 'agent', body: 'Split into two phases.', staged: false },
        ],
      });
      expect(mockSendToAllWindows).toHaveBeenCalledTimes(1);
      expect(mockQueueSharedPlanSync).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('still rejects a draft-only thread after the grace and leaves the file unchanged', async () => {
      seed([HANDED_OFF_THREAD]);
      const before = disk.get(planPath('project-a', 'wt-1'));

      const replying = track(
        replyToPlanCommentThread({
          ...REF,
          body: 'Split into two phases.',
          resolve: true,
          requireSubmittedThread: true,
        }),
      );
      await jest.advanceTimersByTimeAsync(PLAN_COMMENT_HANDOFF_GRACE_MS - 1);
      expect(replying.settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(replying).toEqual({
        settled: true,
        value: {
          ok: false,
          reason: 'not-submitted',
          error: 'Comment thread has not been submitted.',
        },
      });
      expect(disk.get(planPath('project-a', 'wt-1'))).toBe(before);
      expect(mockedWriteFile).not.toHaveBeenCalled();
      expect(mockSendToAllWindows).not.toHaveBeenCalled();
      expect(mockQueueSharedPlanSync).not.toHaveBeenCalled();
    });

    it('never waits on the legacy path that accepts draft-only threads', async () => {
      seed([HANDED_OFF_THREAD]);

      await expect(
        replyToPlanCommentThread({
          ...REF,
          body: 'Legacy reply.',
          resolve: false,
          requireSubmittedThread: false,
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

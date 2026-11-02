import type * as WindowSendModule from '../lib/window-send';
import type * as PlanPersistenceModule from '../lib/plan-persistence';
import type * as PlanFileSyncModule from '../lib/plan-file-sync';
import type * as SharedPlanSyncModule from '../lib/shared-plan-sync';
import type * as CodeReviewDiffModule from '../lib/code-review-diff';
import type {
  AppendPlanCommentReplyResult,
  PlanCommentThreadOwner,
  ReadScopedPlanCommentThreadsResult,
} from '../lib/plan-persistence';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type PlanCommentThread,
  type PreferencesData,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { DEFAULT_COMMIT_MESSAGE_INSTRUCTIONS } from '@canopy/desktop-shared/lib/commit-message-generator';
import { DEFAULT_PR_CONTENT_INSTRUCTIONS } from '@canopy/desktop-shared/lib/github-pr-generator';
import type { SendableBrowserWindow } from '../lib/window-send';
import type * as WorkspacePersistence from '../lib/workspace-persistence';

const mockReadPreferencesFile = jest.fn();
const mockReadWorkspaceConfigDetailed = jest.fn();
jest.mock('../lib/workspace-persistence', () => {
  const actual = jest.requireActual<typeof WorkspacePersistence>(
    '../lib/workspace-persistence',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      readWorkspaceConfigDetailed: {
        configurable: true,
        enumerable: true,
        value: (...args: unknown[]): unknown =>
          mockReadWorkspaceConfigDetailed(...args),
        writable: true,
      },
    },
  );
});
const mockCheckGitHubCliStatus = jest.fn();
const mockGetCodeReviewTarget = jest.fn();
const mockGetPlanExploreTarget = jest.fn();
const mockReadReviewCommentThread = jest.fn();
const mockReadFileCommentThreads = jest.fn();
const mockRespondToFileComment = jest.fn();
const mockAppendReviewCommentReply = jest.fn();
const mockAppendInboxNote = jest.fn();
const mockSearchMemory = jest.fn();
const mockReadMemoryFile = jest.fn();
const mockRecordUsage = jest.fn();
const mockSeedEntry = jest.fn();
const mockGetUserMemoryDir = jest.fn(() => '/memory/user');
const mockGetWorkspaceMemoryDir = jest.fn(
  (workspaceId: string) => `/memory/workspaces/${workspaceId}`,
);
const mockListReviewRepos = jest.fn<
  Promise<unknown>,
  Parameters<typeof CodeReviewDiffModule.listReviewRepos>
>(() => Promise.resolve([{ repoId: 'default', repoPath: '/repo' }]));
const mockComputeReviewFingerprint = jest.fn<
  Promise<string>,
  Parameters<typeof CodeReviewDiffModule.computeReviewFingerprint>
>(() => Promise.resolve('fp-1'));
type AppendPlanCommentReply =
  typeof PlanPersistenceModule.appendPlanCommentReply;
type ReadScopedPlanCommentThreads =
  typeof PlanPersistenceModule.readScopedPlanCommentThreads;
type WaitForSubmittedPlanCommentThread =
  typeof PlanPersistenceModule.waitForSubmittedPlanCommentThread;
type QueueSharedPlanSync = typeof SharedPlanSyncModule.queueSharedPlanSync;
type MaterializePlanFile =
  PlanFileSyncModule.PlanFileSyncService['materializePlanFile'];
const mockAppendPlanCommentReply = jest.fn<
  ReturnType<AppendPlanCommentReply>,
  Parameters<AppendPlanCommentReply>
>();
const mockReadScopedPlanCommentThreads = jest.fn<
  ReturnType<ReadScopedPlanCommentThreads>,
  Parameters<ReadScopedPlanCommentThreads>
>();
const mockWaitForSubmittedPlanCommentThread = jest.fn<
  ReturnType<WaitForSubmittedPlanCommentThread>,
  Parameters<WaitForSubmittedPlanCommentThread>
>();
const mockQueueSharedPlanSync = jest.fn<
  ReturnType<QueueSharedPlanSync>,
  Parameters<QueueSharedPlanSync>
>();
const mockMaterializePlanFile = jest.fn<
  ReturnType<MaterializePlanFile>,
  Parameters<MaterializePlanFile>
>();

const mockBroadcast = jest.fn();
jest.mock('../lib/window-send', () => ({
  ...jest.requireActual<typeof WindowSendModule>('../lib/window-send'),
  sendToAllWindows: (...args: unknown[]): void => {
    mockBroadcast(...args);
  },
}));

jest.mock('../lib/preferences-store', () => ({
  get readPreferencesFile(): typeof mockReadPreferencesFile {
    return mockReadPreferencesFile;
  },
}));

jest.mock('../lib/github-auth', () => ({
  ...jest.requireActual<object>('../lib/github-auth'),
  get checkGitHubCliStatus(): typeof mockCheckGitHubCliStatus {
    return mockCheckGitHubCliStatus;
  },
}));

jest.mock('../lib/code-review-registry', () => ({
  get getCodeReviewTarget(): typeof mockGetCodeReviewTarget {
    return mockGetCodeReviewTarget;
  },
}));

jest.mock('../lib/plan-explore-registry', () => ({
  get getPlanExploreTarget(): typeof mockGetPlanExploreTarget {
    return mockGetPlanExploreTarget;
  },
}));

jest.mock('../lib/code-review-persistence', () => ({
  get readReviewCommentThread(): typeof mockReadReviewCommentThread {
    return mockReadReviewCommentThread;
  },
  get appendReviewCommentReply(): typeof mockAppendReviewCommentReply {
    return mockAppendReviewCommentReply;
  },
}));

jest.mock('../lib/plan-persistence', () => {
  const actual = jest.requireActual<typeof PlanPersistenceModule>(
    '../lib/plan-persistence',
  );
  const mocked = Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      appendPlanCommentReply: {
        configurable: true,
        enumerable: true,
        value: (
          ...args: Parameters<AppendPlanCommentReply>
        ): ReturnType<AppendPlanCommentReply> =>
          mockAppendPlanCommentReply(...args),
        writable: true,
      },
      readScopedPlanCommentThreads: {
        configurable: true,
        enumerable: true,
        value: (
          ...args: Parameters<ReadScopedPlanCommentThreads>
        ): ReturnType<ReadScopedPlanCommentThreads> =>
          mockReadScopedPlanCommentThreads(...args),
        writable: true,
      },
      waitForSubmittedPlanCommentThread: {
        configurable: true,
        enumerable: true,
        value: (
          ...args: Parameters<WaitForSubmittedPlanCommentThread>
        ): ReturnType<WaitForSubmittedPlanCommentThread> =>
          mockWaitForSubmittedPlanCommentThread(...args),
        writable: true,
      },
    },
  );
  // The main-process import graph re-enters this factory while the actual
  // module is still loading (plan-persistence -> ... -> archived-containers ->
  // plan-persistence), and modules loaded inside that cycle keep the partial
  // copy, whose `const` exports are still undefined. Read the grace lazily.
  Object.defineProperty(mocked, 'PLAN_COMMENT_HANDOFF_GRACE_MS', {
    enumerable: true,
    get: (): number => actual.PLAN_COMMENT_HANDOFF_GRACE_MS,
  });
  return mocked;
});

jest.mock('../lib/shared-plan-sync', () => ({
  queueSharedPlanSync: (...args: Parameters<QueueSharedPlanSync>): void => {
    mockQueueSharedPlanSync(...args);
  },
}));

jest.mock('../lib/plan-file-sync', () => ({
  getPlanFileSyncService: (): {
    materializePlanFile: MaterializePlanFile;
  } => ({
    materializePlanFile: (
      ...args: Parameters<MaterializePlanFile>
    ): ReturnType<MaterializePlanFile> => mockMaterializePlanFile(...args),
  }),
}));

jest.mock('../canopy-tools/file-comment-core-client', () => ({
  get readFileCommentThreads(): typeof mockReadFileCommentThreads {
    return mockReadFileCommentThreads;
  },
  get respondToFileComment(): typeof mockRespondToFileComment {
    return mockRespondToFileComment;
  },
}));

jest.mock('../lib/code-review-diff', () => ({
  listReviewRepos: (
    ...args: Parameters<typeof CodeReviewDiffModule.listReviewRepos>
  ): Promise<unknown> => mockListReviewRepos(...args),
  computeReviewFingerprint: (
    ...args: Parameters<typeof CodeReviewDiffModule.computeReviewFingerprint>
  ): Promise<string> => mockComputeReviewFingerprint(...args),
}));

jest.mock('../memory/local/store', () => ({
  get appendInboxNote(): typeof mockAppendInboxNote {
    return mockAppendInboxNote;
  },
  get searchMemory(): typeof mockSearchMemory {
    return mockSearchMemory;
  },
  get readMemoryFile(): typeof mockReadMemoryFile {
    return mockReadMemoryFile;
  },
}));

jest.mock('../memory/local/usage', () => ({
  get recordUsage(): typeof mockRecordUsage {
    return mockRecordUsage;
  },
  get seedEntry(): typeof mockSeedEntry {
    return mockSeedEntry;
  },
}));

jest.mock('../lib/paths', () => ({
  get getUserMemoryDir(): typeof mockGetUserMemoryDir {
    return mockGetUserMemoryDir;
  },
  get getWorkspaceMemoryDir(): typeof mockGetWorkspaceMemoryDir {
    return mockGetWorkspaceMemoryDir;
  },
}));

import { PLAN_COMMENT_HANDOFF_GRACE_MS } from '../lib/plan-persistence';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import {
  getFileCommentsInSession,
  getReviewCommentThreadInSession,
  loadGitPreferences,
  respondToFileCommentInSession,
  readLocalMemory,
  saveLocalMemory,
  searchLocalMemory,
} from '../canopy-tools/session-runtime';

function gitPreferenceDefaults(
  overrides: Partial<PreferencesData>,
): PreferencesData {
  // A partial fixture: these tests rely on unset preferences staying undefined.
  const preferences: Partial<PreferencesData> = {
    branchNamePrefixMode: 'none',
    branchNameCustomPrefix: '',
    branchNamingInstructions: '',
    prInstructions: '',
    prInstructionMode: 'append',
    commitInstructions: '',
    commitInstructionMode: 'append',
    ...overrides,
  };
  return preferences as PreferencesData;
}

function trackedPlanFixture(
  overrides: Partial<TrackedPlanData> = {},
): TrackedPlanData {
  return {
    id: 'plan-1',
    projectId: 'project',
    worktreeId: 'worktree',
    source: 'claude',
    title: 'Ship the plan panel',
    content: '# Ship the plan panel\n\n## Steps\n\n- Add the panel\n',
    reviewStatus: 'pending',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    latestRevisionNumber: 3,
    revisions: [],
    linkedExecutionIds: [],
    share: {
      serverId: 'canopy-cloud',
      remoteId: 'remote-plan-1',
      shareScope: 'team',
      teamId: 'team-1',
      syncStatus: 'synced',
    },
    ...overrides,
  };
}

const PLAN_OWNER: PlanCommentThreadOwner = {
  projectId: 'project',
  worktreeId: 'worktree',
  planId: 'plan-1',
  title: 'Ship the plan panel',
  latestRevisionNumber: 3,
  content: '# Ship the plan panel\n\n## Steps\n\n- Add the panel\n',
};

const OTHER_PLAN_OWNER: PlanCommentThreadOwner = {
  ...PLAN_OWNER,
  planId: 'plan-2',
  title: 'Retire the plan chat',
  latestRevisionNumber: 1,
};

function planThreadFixture(
  overrides: Partial<PlanCommentThread> = {},
): PlanCommentThread {
  return {
    id: 'plan-thread',
    status: 'open',
    createdAt: '2026-09-28T01:00:00.000Z',
    anchorState: 'matched',
    anchor: {
      quote: '- Add the panel',
      renderedText: 'Add the panel',
      lineStart: 5,
      lineEnd: 5,
      planNodeId: 'step-1',
      headingPath: ['Ship the plan panel', 'Steps'],
    },
    comments: [
      {
        id: 'owner-question',
        author: 'user',
        body: 'Should this be split?',
        createdAt: '2026-09-28T01:00:00.000Z',
        staged: false,
      },
      {
        id: 'ada-reply',
        author: 'remote',
        remoteAuthor: { userId: 'user-ada', displayName: 'Ada Lovelace' },
        body: 'Agree, split it.',
        createdAt: '2026-09-28T02:00:00.000Z',
        submittedToChat: true,
      },
      {
        id: 'departed-reply',
        author: 'remote',
        remoteAuthor: { userId: 'user-gone', displayName: null },
        body: 'Plus one.',
        createdAt: '2026-09-28T03:00:00.000Z',
      },
      {
        id: 'agent-reply',
        author: 'agent',
        body: 'Split into two steps.',
        createdAt: '2026-09-28T04:00:00.000Z',
        staged: false,
      },
      {
        id: 'owner-draft',
        author: 'user',
        body: 'private follow-up draft',
        createdAt: '2026-09-28T05:00:00.000Z',
        staged: true,
      },
    ],
    ...overrides,
  };
}

/**
 * A thread whose only comment was just handed off to the chat: the send was
 * accepted, but the renderer has not yet acknowledged it (`staged: true`).
 */
function draftOnlyPlanThreadFixture(
  options: { staged?: boolean } = {},
): PlanCommentThread {
  return planThreadFixture({
    comments: [
      {
        id: 'handed-off',
        author: 'user',
        body: 'Please split this step.',
        createdAt: '2026-09-28T06:00:00.000Z',
        staged: options.staged ?? true,
      },
    ],
  });
}

const PLAN_THREAD_REF = {
  projectId: 'project',
  worktreeId: 'worktree',
  planId: 'plan-1',
  threadId: 'plan-thread',
};

const NOT_SUBMITTED_REPLY: AppendPlanCommentReplyResult = {
  ok: false,
  reason: 'not-submitted',
  error: 'Comment thread has not been submitted.',
};

interface PlanThreadEntry {
  owner: PlanCommentThreadOwner;
  thread: PlanCommentThread;
}

/** Mirrors `readScopedPlanCommentThreads` over an in-memory scope. */
function scopedPlanThreads(
  entries: readonly PlanThreadEntry[],
): (request: {
  threadId?: string;
}) => Promise<ReadScopedPlanCommentThreadsResult> {
  return (request) => {
    if (request.threadId === undefined) {
      return Promise.resolve({
        ok: true,
        mode: 'all',
        threads: entries.filter((entry) => entry.thread.status === 'open'),
      });
    }
    const matches = entries.filter(
      (entry) => entry.thread.id === request.threadId,
    );
    if (matches.length === 0) {
      return Promise.resolve({
        ok: false,
        reason: 'not-found',
        error: 'Comment thread not found.',
      });
    }
    if (matches.length > 1) {
      return Promise.resolve({
        ok: false,
        reason: 'ambiguous',
        error: 'Ambiguous comment thread id.',
      });
    }
    const [match] = matches;
    return Promise.resolve({
      ok: true,
      mode: 'single',
      owner: match.owner,
      thread: match.thread,
    });
  };
}

const REVIEW_THREAD_WITH_SAME_ID = {
  id: 'plan-thread',
  status: 'open',
  createdAt: '2026-09-28T00:00:00.000Z',
  anchorState: 'matched',
  anchor: {
    source: 'code',
    filePath: 'src/file.ts',
    side: 'new',
    lineStart: 1,
    quote: 'const value = 1;',
  },
  comments: [
    {
      id: 'review-comment',
      author: 'user',
      body: 'Submitted review comment.',
      createdAt: '2026-09-28T00:00:00.000Z',
      staged: false,
    },
  ],
};

describe('tracked-plan comment threads through the file-comment tools', () => {
  beforeEach(() => {
    mockGetCodeReviewTarget.mockReset();
    mockReadReviewCommentThread.mockReset();
    mockReadFileCommentThreads.mockReset();
    mockRespondToFileComment.mockReset();
    mockAppendReviewCommentReply.mockReset();
    mockReadScopedPlanCommentThreads.mockReset();
    mockMaterializePlanFile.mockReset();
    mockAppendPlanCommentReply.mockReset();
    mockQueueSharedPlanSync.mockReset();
    mockBroadcast.mockReset();
    mockWaitForSubmittedPlanCommentThread.mockReset();
    mockWaitForSubmittedPlanCommentThread.mockResolvedValue(false);
    mockReadFileCommentThreads.mockImplementation(
      (request: { threadId?: string }) =>
        Promise.resolve(
          request.threadId === undefined
            ? { ok: true, mode: 'all', threads: [] }
            : { ok: false, error: 'File comment thread not found.' },
        ),
    );
    mockReadReviewCommentThread.mockImplementation(
      (request: { threadId?: string }) =>
        Promise.resolve(
          request.threadId === undefined
            ? { ok: true, mode: 'all', threads: [] }
            : { ok: false, error: 'Comment thread not found.' },
        ),
    );
    mockReadScopedPlanCommentThreads.mockImplementation(scopedPlanThreads([]));
    mockMaterializePlanFile.mockResolvedValue(null);
    mockRespondToFileComment.mockResolvedValue({
      ok: false,
      resolved: false,
      error: 'File comment thread not found.',
    });
  });

  afterEach(() => {
    registerWorkspaceTypes(new Map());
  });

  it('reads a plan thread with its plan, editable file, anchor, and redacted history', async () => {
    mockReadScopedPlanCommentThreads.mockImplementation(
      scopedPlanThreads([{ owner: PLAN_OWNER, thread: planThreadFixture() }]),
    );
    mockMaterializePlanFile.mockResolvedValue({
      filePath: '/data/plan-explore/plan-1/plan.md',
      title: 'Ship the plan panel',
      latestRevisionNumber: 3,
    });

    const result = await getFileCommentsInSession({
      projectId: 'project',
      worktreeId: 'worktree',
      threadId: 'plan-thread',
    });

    expect(mockReadScopedPlanCommentThreads).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      threadId: 'plan-thread',
    });
    // D-K: the read creates or refreshes only an unedited working copy; it
    // never flushes an edited file into a revision.
    expect(mockMaterializePlanFile).toHaveBeenCalledTimes(1);
    expect(mockMaterializePlanFile).toHaveBeenCalledWith(
      { projectId: 'project', worktreeId: 'worktree', planId: 'plan-1' },
      { flush: false },
    );
    expect(result).toEqual({
      ok: true,
      text: [
        'Plan "Ship the plan panel" (plan plan-1, latest revision 3)',
        'Plan file: /data/plan-explore/plan-1/plan.md',
        'Thread plan-thread [open] (anchor matched)',
        'Source: document passage',
        'Anchor: Ship the plan panel > Steps; line 5; node step-1',
        'Anchor validity: matches revision 3',
        'Quote:',
        '```markdown',
        '- Add the panel',
        '```',
        '',
        'Comments:',
        '- [user] 2026-09-28T01:00:00.000Z: Should this be split?',
        '- [remote: Ada Lovelace] 2026-09-28T02:00:00.000Z: Agree, split it.',
        '- [remote: unknown teammate] 2026-09-28T03:00:00.000Z: Plus one.',
        '- [agent] 2026-09-28T04:00:00.000Z: Split into two steps.',
        '- [user] 2026-09-28T05:00:00.000Z (staged draft): [redacted draft]',
      ].join('\n'),
    });
    expect(result.text).not.toContain('private follow-up draft');
    expect(mockWaitForSubmittedPlanCommentThread).not.toHaveBeenCalled();
  });

  it('reports no editable plan file when none is current and describes diagram, general, and outdated anchors', async () => {
    mockReadScopedPlanCommentThreads.mockImplementation(
      scopedPlanThreads([
        {
          owner: PLAN_OWNER,
          thread: planThreadFixture({
            id: 'diagram-thread',
            anchor: {
              source: 'diagram',
              diagramKind: 'logicDiff',
              planNodeId: 'node-auth',
              renderedText: 'Validate token',
              quote: '',
              unanchored: true,
            },
          }),
        },
        {
          owner: PLAN_OWNER,
          thread: planThreadFixture({
            id: 'general-thread',
            anchor: { quote: '', unanchored: true },
          }),
        },
        {
          owner: PLAN_OWNER,
          thread: planThreadFixture({
            id: 'outdated-thread',
            anchorState: 'outdated',
            anchor: {
              quote: '- Removed step',
              lineStart: 7,
              lineEnd: 9,
              headingPath: ['Ship the plan panel', 'Steps'],
            },
          }),
        },
      ]),
    );

    const read = async (threadId: string): Promise<string> =>
      (
        await getFileCommentsInSession({
          projectId: 'project',
          worktreeId: 'worktree',
          threadId,
        })
      ).text;

    const diagram = await read('diagram-thread');
    expect(diagram).toContain('Plan file: none available for editing');
    expect(mockMaterializePlanFile).toHaveBeenCalledWith(
      { projectId: 'project', worktreeId: 'worktree', planId: 'plan-1' },
      { flush: false },
    );
    expect(diagram).toContain('Source: logic diagram node "Validate token"');
    expect(diagram).toContain('Anchor: node node-auth');
    expect(diagram).toContain('Quote: none');

    const general = await read('general-thread');
    expect(general).toContain('Source: general note (not anchored)');
    expect(general).toContain('Anchor: none');

    const outdated = await read('outdated-thread');
    expect(outdated).toContain(
      'Thread outdated-thread [open] (anchor outdated)',
    );
    expect(outdated).toContain(
      'Anchor: Ship the plan panel > Steps; lines 7-9',
    );
    expect(outdated).toContain(
      'Anchor validity: outdated; the quoted text is no longer in revision 3',
    );
  });

  it('lists submitted open plan threads beside file and review threads and omits draft-only ones', async () => {
    mockReadReviewCommentThread.mockImplementation(
      (request: { threadId?: string }) =>
        Promise.resolve(
          request.threadId === undefined
            ? {
                ok: true,
                mode: 'all',
                threads: [{ ...REVIEW_THREAD_WITH_SAME_ID, id: 'review-1' }],
              }
            : { ok: false, error: 'Comment thread not found.' },
        ),
    );
    mockReadScopedPlanCommentThreads.mockImplementation(
      scopedPlanThreads([
        { owner: PLAN_OWNER, thread: planThreadFixture() },
        {
          owner: OTHER_PLAN_OWNER,
          thread: planThreadFixture({
            id: 'draft-only',
            comments: [
              {
                id: 'draft',
                author: 'user',
                body: 'not submitted yet',
                createdAt: '2026-09-28T06:00:00.000Z',
                staged: true,
              },
            ],
          }),
        },
        {
          owner: OTHER_PLAN_OWNER,
          thread: planThreadFixture({ id: 'resolved', status: 'resolved' }),
        },
      ]),
    );

    const result = await getFileCommentsInSession({
      projectId: 'project',
      worktreeId: 'worktree',
    });

    expect(mockReadScopedPlanCommentThreads).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
    });
    expect(result.ok).toBe(true);
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('2 open file/diff/diagram/plan comment thread(s):');
    expect(lines).toContain(
      '- plan-thread [open] 5 comment(s): Plan "Ship the plan panel" (plan-1) document passage (Ship the plan panel > Steps, line 5, node step-1) [anchor matched]',
    );
    expect(result.text).toContain('- review-1 [open] Review:');
    expect(result.text).not.toContain('draft-only');
    expect(result.text).not.toContain('resolved');
    expect(result.text).not.toContain('not submitted yet');
    expect(mockWaitForSubmittedPlanCommentThread).not.toHaveBeenCalled();
    // The summary never writes a working copy; only a single-thread read does.
    expect(mockMaterializePlanFile).not.toHaveBeenCalled();
  });

  it('keeps a plan thread readable when the working copy cannot be materialized', async () => {
    mockReadScopedPlanCommentThreads.mockImplementation(
      scopedPlanThreads([{ owner: PLAN_OWNER, thread: planThreadFixture() }]),
    );
    mockMaterializePlanFile.mockRejectedValue(new Error('EACCES'));

    const result = await getFileCommentsInSession({
      projectId: 'project',
      worktreeId: 'worktree',
      threadId: 'plan-thread',
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain('Plan file: none available for editing');
    expect(result.text).toContain('Thread plan-thread [open] (anchor matched)');
  });

  it('reports an empty scope as having no open file or plan threads', async () => {
    await expect(
      getFileCommentsInSession({
        projectId: 'project',
        worktreeId: 'worktree',
      }),
    ).resolves.toEqual({
      ok: true,
      text: 'No open file or plan comment threads.',
    });
  });

  it.each([
    ['a file thread', 'file'],
    ['a review thread', 'review'],
    ['another plan', 'plan'],
  ])(
    'rejects a thread id shared by a plan and %s as ambiguous',
    async (_label, otherStore) => {
      const entries: PlanThreadEntry[] = [
        { owner: PLAN_OWNER, thread: planThreadFixture() },
      ];
      if (otherStore === 'plan') {
        entries.push({ owner: OTHER_PLAN_OWNER, thread: planThreadFixture() });
      }
      mockReadScopedPlanCommentThreads.mockImplementation(
        scopedPlanThreads(entries),
      );
      if (otherStore === 'file') {
        mockReadFileCommentThreads.mockResolvedValue({
          ok: true,
          mode: 'single',
          filePath: '/workspace/src/file.ts',
          thread: REVIEW_THREAD_WITH_SAME_ID,
        });
      }
      if (otherStore === 'review') {
        mockReadReviewCommentThread.mockResolvedValue({
          ok: true,
          mode: 'single',
          thread: REVIEW_THREAD_WITH_SAME_ID,
        });
      }

      await expect(
        getFileCommentsInSession({
          projectId: 'project',
          worktreeId: 'worktree',
          threadId: 'plan-thread',
        }),
      ).resolves.toEqual({
        ok: false,
        text: '',
        error: 'Ambiguous comment thread id.',
      });
      await expect(
        respondToFileCommentInSession({
          projectId: 'project',
          worktreeId: 'worktree',
          threadId: 'plan-thread',
          body: 'Addressed.',
          resolve: true,
          getWindow: () => null,
        }),
      ).resolves.toEqual({
        ok: false,
        resolved: false,
        error: 'Ambiguous comment thread id.',
      });
      expect(mockAppendPlanCommentReply).not.toHaveBeenCalled();
      expect(mockAppendReviewCommentReply).not.toHaveBeenCalled();
      expect(mockRespondToFileComment).not.toHaveBeenCalled();
      expect(mockBroadcast).not.toHaveBeenCalled();
      expect(mockQueueSharedPlanSync).not.toHaveBeenCalled();
    },
  );

  it('replies to a submitted plan thread, broadcasts the plan, and queues shared sync', async () => {
    const plan = trackedPlanFixture({
      commentThreads: [planThreadFixture({ status: 'resolved' })],
    });
    mockReadScopedPlanCommentThreads.mockImplementation(
      scopedPlanThreads([{ owner: PLAN_OWNER, thread: planThreadFixture() }]),
    );
    mockAppendPlanCommentReply.mockResolvedValue({ ok: true, plan });

    const result = await respondToFileCommentInSession({
      projectId: 'project',
      worktreeId: 'worktree',
      threadId: 'plan-thread',
      body: 'Split the step in revision 4.',
      resolve: true,
      getWindow: () => null,
    });

    expect(result).toEqual({ ok: true, resolved: true, store: 'plan' });
    expect(mockAppendPlanCommentReply).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      planId: 'plan-1',
      threadId: 'plan-thread',
      body: 'Split the step in revision 4.',
      resolve: true,
      requireSubmittedThread: true,
    });
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith('tracked-plans:updated', {
      projectId: 'project',
      worktreeId: 'worktree',
      plan,
      change: 'upsert',
    });
    expect(mockQueueSharedPlanSync).toHaveBeenCalledWith(plan, 'plan');
    expect(mockRespondToFileComment).not.toHaveBeenCalled();
    expect(mockAppendReviewCommentReply).not.toHaveBeenCalled();
  });

  it('rejects a reply to a draft-only plan thread that stays unsubmitted through the hand-off grace, with no side effects', async () => {
    mockReadScopedPlanCommentThreads.mockImplementation(
      scopedPlanThreads([
        { owner: PLAN_OWNER, thread: draftOnlyPlanThreadFixture() },
      ]),
    );
    mockAppendPlanCommentReply.mockResolvedValue(NOT_SUBMITTED_REPLY);

    await expect(
      respondToFileCommentInSession({
        projectId: 'project',
        worktreeId: 'worktree',
        threadId: 'plan-thread',
        body: 'Addressed.',
        resolve: true,
        getWindow: () => null,
      }),
    ).resolves.toEqual({
      ok: false,
      resolved: false,
      error: 'Comment thread has not been submitted.',
    });
    expect(mockWaitForSubmittedPlanCommentThread).toHaveBeenCalledWith(
      PLAN_THREAD_REF,
      PLAN_COMMENT_HANDOFF_GRACE_MS,
    );
    // The persistence check runs under the plan file lock and writes nothing.
    expect(mockAppendPlanCommentReply).toHaveBeenCalledTimes(1);
    expect(mockAppendPlanCommentReply).toHaveBeenCalledWith(
      expect.objectContaining({ requireSubmittedThread: true }),
    );
    expect(mockRespondToFileComment).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockQueueSharedPlanSync).not.toHaveBeenCalled();
  });

  it('posts a reply to a plan thread the renderer acknowledges during the hand-off grace', async () => {
    const plan = trackedPlanFixture({
      commentThreads: [planThreadFixture({ status: 'resolved' })],
    });
    mockReadScopedPlanCommentThreads.mockImplementation(
      scopedPlanThreads([
        { owner: PLAN_OWNER, thread: draftOnlyPlanThreadFixture() },
      ]),
    );
    mockAppendPlanCommentReply
      .mockResolvedValueOnce(NOT_SUBMITTED_REPLY)
      .mockResolvedValueOnce({ ok: true, plan });
    mockWaitForSubmittedPlanCommentThread.mockResolvedValue(true);

    await expect(
      respondToFileCommentInSession({
        projectId: 'project',
        worktreeId: 'worktree',
        threadId: 'plan-thread',
        body: 'Split the step in revision 4.',
        resolve: true,
        getWindow: () => null,
      }),
    ).resolves.toEqual({ ok: true, resolved: true, store: 'plan' });
    expect(mockWaitForSubmittedPlanCommentThread).toHaveBeenCalledWith(
      PLAN_THREAD_REF,
      PLAN_COMMENT_HANDOFF_GRACE_MS,
    );
    expect(mockAppendPlanCommentReply).toHaveBeenCalledTimes(2);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockQueueSharedPlanSync).toHaveBeenCalledWith(plan, 'plan');
  });

  it('returns the submitted history of a plan thread the renderer acknowledges during the hand-off grace', async () => {
    mockReadScopedPlanCommentThreads
      .mockImplementationOnce(
        scopedPlanThreads([
          { owner: PLAN_OWNER, thread: draftOnlyPlanThreadFixture() },
        ]),
      )
      .mockImplementation(
        scopedPlanThreads([
          {
            owner: PLAN_OWNER,
            thread: draftOnlyPlanThreadFixture({ staged: false }),
          },
        ]),
      );
    mockWaitForSubmittedPlanCommentThread.mockResolvedValue(true);

    const result = await getFileCommentsInSession({
      projectId: 'project',
      worktreeId: 'worktree',
      threadId: 'plan-thread',
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain(
      '- [user] 2026-09-28T06:00:00.000Z: Please split this step.',
    );
    expect(result.text).not.toContain('[redacted draft]');
    expect(mockWaitForSubmittedPlanCommentThread).toHaveBeenCalledWith(
      PLAN_THREAD_REF,
      PLAN_COMMENT_HANDOFF_GRACE_MS,
    );
  });

  it('keeps a draft-only plan thread redacted when no acknowledgment arrives within the hand-off grace', async () => {
    mockReadScopedPlanCommentThreads.mockImplementation(
      scopedPlanThreads([
        { owner: PLAN_OWNER, thread: draftOnlyPlanThreadFixture() },
      ]),
    );

    const result = await getFileCommentsInSession({
      projectId: 'project',
      worktreeId: 'worktree',
      threadId: 'plan-thread',
    });

    expect(mockWaitForSubmittedPlanCommentThread).toHaveBeenCalledWith(
      PLAN_THREAD_REF,
      PLAN_COMMENT_HANDOFF_GRACE_MS,
    );
    expect(mockReadScopedPlanCommentThreads).toHaveBeenCalledTimes(1);
    expect(result.text).toContain(
      '- [user] 2026-09-28T06:00:00.000Z (staged draft): [redacted draft]',
    );
    expect(result.text).not.toContain('Please split this step.');
  });

  it('reports a failed plan reply without claiming success', async () => {
    mockReadScopedPlanCommentThreads.mockImplementation(
      scopedPlanThreads([{ owner: PLAN_OWNER, thread: planThreadFixture() }]),
    );
    mockAppendPlanCommentReply.mockResolvedValue({
      ok: false,
      error: 'Plan not found.',
    });

    await expect(
      respondToFileCommentInSession({
        projectId: 'project',
        worktreeId: 'worktree',
        threadId: 'plan-thread',
        body: 'Addressed.',
        resolve: false,
        getWindow: () => null,
      }),
    ).resolves.toEqual({
      ok: false,
      resolved: false,
      error: 'Plan not found.',
    });
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockQueueSharedPlanSync).not.toHaveBeenCalled();
  });

  it('tags review replies with their store', async () => {
    mockReadReviewCommentThread.mockResolvedValue({
      ok: true,
      mode: 'single',
      thread: { ...REVIEW_THREAD_WITH_SAME_ID, id: 'review-1' },
    });
    mockAppendReviewCommentReply.mockResolvedValue({
      ok: true,
      review: { version: 1, armed: true, commentThreads: [], diagrams: {} },
    });

    await expect(
      respondToFileCommentInSession({
        projectId: 'project',
        worktreeId: 'worktree',
        threadId: 'review-1',
        body: 'Addressed.',
        resolve: false,
        getWindow: () => null,
      }),
    ).resolves.toEqual({ ok: true, resolved: false, store: 'review' });
  });

  it('reads the reviewed scope plans from a Code Review chat', async () => {
    mockGetCodeReviewTarget.mockResolvedValue({
      projectId: 'real-project',
      worktreeId: 'real-worktree',
    });

    await getFileCommentsInSession({
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'real-project--real-worktree',
    });

    expect(mockReadScopedPlanCommentThreads).toHaveBeenCalledWith({
      projectId: 'real-project',
      worktreeId: 'real-worktree',
    });
  });

  it.each([
    ['App Advisor', APP_ADVISOR_PROJECT_ID],
    ['the legacy standalone sentinel', STANDALONE_CHAT_PROJECT_ID],
    ['a Cowork workspace', 'cowork-workspace'],
  ])('never reads tracked plans from %s', async (_label, projectId) => {
    registerWorkspaceTypes(new Map([['cowork-workspace', 'cowork']]));

    await getFileCommentsInSession({ projectId, worktreeId: 'entry-1' });
    await getFileCommentsInSession({
      projectId,
      worktreeId: 'entry-1',
      threadId: 'plan-thread',
    });
    await respondToFileCommentInSession({
      projectId,
      worktreeId: 'entry-1',
      threadId: 'plan-thread',
      body: 'Addressed.',
      resolve: true,
      getWindow: () => null,
    });

    expect(mockReadScopedPlanCommentThreads).not.toHaveBeenCalled();
    expect(mockAppendPlanCommentReply).not.toHaveBeenCalled();
    expect(mockQueueSharedPlanSync).not.toHaveBeenCalled();
  });
});

describe('canopy tool session runtime Git preferences', () => {
  beforeEach(() => {
    mockReadWorkspaceConfigDetailed.mockReset();
    mockReadWorkspaceConfigDetailed.mockResolvedValue({
      authority: 'ok',
      ownerMalformed: false,
      memoryMalformed: false,
      config: { privateMemory: false },
    });
    mockReadPreferencesFile.mockReset();
    mockCheckGitHubCliStatus.mockReset();
    mockGetCodeReviewTarget.mockReset();
    mockGetPlanExploreTarget.mockReset();
    mockReadReviewCommentThread.mockReset();
    mockReadFileCommentThreads.mockReset();
    mockRespondToFileComment.mockReset();
    mockAppendReviewCommentReply.mockReset();
    mockAppendInboxNote.mockReset();
    mockSearchMemory.mockReset();
    mockReadMemoryFile.mockReset();
    mockRecordUsage.mockReset();
    mockSeedEntry.mockReset();
    mockGetUserMemoryDir.mockClear();
    mockGetWorkspaceMemoryDir.mockClear();
    mockReadReviewCommentThread.mockResolvedValue({
      ok: false,
      error: 'Comment thread not found.',
    });
    mockReadFileCommentThreads.mockResolvedValue({
      ok: false,
      error: 'Comment thread not found.',
    });
    mockReadScopedPlanCommentThreads.mockReset();
    mockReadScopedPlanCommentThreads.mockImplementation(scopedPlanThreads([]));
  });

  it('redacts staged drafts when reading a file comment thread', async () => {
    mockReadFileCommentThreads.mockResolvedValue({
      ok: true,
      mode: 'single',
      filePath: '/workspace/src/file.ts',
      thread: {
        id: 'file-thread',
        status: 'open',
        createdAt: '2026-07-26T00:00:00.000Z',
        anchorState: 'matched',
        anchor: {
          source: 'code',
          filePath: '/workspace/src/file.ts',
          quote: 'const value = 1;',
          lineStart: 1,
          lineEnd: 1,
          side: 'new',
        },
        comments: [
          {
            id: 'draft',
            author: 'user',
            body: 'private draft',
            createdAt: '2026-07-26T00:00:00.000Z',
            staged: true,
          },
          {
            id: 'submitted',
            author: 'user',
            body: 'submitted comment',
            createdAt: '2026-07-26T00:01:00.000Z',
            staged: false,
          },
        ],
      },
    });

    const result = await getFileCommentsInSession({
      projectId: 'project',
      worktreeId: 'worktree',
      threadId: 'file-thread',
    });

    expect(result.text).toContain('[redacted draft]');
    expect(result.text).toContain('submitted comment');
    expect(result.text).not.toContain('private draft');
  });

  it('reads legacy diff and diagram threads through the ordinary file tools with explicit provenance', async () => {
    const thread = {
      id: 'legacy',
      status: 'open',
      createdAt: '2026-09-17',
      anchorState: 'matched',
      anchor: {
        source: 'code',
        filePath: 'gone.ts',
        side: 'old',
        lineStart: 4,
        quote: 'removed',
      },
      comments: [
        {
          id: 'draft',
          author: 'user',
          body: 'private',
          staged: true,
          createdAt: '2026-09-17',
        },
      ],
    };
    mockReadReviewCommentThread.mockResolvedValue({
      ok: true,
      mode: 'single',
      thread,
    });
    const result = await getFileCommentsInSession({
      projectId: 'p',
      worktreeId: 'w',
      threadId: 'legacy',
    });
    expect(result.text).toContain(
      'Diff view; source unknown; snapshot unknown; side old',
    );
    expect(result.text).toContain('anchor outdated');
    expect(result.text).not.toContain('private');
    mockReadReviewCommentThread.mockResolvedValue({
      ok: true,
      mode: 'single',
      thread: {
        ...thread,
        anchor: {
          source: 'diagram',
          diagramKind: 'logicDiff',
          nodeId: 'node',
          diagramFingerprint: 'snapshot',
          quote: 'Node',
        },
      },
    });
    expect(
      (
        await getFileCommentsInSession({
          projectId: 'p',
          worktreeId: 'w',
          threadId: 'legacy',
        })
      ).text,
    ).toContain('Change diagram: logicDiff; node node; snapshot snapshot');
    mockReadFileCommentThreads.mockResolvedValue({
      ok: true,
      mode: 'single',
      filePath: '/file',
      thread,
    });
    expect(
      await getFileCommentsInSession({
        projectId: 'p',
        worktreeId: 'w',
        threadId: 'legacy',
      }),
    ).toEqual({ ok: false, text: '', error: 'Ambiguous comment thread id.' });
  });

  it('resolves unified file tools from a code-review sentinel to the real scope', async () => {
    mockGetCodeReviewTarget.mockResolvedValue({
      projectId: 'real-project',
      worktreeId: 'real-worktree',
    });
    mockReadFileCommentThreads.mockResolvedValue({
      ok: false,
      error: 'Comment thread not found.',
    });
    mockReadReviewCommentThread.mockResolvedValue({
      ok: true,
      mode: 'single',
      thread: {
        id: 'review-thread',
        status: 'open',
        createdAt: '2026-09-18T00:00:00.000Z',
        anchorState: 'matched',
        anchor: {
          source: 'code',
          filePath: 'src/file.ts',
          side: 'new',
          lineStart: 1,
          quote: 'const value = 1;',
        },
        comments: [
          {
            id: 'comment-1',
            author: 'user',
            body: 'Please fix this.',
            createdAt: '2026-09-18T00:00:00.000Z',
            staged: false,
          },
        ],
      },
    });
    mockAppendReviewCommentReply.mockResolvedValue({
      ok: true,
      review: {
        version: 1,
        armed: true,
        commentThreads: [],
        diagrams: {},
      },
    });

    await getFileCommentsInSession({
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'real-project--real-worktree',
      threadId: 'review-thread',
    });
    await respondToFileCommentInSession({
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'real-project--real-worktree',
      threadId: 'review-thread',
      body: 'Addressed.',
      resolve: true,
      getWindow: () => null,
    });

    expect(mockGetCodeReviewTarget).toHaveBeenCalledWith(
      'real-project--real-worktree',
    );
    expect(mockReadReviewCommentThread).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'real-project',
        worktreeId: 'real-worktree',
      }),
    );
    expect(mockAppendReviewCommentReply).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'real-project',
        worktreeId: 'real-worktree',
      }),
    );
  });

  // CAN-4104: the core.annotation adapter publishes the committed reply (see
  // file-annotations-publication.test.ts); the tool must not publish again.
  it('posts a file comment reply and leaves its update to the core adapter', async () => {
    const send = jest.fn();
    const document = {
      filePath: '/workspace/src/file.ts',
      annotations: [],
      commentThreads: [],
    };
    mockRespondToFileComment.mockResolvedValue({
      ok: true,
      resolved: true,
      document,
    });
    const window: SendableBrowserWindow = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        isCrashed: () => false,
        mainFrame: {
          isDestroyed: () => false,
          detached: false,
        },
        send,
      },
    };

    const result = await respondToFileCommentInSession({
      projectId: 'project',
      worktreeId: 'worktree',
      threadId: 'file-thread',
      body: 'Addressed.',
      resolve: true,
      getWindow: () => window,
    });

    expect(result).toEqual({ ok: true, resolved: true, store: 'file' });
    expect(mockBroadcast).not.toHaveBeenCalledWith(
      'file-annotations:updated',
      expect.anything(),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('includes branch naming instructions and an explicit custom prefix with trailing slash', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({
        branchNamePrefixMode: 'custom',
        branchNameCustomPrefix: 'team',
        branchNamingInstructions: 'Use ticket ids when present.',
      }),
    );

    await expect(
      loadGitPreferences({ type: 'branch-name' }),
    ).resolves.toContain('Prefix the branch with team/');
  });

  it('resolves the GitHub username prefix when GitHub prefix mode is enabled', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({
        branchNamePrefixMode: 'github',
        branchNamingInstructions: '',
      }),
    );
    mockCheckGitHubCliStatus.mockResolvedValue({ username: 'octo-user' });

    await expect(
      loadGitPreferences({ type: 'branch-name' }),
    ).resolves.toContain('Prefix the branch with octo-user/');
  });

  it('includes explicit no-prefix guidance when branch prefix mode is none', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({
        branchNamePrefixMode: 'none',
      }),
    );

    await expect(
      loadGitPreferences({ type: 'branch-name' }),
    ).resolves.toContain('Do not prefix the branch name.');
  });

  it('returns only user PR preferences in replace mode', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({
        prInstructionMode: 'replace',
        prInstructions: 'Use the repo template exactly.',
      }),
    );

    await expect(loadGitPreferences({ type: 'pr-generation' })).resolves.toBe(
      [
        'Git preferences for pr-generation:',
        'Effective PR generation instructions:\nUse the repo template exactly.',
      ].join('\n\n'),
    );
  });

  it('returns default plus user PR preferences in append mode', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({
        prInstructionMode: 'append',
        prInstructions: 'Call out test coverage.',
      }),
    );

    await expect(loadGitPreferences({ type: 'pr-generation' })).resolves.toBe(
      [
        'Git preferences for pr-generation:',
        `Effective PR generation instructions:\n${DEFAULT_PR_CONTENT_INSTRUCTIONS}\n\nAdditional instructions:\nCall out test coverage.`,
      ].join('\n\n'),
    );
  });

  it('returns only user commit preferences in replace mode', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({
        commitInstructionMode: 'replace',
        commitInstructions: 'Use imperative mood only.',
      }),
    );

    await expect(loadGitPreferences({ type: 'commit-message' })).resolves.toBe(
      [
        'Git preferences for commit-message:',
        'Effective commit message instructions:\nUse imperative mood only.',
      ].join('\n\n'),
    );
  });

  it('returns default plus user commit preferences in append mode', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({
        commitInstructionMode: 'append',
        commitInstructions: 'Mention migrations when present.',
      }),
    );

    await expect(loadGitPreferences({ type: 'commit-message' })).resolves.toBe(
      [
        'Git preferences for commit-message:',
        `Effective commit message instructions:\n${DEFAULT_COMMIT_MESSAGE_INSTRUCTIONS}\n\nAdditional instructions:\nMention migrations when present.`,
      ].join('\n\n'),
    );
  });

  it('does not return the instruction mode marker to agents', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({
        prInstructionMode: 'append',
        commitInstructionMode: 'replace',
        prInstructions: 'Call out test coverage.',
        commitInstructions: 'Use imperative mood only.',
      }),
    );

    await expect(
      loadGitPreferences({ type: 'pr-generation' }),
    ).resolves.not.toContain('Instruction mode:');
    await expect(
      loadGitPreferences({ type: 'commit-message' }),
    ).resolves.not.toContain('Instruction mode:');
  });

  it('records usage only for files that contributed returned memory hits', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({ localMemoryEnabled: true }),
    );
    mockSearchMemory.mockResolvedValue([
      {
        fileKey: 'topics/editor.md',
        scope: 'user',
        heading: 'Editor',
        snippet: 'Uses Vim keybindings.',
      },
      {
        fileKey: 'inbox/2026-08.md',
        scope: 'workspace',
        snippet: 'This repo uses pnpm.',
      },
    ]);

    const result = await searchLocalMemory({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      query: 'editor package manager',
    });

    expect(mockSearchMemory).toHaveBeenCalledWith(
      [
        { scope: 'user', dir: '/memory/user' },
        { scope: 'workspace', dir: '/memory/workspaces/project-1' },
      ],
      'editor package manager',
    );
    expect(mockRecordUsage).toHaveBeenCalledTimes(2);
    expect(mockRecordUsage).toHaveBeenNthCalledWith(1, '/memory/user', [
      'topics/editor.md',
    ]);
    expect(mockRecordUsage).toHaveBeenNthCalledWith(
      2,
      '/memory/workspaces/project-1',
      ['inbox/2026-08.md'],
    );
    expect(result).toContain('[user] topics/editor.md > Editor');
    expect(result).toContain('[workspace] inbox/2026-08.md');
  });

  it('refuses user memory and searches only the selected private project', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({ localMemoryEnabled: true }),
    );
    mockReadWorkspaceConfigDetailed.mockResolvedValue({
      authority: 'ok',
      ownerMalformed: false,
      memoryMalformed: false,
      config: { privateMemory: true },
    });
    mockSearchMemory.mockResolvedValue([]);
    const input = { projectId: 'project-1', worktreeId: 'worktree-1' };
    await expect(
      saveLocalMemory({
        ...input,
        provider: 'claude',
        chatId: 'chat-1',
        text: 'Private marker',
        scope: 'user',
      }),
    ).resolves.toContain('User memory is unavailable');
    await expect(
      readLocalMemory({
        ...input,
        scope: 'user',
        file: 'MEMORY.md',
      }),
    ).resolves.toContain('User memory is unavailable');
    await searchLocalMemory({ ...input, query: 'marker' });
    expect(mockAppendInboxNote).not.toHaveBeenCalled();
    expect(mockReadMemoryFile).not.toHaveBeenCalled();
    expect(mockSearchMemory).toHaveBeenCalledWith(
      [{ scope: 'workspace', dir: '/memory/workspaces/project-1' }],
      'marker',
    );
  });

  it('reads user and project memory files and records their usage', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({ localMemoryEnabled: true }),
    );
    mockReadMemoryFile
      .mockResolvedValueOnce('User memory content')
      .mockResolvedValueOnce('Project memory content');

    await expect(
      readLocalMemory({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: 'user',
        file: 'topics/editor.md',
      }),
    ).resolves.toBe('User memory content');
    await expect(
      readLocalMemory({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: 'workspace',
        file: 'MEMORY.md',
      }),
    ).resolves.toBe('Project memory content');

    expect(mockReadMemoryFile).toHaveBeenNthCalledWith(
      1,
      '/memory/user',
      'topics/editor.md',
    );
    expect(mockReadMemoryFile).toHaveBeenNthCalledWith(
      2,
      '/memory/workspaces/project-1',
      'MEMORY.md',
    );
    expect(mockRecordUsage).toHaveBeenNthCalledWith(1, '/memory/user', [
      'topics/editor.md',
    ]);
    expect(mockRecordUsage).toHaveBeenNthCalledWith(
      2,
      '/memory/workspaces/project-1',
      ['MEMORY.md'],
    );
  });

  it('returns a clear result when a memory file is not found', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({ localMemoryEnabled: true }),
    );
    mockReadMemoryFile.mockResolvedValue(undefined);

    await expect(
      readLocalMemory({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: 'user',
        file: 'inbox/missing.md',
      }),
    ).resolves.toBe('Local memory file not found: [user] inbox/missing.md.');
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('seeds the usage row for a newly saved memory note', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({ localMemoryEnabled: true }),
    );
    mockAppendInboxNote.mockResolvedValue('inbox/2026-08.md');

    await expect(
      saveLocalMemory({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        provider: 'claude',
        chatId: 'chat-1',
        sessionId: 'session-1',
        text: 'Remember that this repo uses pnpm.',
        scope: 'workspace',
      }),
    ).resolves.toBe('Saved workspace memory to inbox/2026-08.md');

    expect(mockAppendInboxNote).toHaveBeenCalledWith(
      '/memory/workspaces/project-1',
      {
        text: 'Remember that this repo uses pnpm.',
        source: {
          provider: 'claude',
          chatId: 'chat-1',
          sessionId: 'session-1',
        },
      },
    );
    expect(mockSeedEntry).toHaveBeenCalledWith(
      '/memory/workspaces/project-1',
      'inbox/2026-08.md',
    );
  });

  it('gates disabled local memory without touching the store or usage index', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({ localMemoryEnabled: false }),
    );

    await expect(
      searchLocalMemory({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        query: 'anything',
      }),
    ).resolves.toBe('Local memory is disabled');
    await expect(
      saveLocalMemory({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        provider: 'codex',
        chatId: 'chat-1',
        text: 'Remember this.',
        scope: 'user',
      }),
    ).resolves.toBe('Local memory is disabled');
    await expect(
      readLocalMemory({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        scope: 'workspace',
        file: 'MEMORY.md',
      }),
    ).resolves.toBe('Local memory is disabled');

    expect(mockSearchMemory).not.toHaveBeenCalled();
    expect(mockReadMemoryFile).not.toHaveBeenCalled();
    expect(mockAppendInboxNote).not.toHaveBeenCalled();
    expect(mockRecordUsage).not.toHaveBeenCalled();
    expect(mockSeedEntry).not.toHaveBeenCalled();
  });

  it('resolves plan-explore sentinel saves to each plan target project memory dir', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({ localMemoryEnabled: true }),
    );
    mockAppendInboxNote.mockResolvedValue('inbox/2026-08.md');
    mockGetPlanExploreTarget.mockImplementation((planId: string) =>
      Promise.resolve(
        planId === 'plan-a'
          ? { projectId: 'project-a', worktreeId: 'wt-a' }
          : { projectId: 'project-b', worktreeId: 'wt-b' },
      ),
    );

    for (const planId of ['plan-a', 'plan-b']) {
      await expect(
        saveLocalMemory({
          projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
          worktreeId: planId,
          provider: 'claude',
          chatId: `chat-${planId}`,
          text: 'Remember this.',
          scope: 'workspace',
        }),
      ).resolves.toBe('Saved workspace memory to inbox/2026-08.md');
    }

    expect(mockGetPlanExploreTarget).toHaveBeenCalledWith('plan-a');
    expect(mockGetPlanExploreTarget).toHaveBeenCalledWith('plan-b');
    expect(mockAppendInboxNote).toHaveBeenNthCalledWith(
      1,
      '/memory/workspaces/project-a',
      expect.objectContaining({ text: 'Remember this.' }),
    );
    expect(mockAppendInboxNote).toHaveBeenNthCalledWith(
      2,
      '/memory/workspaces/project-b',
      expect.objectContaining({ text: 'Remember this.' }),
    );
  });

  it('resolves code-review sentinel searches to each review target project memory dir', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({ localMemoryEnabled: true }),
    );
    mockSearchMemory.mockResolvedValue([]);
    mockGetCodeReviewTarget.mockImplementation((scopeKey: string) =>
      Promise.resolve(
        scopeKey === 'project-a--wt-a'
          ? { projectId: 'project-a', worktreeId: 'wt-a' }
          : { projectId: 'project-b', worktreeId: 'wt-b' },
      ),
    );

    for (const scopeKey of ['project-a--wt-a', 'project-b--wt-b']) {
      await searchLocalMemory({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: scopeKey,
        query: 'package manager',
      });
    }

    expect(mockGetCodeReviewTarget).toHaveBeenCalledWith('project-a--wt-a');
    expect(mockGetCodeReviewTarget).toHaveBeenCalledWith('project-b--wt-b');
    expect(mockSearchMemory).toHaveBeenNthCalledWith(
      1,
      [
        { scope: 'user', dir: '/memory/user' },
        { scope: 'workspace', dir: '/memory/workspaces/project-a' },
      ],
      'package manager',
    );
    expect(mockSearchMemory).toHaveBeenNthCalledWith(
      2,
      [
        { scope: 'user', dir: '/memory/user' },
        { scope: 'workspace', dir: '/memory/workspaces/project-b' },
      ],
      'package manager',
    );
  });

  it('fails closed when a special-chat sentinel has no target', async () => {
    mockReadPreferencesFile.mockResolvedValue(
      gitPreferenceDefaults({ localMemoryEnabled: true }),
    );
    mockSearchMemory.mockResolvedValue([]);
    mockGetPlanExploreTarget.mockResolvedValue(null);
    mockGetCodeReviewTarget.mockResolvedValue(null);

    await expect(
      saveLocalMemory({
        projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
        worktreeId: 'plan-without-target',
        provider: 'claude',
        chatId: 'chat-1',
        text: 'Remember this.',
        scope: 'workspace',
      }),
    ).resolves.toContain('configuration could not be read');
    expect(mockAppendInboxNote).not.toHaveBeenCalled();

    await searchLocalMemory({
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'scope-without-target',
      query: 'anything',
    });
    expect(mockSearchMemory).not.toHaveBeenCalled();
    expect(mockGetWorkspaceMemoryDir).not.toHaveBeenCalled();

    await expect(
      readLocalMemory({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'scope-without-target',
        scope: 'workspace',
        file: 'MEMORY.md',
      }),
    ).resolves.toContain('configuration could not be read');
    expect(mockReadMemoryFile).not.toHaveBeenCalled();
  });

  it('redacts staged code-review draft bodies from agent-facing thread history', async () => {
    mockGetCodeReviewTarget.mockResolvedValue({
      projectId: 'p1',
      worktreeId: 'w1',
    });
    mockReadReviewCommentThread.mockResolvedValue({
      ok: true,
      mode: 'single',
      thread: {
        id: 'thread-1',
        status: 'open',
        createdAt: '2026-07-07T00:00:00.000Z',
        anchor: {
          source: 'code',
          quote: 'const secret = true;',
          repoId: 'default',
          filePath: 'src/index.ts',
          side: 'new',
          lineStart: 1,
          lineEnd: 1,
        },
        anchorState: 'matched',
        comments: [
          {
            id: 'comment-1',
            author: 'user',
            body: 'do not send this private draft',
            createdAt: '2026-07-07T00:00:00.000Z',
            staged: true,
          },
          {
            id: 'comment-2',
            author: 'agent',
            body: 'submitted reply remains visible',
            createdAt: '2026-07-07T00:01:00.000Z',
            staged: false,
          },
        ],
      },
    });

    const result = await getReviewCommentThreadInSession({
      worktreeId: 'p1--w1',
      threadId: 'thread-1',
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain('(staged draft): [redacted draft]');
    expect(result.text).toContain('submitted reply remains visible');
    expect(result.text).not.toContain('do not send this private draft');
  });
});

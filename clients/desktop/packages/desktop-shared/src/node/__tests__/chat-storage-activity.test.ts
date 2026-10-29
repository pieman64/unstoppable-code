import {
  CHAT_STORAGE_ACTIVITY_IDENTITY_LIMIT,
  CHAT_STORAGE_ACTIVITY_SCOPE_LIMIT,
  chatStorageCommitTotal,
  registerChatStorageScope,
  resetChatStorageActivityForTests,
  takeChatStorageActivity,
} from '../chat-storage-activity';
import {
  recordChatStorageCommit,
  recordChatStorageDirectorySync,
  recordChatStorageFileSync,
  recordChatStorageFileWrite,
  recordChatStorageMutations,
  resetWorkCounters,
} from '../work-counters';

const SCOPE = '/data/workspaces/w1/chat-storage-v2/wt-1';
const OTHER = '/data/workspaces/w2/chat-storage-v2/entry-9';

describe('chat-storage activity', () => {
  beforeEach(() => {
    resetChatStorageActivityForTests();
    resetWorkCounters();
  });

  it('is silent while idle', () => {
    expect(takeChatStorageActivity()).toBeUndefined();
  });

  it('attributes writes, syncs, commits and mutations to the scope that owns them', () => {
    registerChatStorageScope(SCOPE, { projectId: 'w1', worktreeId: 'wt-1' });
    registerChatStorageScope(OTHER, { projectId: 'w2', worktreeId: 'entry-9' });

    recordChatStorageFileWrite(
      `${SCOPE}/metadata-journal.jsonl.2f0c7a4e-9e57-4a4f-8c1c-3fb1b7a7c001.tmp`,
      120,
      true,
    );
    recordChatStorageFileWrite(`${SCOPE}/transcripts/chat-a.jsonl`, 64, false);
    recordChatStorageFileSync(`${SCOPE}/transcripts/chat-a.jsonl`);
    recordChatStorageDirectorySync(SCOPE);
    recordChatStorageDirectorySync(`${SCOPE}/transcripts`);
    recordChatStorageCommit({
      scopeDirectory: SCOPE,
      durationMs: 42.4,
      queueWaitMs: 3.1,
    });
    recordChatStorageCommit({
      scopeDirectory: SCOPE,
      durationMs: 18,
      queueWaitMs: 9.6,
    });
    recordChatStorageMutations(5, SCOPE);
    recordChatStorageFileWrite(`${OTHER}/live-index.json`, 30, true);
    // The shared manifests directory belongs to no single scope.
    recordChatStorageFileWrite(
      '/data/workspaces/w1/chat-storage-manifests/wt-1.json',
      10,
      true,
    );
    recordChatStorageDirectorySync('/data/workspaces/w1/chat-storage-v2');
    // Other writers share the primitives; they are not chat storage.
    recordChatStorageFileWrite('/data/app-advisor/watchers.json', 99, true);

    const window = takeChatStorageActivity();

    expect(window?.scopes).toEqual([
      {
        identity: { projectId: 'w1', worktreeId: 'wt-1' },
        activity: {
          commits: 2,
          mutations: 5,
          bytesWritten: 184,
          fileSyncs: 1,
          directorySyncs: 2,
          commitMsTotal: 60.4,
          commitMsMax: 42.4,
          queueWaitMsMax: 9.6,
        },
      },
      {
        identity: { projectId: 'w2', worktreeId: 'entry-9' },
        activity: {
          commits: 0,
          mutations: 0,
          bytesWritten: 30,
          fileSyncs: 0,
          directorySyncs: 0,
          commitMsTotal: 0,
          commitMsMax: 0,
          queueWaitMsMax: 0,
        },
      },
    ]);
    expect(window?.total).toEqual({
      commits: 2,
      mutations: 5,
      bytesWritten: 224,
      fileSyncs: 1,
      directorySyncs: 3,
      commitMsTotal: 60.4,
      commitMsMax: 42.4,
      queueWaitMsMax: 9.6,
    });
    expect(takeChatStorageActivity()).toBeUndefined();
  });

  it('attributes Windows paths and reports unregistered scopes without an identity', () => {
    registerChatStorageScope(
      'C:\\Users\\u\\.canopy\\workspaces\\w\\chat-storage-v2\\wt',
      {
        projectId: 'w',
        worktreeId: 'wt',
      },
    );
    recordChatStorageFileWrite(
      'C:\\Users\\u\\.canopy\\workspaces\\w\\chat-storage-v2\\wt\\recovery-index.json',
      7,
      true,
    );
    recordChatStorageFileWrite(
      '/data/workspaces/w9/chat-storage-v2/unknown/live-index.json',
      11,
      true,
    );

    const window = takeChatStorageActivity();

    expect(window?.scopes.map((scope) => scope.identity)).toEqual([
      { projectId: 'w', worktreeId: 'wt' },
      undefined,
    ]);
    expect(window?.total.bytesWritten).toBe(18);
  });

  it('keeps a monotonic commit total that taking a window never resets', () => {
    const before = chatStorageCommitTotal();
    recordChatStorageCommit();
    recordChatStorageCommit({
      scopeDirectory: SCOPE,
      durationMs: 1,
      queueWaitMs: 0,
    });
    takeChatStorageActivity();
    resetWorkCounters();

    expect(chatStorageCommitTotal()).toBe(before + 2);
  });

  it('bounds the scopes held per window and the identities remembered', () => {
    for (
      let index = 0;
      index < CHAT_STORAGE_ACTIVITY_SCOPE_LIMIT + 3;
      index += 1
    ) {
      recordChatStorageFileWrite(
        `/data/workspaces/w/chat-storage-v2/scope-${index}/live-index.json`,
        1,
        true,
      );
    }
    const window = takeChatStorageActivity();
    expect(window?.scopes).toHaveLength(CHAT_STORAGE_ACTIVITY_SCOPE_LIMIT);
    // Activity past the scope limit still counts toward the total.
    expect(window?.total.bytesWritten).toBe(
      CHAT_STORAGE_ACTIVITY_SCOPE_LIMIT + 3,
    );

    for (
      let index = 0;
      index <= CHAT_STORAGE_ACTIVITY_IDENTITY_LIMIT;
      index += 1
    ) {
      registerChatStorageScope(
        `/data/workspaces/w/chat-storage-v2/s-${index}`,
        {
          projectId: 'w',
          worktreeId: `s-${index}`,
        },
      );
    }
    recordChatStorageFileWrite(
      '/data/workspaces/w/chat-storage-v2/s-0/live-index.json',
      1,
      true,
    );
    recordChatStorageFileWrite(
      `/data/workspaces/w/chat-storage-v2/s-${CHAT_STORAGE_ACTIVITY_IDENTITY_LIMIT}/live-index.json`,
      1,
      true,
    );
    // The oldest registration was evicted to admit the newest.
    expect(
      takeChatStorageActivity()?.scopes.map((scope) => scope.identity),
    ).toEqual([
      undefined,
      {
        projectId: 'w',
        worktreeId: `s-${CHAT_STORAGE_ACTIVITY_IDENTITY_LIMIT}`,
      },
    ]);
  });
});

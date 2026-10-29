import {
  type SidebarItem,
  COWORK_HOME_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { registerCoworkWorkspaceIds } from '../cowork-registry';
import {
  selectionBelongsToContext,
  getCoworkActivityStatus,
  shouldAcknowledgeCoworkTarget,
  shouldReassertRetainedCoworkEntryOnPageMount,
  shouldRestorePreviousWorktreeAfterCoworkPageUnmount,
} from '../standaloneChatSelection';

describe('shouldAcknowledgeCoworkTarget', () => {
  const visibleTarget = {
    projectId: 'cowork-default',
    workEntryId: 'entry-1',
    tabId: 'tab-1',
    activeTabHidden: false,
    archiveOverlayChatId: null,
  };

  it('acknowledges a complete visible live-chat target', () => {
    expect(shouldAcknowledgeCoworkTarget(visibleTarget)).toBe(true);
  });

  it('does not acknowledge the live-chat target beneath an archive overlay', () => {
    expect(
      shouldAcknowledgeCoworkTarget({
        ...visibleTarget,
        archiveOverlayChatId: 'archived-chat',
      }),
    ).toBe(false);
  });

  it('does not acknowledge a collapsed live-chat target', () => {
    expect(
      shouldAcknowledgeCoworkTarget({
        ...visibleTarget,
        activeTabHidden: true,
      }),
    ).toBe(false);
  });
});

describe('shouldRestorePreviousWorktreeAfterCoworkPageUnmount', () => {
  afterEach(() => {
    registerCoworkWorkspaceIds([]);
  });

  it('restores when no worktree is selected', () => {
    expect(shouldRestorePreviousWorktreeAfterCoworkPageUnmount(null)).toBe(
      true,
    );
  });

  it('restores for the legacy standalone-chat sentinel', () => {
    expect(
      shouldRestorePreviousWorktreeAfterCoworkPageUnmount({
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'research',
      }),
    ).toBe(true);
  });

  it('restores for real cowork project selections', () => {
    registerCoworkWorkspaceIds(['cowork-research']);

    expect(
      shouldRestorePreviousWorktreeAfterCoworkPageUnmount({
        projectId: 'cowork-research',
        worktreeId: COWORK_HOME_WORKTREE_ID,
      }),
    ).toBe(true);
  });

  it('does not restore after navigating to a code project selection', () => {
    expect(
      shouldRestorePreviousWorktreeAfterCoworkPageUnmount({
        projectId: 'workspace-a',
        worktreeId: 'feature-a',
      }),
    ).toBe(false);
  });
});

describe('shouldReassertRetainedCoworkEntryOnPageMount', () => {
  afterEach(() => {
    registerCoworkWorkspaceIds([]);
  });

  it('re-asserts when nothing is globally selected', () => {
    expect(shouldReassertRetainedCoworkEntryOnPageMount(null)).toBe(true);
  });

  it('re-asserts over a code worktree left selected by the previous page', () => {
    expect(
      shouldReassertRetainedCoworkEntryOnPageMount({
        projectId: 'workspace-a',
        worktreeId: 'feature-a',
      }),
    ).toBe(true);
  });

  it('leaves an already-matching cowork selection alone', () => {
    registerCoworkWorkspaceIds(['cowork-research']);

    expect(
      shouldReassertRetainedCoworkEntryOnPageMount({
        projectId: 'cowork-research',
        worktreeId: 'entry-alpha',
      }),
    ).toBe(false);
  });

  it('leaves an in-flight sibling Work Entry destination alone', () => {
    // REG-2842: the sidebar sets the destination synchronously and commits
    // `activeWorkEntryId` only after tab hydration, so a different cowork
    // entry here is the click target — not a stale selection to overwrite.
    registerCoworkWorkspaceIds(['cowork-research']);

    expect(
      shouldReassertRetainedCoworkEntryOnPageMount({
        projectId: 'cowork-research',
        worktreeId: 'entry-beta',
      }),
    ).toBe(false);
  });

  it('leaves the legacy standalone-chat sentinel alone', () => {
    expect(
      shouldReassertRetainedCoworkEntryOnPageMount({
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: COWORK_HOME_WORKTREE_ID,
      }),
    ).toBe(false);
  });
});

describe('getCoworkActivityStatus', () => {
  const workEntry = {
    id: 'entry-1',
    title: 'Entry 1',
    createdAt: '2026-07-17T00:00:00.000Z',
    chatCount: 1,
  };

  it('waits for both legacy and per-entry archive activity to load', () => {
    expect(
      getCoworkActivityStatus({
        projectId: 'cowork-default',
        workEntries: [workEntry],
        legacyArchivedChats: undefined,
        archivedChats: {},
      }),
    ).toEqual({ archiveActivityLoaded: false, hasChatActivity: false });
  });

  it('does not hydrate hundreds of archives when live entries already prove activity', () => {
    const activeEntries = Array.from({ length: 500 }, (_, index) => ({
      ...workEntry,
      id: `entry-${index}`,
      lastMessageAt: '2026-07-17T00:01:00.000Z',
    }));

    expect(
      getCoworkActivityStatus({
        projectId: 'cowork-default',
        workEntries: activeEntries,
        legacyArchivedChats: undefined,
        archivedChats: {},
      }),
    ).toEqual({ archiveActivityLoaded: true, hasChatActivity: true });
  });

  it('detects activity retained only in a Work Entry archive', () => {
    expect(
      getCoworkActivityStatus({
        projectId: 'cowork-default',
        workEntries: [workEntry],
        legacyArchivedChats: [],
        archivedChats: {
          'cowork-default/entry-1': [
            {
              chatId: 'archived-chat',
              title: 'Archived chat',
              turnCount: 1,
              archivedAt: '2026-07-17T00:00:00.000Z',
              createdAt: '2026-07-17T00:00:00.000Z',
              restorable: true,
              unread: false,
            },
          ],
        },
      }),
    ).toEqual({ archiveActivityLoaded: true, hasChatActivity: true });
  });

  it('detects activity retained only in the legacy archive list', () => {
    expect(
      getCoworkActivityStatus({
        projectId: 'cowork-default',
        workEntries: [workEntry],
        legacyArchivedChats: [
          {
            id: 'legacy-chat',
            description: 'Legacy chat',
            createdAt: '2026-07-17T00:00:00.000Z',
            archived: true,
          },
        ],
        archivedChats: { 'cowork-default/entry-1': [] },
      }),
    ).toEqual({ archiveActivityLoaded: true, hasChatActivity: true });
  });
});

describe('selectionBelongsToContext', (): void => {
  const previous = { projectId: 'project-1', worktreeId: 'worktree-1' };
  const project: SidebarItem = {
    type: 'single-repo',
    id: 'project-1',
    name: 'Project',
    repoPath: '/workspace',
    color: '#000000',
    collapsed: false,
    order: 0,
    worktrees: [],
  };

  it('allows an unowned project in Personal', (): void => {
    expect(
      selectionBelongsToContext(previous, [project], {
        kind: 'personal',
      }),
    ).toBe(true);
  });

  it('allows a project owned by the current organization', (): void => {
    expect(
      selectionBelongsToContext(
        previous,
        [
          {
            ...project,
            owner: {
              type: 'organization',
              organizationId: 'org-1',
              projectId: 'remote-1',
              instanceId: 'instance-1',
              bindingGeneration: 1,
            },
          },
        ],
        { kind: 'organization', organizationId: 'org-1' },
      ),
    ).toBe(true);
  });

  it('rejects an unowned project in an organization', (): void => {
    expect(
      selectionBelongsToContext(previous, [project], {
        kind: 'organization',
        organizationId: 'org-1',
      }),
    ).toBe(false);
  });

  it('allows a known project without context scoping', (): void => {
    expect(selectionBelongsToContext(previous, [project], undefined)).toBe(
      true,
    );
  });

  it('rejects a missing project even without context scoping', (): void => {
    expect(selectionBelongsToContext(previous, [], undefined)).toBe(false);
    expect(selectionBelongsToContext(previous, [], { kind: 'personal' })).toBe(
      false,
    );
  });
});

import type {
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  ensureChatTabsRequiredDurability,
  notifyChatTabsMaterialized,
  type ChatTabsWriteDelta,
} from '../../lib/chat-tabs';
import {
  installCoreChatProjections,
  type ChildSearchDirtyEvent,
  type CoreChatProjections,
} from '../core-chat-projections';

jest.mock('../../shared-containers/publish/scheduler', () => ({
  getSharedContainerPublishScheduler: (): { scheduleKnown: jest.Mock } => ({
    scheduleKnown: jest.fn(),
  }),
}));

function tab(id: string): PersistedChatTab {
  return { id, title: id, messages: [], createdAt: '2026-11-05T00:00:00.000Z' };
}

function chatTabs(...ids: string[]): ChatTabsFile {
  return { version: 1, tabs: ids.map(tab), activeTabId: ids[0] ?? '' };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

describe('core chat projections (CAN-4114)', () => {
  let calls: string[];
  let projections: CoreChatProjections | undefined;
  let childListener: ((event: ChildSearchDirtyEvent) => void) | undefined;
  const unsubscribe = jest.fn();
  const search = {
    projectLiveTabs: jest.fn((): Promise<void> => {
      calls.push('search');
      return Promise.resolve();
    }),
    indexWorktreeArchives: jest.fn(),
    childSearchDirty: jest.fn(),
  };
  let touchTargetAfterCommit: jest.Mock<
    Promise<void>,
    [projectId: string, worktreeId: string]
  >;

  function install(): CoreChatProjections {
    projections = installCoreChatProjections({
      search: () => search,
      subscribeChildSearchDirty: (listener) => {
        childListener = listener;
        return unsubscribe;
      },
      touchTargetAfterCommit: (projectId, worktreeId) =>
        touchTargetAfterCommit(projectId, worktreeId),
      steps: {
        syncBadges: () => {
          calls.push('badges');
        },
        syncWorkEntrySummary: () => {
          calls.push('summary');
          return Promise.resolve();
        },
        publishRuntimeStatus: () => {
          calls.push('runtimeStatus');
        },
        publishScope: () => {
          calls.push('scope');
        },
        nudgeSummary: () => {
          calls.push('nudge');
        },
        logRetry: jest.fn(),
      },
    });
    return projections;
  }

  async function commit(
    data: ChatTabsFile,
    delta: ChatTabsWriteDelta | undefined,
  ): Promise<void> {
    await notifyChatTabsMaterialized('p1', 'w1', data, delta, 1, () => true);
    await settle();
  }

  beforeEach(() => {
    calls = [];
    childListener = undefined;
    jest.clearAllMocks();
    touchTargetAfterCommit = jest.fn<Promise<void>, [string, string]>(() =>
      Promise.resolve(),
    );
  });

  afterEach(() => {
    projections?.uninstall();
    projections = undefined;
  });

  it('runs the projection steps in commit order', async () => {
    install();
    await commit(chatTabs('a'), undefined);
    expect(calls).toEqual([
      'search',
      'badges',
      'summary',
      'runtimeStatus',
      'scope',
    ]);
  });

  it('reindexes archives when a commit removes a chat', async () => {
    install();
    await commit(chatTabs('a', 'b'), undefined);
    jest.clearAllMocks();
    await commit(chatTabs('a'), { changedTabIds: [], removedTabIds: ['b'] });
    expect(search.indexWorktreeArchives).toHaveBeenCalledTimes(1);
    expect(search.indexWorktreeArchives).toHaveBeenCalledWith('p1', 'w1');
    expect(
      search.indexWorktreeArchives.mock.invocationCallOrder[0],
    ).toBeLessThan(search.projectLiveTabs.mock.invocationCallOrder[0] ?? 0);
  });

  it('reindexes archives when a commit adds a chat the scope did not have', async () => {
    install();
    await commit(chatTabs('a'), undefined);
    jest.clearAllMocks();
    await commit(chatTabs('a', 'c'), {
      changedTabIds: ['c'],
      removedTabIds: [],
    });
    expect(search.indexWorktreeArchives).toHaveBeenCalledTimes(1);
    expect(search.indexWorktreeArchives).toHaveBeenCalledWith('p1', 'w1');
  });

  it('leaves archives alone when a known chat changes', async () => {
    install();
    await commit(chatTabs('a'), undefined);
    jest.clearAllMocks();
    await commit(chatTabs('a'), { changedTabIds: ['a'], removedTabIds: [] });
    expect(search.indexWorktreeArchives).not.toHaveBeenCalled();
    expect(search.projectLiveTabs).toHaveBeenCalledTimes(1);
  });

  it('routes child search notifications to the index', () => {
    const installed = install();
    const event = {
      scope: { projectId: 'p1', worktreeId: 'w1' },
    } as unknown as ChildSearchDirtyEvent;
    childListener?.(event);
    expect(search.childSearchDirty).toHaveBeenCalledWith(event);
    installed.uninstall();
    projections = undefined;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('awaits the activity watermark before acknowledging', async () => {
    install();
    let release: () => void = () => undefined;
    touchTargetAfterCommit = jest.fn<Promise<void>, [string, string]>(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let acknowledged = false;
    const durability = ensureChatTabsRequiredDurability(
      'p1',
      'w1',
      chatTabs('a'),
      undefined,
      3,
    ).then(() => {
      acknowledged = true;
    });
    await settle();
    expect(touchTargetAfterCommit).toHaveBeenCalledWith('p1', 'w1');
    expect(acknowledged).toBe(false);
    release();
    await durability;
    expect(acknowledged).toBe(true);
  });
});

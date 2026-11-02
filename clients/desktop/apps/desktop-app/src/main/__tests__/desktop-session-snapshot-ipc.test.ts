import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
jest.mock('../services/sidebar-item-groups-service', () => ({
  projectSidebarItemGroups: jest.fn(() => Promise.resolve(undefined)),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../services/workspace-portal-service', () => ({
  listWorkspacePortalEntities: jest.fn(),
}));

jest.mock('../services/chat-service', () => ({
  listWorktreeChatSummaries: jest.fn(),
}));

jest.mock('../services/standalone-chat-service', () => ({
  listStandaloneChats: jest.fn(),
  projectStandaloneChatSnapshot: jest.fn(),
}));

jest.mock('../services/desktop-session-snapshot-invalidation', () => ({
  scheduleDesktopSessionSnapshotInvalidation: jest.fn(),
  subscribeDesktopSessionSnapshotInvalidation: jest.fn(),
}));

jest.mock('../agents/session-manager', () => ({
  subscribeChatSessionActivity: jest.fn(),
}));

import { projectSidebarItemGroups } from '../services/sidebar-item-groups-service';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { PortalSessionShellState } from '@canopy/protocol/portal';
import { subscribeChatSessionActivity } from '../agents/session-manager';
import { registerIpcHandler } from '../ipc/register';
import {
  disposeDesktopSessionSnapshotHandlers,
  registerDesktopSessionSnapshotHandlers,
} from '../ipc/desktop-session-snapshot';
import {
  scheduleDesktopSessionSnapshotInvalidation,
  subscribeDesktopSessionSnapshotInvalidation,
} from '../services/desktop-session-snapshot-invalidation';
import { listWorkspacePortalEntities } from '../services/workspace-portal-service';
import { listStandaloneChats } from '../services/standalone-chat-service';
import { listWorktreeChatSummaries } from '../services/chat-service';
import { buildDesktopSessionSnapshot } from '../services/desktop-session-snapshot-service';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedListWorkspacePortalEntities = jest.mocked(
  listWorkspacePortalEntities,
);
const mockedListStandaloneChats = jest.mocked(listStandaloneChats);
const mockedSubscribeInvalidation = jest.mocked(
  subscribeDesktopSessionSnapshotInvalidation,
);
const mockedScheduleInvalidation = jest.mocked(
  scheduleDesktopSessionSnapshotInvalidation,
);
const mockedSubscribeChatSessionActivity = jest.mocked(
  subscribeChatSessionActivity,
);

function invokeEventFixture(): IpcMainInvokeEvent {
  // These handlers do not inspect sender or frame state.
  return {} as IpcMainInvokeEvent;
}

function createSnapshotWindow(
  send: BrowserWindow['webContents']['send'],
): BrowserWindow {
  // The handler only checks the window lifecycle and sends through webContents.
  const window: Pick<BrowserWindow, 'isDestroyed'> & {
    webContents: Pick<BrowserWindow['webContents'], 'send'>;
  } = {
    isDestroyed: (): boolean => false,
    webContents: { send },
  };
  return window as BrowserWindow;
}

describe('desktop session snapshot IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    disposeDesktopSessionSnapshotHandlers();
    mockedSubscribeInvalidation.mockReturnValue(jest.fn());
    mockedSubscribeChatSessionActivity.mockReturnValue(jest.fn());
    mockedListStandaloneChats.mockResolvedValue([]);
    mockedListWorkspacePortalEntities.mockImplementation((_target, options) => {
      options?.onWorkspace?.({
        localId: 'workspace-1',
        name: 'Workspace',
        type: 'single-repo',
      });
      options?.onWorktree?.({
        localId: 'worktree-1',
        workspaceLocalId: 'workspace-1',
        branch: 'feature/snapshot',
        isStreaming: true,
      });
      return Promise.resolve([]);
    });
  });

  it('lists complete chat inventory only when opted in and strips the flag from the target', async () => {
    const summary = {
      localId: 'chat-1',
      chatId: 'chat-1',
      title: 'Chat',
      scope: 'worktree' as const,
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      lastMessageRole: 'assistant' as const,
    };
    jest.mocked(listWorktreeChatSummaries).mockResolvedValue([summary]);
    await buildDesktopSessionSnapshot();
    await buildDesktopSessionSnapshot({ includeChatSummaries: false });
    expect(listWorktreeChatSummaries).not.toHaveBeenCalled();
    const result = await buildDesktopSessionSnapshot({
      includeChatSummaries: true,
      workspaceLocalId: 'workspace-1',
    });
    expect(result.chatSummaries).toEqual([summary]);
    expect(mockedListWorkspacePortalEntities.mock.calls.at(-1)?.[0]).toEqual({
      workspaceLocalId: 'workspace-1',
    });
    jest
      .mocked(listWorktreeChatSummaries)
      .mockRejectedValueOnce(new Error('inventory unavailable'));
    await expect(
      buildDesktopSessionSnapshot({ includeChatSummaries: true }),
    ).rejects.toThrow('inventory unavailable');
  });

  it('excludes hidden or orphaned worktrees before reading inventory', async () => {
    mockedListWorkspacePortalEntities.mockImplementation((_target, options) => {
      options?.onWorkspace?.({
        localId: 'visible',
        name: 'Visible',
        type: 'single-repo',
      });
      options?.onWorkspace?.({
        localId: 'hidden',
        name: 'Hidden',
        type: 'single-repo',
        hidden: true,
      });
      const worktrees: readonly (readonly [string, string, boolean])[] = [
        ['visible', 'ok', false],
        ['visible', 'hidden-tree', true],
        ['hidden', 'tree', false],
        ['missing', 'orphan', false],
      ];
      for (const [workspaceLocalId, localId, hidden] of worktrees)
        options?.onWorktree?.({
          localId,
          workspaceLocalId,
          branch: 'main',
          hidden,
        });
      return Promise.resolve([]);
    });
    jest.mocked(listWorktreeChatSummaries).mockResolvedValue([]);
    await buildDesktopSessionSnapshot({ includeChatSummaries: true });
    expect(listWorktreeChatSummaries).toHaveBeenCalledTimes(1);
    expect(listWorktreeChatSummaries).toHaveBeenCalledWith({
      workspaceId: 'visible',
      worktreeId: 'ok',
    });
  });

  it('registers an on-demand scoped snapshot handler backed by the main projection', async () => {
    registerDesktopSessionSnapshotHandlers(() => null);
    const registration = mockedRegisterIpcHandler.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.desktopSessionSnapshot,
    );
    const handler = registration?.[1];

    const result = await handler?.(invokeEventFixture(), {
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
    });
    const expected: Partial<PortalSessionShellState> = {
      workspaces: [
        {
          localId: 'workspace-1',
          name: 'Workspace',
          type: 'single-repo',
        },
      ],
      worktrees: [
        {
          localId: 'worktree-1',
          workspaceLocalId: 'workspace-1',
          branch: 'feature/snapshot',
          isStreaming: true,
        },
      ],
      standaloneChats: [],
      connectionStatus: 'active',
    };
    expect(result).toMatchObject(expected);
    expect(mockedListWorkspacePortalEntities.mock.calls[0]?.[0]).toEqual({
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
    });
  });

  it('builds an unscoped snapshot when invoked without args', async () => {
    registerDesktopSessionSnapshotHandlers(() => null);
    const registration = mockedRegisterIpcHandler.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.desktopSessionSnapshot,
    );

    await expect(
      registration?.[1](invokeEventFixture(), undefined),
    ).resolves.toBeDefined();
    expect(
      mockedListWorkspacePortalEntities.mock.calls[0]?.[0],
    ).toBeUndefined();
  });

  it('registers an explicit snapshot invalidation handler', () => {
    registerDesktopSessionSnapshotHandlers(() => null);
    const registration = mockedRegisterIpcHandler.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.desktopSessionSnapshotInvalidate,
    );

    registration?.[1](invokeEventFixture());

    expect(mockedScheduleInvalidation).toHaveBeenCalledTimes(1);
  });

  it('broadcasts stale notifications only while the window is alive', () => {
    const send = jest.fn<
      ReturnType<BrowserWindow['webContents']['send']>,
      Parameters<BrowserWindow['webContents']['send']>
    >();
    const getWindow = jest.fn<BrowserWindow | null, []>(() =>
      createSnapshotWindow(send),
    );
    registerDesktopSessionSnapshotHandlers(getWindow);
    const listener = mockedSubscribeInvalidation.mock.calls[0]?.[0];

    listener?.();
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.desktopSessionSnapshotStale);
  });

  it('replaces and disposes the invalidation subscription', () => {
    const firstUnsubscribe = jest.fn();
    const secondUnsubscribe = jest.fn();
    mockedSubscribeInvalidation
      .mockReturnValueOnce(firstUnsubscribe)
      .mockReturnValueOnce(secondUnsubscribe);

    registerDesktopSessionSnapshotHandlers(() => null);
    registerDesktopSessionSnapshotHandlers(() => null);
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);

    disposeDesktopSessionSnapshotHandlers();
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1);
  });

  // The snapshot projects each worktree's `isStreaming` from live chat
  // sessions, and the shared sidebar gates Archive and Delete on it. Without a
  // portal session nothing else stales the snapshot on turn changes, so a
  // snapshot rebuilt mid-turn kept those actions disabled after the turn ended.
  it('stales the snapshot on chat session activity without a portal session', () => {
    registerDesktopSessionSnapshotHandlers(() => null);
    expect(mockedSubscribeChatSessionActivity).toHaveBeenCalledTimes(1);
    const onActivity = mockedSubscribeChatSessionActivity.mock.calls[0]?.[0];
    expect(mockedScheduleInvalidation).not.toHaveBeenCalled();

    onActivity?.();

    expect(mockedScheduleInvalidation).toHaveBeenCalledTimes(1);
  });

  it('replaces and disposes the chat session activity subscription', () => {
    const firstUnsubscribe = jest.fn();
    const secondUnsubscribe = jest.fn();
    mockedSubscribeChatSessionActivity
      .mockReturnValueOnce(firstUnsubscribe)
      .mockReturnValueOnce(secondUnsubscribe);

    registerDesktopSessionSnapshotHandlers(() => null);
    registerDesktopSessionSnapshotHandlers(() => null);
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);

    disposeDesktopSessionSnapshotHandlers();
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1);
  });
  it('projects optional Advisor membership through the scoped snapshot without enabling presentation', async () => {
    const groups: SidebarItemGroup[] = [
      {
        id: 'grp-advisor',
        name: 'Advisor',
        color: 'neutral',
        collapsed: false,
        memberIds: ['entry-a'],
      },
    ];
    jest.mocked(projectSidebarItemGroups).mockResolvedValueOnce(groups);
    registerDesktopSessionSnapshotHandlers(() => null);
    const handler = mockedRegisterIpcHandler.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.desktopSessionSnapshot,
    )?.[1];
    const result = await handler?.(invokeEventFixture(), {
      workspaceLocalId: 'workspace-1',
    });
    expect(projectSidebarItemGroups).toHaveBeenCalledWith({ appAdvisor: true });
    expect(result).toMatchObject({ appAdvisorItemGroups: groups });
  });
});

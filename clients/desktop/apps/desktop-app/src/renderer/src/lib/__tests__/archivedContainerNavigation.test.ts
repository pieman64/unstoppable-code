/**
 * @jest-environment jsdom
 */
import type { ArchivedContainerRestoreResponse } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import {
  openArchivedContainerSurface,
  navigateToRestoredContainerDestination,
} from '@/lib/archivedContainerNavigation';

const CODE_WORKSPACE_ID = 'code-workspace-1';
const COWORK_WORKSPACE_ID = 'cowork-workspace-1';

// Store action mocks, re-created per test and injected via `setState` so the
// helper under test (which reads them through `getState()`) picks them up.
let navigateMock: jest.Mock;
let openAppAdvisorMock: jest.Mock;
let closeArchiveOverlayMock: jest.Mock;
let openWorkEntryFromSidebarMock: jest.Mock;
let refreshWorkEntriesMock: jest.Mock;
let selectWorktreeMock: jest.Mock;
let openViewerMock: jest.Mock;
let closeSharedContainerViewerMock: jest.Mock;
let loadProjectsMock: jest.Mock;

// Preserve the real actions so this file leaves the singleton stores intact
// for any same-file describe blocks added later.
const originalNavigation = {
  navigate: useNavigationStore.getState().navigate,
  openAppAdvisor: useNavigationStore.getState().openAppAdvisor,
};
const originalStandalone = {
  closeArchiveOverlay: useStandaloneChatStore.getState().closeArchiveOverlay,
  openWorkEntryFromSidebar:
    useStandaloneChatStore.getState().openWorkEntryFromSidebar,
  refreshWorkEntries: useStandaloneChatStore.getState().refreshWorkEntries,
};
const originalSelectWorktree = useChatStore.getState().selectWorktree;
const originalSelectedWorktree = useChatStore.getState().selectedWorktree;
const originalOpenViewer = useArchivedContainersStore.getState().openViewer;
const originalCloseSharedContainerViewer =
  useSharedContainerReplicasStore.getState().closeViewer;
const originalLoadProjects = useProjectsStore.getState().loadProjects;

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      appAdvisor: { openWindow: jest.fn() },
      archivedContainers: { list: jest.fn().mockResolvedValue([]) },
    },
  });
  navigateMock = jest.fn();
  openAppAdvisorMock = jest.fn();
  closeArchiveOverlayMock = jest.fn();
  openWorkEntryFromSidebarMock = jest.fn().mockResolvedValue(undefined);
  refreshWorkEntriesMock = jest.fn().mockResolvedValue(undefined);
  // Mirrors the real action's guard-passing outcome so the helper's
  // selection-landed verification sees the selection it just made.
  selectWorktreeMock = jest.fn(
    (projectId: string, worktreeId: string): void => {
      useChatStore.setState({ selectedWorktree: { projectId, worktreeId } });
    },
  );
  openViewerMock = jest.fn();
  closeSharedContainerViewerMock = jest.fn();
  loadProjectsMock = jest.fn().mockResolvedValue(undefined);
  useNavigationStore.setState({
    navigate: navigateMock,
    openAppAdvisor: openAppAdvisorMock,
  });
  useStandaloneChatStore.setState({
    activeChatProjectId: COWORK_WORKSPACE_ID,
    closeArchiveOverlay: closeArchiveOverlayMock,
    openWorkEntryFromSidebar: openWorkEntryFromSidebarMock,
    refreshWorkEntries: refreshWorkEntriesMock,
  });
  useChatStore.setState({
    selectWorktree: selectWorktreeMock,
    selectedWorktree: null,
  });
  useProjectsStore.setState({ loadProjects: loadProjectsMock });
  useArchivedContainersStore.setState({
    byWorkspace: {},
    loadedWorkspaces: {},
    viewer: null,
    openViewer: openViewerMock,
  });
  useSharedContainerReplicasStore.setState({
    closeViewer: closeSharedContainerViewerMock,
  });
  // Make COWORK_WORKSPACE_ID look like a real cowork workspace to
  // `isCoworkChatTarget` (the registry is what projectsStore syncs into).
  registerCoworkWorkspaceIds([COWORK_WORKSPACE_ID]);
});

afterAll(() => {
  useNavigationStore.setState(originalNavigation);
  useStandaloneChatStore.setState(originalStandalone);
  useChatStore.setState({
    selectWorktree: originalSelectWorktree,
    selectedWorktree: originalSelectedWorktree,
  });
  useArchivedContainersStore.setState({ openViewer: originalOpenViewer });
  useSharedContainerReplicasStore.setState({
    closeViewer: originalCloseSharedContainerViewer,
  });
  useProjectsStore.setState({ loadProjects: originalLoadProjects });
  registerCoworkWorkspaceIds([]);
});

describe('openArchivedContainerSurface', () => {
  it('routes code projects to the main page before opening the viewer', () => {
    openArchivedContainerSurface(CODE_WORKSPACE_ID, 'container-1');

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('main');
    expect(openViewerMock).toHaveBeenCalledTimes(1);
    expect(openViewerMock).toHaveBeenCalledWith(
      CODE_WORKSPACE_ID,
      'container-1',
      undefined,
    );
    expect(openAppAdvisorMock).not.toHaveBeenCalled();
    // navigate('main') happens before openViewer on the code path.
    expect(navigateMock.mock.invocationCallOrder[0]).toBeLessThan(
      openViewerMock.mock.invocationCallOrder[0],
    );
  });

  it('routes cowork projects to the chat page and forwards tab/chat options', () => {
    openArchivedContainerSurface(COWORK_WORKSPACE_ID, 'container-2', {
      tab: 'chats',
      chatId: 'chat-9',
    });

    expect(openViewerMock).toHaveBeenCalledTimes(1);
    expect(openViewerMock).toHaveBeenCalledWith(
      COWORK_WORKSPACE_ID,
      'container-2',
      { tab: 'chats', chatId: 'chat-9' },
    );
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith('chat');
    expect(openAppAdvisorMock).not.toHaveBeenCalled();
  });

  it('routes the App Advisor project through the window-open request, never the local store', () => {
    openArchivedContainerSurface(APP_ADVISOR_PROJECT_ID, 'container-3', {
      chatId: 'chat-3',
    });

    // The viewer's state lives in the popout renderer's store instance —
    // opening it locally would be invisible there, so the open is forwarded
    // through the App Advisor window-open request instead.
    expect(openAppAdvisorMock).toHaveBeenCalledTimes(1);
    expect(openAppAdvisorMock).toHaveBeenCalledWith({
      archivedContainer: { containerId: 'container-3', chatId: 'chat-3' },
    });
    expect(openViewerMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('closes the legacy single-chat archive overlay before opening the viewer', () => {
    openArchivedContainerSurface(CODE_WORKSPACE_ID, 'container-1');
    openArchivedContainerSurface(COWORK_WORKSPACE_ID, 'container-2');

    expect(closeArchiveOverlayMock).toHaveBeenCalledTimes(2);
    // The legacy overlay close always precedes the viewer open.
    closeArchiveOverlayMock.mock.invocationCallOrder.forEach((order, index) => {
      expect(order).toBeLessThan(
        openViewerMock.mock.invocationCallOrder[index],
      );
    });
  });

  it('closes the recipient viewer before opening an archived container', () => {
    openArchivedContainerSurface(CODE_WORKSPACE_ID, 'container-1');

    expect(closeSharedContainerViewerMock).toHaveBeenCalledTimes(1);
    expect(
      closeSharedContainerViewerMock.mock.invocationCallOrder[0],
    ).toBeLessThan(openViewerMock.mock.invocationCallOrder[0]);
  });
});

describe('navigateToRestoredContainerDestination', () => {
  it('selects the restored worktree and navigates to main for worktree restores', async () => {
    const result: ArchivedContainerRestoreResponse = {
      kind: 'worktree',
      restoredWorktreeId: 'worktree-7',
      warnings: [],
    };

    await navigateToRestoredContainerDestination(CODE_WORKSPACE_ID, result);

    expect(selectWorktreeMock).toHaveBeenCalledTimes(1);
    expect(selectWorktreeMock).toHaveBeenCalledWith(
      CODE_WORKSPACE_ID,
      'worktree-7',
    );
    expect(navigateMock).toHaveBeenCalledWith('main');
    expect(openWorkEntryFromSidebarMock).not.toHaveBeenCalled();
    // The selection already landed, so no projects refresh is needed.
    expect(loadProjectsMock).not.toHaveBeenCalled();
  });

  it('retries the worktree selection after a projects refresh when the guard rejects it', async () => {
    // Simulate selectWorktree's stale-projects navigation guard: the
    // selection only lands once the projects snapshot has been refreshed.
    selectWorktreeMock.mockImplementation(
      (projectId: string, worktreeId: string): void => {
        if (loadProjectsMock.mock.calls.length === 0) {
          return;
        }
        useChatStore.setState({ selectedWorktree: { projectId, worktreeId } });
      },
    );
    const result: ArchivedContainerRestoreResponse = {
      kind: 'worktree',
      restoredWorktreeId: 'worktree-7',
      warnings: [],
    };

    await navigateToRestoredContainerDestination(CODE_WORKSPACE_ID, result);

    expect(loadProjectsMock).toHaveBeenCalledWith({ silent: true });
    expect(selectWorktreeMock).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().selectedWorktree).toEqual({
      projectId: CODE_WORKSPACE_ID,
      worktreeId: 'worktree-7',
    });
    expect(navigateMock).toHaveBeenCalledWith('main');
  });

  it('opens the restored work entry and navigates to chat for cowork restores', async () => {
    const result: ArchivedContainerRestoreResponse = {
      kind: 'work-entry',
      restoredEntryId: 'entry-4',
      warnings: [],
    };

    await navigateToRestoredContainerDestination(COWORK_WORKSPACE_ID, result);

    expect(openWorkEntryFromSidebarMock).toHaveBeenCalledTimes(1);
    expect(openWorkEntryFromSidebarMock).toHaveBeenCalledWith(
      COWORK_WORKSPACE_ID,
      'entry-4',
    );
    expect(refreshWorkEntriesMock).toHaveBeenCalledWith(COWORK_WORKSPACE_ID);
    expect(refreshWorkEntriesMock.mock.invocationCallOrder[0]).toBeLessThan(
      openWorkEntryFromSidebarMock.mock.invocationCallOrder[0],
    );
    expect(navigateMock).toHaveBeenCalledWith('chat');
    expect(selectWorktreeMock).not.toHaveBeenCalled();
  });

  it('reveals App Advisor restores through the window-open request', async () => {
    const result: ArchivedContainerRestoreResponse = {
      kind: 'work-entry',
      restoredEntryId: 'entry-5',
      warnings: [],
    };

    await navigateToRestoredContainerDestination(
      APP_ADVISOR_PROJECT_ID,
      result,
    );

    // Selection must land in the popout renderer's store — routed via the
    // window command queue, not the local standalone store.
    expect(openAppAdvisorMock).toHaveBeenCalledWith({
      workEntryId: 'entry-5',
    });
    expect(openWorkEntryFromSidebarMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('does nothing for a worktree restore that produced no destination ids', async () => {
    const result: ArchivedContainerRestoreResponse = {
      kind: 'worktree',
      warnings: [],
    };

    await navigateToRestoredContainerDestination(CODE_WORKSPACE_ID, result);

    expect(selectWorktreeMock).not.toHaveBeenCalled();
    expect(openWorkEntryFromSidebarMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});

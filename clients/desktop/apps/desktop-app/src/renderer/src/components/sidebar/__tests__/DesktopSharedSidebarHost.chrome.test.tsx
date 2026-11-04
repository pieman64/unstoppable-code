/** @jest-environment jsdom */
import type { SessionViewModel } from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { createFakeClient } from '@canopy/app-state/__tests__/fake-org-projects-client';
import {
  chooseSettingsOptionSync,
  settingsSelectTrigger,
  settingsSelectValue,
} from '@canopy/ui-app/settings/__tests__/helpers/settings-select';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarSurface, SidebarSurfaceProps } from '@canopy/ui-app';

import { noteChatIntent, endChatIntent } from '@/stores/chat/chat-prefetch';

jest.mock('@/stores/chat/chat-prefetch', () => ({
  noteChatIntent: jest.fn(),
  endChatIntent: jest.fn(),
}));

/**
 * The host nests the shared surface INSIDE `AppSidebar`, which already renders
 * the rail's own New Task entry point and More menu. Under the surface's
 * default `'full'` chrome it therefore contributes a second set — and since the
 * host supplies no `onCreateTask`, that second New Task button renders
 * permanently disabled. `'navigation-only'` is the contract for exactly this
 * case; `SidebarSurface`'s own tests cover what it suppresses, so this pins the
 * one thing that is desktop's to get wrong: actually passing it.
 */
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const capturedProps: SidebarSurfaceProps[] = [];
const capturedSharedContainerSectionProps: Array<{
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}> = [];

function makeSessionSnapshot(
  overrides: Partial<SessionViewModel> = {},
): SessionViewModel {
  return {
    workspaces: [],
    worktrees: [],
    standaloneChats: [],
    chatProjects: [],
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries: [],
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {},
    diffSnapshots: {},
    prStatuses: {},
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
    ...overrides,
  };
}

jest.mock('@canopy/ui-app', () => {
  const actual = jest.requireActual<{ SidebarSurface: typeof SidebarSurface }>(
    '@canopy/ui-app',
  );
  return {
    ...actual,
    __esModule: true,
    SidebarSurface: (props: SidebarSurfaceProps): JSX.Element | null => {
      capturedProps.push(props);
      return <actual.SidebarSurface {...props} />;
    },
  };
});

jest.mock('@/client/ipc-canopy-client', () => ({
  __esModule: true,
  ipcCanopyClient: {
    capabilities: {},
    // The initial snapshot is normally available immediately in this fixture.
    query: jest.fn().mockResolvedValue({
      workspaces: [],
      standaloneChats: [],
    }),
    command: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn((): (() => void) => (): void => {}),
  },
}));

jest.mock('./../SidebarCoworkWorkspaceRow', () => ({
  __esModule: true,
  // Stands in for the Chats rows; reports whether the host asked it to list
  // `None found` while empty.
  SidebarCoworkWorkspaceRow: ({
    listsNoneFoundWhenEmpty,
    onMoveToOrganizationRequested,
  }: {
    listsNoneFoundWhenEmpty?: boolean;
    onMoveToOrganizationRequested?: (workspaceId: string) => void;
  }): JSX.Element => (
    <span
      data-testid="mock-chats-rows"
      data-lists-none-found={listsNoneFoundWhenEmpty === true}
      data-offers-move={onMoveToOrganizationRequested !== undefined}
    />
  ),
}));

jest.mock('@/components/archive/ArchivedContainerActionsMenu', () => ({
  __esModule: true,
  ArchivedContainerActionsMenu: (): JSX.Element | null => null,
}));

jest.mock(
  '@/components/shared-containers/SharedContainerSidebarSection',
  () => ({
    __esModule: true,
    SharedContainerSidebarSection: (props: {
      expanded: boolean;
      onExpandedChange: (expanded: boolean) => void;
    }): JSX.Element => {
      capturedSharedContainerSectionProps.push(props);
      return <div data-testid="shared-container-sidebar-section" />;
    },
  }),
);

const mockOpenNewCoworkTaskFromSidebar = jest.fn();
jest.mock('@/lib/openNewCoworkTaskFromSidebar', () => ({
  __esModule: true,
  openNewCoworkTaskFromSidebar: (
    workspaceId: string,
    options?: { pending?: boolean },
  ): void => {
    mockOpenNewCoworkTaskFromSidebar(workspaceId, options);
  },
}));

jest.mock('@/hooks/useCanopyOrgProjectsEnabled', () => ({
  useCanopyOrgProjectsEnabled: (): boolean => true,
}));

import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useChatStore } from '@/stores/chatStore';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { requestWorktreeArchiveConfirmation } from '@/lib/worktreeArchiveConfirmationEvents';
import { useSidebarWorkspaces } from '../useSidebarWorkspaces';
import { DesktopSharedSidebarHost } from '../DesktopSharedSidebarHost';
import {
  setDesktopRowLiveKeys,
  useDesktopRowLiveKeysStore,
  type DesktopWorktreeRowLiveKeys,
} from '../desktopWorktreeRowOverrides';
import { useNavigationStore } from '@/stores/navigationStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { useSidebarPageHandoffStore } from '@/stores/sidebarPageHandoffStore';
import { SPLIT_PR_BLOCKER_COPY } from '@/lib/splitPrEligibilityInputs';
import { useSplitPrPreferencesStore } from '@/hooks/useSplitPrPreferences';
import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { resolveArchiveRetentionDays } from '@canopy/desktop-shared/lib/archive-retention';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import {
  openMoveToOrganizationModal,
  useMoveToOrganizationModalStore,
} from '@/stores/moveToOrganizationModalStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      sidebarItemGroups: {
        onChanged: (): (() => void) => (): void => undefined,
      },
    },
  });
});

describe('DesktopSharedSidebarHost chrome', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    capturedProps.length = 0;
    capturedSharedContainerSectionProps.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([undefined, 'grp-retry'])(
    'creation in group %s reports its failure once and returns the successful retry',
    async (groupId) => {
      const original = useProjectsStore.getState();
      const originalPage = useNavigationStore.getState().activePage;
      const toast = jest
        .spyOn(useGitHubStore.getState(), 'addToast')
        .mockImplementation(() => {});
      const navigate = jest
        .spyOn(useNavigationStore.getState(), 'navigate')
        .mockImplementation(() => {});
      const error =
        'Selected Git executable cannot be used. Git executable does not exist: /home/canopy-desktop/.cache/can5422-filtered-path-candidate-v3/git';
      const create = jest
        .spyOn(original, 'createWorktree')
        .mockImplementationOnce(() => {
          useProjectsStore.setState({ worktreeError: error });
          return Promise.resolve(undefined);
        })
        .mockImplementationOnce((_projectId, options) => {
          if (groupId === undefined) {
            options?.onRegistered?.({
              id: 'retry-row',
              branchName: 'retry',
              createdAt: '2026-10-30T00:00:00.000Z',
            });
            // Navigation must happen at registration, before creation resolves.
            expect(navigate).toHaveBeenCalledWith('main');
          }
          return Promise.resolve({ id: 'retry-row' });
        });
      try {
        useNavigationStore.setState({ activePage: 'main' });
        useProjectsStore.setState({ pendingWorkspaceRepair: null });
        await act(async () => {
          root.render(
            <CanopyClientProvider client={createFakeClient().client}>
              <DesktopSharedSidebarHost />
            </CanopyClientProvider>,
          );
          await Promise.resolve();
        });
        const createFromHeader = capturedProps.at(-1)?.onCreateWorktree;
        if (!createFromHeader)
          throw new Error('Missing header creation command');
        await act(async () => {
          const failed = Promise.resolve(
            createFromHeader('retry-code', groupId),
          );
          await expect(failed).rejects.toThrow(error);
          // The shared sidebar forwards the rejection after clearing its pending
          // row. The persistent worktree notice already owns this failure.
          await failed.catch((failure: unknown) =>
            capturedProps.at(-1)?.onGroupError?.('retry-code', failure),
          );
          expect(toast).not.toHaveBeenCalled();
          expect(navigate).not.toHaveBeenCalled();
          await expect(
            createFromHeader('retry-code', groupId),
          ).resolves.toEqual({
            status: 'completed',
            worktreeId: 'retry-row',
          });
        });
        expect(create).toHaveBeenCalledTimes(2);
        // An unrelated failure still needs a toast, even with identical text.
        const groupError = new Error(error);
        capturedProps.at(-1)?.onGroupError?.('retry-code', groupError);
        expect(toast).toHaveBeenCalledWith(groupError.message, 'error');
        toast.mockClear();
        useProjectsStore.setState({ worktreeError: null });
        create.mockResolvedValueOnce(undefined);
        await act(async () => {
          const failed = Promise.resolve(
            createFromHeader('retry-code', groupId),
          );
          await expect(failed).rejects.toThrow(
            'Worktree could not be created. Try again.',
          );
          await failed.catch((failure: unknown) =>
            capturedProps.at(-1)?.onGroupError?.('retry-code', failure),
          );
        });
        expect(toast).toHaveBeenCalledWith(
          'Worktree could not be created. Try again.',
          'error',
        );
      } finally {
        toast.mockRestore();
        create.mockRestore();
        navigate.mockRestore();
        useNavigationStore.setState({ activePage: originalPage });
        useProjectsStore.setState({
          createWorktree: original.createWorktree,
          pendingWorkspaceRepair: original.pendingWorkspaceRepair,
          worktreeError: original.worktreeError,
        });
      }
    },
  );

  it.each([
    { page: 'home', message: 'Creation failed', dismissed: false },
    { page: 'overview', message: 'Creation failed', dismissed: false },
    { page: 'main', message: ' \r\n\t ', dismissed: false },
    { page: 'main', message: 'Creation failed', dismissed: true },
    {
      page: 'main',
      message: 'Creation failed',
      dismissed: false,
      overlay: 'archive',
    },
    {
      page: 'main',
      message: 'Creation failed',
      dismissed: false,
      overlay: 'archive-overview',
    },
    {
      page: 'main',
      message: 'Creation failed',
      dismissed: false,
      overlay: 'shared',
    },
    {
      page: 'main',
      message: 'Creation failed',
      dismissed: false,
      overlay: 'past-shares',
    },
    {
      page: 'main',
      message: 'Creation failed',
      dismissed: false,
      overlay: 'settings',
    },
    {
      page: 'main',
      message: 'Creation failed',
      dismissed: false,
      overlay: 'project-settings',
    },
    {
      page: 'main',
      message: 'Creation failed',
      dismissed: false,
      overlay: 'advisor-archive',
    },
    {
      page: 'main',
      message: 'Creation failed',
      dismissed: false,
      overlay: 'cowork-archive',
    },
  ] as const)(
    'reports once on $page ($message; dismissed=$dismissed; overlay=$overlay)',
    async (scenario) => {
      const { page, message, dismissed } = scenario;
      const original = useProjectsStore.getState();
      const originalPage = useNavigationStore.getState().activePage;
      const originalSettingsOpen = useNavigationStore.getState().settingsOpen;
      const originalArchive = useArchivedContainersStore.getState();
      const originalShared = useSharedContainerReplicasStore.getState();
      const originalHandoff = useSidebarPageHandoffStore.getState();
      const toast = jest
        .spyOn(useGitHubStore.getState(), 'addToast')
        .mockImplementation(() => {});
      const create = jest
        .spyOn(original, 'createWorktree')
        .mockImplementation(() => {
          useProjectsStore.setState({ worktreeError: message });
          return Promise.resolve(undefined);
        });
      try {
        await act(async () => {
          useNavigationStore.setState({ activePage: page });
          if ('overlay' in scenario) {
            switch (scenario.overlay) {
              case 'archive':
                useArchivedContainersStore.setState({
                  viewer: {
                    workspaceId: 'retry-code',
                    containerId: 'archive',
                    tab: 'chats',
                  },
                });
                break;
              case 'archive-overview':
                useArchivedContainersStore.setState({
                  overview: { workspaceId: 'retry-code' },
                });
                break;
              case 'shared':
                useSharedContainerReplicasStore.setState({
                  viewer: {
                    containerId: 'share',
                    replica: null,
                    openError: null,
                    loading: true,
                  },
                });
                break;
              case 'past-shares':
                useSharedContainerReplicasStore.setState({
                  pastSharesOpen: true,
                });
                break;
              case 'settings':
                useNavigationStore.setState({ settingsOpen: true });
                break;
              case 'project-settings':
                useSidebarPageHandoffStore.setState({
                  active: true,
                  coversMainShell: true,
                });
                break;
              case 'advisor-archive':
              case 'cowork-archive':
                useArchivedContainersStore.setState({
                  viewer: {
                    workspaceId:
                      scenario.overlay === 'advisor-archive'
                        ? APP_ADVISOR_PROJECT_ID
                        : STANDALONE_CHAT_PROJECT_ID,
                    containerId: 'other-surface',
                    tab: 'chats',
                  },
                });
                break;
            }
          }
          useProjectsStore.setState({ pendingWorkspaceRepair: null });
          root.render(
            <CanopyClientProvider client={createFakeClient().client}>
              <DesktopSharedSidebarHost />
            </CanopyClientProvider>,
          );
          await Promise.resolve();
        });
        const props = capturedProps.at(-1);
        const createFromHeader = props?.onCreateWorktree;
        if (!createFromHeader)
          throw new Error('Missing header creation command');
        await act(async () => {
          await Promise.resolve(createFromHeader('retry-code')).catch(
            (failure: unknown) => {
              if (dismissed) useProjectsStore.getState().clearWorktreeError();
              props?.onGroupError?.('retry-code', failure);
            },
          );
        });
        if (
          'overlay' in scenario &&
          (scenario.overlay === 'advisor-archive' ||
            scenario.overlay === 'cowork-archive')
        ) {
          expect(toast).not.toHaveBeenCalled();
        } else {
          expect(toast).toHaveBeenCalledTimes(1);
          expect(toast).toHaveBeenCalledWith(
            message.trim()
              ? message
              : 'Worktree could not be created. Try again.',
            'error',
          );
        }
      } finally {
        toast.mockRestore();
        create.mockRestore();
        useNavigationStore.setState({ activePage: originalPage });
        useNavigationStore.setState({ settingsOpen: originalSettingsOpen });
        useArchivedContainersStore.setState({
          viewer: originalArchive.viewer,
          overview: originalArchive.overview,
        });
        useSharedContainerReplicasStore.setState({
          viewer: originalShared.viewer,
          pastSharesOpen: originalShared.pastSharesOpen,
        });
        useSidebarPageHandoffStore.setState({
          active: originalHandoff.active,
          coversMainShell: originalHandoff.coversMainShell,
        });
        useProjectsStore.setState({
          createWorktree: original.createWorktree,
          pendingWorkspaceRepair: original.pendingWorkspaceRepair,
          worktreeError: original.worktreeError,
        });
      }
    },
  );

  it('keeps later navigation when header creation settles after registration', async () => {
    const original = useProjectsStore.getState();
    const originalNavigation = useNavigationStore.getState();
    const originalChat = useChatStore.getState();
    let finishPersistence: ((value: { id: string }) => void) | undefined;
    const capability = jest.replaceProperty(ipcCanopyClient, 'capabilities', {
      ...ipcCanopyClient.capabilities,
      worktreeCreation: true,
    });
    const navigate = jest
      .spyOn(originalNavigation, 'navigate')
      .mockImplementation((page) => {
        if (page === 'agents') throw new Error('Unexpected agents navigation');
        useNavigationStore.setState({ activePage: page });
      });
    const select = jest
      .spyOn(originalChat, 'selectWorktree')
      .mockImplementation((projectId, worktreeId) => {
        useChatStore.setState({ selectedWorktree: { projectId, worktreeId } });
      });
    const create = jest
      .spyOn(original, 'createWorktree')
      .mockImplementation((projectId, options) => {
        useChatStore.getState().selectWorktree(projectId, 'registered-row');
        options?.onRegistered?.({
          id: 'registered-row',
          branchName: 'new-branch',
          createdAt: '2026-10-30T00:00:00.000Z',
        });
        return new Promise((resolve) => {
          finishPersistence = resolve;
        });
      });
    const client = createFakeClient().client;
    try {
      useProjectsStore.setState({
        projects: [
          {
            type: 'single-repo',
            id: 'slow-code',
            name: 'Slow Code',
            repoPath: '/slow',
            color: '#000000',
            collapsed: false,
            order: 0,
            worktrees: [],
          },
        ],
        pendingWorkspaceRepair: null,
      });
      jest.mocked(ipcCanopyClient).query.mockResolvedValueOnce(
        makeSessionSnapshot({
          workspaces: [
            { localId: 'slow-code', name: 'Slow Code', type: 'single-repo' },
          ],
          worktrees: [],
          standaloneChats: [],
          chatProjects: [],
        }),
      );
      await act(async () => {
        root.render(
          <CanopyClientProvider
            client={{
              ...client,
              capabilities: { ...client.capabilities, worktreeCreation: true },
            }}
          >
            <DesktopSharedSidebarHost />
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
      const add = container.querySelector<HTMLButtonElement>(
        '[aria-label="Create worktree for Slow Code"]',
      );
      expect(add).not.toBeNull();
      await act(async () => {
        add?.click();
        await Promise.resolve();
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenLastCalledWith('main');
      expect(select).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('Creating worktree…');
      act(() => useNavigationStore.getState().navigate('home'));
      await act(async () => {
        finishPersistence?.({ id: 'registered-row' });
        await Promise.resolve();
      });
      expect(container.textContent).not.toContain('Creating worktree…');
      expect(useNavigationStore.getState().activePage).toBe('home');
      expect(navigate).toHaveBeenLastCalledWith('home');
      expect(select).toHaveBeenCalledTimes(1);
    } finally {
      create.mockRestore();
      navigate.mockRestore();
      select.mockRestore();
      act(() => {
        useProjectsStore.setState(original);
        useNavigationStore.setState(originalNavigation);
        useChatStore.setState(originalChat);
        capability.restore();
      });
    }
  });

  it('grouped creation needing repair stays pending without reporting a failed creation', async () => {
    const original = useProjectsStore.getState();
    const create = jest
      .spyOn(original, 'createWorktree')
      .mockImplementation(() => {
        useProjectsStore.setState({
          worktreeError: null,
          pendingWorkspaceRepair: {
            workspaceId: 'repair-code',
            workspaceName: 'Repair Code',
            id: 'repair-row',
            branchName: 'task/repair',
            repairIssues: [],
          },
        });
        return Promise.resolve(undefined);
      });
    try {
      await act(async () => {
        root.render(
          <CanopyClientProvider client={createFakeClient().client}>
            <DesktopSharedSidebarHost />
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
      const props = capturedProps.at(-1);
      expect(props?.onCreateWorktree).toBeDefined();
      await act(async () => {
        await expect(
          props?.onCreateWorktree?.('repair-code', 'grp-repair'),
        ).resolves.toEqual({ status: 'pending' });
      });
      expect(create).toHaveBeenCalledWith(
        'repair-code',
        expect.objectContaining({ sidebarItemGroupId: 'grp-repair' }),
      );
      expect(useProjectsStore.getState().pendingWorkspaceRepair?.id).toBe(
        'repair-row',
      );
      expect(useProjectsStore.getState().worktreeError).toBeNull();
    } finally {
      create.mockRestore();
      useProjectsStore.setState({
        createWorktree: original.createWorktree,
        pendingWorkspaceRepair: original.pendingWorkspaceRepair,
        worktreeError: original.worktreeError,
      });
    }
  });

  it('shows loading projects until its first snapshot arrives', async () => {
    let releaseSnapshot = (): void => {};
    jest.mocked(ipcCanopyClient).query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSnapshot = (): void =>
            resolve(
              makeSessionSnapshot({
                workspaces: [],
                worktrees: [],
                standaloneChats: [],
                chatProjects: [],
              }),
            );
        }),
    );
    await act(async () => {
      root.render(
        <CanopyClientProvider client={createFakeClient().client}>
          <DesktopSharedSidebarHost />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
    try {
      expect(
        container.querySelector('[data-testid="sidebar-section-code-loading"]')
          ?.textContent,
      ).toContain('Loading projects');
      expect(capturedProps).toHaveLength(0);
    } finally {
      await act(async () => {
        releaseSnapshot();
        await Promise.resolve();
      });
    }
    expect(
      container.querySelector('[data-testid="sidebar-section-code-loading"]'),
    ).toBeNull();
    expect(capturedProps.length).toBeGreaterThan(0);
  });

  it('retries its first snapshot after a transient failure', async () => {
    jest.useFakeTimers();
    try {
      jest
        .mocked(ipcCanopyClient)
        .query.mockRejectedValueOnce(new Error('transient snapshot failure'));
      await act(async () => {
        root.render(
          <CanopyClientProvider client={createFakeClient().client}>
            <DesktopSharedSidebarHost />
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="sidebar-section-code-loading"]'),
      ).not.toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(1_000);
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="sidebar-section-code-loading"]'),
      ).toBeNull();
      expect(capturedProps.length).toBeGreaterThan(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['resolve', 'reject'] as const)(
    'coalesces stale events into serial trailing refreshes when a refresh will %s',
    async (outcome) => {
      const query = jest.spyOn(ipcCanopyClient, 'query');
      const subscribe = jest.spyOn(ipcCanopyClient, 'subscribe');
      const pending = Array.from({ length: 3 }, () => {
        let resolve: (snapshot: SessionViewModel) => void = () => {};
        let reject: (error: Error) => void = () => {};
        const promise = new Promise<SessionViewModel>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        return { promise, resolve, reject };
      });
      query.mockClear();
      subscribe.mockClear();
      query.mockResolvedValueOnce(makeSessionSnapshot());
      for (const request of pending) {
        query.mockImplementationOnce(() => request.promise);
      }
      const onSnapshot = jest.fn();
      try {
        await act(async () => {
          root.render(
            <CanopyClientProvider client={createFakeClient().client}>
              <DesktopSharedSidebarHost onSnapshot={onSnapshot} />
            </CanopyClientProvider>,
          );
          await Promise.resolve();
        });
        expect(query).toHaveBeenCalledTimes(1);
        const subscription = subscribe.mock.calls.find(
          ([name]) => name === 'session.snapshot-stale',
        );
        if (!subscription) throw new Error('Snapshot subscription not mounted');
        const invalidate = (): void =>
          subscription[1]({ occurredAt: '2026-11-02T00:00:00Z' });

        await act(async () => {
          invalidate();
          invalidate();
          invalidate();
          await Promise.resolve();
        });
        expect(query).toHaveBeenCalledTimes(2);

        await act(async () => {
          if (outcome === 'reject') {
            pending[0].reject(new Error('Refresh unavailable'));
          } else {
            pending[0].resolve(makeSessionSnapshot());
          }
          await Promise.resolve();
        });
        expect(query).toHaveBeenCalledTimes(3);
        expect(onSnapshot).toHaveBeenCalledTimes(1);

        await act(async () => {
          invalidate();
          invalidate();
          await Promise.resolve();
        });
        expect(query).toHaveBeenCalledTimes(3);
        await act(async () => {
          pending[1].resolve(makeSessionSnapshot());
          await Promise.resolve();
        });
        expect(query).toHaveBeenCalledTimes(4);
        expect(onSnapshot).toHaveBeenCalledTimes(1);

        const latest = makeSessionSnapshot({
          connectionStatus: 'reconnecting',
        });
        await act(async () => {
          pending[2].resolve(latest);
          await Promise.resolve();
        });
        expect(query).toHaveBeenCalledTimes(4);
        expect(onSnapshot).toHaveBeenCalledTimes(2);
        expect(onSnapshot).toHaveBeenLastCalledWith(latest);
      } finally {
        await act(async () => {
          for (const request of pending) request.resolve(makeSessionSnapshot());
          await Promise.resolve();
        });
        query.mockReset();
        query.mockResolvedValue(makeSessionSnapshot());
      }
    },
  );

  it.each([
    ['unmount', 'resolve'],
    ['unmount', 'reject'],
    ['replace', 'resolve'],
    ['replace', 'reject'],
  ] as const)(
    'discards a queued refresh on %s even when its request will %s',
    async (lifecycle, outcome) => {
      let resolve: (snapshot: SessionViewModel) => void = () => {};
      let reject: (error: Error) => void = () => {};
      const pending = new Promise<SessionViewModel>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const unsubscribe = jest.fn();
      const oldClient = createFakeClient().client;
      const oldQuery = jest
        .spyOn(oldClient, 'query')
        .mockImplementation(() => pending);
      const oldSubscribe = jest
        .spyOn(oldClient, 'subscribe')
        .mockImplementation((name) =>
          name === 'session.snapshot-stale' ? unsubscribe : (): void => {},
        );
      const latest = makeSessionSnapshot({ connectionStatus: 'reconnecting' });
      const newClient = createFakeClient().client;
      const newQuery = jest.spyOn(newClient, 'query').mockResolvedValue(latest);
      jest
        .spyOn(newClient, 'subscribe')
        .mockImplementation(() => (): void => {});
      const onSnapshot = jest.fn();
      const onRefreshMeasured = jest.fn();
      const providerClient = createFakeClient().client;
      try {
        await act(async () => {
          root.render(
            <CanopyClientProvider client={providerClient}>
              <DesktopSharedSidebarHost
                client={oldClient}
                onSnapshot={onSnapshot}
                onRefreshMeasured={onRefreshMeasured}
              />
            </CanopyClientProvider>,
          );
          await Promise.resolve();
        });
        const subscription = oldSubscribe.mock.calls.find(
          ([name]) => name === 'session.snapshot-stale',
        );
        if (!subscription) throw new Error('Snapshot subscription not mounted');
        const invalidate = (): void =>
          subscription[1]({ occurredAt: '2026-11-02T00:00:00Z' });
        await act(async () => {
          invalidate();
          invalidate();
          await Promise.resolve();
        });
        expect(oldQuery).toHaveBeenCalledTimes(1);
        await act(async () => {
          root.render(
            lifecycle === 'unmount' ? null : (
              <CanopyClientProvider client={providerClient}>
                <DesktopSharedSidebarHost
                  client={newClient}
                  onSnapshot={onSnapshot}
                  onRefreshMeasured={onRefreshMeasured}
                />
              </CanopyClientProvider>
            ),
          );
          await Promise.resolve();
        });
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        await act(async () => {
          invalidate();
          if (outcome === 'reject')
            reject(new Error('Disposed request failed'));
          else resolve(makeSessionSnapshot());
          await Promise.resolve();
        });
        expect(oldQuery).toHaveBeenCalledTimes(1);
        expect(onSnapshot).toHaveBeenCalledTimes(
          lifecycle === 'unmount' ? 0 : 1,
        );
        expect(onRefreshMeasured).toHaveBeenCalledTimes(
          lifecycle === 'unmount' ? 0 : 1,
        );
        if (lifecycle === 'replace') {
          expect(newQuery).toHaveBeenCalledTimes(1);
          expect(onSnapshot).toHaveBeenLastCalledWith(latest);
        }
      } finally {
        await act(async () => {
          resolve(makeSessionSnapshot());
          await Promise.resolve();
        });
      }
    },
  );

  it('renders pending organization Chats above a None found Projects row (CAN-3550)', async (): Promise<void> => {
    const originalContext = useWorkspaceContextStore.getState();
    const organizationId = '11111111-1111-4111-8111-111111111111';
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId },
        organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
        revision: 1,
      },
    });
    try {
      await act(async (): Promise<void> => {
        root.render(
          <CanopyClientProvider client={createFakeClient().client}>
            <DesktopSharedSidebarHost />
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
      // The default shared rail: Chats listed above does not hide the empty
      // Projects row, and nothing describes the organization as empty.
      const emptyState = container.querySelector(
        '[data-testid="sidebar-context-empty-state"]',
      );
      expect(emptyState?.textContent).toBe('None found');
      expect(
        container.querySelector(
          '[data-testid="sidebar-context-empty-state-back"]',
        ),
      ).toBeNull();
      const chats = container.querySelector(
        '[data-testid="sidebar-section-chats"]',
      );
      expect(chats).not.toBeNull();
      expect(
        chats !== null &&
          emptyState !== null &&
          (chats.compareDocumentPosition(emptyState) &
            Node.DOCUMENT_POSITION_FOLLOWING) !==
            0,
      ).toBe(true);
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-section-chats-settings"]',
        )?.disabled,
      ).toBe(true);
      // The Chats rows are asked for the same row while empty, and both
      // headers keep their "+" on screen (CAN-3550).
      expect(
        container
          .querySelector(
            '[data-testid="sidebar-section-chats-content"] [data-testid="mock-chats-rows"]',
          )
          ?.getAttribute('data-lists-none-found'),
      ).toBe('true');
      expect(emptyState?.querySelector('button') ?? null).toBeNull();
      for (const id of [
        'sidebar-section-chats-new-chat',
        'sidebar-section-code-add',
      ]) {
        const add = container.querySelector(`[data-testid="${id}"]`);
        expect(add).not.toBeNull();
        expect(add?.closest('[class~="opacity-0"]')).toBeNull();
      }
    } finally {
      act((): void => root.unmount());
      useWorkspaceContextStore.setState(originalContext);
    }
  });

  it("opens the Chats section's new chat in the organization's own Chats workspace", async (): Promise<void> => {
    const originalContext = useWorkspaceContextStore.getState();
    const organizationId = '11111111-1111-4111-8111-111111111111';
    mockOpenNewCoworkTaskFromSidebar.mockClear();
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId },
        organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
        revision: 1,
      },
    });
    try {
      await act(async (): Promise<void> => {
        root.render(
          <CanopyClientProvider client={createFakeClient().client}>
            <DesktopSharedSidebarHost />
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
      const props = capturedProps[capturedProps.length - 1];
      act((): void => props.onCreateChatsSectionChat?.());
      expect(mockOpenNewCoworkTaskFromSidebar).toHaveBeenCalledWith(
        `cowork-org-${organizationId}`,
        { pending: true },
      );
    } finally {
      act((): void => root.unmount());
      useWorkspaceContextStore.setState(originalContext);
    }
  });

  it('routes worktree intent through the desktop prefetch scheduler', async () => {
    jest.mocked(noteChatIntent).mockClear();
    jest.mocked(endChatIntent).mockClear();
    await act(async () => {
      root.render(
        <CanopyClientProvider client={createFakeClient().client}>
          <DesktopSharedSidebarHost />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
    const props = capturedProps[capturedProps.length - 1];
    props.onWorktreeIntent?.('code-1', 'feature/a', 'start', 'pointer');
    props.onWorktreeIntent?.('code-1', 'feature/a', 'end', 'pointer');
    props.onWorktreeIntent?.('code-1', 'feature/a', 'start', 'focus');
    props.onWorktreeIntent?.('code-1', 'feature/a', 'end', 'focus');
    const target = {
      kind: 'worktree',
      projectId: 'code-1',
      worktreeId: 'feature/a',
    };
    expect(noteChatIntent).toHaveBeenCalledTimes(2);
    expect(noteChatIntent).toHaveBeenNthCalledWith(1, target, 'pointer');
    expect(noteChatIntent).toHaveBeenNthCalledWith(2, target, 'focus');
    expect(endChatIntent).toHaveBeenCalledTimes(2);
    expect(endChatIntent).toHaveBeenNthCalledWith(1, target);
    expect(endChatIntent).toHaveBeenNthCalledWith(2, target);
  });

  it('renders the nested surface without command chrome', async () => {
    await act(async () => {
      root.render(
        <CanopyClientProvider client={createFakeClient().client}>
          <DesktopSharedSidebarHost />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });

    expect(capturedProps.length).toBeGreaterThan(0);
    const props = capturedProps[capturedProps.length - 1];
    expect(props.chrome).toBe('navigation-only');
    // Drawer shape (fills the rail's scroll area), fine pointer (it is a
    // mouse-and-keyboard surface, not a phone drawer).
    expect(props.variant).toBe('drawer');
    expect(props.pointer).toBe('fine');
    // And the reason it matters: with no handler, `'full'` chrome would render
    // a dead, permanently disabled New Task button above the Projects header.
    expect(props.onCreateTask).toBeUndefined();
  });

  // Every desktop row mutation (label, pin, hide, archive/delete, reorder,
  // grouping, split, repositories) persists through the projects store, so a
  // row the store does not hold (a cloud session projected into the rail)
  // offers none of them: each would fail in main and change nothing. It keeps
  // what needs no store row: selection and the read-only info.
  it('offers only desktop-backed actions on rows the store does not hold', async () => {
    const projectsBefore = useProjectsStore.getState();
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'code-1',
          name: 'Code',
          repoPath: '/repo',
          color: '#000000',
          collapsed: false,
          order: 0,
          worktrees: [
            {
              id: 'local-row',
              branchName: 'feature/local',
              createdAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        },
      ],
    });
    jest.mocked(ipcCanopyClient).query.mockResolvedValueOnce(
      makeSessionSnapshot({
        workspaces: [{ localId: 'code-1', name: 'Code', type: 'single-repo' }],
        worktrees: [
          { localId: 'local-row', workspaceLocalId: 'code-1', branch: 'a' },
          {
            localId: 'cloud-session',
            workspaceLocalId: 'code-1',
            branch: 'cloud',
            backend: 'cloud',
          },
        ],
        standaloneChats: [],
        chatProjects: [],
      }),
    );
    try {
      await act(async () => {
        root.render(
          <CanopyClientProvider client={createFakeClient().client}>
            <DesktopSharedSidebarHost />
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
      const props = capturedProps.at(-1);
      expect(props?.transformWorktreeMenuItems).toBeDefined();
      const allKeys = [
        'set-label',
        'branch-info',
        'launch',
        'dispatch-pipeline',
        'split-pr',
        'create-branch',
        'group-with-base',
        'add-repository',
        'toggle-pin',
        'toggle-hidden',
        'archive',
        'delete',
      ] as const;
      const items = allKeys.map((key) => ({ key, label: key, icon: null }));
      const keysFor = (worktreeId: string): string[] =>
        (
          props?.transformWorktreeMenuItems?.(
            {
              workspace: {
                localId: 'code-1',
                name: 'Code',
                type: 'single-repo',
              },
              worktree: {
                localId: worktreeId,
                workspaceLocalId: 'code-1',
                branch: 'cloud',
              },
              selected: false,
              hidden: false,
              sortable: false,
              worktreeRemoval: undefined,
            },
            items,
          ) ?? items
        ).map((item) => item.key);

      expect(keysFor('local-row')).toEqual([...allKeys]);
      expect(keysFor('cloud-session')).toEqual(['branch-info']);

      // Cloud rows read through their own path, so hover never prefetches.
      jest.mocked(noteChatIntent).mockClear();
      props?.onWorktreeIntent?.('code-1', 'cloud-session', 'start', 'focus');
      expect(noteChatIntent).not.toHaveBeenCalled();
      props?.onWorktreeIntent?.('code-1', 'local-row', 'start', 'focus');
      expect(noteChatIntent).toHaveBeenCalledTimes(1);

      // Reorder is a drag, not a menu row: the cloud row is not sortable.
      expect(props?.capabilitiesFor?.('cloud-session').worktreeReordering).toBe(
        false,
      );
      expect(props?.capabilitiesFor?.('local-row').worktreeReordering).toBe(
        true,
      );

      // The store row's label edit is desktop's own Branch Info dialog.
      let tookLocalLabel = false;
      let tookCloudInfo = true;
      act(() => {
        tookLocalLabel =
          props?.onSetLabelRequestedOverride?.('code-1', 'local-row') === true;
        tookCloudInfo =
          props?.onBranchInfoRequestedOverride?.('code-1', 'cloud-session') ===
          true;
      });
      expect(tookLocalLabel).toBe(true);
      expect(tookCloudInfo).toBe(false);
    } finally {
      useProjectsStore.setState(projectsBefore, true);
    }
  });

  it('keeps recipient shares reachable through the flag-enabled sidebar host', async () => {
    await act(async () => {
      root.render(
        <CanopyClientProvider client={createFakeClient().client}>
          <DesktopSharedSidebarHost />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });

    const section = container.querySelector(
      '[data-testid="shared-container-sidebar-section"]',
    );
    expect(section).not.toBeNull();
    expect(capturedSharedContainerSectionProps.at(-1)?.expanded).toBe(true);
    // Inside the rail's own flow, after the Projects section, as the legacy
    // section placed it, rather than trailing the rail as a stray sibling.
    const rail = container.querySelector('[data-testid="sidebar-shared-rail"]');
    const projects = container.querySelector(
      '[data-testid="sidebar-section-code"]',
    );
    expect(rail?.contains(section)).toBe(true);
    expect(
      projects && section
        ? projects.compareDocumentPosition(section) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();
  });
});

describe('DesktopSharedSidebarHost live delegates', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    capturedProps.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetDelegationActivityStoreForTests();
  });

  it('reports a worktree whose chat has live delegates as an active session', async () => {
    await act(async () => {
      root.render(
        <CanopyClientProvider client={createFakeClient().client}>
          <DesktopSharedSidebarHost />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
    expect(capturedProps.at(-1)?.hasActiveWorktreeSession?.('p1', 'w1')).toBe(
      false,
    );

    // The chat's own turn has ended; only its delegates are still running.
    act(() => {
      useDelegationActivityStore.getState().applyActivity({
        projectId: 'p1',
        worktreeId: 'w1',
        chatId: 'c1',
        live: 0,
        queued: 1,
      });
    });
    // Drives `hasActiveSession`, which disables Archive and Delete.
    expect(capturedProps.at(-1)?.hasActiveWorktreeSession?.('p1', 'w1')).toBe(
      true,
    );

    act(() => {
      useDelegationActivityStore.getState().applyActivity({
        projectId: 'p1',
        worktreeId: 'w1',
        chatId: 'c1',
        live: 0,
        queued: 0,
      });
    });
    expect(capturedProps.at(-1)?.hasActiveWorktreeSession?.('p1', 'w1')).toBe(
      false,
    );
  });
});

describe('sidebar context hydration', () => {
  it('keeps both paths unscoped until hydration, then scopes to the organization', async (): Promise<void> => {
    const contextBefore = useWorkspaceContextStore.getState();
    const projectsBefore = useProjectsStore.getState();
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const container = document.createElement('div');
    const root = createRoot(container);
    let visibleIds: string[] = [];
    function WorkspaceProbe(): null {
      visibleIds = useSidebarWorkspaces().visibleProjects.map(
        (project) => project.id,
      );
      return null;
    }
    useWorkspaceContextStore.setState({
      hydrated: false,
      state: { context: { kind: 'personal' }, organizations: [], revision: 0 },
    });
    useProjectsStore.setState({
      projects: [
        {
          id: 'personal',
          name: 'Personal repo',
          type: 'single-repo',
          repoPath: '/personal',
          color: '#123456',
          collapsed: false,
          order: 0,
          worktrees: [],
        },
        {
          id: 'organization',
          name: 'Organization repo',
          type: 'single-repo',
          repoPath: '/organization',
          color: '#123456',
          collapsed: false,
          order: 1,
          worktrees: [],
          owner: {
            type: 'organization',
            organizationId,
            projectId: '22222222-2222-4222-8222-222222222222',
            instanceId: '33333333-3333-4333-8333-333333333333',
            bindingGeneration: 0,
          },
        },
      ],
    });
    try {
      await act(async (): Promise<void> => {
        root.render(
          <>
            <CanopyClientProvider client={createFakeClient().client}>
              <DesktopSharedSidebarHost />
            </CanopyClientProvider>
            <CanopyClientProvider client={createFakeClient().client}>
              <WorkspaceProbe />
            </CanopyClientProvider>
          </>,
        );
        await Promise.resolve();
      });
      expect({ context: capturedProps.at(-1)?.context, visibleIds }).toEqual({
        context: undefined,
        visibleIds: ['personal', 'organization'],
      });
      act((): void => {
        useWorkspaceContextStore.setState({
          hydrated: true,
          state: {
            context: { kind: 'organization', organizationId },
            organizations: [],
            revision: 1,
          },
        });
      });
      expect(capturedProps.at(-1)?.context).toEqual({
        kind: 'organization',
        organizationId,
      });
      expect(visibleIds).toEqual(['organization']);
    } finally {
      act((): void => root.unmount());
      container.remove();
      useWorkspaceContextStore.setState(contextBefore);
      useProjectsStore.setState(projectsBefore);
    }
  });
});

/**
 * Placeholder rows are not workspaces — `partitionWorkspaces` drops them — so
 * the shared host has to hand them to the surface itself. Nothing else does it
 * on this path: `SidebarWorkspacesSection` (the native sidebar) is not mounted
 * when the shared sidebar is on.
 */
describe('DesktopSharedSidebarHost catalog placeholders', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders no idle catalog row, and the setup row the native sidebar shows', async (): Promise<void> => {
    const originalContext = useWorkspaceContextStore.getState();
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const projectId = '33333333-3333-4333-8333-333333333331';
    const fake = createFakeClient();
    fake.query.mockImplementation(
      (name: string): Promise<unknown> =>
        name === 'orgProjects.catalog'
          ? Promise.resolve({
              context: serializeWorkspaceContext({
                kind: 'organization',
                organizationId,
              }),
              revision: '1',
              fetchedAt: '2026-09-18T00:00:00.000Z',
              projects: [
                {
                  id: projectId,
                  organizationId,
                  name: 'Catalog ready',
                  description: null,
                  kind: 'CODE',
                  location: 'LOCAL',
                  repository: {
                    provider: 'github',
                    host: 'github.com',
                    owner: 'acme',
                    name: 'repo-0',
                    providerRepoId: '1',
                    defaultBranch: 'main',
                    verification: 'VERIFIED',
                  },
                  state: 'ACTIVE',
                  revision: 1,
                  authorizationVersion: 1,
                  defaultListed: true,
                  preference: 'FOLLOW_DEFAULTS',
                  listed: true,
                  capabilities: {
                    administer: false,
                    manageCloud: false,
                    use: true,
                  },
                  instance: null,
                },
              ],
            })
          : Promise.resolve(undefined),
    );
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId },
        organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
        revision: 1,
      },
    });
    try {
      await act(async (): Promise<void> => {
        root.render(
          <CanopyClientProvider client={fake.client}>
            <DesktopSharedSidebarHost />
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
      // Let the catalog load settle.
      await act(async (): Promise<void> => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fake.query).toHaveBeenCalledWith(
        'orgProjects.catalog',
        expect.anything(),
      );
      // CAN-3386: a project not set up is added from the + dialog, not listed.
      expect(
        container.querySelector(
          `[data-testid="sidebar-org-project-placeholder-${projectId}"]`,
        ),
      ).toBeNull();
      // A setup the member started is shown until it resolves.
      await act(async (): Promise<void> => {
        fake.emit('org-projects.setup-progress', {
          progress: {
            projectId,
            instanceId: null,
            state: 'materializing',
            message: 'Cloning repository',
            percent: 42,
            updatedAt: 'materializing',
          },
          occurredAt: 'materializing',
        });
        await Promise.resolve();
      });
      expect(
        container.querySelector(
          `[data-testid="sidebar-org-project-placeholder-${projectId}"]`,
        ),
      ).not.toBeNull();
      const group = container.querySelector(
        '[data-testid="sidebar-section-shared-projects"]',
      );
      expect(group?.textContent).toContain('Shared projects');
      expect(
        group?.querySelector(
          `[data-testid="sidebar-org-project-placeholder-${projectId}"]`,
        ),
      ).not.toBeNull();
    } finally {
      useWorkspaceContextStore.setState(originalContext);
    }
  });
});

describe('DesktopSharedSidebarHost store overlay', () => {
  it('hides a worktree as soon as the store does, ahead of the next snapshot', async (): Promise<void> => {
    const projectsBefore = useProjectsStore.getState();
    const baseSnapshot = makeSessionSnapshot({
      workspaces: [{ localId: 'code-1', name: 'Code', type: 'single-repo' }],
      worktrees: [
        { localId: 'wt-1', workspaceLocalId: 'code-1', branch: 'feature' },
      ],
      standaloneChats: [],
      chatProjects: [],
    });
    const query = jest
      .spyOn(ipcCanopyClient, 'query')
      .mockResolvedValue(baseSnapshot);
    const project = {
      id: 'code-1',
      name: 'Code',
      type: 'single-repo' as const,
      repoPath: '/code',
      color: '#123456',
      collapsed: false,
      order: 0,
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    };
    useProjectsStore.setState({ projects: [project] });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async (): Promise<void> => {
        root.render(
          <CanopyClientProvider client={createFakeClient().client}>
            <DesktopSharedSidebarHost />
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
      expect(
        capturedProps.at(-1)?.snapshot?.worktrees[0]?.hidden,
      ).toBeUndefined();
      await act(async (): Promise<void> => {
        useProjectsStore.setState({
          projects: [
            {
              ...project,
              worktrees: [{ ...project.worktrees[0], hidden: true }],
            },
          ],
        });
        await Promise.resolve();
      });
      expect(capturedProps.at(-1)?.snapshot?.worktrees[0]?.hidden).toBe(true);
    } finally {
      act((): void => root.unmount());
      container.remove();
      useProjectsStore.setState(projectsBefore);
      query.mockRestore();
    }
  });
});

/**
 * App Advisor's `worktree.archive` reports that a confirmation opened, so the
 * shared rail must open one even for a done worktree a row gesture would
 * remove at once, as the legacy row's subscriber always did.
 */
describe('DesktopSharedSidebarHost external archive requests', () => {
  it('opens the confirmation for a done worktree instead of removing it', async (): Promise<void> => {
    const projectsBefore = useProjectsStore.getState();
    const query = jest.spyOn(ipcCanopyClient, 'query').mockResolvedValue(
      makeSessionSnapshot({
        workspaces: [{ localId: 'code-1', name: 'Code', type: 'single-repo' }],
        worktrees: [
          { localId: 'wt-1', workspaceLocalId: 'code-1', branch: 'feature' },
        ],
        standaloneChats: [],
        chatProjects: [],
      }),
    );
    const archiveWorktree = jest.fn((): Promise<void> => Promise.resolve());
    useProjectsStore.setState({
      archiveWorktree,
      projects: [
        {
          id: 'code-1',
          name: 'Code',
          type: 'single-repo',
          repoPath: '/code',
          color: '#123456',
          collapsed: false,
          order: 0,
          worktrees: [
            {
              id: 'wt-1',
              branchName: 'feature',
              createdAt: '2026-01-01T00:00:00Z',
              status: 'done',
            },
          ],
        },
      ],
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async (): Promise<void> => {
        root.render(
          <CanopyClientProvider client={createFakeClient().client}>
            <DesktopSharedSidebarHost />
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
      let opened = false;
      act((): void => {
        opened = requestWorktreeArchiveConfirmation({
          projectId: 'code-1',
          worktreeId: 'wt-1',
          requestedDeleteBranch: false,
        });
      });
      expect(opened).toBe(true);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(archiveWorktree).not.toHaveBeenCalled();
    } finally {
      act((): void => root.unmount());
      container.remove();
      useProjectsStore.setState(projectsBefore);
      query.mockRestore();
    }
  });

  // App Advisor asked for Archive and for a branch handling: the dialog must
  // open as the Archive confirmation with its branch switch preset to the
  // request and a note naming it, while leaving the final choice to the user.
  it.each([
    [false, 'worktree-removal-preserve-branch', 'keeping it'],
    [true, 'worktree-removal-delete-branch', 'deleting it'],
  ])(
    'opens the requested mode and presets the requested branch choice (deleteBranch=%s)',
    async (requestedDeleteBranch, requestedTestId, hint): Promise<void> => {
      const projectsBefore = useProjectsStore.getState();
      const query = jest.spyOn(ipcCanopyClient, 'query').mockResolvedValue(
        makeSessionSnapshot({
          workspaces: [
            { localId: 'code-1', name: 'Code', type: 'single-repo' },
          ],
          worktrees: [
            { localId: 'wt-1', workspaceLocalId: 'code-1', branch: 'feature' },
          ],
          standaloneChats: [],
          chatProjects: [],
        }),
      );
      const archiveWorktree = jest.fn((): Promise<void> => Promise.resolve());
      useProjectsStore.setState({
        archiveWorktree,
        projects: [
          {
            id: 'code-1',
            name: 'Code',
            type: 'single-repo',
            repoPath: '/code',
            color: '#123456',
            collapsed: false,
            order: 0,
            worktrees: [
              {
                id: 'wt-1',
                branchName: 'feature',
                createdAt: '2026-01-01T00:00:00Z',
              },
            ],
          },
        ],
      });
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await act(async (): Promise<void> => {
          root.render(
            <CanopyClientProvider client={createFakeClient().client}>
              <DesktopSharedSidebarHost />
            </CanopyClientProvider>,
          );
          await Promise.resolve();
        });
        act((): void => {
          requestWorktreeArchiveConfirmation({
            projectId: 'code-1',
            worktreeId: 'wt-1',
            requestedDeleteBranch,
            lockAfterArchive: true,
          });
        });
        const dialog = document.querySelector('[role="dialog"]');
        expect(dialog?.textContent).toContain('Archive worktree “feature”?');
        expect(dialog?.textContent).toContain(
          `${ORCHESTRATOR_LABEL} suggested ${hint}.`,
        );
        expect(
          document
            .querySelector('[data-testid="worktree-removal-keep-branch"]')
            ?.getAttribute('aria-checked'),
        ).toBe(String(!requestedDeleteBranch));
        // One action, named for what it will do with the branch. Archive keeps
        // the work, so it is the primary action rather than destructive.
        const action = document.querySelector(
          `[data-testid="${requestedTestId}"]`,
        );
        expect(action?.firstChild?.textContent).toBe('Archive worktree');
        // Archive keeps the work, so it is the Enter default.
        expect(
          action?.querySelector('[data-testid="kbd-chip"]'),
        ).toBeInstanceOf(Element);
        expect(action?.className.split(/\s+/)).toContain('bg-accent');
        expect(archiveWorktree).not.toHaveBeenCalled();
      } finally {
        act((): void => root.unmount());
        container.remove();
        useProjectsStore.setState(projectsBefore);
        query.mockRestore();
      }
    },
  );

  // CAN-3053 follow-up: the published live-keys store is a module-level
  // singleton outliving this component, so an account/session switch —
  // which remounts the sidebar host — must not let the new mount's first
  // render see the PREVIOUS session's last-published keys.
  it('resets the published row live-keys store on unmount', async () => {
    // A dedicated local root: the outer `afterEach` also unmounts the shared
    // one, and this test needs to unmount mid-test to observe the reset.
    const localContainer = document.createElement('div');
    document.body.appendChild(localContainer);
    const localRoot = createRoot(localContainer);
    const staleKeys: DesktopWorktreeRowLiveKeys = {
      statusByKey: new Map([['stale-project/stale-worktree', 'working']]),
      streaming: new Set(['stale-project/stale-worktree']),
      awaitingApproval: new Set(),
      pendingQuestion: new Set(),
      toolApproval: new Set(),
      unread: new Set(),
      pipelineRunning: new Set(),
      pipelineUnseen: new Set(),
      pipelineUnseenFailed: new Set(),
      pipelinePaused: new Set(),
      backgroundTasks: new Map(),
    };
    setDesktopRowLiveKeys(staleKeys);
    expect(useDesktopRowLiveKeysStore.getState().keys).toBe(staleKeys);

    await act(async () => {
      localRoot.render(
        <CanopyClientProvider client={createFakeClient().client}>
          <DesktopSharedSidebarHost />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
    // The freshly-mounted host has already published its own key set (empty,
    // since this fixture has no projects), replacing the stale one.
    expect(useDesktopRowLiveKeysStore.getState().keys).not.toBe(staleKeys);
    expect(useDesktopRowLiveKeysStore.getState().keys).not.toBeNull();

    act(() => localRoot.unmount());
    expect(useDesktopRowLiveKeysStore.getState().keys).toBeNull();
    localContainer.remove();
  });

  // CAN-3053 attempt-2: `getPipelinePopoverEntries` fed a fresh `?? []` on
  // every call for a worktree with no runs into `SidebarPipelineStatusPopover`,
  // which uses it as a `useSyncExternalStore` snapshot getter — an unstable
  // reference there reads as "changed" on every render, which can drive React
  // into "Maximum update depth exceeded". The fix returns the SAME empty-array
  // reference across calls; assert exactly that reference stability, which is
  // what `useSyncExternalStore`'s snapshot comparison actually relies on.
  it('returns the same empty-array reference from getPipelinePopoverEntries for a worktree with no runs', async () => {
    const localContainer = document.createElement('div');
    document.body.appendChild(localContainer);
    const localRoot = createRoot(localContainer);
    try {
      await act(async () => {
        localRoot.render(
          <CanopyClientProvider client={createFakeClient().client}>
            <DesktopSharedSidebarHost />
          </CanopyClientProvider>,
        );
        await Promise.resolve();
      });
      const props = capturedProps.at(-1);
      expect(props?.getPipelinePopoverEntries).toBeDefined();
      const first = props?.getPipelinePopoverEntries?.(
        'no-runs-wt',
        'no-runs-ws',
      );
      const second = props?.getPipelinePopoverEntries?.(
        'no-runs-wt',
        'no-runs-ws',
      );
      expect(first).toEqual([]);
      expect(first).toBe(second);
    } finally {
      act(() => localRoot.unmount());
      localContainer.remove();
    }
  });
});

/**
 * CAN-3053: the shared rail's worktree menu lost entries the legacy row had.
 * The host restores them through the surface's seams, so these pin the
 * desktop side of each seam: Split project, desktop's own dispatch dialog,
 * and Split PR's live eligibility and blockers.
 */
describe('DesktopSharedSidebarHost worktree menu parity', () => {
  const noopIcon = <span />;
  const sharedItems = [
    { key: 'branch-info', label: 'Branch info', icon: noopIcon },
    { key: 'add-repository', label: 'Add repository', icon: noopIcon },
    {
      key: 'toggle-hidden',
      label: 'Hide',
      icon: noopIcon,
      separatorBefore: true,
    },
    { key: 'archive', label: 'Archive', icon: noopIcon },
  ] as const;

  async function mountWithProjects(
    projects: SidebarItem[],
    snapshot: {
      readonly workspaces: ReadonlyArray<{
        localId: string;
        name: string;
        type: 'single-repo' | 'multi-repo';
      }>;
      readonly worktrees: ReadonlyArray<{
        localId: string;
        workspaceLocalId: string;
        branch: string;
      }>;
    },
  ): Promise<() => void> {
    const projectsBefore = useProjectsStore.getState();
    const query = jest.spyOn(ipcCanopyClient, 'query').mockResolvedValue(
      makeSessionSnapshot({
        workspaces: [...snapshot.workspaces],
        worktrees: [...snapshot.worktrees],
        standaloneChats: [],
        chatProjects: [],
      }),
    );
    useProjectsStore.setState({ projects });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async (): Promise<void> => {
      root.render(
        <CanopyClientProvider client={createFakeClient().client}>
          <DesktopSharedSidebarHost />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
    return (): void => {
      act((): void => root.unmount());
      container.remove();
      useProjectsStore.setState(projectsBefore);
      query.mockRestore();
    };
  }

  function rowContext(
    workspaceLocalId: string,
    worktreeLocalId: string,
  ): Parameters<
    NonNullable<SidebarSurfaceProps['transformWorktreeMenuItems']>
  >[0] {
    return {
      workspace: {
        localId: workspaceLocalId,
        name: workspaceLocalId,
        type: 'single-repo',
      },
      worktree: {
        localId: worktreeLocalId,
        workspaceLocalId,
        branch: worktreeLocalId,
      },
      selected: false,
      hidden: false,
      sortable: false,
      worktreeRemoval: 'archive',
    };
  }

  it('adds Split project after Add repository on a temporary multi-repo worktree only', async (): Promise<void> => {
    const cleanup = await mountWithProjects(
      [
        {
          id: 'temp-1',
          name: 'Temp',
          type: 'multi-repo',
          temporary: true,
          repos: [],
          color: '#123456',
          collapsed: false,
          order: 0,
          worktrees: [
            { id: 'wt-1', branchName: 'combo', createdAt: '2026-01-01' },
          ],
        },
        {
          id: 'code-1',
          name: 'Code',
          type: 'single-repo',
          repoPath: '/code',
          color: '#654321',
          collapsed: false,
          order: 1,
          worktrees: [
            { id: 'wt-2', branchName: 'feature', createdAt: '2026-01-01' },
          ],
        },
      ],
      {
        workspaces: [
          { localId: 'temp-1', name: 'Temp', type: 'multi-repo' },
          { localId: 'code-1', name: 'Code', type: 'single-repo' },
        ],
        worktrees: [
          { localId: 'wt-1', workspaceLocalId: 'temp-1', branch: 'combo' },
          { localId: 'wt-2', workspaceLocalId: 'code-1', branch: 'feature' },
        ],
      },
    );
    try {
      const transform = capturedProps.at(-1)?.transformWorktreeMenuItems;
      expect(transform).toBeDefined();
      const temporary = transform?.(rowContext('temp-1', 'wt-1'), sharedItems);
      expect(temporary?.map((item) => item.key)).toEqual([
        'branch-info',
        'add-repository',
        'split-workspace',
        'toggle-hidden',
        'archive',
      ]);
      const split = temporary?.find((item) => item.key === 'split-workspace');
      expect(split).toMatchObject({
        label: 'Split project',
        disabled: false,
        testId: 'worktree-actions-menu-split-workspace',
      });
      act((): void => split?.onSelect?.());
      expect(useNavigationStore.getState().pendingSplitWorkspace).toEqual({
        projectId: 'temp-1',
        worktreeId: 'wt-1',
      });
      expect(
        transform?.(rowContext('code-1', 'wt-2'), sharedItems).map(
          (item) => item.key,
        ),
      ).not.toContain('split-workspace');
    } finally {
      useNavigationStore.getState().consumeSplitWorkspaceRequest();
      cleanup();
    }
  });

  it('composes the Split project insertion with the non-store row filter in one transform', async (): Promise<void> => {
    // CAN-3053 and the cloud-row filtering fix (#4092) each add their own
    // `transformWorktreeMenuItems` JSX prop on the same `SidebarSurface`
    // element. JSX silently keeps only the last duplicate prop, so a naive
    // merge of both PRs drops Split project without a build error. This pins
    // that both behaviors survive as ONE composed transform: a temporary
    // multi-repo store row still gets Split project after Add repository,
    // and a row the store does not hold (a cloud row) is still filtered down
    // to the non-store allowlist.
    const cleanup = await mountWithProjects(
      [
        {
          id: 'temp-1',
          name: 'Temp',
          type: 'multi-repo',
          temporary: true,
          repos: [],
          color: '#123456',
          collapsed: false,
          order: 0,
          worktrees: [
            { id: 'wt-1', branchName: 'combo', createdAt: '2026-01-01' },
          ],
        },
      ],
      {
        workspaces: [{ localId: 'temp-1', name: 'Temp', type: 'multi-repo' }],
        worktrees: [
          { localId: 'wt-1', workspaceLocalId: 'temp-1', branch: 'combo' },
          // Not in the store project's `worktrees` array above: a cloud
          // session projected into the rail, not a store-backed row.
          {
            localId: 'cloud-session',
            workspaceLocalId: 'temp-1',
            branch: 'cloud',
          },
        ],
      },
    );
    try {
      const transform = capturedProps.at(-1)?.transformWorktreeMenuItems;
      expect(transform).toBeDefined();

      const storeRow = transform?.(rowContext('temp-1', 'wt-1'), sharedItems);
      expect(storeRow?.map((item) => item.key)).toEqual([
        'branch-info',
        'add-repository',
        'split-workspace',
        'toggle-hidden',
        'archive',
      ]);

      const nonStoreRow = transform?.(
        rowContext('temp-1', 'cloud-session'),
        sharedItems,
      );
      expect(nonStoreRow?.map((item) => item.key)).toEqual(['branch-info']);
    } finally {
      useNavigationStore.getState().consumeSplitWorkspaceRequest();
      cleanup();
    }
  });

  it('names the retention window, opens desktop dispatch dialog, and derives Split PR from the live PR status', async (): Promise<void> => {
    const githubBefore = useGitHubStore.getState();
    const splitPrBefore = useSplitPrPreferencesStore.getState();
    useSplitPrPreferencesStore.setState({
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
      hasLoaded: true,
    });
    const cleanup = await mountWithProjects(
      [
        {
          id: 'code-1',
          name: 'Code',
          type: 'single-repo',
          repoPath: '/code',
          color: '#654321',
          collapsed: false,
          order: 0,
          worktrees: [
            { id: 'wt-2', branchName: 'feature', createdAt: '2026-01-01' },
          ],
        },
      ],
      {
        workspaces: [{ localId: 'code-1', name: 'Code', type: 'single-repo' }],
        worktrees: [
          { localId: 'wt-2', workspaceLocalId: 'code-1', branch: 'feature' },
        ],
      },
    );
    try {
      const props = capturedProps.at(-1);
      // Delete's tooltip names the project's retention window.
      expect(props?.worktreeRetentionDaysFor?.('code-1')).toBe(
        resolveArchiveRetentionDays('single-repo', undefined),
      );
      act((): void => props?.onDispatchPipelineRequested?.('code-1', 'wt-2'));
      expect(useNavigationStore.getState().pendingDispatchPipeline).toEqual({
        projectId: 'code-1',
        worktreeId: 'wt-2',
      });

      await act(async (): Promise<void> => {
        useGitHubStore.setState({
          prStatuses: {
            'code-1/wt-2': {
              lastCheckedAt: '2026-01-01T00:00:00Z',
              repos: [
                {
                  repoId: 'code-1',
                  repoName: 'repo',
                  status: {
                    prNumber: 826,
                    prUrl: 'https://example.test/pr/826',
                    state: 'open',
                    title: 'Big change',
                    checkStatus: 'none',
                    checkDetails: [],
                    reviewStatus: 'none',
                    reviewers: [],
                    hasConflicts: true,
                    commentCount: 0,
                    updatedAt: '2026-01-01T00:00:00Z',
                    additions: 400,
                    deletions: 200,
                  },
                },
              ],
            },
          },
        });
        await Promise.resolve();
      });
      const latest = capturedProps.at(-1);
      expect(
        latest?.getSplitPrEligibilityInputs?.('code-1', 'wt-2'),
      ).toMatchObject({ prState: 'open', prAdditions: 400, prDeletions: 200 });
      expect(latest?.getSplitPrBlockers?.('code-1', 'wt-2')).toContain(
        SPLIT_PR_BLOCKER_COPY.merge_conflicts,
      );
    } finally {
      useNavigationStore.getState().consumeDispatchPipelineRequest();
      useGitHubStore.setState(githubBefore);
      useSplitPrPreferencesStore.setState(splitPrBefore);
      cleanup();
    }
  });
});

describe('DesktopSharedSidebarHost move to organization', () => {
  const ACME = { id: 'org-acme', name: 'Acme', role: 'MEMBER' as const };
  let container: HTMLElement;
  let root: Root;
  const contextBefore = useWorkspaceContextStore.getState();
  const projectsBefore = useProjectsStore.getState();
  const flagsBefore = useFeatureFlagsStore.getState();

  beforeEach(() => {
    capturedProps.length = 0;
    // An earlier suite's spy restore can leave the shared query mock empty.
    jest.mocked(ipcCanopyClient).query.mockResolvedValue(
      makeSessionSnapshot({
        workspaces: [],
        standaloneChats: [],
      }),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const defaults = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...defaults,
        values: {
          ...defaults.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
        status: 'ready',
        initialized: true,
      },
    });
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'personal-code',
          name: 'Personal code',
          repoPath: '/repo',
          color: '#000000',
          collapsed: false,
          order: 0,
          worktrees: [],
        },
        {
          type: 'single-repo',
          id: 'owned-code',
          name: 'Owned code',
          repoPath: '/owned',
          color: '#000000',
          collapsed: false,
          order: 1,
          worktrees: [],
          owner: {
            type: 'organization',
            organizationId: ACME.id,
            projectId: 'p',
            instanceId: 'i',
            bindingGeneration: 0,
          },
        },
        {
          type: 'cowork',
          id: 'personal-cowork',
          name: 'Personal cowork',
          color: '#000000',
          collapsed: false,
          order: 2,
        },
      ],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useWorkspaceContextStore.setState(contextBefore);
    useProjectsStore.setState(projectsBefore, true);
    useFeatureFlagsStore.setState(flagsBefore);
    useMoveToOrganizationModalStore.setState({
      target: null,
      busy: false,
      error: null,
    });
  });

  async function renderHost(
    context:
      | { kind: 'personal' }
      | { kind: 'organization'; organizationId: string },
    organizations: readonly (typeof ACME)[],
  ): Promise<SidebarSurfaceProps | undefined> {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: { context, organizations, revision: 1 },
    });
    await act(async () => {
      root.render(
        <CanopyClientProvider client={createFakeClient().client}>
          <DesktopSharedSidebarHost />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
    return capturedProps.at(-1);
  }

  function renderHeaderMenu(
    props: SidebarSurfaceProps | undefined,
    workspaceId: string,
  ): HTMLElement {
    const menu = document.createElement('div');
    document.body.appendChild(menu);
    const menuRoot = createRoot(menu);
    act(() => {
      menuRoot.render(
        <>
          {props?.renderWorkspaceContextMenuItems?.({
            workspace: {
              localId: workspaceId,
              name: workspaceId,
              type: 'single-repo',
            },
            close: () => undefined,
          })}
        </>,
      );
    });
    return menu;
  }

  it('offers Move from Personal with an organization, for Personal projects only', async () => {
    const props = await renderHost({ kind: 'personal' }, [ACME]);
    expect(props?.capabilities.workspaceMoveToOrganization).toBe(true);
    expect(
      props?.isWorkspaceMoveToOrganizationAvailable?.('personal-code'),
    ).toBe(true);
    expect(props?.isWorkspaceMoveToOrganizationAvailable?.('owned-code')).toBe(
      false,
    );

    const menu = renderHeaderMenu(props, 'personal-code');
    const item = menu.querySelector<HTMLElement>(
      '[data-testid="workspace-move-to-organization-menu-item"]',
    );
    expect(item?.textContent).toContain('Move to org…');
    act(() => item?.click());
    expect(useMoveToOrganizationModalStore.getState().target).toEqual({
      workspaceId: 'personal-code',
    });
    menu.remove();

    const ownedMenu = renderHeaderMenu(props, 'owned-code');
    expect(
      ownedMenu.querySelector(
        '[data-testid="workspace-move-to-organization-menu-item"]',
      ),
    ).toBeNull();
    ownedMenu.remove();
  });

  it('starts a fresh pick when the dialog is reopened for another project', async () => {
    const BETA = { id: 'org-beta', name: 'Beta', role: 'MEMBER' as const };
    await renderHost({ kind: 'personal' }, [ACME, BETA]);
    act(() => {
      openMoveToOrganizationModal('personal-code');
    });
    const select = (): HTMLButtonElement =>
      settingsSelectTrigger(
        document,
        '[data-testid="move-project-to-organization-select"]',
      );
    expect(settingsSelectValue(select())).toBe('');
    expect(
      useCurrentUiStateStore.getState().slices['moveToOrganization.modal'],
    ).toEqual({ open: true, workspaceId: 'personal-code', busy: false });
    chooseSettingsOptionSync(select(), ACME.id);
    expect(settingsSelectValue(select())).toBe(ACME.id);

    act(() => {
      openMoveToOrganizationModal('personal-cowork');
    });
    expect(settingsSelectValue(select())).toBe('');
  });

  it('hands the Cowork row the open handler only for a movable project', async () => {
    const props = await renderHost({ kind: 'personal' }, [ACME]);
    const coworkSlot = (workspaceId: string): HTMLElement => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const slotRoot = createRoot(host);
      act(() => {
        slotRoot.render(
          <>
            {props?.renderCoworkWorkspace?.({
              workspace: {
                localId: workspaceId,
                name: workspaceId,
                type: 'cowork',
              },
              selected: false,
              hidden: false,
              sortable: false,
              collapsed: false,
              index: 0,
              hasFollowingWorkspace: false,
            })}
          </>,
        );
      });
      return host;
    };
    const slot = coworkSlot('personal-cowork');
    expect(
      slot
        .querySelector('[data-testid="mock-chats-rows"]')
        ?.getAttribute('data-offers-move'),
    ).toBe('true');
    slot.remove();
  });

  it.each([
    [
      'an organization context',
      { kind: 'organization' as const, organizationId: ACME.id },
      [ACME],
    ],
    ['Personal with no organizations', { kind: 'personal' as const }, []],
  ])('offers no Move in %s', async (_name, context, organizations) => {
    const props = await renderHost(context, organizations);
    expect(props?.capabilities.workspaceMoveToOrganization).toBe(false);
    expect(
      props?.isWorkspaceMoveToOrganizationAvailable?.('personal-code'),
    ).toBe(false);
    const menu = renderHeaderMenu(props, 'personal-code');
    expect(
      menu.querySelector(
        '[data-testid="workspace-move-to-organization-menu-item"]',
      ),
    ).toBeNull();
    menu.remove();
  });
});

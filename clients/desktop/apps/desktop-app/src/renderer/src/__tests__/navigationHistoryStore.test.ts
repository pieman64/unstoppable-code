import type * as Zustand from 'zustand';
import type { WorktreeSelection } from '@canopy/desktop-shared/types';
import type { isCoworkChatTarget } from '@/lib/cowork';
import type { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
} from '@/test-utils/labsExperiments';

interface MockChatState {
  selectedWorktree: WorktreeSelection | null;
  selectWorktree: (projectId: string, worktreeId: string) => void;
  deselectWorktree: () => void;
}

jest.mock('@/stores/chatStore', () => {
  const { create } = jest.requireActual<typeof Zustand>('zustand');
  const useChatStore = create<MockChatState>((set) => ({
    selectedWorktree: null,
    selectWorktree: (projectId: string, worktreeId: string): void => {
      set({ selectedWorktree: { projectId, worktreeId } });
    },
    deselectWorktree: (): void => {
      set({ selectedWorktree: null });
    },
  }));
  return { useChatStore };
});

interface MockSharedContainerState {
  viewer: { containerId: string; organizationId: string } | null;
  entries: Array<{
    organizationId: string;
    container: { id: string };
  }>;
  listStatus: 'success';
  openContainer: (target: {
    containerId: string;
    organizationId: string;
  }) => Promise<void>;
  closeViewer: () => void;
}

jest.mock('@/stores/sharedContainerReplicasStore', () => {
  const { create } = jest.requireActual<typeof Zustand>('zustand');
  const useSharedContainerReplicasStore = create<MockSharedContainerState>(
    (set) => ({
      viewer: null,
      entries: [
        {
          organizationId: 'org-1',
          container: { id: 'shared-1' },
        },
      ],
      listStatus: 'success',
      openContainer: (target): Promise<void> => {
        set({ viewer: target });
        return Promise.resolve();
      },
      closeViewer: (): void => set({ viewer: null }),
    }),
  );
  return { useSharedContainerReplicasStore };
});

interface MockProjectsState {
  projects: unknown[];
  hasHydratedProjects: boolean;
}

jest.mock('@/stores/projectsStore', () => {
  const { create } = jest.requireActual<typeof Zustand>('zustand');
  const useProjectsStore = create<MockProjectsState>(() => ({
    projects: [],
    hasHydratedProjects: true,
  }));
  return { useProjectsStore };
});

const canNavigateMock = jest.fn<
  boolean,
  Parameters<typeof canNavigateToWorktreeFromSidebarItems>
>((): boolean => true);
jest.mock('@/lib/worktreeNavigation', () => ({
  canNavigateToWorktreeFromSidebarItems: (
    ...args: Parameters<typeof canNavigateToWorktreeFromSidebarItems>
  ): boolean => canNavigateMock(...args),
}));

const isCoworkMock = jest.fn<boolean, Parameters<typeof isCoworkChatTarget>>(
  (): boolean => false,
);
jest.mock('@/lib/cowork', () => ({
  isCoworkChatTarget: (projectId: string): boolean => isCoworkMock(projectId),
}));

import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useChatStore } from '@/stores/chatStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import {
  registerNavigationGuard,
  useNavigationStore,
} from '../stores/navigationStore';
import {
  initNavigationHistoryTracking,
  NAVIGATION_HISTORY_MAX_ENTRIES,
  useNavigationHistoryStore,
} from '../stores/navigationHistoryStore';

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function setWorkersPageEnabled(enabled: boolean): void {
  const base = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.getState().setSnapshot({
    ...base,
    values: {
      ...base.values,
      [CLIENT_FEATURE_FLAGS.canopyDesktopClaudeTuiWorkers.key]: enabled,
    },
    status: 'ready',
    initialized: true,
  });
}

describe('navigationHistoryStore', () => {
  let dispose: () => void;

  beforeEach(() => {
    canNavigateMock.mockReturnValue(true);
    isCoworkMock.mockReturnValue(false);
    applyLabsExperimentsSnapshot(
      makeTestLabsSnapshot({ revision: 0, experiments: pageExperimentsOn() }),
    );
    useNavigationStore.setState({
      activePage: 'overview',
      workflowEdit: undefined,
      pendingPluginsNavigation: undefined,
      pluginsPresentation: undefined,
    });
    useNavigationStore.getState().setPluginsBrowseSectionId(null);
    useChatStore.setState({ selectedWorktree: null });
    useSharedContainerReplicasStore.setState({ viewer: null });
    dispose = initNavigationHistoryTracking();
  });

  afterEach(async () => {
    dispose();
    await flush();
    resetLabsExperimentsStoreForTest();
  });

  it('normalizes a legacy Agents history location before checking page availability', async () => {
    const legacy = {
      page: 'home' as const,
      worktree: null,
      archivedContainer: null,
    };
    Object.defineProperty(legacy, 'page', {
      value: 'agents',
      enumerable: true,
    });
    useNavigationHistoryStore.setState({
      entries: [
        legacy,
        { page: 'home', worktree: null, archivedContainer: null },
      ],
      index: 1,
      canGoBack: true,
    });
    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    await flush();
    expect(useNavigationStore.getState().activePage).toBe('plugins');
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'marketplace-browse',
      query: '',
      tab: 'agent',
    });
    expect(
      useNavigationHistoryStore
        .getState()
        .entries.some((entry) => String(entry.page) === 'agents'),
    ).toBe(false);
    useNavigationStore.getState().consumePluginsNavigation();
    expect(useNavigationHistoryStore.getState().goForward()).toBe(true);
    await flush();
    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    await flush();
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'marketplace-browse',
      query: '',
      tab: 'agent',
    });
  });

  it('seeds the current location and starts with no history', () => {
    const state = useNavigationHistoryStore.getState();
    expect(state.entries).toEqual([
      { page: 'overview', worktree: null, archivedContainer: null },
    ]);
    expect(state.canGoBack).toBe(false);
    expect(state.canGoForward).toBe(false);
  });

  it('can replace the initial entry with the final restored location', () => {
    useNavigationStore.setState({ activePage: 'main' });
    useChatStore.getState().selectWorktree('proj-1', 'wt-1');

    expect(useNavigationHistoryStore.getState().replaceInitialLocation()).toBe(
      true,
    );

    expect(useNavigationHistoryStore.getState()).toMatchObject({
      entries: [
        {
          page: 'main',
          worktree: { projectId: 'proj-1', worktreeId: 'wt-1' },
          archivedContainer: null,
        },
      ],
      index: 0,
      canGoBack: false,
      canGoForward: false,
    });
  });

  it('preserves real navigation when replacing the startup location', async () => {
    useNavigationStore.getState().navigate('workflows-library');
    await flush();
    useNavigationStore.getState().navigate('main');
    useChatStore.getState().selectWorktree('proj-1', 'wt-1');

    expect(useNavigationHistoryStore.getState().replaceInitialLocation()).toBe(
      false,
    );
    expect(useNavigationHistoryStore.getState().entries).toEqual([
      { page: 'overview', worktree: null, archivedContainer: null },
      { page: 'workflows-library', worktree: null, archivedContainer: null },
    ]);

    await flush();
    expect(useNavigationHistoryStore.getState().entries).toEqual([
      { page: 'overview', worktree: null, archivedContainer: null },
      { page: 'workflows-library', worktree: null, archivedContainer: null },
      {
        page: 'main',
        worktree: { projectId: 'proj-1', worktreeId: 'wt-1' },
        archivedContainer: null,
      },
    ]);
  });

  it('records the tab a legacy Workflows id became, never the legacy id (CAN-3981)', async () => {
    useNavigationStore.getState().navigate('watchers');
    await flush();
    useNavigationStore.getState().navigate('automations');
    await flush();

    const pages = useNavigationHistoryStore
      .getState()
      .entries.map((entry) => entry.page);
    expect(pages).toEqual(['overview', 'workflows', 'workflows-library']);

    // Back from a redirected legacy id lands on the tab that was open.
    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    expect(useNavigationStore.getState().activePage).toBe('workflows');
  });

  it('records page navigations and walks back/forward through them', async () => {
    useNavigationStore.getState().navigate('workflows-library');
    await flush();
    useNavigationStore.getState().navigate('plugins');
    await flush();

    const state = useNavigationHistoryStore.getState();
    expect(state.entries.map((e) => e.page)).toEqual([
      'overview',
      'workflows-library',
      'plugins',
    ]);
    expect(state.canGoBack).toBe(true);

    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    await flush();
    expect(useNavigationHistoryStore.getState().canGoForward).toBe(true);

    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    expect(useNavigationStore.getState().activePage).toBe('overview');
    await flush();
    expect(useNavigationHistoryStore.getState().canGoBack).toBe(false);
    expect(useNavigationHistoryStore.getState().goBack()).toBe(false);

    expect(useNavigationHistoryStore.getState().goForward()).toBe(true);
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    await flush();
    // Walking through history must not have grown the stack.
    expect(useNavigationHistoryStore.getState().entries).toHaveLength(3);
  });

  it('returns from a Marketplace category to the Marketplace overview before the previous page', async () => {
    useNavigationStore.getState().navigate('plugins');
    await flush();
    useNavigationStore
      .getState()
      .setPluginsBrowseSectionId('category-developer-tools');
    await flush();

    expect(useNavigationHistoryStore.getState().entries).toEqual([
      { page: 'overview', worktree: null, archivedContainer: null },
      { page: 'plugins', worktree: null, archivedContainer: null },
      {
        page: 'plugins',
        worktree: null,
        archivedContainer: null,
        pluginsBrowseSectionId: 'category-developer-tools',
      },
    ]);

    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    expect(useNavigationStore.getState().activePage).toBe('plugins');
    expect(useNavigationStore.getState().pluginsBrowseSectionId).toBeNull();
    await flush();

    expect(useNavigationHistoryStore.getState().goForward()).toBe(true);
    expect(useNavigationStore.getState().activePage).toBe('plugins');
    expect(useNavigationStore.getState().pluginsBrowseSectionId).toBe(
      'category-developer-tools',
    );
  });

  it('coalesces a page change plus worktree selection into one entry', async () => {
    useNavigationStore.getState().navigate('main');
    useChatStore.getState().selectWorktree('proj-1', 'wt-1');
    await flush();

    const state = useNavigationHistoryStore.getState();
    expect(state.entries).toEqual([
      { page: 'overview', worktree: null, archivedContainer: null },
      {
        page: 'main',
        worktree: { projectId: 'proj-1', worktreeId: 'wt-1' },
        archivedContainer: null,
      },
    ]);
  });

  it('treats worktree switches on the main page as history steps', async () => {
    useNavigationStore.getState().navigate('main');
    useChatStore.getState().selectWorktree('proj-1', 'wt-1');
    await flush();
    useChatStore.getState().selectWorktree('proj-1', 'wt-2');
    await flush();

    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    expect(useChatStore.getState().selectedWorktree).toEqual({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
    });
    expect(useNavigationStore.getState().activePage).toBe('main');
  });

  it('records recipient surfaces and restores them through back and forward', async () => {
    useNavigationStore.getState().navigate('main');
    await flush();
    await useSharedContainerReplicasStore.getState().openContainer({
      containerId: 'shared-1',
      organizationId: 'org-1',
    });
    await flush();

    const historyEntries = useNavigationHistoryStore.getState().entries;
    expect(historyEntries[historyEntries.length - 1]?.sharedContainer).toEqual({
      containerId: 'shared-1',
      organizationId: 'org-1',
    });

    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    expect(useSharedContainerReplicasStore.getState().viewer).toBeNull();
    await flush();

    expect(useNavigationHistoryStore.getState().goForward()).toBe(true);
    await flush();
    expect(useSharedContainerReplicasStore.getState().viewer).toEqual({
      containerId: 'shared-1',
      organizationId: 'org-1',
    });
  });

  it('captures a recipient surface from one store snapshot', () => {
    useNavigationStore.setState({ activePage: 'main' });
    const sharedState = useSharedContainerReplicasStore.getState();
    const getState = jest
      .spyOn(useSharedContainerReplicasStore, 'getState')
      .mockReturnValueOnce({
        ...sharedState,
        viewer: {
          containerId: 'shared-1',
          organizationId: 'org-1',
          replica: null,
          openError: null,
          loading: false,
        },
      })
      .mockReturnValueOnce({
        ...sharedState,
        viewer: {
          containerId: 'shared-2',
          organizationId: 'org-2',
          replica: null,
          openError: null,
          loading: false,
        },
      });

    expect(useNavigationHistoryStore.getState().replaceInitialLocation()).toBe(
      true,
    );
    expect(
      useNavigationHistoryStore.getState().entries[0]?.sharedContainer,
    ).toEqual({
      containerId: 'shared-1',
      organizationId: 'org-1',
    });

    getState.mockRestore();
  });

  it('ignores worktree selection changes while on non-worktree pages', async () => {
    useNavigationStore.getState().navigate('workflows-library');
    await flush();
    useChatStore.getState().selectWorktree('proj-1', 'wt-1');
    await flush();

    expect(useNavigationHistoryStore.getState().entries).toEqual([
      { page: 'overview', worktree: null, archivedContainer: null },
      { page: 'workflows-library', worktree: null, archivedContainer: null },
    ]);
  });

  it('normalizes cowork chat targets out of recorded locations', async () => {
    isCoworkMock.mockImplementation(
      (projectId: string): boolean => projectId === 'cowork-1',
    );
    useNavigationStore.getState().navigate('main');
    useChatStore.getState().selectWorktree('cowork-1', 'home');
    await flush();

    expect(useNavigationHistoryStore.getState().entries).toEqual([
      { page: 'overview', worktree: null, archivedContainer: null },
      { page: 'main', worktree: null, archivedContainer: null },
    ]);
  });

  it('truncates the forward branch when navigating after going back', async () => {
    useNavigationStore.getState().navigate('workflows-library');
    await flush();
    useNavigationStore.getState().navigate('plugins');
    await flush();
    useNavigationHistoryStore.getState().goBack();
    await flush();

    useNavigationStore.getState().navigate('usage');
    await flush();

    const state = useNavigationHistoryStore.getState();
    expect(state.entries.map((e) => e.page)).toEqual([
      'overview',
      'workflows-library',
      'usage',
    ]);
    expect(state.canGoForward).toBe(false);
  });

  it('prunes entries whose worktree no longer exists when stepping back', async () => {
    useNavigationStore.getState().navigate('main');
    useChatStore.getState().selectWorktree('proj-1', 'wt-gone');
    await flush();
    useNavigationStore.getState().navigate('workflows-library');
    await flush();

    canNavigateMock.mockReturnValue(false);
    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    // The dead worktree entry is skipped and removed; we land on overview.
    expect(useNavigationStore.getState().activePage).toBe('overview');
    await flush();
    expect(
      useNavigationHistoryStore
        .getState()
        .entries.some((e) => e.worktree?.worktreeId === 'wt-gone'),
    ).toBe(false);
  });

  describe('pages switched off since they were recorded (CAN-3661)', () => {
    beforeEach(() => {
      setWorkersPageEnabled(true);
    });

    afterEach(() => {
      useFeatureFlagsStore
        .getState()
        .setSnapshot(getDefaultFeatureFlagSnapshot());
    });

    const pagesOf = (): string[] =>
      useNavigationHistoryStore.getState().entries.map((entry) => entry.page);

    it('skips the entry going back, without a fallback entry or a loop', async () => {
      const navigation = useNavigationStore.getState();
      navigation.navigate('workers');
      await flush();
      navigation.navigate('workflows-library');
      await flush();
      expect(pagesOf()).toEqual(['overview', 'workers', 'workflows-library']);

      setWorkersPageEnabled(false);
      expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
      await flush();

      expect(useNavigationStore.getState().activePage).toBe('overview');
      expect(pagesOf()).toEqual(['overview', 'workflows-library']);
      const state = useNavigationHistoryStore.getState();
      expect(state.index).toBe(0);
      expect(state.canGoBack).toBe(false);
      expect(state.canGoForward).toBe(true);
      expect(state.goBack()).toBe(false);

      // The rest of the history is still usable.
      expect(useNavigationHistoryStore.getState().goForward()).toBe(true);
      await flush();
      expect(useNavigationStore.getState().activePage).toBe(
        'workflows-library',
      );
      expect(pagesOf()).toEqual(['overview', 'workflows-library']);
    });

    it('skips the entry going forward and keeps the entries after it', async () => {
      const navigation = useNavigationStore.getState();
      navigation.navigate('workers');
      await flush();
      navigation.navigate('workflows-library');
      await flush();
      useNavigationHistoryStore.getState().goBack();
      await flush();
      useNavigationHistoryStore.getState().goBack();
      await flush();
      expect(useNavigationStore.getState().activePage).toBe('overview');

      setWorkersPageEnabled(false);
      expect(useNavigationHistoryStore.getState().goForward()).toBe(true);
      await flush();

      expect(useNavigationStore.getState().activePage).toBe(
        'workflows-library',
      );
      expect(pagesOf()).toEqual(['overview', 'workflows-library']);
      const state = useNavigationHistoryStore.getState();
      expect(state.index).toBe(1);
      expect(state.canGoBack).toBe(true);
      expect(state.canGoForward).toBe(false);
      expect(state.goForward()).toBe(false);
    });

    it('reports no move when the only other entry is switched off', async () => {
      useNavigationStore.getState().navigate('workers');
      await flush();
      useNavigationHistoryStore.getState().goBack();
      await flush();

      setWorkersPageEnabled(false);
      expect(useNavigationHistoryStore.getState().goForward()).toBe(false);
      await flush();

      expect(useNavigationStore.getState().activePage).toBe('overview');
      expect(pagesOf()).toEqual(['overview']);
      expect(useNavigationHistoryStore.getState().canGoForward).toBe(false);
    });
  });

  it('caps retained history at the configured maximum', async () => {
    const pages = ['workflows-library', 'plugins'] as const;
    for (let i = 0; i < NAVIGATION_HISTORY_MAX_ENTRIES + 10; i += 1) {
      useNavigationStore.getState().navigate(pages[i % 2]);
      await flush();
    }

    const state = useNavigationHistoryStore.getState();
    expect(state.entries.length).toBeLessThanOrEqual(
      NAVIGATION_HISTORY_MAX_ENTRIES,
    );
    expect(state.index).toBe(state.entries.length - 1);
  });
  describe('the Workflows edit shell and the navigation guard (CAN-4072)', () => {
    let clearGuard: (() => void) | undefined;
    const automation = { kind: 'automation', activityId: 'act-1' } as const;
    const pipeline = { kind: 'pipeline', pipelineId: 'deploy' } as const;

    afterEach(() => {
      clearGuard?.();
      clearGuard = undefined;
    });

    const recordLibraryThenShell = async (): Promise<void> => {
      useNavigationStore.getState().navigate('workflows-library');
      await flush();
      useNavigationStore.getState().openWorkflowEdit(automation);
      await flush();
    };

    it('records the open item as its own entry and restores it', async () => {
      await recordLibraryThenShell();
      useNavigationStore.getState().openWorkflowEdit(pipeline);
      await flush();

      const entries = useNavigationHistoryStore.getState().entries;
      expect(entries.map((entry) => entry.workflowEdit?.key ?? null)).toEqual([
        null,
        null,
        'automation:act-1',
        expect.stringMatching(/^pipeline:/),
      ]);

      expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
      expect(useNavigationStore.getState().workflowEdit).toEqual(automation);
      await flush();
      expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
      expect(useNavigationStore.getState().activePage).toBe(
        'workflows-library',
      );
      expect(useNavigationStore.getState().workflowEdit).toBeUndefined();
      await flush();
      expect(useNavigationHistoryStore.getState().goForward()).toBe(true);
      expect(useNavigationStore.getState().workflowEdit).toEqual(automation);
      await flush();
      // Walking through history added nothing.
      expect(useNavigationHistoryStore.getState().entries).toHaveLength(4);
    });

    it('restores an item from another page', async () => {
      await recordLibraryThenShell();
      useNavigationStore.getState().navigate('plugins');
      await flush();
      expect(useNavigationStore.getState().workflowEdit).toBeUndefined();

      expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
      expect(useNavigationStore.getState().activePage).toBe(
        'workflows-library',
      );
      expect(useNavigationStore.getState().workflowEdit).toEqual(automation);
    });

    it('keeps a section change in the current entry, not as a step', async () => {
      await recordLibraryThenShell();
      useNavigationStore.getState().setWorkflowEditSection('runs');
      await flush();

      const state = useNavigationHistoryStore.getState();
      expect(state.entries).toHaveLength(3);
      expect(state.entries[2]?.workflowEdit?.target).toEqual({
        ...automation,
        section: 'runs',
      });

      useNavigationStore.getState().navigate('plugins');
      await flush();
      useNavigationHistoryStore.getState().goBack();
      expect(useNavigationStore.getState().workflowEdit).toEqual({
        ...automation,
        section: 'runs',
      });
    });

    it('records a replaced item over the current entry', async () => {
      useNavigationStore.getState().navigate('workflows-library');
      await flush();
      useNavigationStore
        .getState()
        .openWorkflowEdit({ kind: 'automation-draft', draftKey: 'd-1' });
      await flush();
      expect(useNavigationHistoryStore.getState().entries).toHaveLength(3);

      useNavigationStore.getState().replaceWorkflowEdit(automation);
      await flush();

      const state = useNavigationHistoryStore.getState();
      expect(state.entries).toHaveLength(3);
      expect(state.index).toBe(2);
      expect(state.entries[2]?.workflowEdit).toEqual({
        key: 'automation:act-1',
        target: automation,
      });

      // Back leaves the saved item for the Library, never the old draft.
      expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
      expect(useNavigationStore.getState().workflowEdit).toBeUndefined();
    });

    it('still pushes an ordinary open after a replace', async () => {
      await recordLibraryThenShell();
      useNavigationStore.getState().replaceWorkflowEdit(pipeline);
      await flush();
      useNavigationStore
        .getState()
        .openWorkflowEdit({ kind: 'shared-automation', remoteId: 's-1' });
      await flush();
      expect(
        useNavigationHistoryStore
          .getState()
          .entries.map((entry) => entry.workflowEdit?.key ?? null),
      ).toEqual([
        null,
        null,
        expect.stringMatching(/^pipeline:/),
        'shared-automation:s-1',
      ]);
    });

    it('keeps an entry whose item was deleted navigable', async () => {
      await recordLibraryThenShell();
      useNavigationStore.getState().navigate('plugins');
      await flush();
      // Nothing in history knows about automations: the shell shows "not
      // found" for an id the store no longer has.
      expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
      expect(useNavigationStore.getState().workflowEdit).toEqual(automation);
    });

    it('asks the guard before the index moves, and a refusal leaves it', async () => {
      await recordLibraryThenShell();
      const guard = jest.fn(() => false);
      clearGuard = registerNavigationGuard(guard);

      expect(useNavigationHistoryStore.getState().goBack()).toBe(false);

      expect(guard).toHaveBeenCalledTimes(1);
      expect(guard).toHaveBeenCalledWith('workflows-library');
      expect(useNavigationHistoryStore.getState().index).toBe(2);
      expect(useNavigationStore.getState().workflowEdit).toEqual(automation);
    });

    it('applies a step the guard allows without asking again', async () => {
      await recordLibraryThenShell();
      const guard = jest.fn(() => true);
      clearGuard = registerNavigationGuard(guard);

      expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
      expect(guard).toHaveBeenCalledTimes(1);
      expect(useNavigationHistoryStore.getState().index).toBe(1);
      expect(useNavigationStore.getState().workflowEdit).toBeUndefined();

      // Restoring a page change is not re-guarded either.
      expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
      expect(guard).toHaveBeenCalledTimes(2);
      expect(useNavigationStore.getState().activePage).toBe('overview');
    });

    it('moves once a deferred answer allows it', async () => {
      await recordLibraryThenShell();
      let answer: (allowed: boolean) => void = () => undefined;
      const guard = jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      );
      clearGuard = registerNavigationGuard(guard);

      expect(useNavigationHistoryStore.getState().goBack()).toBe(false);
      expect(useNavigationHistoryStore.getState().index).toBe(2);
      expect(useNavigationStore.getState().workflowEdit).toEqual(automation);

      answer(true);
      await flush();
      expect(guard).toHaveBeenCalledTimes(1);
      expect(useNavigationHistoryStore.getState().index).toBe(1);
      expect(useNavigationStore.getState().workflowEdit).toBeUndefined();
      expect(useNavigationHistoryStore.getState().entries).toHaveLength(3);
    });

    it('stays put when a deferred answer refuses', async () => {
      await recordLibraryThenShell();
      let answer: (allowed: boolean) => void = () => undefined;
      clearGuard = registerNavigationGuard(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      );

      expect(useNavigationHistoryStore.getState().goBack()).toBe(false);
      answer(false);
      await flush();
      expect(useNavigationHistoryStore.getState().index).toBe(2);
      expect(useNavigationStore.getState().workflowEdit).toEqual(automation);
    });

    it('keeps a save from the prompt that replaced the current entry', async () => {
      useNavigationStore.getState().navigate('workflows-library');
      await flush();
      useNavigationStore
        .getState()
        .openWorkflowEdit({ kind: 'automation-draft', draftKey: 'd-1' });
      await flush();
      let answer: (allowed: boolean) => void = () => undefined;
      clearGuard = registerNavigationGuard(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      );

      expect(useNavigationHistoryStore.getState().goBack()).toBe(false);
      // Save in the prompt: the draft gets its id, then leaving is allowed.
      useNavigationStore.getState().replaceWorkflowEdit(automation);
      await flush();
      answer(true);
      await flush();

      const state = useNavigationHistoryStore.getState();
      expect(state.index).toBe(1);
      expect(state.entries[2]?.workflowEdit?.key).toBe('automation:act-1');
    });

    it('drops a deferred step once history moved elsewhere', async () => {
      await recordLibraryThenShell();
      let answer: (allowed: boolean) => void = () => undefined;
      clearGuard = registerNavigationGuard(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      );

      expect(useNavigationHistoryStore.getState().goBack()).toBe(false);
      clearGuard();
      useNavigationStore.getState().navigate('plugins');
      await flush();
      answer(true);
      await flush();

      expect(useNavigationStore.getState().activePage).toBe('plugins');
      expect(useNavigationHistoryStore.getState().index).toBe(3);
    });
  });
  it('restores source filters, entry context and Installed filtering without replaying Add (CAN-4267)', async () => {
    const location = {
      browse: {
        query: 'catalog',
        tab: 'sources' as const,
        installedStatusFilter: 'disabled' as const,
        installedExpanded: true,
      },
      source: {
        sourceId: 'opaque/source',
        filters: { query: 'lint', category: 'tools', author: null },
      },
      entry: { id: 'mkt:opaque/source/lint', stack: [], fromInstalled: true },
      scrollTop: 240,
      browseScrollTop: 120,
      detailReturnScrollTop: 360,
    };
    useNavigationStore.getState().navigate('plugins');
    useNavigationStore.getState().setPluginsPresentation(location);
    await flush();
    useNavigationStore.getState().navigate('overview');
    await flush();
    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    await flush();
    expect(useNavigationStore.getState().pendingPluginsNavigation).toEqual({
      kind: 'restore',
      location,
    });
  });

  it('restores older Customize visits atomically and preserves Forward history (CAN-4267)', async () => {
    const older = { browse: { query: 'older', tab: 'skill' as const } };
    const newer = { browse: { query: 'newer', tab: 'app' as const } };
    useNavigationStore.getState().navigate('plugins');
    useNavigationStore.getState().setPluginsPresentation(older);
    await flush();
    useNavigationStore.getState().navigate('overview');
    await flush();
    useNavigationStore.getState().navigate('plugins');
    useNavigationStore.getState().setPluginsPresentation(newer);
    await flush();
    const entries = useNavigationHistoryStore.getState().entries;
    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    await flush();
    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    expect(useNavigationStore.getState().pluginsPresentation).toEqual(older);
    await flush();
    // Simulate the page publishing the restored state after its React effect.
    useNavigationStore.getState().setPluginsPresentation(older);
    await flush();
    expect(useNavigationHistoryStore.getState().entries).toEqual(entries);
    expect(useNavigationHistoryStore.getState().canGoForward).toBe(true);
    expect(useNavigationHistoryStore.getState().goForward()).toBe(true);
    await flush();
    expect(useNavigationHistoryStore.getState().goForward()).toBe(true);
    expect(useNavigationStore.getState().pluginsPresentation).toEqual(newer);
    await flush();
    expect(useNavigationHistoryStore.getState().entries).toEqual(entries);
  });

  it('refines the current Customize step while search text changes (CAN-4267)', async () => {
    const source = {
      sourceId: 'opaque/source',
      filters: { query: '', category: null, author: null },
    };
    useNavigationStore.getState().navigate('plugins');
    useNavigationStore.getState().setPluginsPresentation({
      browse: { query: '', tab: 'all' },
      categoryQuery: '',
    });
    await flush();
    const { entries, index } = useNavigationHistoryStore.getState();
    for (const query of ['r', 'repo', '']) {
      useNavigationStore.getState().setPluginsPresentation({
        browse: { query, tab: 'all' },
        categoryQuery: query,
      });
      await flush();
    }
    useNavigationStore.getState().setPluginsPresentation({
      browse: { query: 'lint', tab: 'all' },
      categoryQuery: '',
    });
    await flush();
    expect(useNavigationHistoryStore.getState().entries).toHaveLength(
      entries.length,
    );
    expect(useNavigationHistoryStore.getState().index).toBe(index);
    expect(
      useNavigationHistoryStore.getState().entries[index]?.pluginsPresentation
        ?.browse.query,
    ).toBe('lint');

    // A source is a step; typing in its search refines that step.
    useNavigationStore.getState().setPluginsPresentation({
      browse: { query: 'lint', tab: 'sources' },
      source,
    });
    await flush();
    useNavigationStore.getState().setPluginsPresentation({
      browse: { query: 'lint', tab: 'sources' },
      source: { ...source, filters: { ...source.filters, query: 'fmt' } },
    });
    await flush();
    expect(useNavigationHistoryStore.getState().entries).toHaveLength(
      entries.length + 1,
    );
    // Back leaves the source instead of replaying each search edit.
    expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
    expect(useNavigationStore.getState().pluginsPresentation).toEqual({
      browse: { query: 'lint', tab: 'all' },
      categoryQuery: '',
    });
  });

  it.each(['account', 'workspace'] as const)(
    'never replays abandoned Customize history after a %s switch (CAN-4267)',
    async (context) => {
      useNavigationStore.getState().navigate('plugins');
      useNavigationStore.getState().setPluginsPresentation({
        browse: { query: 'PRIVATE QUERY', tab: 'sources' },
        source: {
          sourceId: 'private-source',
          filters: { query: 'PRIVATE FILTER', category: null, author: null },
        },
      });
      await flush();
      useNavigationStore.getState().navigate('overview');
      await flush();
      useNavigationStore.getState().navigate('statistics');
      await flush();
      const workspace = useWorkspaceContextStore.getState();
      useWorkspaceContextStore.setState(
        context === 'account'
          ? { accountEpoch: workspace.accountEpoch + 1 }
          : { appliedGeneration: workspace.appliedGeneration + 1 },
      );
      await flush();
      expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
      await flush();
      expect(useNavigationStore.getState().activePage).toBe('overview');
      expect(useNavigationHistoryStore.getState().goBack()).toBe(true);
      await flush();
      expect(useNavigationStore.getState().activePage).toBe('overview');
      expect(
        useNavigationStore.getState().pendingPluginsNavigation,
      ).toBeUndefined();
      expect(
        useNavigationHistoryStore
          .getState()
          .entries.some((entry) => entry.pluginsPresentation !== undefined),
      ).toBe(false);
      expect(useNavigationHistoryStore.getState().goForward()).toBe(true);
      await flush();
      expect(useNavigationHistoryStore.getState().goForward()).toBe(true);
      await flush();
      expect(useNavigationStore.getState().activePage).toBe('statistics');
    },
  );

  it('does not duplicate equivalent Customize locations (CAN-4267)', async () => {
    useNavigationStore.getState().navigate('plugins');
    useNavigationStore.getState().setPluginsPresentation({
      browse: { query: '', tab: 'all', installedExpanded: true },
    });
    await flush();
    const count = useNavigationHistoryStore.getState().entries.length;
    useNavigationStore.getState().setPluginsPresentation({
      browse: { query: '', tab: 'all', installedExpanded: true },
      scrollTop: 120,
      browseScrollTop: 240,
      detailReturnScrollTop: 360,
    });
    await flush();
    expect(useNavigationHistoryStore.getState().entries).toHaveLength(count);
  });
});

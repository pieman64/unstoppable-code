import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import type { WorkspaceContext } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  installWorkspaceContextSelectionSync,
  syncSelectionForContextChange,
} from '../workspaceContextSelection';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSONAL: WorkspaceContext = { kind: 'personal' };
const COWORK_SELECTION = { projectId: 'cowork-1', worktreeId: 'entry-1' };
const ACME: WorkspaceContext = { kind: 'organization', organizationId: ORG_A };

describe('workspace context selection sync (CAN-2954)', (): void => {
  let selectWorktree: jest.Mock;
  let deselectWorktree: jest.Mock;
  let navigate: jest.Mock;
  let clearActiveWorkEntry: jest.Mock;
  let cancelPendingWorkEntryNavigation: jest.Mock;
  let openWorkEntryFromSidebar: jest.Mock;

  beforeEach((): void => {
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    selectWorktree = jest.fn((projectId: string, worktreeId: string): void => {
      useChatStore.setState({ selectedWorktree: { projectId, worktreeId } });
    });
    deselectWorktree = jest.fn((): void => {
      useChatStore.setState({ selectedWorktree: null });
    });
    navigate = jest.fn();
    useChatStore.setState({
      selectedWorktree: { projectId: 'p1', worktreeId: 'w1' },
      selectWorktree,
      deselectWorktree,
    });
    useNavigationStore.setState({ navigate, activePage: 'main' });
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'p1',
          name: 'Project',
          repoPath: '/workspace',
          color: '#000000',
          collapsed: false,
          order: 0,
          worktrees: [],
        },
        {
          type: 'cowork',
          id: 'cowork-1',
          name: 'Cowork',
          color: '#000000',
          collapsed: false,
          order: 1,
        },
      ],
    });
    cancelPendingWorkEntryNavigation = jest.fn();
    clearActiveWorkEntry = jest.fn((): void => {
      useStandaloneChatStore.setState({ activeWorkEntryId: null });
    });
    openWorkEntryFromSidebar = jest.fn((): Promise<void> => {
      useChatStore.setState({ selectedWorktree: COWORK_SELECTION });
      return Promise.resolve();
    });
    const standaloneState = {
      activeChatProjectId: 'cowork-1',
      activeWorkEntryId: null,
      workEntries: [
        { id: 'entry-1', title: 'Task', createdAt: '2026-07-01T10:00:00.000Z' },
      ],
      openWorkEntryFromSidebar,
      clearActiveWorkEntry,
      cancelPendingWorkEntryNavigation,
    };
    useStandaloneChatStore.setState(standaloneState);
    useWorkspaceContextStore.setState({
      state: {
        context: PERSONAL,
        revision: 1,
        organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
      },
      hydrated: false,
      lastSelectionByContext: {},
    });
  });

  it('remembers the Personal selection and clears it when entering an organization', (): void => {
    syncSelectionForContextChange(PERSONAL, ACME);
    expect(useWorkspaceContextStore.getState().lastSelectionByContext).toEqual({
      personal: { projectId: 'p1', worktreeId: 'w1' },
    });
    expect(deselectWorktree).toHaveBeenCalledTimes(1);
    expect(selectWorktree).not.toHaveBeenCalled();
  });

  it('restores the last selection of the context being entered', (): void => {
    useWorkspaceContextStore.setState({
      lastSelectionByContext: {
        personal: { projectId: 'p1', worktreeId: 'w1' },
      },
    });
    useChatStore.setState({ selectedWorktree: null });
    syncSelectionForContextChange(ACME, PERSONAL);
    expect(selectWorktree).toHaveBeenCalledWith('p1', 'w1');
    expect(navigate).toHaveBeenCalledWith('main');
    expect(deselectWorktree).not.toHaveBeenCalled();
    // The organization context left with no selection.
    expect(
      useWorkspaceContextStore.getState().lastSelectionByContext[
        `org:${ORG_A}`
      ],
    ).toBeNull();
  });

  it('clears the outgoing selection and drops a remembered worktree that no longer exists', (): void => {
    useWorkspaceContextStore.setState({
      lastSelectionByContext: {
        [`org:${ORG_A}`]: { projectId: 'p2', worktreeId: 'deleted' },
      },
    });
    selectWorktree.mockImplementation((): void => {
      expect(useChatStore.getState().selectedWorktree).toBeNull();
    });

    syncSelectionForContextChange(PERSONAL, ACME);

    expect(deselectWorktree).toHaveBeenCalledTimes(1);
    expect(selectWorktree).toHaveBeenCalledWith('p2', 'deleted');
    expect(useChatStore.getState().selectedWorktree).toBeNull();
    expect(useWorkspaceContextStore.getState().lastSelectionByContext).toEqual({
      personal: { projectId: 'p1', worktreeId: 'w1' },
      [`org:${ORG_A}`]: null,
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('clears an open Cowork task and leaves the chat page when entering an organization', (): void => {
    useChatStore.setState({ selectedWorktree: COWORK_SELECTION });
    useStandaloneChatStore.setState({ activeWorkEntryId: 'entry-1' });
    useNavigationStore.setState({ activePage: 'chat' });

    syncSelectionForContextChange(PERSONAL, ACME);

    expect(deselectWorktree).toHaveBeenCalledTimes(1);
    expect(clearActiveWorkEntry).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('main');
    expect(
      useWorkspaceContextStore.getState().lastSelectionByContext.personal,
    ).toEqual(COWORK_SELECTION);
  });

  it('cancels an in-flight Cowork open when the context changes', (): void => {
    useChatStore.setState({ selectedWorktree: null });
    useStandaloneChatStore.setState({ activeWorkEntryId: null });
    useNavigationStore.setState({ activePage: 'chat' });

    syncSelectionForContextChange(PERSONAL, ACME);

    expect(cancelPendingWorkEntryNavigation).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('main');
    expect(deselectWorktree).not.toHaveBeenCalled();
    expect(clearActiveWorkEntry).not.toHaveBeenCalled();
  });

  it('does not leave a non-chat page when clearing', (): void => {
    useChatStore.setState({ selectedWorktree: COWORK_SELECTION });
    useStandaloneChatStore.setState({ activeWorkEntryId: 'entry-1' });
    useNavigationStore.setState({ activePage: 'settings' });

    syncSelectionForContextChange(PERSONAL, ACME);

    expect(deselectWorktree).toHaveBeenCalledTimes(1);
    expect(clearActiveWorkEntry).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  describe('remembered Cowork selection', (): void => {
    beforeEach((): void => {
      useChatStore.setState({ selectedWorktree: null });
      useWorkspaceContextStore.setState({
        lastSelectionByContext: { personal: COWORK_SELECTION },
      });
    });

    it('restores a remembered Cowork task through the Cowork navigation path', async (): Promise<void> => {
      syncSelectionForContextChange(ACME, PERSONAL);
      await Promise.resolve();
      await Promise.resolve();

      expect(openWorkEntryFromSidebar).toHaveBeenCalledWith(
        'cowork-1',
        'entry-1',
      );
      expect(selectWorktree).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith('chat');
    });

    it('does not navigate to chat when the user changed page during a pending Cowork restore', async (): Promise<void> => {
      let finishRestore: () => void = (): void => {
        throw new Error('Restore did not start');
      };
      const pendingRestore = new Promise<void>((resolve): void => {
        finishRestore = resolve;
      });
      openWorkEntryFromSidebar.mockImplementation(async (): Promise<void> => {
        await pendingRestore;
        useChatStore.setState({ selectedWorktree: COWORK_SELECTION });
        useStandaloneChatStore.setState({ activeWorkEntryId: 'entry-1' });
      });

      syncSelectionForContextChange(ACME, PERSONAL);
      useNavigationStore.setState({ activePage: 'settings' });
      finishRestore();
      await pendingRestore;
      await Promise.resolve();
      await Promise.resolve();

      expect(navigate).not.toHaveBeenCalled();
      expect(useNavigationStore.getState().activePage).toBe('settings');
      // The user's page wins and nothing from the restore stays installed.
      expect(useChatStore.getState().selectedWorktree).toBeNull();
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBeNull();
      expect(clearActiveWorkEntry).toHaveBeenCalledTimes(1);
      expect(
        useWorkspaceContextStore.getState().lastSelectionByContext.personal,
      ).toEqual(COWORK_SELECTION);
    });

    it('releases a stale restore instead of reinstalling a selection captured before another context switch', async (): Promise<void> => {
      let finishRestore: () => void = (): void => {
        throw new Error('Restore did not start');
      };
      const pendingRestore = new Promise<void>((resolve): void => {
        finishRestore = resolve;
      });
      openWorkEntryFromSidebar.mockImplementation(async (): Promise<void> => {
        await pendingRestore;
        useChatStore.setState({ selectedWorktree: COWORK_SELECTION });
        useStandaloneChatStore.setState({ activeWorkEntryId: 'entry-1' });
      });

      syncSelectionForContextChange(ACME, PERSONAL);
      // A click lands, then another switch leaves Personal before the open resolves.
      useChatStore.setState({
        selectedWorktree: { projectId: 'p1', worktreeId: 'w1' },
      });
      useWorkspaceContextStore.setState({
        state: {
          context: ACME,
          revision: 2,
          organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
        },
      });
      finishRestore();
      await pendingRestore;
      await Promise.resolve();
      await Promise.resolve();

      expect(useChatStore.getState().selectedWorktree).toBeNull();
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBeNull();
      expect(selectWorktree).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(
        useWorkspaceContextStore.getState().lastSelectionByContext.personal,
      ).toEqual(COWORK_SELECTION);
    });

    it('drops a remembered Cowork task that no longer exists after the open', async (): Promise<void> => {
      openWorkEntryFromSidebar.mockImplementation((): Promise<void> => {
        useChatStore.setState({ selectedWorktree: COWORK_SELECTION });
        useStandaloneChatStore.setState({
          activeWorkEntryId: 'entry-1',
          workEntries: [],
        });
        return Promise.resolve();
      });

      syncSelectionForContextChange(ACME, PERSONAL);
      await Promise.resolve();
      await Promise.resolve();

      expect(useChatStore.getState().selectedWorktree).toBeNull();
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
      expect(
        useWorkspaceContextStore.getState().lastSelectionByContext.personal,
      ).toBeNull();
    });

    it('keeps a Code worktree the user picked while a Cowork restore was pending', async (): Promise<void> => {
      let finishRestore: () => void = (): void => {
        throw new Error('Restore did not start');
      };
      const pendingRestore = new Promise<void>((resolve): void => {
        finishRestore = resolve;
      });
      openWorkEntryFromSidebar.mockImplementation(async (): Promise<void> => {
        await pendingRestore;
        useChatStore.setState({ selectedWorktree: COWORK_SELECTION });
        useStandaloneChatStore.setState({
          activeChatProjectId: 'cowork-1',
          activeWorkEntryId: 'entry-1',
        });
      });

      syncSelectionForContextChange(ACME, PERSONAL);
      useChatStore.setState({
        selectedWorktree: { projectId: 'p1', worktreeId: 'w1' },
      });
      finishRestore();
      await pendingRestore;
      await Promise.resolve();
      await Promise.resolve();

      expect(useChatStore.getState().selectedWorktree).toEqual({
        projectId: 'p1',
        worktreeId: 'w1',
      });
      expect(clearActiveWorkEntry).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled();
      expect(
        useWorkspaceContextStore.getState().lastSelectionByContext.personal,
      ).toEqual(COWORK_SELECTION);
    });

    it('releases a partially installed Cowork task when the restore rejects', async (): Promise<void> => {
      openWorkEntryFromSidebar.mockImplementation((): Promise<void> => {
        useChatStore.setState({ selectedWorktree: COWORK_SELECTION });
        useStandaloneChatStore.setState({
          activeChatProjectId: 'cowork-1',
          activeWorkEntryId: 'entry-1',
        });
        return Promise.reject(new Error('Load tabs failed'));
      });

      syncSelectionForContextChange(ACME, PERSONAL);
      await Promise.resolve();
      await Promise.resolve();

      expect(deselectWorktree).toHaveBeenCalledTimes(1);
      expect(clearActiveWorkEntry).toHaveBeenCalledTimes(1);
      expect(useChatStore.getState().selectedWorktree).toBeNull();
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
      expect(
        useWorkspaceContextStore.getState().lastSelectionByContext.personal,
      ).toBeNull();
    });

    it('leaves a different selection alone when the restore rejects', async (): Promise<void> => {
      const differentSelection = { projectId: 'p1', worktreeId: 'w1' };
      openWorkEntryFromSidebar.mockImplementation((): Promise<void> => {
        useChatStore.setState({ selectedWorktree: differentSelection });
        useStandaloneChatStore.setState({
          activeChatProjectId: 'p1',
          activeWorkEntryId: 'w1',
        });
        return Promise.reject(new Error('Load tabs failed'));
      });

      syncSelectionForContextChange(ACME, PERSONAL);
      await Promise.resolve();
      await Promise.resolve();

      expect(deselectWorktree).not.toHaveBeenCalled();
      expect(clearActiveWorkEntry).not.toHaveBeenCalled();
      expect(useChatStore.getState().selectedWorktree).toEqual(
        differentSelection,
      );
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe('w1');
      expect(navigate).not.toHaveBeenCalled();
      expect(
        useWorkspaceContextStore.getState().lastSelectionByContext.personal,
      ).toEqual(COWORK_SELECTION);
    });

    it.each(['missing', 'rejected'])(
      'drops a remembered Cowork task that could not be reopened (%s)',
      async (outcome): Promise<void> => {
        openWorkEntryFromSidebar.mockImplementation((): Promise<void> => {
          return outcome === 'rejected'
            ? Promise.reject(new Error('Entry unavailable'))
            : Promise.resolve();
        });
        syncSelectionForContextChange(ACME, PERSONAL);
        await Promise.resolve();
        await Promise.resolve();

        expect(navigate).not.toHaveBeenCalled();
        expect(
          useWorkspaceContextStore.getState().lastSelectionByContext.personal,
        ).toBeNull();
      },
    );

    it('ignores a Cowork restore that finished after another context switch', async (): Promise<void> => {
      let finishRestore: () => void = (): void => {
        throw new Error('Restore did not start');
      };
      const pendingRestore = new Promise<void>((resolve): void => {
        finishRestore = resolve;
      });
      openWorkEntryFromSidebar.mockImplementation(async (): Promise<void> => {
        await pendingRestore;
        useChatStore.setState({ selectedWorktree: COWORK_SELECTION });
        useStandaloneChatStore.setState({
          activeChatProjectId: 'cowork-1',
          activeWorkEntryId: 'entry-1',
        });
      });
      syncSelectionForContextChange(ACME, PERSONAL);
      useWorkspaceContextStore.setState((store) => ({
        state: { ...store.state, context: ACME },
      }));
      finishRestore();
      await pendingRestore;
      await Promise.resolve();
      await Promise.resolve();

      expect({
        deselected: deselectWorktree.mock.calls.length,
        cleared: clearActiveWorkEntry.mock.calls.length,
      }).toEqual({ deselected: 1, cleared: 1 });
      expect(useChatStore.getState().selectedWorktree).toBeNull();
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
      expect(
        useWorkspaceContextStore.getState().lastSelectionByContext.personal,
      ).toEqual(COWORK_SELECTION);
    });
    it('preserves a newer selection when a stale Cowork restore finishes', async (): Promise<void> => {
      let finishRestore: () => void = (): void => {
        throw new Error('Restore did not start');
      };
      const pendingRestore = new Promise<void>((resolve): void => {
        finishRestore = resolve;
      });
      openWorkEntryFromSidebar.mockImplementation(async (): Promise<void> => {
        await pendingRestore;
        useChatStore.setState({ selectedWorktree: COWORK_SELECTION });
        useStandaloneChatStore.setState({
          activeChatProjectId: 'cowork-1',
          activeWorkEntryId: 'entry-1',
        });
      });
      syncSelectionForContextChange(ACME, PERSONAL);
      useWorkspaceContextStore.setState((store) => ({
        state: { ...store.state, context: ACME },
      }));
      void pendingRestore.then((): void => {
        useChatStore.setState({
          selectedWorktree: { projectId: 'p2', worktreeId: 'w2' },
        });
        useStandaloneChatStore.setState({
          activeChatProjectId: 'cowork-2',
          activeWorkEntryId: 'entry-2',
        });
      });
      finishRestore();
      await pendingRestore;
      await Promise.resolve();
      await Promise.resolve();

      expect({
        deselected: deselectWorktree.mock.calls.length,
        cleared: clearActiveWorkEntry.mock.calls.length,
      }).toEqual({ deselected: 0, cleared: 0 });
      expect(useChatStore.getState().selectedWorktree).toEqual({
        projectId: 'p2',
        worktreeId: 'w2',
      });
      expect(useStandaloneChatStore.getState().activeWorkEntryId).toBe(
        'entry-2',
      );
      expect(navigate).not.toHaveBeenCalled();
      expect(
        useWorkspaceContextStore.getState().lastSelectionByContext.personal,
      ).toEqual(COWORK_SELECTION);
    });
  });

  describe('open share viewer (CAN-2954, PR #3304)', (): void => {
    let closeViewer: jest.Mock;
    const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    beforeEach((): void => {
      closeViewer = jest.fn((): void => {
        useSharedContainerReplicasStore.setState({ viewer: null });
      });
      useSharedContainerReplicasStore.setState({
        viewer: {
          containerId: 'share-zen',
          organizationId: ORG_B,
          replica: null,
          openError: null,
          loading: false,
        },
        closeViewer,
      });
    });

    afterEach((): void => {
      useSharedContainerReplicasStore.setState({
        viewer: null,
        acceptedRecords: {},
      });
    });

    it('closes a share viewer that belongs to another organization when the context changes', (): void => {
      syncSelectionForContextChange(PERSONAL, ACME);
      expect(closeViewer).toHaveBeenCalledTimes(1);
    });

    it('closes an organization share viewer when entering Personal', (): void => {
      syncSelectionForContextChange(ACME, PERSONAL);
      expect(closeViewer).toHaveBeenCalledTimes(1);
    });

    it('keeps a direct share viewer when entering Personal', (): void => {
      useSharedContainerReplicasStore.setState({
        viewer: {
          containerId: 'share-direct',
          access: 'direct',
          replica: null,
          openError: null,
          loading: false,
        },
      });
      syncSelectionForContextChange(ACME, PERSONAL);
      expect(closeViewer).not.toHaveBeenCalled();
    });

    it('closes a foreign viewer that opens after the switch while scoping is active', (): void => {
      useSharedContainerReplicasStore.setState({ viewer: null });
      const snapshot = getDefaultFeatureFlagSnapshot();
      snapshot.values[CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key] = true;
      useFeatureFlagsStore.setState({ snapshot });
      useWorkspaceContextStore.setState({
        state: {
          context: ACME,
          revision: 2,
          organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
        },
        hydrated: true,
      });
      const unsubscribe = installWorkspaceContextSelectionSync();
      try {
        // A pending acceptance from the Zen context resolves and opens its viewer.
        useSharedContainerReplicasStore.setState({
          viewer: {
            containerId: 'share-zen',
            organizationId: ORG_B,
            replica: null,
            openError: null,
            loading: false,
          },
        });
        expect(closeViewer).toHaveBeenCalledTimes(1);
        // A viewer of the active organization is left alone.
        useSharedContainerReplicasStore.setState({
          viewer: {
            containerId: 'share-acme',
            organizationId: ORG_A,
            replica: null,
            openError: null,
            loading: false,
          },
        });
        expect(closeViewer).toHaveBeenCalledTimes(1);
      } finally {
        unsubscribe();
      }
    });

    describe('accepted share anchored by its acceptance record (CAN-3554)', (): void => {
      // The share was accepted in Acme; a later listing round classified it
      // as direct, so its viewer carries `access: 'direct'`.
      const openedAsDirect = {
        containerId: 'share-acme',
        organizationId: ORG_A,
        access: 'direct' as const,
        replica: null,
        openError: null,
        loading: false,
      };

      it('keeps the viewer in the organization it was accepted in and closes it in Personal', (): void => {
        useSharedContainerReplicasStore.setState({
          viewer: openedAsDirect,
          acceptedRecords: { 'share-acme': { organizationId: ORG_A } },
        });
        syncSelectionForContextChange(PERSONAL, ACME);
        expect(closeViewer).not.toHaveBeenCalled();

        syncSelectionForContextChange(ACME, PERSONAL);
        expect(closeViewer).toHaveBeenCalledTimes(1);
      });

      it('keeps that viewer when it mounts while its organization is the active context', (): void => {
        useSharedContainerReplicasStore.setState({
          viewer: null,
          acceptedRecords: { 'share-acme': { organizationId: ORG_A } },
        });
        const snapshot = getDefaultFeatureFlagSnapshot();
        snapshot.values[CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key] =
          true;
        useFeatureFlagsStore.setState({ snapshot });
        useWorkspaceContextStore.setState({
          state: {
            context: ACME,
            revision: 2,
            organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
          },
          hydrated: true,
        });
        const unsubscribe = installWorkspaceContextSelectionSync();
        try {
          useSharedContainerReplicasStore.setState({ viewer: openedAsDirect });
          expect(closeViewer).not.toHaveBeenCalled();
        } finally {
          unsubscribe();
        }
      });

      it('closes the viewer of a share accepted as direct when entering the organization it lists under this round', (): void => {
        useSharedContainerReplicasStore.setState({
          viewer: {
            containerId: 'share-acme',
            organizationId: ORG_A,
            replica: null,
            openError: null,
            loading: false,
          },
          acceptedRecords: { 'share-acme': { access: 'direct' } },
        });
        syncSelectionForContextChange(ACME, PERSONAL);
        expect(closeViewer).not.toHaveBeenCalled();

        syncSelectionForContextChange(PERSONAL, ACME);
        expect(closeViewer).toHaveBeenCalledTimes(1);
      });
    });

    it('keeps the viewer of the organization being entered', (): void => {
      useSharedContainerReplicasStore.setState({
        viewer: {
          containerId: 'share-acme',
          organizationId: ORG_A,
          replica: null,
          openError: null,
          loading: false,
        },
      });
      syncSelectionForContextChange(PERSONAL, ACME);
      expect(closeViewer).not.toHaveBeenCalled();
    });
  });

  it('does nothing when the context did not actually change', (): void => {
    syncSelectionForContextChange(PERSONAL, { kind: 'personal' });
    expect(deselectWorktree).not.toHaveBeenCalled();
    expect(selectWorktree).not.toHaveBeenCalled();
  });

  it('runs on every applied context change once installed', (): void => {
    useFeatureFlagsStore.setState({
      snapshot: {
        ...getDefaultFeatureFlagSnapshot(),
        values: { [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true },
      },
    });
    useWorkspaceContextStore.setState({ hydrated: true });
    const unsubscribe = installWorkspaceContextSelectionSync();
    useWorkspaceContextStore.getState().applyBroadcast({
      context: ACME,
      revision: 2,
      organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
      reason: 'switch',
    });
    expect(deselectWorktree).toHaveBeenCalledTimes(1);
    unsubscribe();
    useWorkspaceContextStore.getState().applyBroadcast({
      context: PERSONAL,
      revision: 3,
      organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
      reason: 'switch',
    });
    expect(selectWorktree).not.toHaveBeenCalled();
  });
  describe('runtime scoping activation', (): void => {
    function setEnabled(enabled: boolean): void {
      useFeatureFlagsStore.setState({
        snapshot: {
          ...getDefaultFeatureFlagSnapshot(),
          values: {
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: enabled,
          },
        },
      });
    }

    beforeEach((): void => {
      setEnabled(false);
      const state = useWorkspaceContextStore.getState().state;
      useWorkspaceContextStore.setState({
        state: { ...state, context: ACME },
        hydrated: true,
      });
    });

    it.each([
      ['disable', 'personal', 'enable', 'organization'],
      ['disable', 'personal', 'organization', 'enable'],
      ['personal', 'disable', 'enable', 'organization'],
      ['disable', 'enable', 'personal', 'organization'],
    ])(
      'keeps the selected organization draft through rollout broadcasts (%j)',
      (...steps): void => {
        useProjectsStore.setState({
          projects: useProjectsStore.getState().projects.map((project) =>
            project.id === 'p1'
              ? {
                  ...project,
                  owner: {
                    type: 'organization',
                    organizationId: ORG_A,
                    projectId: 'org-project',
                    instanceId: 'instance-1',
                    bindingGeneration: 1,
                  },
                }
              : project,
          ),
        });
        setEnabled(true);
        const revision = useWorkspaceContextStore.getState().state.revision;
        const draft = [
          {
            type: 'paragraph',
            children: [{ text: 'Keep typing in this worktree' }],
          },
        ];
        useChatStore.getState().saveTabDraft('draft-tab', draft);
        const unsubscribe = installWorkspaceContextSelectionSync();
        try {
          for (const step of steps) {
            if (step === 'disable' || step === 'enable') {
              setEnabled(step === 'enable');
            } else {
              useWorkspaceContextStore.getState().applyBroadcast({
                context: step === 'personal' ? PERSONAL : ACME,
                revision,
                organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
                reason: 'organizations',
              });
            }
            expect(useChatStore.getState().selectedWorktree).toEqual({
              projectId: 'p1',
              worktreeId: 'w1',
            });
            expect(useChatStore.getState().getTabDraft('draft-tab')).toEqual(
              draft,
            );
          }
          expect(deselectWorktree).not.toHaveBeenCalled();
          expect(
            useWorkspaceContextStore.getState().lastSelectionByContext,
          ).toEqual({});
          // A real departure still clears the selection, even after a projection.
          useWorkspaceContextStore.getState().applyBroadcast({
            context: PERSONAL,
            revision: revision + 1,
            organizations: [],
            reason: 'departed',
          });
          expect(deselectWorktree).toHaveBeenCalledTimes(1);
          expect(useChatStore.getState().selectedWorktree).toBeNull();
        } finally {
          unsubscribe();
        }
      },
    );

    it.each(['switch', 'departed', 'account-change', 'organizations'] as const)(
      'still clears the selection for an authoritative %s broadcast',
      (reason): void => {
        setEnabled(true);
        const revision = useWorkspaceContextStore.getState().state.revision;
        const unsubscribe = installWorkspaceContextSelectionSync();
        try {
          useWorkspaceContextStore.getState().applyBroadcast({
            context: PERSONAL,
            revision: reason === 'account-change' ? revision : revision + 1,
            organizations: [],
            reason,
          });
          expect(deselectWorktree).toHaveBeenCalledTimes(1);
          expect(useChatStore.getState().selectedWorktree).toBeNull();
        } finally {
          unsubscribe();
        }
      },
    );

    it('clears a hidden selection when organization scoping activates at runtime', (): void => {
      const unsubscribe = installWorkspaceContextSelectionSync();
      try {
        expect(deselectWorktree).not.toHaveBeenCalled();
        setEnabled(true);
        expect(deselectWorktree).toHaveBeenCalledTimes(1);
        expect(navigate).not.toHaveBeenCalled();
        expect(
          useWorkspaceContextStore.getState().lastSelectionByContext,
        ).toEqual({});
      } finally {
        unsubscribe();
      }
    });

    it('leaves a matching selection alone when scoping activates', (): void => {
      const state = useWorkspaceContextStore.getState().state;
      useWorkspaceContextStore.setState({
        state: { ...state, context: PERSONAL },
      });
      const unsubscribe = installWorkspaceContextSelectionSync();
      try {
        setEnabled(true);
        expect(deselectWorktree).not.toHaveBeenCalled();
        expect(selectWorktree).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });

    it('restores the remembered selection of the active context after reconciling', (): void => {
      useProjectsStore.setState({
        projects: [
          ...useProjectsStore.getState().projects,
          {
            type: 'single-repo',
            id: 'p2',
            name: 'Organization project',
            repoPath: '/organization',
            color: '#000000',
            collapsed: false,
            order: 2,
            worktrees: [],
            owner: {
              type: 'organization',
              organizationId: ORG_A,
              projectId: 'org-project',
              instanceId: 'instance-1',
              bindingGeneration: 1,
            },
          },
        ],
      });
      useWorkspaceContextStore.setState({
        lastSelectionByContext: {
          [`org:${ORG_A}`]: { projectId: 'p2', worktreeId: 'w2' },
        },
      });
      const unsubscribe = installWorkspaceContextSelectionSync();
      try {
        setEnabled(true);
        expect(deselectWorktree).toHaveBeenCalledTimes(1);
        expect(selectWorktree).toHaveBeenCalledWith('p2', 'w2');
        expect(navigate).toHaveBeenCalledWith('main');
        expect(
          useWorkspaceContextStore.getState().lastSelectionByContext,
        ).toEqual({
          [`org:${ORG_A}`]: { projectId: 'p2', worktreeId: 'w2' },
        });
      } finally {
        unsubscribe();
      }
    });
  });

  it.each([
    { enabled: false, hydrated: true },
    { enabled: true, hydrated: false },
  ])(
    'leaves the selection alone while organization scoping is inactive (%j)',
    ({ enabled, hydrated }): void => {
      useFeatureFlagsStore.setState({
        snapshot: {
          ...getDefaultFeatureFlagSnapshot(),
          values: {
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: enabled,
          },
        },
      });
      useWorkspaceContextStore.setState({ hydrated });
      const unsubscribe = installWorkspaceContextSelectionSync();
      try {
        if (hydrated) {
          useWorkspaceContextStore.getState().applyBroadcast({
            context: ACME,
            revision: 2,
            organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
            reason: 'switch',
          });
        } else {
          // Broadcasts complete hydration; exercise a pre-hydration change directly.
          const state = useWorkspaceContextStore.getState().state;
          useWorkspaceContextStore.setState({
            state: { ...state, context: ACME, revision: 2 },
          });
        }
        expect(deselectWorktree).not.toHaveBeenCalled();
        expect(useChatStore.getState().selectedWorktree).toEqual({
          projectId: 'p1',
          worktreeId: 'w1',
        });
        expect(
          useWorkspaceContextStore.getState().lastSelectionByContext,
        ).toEqual({});
        useFeatureFlagsStore.setState({
          snapshot: {
            ...getDefaultFeatureFlagSnapshot(),
            values: {
              [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
            },
          },
        });
        useWorkspaceContextStore.setState({ hydrated: true });
        useWorkspaceContextStore.getState().applyBroadcast({
          context: PERSONAL,
          revision: 3,
          organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
          reason: 'switch',
        });
        expect(deselectWorktree).toHaveBeenCalledTimes(1);
        expect(
          useWorkspaceContextStore.getState().lastSelectionByContext,
        ).toEqual({
          [`org:${ORG_A}`]: null,
        });
      } finally {
        unsubscribe();
      }
    },
  );
});

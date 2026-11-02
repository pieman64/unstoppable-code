/**
 * @jest-environment jsdom
 */
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import type { PipelineRunRowState } from '@/lib/pipelineRunRowState';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { useChatStore } from '@/stores/chatStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
  useLabsExperimentsStore,
} from '@/stores/labsExperimentsStore';
import { makeTestLabsSnapshot } from '@/test-utils/labsExperiments';
import { useFileLabelsStore } from '@/stores/fileLabelsStore';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { SIDEBAR_DEFAULT_WIDTH, useSidebarStore } from '@/stores/sidebarStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { initCurrentUiStateTracking } from '../initCurrentUiStateTracking';

function setCanopyPortalFlag(enabled: boolean): void {
  useFeatureFlagsStore.getState().setSnapshot({
    ...getDefaultFeatureFlagSnapshot(),
    values: {
      ...getDefaultFeatureFlagSnapshot().values,
      [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: enabled,
      [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]: false,
    },
    status: 'ready',
    initialized: true,
    updatedAt: new Date().toISOString(),
    error: null,
  });
}

beforeEach(() => {
  resetLabsExperimentsStoreForTest();
  useCurrentUiStateStore.setState({ revision: 0, slices: {} });
  useWorkspaceContextStore.setState({
    hydrated: false,
    state: { context: { kind: 'personal' }, revision: 0, organizations: [] },
  });
  useNavigationHistoryStore.getState().reset();
  useChatStore.setState({ selectedWorktree: null });
  useWorkspaceLayoutModeStore.setState({ entries: {} });
  useProjectsStore.setState({ projects: [] });
  usePipelineRunsStore.setState({
    currentCwd: null,
    currentProjectId: null,
    currentWorktreeId: null,
    summaries: [],
    statesById: {},
    rowStatesById: {},
  });
  useCanopyPortalStore.setState({
    hydrated: true,
    state: {
      status: 'disabled',
      connectionStatus: 'inactive',
      sessionId: null,
      pairingCode: null,
      hostCode: null,
      pairingCodeExpiresAt: null,
      machineName: null,
      activatedAt: null,
      lastSeenAt: null,
      lastErrorAt: null,
      error: null,
    },
  });
  useNavigationStore.setState({
    activePage: 'overview',
    settingsOpen: false,
    commandPaletteOpen: false,
    fileSearchPaletteOpen: false,
    prPickerOpen: false,
    canopyPortalOpen: false,
    appAdvisorOpen: false,
  });
  useSidebarStore.setState({
    hidden: false,
    width: SIDEBAR_DEFAULT_WIDTH,
    hydrated: true,
    codeSectionCollapsed: false,
    chatsSectionCollapsed: false,
  });
  useFileLabelsStore.setState({ hiddenLabelIds: [] });
  setCanopyPortalFlag(true);
});

describe('initCurrentUiStateTracking', () => {
  it('publishes current availablePages for Advisor on Labs changes without navigation, and unsubscribes', () => {
    const audit = {
      id: 'audit-fixture',
      pages: ['audit' as const],
      choice: true,
    };
    applyLabsExperimentsSnapshot(
      makeTestLabsSnapshot({ earlyAccess: true, experiments: [audit] }),
    );
    const dispose = initCurrentUiStateTracking();
    try {
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.availablePages,
      ).toContain('audit');
      applyLabsExperimentsSnapshot(
        makeTestLabsSnapshot({
          earlyAccess: true,
          revision: 2,
          experiments: [{ ...audit, availability: 'hidden' }],
        }),
      );
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.availablePages,
      ).not.toContain('audit');
      applyLabsExperimentsSnapshot(
        makeTestLabsSnapshot({
          earlyAccess: true,
          revision: 3,
          experiments: [audit],
        }),
      );
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.availablePages,
      ).toContain('audit');
      dispose();
      const revision = useCurrentUiStateStore.getState().revision;
      useLabsExperimentsStore.setState({ snapshot: null });
      expect(useCurrentUiStateStore.getState().revision).toBe(revision);
    } finally {
      dispose();
    }
  });
  it('recomputes on workspace context hydration and switches, and unsubscribes on disposal', (): void => {
    const dispose = initCurrentUiStateTracking();
    const initialRevision = useCurrentUiStateStore.getState().revision;
    try {
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.workspaceContext,
      ).toBeUndefined();
      useWorkspaceContextStore.setState({ hydrated: true });
      expect(useCurrentUiStateStore.getState().revision).toBe(
        initialRevision + 1,
      );
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.workspaceContext,
      ).toEqual({
        kind: 'personal',
        organizationCount: 0,
      });

      const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      useWorkspaceContextStore.getState().applyBroadcast({
        context: { kind: 'organization', organizationId },
        revision: 1,
        organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
        reason: 'switch',
      });
      expect(useCurrentUiStateStore.getState().revision).toBe(
        initialRevision + 2,
      );
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.workspaceContext,
      ).toEqual({
        kind: 'organization',
        organizationId,
        organizationCount: 1,
      });
      dispose();
      useWorkspaceContextStore.setState({ hydrated: false });
      expect(useCurrentUiStateStore.getState().revision).toBe(
        initialRevision + 2,
      );
    } finally {
      dispose();
    }
  });

  it("reports the popout nav's forwarded batch removal dialog as Work Entry batch state", () => {
    let forward: ((state: unknown) => void) | undefined;
    const unsubscribe = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        appAdvisor: {
          onWindowUiStateChanged: (callback: (state: unknown) => void) => {
            forward = callback;
            return unsubscribe;
          },
        },
      },
    });
    const windowState = {
      activeWorkEntryId: 'entry-1',
      activeChatId: null,
      navCollapsed: false,
      groupEditorId: null,
      settingsModalOpen: false,
      archivedOverviewOpen: false,
      archivedOverviewWorkspaceId: null,
      emptyTrashConfirmationOpen: false,
      emptyTrashRunning: false,
      lastArchivedOverviewRequestId: null,
      lastArchivedOverviewConfirmationOpened: null,
    };
    const dispose = initCurrentUiStateTracking();
    try {
      forward?.({
        ...windowState,
        batchRemovalDialog: {
          open: true,
          mode: 'delete',
          count: 2,
          phase: 'confirm',
        },
      });
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot
          .workEntryBatchRemovalDialog,
      ).toEqual({ open: true, mode: 'delete', count: 2, phase: 'confirm' });

      forward?.({ ...windowState, batchRemovalDialog: null });
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot
          .workEntryBatchRemovalDialog,
      ).toBeUndefined();
    } finally {
      dispose();
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('recomputes the App Advisor UI-state envelope when feature flags change', () => {
    const dispose = initCurrentUiStateTracking();
    try {
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.canopyPortal
          ?.featureEnabled,
      ).toBe(true);

      setCanopyPortalFlag(false);

      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.canopyPortal
          ?.featureEnabled,
      ).toBe(false);
    } finally {
      dispose();
    }
  });

  it('recomputes the App Advisor UI-state envelope when history changes', () => {
    const dispose = initCurrentUiStateTracking();
    try {
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.navigationHistory,
      ).toEqual({ canGoBack: false, canGoForward: false });

      useNavigationHistoryStore.setState({
        canGoBack: true,
        canGoForward: true,
      });

      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.navigationHistory,
      ).toEqual({ canGoBack: true, canGoForward: true });
    } finally {
      dispose();
    }
  });

  it('ignores pipeline detail updates but tracks pipeline selection changes', () => {
    const dispose = initCurrentUiStateTracking();
    const currentUiState = useCurrentUiStateStore.getState();
    const originalRecomputeEnvelope =
      currentUiState.recomputeEnvelope.bind(currentUiState);
    const recomputeEnvelope = jest.spyOn(
      useCurrentUiStateStore.getState(),
      'recomputeEnvelope',
    );
    try {
      // Live step output no longer passes through this store at all; cached
      // execution detail changes on every event and must not recompute.
      usePipelineRunsStore.setState({ statesById: {} });
      expect(recomputeEnvelope).not.toHaveBeenCalled();

      usePipelineRunsStore.setState({ currentProjectId: 'workspace-1' });
      expect(recomputeEnvelope).toHaveBeenCalledTimes(1);
    } finally {
      recomputeEnvelope.mockRestore();
      useCurrentUiStateStore.setState({
        recomputeEnvelope: originalRecomputeEnvelope,
      });
      dispose();
    }
  });

  it('recomputes for relevant row pause facts but ignores unrelated step events', () => {
    const summary: ExecutionSummary = {
      id: 'run-paused',
      pipeline_id: 'pipeline-paused',
      pipeline_name: 'Paused pipeline',
      status: 'paused',
      status_reasons: [],
      started_at: '2026-10-24T00:00:00.000Z',
      cwd: '/repo',
      project_id: 'workspace-1',
      worktree_id: 'worktree-1',
    };
    const row: PipelineRunRowState = {
      id: summary.id,
      status: 'paused',
      pipeline_snapshot: { jobs: {} },
      jobs: {},
      job_groups: {},
      pending_pauses: [
        {
          id: 'input-pause',
          kind: 'input',
          job_id: 'build',
          logical_job_id: 'build',
          step_id: 'input',
          request: { fields: [] },
        },
      ],
    };
    useChatStore.setState({
      selectedWorktree: {
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
      },
    });
    usePipelineRunsStore.setState({ summaries: [summary] });
    const dispose = initCurrentUiStateTracking();
    const currentUiState = useCurrentUiStateStore.getState();
    const originalRecomputeEnvelope =
      currentUiState.recomputeEnvelope.bind(currentUiState);
    const recomputeEnvelope = jest.spyOn(
      useCurrentUiStateStore.getState(),
      'recomputeEnvelope',
    );

    try {
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.activePipelineRun,
      ).not.toHaveProperty('inputRequired');

      usePipelineRunsStore.setState({
        rowStatesById: { [summary.id]: row },
      });

      expect(recomputeEnvelope).toHaveBeenCalledTimes(1);
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.activePipelineRun,
      ).toMatchObject({
        executionId: summary.id,
        inputRequired: true,
        resumable: false,
      });

      recomputeEnvelope.mockClear();
      usePipelineRunsStore.setState({
        rowStatesById: {
          [summary.id]: {
            ...row,
            jobs: {
              build: {
                status: 'running',
                steps: { compile: { status: 'running' } },
              },
            },
          },
        },
      });

      expect(recomputeEnvelope).not.toHaveBeenCalled();
    } finally {
      recomputeEnvelope.mockRestore();
      useCurrentUiStateStore.setState({
        recomputeEnvelope: originalRecomputeEnvelope,
      });
      dispose();
    }
  });

  it('recomputes the App Advisor UI-state envelope when sidebar state changes', () => {
    const dispose = initCurrentUiStateTracking();
    try {
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.sidebar,
      ).toEqual({
        hidden: false,
        previewing: false,
        previewVisible: false,
        width: SIDEBAR_DEFAULT_WIDTH,
        codeSectionCollapsed: false,
        chatsSectionCollapsed: false,
      });

      // Use `setState` directly (rather than the `setHidden` action) so this
      // test does not depend on a `window.api.savePreferences` mock — the
      // recompute wiring only cares that the store emitted a state change.
      useSidebarStore.setState({ hidden: true });

      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.sidebar,
      ).toEqual({
        hidden: true,
        previewing: false,
        previewVisible: false,
        width: SIDEBAR_DEFAULT_WIDTH,
        codeSectionCollapsed: false,
        chatsSectionCollapsed: false,
      });
    } finally {
      dispose();
    }
  });

  it('recomputes the App Advisor UI-state envelope when project layout mode changes', () => {
    const dispose = initCurrentUiStateTracking();
    const currentUiState = useCurrentUiStateStore.getState();
    const originalRecomputeEnvelope =
      currentUiState.recomputeEnvelope.bind(currentUiState);
    const recomputeEnvelope = jest.spyOn(
      useCurrentUiStateStore.getState(),
      'recomputeEnvelope',
    );
    try {
      useWorkspaceLayoutModeStore.setState({
        entries: {
          'project-1/worktree-1': {
            mode: 'minimal',
            status: 'ready',
            requestId: 1,
          },
        },
      });

      expect(recomputeEnvelope).toHaveBeenCalledTimes(1);
    } finally {
      recomputeEnvelope.mockRestore();
      useCurrentUiStateStore.setState({
        recomputeEnvelope: originalRecomputeEnvelope,
      });
      dispose();
    }
  });

  it('reports changed-file label filters and recomputes when they change', () => {
    const dispose = initCurrentUiStateTracking();
    try {
      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.changedFilesFilter,
      ).toEqual({ hiddenLabelIds: [] });

      useFileLabelsStore.setState({
        hiddenLabelIds: ['documentation', 'tests'],
      });

      expect(
        useCurrentUiStateStore.getState().envelope.snapshot.changedFilesFilter,
      ).toEqual({ hiddenLabelIds: ['documentation', 'tests'] });
    } finally {
      dispose();
    }
  });
});

/**
 * @jest-environment jsdom
 */
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
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
  });
  useCanopyPortalStore.setState({
    hydrated: true,
    state: {
      status: 'disabled',
      connectionStatus: 'inactive',
      selectedServerId: null,
      selectedServerName: null,
      selectedServerBaseUrl: null,
      sessionId: null,
      pairingCode: null,
      pairingCodeExpiresAt: null,
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

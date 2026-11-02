/**
 * @jest-environment jsdom
 */
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import { useChatStore } from '@/stores/chatStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

beforeEach(() => {
  useChatStore.setState({ selectedWorktree: null });
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
      sessionId: null,
      pairingCode: null,
      pairingCodeExpiresAt: null,
      machineName: null,
      hostCode: null,
      activatedAt: null,
      lastSeenAt: null,
      lastErrorAt: null,
      error: null,
    },
  });
  useNavigationStore.setState({
    activePage: 'main',
    settingsOpen: false,
    commandPaletteOpen: false,
    fileSearchPaletteOpen: false,
    prPickerOpen: false,
    canopyPortalOpen: false,
    appAdvisorOpen: false,
  });
  useFeatureFlagsStore.getState().setSnapshot({
    values: {
      ...getDefaultFeatureFlagSnapshot().values,
      [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
      [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]: false,
    },
    status: 'ready',
    initialized: true,
    updatedAt: new Date().toISOString(),
    error: null,
  });
});

describe('buildCurrentUiStateSnapshot archivedContainers slice', () => {
  it('reports the closed default with no optional keys when no reporter is mounted', () => {
    const snapshot = buildCurrentUiStateSnapshot({});

    // `toEqual` on the exact object also proves viewerKind / viewerTab /
    // viewerLocked / selectedChatId are absent, not merely undefined-valued.
    expect(snapshot.archivedContainers).toEqual({
      count: 0,
      viewerOpen: false,
    });
  });

  it('forwards a full reporter slice with kind, tab, and selected chat', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      archivedContainers: {
        count: 3,
        viewerOpen: true,
        viewerKind: 'work-entry',
        viewerTab: 'pipelines',
        viewerLocked: true,
        selectedChatId: 'chat-42',
        selectedPlanId: 'plan-42',
      },
    });

    expect(snapshot.archivedContainers).toEqual({
      count: 3,
      viewerOpen: true,
      viewerKind: 'work-entry',
      viewerTab: 'pipelines',
      viewerLocked: true,
      selectedChatId: 'chat-42',
      selectedPlanId: 'plan-42',
    });
  });

  it('forwards the overview-page flag reported by the Archived and deleted page', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      archivedContainers: {
        count: 2,
        viewerOpen: false,
        overviewOpen: true,
        workspaceId: 'workspace-1',
        emptyTrashConfirmationOpen: true,
      },
    });

    expect(snapshot.archivedContainers).toEqual({
      count: 2,
      viewerOpen: false,
      overviewOpen: true,
      workspaceId: 'workspace-1',
      emptyTrashConfirmationOpen: true,
    });
  });

  it('merges the App Advisor popout archive state into the authoritative snapshot', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'appAdvisor.dialogOpen': true,
      'appAdvisor.window': {
        activeWorkEntryId: 'entry-1',
        activeChatId: 'chat-1',
        navCollapsed: false,
        settingsModalOpen: false,
        archivedOverviewOpen: true,
        archivedOverviewWorkspaceId: 'app-advisor',
        emptyTrashConfirmationOpen: true,
      },
    });

    expect(snapshot.archivedContainers).toEqual({
      count: 0,
      viewerOpen: false,
      overviewOpen: true,
      workspaceId: 'app-advisor',
      emptyTrashConfirmationOpen: true,
    });
  });

  it('ignores stale archive state from a hidden App Advisor popout', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'appAdvisor.dialogOpen': false,
      'appAdvisor.window': {
        activeWorkEntryId: 'entry-1',
        activeChatId: 'chat-1',
        navCollapsed: false,
        settingsModalOpen: false,
        archivedOverviewOpen: true,
        archivedOverviewWorkspaceId: 'app-advisor',
        emptyTrashConfirmationOpen: true,
      },
    });

    expect(snapshot.archivedContainers).toEqual({
      count: 0,
      viewerOpen: false,
    });
  });

  it('accepts the worktree kind and chats tab enum values', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      archivedContainers: {
        count: 1,
        viewerOpen: true,
        viewerKind: 'worktree',
        viewerTab: 'chats',
      },
    });

    expect(snapshot.archivedContainers).toEqual({
      count: 1,
      viewerOpen: true,
      viewerKind: 'worktree',
      viewerTab: 'chats',
    });
  });

  it.each(['changes', 'attachments', 'plans'] as const)(
    'preserves the %s archive tab',
    (viewerTab) => {
      const snapshot = buildCurrentUiStateSnapshot({
        archivedContainers: {
          count: 1,
          viewerOpen: true,
          viewerKind: 'worktree',
          viewerTab,
        },
      });

      expect(snapshot.archivedContainers).toEqual({
        count: 1,
        viewerOpen: true,
        viewerKind: 'worktree',
        viewerTab,
      });
    },
  );

  it('drops invalid optional archived-container values', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      archivedContainers: {
        count: 1,
        viewerOpen: true,
        viewerKind: 'bogus-kind',
        viewerTab: 'bogus-tab',
        viewerLocked: 'yes',
        selectedChatId: { nested: 'not-a-chat-id' },
      },
    });

    expect(snapshot.archivedContainers).toEqual({
      count: 1,
      viewerOpen: true,
    });
  });

  it('falls back to safe defaults for malformed count and viewerOpen values', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      archivedContainers: {
        count: Number.NaN,
        viewerOpen: 'yes',
      },
    });

    expect(snapshot.archivedContainers).toEqual({
      count: 0,
      viewerOpen: false,
    });
  });
});

describe('buildCurrentUiStateSnapshot split project modal slice', () => {
  it('projects the modal reporter fields without free-form item data', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'worktree.splitWorkspaceModal': {
        open: true,
        workspaceId: 'temporary-workspace',
        worktreeId: 'temporary-worktree',
        repoCount: 3,
        splitCount: 1,
        archiveCount: 1,
        deleteCount: 1,
        rootRowVisible: true,
        rootSelection: 'archive',
        destinationsLoaded: true,
        errorVisible: false,
        ignoredItemTitle: 'must not be forwarded',
      },
    });

    expect(snapshot.splitWorkspaceModal).toEqual({
      open: true,
      workspaceId: 'temporary-workspace',
      worktreeId: 'temporary-worktree',
      repoCount: 3,
      splitCount: 1,
      archiveCount: 1,
      deleteCount: 1,
      rootRowVisible: true,
      rootSelection: 'archive',
      destinationsLoaded: true,
      errorVisible: false,
    });
  });

  it('omits the projection when the modal reporter is not mounted', () => {
    expect(buildCurrentUiStateSnapshot({}).splitWorkspaceModal).toBeUndefined();
  });
});

describe('buildCurrentUiStateSnapshot mobile app CTA banner slice', () => {
  it('projects pill and popover visibility without forwarding extra fields', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'mobileAppCtaBanner.pill': {
        open: true,
        popoverOpen: true,
        ignoredStoreUrl: 'https://example.com/private-campaign-url',
      },
    });

    expect(snapshot.mobileAppCtaBanner).toEqual({
      open: true,
      popoverOpen: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-campaign-url');
  });

  it('omits the banner projection when the reporter is not mounted', () => {
    const snapshot = buildCurrentUiStateSnapshot({});

    expect(snapshot.mobileAppCtaBanner).toBeUndefined();
  });
});

it('reports only validated Advisor group editor identity, excluding drafts', () => {
  const snapshot = buildCurrentUiStateSnapshot({
    'appAdvisor.window': {
      groupEditorId: 'grp-editor',
      draftName: 'private draft',
      secret: 'secret',
    },
  });
  expect(snapshot.appAdvisor?.groupEditorId).toBe('grp-editor');
  expect(JSON.stringify(snapshot)).not.toContain('private draft');
  expect(
    buildCurrentUiStateSnapshot({
      'appAdvisor.window': { groupEditorId: '../escape' },
    }).appAdvisor?.groupEditorId,
  ).toBeUndefined();
  expect(
    buildCurrentUiStateSnapshot({
      'appAdvisor.window': { groupEditorId: null },
    }).appAdvisor?.groupEditorId,
  ).toBeNull();
});

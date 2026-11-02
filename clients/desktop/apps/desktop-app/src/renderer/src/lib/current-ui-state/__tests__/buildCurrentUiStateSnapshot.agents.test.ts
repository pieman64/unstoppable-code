/**
 * @jest-environment jsdom
 */
import { registerChatHarnessAction } from '@/lib/chat-harness-actions';

import type { AppAdvisorJson } from '@canopy/desktop-shared/types';
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
import {
  applyLabsExperimentsSnapshot,
  resetLabsExperimentsStoreForTest,
} from '@/stores/labsExperimentsStore';
import {
  makeTestLabsSnapshot,
  pageExperimentsOn,
} from '@/test-utils/labsExperiments';

beforeEach(() => {
  useChatStore.setState({ selectedWorktree: null });
  resetLabsExperimentsStoreForTest();
  // The Labs page experiments are on, so their pages are reachable (CAN-3678).
  applyLabsExperimentsSnapshot(
    makeTestLabsSnapshot({ revision: 0, experiments: pageExperimentsOn() }),
  );
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
    activePage: 'plugins',
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
      // Agents (now in the Marketplace) report their share dialog only while
      // this flag is on.
      [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: true,
    },
    status: 'ready',
    initialized: true,
    updatedAt: new Date().toISOString(),
    error: null,
  });
});

describe('buildCurrentUiStateSnapshot resume queue slice', () => {
  it('projects sanitized queue progress for App Advisor', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'usage.resumeQueueModal': {
        open: true,
        paused: true,
        pending: false,
        processed: 3,
        total: 5,
        active: true,
        errorVisible: false,
      },
    });
    expect(snapshot.appAdvisor?.resumeQueueModal).toEqual({
      open: true,
      paused: true,
      pending: false,
      processed: 3,
      total: 5,
      active: true,
      errorVisible: false,
    });
  });
});

describe('buildCurrentUiStateSnapshot clone progress slice', () => {
  it('projects clone counts without names, URLs, or paths', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'projects.cloneProgressModal': {
        open: true,
        running: 2,
        failed: 1,
        percent: 37,
        repoName: 'secret-repo',
        remoteUrl: 'https://token@github.com/org/secret-repo.git',
      },
    });
    expect(snapshot.appAdvisor?.cloneProgressModal).toEqual({
      open: true,
      running: 2,
      failed: 1,
      percent: 37,
    });
  });
});

describe('buildCurrentUiStateSnapshot automations slices', () => {
  it('sanitizes curated pipeline preview state', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'pipelines.curatedPreview': {
        open: true,
        key: 'review-code',
        loading: false,
        errorVisible: true,
        rawPipeline: 'secret definition',
      },
    });

    expect(snapshot).toMatchObject({
      curatedPipelinePreview: {
        open: true,
        key: 'review-code',
        loading: false,
        errorVisible: true,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret definition');
  });

  it('preserves the Automations page review state and drops unknown fields', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'automations.page': {
        activeTab: 'scheduled',
        sharedPipelineReviewModalOpen: true,
        sharedPipelineReviewActivityId: 'activity-2',
        secretPrompt: 'do not expose',
      },
    });

    expect(snapshot.automations).toEqual({
      activeTab: 'scheduled',
      formOpen: false,
      detailsModalOpen: false,
      sharedPipelineReviewModalOpen: true,
      sharedPipelineReviewActivityId: 'activity-2',
    });
  });

  describe('form and run-history flags from the Workflows edit shell (CAN-4072)', () => {
    const page = { activeTab: 'scheduled' };
    function shell(
      overrides: Record<string, string | boolean> = {},
    ): Record<string, string | boolean> {
      return {
        kind: 'automation',
        id: 'activity-1',
        section: 'definition',
        dirty: false,
        readonly: false,
        draft: false,
        ...overrides,
      };
    }

    it('reports the form open for an editable automation', () => {
      const snapshot = buildCurrentUiStateSnapshot({
        'automations.page': page,
        'workflows.editShell': shell({ section: 'trigger', dirty: true }),
      });
      expect(snapshot.automations).toEqual({
        activeTab: 'scheduled',
        formOpen: true,
        detailsModalOpen: false,
      });
    });

    it('reports the run history open on the Runs section, with its automation', () => {
      const snapshot = buildCurrentUiStateSnapshot({
        'automations.page': page,
        'workflows.editShell': shell({ section: 'runs' }),
      });
      expect(snapshot.automations).toEqual({
        activeTab: 'scheduled',
        formOpen: true,
        detailsModalOpen: true,
        detailsModalActivityId: 'activity-1',
      });
    });

    it('reports a new draft as an open form without run history', () => {
      const snapshot = buildCurrentUiStateSnapshot({
        'automations.page': page,
        'workflows.editShell': {
          kind: 'automation',
          section: 'runs',
          dirty: false,
          readonly: false,
          draft: true,
        },
      });
      expect(snapshot.automations).toEqual({
        activeTab: 'scheduled',
        formOpen: true,
        detailsModalOpen: false,
      });
    });

    it('reports neither for a read-only shared automation', () => {
      const snapshot = buildCurrentUiStateSnapshot({
        'automations.page': page,
        'workflows.editShell': shell({
          id: 'remote-1',
          section: 'runs',
          readonly: true,
        }),
      });
      expect(snapshot.automations).toEqual({
        activeTab: 'scheduled',
        formOpen: false,
        detailsModalOpen: false,
      });
    });

    it('reports neither for a pipeline in the shell', () => {
      const snapshot = buildCurrentUiStateSnapshot({
        'automations.page': page,
        'workflows.editShell': shell({ kind: 'pipeline', section: 'runs' }),
      });
      expect(snapshot.automations).toEqual({
        activeTab: 'scheduled',
        formOpen: false,
        detailsModalOpen: false,
      });
    });

    it('reports neither when no shell is open, whatever the page claims', () => {
      const snapshot = buildCurrentUiStateSnapshot({
        'automations.page': {
          ...page,
          formOpen: true,
          detailsModalOpen: true,
          detailsModalActivityId: 'activity-1',
        },
      });
      expect(snapshot.automations).toEqual({
        activeTab: 'scheduled',
        formOpen: false,
        detailsModalOpen: false,
      });
    });
  });

  it('sanitizes the project Automations panel context and active local state', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'automations.panel.panel-overview': {
        panelId: 'panel-overview',
        variant: 'overview',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        detailsModalOpen: false,
        sharedPipelineReviewModalOpen: true,
        sharedPipelineReviewActivityId: 'activity-2',
        watcherModalOpen: true,
        watcherModalWatcherId: 'watcher-1',
        formOpen: true,
        formMode: 'edit',
        formActivityId: 'activity-1',
        secretPrompt: 'do not expose',
      },
      'automations.panel.panel-completed': {
        panelId: 'panel-completed',
        variant: 'completed',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        detailsModalOpen: false,
        watcherModalOpen: false,
        formOpen: false,
      },
    });

    expect(snapshot.automations?.panels).toEqual([
      {
        panelId: 'panel-completed',
        variant: 'completed',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        detailsModalOpen: false,
        watcherModalOpen: false,
        formOpen: false,
      },
      {
        panelId: 'panel-overview',
        variant: 'overview',
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        detailsModalOpen: false,
        sharedPipelineReviewModalOpen: true,
        sharedPipelineReviewActivityId: 'activity-2',
        watcherModalOpen: true,
        watcherModalWatcherId: 'watcher-1',
        formOpen: true,
        formMode: 'edit',
        formActivityId: 'activity-1',
      },
    ]);
  });
});

function setSharedCustomAgentsFlag(enabled: boolean): void {
  const defaults = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.setState({
    snapshot: {
      ...defaults,
      values: {
        ...defaults.values,
        [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: enabled,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    },
  });
}

const AGENT_SHARE_MODAL_SLICE: AppAdvisorJson = {
  open: true,
  localAgentId: 'agent_model_reviewer',
  sharedAgentId: 'shared-agent-1',
  state: 'stale',
  busy: true,
  copied: false,
  canUpdate: true,
  publicUrl: 'https://secret.example/share/agent',
};

describe('buildCurrentUiStateSnapshot agents slice', () => {
  it('ignores the retired Agents page slice (CAN-4266)', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'agents.page': {
        activeTab: 'local',
        localCount: 3,
        sharedCount: 1,
        selectedAgentId: 'agent_model_reviewer',
        selectedAgentName: 'Code Reviewer',
        sharedSearchQuery: 'review',
        modalMode: 'edit',
        loading: false,
        error: false,
        instructions: 'SECRET SYSTEM PROMPT',
      },
    });

    expect(snapshot.agents).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('SECRET SYSTEM PROMPT');
    expect(JSON.stringify(snapshot)).not.toContain('Code Reviewer');
  });

  it('reports sanitized public-share modal state without the public URL', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'agents.page': { activeTab: 'local', modalMode: 'share' },
      'agents.shareModal': AGENT_SHARE_MODAL_SLICE,
    });

    // Only the share dialog is reported; no Agents page fields.
    expect(snapshot.agents).toEqual({
      publicShareModal: {
        open: true,
        localAgentId: 'agent_model_reviewer',
        sharedAgentId: 'shared-agent-1',
        state: 'stale',
        busy: true,
        copied: false,
        canUpdate: true,
      },
    });
    expect(JSON.stringify(snapshot.agents)).not.toContain('secret.example');
  });

  it('drops the public-share modal while shared custom agents are off', () => {
    setSharedCustomAgentsFlag(false);

    const snapshot = buildCurrentUiStateSnapshot({
      'agents.shareModal': AGENT_SHARE_MODAL_SLICE,
    });

    expect(snapshot.agents).toBeUndefined();
  });

  it('reports the public-share modal when the flag is set on the defaults', () => {
    setSharedCustomAgentsFlag(true);

    const snapshot = buildCurrentUiStateSnapshot({
      'agents.shareModal': AGENT_SHARE_MODAL_SLICE,
    });

    expect(snapshot.agents?.publicShareModal).toMatchObject({
      open: true,
      localAgentId: 'agent_model_reviewer',
      state: 'stale',
    });
  });
});

describe('buildCurrentUiStateSnapshot plugins page agent dialog (CAN-4266)', () => {
  const basePage = {
    view: 'discovery',
    managementSection: null,
    searchActive: false,
    resultCount: 0,
  };

  it('reports the create dialog without an agent id', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'plugins.page': {
        ...basePage,
        agentDialog: 'create',
        agentDialogAgentId: 'agent-should-not-appear',
      },
    });

    expect(snapshot.plugins?.page).toMatchObject({ agentDialog: 'create' });
    expect(snapshot.plugins?.page).not.toHaveProperty('agentDialogAgentId');
  });

  it.each(['edit', 'delete'] as const)(
    'reports the %s dialog with its agent id',
    (mode) => {
      const snapshot = buildCurrentUiStateSnapshot({
        'plugins.page': {
          ...basePage,
          agentDialog: mode,
          agentDialogAgentId: 'agent_model_reviewer',
        },
      });

      expect(snapshot.plugins?.page).toMatchObject({
        agentDialog: mode,
        agentDialogAgentId: 'agent_model_reviewer',
      });
    },
  );

  it('ignores an invalid agent dialog mode', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'plugins.page': {
        ...basePage,
        agentDialog: 'share',
        agentDialogAgentId: 'agent_model_reviewer',
      },
    });

    expect(snapshot.plugins?.page).not.toHaveProperty('agentDialog');
    expect(snapshot.plugins?.page).not.toHaveProperty('agentDialogAgentId');
  });

  it('accepts a local Agent as the entry-detail ref type', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'plugins.entryDetail': {
        open: true,
        entryId: 'agent:local:agent_model_reviewer',
        refType: 'local-agent',
      },
    });

    expect(snapshot.plugins?.entryDetail).toMatchObject({
      open: true,
      entryId: 'agent:local:agent_model_reviewer',
      refType: 'local-agent',
    });
  });
});

describe('buildCurrentUiStateSnapshot settings navigation', () => {
  it('reports the active Terminal settings section to App Advisor', () => {
    useNavigationStore.setState({
      settingsOpen: true,
      settingsInitialSection: 'terminal',
    });

    expect(buildCurrentUiStateSnapshot({}).settings).toEqual({
      open: true,
      section: 'terminal',
    });
  });
});

describe('buildCurrentUiStateSnapshot file tree search slice', () => {
  it('reports explorer filter metadata without the raw query', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'files.treeSearch': {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        open: true,
        query: 'SECRET_SEARCH_TERM',
        filtering: true,
        fileContents: 'SECRET CONTENT',
      },
    });

    expect(snapshot.fileTreeSearch).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      open: true,
      filtering: true,
    });
    expect(JSON.stringify(snapshot.fileTreeSearch)).not.toContain(
      'SECRET_SEARCH_TERM',
    );
    expect(JSON.stringify(snapshot.fileTreeSearch)).not.toContain(
      'SECRET CONTENT',
    );
  });
});

describe('buildCurrentUiStateSnapshot project settings slice', () => {
  it('reports the open project settings modal and selected tab', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'workspaceSettings.modal': {
        open: true,
        workspaceId: 'cowork-settings',
        workspaceType: 'cowork',
        activeTab: 'environment',
      },
    });

    expect(snapshot.workspaceSettings).toEqual({
      open: true,
      workspaceId: 'cowork-settings',
      workspaceType: 'cowork',
      activeTab: 'environment',
    });
  });

  it('drops unrecognized project settings metadata', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'workspaceSettings.modal': {
        open: true,
        workspaceId: 'workspace-1',
        workspaceType: 'secret-kind',
        activeTab: 'secret-tab',
        instructions: 'must never leak',
      },
    });

    expect(snapshot.workspaceSettings).toEqual({
      open: true,
      workspaceId: 'workspace-1',
    });
    expect(JSON.stringify(snapshot.workspaceSettings)).not.toContain('secret');
  });
});

describe('buildCurrentUiStateSnapshot project readiness slice', () => {
  it('prefers settings state and strips recommendation prompt content', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'workspaceReadiness.overview': {
        surface: 'overview',
        status: 'ready',
        issueCount: 4,
        failedWorkspaceCount: 1,
        launching: false,
        errorVisible: false,
      },
      'workspaceReadiness.settings': {
        surface: 'settings',
        workspaceId: 'workspace-1',
        worktreeId: 'worktree-1',
        status: 'loading',
        issueCount: 2,
        launching: true,
        errorVisible: false,
        fixPrompt: 'SECRET GENERATED PROMPT',
      },
      // Settings is the one surface that can genuinely co-occur with another
      // (it is a modal overlaying whichever page is beneath), so it must win
      // over BOTH page slices — this pins the settings ?? overview ?? home
      // order against a reorder that every other test would miss.
      'workspaceReadiness.home': {
        surface: 'home',
        workspaceId: 'workspace-2',
        status: 'ready',
        issueCount: 3,
        launching: false,
        errorVisible: false,
      },
    });

    expect(snapshot.workspaceReadiness).toEqual({
      surface: 'settings',
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
      status: 'loading',
      issueCount: 2,
      launching: true,
      errorVisible: false,
    });
    expect(JSON.stringify(snapshot.workspaceReadiness)).not.toContain('SECRET');
  });

  it('accepts the New Task page surface when no other readiness slice exists', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'workspaceReadiness.home': {
        surface: 'home',
        workspaceId: 'workspace-1',
        status: 'ready',
        issueCount: 3,
        launching: false,
        errorVisible: false,
      },
    });

    expect(snapshot.workspaceReadiness).toEqual({
      surface: 'home',
      workspaceId: 'workspace-1',
      status: 'ready',
      issueCount: 3,
      launching: false,
      errorVisible: false,
    });
  });
});

describe('buildCurrentUiStateSnapshot pull request slice', () => {
  it('reports Git action cancellation state without accepting extra fields', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'worktree.pullRequest': {
        gitActionInProgress: true,
        gitActionCancellationRequested: true,
        privateOperationId: 'operation-secret',
      },
    });

    expect(snapshot.pullRequest).toMatchObject({
      gitActionInProgress: true,
      gitActionCancellationRequested: true,
    });
    expect(snapshot.pullRequest).not.toHaveProperty('privateOperationId');
  });
});

describe('buildCurrentUiStateSnapshot plugins page collection editor', () => {
  it('projects whether the create-mode collection editor is open', () => {
    const open = buildCurrentUiStateSnapshot({
      'plugins.page': {
        view: 'discovery',
        managementSection: null,
        searchActive: false,
        resultCount: 0,
        createCollectionOpen: true,
      },
    });
    expect(open.plugins?.page).toMatchObject({ createCollectionOpen: true });

    const closed = buildCurrentUiStateSnapshot({
      'plugins.page': {
        view: 'discovery',
        managementSection: null,
        searchActive: false,
        resultCount: 0,
        createCollectionOpen: false,
      },
    });
    expect(closed.plugins?.page).not.toHaveProperty('createCollectionOpen');
  });
});

describe('buildCurrentUiStateSnapshot plugins page skill editor', () => {
  it('projects whether a custom skill edit page is open', () => {
    const open = buildCurrentUiStateSnapshot({
      'plugins.page': {
        view: 'discovery',
        managementSection: null,
        searchActive: false,
        resultCount: 0,
        selectedEntryId: 'skill:custom:app:review-checklist',
        skillEditorOpen: true,
      },
    });
    expect(open.plugins?.page).toMatchObject({ skillEditorOpen: true });

    const closed = buildCurrentUiStateSnapshot({
      'plugins.page': {
        view: 'discovery',
        managementSection: null,
        searchActive: false,
        resultCount: 0,
        skillEditorOpen: false,
      },
    });
    expect(closed.plugins?.page).not.toHaveProperty('skillEditorOpen');
  });
});

describe('buildCurrentUiStateSnapshot skill detail slice', () => {
  it('sanitizes Customize destination and Installed filter metadata (CAN-4267)', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'plugins.page': {
        view: 'discovery',
        customizeTab: 'skill',
        installedStatusFilter: 'active',
        installedExpanded: true,
        query: 'SECRET SEARCH',
        category: 'SECRET CATEGORY',
      },
    });
    expect(snapshot.plugins?.page).toMatchObject({
      customizeTab: 'skill',
      installedStatusFilter: 'active',
      installedExpanded: true,
    });
    expect(JSON.stringify(snapshot.plugins?.page)).not.toContain('SECRET');
    const disabled = buildCurrentUiStateSnapshot({
      'plugins.page': {
        view: 'discovery',
        customizeTab: 'all',
        installedStatusFilter: 'disabled',
      },
    });
    expect(disabled.plugins?.page).toMatchObject({
      installedStatusFilter: 'disabled',
    });
    const invalid = buildCurrentUiStateSnapshot({
      'plugins.page': {
        view: 'discovery',
        customizeTab: 'SECRET TAB',
        installedStatusFilter: 'SECRET STATUS',
      },
    });
    expect(invalid.plugins?.page).not.toHaveProperty('customizeTab');
    expect(invalid.plugins?.page).not.toHaveProperty('installedStatusFilter');
  });

  it('projects Plugins entry-detail navigation metadata without pipeline contents', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'plugins.page': {
        view: 'discovery',
        managementSection: null,
        searchActive: false,
        resultCount: 4,
        selectedEntryId: 'skill:builtin:app:review-checklist',
        detailHistoryDepth: 2,
        detailBackTarget: 'pipeline',
        returnToPipeline: { yaml: 'SECRET PIPELINE CONTENT' },
      },
    });

    expect(snapshot.plugins?.page).toEqual({
      view: 'discovery',
      searchActive: false,
      resultCount: 4,
      selectedEntryId: 'skill:builtin:app:review-checklist',
      detailHistoryDepth: 2,
      detailBackTarget: 'pipeline',
    });
    expect(JSON.stringify(snapshot.plugins?.page)).not.toContain('SECRET');
  });

  it('reports multi-file viewer state without accepting file contents', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'plugins.page': {
        view: 'management',
        managementSection: 'skills',
        searchActive: false,
        resultCount: 0,
      },
      'plugins.skillDetail': {
        open: true,
        sourceId: 'custom:app',
        skillName: 'review-checklist',
        loading: false,
        errorVisible: false,
        fileCount: 3,
        filesTruncated: false,
        treeOpen: true,
        openTabs: ['references/api.md'],
        activeFile: 'references/api.md',
        content: 'SECRET FILE CONTENT',
        absolutePath: '/private/review-checklist/references/api.md',
      },
    });

    expect(snapshot.plugins?.skillDetail).toEqual({
      open: true,
      sourceId: 'custom:app',
      skillName: 'review-checklist',
      loading: false,
      errorVisible: false,
      fileCount: 3,
      filesTruncated: false,
      treeOpen: true,
      openTabs: ['references/api.md'],
      activeFile: 'references/api.md',
    });
    const serialized = JSON.stringify(snapshot.plugins?.skillDetail);
    expect(serialized).not.toContain('SECRET FILE CONTENT');
    expect(serialized).not.toContain('/private/');
  });
});

describe('buildCurrentUiStateSnapshot session transfer slice', () => {
  it('reports sanitized base-branch confirmation metadata', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'worktree.baseBranchChangeConfirmationModal': {
        open: true,
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-1',
        baseBranch: 'release/next',
        prNumber: 42.8,
        repoPath: '/private/repository',
        pullRequestBody: 'SECRET REVIEW CONTENT',
      },
    });

    expect(snapshot.baseBranchChangeConfirmationModal).toEqual({
      open: true,
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repoId: 'repo-1',
      baseBranch: 'release/next',
      prNumber: 42,
    });
    const serialized = JSON.stringify(
      snapshot.baseBranchChangeConfirmationModal,
    );
    expect(serialized).not.toContain('/private/repository');
    expect(serialized).not.toContain('SECRET REVIEW CONTENT');
  });

  it('reports only import-modal visibility and its destination project', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.importSessionModal': {
        open: true,
        workspaceId: 'workspace-a',
        sourcePath: '/tmp/private/session-export',
        manifest: { transcript: 'SECRET TRANSCRIPT' },
      },
    });

    expect(snapshot.importSessionModal).toEqual({
      open: true,
      workspaceId: 'workspace-a',
    });
    expect(JSON.stringify(snapshot.importSessionModal)).not.toContain(
      'SECRET TRANSCRIPT',
    );
    expect(JSON.stringify(snapshot.importSessionModal)).not.toContain(
      '/tmp/private',
    );
  });

  it('omits the import-modal slice when no reporter is mounted', () => {
    const snapshot = buildCurrentUiStateSnapshot({});

    expect(snapshot.importSessionModal).toBeUndefined();
  });

  it('reports only Cursor rules review visibility and its entry point', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.repoRulesModal': {
        open: true,
        source: 'app-advisor',
        workspaceId: 'workspace-a',
        rulePath: '/private/repo/.cursor/rules/secret.mdc',
        ruleText: 'SECRET RULE BODY',
      },
    });

    expect(snapshot.repoRulesModal).toEqual({
      open: true,
      source: 'app-advisor',
    });
    const serialized = JSON.stringify(snapshot.repoRulesModal);
    expect(serialized).not.toContain('workspace-a');
    expect(serialized).not.toContain('/private/repo');
    expect(serialized).not.toContain('SECRET RULE BODY');
  });

  it('drops an unknown Cursor rules review entry point', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.repoRulesModal': { open: true, source: '/private/path' },
    });

    expect(snapshot.repoRulesModal).toEqual({ open: true });
  });

  it('omits the Cursor rules review slice when no reporter is mounted', () => {
    expect(buildCurrentUiStateSnapshot({}).repoRulesModal).toBeUndefined();
  });

  it('reports only export-confirmation visibility', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.exportSessionConfirmationModal': {
        open: true,
        transcript: 'SECRET TRANSCRIPT',
        destination: '/tmp/private/session-export',
      },
    });

    expect(snapshot.exportSessionConfirmationModal).toEqual({ open: true });
    expect(
      JSON.stringify(snapshot.exportSessionConfirmationModal),
    ).not.toContain('SECRET TRANSCRIPT');
    expect(
      JSON.stringify(snapshot.exportSessionConfirmationModal),
    ).not.toContain('/tmp/private');
  });

  it('omits the export-confirmation slice when no reporter is mounted', () => {
    const snapshot = buildCurrentUiStateSnapshot({});

    expect(snapshot.exportSessionConfirmationModal).toBeUndefined();
  });

  it('reports only the bounded share-status modal phase', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.shareSessionStatusModal': {
        open: true,
        phase: 'sharing',
        response: { exportId: 'secret-export-id' },
        message: 'PRIVATE ERROR DETAILS',
      },
    });

    expect(snapshot.shareSessionStatusModal).toEqual({
      open: true,
      phase: 'sharing',
    });
    expect(JSON.stringify(snapshot.shareSessionStatusModal)).not.toContain(
      'secret-export-id',
    );
    expect(JSON.stringify(snapshot.shareSessionStatusModal)).not.toContain(
      'PRIVATE ERROR DETAILS',
    );
  });

  it('omits the share-status modal slice when no reporter is mounted', () => {
    const snapshot = buildCurrentUiStateSnapshot({});

    expect(snapshot.shareSessionStatusModal).toBeUndefined();
  });
});

describe('buildCurrentUiStateSnapshot memory-used dialog slice', () => {
  it('reports only bounded dialog state', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.memoryUsedDialog': {
        open: true,
        factCount: 3,
        facts: [{ factText: 'must not leak' }],
      },
    });

    expect(snapshot.memoryUsedDialog).toEqual({
      open: true,
      factCount: 3,
    });
    expect(JSON.stringify(snapshot.memoryUsedDialog)).not.toContain(
      'must not leak',
    );
  });

  it('omits the dialog when no reporter is mounted', () => {
    expect(buildCurrentUiStateSnapshot({}).memoryUsedDialog).toBeUndefined();
  });
});

describe('buildCurrentUiStateSnapshot active chat selection context', () => {
  it('reports only the staged-selection count and drops selection contents', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.activeTab': {
        chatId: 'chat-a',
        title: 'Chat A',
        status: 'idle',
        approvalMode: 'auto',
        stagedSelectionCount: 2,
        stagedSelections: [
          {
            path: '/secret/repo/file.ts',
            text: 'SECRET SELECTED SOURCE',
          },
        ],
      },
    });

    expect(snapshot.activeChat).toMatchObject({
      chatId: 'chat-a',
      approvalMode: 'auto',
      stagedSelectionCount: 2,
    });
    expect(JSON.stringify(snapshot.activeChat)).not.toContain('/secret/');
    expect(JSON.stringify(snapshot.activeChat)).not.toContain(
      'SECRET SELECTED SOURCE',
    );
  });

  it('reports sanitized chat-state recovery controls', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.activeTab': { chatId: 'chat-a', title: 'Chat A' },
      'chat.stateRecovery': {
        phase: 'refresh_error',
        noticeKind: 'conflict',
        retryAvailable: true,
        dismissAvailable: true,
        noticeMessage: 'SECRET CONFLICT DETAILS',
        error: '/secret/chat-state.json',
      },
    });

    expect(snapshot.activeChat?.stateRecovery).toEqual({
      phase: 'refresh_error',
      noticeKind: 'conflict',
      retryAvailable: true,
      dismissAvailable: true,
    });
    expect(JSON.stringify(snapshot.activeChat?.stateRecovery)).not.toContain(
      'SECRET CONFLICT DETAILS',
    );
    expect(JSON.stringify(snapshot.activeChat?.stateRecovery)).not.toContain(
      '/secret/',
    );
  });

  it('reports bounded background-process state for the active chat', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.activeTab': { chatId: 'chat-a', title: 'Chat A' },
      'chat.backgroundProcesses': {
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        total: 3,
        running: 2,
        detailModalOpen: true,
        selectedTaskId: 'task-a',
        outputLines: ['SECRET OUTPUT'],
        outputFile: '/secret/task.output',
      },
    });

    expect(snapshot.activeChat?.backgroundProcesses).toEqual({
      total: 3,
      running: 2,
      detailModalOpen: true,
      selectedTaskId: 'task-a',
    });
    expect(JSON.stringify(snapshot.activeChat)).not.toContain('SECRET');
    expect(JSON.stringify(snapshot.activeChat)).not.toContain('/secret/');
  });

  it('normalizes command-failure recovery notices for App Advisor', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.activeTab': { chatId: 'chat-a', title: 'Chat A' },
      'chat.stateRecovery': {
        noticeKind: 'command_failed',
        retryAvailable: false,
        dismissAvailable: true,
      },
    });

    expect(snapshot.activeChat?.stateRecovery).toEqual({
      noticeKind: 'failure',
      retryAvailable: false,
      dismissAvailable: true,
    });
  });

  it('drops invalid active-chat approval modes', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.activeTab': {
        chatId: 'chat-a',
        approvalMode: 'unrestricted',
      },
    });

    expect(snapshot.activeChat).toEqual({ chatId: 'chat-a' });
  });
});

describe('buildCurrentUiStateSnapshot settings slices', () => {
  it('reports sanitized Code Graph controls without arbitrary fields', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.codeGraph': {
        loaded: true,
        mode: 'selected-workspaces',
        selectedWorkspaceIds: ['workspace-a', 42],
        generationTimeoutMinutes: 30,
        timeoutDraftMinutes: 45,
        saving: false,
        saveErrorVisible: false,
        timeoutErrorVisible: true,
        secret: 'do not expose',
      },
    });

    expect(snapshot.settings?.codeGraph).toEqual({
      loaded: true,
      mode: 'selected-workspaces',
      selectedWorkspaceIds: ['workspace-a'],
      generationTimeoutMinutes: 30,
      timeoutDraftMinutes: 45,
      saving: false,
      saveErrorVisible: false,
      timeoutErrorVisible: true,
    });
    expect(JSON.stringify(snapshot.settings?.codeGraph)).not.toContain(
      'do not expose',
    );
  });

  it('reports sanitized local memory panel state without arbitrary fields', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.localMemory': {
        loaded: true,
        enabled: false,
        memoryDirPath: '/secret/memory-folder',
      },
    });

    expect(snapshot.settings?.localMemory).toEqual({
      loaded: true,
      enabled: false,
    });
    expect(JSON.stringify(snapshot.settings)).not.toContain('/secret/');
  });

  it('reports the daily free AI Credits opt-in without arbitrary fields', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.dailyCreditDrip': {
        loaded: true,
        available: true,
        enabled: true,
        decided: true,
        accountEmail: 'secret@example.com',
      },
    });

    expect(snapshot.settings?.dailyCreditDrip).toEqual({
      loaded: true,
      available: true,
      enabled: true,
      decided: true,
    });
    expect(JSON.stringify(snapshot.settings)).not.toContain('secret@');
  });

  it('defaults malformed daily free AI Credits fields to false', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.dailyCreditDrip': { loaded: true, enabled: 'yes' },
    });

    expect(snapshot.settings?.dailyCreditDrip).toEqual({
      loaded: true,
      available: false,
      enabled: false,
      decided: false,
    });
  });

  it('reports the profile role without the user-authored detail text', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.profileRole': {
        loaded: true,
        role: 'designer',
        // The free-text detail is user-authored content, excluded from the
        // snapshot for the same reason it is excluded from telemetry.
        profileRoleDetail: 'my secret job description',
      },
    });

    expect(snapshot.settings?.profileRole).toEqual({
      loaded: true,
      role: 'designer',
    });
    expect(JSON.stringify(snapshot.settings)).not.toContain('secret job');
  });

  it('reports the navigation mode from the General settings tab', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.navigationMode': { loaded: true, mode: 'work' },
    });
    expect(snapshot.settings?.navigationMode).toEqual({
      loaded: true,
      mode: 'work',
    });
  });

  it('reports sanitized managed consultation state', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.managedDelegation': {
        loaded: true,
        mode: 'off',
        maxDepth: 7,
        revocationIncomplete: true,
        childSessionIds: ['secret-child'],
      },
    });

    expect(snapshot.settings?.managedDelegation).toEqual({
      loaded: true,
      mode: 'off',
      maxDepth: 7,
      revocationIncomplete: true,
    });
    expect(JSON.stringify(snapshot.settings)).not.toContain('secret-child');
  });

  it('reports an unset profile role as null rather than omitting it', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.profileRole': { loaded: true, role: null },
    });

    expect(snapshot.settings?.profileRole).toEqual({
      loaded: true,
      role: null,
    });
  });

  it('reports sanitized Code Graph detail-panel state', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'codeGraph.detailPanel': {
        scope: 'worktree',
        workspaceId: 'workspace-a',
        worktreeId: 'worktree-a',
        phase: 'loaded',
        state: 'partial',
        enabled: true,
        building: false,
        repositoryCount: 2,
        loadErrorVisible: false,
        buildErrorVisible: true,
        canonicalRepoRoot: '/secret/repo/path',
      },
    });

    expect(snapshot.codeGraphPanel).toEqual({
      scope: 'worktree',
      workspaceId: 'workspace-a',
      worktreeId: 'worktree-a',
      phase: 'loaded',
      state: 'partial',
      enabled: true,
      building: false,
      repositoryCount: 2,
      loadErrorVisible: false,
      buildErrorVisible: true,
    });
    expect(JSON.stringify(snapshot.codeGraphPanel)).not.toContain('/secret/');
  });
});

describe('buildCurrentUiStateSnapshot worktree archive dialog slice', () => {
  it('reports the open removal confirmation and drops unrecognized fields', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'worktree.archiveDialog.worktree-a': {
        open: true,
        workspaceId: 'workspace-a',
        worktreeId: 'worktree-a',
        branchName: 'feature/archive-me',
        branchChoiceMenuOpen: true,
        archiveInProgress: false,
        blocked: false,
        checkoutPath: '/secret/worktree/path',
      },
    });

    expect(snapshot.worktreeArchiveDialog).toEqual({
      open: true,
      workspaceId: 'workspace-a',
      worktreeId: 'worktree-a',
      branchName: 'feature/archive-me',
      archiveInProgress: false,
      blocked: false,
    });
    expect(JSON.stringify(snapshot.worktreeArchiveDialog)).not.toContain(
      '/secret/',
    );
  });

  it('ignores closed or incomplete worktree archive dialog slices', () => {
    expect(
      buildCurrentUiStateSnapshot({
        'worktree.archiveDialog.closed': {
          open: false,
          workspaceId: 'workspace-a',
          worktreeId: 'worktree-a',
        },
      }).worktreeArchiveDialog,
    ).toBeUndefined();
    expect(
      buildCurrentUiStateSnapshot({
        'worktree.archiveDialog.incomplete': { open: true },
      }).worktreeArchiveDialog,
    ).toBeUndefined();
  });
});

describe('buildCurrentUiStateSnapshot worktree batch removal slice', () => {
  it('reports the open bulk removal dialog (CAN-3975) and drops other fields', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'worktree.batchRemovalDialog': {
        open: true,
        mode: 'archive',
        count: 3,
        phase: 'running',
        worktreeIds: ['secret-a'],
      },
    });
    expect(snapshot.worktreeBatchRemovalDialog).toEqual({
      open: true,
      mode: 'archive',
      count: 3,
      phase: 'running',
    });
  });

  it('reports a batch running in the background with no dialog open', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'worktree.batchRemovalDialog': {
        open: false,
        mode: 'delete',
        count: 2,
        phase: 'running',
      },
    });
    expect(snapshot.worktreeBatchRemovalDialog).toEqual({
      open: false,
      mode: 'delete',
      count: 2,
      phase: 'running',
    });
  });

  it('ignores a closed or malformed batch removal slice', () => {
    expect(
      buildCurrentUiStateSnapshot({
        'worktree.batchRemovalDialog': {
          open: false,
          mode: 'archive',
          count: 1,
          phase: 'confirm',
        },
      }).worktreeBatchRemovalDialog,
    ).toBeUndefined();
    expect(
      buildCurrentUiStateSnapshot({
        'worktree.batchRemovalDialog': {
          open: false,
          mode: 'archive',
          count: 1,
          phase: 'results',
        },
      }).worktreeBatchRemovalDialog,
    ).toBeUndefined();
    expect(
      buildCurrentUiStateSnapshot({
        'worktree.batchRemovalDialog': {
          open: true,
          mode: 'erase',
          count: 1,
          phase: 'confirm',
        },
      }).worktreeBatchRemovalDialog,
    ).toBeUndefined();
  });
});

describe('buildCurrentUiStateSnapshot Work Entry batch removal slice', () => {
  it('reports the open bulk chat removal dialog and drops other fields', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'workEntry.batchRemovalDialog': {
        open: true,
        mode: 'delete',
        count: 2,
        phase: 'results',
        entryIds: ['secret-a'],
      },
    });
    expect(snapshot.workEntryBatchRemovalDialog).toEqual({
      open: true,
      mode: 'delete',
      count: 2,
      phase: 'results',
    });
    expect(snapshot.worktreeBatchRemovalDialog).toBeUndefined();
  });

  it('falls back to the App Advisor nav dialog and prefers the main rail', () => {
    const appAdvisorDialog = {
      open: true,
      mode: 'archive',
      count: 4,
      phase: 'running',
    };
    expect(
      buildCurrentUiStateSnapshot({
        'appAdvisor.batchRemovalDialog': appAdvisorDialog,
      }).workEntryBatchRemovalDialog,
    ).toEqual(appAdvisorDialog);
    expect(
      buildCurrentUiStateSnapshot({
        'workEntry.batchRemovalDialog': {
          open: true,
          mode: 'delete',
          count: 1,
          phase: 'confirm',
        },
        'appAdvisor.batchRemovalDialog': appAdvisorDialog,
      }).workEntryBatchRemovalDialog,
    ).toEqual({ open: true, mode: 'delete', count: 1, phase: 'confirm' });
    expect(
      buildCurrentUiStateSnapshot({
        'workEntry.batchRemovalDialog': {
          open: false,
          mode: 'delete',
          count: 1,
          phase: 'confirm',
        },
        'appAdvisor.batchRemovalDialog': appAdvisorDialog,
      }).workEntryBatchRemovalDialog,
    ).toEqual(appAdvisorDialog);
  });

  it('ignores a closed or malformed Work Entry batch removal slice', () => {
    expect(
      buildCurrentUiStateSnapshot({
        'workEntry.batchRemovalDialog': {
          open: false,
          mode: 'archive',
          count: 1,
          phase: 'confirm',
        },
      }).workEntryBatchRemovalDialog,
    ).toBeUndefined();
    expect(
      buildCurrentUiStateSnapshot({
        'workEntry.batchRemovalDialog': {
          open: true,
          mode: 'archive',
          count: 1,
          phase: 'pending',
        },
      }).workEntryBatchRemovalDialog,
    ).toBeUndefined();
    expect(
      buildCurrentUiStateSnapshot({
        'workEntry.batchRemovalDialog': {
          open: true,
          mode: 'archive',
          phase: 'confirm',
        },
      }).workEntryBatchRemovalDialog,
    ).toBeUndefined();
  });
});

describe('buildCurrentUiStateSnapshot home slice', () => {
  it('reports compact Home metadata and drops prompt/path details', () => {
    useNavigationStore.setState({ activePage: 'home' });

    const snapshot = buildCurrentUiStateSnapshot({
      'home.surface': {
        variant: 'page',
        workspaceSelected: true,
        workspaceId: 'workspace-a',
        workspaceName: 'Workspace A',
        workspaceType: 'multi-repo',
        mode: 'chat',
        targetKind: 'branch',
        branchName: 'feature/foo',
        attachmentCount: 2,
        fileReferenceCount: 1,
        scheduledDraft: true,
        pluginSelectionsActive: true,
        discoveryLoading: false,
        fileIndexLoading: true,
        sendErrorVisible: false,
        inlineSlashMenuOpen: true,
        startupResumeOfferVisible: true,
        startupResumeOfferKind: 'worktree',
        prompt: 'SECRET DRAFT',
        attachmentPaths: ['/tmp/secret.png'],
        fileReferences: [{ absolutePath: '/repo/secret.ts' }],
      },
      'home.controls': {
        scheduleModalOpen: true,
        linearPickerOpen: false,
        scheduleDisabledByAttachments: true,
        scheduleDisabledByCursor: false,
      },
      'home.toolbar': {
        plusMenuOpen: true,
      },
      'home.interruptedSessionsBanner': {
        visible: true,
        count: 3,
      },
    });

    expect(snapshot.home).toEqual({
      variant: 'page',
      workspaceSelected: true,
      workspaceId: 'workspace-a',
      workspaceName: 'Workspace A',
      workspaceType: 'multi-repo',
      mode: 'chat',
      targetKind: 'branch',
      branchName: 'feature/foo',
      attachmentCount: 2,
      fileReferenceCount: 1,
      scheduledDraft: true,
      pluginSelectionsActive: true,
      discoveryLoading: false,
      fileIndexLoading: true,
      sendErrorVisible: false,
      inlineSlashMenuOpen: true,
      startupResumeOfferVisible: true,
      startupResumeOfferKind: 'worktree',
      interruptedSessionsBannerVisible: true,
      interruptedSessionCount: 3,
      plusMenuOpen: true,
      scheduleModalOpen: true,
      linearPickerOpen: false,
      scheduleDisabledByAttachments: true,
      scheduleDisabledByCursor: false,
    });
    expect(JSON.stringify(snapshot.home)).not.toContain('SECRET');
    expect(JSON.stringify(snapshot.home)).not.toContain('/tmp/secret.png');
    expect(JSON.stringify(snapshot.home)).not.toContain('/repo/secret.ts');
  });

  it('reports Continue attention counts only when page Home publishes them (CAN-4958)', () => {
    useNavigationStore.setState({ activePage: 'home' });
    const surface = { variant: 'page', workspaceSelected: true, mode: 'chat' };

    const reported = buildCurrentUiStateSnapshot({
      'home.surface': surface,
      'home.continueAttention': {
        questionCount: 1,
        toolApprovalCount: 0,
        planReviewCount: 2,
        unreadCount: 3,
        lastViewedVisible: true,
      },
    });
    const absent = buildCurrentUiStateSnapshot({ 'home.surface': surface });

    expect(reported.home?.continueAttention).toEqual({
      questionCount: 1,
      toolApprovalCount: 0,
      planReviewCount: 2,
      unreadCount: 3,
      lastViewedVisible: true,
    });
    expect(absent.home).not.toHaveProperty('continueAttention');
  });

  it('reports interrupted-session readiness counts with the Home banner', () => {
    useNavigationStore.setState({ activePage: 'home' });
    const surface = { variant: 'page', workspaceSelected: true, mode: 'chat' };
    const snapshot = buildCurrentUiStateSnapshot({
      'home.surface': surface,
      'home.interruptedSessionsBanner': {
        visible: true,
        count: 3,
        readyCount: 2,
        waitingCount: 1,
      },
    });
    expect(snapshot.home).toMatchObject({
      interruptedSessionsBannerVisible: true,
      interruptedSessionCount: 3,
      interruptedSessionReadyCount: 2,
      interruptedSessionWaitingCount: 1,
    });
    const empty = buildCurrentUiStateSnapshot({
      'home.surface': surface,
      'home.interruptedSessionsBanner': {
        visible: false,
        count: 0,
        readyCount: 0,
        waitingCount: 0,
      },
    });
    expect(empty.home).not.toHaveProperty('interruptedSessionReadyCount');
    expect(empty.home).not.toHaveProperty('interruptedSessionWaitingCount');
  });

  it('reports the MCP sign-in strip only while it shows', () => {
    useNavigationStore.setState({ activePage: 'home' });
    const surface = { variant: 'page', workspaceSelected: true, mode: 'chat' };

    const shown = buildCurrentUiStateSnapshot({
      'home.surface': surface,
      'home.mcpSignIn': {
        visible: true,
        setupOpen: true,
        servers: [
          { name: 'Linear', status: 'not_signed_in', pending: true },
          { name: 'Slack', status: 'needs_reconnecting', pending: false },
          { name: 'Docs', status: 'signed_in', pending: false },
          { status: 'not_signed_in', pending: false },
        ],
        token: 'SECRET',
      },
    });
    expect(shown.home?.mcpSignIn).toEqual({
      setupOpen: true,
      servers: [
        { name: 'Linear', status: 'not_signed_in', pending: true },
        { name: 'Slack', status: 'needs_reconnecting', pending: false },
      ],
    });
    expect(JSON.stringify(shown.home)).not.toContain('SECRET');

    const hidden = buildCurrentUiStateSnapshot({
      'home.surface': surface,
      'home.mcpSignIn': { visible: false, setupOpen: false, servers: [] },
    });
    expect(hidden.home).not.toHaveProperty('mcpSignIn');
  });
});

describe('buildCurrentUiStateSnapshot shared-container slice', () => {
  it('projects a bounded recipient identity list and drops extra fields', () => {
    const recipients = Array.from({ length: 55 }, (_, index) => ({
      userId: `user-${index}`,
      name: `Person ${index}`,
      email: `secret-${index}@example.test`,
      grantId: `grant-${index}`,
    }));

    const snapshot = buildCurrentUiStateSnapshot({
      'sharedContainers.inviteModal': {
        open: true,
        containerId: 'container-1',
        organizationId: 'org-1',
        recipients,
      },
    });

    expect(snapshot.sharedContainersInviteModal?.recipients).toHaveLength(50);
    expect(snapshot.sharedContainersInviteModal?.recipients?.[0]).toEqual({
      userId: 'user-0',
      name: 'Person 0',
    });
    expect(JSON.stringify(snapshot.sharedContainersInviteModal)).not.toContain(
      'secret-0@example.test',
    );
    expect(JSON.stringify(snapshot.sharedContainersInviteModal)).not.toContain(
      'grant-0',
    );
  });

  it('reports whether the invite modal ships the preferred layout and when it was pinned', () => {
    const pinned = buildCurrentUiStateSnapshot({
      'sharedContainers.inviteModal': {
        open: true,
        preferredLayoutEnabled: true,
        preferredLayoutPinnedAt: '2026-10-13T00:00:00.000Z',
      },
    });
    expect(pinned.sharedContainersInviteModal).toEqual(
      expect.objectContaining({
        preferredLayoutEnabled: true,
        preferredLayoutPinnedAt: '2026-10-13T00:00:00.000Z',
      }),
    );

    // Off, or on with nothing pinned yet, reports no pin time.
    const off = buildCurrentUiStateSnapshot({
      'sharedContainers.inviteModal': {
        open: true,
        preferredLayoutEnabled: false,
        preferredLayoutPinnedAt: null,
      },
    });
    expect(off.sharedContainersInviteModal?.preferredLayoutEnabled).toBe(false);
    expect(off.sharedContainersInviteModal).not.toHaveProperty(
      'preferredLayoutPinnedAt',
    );

    // A slice that does not report the layout leaves both fields out.
    const absent = buildCurrentUiStateSnapshot({
      'sharedContainers.inviteModal': { open: true },
    });
    expect(absent.sharedContainersInviteModal).not.toHaveProperty(
      'preferredLayoutEnabled',
    );
  });

  it('reports an email recipient by grant id only, never its address, plus the audience', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'sharedContainers.inviteModal': {
        open: true,
        containerId: 'container-1',
        audience: 'public',
        availableAudiences: ['organization', 'public', 'bogus'],
        status: 'sharing',
        committed: true,
        // Removed lifecycle fields must not leak back into the snapshot.
        tab: 'invite',
        modalState: 'success',
        blockedReason: 'external-sharing-disabled',
        recipients: [
          {
            grantId: 'grant-email',
            kind: 'email',
            email: 'friend@example.test',
            status: 'invited',
          },
        ],
      },
    });

    expect(snapshot.sharedContainersInviteModal).toEqual(
      expect.objectContaining({
        audience: 'public',
        availableAudiences: ['organization', 'public'],
        status: 'sharing',
        committed: true,
        blockedReason: 'external-sharing-disabled',
        recipients: [
          { grantId: 'grant-email', kind: 'email', status: 'invited' },
        ],
      }),
    );
    expect(JSON.stringify(snapshot.sharedContainersInviteModal)).not.toContain(
      'friend@example.test',
    );
    // A personal container has no organization to report.
    expect(snapshot.sharedContainersInviteModal).not.toHaveProperty(
      'organizationId',
    );
    expect(snapshot.sharedContainersInviteModal).not.toHaveProperty('tab');
    expect(snapshot.sharedContainersInviteModal).not.toHaveProperty(
      'modalState',
    );
  });
});

describe('retired Getting started UI projection', () => {
  it('ignores stale checklist slices', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'home.surface': { workspaceSelected: true },
      'home.onboardingSuggestions': {
        open: true,
        entries: ['roles:choose-roles'],
      },
    });
    expect(snapshot.home).not.toHaveProperty('onboardingSuggestions');
  });
});

it('reports Cursor setup and approval-check state without paths, errors, or credentials', () => {
  useNavigationStore.setState({
    settingsOpen: true,
    settingsInitialSection: 'experiments',
  });
  const snapshot = buildCurrentUiStateSnapshot({
    'settings.cursor': {
      loaded: true,
      supported: true,
      enabled: false,
      installed: true,
      busy: true,
      phase: 'signing-in',
      errorVisible: false,
      token: 'secret',
      binaryPath: '/private/runtime',
    },
    'settings.cursorApprovalCheck': {
      available: true,
      configured: true,
      running: true,
      awaitingApproval: true,
      outcome: 'allowed',
      errorVisible: false,
      filePath: '/private/result.txt',
      error: 'secret failure',
    },
  });
  expect(snapshot.settings?.cursor).toEqual({
    loaded: true,
    supported: true,
    enabled: false,
    installed: true,
    busy: true,
    phase: 'signing-in',
    errorVisible: false,
  });
  // Every phase on the wire must survive the allowlist; one that is dropped
  // silently reports the panel as having no phase at all.
  for (const phase of [
    'idle',
    'downloading',
    'verifying',
    'installing',
    'signing-out',
    'signing-in',
    'connected',
  ]) {
    expect(
      buildCurrentUiStateSnapshot({
        'settings.cursor': {
          loaded: true,
          supported: true,
          enabled: true,
          installed: true,
          busy: true,
          phase,
          errorVisible: false,
        },
      }).settings?.cursor?.phase,
    ).toBe(phase);
  }
  expect(snapshot.settings?.section).toBe('experiments');
  expect(snapshot.settings?.cursorApprovalCheck).toEqual({
    available: true,
    configured: true,
    running: true,
    awaitingApproval: true,
    outcome: 'allowed',
    errorVisible: false,
  });
  expect(JSON.stringify(snapshot.settings)).not.toMatch(/secret|private/);
});

test('reports only bounded harness selector metadata for the Advisor', () => {
  let visible = true;
  const unregister = registerChatHarnessAction(
    'test',
    () => true,
    () => visible,
  );
  const snapshot = buildCurrentUiStateSnapshot({
    'chat.harnessPicker.test': {
      pickerId: 'test',
      model: 'gpt-shared',
      harness: 'codex',
      availableHarnesses: ['codex', 'cursor', 'unknown'],
      message: 'private prompt',
    },
  });
  expect(snapshot.chatHarnessPickers).toEqual([
    {
      pickerId: 'test',
      model: 'gpt-shared',
      harness: 'codex',
      availableHarnesses: ['codex', 'cursor'],
    },
  ]);
  expect(JSON.stringify(snapshot)).not.toContain('private prompt');
  visible = false;
  expect(
    buildCurrentUiStateSnapshot({
      'chat.harnessPicker.test': snapshot.chatHarnessPickers?.[0] ?? {},
    }).chatHarnessPickers,
  ).toBeUndefined();
  unregister();
  expect(buildCurrentUiStateSnapshot({}).chatHarnessPickers).toBeUndefined();
});

test('omits a stale harness picker that is no longer mounted', () => {
  const snapshot = buildCurrentUiStateSnapshot({
    'chat.harnessPicker.hidden': {
      pickerId: 'hidden',
      model: 'gpt-shared',
      harness: 'codex',
      availableHarnesses: ['codex', 'cursor'],
    },
  });
  expect(snapshot.chatHarnessPickers).toBeUndefined();
});

it('reports the Home and active chat execution harness independently from provider identity', () => {
  const snapshot = buildCurrentUiStateSnapshot({
    'home.controls': { executionHarness: 'claude' },
    'chat.activeTab': {
      chatId: 'chat',
      providerType: 'ollama',
      executionHarness: 'codex',
    },
  });
  expect(snapshot.home).toMatchObject({ executionHarness: 'claude' });
  expect(snapshot.activeChat).toMatchObject({
    providerType: 'ollama',
    executionHarness: 'codex',
  });
});

test('reports the Cursor sign-in and account only once the panel has read them', () => {
  useNavigationStore.setState({
    settingsOpen: true,
    settingsInitialSection: 'experiments',
  });
  const base = {
    loaded: true,
    supported: true,
    enabled: true,
    installed: true,
    busy: false,
    phase: 'connected',
    errorVisible: false,
  };
  expect(
    buildCurrentUiStateSnapshot({ 'settings.cursor': base }).settings?.cursor,
  ).toEqual(base);
  const signedIn = buildCurrentUiStateSnapshot({
    'settings.cursor': {
      ...base,
      signedIn: true,
      account: 'ryan@example.test',
      accessToken: 'secret',
    },
  }).settings?.cursor;
  expect(signedIn).toEqual({
    ...base,
    signedIn: true,
    account: 'ryan@example.test',
  });
  expect(JSON.stringify(signedIn)).not.toMatch(/secret/);
  expect(
    buildCurrentUiStateSnapshot({
      'settings.cursor': { ...base, signedIn: false, account: '' },
    }).settings?.cursor,
  ).toEqual({ ...base, signedIn: false, account: '' });
});

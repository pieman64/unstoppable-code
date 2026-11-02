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
      [CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key]: true,
    },
    status: 'ready',
    initialized: true,
    updatedAt: new Date().toISOString(),
    error: null,
  });
});

describe('buildCurrentUiStateSnapshot App Advisor project-agent access slice', () => {
  it('sanitizes access settings and rebuilds only valid owner fields', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.appAdvisorProjectAgentAccess': {
        loaded: true,
        mode: 'selected-owners',
        selectedOwners: [
          { kind: 'personal', secret: 'drop this field' },
          {
            kind: 'organization',
            organizationId: 'org-a',
            extra: 'drop this field',
          },
          { kind: 'organization', organizationId: '' },
          { kind: 'organization', organizationId: '   ' },
          { kind: 'organization', organizationId: 42 },
          { kind: 'project', organizationId: 'org-b' },
          null,
        ],
        saving: true,
        saveErrorVisible: false,
        secret: 'never include',
      },
    });

    expect(snapshot.settings?.appAdvisorProjectAgentAccess).toEqual({
      loaded: true,
      mode: 'selected-owners',
      selectedOwners: [
        { kind: 'personal' },
        { kind: 'organization', organizationId: 'org-a' },
      ],
      saving: true,
      saveErrorVisible: false,
    });
    expect(
      JSON.stringify(snapshot.settings?.appAdvisorProjectAgentAccess),
    ).not.toContain('secret');
    expect(
      JSON.stringify(snapshot.settings?.appAdvisorProjectAgentAccess),
    ).not.toContain('extra');
  });

  it('omits the access setting when the mode is invalid', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.appAdvisorProjectAgentAccess': {
        loaded: true,
        mode: 'unknown',
        selectedOwners: [{ kind: 'personal' }],
      },
    });

    expect(snapshot.settings?.appAdvisorProjectAgentAccess).toBeUndefined();
  });

  it('defaults missing booleans to false', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.appAdvisorProjectAgentAccess': {
        mode: 'disabled',
        selectedOwners: [{ kind: 'personal' }],
      },
    });

    expect(snapshot.settings?.appAdvisorProjectAgentAccess).toEqual({
      loaded: false,
      mode: 'disabled',
      selectedOwners: [{ kind: 'personal' }],
      saving: false,
      saveErrorVisible: false,
    });
  });

  it('preserves the Code Graph setting alongside the App Advisor access setting', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.codeGraph': {
        loaded: true,
        mode: 'enabled',
        selectedWorkspaceIds: ['workspace-a'],
        generationTimeoutMinutes: 30,
        saving: false,
        saveErrorVisible: false,
        timeoutErrorVisible: false,
      },
      'settings.appAdvisorProjectAgentAccess': {
        loaded: true,
        mode: 'enabled',
        selectedOwners: [],
        saving: false,
        saveErrorVisible: false,
      },
    });

    expect(snapshot.settings?.codeGraph).toEqual({
      loaded: true,
      mode: 'enabled',
      selectedWorkspaceIds: ['workspace-a'],
      generationTimeoutMinutes: 30,
      saving: false,
      saveErrorVisible: false,
      timeoutErrorVisible: false,
    });
    expect(snapshot.settings?.appAdvisorProjectAgentAccess).toEqual({
      loaded: true,
      mode: 'enabled',
      selectedOwners: [],
      saving: false,
      saveErrorVisible: false,
    });
  });
});

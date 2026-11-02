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
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

describe('buildCurrentUiStateSnapshot workspaceContext (CAN-2952)', () => {
  it('omits the context until the renderer has hydrated it', () => {
    useWorkspaceContextStore.setState({
      hydrated: false,
      state: { context: { kind: 'personal' }, revision: 0, organizations: [] },
    });
    expect(buildCurrentUiStateSnapshot({}).workspaceContext).toBeUndefined();
  });

  it('reports the kind, organization id, and membership count without names', () => {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: ORG_A },
        revision: 3,
        organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
      },
    });
    const snapshot = buildCurrentUiStateSnapshot({});
    expect(snapshot.workspaceContext).toEqual({
      kind: 'organization',
      organizationId: ORG_A,
      organizationCount: 1,
    });
    expect(JSON.stringify(snapshot.workspaceContext)).not.toContain('Acme');
  });
});

it('exposes only bounded plugin connection state, never sign-in content', () => {
  const snapshot = buildCurrentUiStateSnapshot({
    'plugins.connection': {
      pending: true,
      browserOpen: true,
      connected: false,
      authRequired: true,
      errorVisible: false,
      authorizationUrl: 'https://private.example/authorize?secret=fixture',
      lastError: 'private diagnostic',
      flowId: 'secret-flow',
    },
  });
  expect(snapshot.plugins?.connection).toEqual({
    pending: true,
    browserOpen: true,
    connected: false,
    authRequired: true,
    errorVisible: false,
  });
  expect(JSON.stringify(snapshot.plugins)).not.toContain('secret');
  expect(JSON.stringify(snapshot.plugins)).not.toContain('private');
});

it('projects MCP health and confirmation metadata without test output (CAN-4265)', () => {
  const snapshot = buildCurrentUiStateSnapshot({
    'plugins.connection.management': {
      healthStatus: 'auth_required',
      testPending: true,
      actionPending: false,
      deleteConfirmOpen: true,
      promoteDialogOpen: false,
      credentialDialogOpen: false,
      deviceServer: true,
      message: 'SECRET result',
      tools: ['SECRET tool'],
      error: 'SECRET error',
    },
  });
  expect(snapshot.plugins?.mcpManagement).toEqual({
    healthStatus: 'auth_required',
    testPending: true,
    actionPending: false,
    deleteConfirmOpen: true,
    promoteDialogOpen: false,
    credentialDialogOpen: false,
    deviceServer: true,
  });
  expect(JSON.stringify(snapshot)).not.toContain('SECRET');
});

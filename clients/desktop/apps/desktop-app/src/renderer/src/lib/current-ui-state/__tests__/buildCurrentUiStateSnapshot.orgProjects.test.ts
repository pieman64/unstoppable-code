/**
 * @jest-environment jsdom
 */
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
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
      [CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key]: true,
      [CLIENT_FEATURE_FLAGS.canopySharedClaudeModelFable5.key]: false,
    },
    status: 'ready',
    initialized: true,
    updatedAt: new Date().toISOString(),
    error: null,
  });
});

describe('buildCurrentUiStateSnapshot orgProjects (CAN-2956)', () => {
  it('omits catalog rows outside an organization context', () => {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
    });
    expect(buildCurrentUiStateSnapshot({}).orgProjects).toBeUndefined();
  });

  it('reports the visible catalog rows and any live setup', () => {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: ORG_A },
        revision: 1,
        organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
      },
    });
    const snapshot = buildCurrentUiStateSnapshot({
      'sidebar.orgProjects': {
        rows: [
          {
            projectId: 'project-1',
            name: 'Payments service',
            state: 'ready-to-set-up',
          },
          {
            projectId: 'project-2',
            name: 'Design system',
            state: 'needs-github-access',
            setupState: 'materializing',
            setupPercent: 42,
          },
          {
            projectId: 'project-3',
            name: 'Billing',
            state: 'ready-to-set-up',
            unfinished: true,
          },
        ],
      },
    }).orgProjects;
    expect(snapshot).toEqual({
      organizationId: ORG_A,
      rows: [
        {
          projectId: 'project-1',
          name: 'Payments service',
          state: 'ready-to-set-up',
        },
        {
          projectId: 'project-2',
          name: 'Design system',
          state: 'needs-github-access',
          setupState: 'materializing',
          setupPercent: 42,
        },
        // Without this the Advisor would see a plain placeholder state and
        // could offer a setup the main process refuses.
        {
          projectId: 'project-3',
          name: 'Billing',
          state: 'ready-to-set-up',
          unfinished: true,
        },
      ],
    });
  });
});

it('allowlists setup modal state without paths or repository contents', (): void => {
  const safe = {
    open: true,
    projectId: 'project-1',
    name: 'Payments',
    state: 'ready-to-set-up',
    canStart: false,
  };
  expect(
    buildCurrentUiStateSnapshot({
      'orgProjectSetup.modal': {
        ...safe,
        setupState: 'materializing',
        setupPercent: 42,
        destination: '/private/destination',
        repository: { contents: 'secret' },
        message: '/private/repo',
      },
    }).orgProjectSetup,
  ).toEqual(safe);
  expect(
    JSON.stringify(
      buildCurrentUiStateSnapshot({
        'orgProjectSetup.modal': {
          ...safe,
          destination: '/private/destination',
          repository: { contents: 'secret' },
        },
      }),
    ),
  ).not.toContain('/private');
  expect(buildCurrentUiStateSnapshot({})).not.toHaveProperty('orgProjectSetup');
});

it('reports the Move to organization dialog with a known refusal code only', (): void => {
  expect(
    buildCurrentUiStateSnapshot({
      'moveToOrganization.modal': {
        open: true,
        workspaceId: 'payments',
        busy: false,
        errorCode: 'limit-reached',
        projectPath: '/private/payments',
      },
    }).moveToOrganization,
  ).toEqual({
    open: true,
    workspaceId: 'payments',
    busy: false,
    errorCode: 'limit-reached',
  });
  expect(
    buildCurrentUiStateSnapshot({
      'moveToOrganization.modal': {
        open: true,
        workspaceId: 'payments',
        busy: true,
        errorCode: 'not-a-code',
      },
    }).moveToOrganization,
  ).toEqual({ open: true, workspaceId: 'payments', busy: true });
  expect(buildCurrentUiStateSnapshot({})).not.toHaveProperty(
    'moveToOrganization',
  );
});

it.each([false, true])(
  'allowlists Add dialog reset state (%s), ids, names and mode without private contents',
  (contextChanged): void => {
    const snapshot = buildCurrentUiStateSnapshot({
      'addWorkspace.modal': {
        mode: 'organization',
        contextChanged,
        organizationId: ORG_A,
        name: 'Acme',
        path: '/private/secret',
        repository: { contents: 'private source' },
      },
    });
    expect(snapshot).toHaveProperty('addWorkspace', {
      mode: 'organization',
      contextChanged,
      organizationId: ORG_A,
      name: 'Acme',
    });
    expect(JSON.stringify(snapshot)).not.toContain('/private/secret');
    expect(JSON.stringify(snapshot)).not.toContain('private source');
  },
);

it('reports the organization options and drops unknown modes', (): void => {
  expect(
    buildCurrentUiStateSnapshot({
      'addWorkspace.modal': {
        mode: 'organization-existing',
        contextChanged: false,
        organizationId: ORG_A,
        name: 'Acme',
        projectKind: 'code',
        folderKind: 'git-repository',
        folderPath: '/private/folder',
      },
    }).addWorkspace,
  ).toEqual({
    mode: 'organization-existing',
    contextChanged: false,
    organizationId: ORG_A,
    name: 'Acme',
    projectKind: 'code',
    folderKind: 'git-repository',
  });
  // Create new reports the chosen project type and no folder.
  expect(
    buildCurrentUiStateSnapshot({
      'addWorkspace.modal': {
        mode: 'organization-create',
        contextChanged: false,
        organizationId: ORG_A,
        name: 'Acme',
        projectKind: 'cowork',
      },
    }).addWorkspace,
  ).toEqual({
    mode: 'organization-create',
    contextChanged: false,
    organizationId: ORG_A,
    name: 'Acme',
    projectKind: 'cowork',
  });
  expect(
    buildCurrentUiStateSnapshot({
      'addWorkspace.modal': { mode: 'personal-in-organization' },
    }),
  ).not.toHaveProperty('addWorkspace');
  // The mode's CAN-3453 name is gone with the Cowork-only form.
  expect(
    buildCurrentUiStateSnapshot({
      'addWorkspace.modal': { mode: 'organization-cowork' },
    }),
  ).not.toHaveProperty('addWorkspace');
});

it('keeps only known folder kinds, never the folder itself', (): void => {
  const snapshot = buildCurrentUiStateSnapshot({
    'addWorkspace.modal': {
      mode: 'organization-existing',
      organizationId: ORG_A,
      name: 'Acme',
      // A refused folder has no project kind; an unknown kind is dropped.
      projectKind: '/private/folder',
      folderKind: 'refused',
    },
  });
  expect(snapshot.addWorkspace).toEqual({
    mode: 'organization-existing',
    contextChanged: false,
    organizationId: ORG_A,
    name: 'Acme',
    folderKind: 'refused',
  });
  expect(JSON.stringify(snapshot)).not.toContain('/private');
});

it('reports a Personal folder conflict, with ids only once access is established (CAN-3648)', (): void => {
  const conflictOf = (
    folderConflict: unknown,
  ): ReturnType<typeof buildCurrentUiStateSnapshot>['addWorkspace'] =>
    buildCurrentUiStateSnapshot({
      'addWorkspace.modal': {
        mode: 'personal',
        contextChanged: false,
        folderConflict,
      },
    }).addWorkspace;
  expect(
    conflictOf({ status: 'ready', organizationId: ORG_A, projectId: 'p' }),
  ).toEqual({
    mode: 'personal',
    contextChanged: false,
    folderConflict: { status: 'ready', organizationId: ORG_A, projectId: 'p' },
  });
  expect(
    conflictOf({ status: 'unfinished', organizationId: ORG_A, projectId: 'p' })
      ?.folderConflict,
  ).toEqual({ status: 'unfinished', organizationId: ORG_A, projectId: 'p' });
  for (const status of ['resolving', 'denied', 'unknown'] as const)
    expect(
      conflictOf({
        status,
        organizationId: ORG_A,
        projectId: 'p',
        path: '/private/repo',
      })?.folderConflict,
    ).toEqual({ status });
  // An unknown status, or an actionable one missing its ids, is dropped.
  expect(conflictOf({ status: 'superseded' })).not.toHaveProperty(
    'folderConflict',
  );
  expect(conflictOf({ status: 'ready' })).not.toHaveProperty('folderConflict');
});

it('reports a project that needs its folder chosen as its own row state (CAN-3534)', (): void => {
  useWorkspaceContextStore.setState({
    hydrated: true,
    state: {
      context: { kind: 'organization', organizationId: ORG_A },
      revision: 1,
      organizations: [{ id: ORG_A, name: 'Acme', role: 'MEMBER' }],
    },
  });
  expect(
    buildCurrentUiStateSnapshot({
      'sidebar.orgProjects': {
        rows: [
          { projectId: 'project-1', name: 'Notes', state: 'choose-folder' },
        ],
      },
    }).orgProjects?.rows,
  ).toEqual([
    { projectId: 'project-1', name: 'Notes', state: 'choose-folder' },
  ]);
});

it('reports Personal catalog enrollment in Privacy without free-form metadata', (): void => {
  useNavigationStore.setState({
    settingsOpen: true,
    settingsInitialSection: 'privacy',
  });
  expect(
    buildCurrentUiStateSnapshot({
      'settings.personalCatalog': {
        loaded: true,
        enabled: true,
        signedIn: false,
        pending: false,
        notice: 'removed',
        error: false,
        projectName: 'private name',
      },
    }).settings,
  ).toMatchObject({
    open: true,
    section: 'privacy',
    personalCatalog: {
      loaded: true,
      enabled: true,
      signedIn: false,
      pending: false,
      notice: 'removed',
      error: false,
    },
  });
  expect(
    JSON.stringify(
      buildCurrentUiStateSnapshot({
        'settings.personalCatalog': {
          projectName: 'private name',
          notice: 'secret',
        },
      }),
    ),
  ).not.toMatch(/private name|secret/);
});

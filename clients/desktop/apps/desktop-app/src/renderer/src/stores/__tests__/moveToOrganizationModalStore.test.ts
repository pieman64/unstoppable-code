/**
 * @jest-environment jsdom
 */
import type {
  OrgProjectMoveResult,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { DEFAULT_COWORK_WORKSPACE_ID } from '@canopy/protocol/ui-labels';
import { DESKTOP_SHARED_SIDEBAR_STORAGE_KEY } from '@/components/sidebar/desktop-shared-sidebar-flag';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  canMoveToOrganization,
  closeMoveToOrganizationModal,
  moveToOrganization,
  openMoveToOrganizationModal,
  useMoveToOrganizationModalStore,
} from '@/stores/moveToOrganizationModalStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

const ACME = { id: 'org-acme', name: 'Acme', role: 'MEMBER' as const };

function makeProject(id: string): SingleRepoSidebarItem {
  return {
    id,
    type: 'single-repo',
    name: `Project ${id}`,
    repoPath: `/tmp/${id}`,
    color: '#123456',
    order: 0,
    collapsed: true,
    worktrees: [],
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
  };
}

function setFlag(enabled: boolean): void {
  const defaults = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.setState({
    snapshot: {
      ...defaults,
      values: {
        ...defaults.values,
        [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: enabled,
      },
      status: 'ready',
      initialized: true,
      updatedAt: new Date().toISOString(),
      error: null,
    },
  });
}

const moveWorkspace = jest.fn<Promise<OrgProjectMoveResult>, [unknown]>();
const addToast = jest.fn();

beforeEach(() => {
  moveWorkspace.mockReset();
  addToast.mockReset();
  setFlag(true);
  useWorkspaceContextStore.setState({
    state: {
      context: { kind: 'personal' },
      revision: 1,
      organizations: [ACME],
    },
  });
  useProjectsStore.setState({
    projects: [
      makeProject('personal'),
      {
        ...makeProject('owned'),
        owner: {
          type: 'organization',
          organizationId: ACME.id,
          projectId: 'p',
          instanceId: 'i',
          bindingGeneration: 0,
        },
      },
      { ...makeProject(DEFAULT_COWORK_WORKSPACE_ID) },
    ],
  });
  useMoveToOrganizationModalStore.setState({
    target: null,
    busy: false,
    error: null,
  });
  useGitHubStore.setState({ addToast });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { orgProjects: { moveWorkspace } },
  });
});

describe('canMoveToOrganization', () => {
  it('allows a Personal project in Personal with an organization', () => {
    expect(canMoveToOrganization('personal')).toBe(true);
  });

  it('refuses on the legacy sidebar, which mounts no dialog', () => {
    window.localStorage.setItem(DESKTOP_SHARED_SIDEBAR_STORAGE_KEY, '0');
    try {
      expect(canMoveToOrganization('personal')).toBe(false);
      expect(openMoveToOrganizationModal('personal')).toBe(false);
    } finally {
      window.localStorage.removeItem(DESKTOP_SHARED_SIDEBAR_STORAGE_KEY);
    }
  });

  it('refuses with the flag off', () => {
    setFlag(false);
    expect(canMoveToOrganization('personal')).toBe(false);
  });

  it('refuses in an organization context', () => {
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: ACME.id },
        revision: 2,
        organizations: [ACME],
      },
    });
    expect(canMoveToOrganization('personal')).toBe(false);
  });

  it('refuses without organizations', () => {
    useWorkspaceContextStore.setState({
      state: { context: { kind: 'personal' }, revision: 2, organizations: [] },
    });
    expect(canMoveToOrganization('personal')).toBe(false);
  });

  it('refuses an owned project, the default Chats space, and an unknown id', () => {
    expect(canMoveToOrganization('owned')).toBe(false);
    expect(canMoveToOrganization(DEFAULT_COWORK_WORKSPACE_ID)).toBe(false);
    expect(canMoveToOrganization('missing')).toBe(false);
  });
});

describe('move to organization modal', () => {
  it('opens for a movable project and refuses otherwise', () => {
    expect(openMoveToOrganizationModal('owned')).toBe(false);
    expect(useMoveToOrganizationModalStore.getState().target).toBeNull();
    expect(openMoveToOrganizationModal('personal')).toBe(true);
    expect(useMoveToOrganizationModalStore.getState().target).toEqual({
      workspaceId: 'personal',
    });
  });

  it('closes on success and confirms with a toast', async () => {
    moveWorkspace.mockResolvedValue({
      ok: true,
      workspaceId: 'personal',
      organizationId: ACME.id,
      projectId: 'org-project',
    });
    openMoveToOrganizationModal('personal');
    await moveToOrganization(ACME.id);
    expect(moveWorkspace).toHaveBeenCalledWith({
      workspaceId: 'personal',
      organizationId: ACME.id,
    });
    expect(useMoveToOrganizationModalStore.getState()).toMatchObject({
      target: null,
      busy: false,
      error: null,
    });
    expect(addToast).toHaveBeenCalledWith(
      'Moved Project personal to Acme.',
      'success',
    );
  });

  it('keeps the dialog open with the error tied to the organization on failure', async () => {
    moveWorkspace.mockResolvedValue({ ok: false, code: 'limit-reached' });
    openMoveToOrganizationModal('personal');
    await moveToOrganization(ACME.id);
    expect(useMoveToOrganizationModalStore.getState()).toMatchObject({
      target: { workspaceId: 'personal' },
      busy: false,
      error: { code: 'limit-reached', organizationId: ACME.id },
    });
    expect(addToast).not.toHaveBeenCalled();
    closeMoveToOrganizationModal();
    expect(openMoveToOrganizationModal('personal')).toBe(true);
    expect(useMoveToOrganizationModalStore.getState().error).toBeNull();
  });

  it('maps a thrown IPC call to move-failed', async () => {
    moveWorkspace.mockRejectedValue(new Error('ipc down'));
    openMoveToOrganizationModal('personal');
    await moveToOrganization(ACME.id);
    expect(useMoveToOrganizationModalStore.getState().error).toEqual({
      code: 'move-failed',
      organizationId: ACME.id,
    });
  });

  it('ignores a second submit, close, and open while a move is running', async () => {
    let resolve: (result: OrgProjectMoveResult) => void = () => undefined;
    moveWorkspace.mockReturnValue(
      new Promise<OrgProjectMoveResult>((settle) => {
        resolve = settle;
      }),
    );
    openMoveToOrganizationModal('personal');
    const first = moveToOrganization(ACME.id);
    expect(useMoveToOrganizationModalStore.getState().busy).toBe(true);
    await moveToOrganization(ACME.id);
    closeMoveToOrganizationModal();
    expect(openMoveToOrganizationModal('personal')).toBe(false);
    expect(moveWorkspace).toHaveBeenCalledTimes(1);
    expect(useMoveToOrganizationModalStore.getState().target).toEqual({
      workspaceId: 'personal',
    });
    resolve({ ok: false, code: 'busy' });
    await first;
    expect(useMoveToOrganizationModalStore.getState().busy).toBe(false);
  });
});

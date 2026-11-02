import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import type {
  SidebarItem,
  WorkspaceContext,
  WorkspaceContextState,
} from '@canopy/desktop-shared/types';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  isChatTabInScopingContext,
  isWorkspaceIdInContext,
  isWorkspaceIdInScopingContext,
  openInWorkspaceContext,
  openInWorkspaceContextAsync,
  scopeWorkspacesToContext,
  switchContextForWorkspace,
} from '../contextScope';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PERSONAL: WorkspaceContext = { kind: 'personal' };
const ORG_A_CONTEXT: WorkspaceContext = {
  kind: 'organization',
  organizationId: ORG_A,
};
const ORG_B_CONTEXT: WorkspaceContext = {
  kind: 'organization',
  organizationId: ORG_B,
};
const ORGANIZATIONS: WorkspaceContextState['organizations'] = [
  { id: ORG_A, name: 'Org A', role: 'MEMBER' },
  { id: ORG_B, name: 'Org B', role: 'MEMBER' },
];

function workspace(id: string, organizationId?: string): SidebarItem {
  return {
    type: 'single-repo',
    id,
    name: id,
    repoPath: `/repos/${id}`,
    color: '#000000',
    collapsed: false,
    order: 0,
    worktrees: [],
    ...(organizationId === undefined
      ? {}
      : {
          owner: {
            type: 'organization' as const,
            organizationId,
            projectId: '11111111-1111-4111-8111-111111111111',
            instanceId: '22222222-2222-4222-8222-222222222222',
            bindingGeneration: 0,
          },
        }),
  };
}

const WORKSPACES: SidebarItem[] = [
  workspace('org-a', ORG_A),
  workspace('org-b', ORG_B),
  workspace('personal'),
  workspace('linked'),
];

function setScoping(enabled: boolean, context: WorkspaceContext): void {
  const defaultSnapshot = getDefaultFeatureFlagSnapshot();
  useFeatureFlagsStore.setState({
    snapshot: {
      ...defaultSnapshot,
      values: {
        ...defaultSnapshot.values,
        [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: enabled,
      },
    },
  });
  useWorkspaceContextStore.setState({
    hydrated: true,
    state: { context, revision: 1, organizations: ORGANIZATIONS },
  });
}

describe('scopeWorkspacesToContext (CAN-3461)', () => {
  it('lists every workspace while unscoped', () => {
    expect(
      scopeWorkspacesToContext(WORKSPACES, undefined, []).map((w) => w.id),
    ).toEqual(['org-a', 'org-b', 'personal', 'linked']);
  });

  it('lists only the selected context, with linked Personal checkouts in the organization', () => {
    expect(
      scopeWorkspacesToContext(WORKSPACES, ORG_A_CONTEXT, ['linked']).map(
        (w) => w.id,
      ),
    ).toEqual(['org-a', 'linked']);
    expect(
      scopeWorkspacesToContext(WORKSPACES, ORG_B_CONTEXT, []).map((w) => w.id),
    ).toEqual(['org-b']);
    expect(
      scopeWorkspacesToContext(WORKSPACES, PERSONAL, ['linked']).map(
        (w) => w.id,
      ),
    ).toEqual(['personal', 'linked']);
  });

  it('keeps App Advisor global but fails closed for other unknown workspace ids', () => {
    expect(
      isWorkspaceIdInContext('app-advisor', WORKSPACES, ORG_A_CONTEXT, []),
    ).toBe(true);
    expect(
      isWorkspaceIdInContext(
        'deleted-org-project',
        WORKSPACES,
        ORG_A_CONTEXT,
        [],
      ),
    ).toBe(false);
    expect(isWorkspaceIdInContext('org-b', WORKSPACES, ORG_A_CONTEXT, [])).toBe(
      false,
    );
  });
});

describe('isChatTabInScopingContext (CAN-3464)', () => {
  beforeEach(() => {
    useProjectsStore.setState({ projects: WORKSPACES });
    useLinkedPersonalWorkspacesStore.setState({
      ids: ['linked'],
      organizationId: ORG_A,
    });
  });

  it('keeps a started linked Personal tab with its captured Personal owner', () => {
    setScoping(true, ORG_A_CONTEXT);

    expect(isChatTabInScopingContext('linked', 'personal', true)).toBe(false);
  });

  it('allows a linked Personal tab captured for the active organization', () => {
    setScoping(true, ORG_A_CONTEXT);

    expect(isChatTabInScopingContext('linked', `org:${ORG_A}`, true)).toBe(
      true,
    );
  });

  it('treats a legacy started linked Personal tab as Personal', () => {
    setScoping(true, ORG_A_CONTEXT);

    expect(isChatTabInScopingContext('linked', undefined, true)).toBe(false);
  });

  it('lets an unstarted linked tab follow the current navigation context', () => {
    setScoping(true, ORG_A_CONTEXT);

    expect(isChatTabInScopingContext('linked', undefined, false)).toBe(true);
  });
});

describe('switchContextForWorkspace (CAN-3461)', () => {
  let setContext: jest.Mock;

  beforeEach(() => {
    useProjectsStore.setState({ projects: WORKSPACES });
    useLinkedPersonalWorkspacesStore.setState({ ids: [] });
    setContext = jest.fn(
      (context: WorkspaceContext): Promise<WorkspaceContextState> => {
        const state: WorkspaceContextState = {
          context,
          revision: 2,
          organizations: ORGANIZATIONS,
        };
        useWorkspaceContextStore.setState({ state });
        return Promise.resolve(state);
      },
    );
    useWorkspaceContextStore.setState({ setContext });
  });

  it('never switches while org projects are off', async () => {
    setScoping(false, PERSONAL);
    expect(isWorkspaceIdInScopingContext('org-b')).toBe(true);
    await expect(switchContextForWorkspace('org-b')).resolves.toBe(true);
    expect(setContext).not.toHaveBeenCalled();
  });

  it('opens an in-context entry synchronously without switching', () => {
    setScoping(true, ORG_A_CONTEXT);
    const open = jest.fn();
    openInWorkspaceContext('org-a', open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(setContext).not.toHaveBeenCalled();
  });

  it('switches to the entry owner context before opening it', async () => {
    setScoping(true, ORG_A_CONTEXT);
    const open = jest.fn((): void => {
      expect(useWorkspaceContextStore.getState().state.context).toEqual(
        ORG_B_CONTEXT,
      );
    });
    openInWorkspaceContext('org-b', open);
    expect(open).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(setContext).toHaveBeenCalledWith(ORG_B_CONTEXT);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('switches a Personal entry back to Personal', async () => {
    setScoping(true, ORG_B_CONTEXT);
    await expect(switchContextForWorkspace('personal')).resolves.toBe(true);
    expect(setContext).toHaveBeenCalledWith({ kind: 'personal' });
  });

  it('settles the awaitable open only after the switch and the open finish (CAN-5006)', async () => {
    setScoping(true, ORG_A_CONTEXT);
    let finishOpen: () => void = () => undefined;
    const open = jest.fn(
      (): Promise<void> =>
        new Promise<void>((resolve) => {
          finishOpen = resolve;
        }),
    );
    let settled = false;
    const opening = openInWorkspaceContextAsync('org-b', open).then(() => {
      settled = true;
    });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    finishOpen();
    await opening;
    expect(settled).toBe(true);
  });

  it('opens an in-context entry synchronously through the awaitable open', async () => {
    setScoping(true, ORG_A_CONTEXT);
    const open = jest.fn();
    const opening = openInWorkspaceContextAsync('org-a', open);
    expect(open).toHaveBeenCalledTimes(1);
    await opening;
    expect(setContext).not.toHaveBeenCalled();
  });

  it('settles the awaitable open without opening when the switch is rejected', async () => {
    setScoping(true, ORG_A_CONTEXT);
    setContext.mockRejectedValueOnce(new Error('stale revision'));
    const open = jest.fn();
    await openInWorkspaceContextAsync('org-b', open);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens nothing when the switch is rejected', async () => {
    setScoping(true, ORG_A_CONTEXT);
    setContext.mockRejectedValueOnce(new Error('stale revision'));
    const open = jest.fn();
    openInWorkspaceContext('org-b', open);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
  });

  describe('temporary combination destinations (CAN-3846)', () => {
    function combination(id: string, organizationId?: string): SidebarItem {
      const { owner } = workspace(id, organizationId);
      return {
        type: 'multi-repo',
        id,
        name: id,
        color: '#000000',
        collapsed: false,
        order: 0,
        temporary: true,
        repos: [
          { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
          { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
        ],
        worktrees: [],
        ...(owner === undefined ? {} : { owner }),
      };
    }

    beforeEach(() => {
      useProjectsStore.setState({
        projects: [
          ...WORKSPACES,
          combination('combo-org-a', ORG_A),
          combination('combo-unowned'),
        ],
      });
    });

    it('keeps the organization selected for a combination it owns', async () => {
      setScoping(true, ORG_A_CONTEXT);
      await expect(switchContextForWorkspace('combo-org-a')).resolves.toBe(
        true,
      );
      expect(setContext).not.toHaveBeenCalled();
    });

    it('switches to the owning organization from Personal', async () => {
      setScoping(true, PERSONAL);
      await expect(switchContextForWorkspace('combo-org-a')).resolves.toBe(
        true,
      );
      expect(setContext).toHaveBeenCalledWith(ORG_A_CONTEXT);
    });

    it('lands an unowned combination in Personal', async () => {
      setScoping(true, ORG_A_CONTEXT);
      await expect(switchContextForWorkspace('combo-unowned')).resolves.toBe(
        true,
      );
      expect(setContext).toHaveBeenCalledWith({ kind: 'personal' });
    });

    it('selects a combination without switching while org projects are off', async () => {
      setScoping(false, PERSONAL);
      await expect(switchContextForWorkspace('combo-org-a')).resolves.toBe(
        true,
      );
      expect(setContext).not.toHaveBeenCalled();
    });

    it('reports a rejected switch without throwing', async () => {
      setScoping(true, ORG_A_CONTEXT);
      setContext.mockRejectedValueOnce(new Error('stale revision'));
      await expect(switchContextForWorkspace('combo-unowned')).resolves.toBe(
        false,
      );
    });

    it('reports a switch that landed in another context', async () => {
      setScoping(true, ORG_A_CONTEXT);
      setContext.mockImplementationOnce((): Promise<WorkspaceContextState> => {
        const state: WorkspaceContextState = {
          context: ORG_B_CONTEXT,
          revision: 2,
          organizations: ORGANIZATIONS,
        };
        useWorkspaceContextStore.setState({ state });
        return Promise.resolve(state);
      });
      await expect(switchContextForWorkspace('combo-unowned')).resolves.toBe(
        false,
      );
    });

    it('reports a destination the projects refresh has not loaded yet', async () => {
      setScoping(true, ORG_A_CONTEXT);
      await expect(switchContextForWorkspace('combo-missing')).resolves.toBe(
        false,
      );
      expect(setContext).not.toHaveBeenCalled();
    });
  });

  it('opens nothing for a workspace whose owner cannot be resolved', async () => {
    setScoping(true, ORG_A_CONTEXT);
    const open = jest.fn();
    openInWorkspaceContext('deleted-org-project', open);
    await Promise.resolve();
    expect(setContext).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { create as createZustand } from 'zustand';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { HomeWorkspacePicker } from '../HomeWorkspacePicker';
import { useProjectsStore } from '@/stores/projectsStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import type { WorkspaceDropdownProps } from '@/components/shared/WorkspaceDropdown';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

const coworkWorkspace: SidebarItem = {
  id: 'cowork-default',
  name: 'Chats',
  type: 'cowork',
  color: '#7c3aed',
  collapsed: false,
  order: 0,
};
const codeWorkspace: SidebarItem = {
  id: 'repo-1',
  name: 'Repo One',
  type: 'single-repo',
  repoPath: '/tmp/repo-one',
  color: '#16a34a',
  worktrees: [],
  collapsed: false,
  order: 1,
};

jest.mock('@/stores/projectsStore', () => {
  const { create } = jest.requireActual<{ create: typeof createZustand }>(
    'zustand',
  );
  return {
    useProjectsStore: create(() => ({ projects: [] })),
  };
});
jest.mock('@/stores/homeComposerStore', () => {
  const { create } = jest.requireActual<{ create: typeof createZustand }>(
    'zustand',
  );
  return {
    useHomeComposerStore: create(() => ({
      workspaceId: null,
      mode: 'chat',
      linkTarget: { status: 'idle' },
      fileReferences: [],
      setSendError: jest.fn(),
      selectWorkspace: jest.fn(),
    })),
  };
});
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ openAddWorkspaceModal: jest.fn() }),
}));
/** Props the picker handed the dropdown on its last render. */
const dropdownProps: { current: WorkspaceDropdownProps | null } = {
  current: null,
};

jest.mock('../../shared/WorkspaceDropdown', () => ({
  WorkspaceDropdown: (props: WorkspaceDropdownProps): JSX.Element => {
    dropdownProps.current = props;
    return <button data-testid="home-workspace-select">Workspace</button>;
  },
}));

describe('HomeWorkspacePicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // The selectWorkspace mock is created once in the store factory and the
    // repo sets no `clearMocks`, so without this a call from an earlier test
    // would satisfy `toHaveBeenCalledWith` vacuously.
    const { selectWorkspace } = useHomeComposerStore.getState();
    if (jest.isMockFunction(selectWorkspace)) selectWorkspace.mockClear();
    useProjectsStore.setState({ projects: [coworkWorkspace] });
    useHomeComposerStore.setState({
      workspaceId: 'cowork-default',
      linkTarget: { status: 'idle' },
      fileReferences: [],
      setSendError: jest.fn(),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        createElement(HomeWorkspacePicker, { shortcutEnabled: false }),
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps file mentions in their project when a link draft chooses another project', () => {
    act(() => {
      useProjectsStore.setState({ projects: [coworkWorkspace, codeWorkspace] });
      useHomeComposerStore.setState({
        workspaceId: 'repo-1',
        fileReferences: [
          {
            displayPath: 'README.md',
            absolutePath: '/tmp/repo-one/README.md',
            kind: 'file',
          },
        ],
        linkTarget: {
          status: 'blocked',
          key: 'github-repo:acme/app',
          fingerprint: 'preview',
          message: 'Choose project',
          actions: [],
        },
      });
    });
    act(() => dropdownProps.current?.onSelect('cowork-default'));
    expect(
      useHomeComposerStore.getState().selectWorkspace,
    ).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().setSendError).toHaveBeenCalledWith(
      expect.stringContaining('file mentions'),
    );
  });

  it('keeps saved prompt mentions in their project when a link draft chooses another project', () => {
    act(() => {
      useProjectsStore.setState({ projects: [coworkWorkspace, codeWorkspace] });
      useHomeComposerStore.setState({
        workspaceId: 'repo-1',
        fileReferences: [
          {
            displayPath: 'README.md',
            absolutePath: '/tmp/repo-one/README.md',
            kind: 'prompt',
          },
        ],
        linkTarget: {
          status: 'blocked',
          key: 'github-repo:acme/app',
          fingerprint: 'preview',
          message: 'Choose project',
          actions: [],
        },
      });
    });
    act(() => dropdownProps.current?.onSelect('cowork-default'));
    expect(
      useHomeComposerStore.getState().selectWorkspace,
    ).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().setSendError).toHaveBeenCalledWith(
      expect.stringContaining('saved prompt mentions'),
    );
  });

  it('names the Chats catch-all when it is the only destination', () => {
    // beforeEach mounts with the default workspace alone and selected: the
    // chip says where the chat goes and still offers "New project".
    expect(
      document.querySelector('[data-testid="home-workspace-picker"]'),
    ).not.toBeNull();
    expect(dropdownProps.current?.selectedWorkspaceId).toBe('cowork-default');
  });

  it('hides a selected sole project and appears live when another project arrives', () => {
    act(() => {
      useProjectsStore.setState({ projects: [codeWorkspace] });
      useHomeComposerStore.setState({ workspaceId: 'repo-1' });
    });
    expect(
      document.querySelector('[data-testid="home-workspace-picker"]'),
    ).toBeNull();

    act(() =>
      useProjectsStore.setState({
        projects: [coworkWorkspace, codeWorkspace],
      }),
    );

    expect(
      document.querySelector('[data-testid="home-workspace-picker"]'),
    ).not.toBeNull();
  });

  it('never offers the default cowork workspace as a pickable project', () => {
    // It is a real workspace and stays the resting destination for a chat
    // with no project, but the sidebar presents it as the Chats section, so
    // listing it here read as filing a chat somewhere it never appeared.
    // beforeEach mounts with the default workspace alone, which the gate
    // hides; a second project brings the picker on screen.
    act(() =>
      useProjectsStore.setState({
        projects: [coworkWorkspace, codeWorkspace],
      }),
    );

    expect(dropdownProps.current?.unlistedWorkspaceIds).toContain(
      'cowork-default',
    );
    // Still handed the full list, so the trigger can name the selection.
    expect(dropdownProps.current?.workspaces.map((w) => w.id)).toEqual([
      'cowork-default',
      'repo-1',
    ]);
  });

  it('declines to name the catch-all on the trigger', () => {
    // The store still holds the real id; only the label is withheld, so the
    // chip reads "Choose project" instead of presenting it as a filed-in
    // project.
    act(() => {
      useProjectsStore.setState({ projects: [coworkWorkspace, codeWorkspace] });
      useHomeComposerStore.setState({ workspaceId: 'cowork-default' });
    });

    expect(dropdownProps.current?.selectedWorkspaceId).toBe('');
    expect(dropdownProps.current?.allowUnset).toBe(true);
    expect(dropdownProps.current?.placeholder).toBe('Choose project');
  });

  it('names a real project on the trigger', () => {
    act(() => {
      useProjectsStore.setState({ projects: [coworkWorkspace, codeWorkspace] });
      useHomeComposerStore.setState({ workspaceId: 'repo-1' });
    });

    expect(dropdownProps.current?.selectedWorkspaceId).toBe('repo-1');
  });

  it('offers no clear control while the default project is already selected', () => {
    act(() => {
      useProjectsStore.setState({ projects: [coworkWorkspace, codeWorkspace] });
      useHomeComposerStore.setState({ workspaceId: 'cowork-default' });
    });

    expect(dropdownProps.current?.onClear).toBeUndefined();
  });

  it('clears a real project back to the default one, never to nothing', () => {
    // Tommy's constraint: "Chats" stays an ordinary project with a fixed id.
    // Clearing is presentation, not a new non-project context.
    act(() => {
      useProjectsStore.setState({ projects: [coworkWorkspace, codeWorkspace] });
      useHomeComposerStore.setState({ workspaceId: 'repo-1' });
    });

    expect(dropdownProps.current?.onClear).toBeDefined();
    act(() => dropdownProps.current?.onClear?.());

    expect(
      useHomeComposerStore.getState().selectWorkspace,
    ).toHaveBeenCalledWith('cowork-default', { explicit: true });
  });

  it("clears a project in an organization to that organization's Chats", () => {
    // The Home E2E only sees "Choose project" after clearing; this pins the
    // destination: the selected organization's Chats, never Personal Chats.
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values['canopy-shared-org-projects-enabled'] = true;
    const previousContext = useWorkspaceContextStore.getState();
    act(() => {
      useFeatureFlagsStore.setState({ snapshot });
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'organization', organizationId },
          revision: 1,
          organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
        },
      });
      useProjectsStore.setState({ projects: [coworkWorkspace, codeWorkspace] });
      useHomeComposerStore.setState({ workspaceId: 'repo-1' });
    });

    try {
      expect(dropdownProps.current?.onClear).toBeDefined();
      act(() => dropdownProps.current?.onClear?.());
      expect(
        useHomeComposerStore.getState().selectWorkspace,
      ).toHaveBeenCalledWith(`cowork-org-${organizationId}`, {
        explicit: true,
      });
      expect(
        useHomeComposerStore.getState().selectWorkspace,
      ).not.toHaveBeenCalledWith('cowork-default');
    } finally {
      act(() => useWorkspaceContextStore.setState(previousContext, true));
    }
  });

  it('offers only projects in the selected organization', () => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const orgWorkspace: SidebarItem = {
      ...codeWorkspace,
      id: 'org-repo',
      name: 'Org repo',
      order: 2,
      owner: {
        type: 'organization',
        organizationId,
        projectId: 'project-1',
        instanceId: 'instance-1',
        bindingGeneration: 1,
      },
    };
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values['canopy-shared-org-projects-enabled'] = true;
    const previousContext = useWorkspaceContextStore.getState();
    act(() => {
      useFeatureFlagsStore.setState({ snapshot });
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'organization', organizationId },
          revision: 1,
          organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
        },
      });
      useProjectsStore.setState({
        projects: [coworkWorkspace, codeWorkspace, orgWorkspace],
      });
      useHomeComposerStore.setState({
        workspaceId: `cowork-org-${organizationId}`,
      });
    });

    try {
      expect(dropdownProps.current?.workspaces.map((w) => w.id)).toEqual([
        'org-repo',
      ]);
    } finally {
      act(() => useWorkspaceContextStore.setState(previousContext, true));
    }
  });

  it("names the organization's Chats when it is the only thing in scope", () => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const orgChats: SidebarItem = {
      ...coworkWorkspace,
      id: `cowork-org-${organizationId}`,
      owner: {
        type: 'organization',
        organizationId,
        projectId: 'chats-project',
        instanceId: 'chats-instance',
        bindingGeneration: 1,
      },
    };
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values['canopy-shared-org-projects-enabled'] = true;
    const previousContext = useWorkspaceContextStore.getState();
    act(() => {
      useFeatureFlagsStore.setState({ snapshot });
      useWorkspaceContextStore.setState({
        hydrated: true,
        state: {
          context: { kind: 'organization', organizationId },
          revision: 1,
          organizations: [{ id: organizationId, name: 'Acme', role: 'MEMBER' }],
        },
      });
      useProjectsStore.setState({
        projects: [coworkWorkspace, codeWorkspace, orgChats],
      });
      useHomeComposerStore.setState({ workspaceId: orgChats.id });
    });

    try {
      expect(
        document.querySelector('[data-testid="home-workspace-picker"]'),
      ).not.toBeNull();
      expect(dropdownProps.current?.selectedWorkspaceId).toBe(orgChats.id);
    } finally {
      act(() => useWorkspaceContextStore.setState(previousContext, true));
    }
  });

  it('preselects the existing project a pasted link proposes', () => {
    act(() => {
      useProjectsStore.setState({ projects: [coworkWorkspace, codeWorkspace] });
      useHomeComposerStore.setState({
        workspaceId: 'cowork-default',
        linkTarget: {
          status: 'ready',
          key: 'github.com/acme/app',
          fingerprint: 'preview',
          plan: {
            kind: 'existing-project',
            workspaceId: 'repo-1',
            workspaceName: 'Repo One',
            branchTarget: { kind: 'new-worktree' },
          },
        },
      });
    });

    expect(dropdownProps.current?.selectedWorkspaceId).toBe('repo-1');
    expect(dropdownProps.current?.pendingWorkspace).toBeUndefined();
    // Preview only: clearing would not undo the link's proposal.
    expect(dropdownProps.current?.onClear).toBeUndefined();
    expect(
      useHomeComposerStore.getState().selectWorkspace,
    ).not.toHaveBeenCalled();
  });

  it('preselects New project when a pasted link would add one', () => {
    // A sole selected project normally hides the picker; the proposal shows it.
    act(() => {
      useProjectsStore.setState({ projects: [codeWorkspace] });
      useHomeComposerStore.setState({
        workspaceId: 'repo-1',
        linkTarget: {
          status: 'ready',
          key: 'github.com/acme/registrar',
          fingerprint: 'preview',
          plan: {
            kind: 'create-project',
            repository: {
              owner: 'acme',
              repo: 'registrar',
              repositoryKey: 'github.com/acme/registrar',
              cloneUrl: 'https://github.com/acme/registrar.git',
              isArchived: false,
            },
            pending: { kind: 'default-branch' },
          },
        },
      });
    });

    expect(
      document.querySelector('[data-testid="home-workspace-picker"]'),
    ).not.toBeNull();
    expect(dropdownProps.current?.selectedWorkspaceId).toBe('');
    expect(dropdownProps.current?.pendingWorkspace).toEqual({
      title: 'New project for acme/registrar',
    });
  });

  it('names the catch-all on the trigger once the user renames it', () => {
    // Withholding a name the user deliberately chose puts the trigger back
    // out of step with the sidebar section, which renders the stored name.
    act(() => {
      useProjectsStore.setState({
        projects: [{ ...coworkWorkspace, name: 'Scratchpad' }, codeWorkspace],
      });
      useHomeComposerStore.setState({ workspaceId: 'cowork-default' });
    });

    expect(dropdownProps.current?.selectedWorkspaceId).toBe('cowork-default');
  });
});

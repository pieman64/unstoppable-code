/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  orgDefaultCoworkWorkspaceId,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  useKeepHomeSelectionInScope,
  type HomeContextRebind,
} from '../homeScope';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ORG = '11111111-1111-4111-8111-111111111111';

const personalProject: SidebarItem = {
  id: 'sharing-test',
  name: 'Sharing test',
  type: 'cowork',
  color: '#ea580c',
  collapsed: false,
  order: 1,
};

function Harness({
  workspaceId,
  selectWorkspace,
  readCurrentWorkspaceId,
}: {
  workspaceId: string | null;
  selectWorkspace: (rebind: HomeContextRebind) => void;
  readCurrentWorkspaceId?: () => string | null;
}): JSX.Element {
  useKeepHomeSelectionInScope(
    workspaceId,
    selectWorkspace,
    readCurrentWorkspaceId,
  );
  return <div />;
}

describe('useKeepHomeSelectionInScope', () => {
  const originalFlags = useFeatureFlagsStore.getState();
  const originalContext = useWorkspaceContextStore.getState();
  const originalProjects = useProjectsStore.getState();
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    snapshot.values['canopy-shared-org-projects-enabled'] = true;
    useFeatureFlagsStore.setState({ snapshot });
    useProjectsStore.setState({ projects: [personalProject] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useFeatureFlagsStore.setState(originalFlags, true);
    useWorkspaceContextStore.setState(originalContext, true);
    useProjectsStore.setState(originalProjects, true);
  });

  function selectContext(
    context:
      | { kind: 'personal' }
      | { kind: 'organization'; organizationId: string },
  ): void {
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context,
        revision: 1,
        organizations: [{ id: ORG, name: 'Acme', role: 'MEMBER' }],
      },
    });
  }

  it("moves a Personal project selection to the organization's Chats", () => {
    const selectWorkspace = jest.fn();
    act(() => selectContext({ kind: 'personal' }));
    act(() =>
      root.render(
        <Harness
          workspaceId="sharing-test"
          selectWorkspace={selectWorkspace}
        />,
      ),
    );
    expect(selectWorkspace).not.toHaveBeenCalled();

    act(() => selectContext({ kind: 'organization', organizationId: ORG }));

    expect(selectWorkspace).toHaveBeenCalledWith({
      workspaceId: orgDefaultCoworkWorkspaceId(ORG),
    });
  });

  it('moves a Personal Cowork selection to the first listed project of each context', () => {
    // The shape of a real install: each context's Chats sorts ahead of its
    // projects, so "first by order" alone lands on the unlisted Chats.
    const organizationOwner: SidebarItem['owner'] = {
      type: 'organization',
      organizationId: ORG,
      projectId: 'project-1',
      instanceId: 'instance-1',
      bindingGeneration: 1,
    };
    const personalChats: SidebarItem = {
      ...personalProject,
      id: 'cowork-default',
      name: 'Chats',
      order: 0,
    };
    const organizationChats: SidebarItem = {
      ...personalChats,
      id: orgDefaultCoworkWorkspaceId(ORG),
      order: 2,
      owner: organizationOwner,
    };
    const organizationProject: SidebarItem = {
      id: 'org-repo',
      name: 'Org repo',
      type: 'single-repo',
      repoPath: '/tmp/org-repo',
      color: '#2563eb',
      worktrees: [],
      collapsed: false,
      order: 3,
      owner: organizationOwner,
    };
    useProjectsStore.setState({
      projects: [
        personalChats,
        personalProject,
        organizationChats,
        organizationProject,
      ],
    });
    const selectWorkspace = jest.fn();
    act(() => selectContext({ kind: 'personal' }));
    act(() =>
      root.render(
        <Harness
          workspaceId="sharing-test"
          selectWorkspace={selectWorkspace}
        />,
      ),
    );

    act(() => selectContext({ kind: 'organization', organizationId: ORG }));
    expect(selectWorkspace).toHaveBeenCalledTimes(1);
    expect(selectWorkspace).toHaveBeenLastCalledWith({
      workspaceId: 'org-repo',
    });

    act(() =>
      root.render(
        <Harness workspaceId="org-repo" selectWorkspace={selectWorkspace} />,
      ),
    );
    act(() => selectContext({ kind: 'personal' }));
    expect(selectWorkspace).toHaveBeenCalledTimes(2);
    expect(selectWorkspace).toHaveBeenLastCalledWith({
      workspaceId: 'sharing-test',
    });
  });

  it('keeps a selection an earlier effect already moved into scope', () => {
    const selectWorkspace = jest.fn();
    let liveWorkspaceId: string | null = 'sharing-test';
    act(() => selectContext({ kind: 'personal' }));
    act(() =>
      root.render(
        <Harness
          workspaceId="sharing-test"
          selectWorkspace={selectWorkspace}
          readCurrentWorkspaceId={() => liveWorkspaceId}
        />,
      ),
    );

    // The context-change effect runs first in the same commit and has already chosen
    // an in-scope project, so the rendered id is stale.
    liveWorkspaceId = orgDefaultCoworkWorkspaceId(ORG);
    act(() => selectContext({ kind: 'organization', organizationId: ORG }));

    expect(selectWorkspace).not.toHaveBeenCalled();
  });

  it('leaves a selection the store has not loaded yet alone', () => {
    const selectWorkspace = jest.fn();
    act(() => selectContext({ kind: 'organization', organizationId: ORG }));
    act(() =>
      root.render(
        <Harness workspaceId="just-added" selectWorkspace={selectWorkspace} />,
      ),
    );
    expect(selectWorkspace).not.toHaveBeenCalled();
  });
});

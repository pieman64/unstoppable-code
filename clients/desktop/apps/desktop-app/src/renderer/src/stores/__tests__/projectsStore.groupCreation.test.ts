import type { SidebarItem } from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';

const createSingle = jest.fn().mockRejectedValue(new Error('Held creation'));
const createMulti = jest.fn().mockRejectedValue(new Error('Held creation'));
beforeAll(() =>
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        createWorktree: createSingle,
        createWorkspaceWorktree: createMulti,
      },
    },
  }),
);
afterAll(() => Reflect.deleteProperty(globalThis, 'window'));
const shared = {
  id: 'code',
  name: 'Code project',
  color: '#000000',
  order: 0,
  collapsed: false,
  worktrees: [],
  scripts: {},
  effectiveScripts: {},
  hooks: {},
  effectiveHooks: {},
};
it.each(['single-repo', 'multi-repo'] as const)(
  'carries group membership in %s creation before any registration',
  async (type) => {
    const project: SidebarItem =
      type === 'single-repo'
        ? { ...shared, type, repoPath: '/tmp/code' }
        : { ...shared, type, repos: [] };
    useProjectsStore.setState({
      projects: [project],
      creatingWorktreeForProject: new Set(),
    });
    await useProjectsStore
      .getState()
      .createWorktree('code', { sidebarItemGroupId: 'grp-release' });
    const command = type === 'single-repo' ? createSingle : createMulti;
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ sidebarItemGroupId: 'grp-release' }),
    );
    const createdProject = useProjectsStore.getState().projects[0];
    if (!createdProject || createdProject.type === 'cowork') {
      throw new Error('Expected a code workspace');
    }
    expect(createdProject.worktrees).toEqual([]);
  },
);

it.each(['single-repo', 'multi-repo'] as const)(
  'settles failed %s creation and clears its error when retrying',
  async (type) => {
    const project: SidebarItem =
      type === 'single-repo'
        ? { ...shared, type, repoPath: '/tmp/code' }
        : { ...shared, type, repos: [] };
    useProjectsStore.setState({
      projects: [project],
      creatingWorktreeForProject: new Set(),
      worktreeError: null,
    });
    const command = type === 'single-repo' ? createSingle : createMulti;
    const error = 'Git is unavailable. Install Git, then recheck.';
    command.mockRejectedValueOnce(new Error(error));
    await useProjectsStore.getState().createWorktree('code');
    expect(
      useProjectsStore.getState().creatingWorktreeForProject.has('code'),
    ).toBe(false);
    expect(useProjectsStore.getState().worktreeError).toBe(error);
    const createdProject = useProjectsStore.getState().projects[0];
    if (!createdProject || createdProject.type === 'cowork') {
      throw new Error('Expected a code workspace');
    }
    expect(createdProject.worktrees).toEqual([]);

    let rejectRetry: (error: Error) => void = () => undefined;
    command.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRetry = reject;
        }),
    );
    const retry = useProjectsStore.getState().createWorktree('code');
    const retryState = {
      pending: useProjectsStore
        .getState()
        .creatingWorktreeForProject.has('code'),
      error: useProjectsStore.getState().worktreeError,
    };
    rejectRetry(new Error(error));
    await retry;
    expect(retryState).toEqual({ pending: true, error: null });
    expect(
      useProjectsStore.getState().creatingWorktreeForProject.has('code'),
    ).toBe(false);
  },
);

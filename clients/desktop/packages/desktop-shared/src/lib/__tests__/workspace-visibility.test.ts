import type { MultiRepoSidebarItem } from '../../types';
import {
  hasVisibleWorkspaceContent,
  isRetiredTemporaryWorkspace,
} from '../workspace-visibility';

function multiRepo(
  overrides: Partial<MultiRepoSidebarItem> = {},
): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    id: 'combine',
    name: 'Combine',
    color: '#000000',
    collapsed: false,
    order: 0,
    repos: [],
    worktrees: [],
    ...overrides,
  };
}

describe('isRetiredTemporaryWorkspace', () => {
  it.each([undefined, false, true])(
    'decides retirement from explicit Always show (%s), independently of ownership',
    (alwaysShow) => {
      const workspace = multiRepo({
        temporary: true,
        alwaysShow,
        archivedContainerCount: 0,
      });
      expect(isRetiredTemporaryWorkspace(workspace)).toBe(alwaysShow !== true);
      expect(
        isRetiredTemporaryWorkspace({
          ...workspace,
          owner: {
            type: 'organization',
            organizationId: 'org',
            projectId: 'project',
            instanceId: 'instance',
            bindingGeneration: 1,
          },
        }),
      ).toBe(alwaysShow !== true);
    },
  );

  it('never retires a single-repo or Cowork workspace', () => {
    const common = {
      id: 'other',
      name: 'Other',
      color: '',
      collapsed: false,
      order: 0,
      temporary: true,
      alwaysShow: false,
      worktrees: [],
    };
    expect(
      isRetiredTemporaryWorkspace({
        ...common,
        type: 'single-repo',
        repoPath: '/repo',
      }),
    ).toBe(false);
    expect(
      isRetiredTemporaryWorkspace({
        ...common,
        type: 'cowork',
        externalPath: '/folder',
      }),
    ).toBe(false);
  });

  it('keeps a temporary workspace that still owns a retained container', () => {
    expect(
      isRetiredTemporaryWorkspace(
        multiRepo({ temporary: true, archivedContainerCount: 1 }),
      ),
    ).toBe(false);
  });

  it('keeps a temporary workspace that still has a worktree', () => {
    expect(
      isRetiredTemporaryWorkspace(
        multiRepo({
          temporary: true,
          worktrees: [
            {
              id: 'wt',
              branchName: 'main',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('never retires a permanent workspace', () => {
    expect(isRetiredTemporaryWorkspace(multiRepo())).toBe(false);
    expect(hasVisibleWorkspaceContent(multiRepo({ temporary: true }))).toBe(
      false,
    );
  });
});

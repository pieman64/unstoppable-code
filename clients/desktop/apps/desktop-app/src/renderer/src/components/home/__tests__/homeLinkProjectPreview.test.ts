import type { SidebarItem } from '@canopy/desktop-shared/types';
import {
  homeLinkProjectPreview,
  type HomeLinkProjectPreviewInput,
} from '../homeLinkProjectPreview';
import type { HomeLinkPlan } from '../homeLinkTarget';

const chats: SidebarItem = {
  id: 'cowork-default',
  name: 'Chats',
  type: 'cowork',
  color: '#7c3aed',
  collapsed: false,
  order: 0,
};
const blog: SidebarItem = {
  id: 'blog',
  name: 'My blog builder',
  type: 'single-repo',
  repoPath: '/tmp/blog',
  color: '#16a34a',
  worktrees: [],
  collapsed: false,
  order: 1,
};
const app: SidebarItem = { ...blog, id: 'app', name: 'App', order: 2 };

const existing: HomeLinkPlan = {
  kind: 'existing-project',
  workspaceId: 'app',
  workspaceName: 'App',
  branchTarget: { kind: 'new-worktree' },
};
const create: HomeLinkPlan = {
  kind: 'create-project',
  repository: {
    owner: 'acme',
    repo: 'registrar',
    repositoryKey: 'github.com/acme/registrar',
    cloneUrl: 'https://github.com/acme/registrar.git',
    isArchived: false,
  },
  pending: { kind: 'default-branch' },
};

function input(
  overrides: Partial<HomeLinkProjectPreviewInput>,
): HomeLinkProjectPreviewInput {
  return {
    mode: 'chat',
    linkTarget: { status: 'idle' },
    workspaceId: 'blog',
    workspaceSelectionExplicit: false,
    projects: [chats, blog, app],
    ...overrides,
  };
}

const ready = (
  plan: HomeLinkPlan,
): HomeLinkProjectPreviewInput['linkTarget'] => ({
  status: 'ready',
  key: 'k',
  fingerprint: 'f',
  plan,
});

describe('homeLinkProjectPreview', () => {
  it('previews a different existing project over an inherited selection', () => {
    expect(
      homeLinkProjectPreview(input({ linkTarget: ready(existing) })),
    ).toEqual({ kind: 'existing-project', workspaceId: 'app' });
  });

  it('previews a new project for a repository that is not a project yet', () => {
    expect(
      homeLinkProjectPreview(input({ linkTarget: ready(create) })),
    ).toEqual({
      kind: 'create-project',
      repositoryLabel: 'acme/registrar',
    });
  });

  it('previews over an explicitly cleared selection, which is just Chats', () => {
    expect(
      homeLinkProjectPreview(
        input({
          workspaceId: 'cowork-default',
          workspaceSelectionExplicit: true,
          linkTarget: ready(existing),
        }),
      ),
    ).toEqual({ kind: 'existing-project', workspaceId: 'app' });
  });

  it('never overrides a code project the user picked', () => {
    expect(
      homeLinkProjectPreview(
        input({ workspaceSelectionExplicit: true, linkTarget: ready(create) }),
      ),
    ).toBeNull();
  });

  it('adds nothing when the link targets the selected project', () => {
    expect(
      homeLinkProjectPreview(
        input({ workspaceId: 'app', linkTarget: ready(existing) }),
      ),
    ).toBeNull();
  });

  it('keeps the last destination while the same link is re-checked', () => {
    expect(
      homeLinkProjectPreview(
        input({
          linkTarget: {
            status: 'resolving',
            key: 'k',
            fingerprint: 'g',
            previousPlan: existing,
          },
        }),
      ),
    ).toEqual({ kind: 'existing-project', workspaceId: 'app' });
    expect(
      homeLinkProjectPreview(
        input({
          linkTarget: { status: 'resolving', key: 'k', fingerprint: 'g' },
        }),
      ),
    ).toBeNull();
  });

  it('keeps the destination while it is being created', () => {
    expect(
      homeLinkProjectPreview(
        input({
          linkTarget: {
            status: 'submitting',
            key: 'k',
            fingerprint: 'f',
            plan: create,
            progress: 'Cloning…',
            canCancel: true,
          },
        }),
      ),
    ).toEqual({ kind: 'create-project', repositoryLabel: 'acme/registrar' });
  });

  it('shows the real selection for a blocked link or outside chat mode', () => {
    expect(
      homeLinkProjectPreview(
        input({
          linkTarget: {
            status: 'blocked',
            key: 'k',
            fingerprint: 'f',
            message: 'Choose a project',
            actions: [],
          },
        }),
      ),
    ).toBeNull();
    expect(
      homeLinkProjectPreview(
        input({ mode: 'pipeline', linkTarget: ready(existing) }),
      ),
    ).toBeNull();
  });
});

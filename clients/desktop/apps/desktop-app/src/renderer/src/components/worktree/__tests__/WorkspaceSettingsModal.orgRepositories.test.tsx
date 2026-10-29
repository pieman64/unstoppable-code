/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  MultiRepoSidebarItem,
  OrgMultiRepoRepositoryCheckRequest,
  OrgMultiRepoRepositoryCheckResult,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { WorkspaceSettingsModal } from '../WorkspaceSettingsModal';
import { useProjectsStore } from '@/stores/projectsStore';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ORGANIZATION_OWNER: MultiRepoSidebarItem['owner'] = {
  type: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  instanceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  bindingGeneration: 0,
};

function singleRepoProject(name: string): SingleRepoSidebarItem {
  return {
    id: name,
    type: 'single-repo',
    name,
    repoPath: `/repos/${name}`,
    worktrees: [],
    collapsed: false,
    order: 0,
  };
}

function workspace(
  owner: MultiRepoSidebarItem['owner'] | null = ORGANIZATION_OWNER,
): MultiRepoSidebarItem {
  return {
    id: 'acme-platform',
    type: 'multi-repo',
    name: 'Platform',
    repos: [],
    worktrees: [],
    collapsed: false,
    order: 1,
    ...(owner ? { owner } : {}),
  };
}

const checkRepositories = jest.fn<
  Promise<OrgMultiRepoRepositoryCheckResult>,
  [OrgMultiRepoRepositoryCheckRequest]
>();
const browseForRepo = jest.fn<Promise<{ path: string } | null>, []>();

function installApi(): void {
  const api: Record<string, unknown> = {
    orgProjects: { checkRepositories },
    browseForRepo,
    listDefaultRepos: jest.fn(() => Promise.resolve([])),
    loadClaudeMd: jest.fn(() => Promise.resolve('')),
    getDefaultCloneDirectory: jest.fn(() => Promise.resolve('/repos')),
    getRemoteUrl: jest.fn(() => Promise.resolve({ remoteUrl: null })),
    getWorkspaceSettingsData: jest.fn(() => Promise.reject(new Error('n/a'))),
    onWorkspaceSourceChangesApplied: jest.fn(() => (): void => undefined),
  };
  // Every other preload call this surface makes on open settles harmlessly.
  const fallback = new Proxy(api, {
    get(target, key: string): unknown {
      return key in target
        ? target[key]
        : jest.fn(() => Promise.resolve(undefined));
    },
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: fallback,
  });
}

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async (): Promise<void> => {
      await Promise.resolve();
    });
  }
}

async function openAddRepo(
  project: MultiRepoSidebarItem = workspace(),
): Promise<void> {
  act((): void => {
    root.render(
      <WorkspaceSettingsModal isOpen onClose={jest.fn()} workspace={project} />,
    );
  });
  await flush();
  const addRepo = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === '+ Add repo',
  );
  if (!addRepo) throw new Error('No Add repo button');
  act((): void => {
    addRepo.click();
  });
  await flush();
}

function existingOption(name: string): HTMLButtonElement {
  const option = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="workspace-settings-existing-repo"]',
    ),
  ).find((button) => button.textContent?.startsWith(name));
  if (!option) throw new Error(`No Existing option ${name}`);
  return option;
}

beforeEach((): void => {
  jest.clearAllMocks();
  installApi();
  useProjectsStore.setState({
    projects: [singleRepoProject('payments'), singleRepoProject('docs')],
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach((): void => {
  act((): void => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
});

describe('adding a repository to an organization multi-repo project (CAN-3546)', (): void => {
  it("disables Existing repositories the organization doesn't hold and says why", async (): Promise<void> => {
    checkRepositories.mockResolvedValue({
      kind: 'checked',
      organizationName: 'Acme',
      repositories: {
        '/repos/payments': 'eligible',
        '/repos/docs': 'outside',
      },
    });

    await openAddRepo();

    expect(checkRepositories).toHaveBeenCalledWith({
      workspaceId: 'acme-platform',
      repoPaths: ['/repos/payments', '/repos/docs'],
    });
    expect(existingOption('payments').disabled).toBe(false);
    const docs = existingOption('docs');
    expect(docs.disabled).toBe(true);
    // The reason's icon sits beside the row and anchors the tooltip.
    const trigger = docs.parentElement?.querySelector(
      '[data-testid="workspace-settings-existing-repo-reason"]',
    );
    if (!trigger) throw new Error('No tooltip trigger');
    expect(trigger.querySelector('svg')).not.toBeNull();
    act((): void => {
      trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).toContain("docs doesn't belong to Acme.");

    // A disabled choice stages nothing.
    act((): void => {
      docs.click();
    });
    expect(document.body.textContent).not.toContain('Will add in worktree');
    expect(existingOption('docs')).toBeTruthy();
  });

  it('refuses a local folder beside its tab and stages nothing', async (): Promise<void> => {
    checkRepositories.mockImplementation((request) =>
      Promise.resolve({
        kind: 'checked',
        organizationName: 'Acme',
        repositories: Object.fromEntries(
          (request.repoPaths ?? []).map((path) => [path, 'outside' as const]),
        ),
      }),
    );
    browseForRepo.mockResolvedValue({ path: '/elsewhere/engineering-docs' });

    await openAddRepo();
    const localFolder = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Local folder',
    );
    if (!localFolder) throw new Error('No Local Folder tab');
    act((): void => {
      localFolder.click();
    });
    const browse = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Browse for repo',
    );
    if (!browse) throw new Error('No Browse button');
    act((): void => {
      browse.click();
    });
    await flush();

    expect(checkRepositories).toHaveBeenLastCalledWith({
      workspaceId: 'acme-platform',
      repoPaths: ['/elsewhere/engineering-docs'],
    });
    expect(
      document.querySelector(
        '[data-testid="workspace-settings-add-repo-refusal"]',
      )?.textContent,
    ).toBe(
      "engineering-docs doesn't belong to Acme. Choose repositories that belong to Acme.",
    );
    // Still on the Local Folder tab, and nothing was staged.
    expect(document.body.textContent).toContain('Browse for repo');
    expect(document.body.textContent).not.toContain(
      '/elsewhere/engineering-docs',
    );
  });

  it('checks nothing for a Personal project', async (): Promise<void> => {
    await openAddRepo(workspace(null));

    expect(checkRepositories).not.toHaveBeenCalled();
    expect(existingOption('docs').disabled).toBe(false);
  });
});

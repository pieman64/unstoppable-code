/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  MultiRepoSidebarItem,
  OrgMultiRepoRepositoryCheckRequest,
  OrgMultiRepoRepositoryCheckResult,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { WorkspaceSettingsModal } from '../WorkspaceSettingsModal';
import { useSharedMultiRepoRequired } from '../DesktopOrgSharedMultiRepoSetup';
import { useProjectsStore } from '@/stores/projectsStore';

jest.mock('../DesktopOrgSharedMultiRepoSetup', () => ({
  useSharedMultiRepoRequired: jest.fn(() => true),
  DesktopOrgSharedMultiRepoSetup: ({
    mode,
    sources,
  }: {
    mode: string;
    sources: { id: string }[];
  }): JSX.Element => (
    <div
      data-testid="shared-setup"
      data-mode={mode}
      data-source={sources[0]?.id}
    >
      New shared multi-repo project
    </div>
  ),
}));

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
    color: '#123456',
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
    color: '#123456',
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
  jest.mocked(useSharedMultiRepoRequired).mockReturnValue(true);
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

describe('adding repositories (CAN-3571)', () => {
  it('lists shared organization repositories with the existing add/remove controls', async () => {
    const project = workspace();
    project.repos = ['setup-repo', 'second-repo'].map((name) => ({
      id: name,
      name,
      repoPath: `/repos/acme/${name}`,
    }));
    act(() => {
      root.render(
        <WorkspaceSettingsModal
          isOpen
          onClose={jest.fn()}
          workspace={project}
        />,
      );
    });
    await flush();
    expect(document.body.textContent).toContain('setup-repo');
    expect(document.body.textContent).toContain('second-repo');
    expect(document.body.textContent).not.toContain(
      'worktree ⋯ → Add repository',
    );
    expect(document.querySelector('[data-testid="shared-setup"]')).toBeNull();
    expect(document.body.textContent).toContain('+ Add repo');
    for (const name of ['setup-repo', 'second-repo']) {
      expect(
        document.querySelector(`button[aria-label="Remove ${name}"]`),
      ).not.toBeNull();
    }
  });

  it('preserves private-member repository eligibility and refusal explanations', async (): Promise<void> => {
    jest.mocked(useSharedMultiRepoRequired).mockReturnValue(false);
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

  it('preserves private-member local-folder refusals', async (): Promise<void> => {
    jest.mocked(useSharedMultiRepoRequired).mockReturnValue(false);
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

  it('preserves the existing Personal repository picker', async () => {
    jest.mocked(useSharedMultiRepoRequired).mockReturnValue(false);
    await openAddRepo(workspace(null));
    expect(checkRepositories).not.toHaveBeenCalled();
    expect(existingOption('docs').disabled).toBe(false);
  });
});

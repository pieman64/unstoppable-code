/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import { ProjectSettingsModal } from '../ProjectSettingsModal';
import { CanopyClientProvider } from '@canopy/app-state';
import { createFakeClient } from '@canopy/app-state/__tests__/fake-org-projects-client';
import { useProjectsStore } from '@/stores/projectsStore';
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));
jest.mock('../DesktopOrgSharedMultiRepoSetup', () => ({
  useSharedMultiRepoRequired: (): boolean => true,
  DesktopOrgSharedMultiRepoSetup: (): JSX.Element => (
    <section data-testid="org-shared-multi-repo-setup">
      New shared multi-repo project
    </section>
  ),
}));
const checkRepositories = jest.fn();
const browseForRepo = jest.fn();
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

test('organization General page has no shared form and directs users to worktree ⋯ → Add repository', async () => {
  installApi();
  const project: SingleRepoSidebarItem = {
    id: 'source',
    type: 'single-repo',
    name: 'Source',
    color: '#000000',
    repoPath: '/repos/source',
    worktrees: [],
    collapsed: false,
    order: 0,
    owner: {
      type: 'organization',
      organizationId: 'org',
      projectId: 'shared',
      instanceId: 'instance',
      bindingGeneration: 0,
    },
  };
  useProjectsStore.setState({ projects: [project] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const { client } = createFakeClient();
  try {
    await act(async () => {
      root.render(
        <CanopyClientProvider client={client}>
          <ProjectSettingsModal
            isOpen
            project={project}
            onClose={() => undefined}
          />
        </CanopyClientProvider>,
      );
      await Promise.resolve();
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(
      dialog?.querySelector('[data-testid="project-settings-page-general"]'),
    ).not.toBeNull();
    const convertRow = dialog?.querySelector(
      '[data-testid="project-settings-convert"]',
    );
    expect(convertRow?.textContent).toContain('Convert to multi-repo project');
    expect(convertRow?.querySelector('button')).toBeNull();
    expect(
      dialog?.querySelector('[data-testid="org-shared-multi-repo-setup"]'),
    ).toBeNull();
    expect(
      dialog?.querySelector('[data-testid="project-settings-convert-org-note"]')
        ?.textContent,
    ).toContain('worktree ⋯ → Add repository');
    expect(dialog?.textContent).toContain('shared multi-repo project');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

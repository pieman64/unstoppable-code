/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';

const loadProjects = jest.fn<Promise<void>, []>();
const refreshProject = jest.fn<Promise<void>, [string]>();
const addToast = jest.fn();

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: { getState: (): object => ({ loadProjects }) },
}));
jest.mock('@/stores/startPageStore', () => ({
  useStartPageStore: { getState: (): object => ({ refreshProject }) },
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: { getState: (): object => ({ addToast }) },
}));

import { CodeStartPageSettings } from '../start-page/CodeStartPageSettings';

const project: SingleRepoSidebarItem = {
  id: 'project-1',
  type: 'single-repo',
  name: 'Project',
  repoPath: '/tmp/project',
  color: '#000000',
  worktrees: [],
  collapsed: false,
  order: 0,
  startPage: { kind: 'url', url: 'https://example.com' },
};

describe('CodeStartPageSettings', () => {
  let container: HTMLDivElement;
  let root: Root;
  const setWorkspaceStartPage = jest.fn<Promise<void>, [unknown]>();

  beforeEach(() => {
    jest.clearAllMocks();
    loadProjects.mockResolvedValue(undefined);
    refreshProject.mockResolvedValue(undefined);
    setWorkspaceStartPage.mockResolvedValue(undefined);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        homeFileIndex: jest.fn().mockResolvedValue({ repos: [] }),
        getWorkspaceSettingsData: jest.fn().mockResolvedValue({
          manifest: { startPage: { kind: 'url', url: 'https://team.test' } },
        }),
        setWorkspaceStartPage,
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not save the previous target after switching to an incomplete choice', async () => {
    act(() => root.render(<CodeStartPageSettings project={project} />));

    const choice = document.querySelector<HTMLButtonElement>(
      '[data-testid="start-page-choice-trigger"]',
    );
    const save = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save local',
    );
    expect(choice).not.toBeNull();
    expect(save).toBeDefined();

    act(() => choice?.click());
    const fileChoice = document.querySelector<HTMLButtonElement>(
      '[data-testid="start-page-choice-file"]',
    );
    expect(fileChoice).not.toBeNull();
    await act(() => {
      fileChoice?.click();
      return Promise.resolve();
    });

    expect(save?.disabled).toBe(true);
    act(() => save?.click());
    expect(setWorkspaceStartPage).not.toHaveBeenCalled();
  });

  it('uses the shared source controls for worktree selection and apply', async () => {
    act(() => root.render(<CodeStartPageSettings project={project} />));

    const source = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Source controlled',
    );
    expect(source).toBeDefined();
    await act(() => {
      source?.click();
      return Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="source-worktree-picker-trigger"]'),
    ).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Add to worktree',
      ),
    ).toBe(true);
  });

  it('does not save the canopy.json value for this computer when switching back', async () => {
    act(() =>
      root.render(
        <CodeStartPageSettings project={project} layout="settings" />,
      ),
    );
    const scope = (id: string): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

    await act(async () => {
      scope('project-settings-scope-source')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      scope('project-settings-scope-local')?.click();
      await Promise.resolve();
    });

    expect(setWorkspaceStartPage).not.toHaveBeenCalled();
  });

  it('shows and compares against the stored value for this computer, not a prefill', async () => {
    await act(async () => {
      root.render(
        <CodeStartPageSettings
          project={project}
          layout="settings"
          initialMode="local"
          prefill={null}
        />,
      );
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="start-page-choice-trigger"]')
        ?.textContent,
    ).toContain('A web page');
    expect(setWorkspaceStartPage).not.toHaveBeenCalled();
  });

  it('saves a choice for this computer only when Save local is pressed', async () => {
    const saved: SingleRepoSidebarItem = { ...project, startPage: null };
    act(() =>
      root.render(<CodeStartPageSettings project={saved} layout="settings" />),
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="start-page-choice-trigger"]',
        )
        ?.click(),
    );
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="start-page-choice-team"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setWorkspaceStartPage).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Local override');

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="start-page-save-local"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(setWorkspaceStartPage).toHaveBeenCalledTimes(1);
    expect(setWorkspaceStartPage).toHaveBeenLastCalledWith({
      workspaceId: 'project-1',
    });
  });

  it('still reports a local choice as unsaved on the Source controlled tab', async () => {
    const saved: SingleRepoSidebarItem = { ...project, startPage: null };
    const onUnsavedChange = jest.fn();
    act(() =>
      root.render(
        <CodeStartPageSettings
          project={saved}
          layout="settings"
          onUnsavedChange={onUnsavedChange}
        />,
      ),
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="start-page-choice-trigger"]',
        )
        ?.click(),
    );
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="start-page-choice-team"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="project-settings-scope-source"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
  });

  it('reports a choice made during a running Save local as unsaved', async () => {
    const saved: SingleRepoSidebarItem = { ...project, startPage: null };
    setWorkspaceStartPage.mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    const onUnsavedChange = jest.fn();
    act(() =>
      root.render(
        <CodeStartPageSettings
          project={saved}
          layout="settings"
          onUnsavedChange={onUnsavedChange}
        />,
      ),
    );
    const choose = async (option: string): Promise<void> => {
      act(() =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="start-page-choice-trigger"]',
          )
          ?.click(),
      );
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            `[data-testid="start-page-choice-${option}"]`,
          )
          ?.click();
        await Promise.resolve();
      });
    };
    await choose('team');
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="start-page-save-local"]',
        )
        ?.click();
      await Promise.resolve();
    });
    // The running write covers Team.
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
    // Back to New chat, the value stored before that write.
    await choose('chat');
    expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
  });

  it('follows an outside change after its own save settled', async () => {
    const saved: SingleRepoSidebarItem = { ...project, startPage: null };
    act(() =>
      root.render(<CodeStartPageSettings project={saved} layout="settings" />),
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="start-page-choice-trigger"]',
        )
        ?.click(),
    );
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="start-page-choice-team"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="start-page-save-local"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setWorkspaceStartPage).toHaveBeenCalledTimes(1);
    // The save's refresh, then a change made elsewhere.
    await act(async () => {
      root.render(
        <CodeStartPageSettings
          project={{ ...saved, startPage: undefined }}
          layout="settings"
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      root.render(
        <CodeStartPageSettings
          project={{
            ...saved,
            startPage: { kind: 'url', url: 'https://elsewhere.test' },
          }}
          layout="settings"
        />,
      );
      await Promise.resolve();
    });

    expect(setWorkspaceStartPage).toHaveBeenCalledTimes(1);
  });
});

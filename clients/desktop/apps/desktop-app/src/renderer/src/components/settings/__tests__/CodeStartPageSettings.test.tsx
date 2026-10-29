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
});

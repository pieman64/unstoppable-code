/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { WorktreeLaunchButton } from '../WorktreeLaunchButton';
import { useProjectsStore } from '@/stores/projectsStore';
import { useScriptsStore } from '@/stores/scriptsStore';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const WORKTREE_KEY = `${PROJECT_ID}/${WORKTREE_ID}`;

function makeSingleRepoProject(
  overrides: Partial<SidebarItem> = {},
): SidebarItem {
  return {
    type: 'single-repo',
    id: PROJECT_ID,
    name: 'Project One',
    repoPath: '/tmp/project-one',
    color: '#112233',
    worktrees: [],
    collapsed: false,
    order: 0,
    effectiveScripts: { launch: 'npm run dev' },
    ...overrides,
  };
}

describe('WorktreeLaunchButton', () => {
  let container: HTMLDivElement;
  let root: Root;
  let runScriptMock: jest.Mock;
  let stopScriptMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    runScriptMock = jest.fn(
      () =>
        new Promise(() => {
          // Never resolves: keeps the run in `running` for Stop assertions.
        }),
    );
    stopScriptMock = jest.fn(() => Promise.resolve(null));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runScript: runScriptMock,
        stopScript: stopScriptMock,
      },
    });
    useProjectsStore.setState({
      projects: [makeSingleRepoProject()],
      appliedProjectWorktreeScripts: {},
    });
    useScriptsStore.setState({ runs: {} });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderButton(): void {
    act(() => {
      root.render(
        <WorktreeLaunchButton
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
        />,
      );
    });
  }

  function queryLaunchButton(): HTMLButtonElement | null {
    return container.querySelector('button[aria-label="Launch scripts"]');
  }

  it('renders the Launch button when the worktree has a launch script', () => {
    renderButton();
    const button = queryLaunchButton();
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('Launch');
    expect(button?.getAttribute('data-execution-action-button')).toBe('true');
  });

  it('renders nothing when the project has no launch script', () => {
    useProjectsStore.setState({
      projects: [makeSingleRepoProject({ effectiveScripts: {} })],
    });
    renderButton();
    expect(
      container.querySelector('[data-testid="worktree-launch-button"]'),
    ).toBeNull();
  });

  it('clicking Launch starts the run via window.api.runScript, then Stop stops it', () => {
    renderButton();
    const launch = queryLaunchButton();
    expect(launch).not.toBeNull();
    act(() => {
      launch?.click();
    });

    expect(runScriptMock).toHaveBeenCalledTimes(1);
    expect(runScriptMock).toHaveBeenCalledWith({
      target: 'project',
      scriptName: 'launch',
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });

    // startRun marked the launch script running in the scripts store, so the
    // control flips to Stop.
    const runs = useScriptsStore.getState().runs[WORKTREE_KEY];
    expect(runs).toBeDefined();
    expect(
      Object.values(runs ?? {}).some(
        (run) => run.lifecycle === 'launch' && run.status === 'running',
      ),
    ).toBe(true);
    const stop = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop scripts"]',
    );
    expect(stop).not.toBeNull();
    expect(queryLaunchButton()).toBeNull();

    act(() => {
      stop?.click();
    });
    expect(stopScriptMock).toHaveBeenCalledTimes(1);
    expect(stopScriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      }),
    );
  });

  it('keeps a host-owned Run action available while its terminal is tracked', () => {
    const onLaunch = jest.fn();
    useScriptsStore.setState({
      runs: {
        [WORKTREE_KEY]: {
          launch: {
            scriptKey: 'launch',
            label: 'Launch',
            lifecycle: 'launch',
            status: 'running',
            startedAt: Date.now(),
            devServerHits: [],
          },
        },
      },
    });

    act(() => {
      root.render(
        <WorktreeLaunchButton
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          onLaunch={onLaunch}
          launchLabel="Run"
          launchTestId="recipient-run"
        />,
      );
    });

    const run = container.querySelector<HTMLButtonElement>(
      '[data-testid="recipient-run"]',
    );
    expect(run).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Stop scripts"]'),
    ).toBeNull();
    act(() => run?.click());
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });
});

/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import type { KnownTerminalSession } from '@/stores/terminalStore';
import type {
  SplitPrDiscardResponse,
  SplitPrMap,
} from '@canopy/desktop-shared/types/github';
import { SplitPreflightModalHost } from '../SplitPreflightModal';
import { useActivityStore } from '@/stores/activityStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useBrowserStore } from '@/stores/browserStore';
import { useScriptsStore, type ScriptRunState } from '@/stores/scriptsStore';
import {
  __resetSplitPrPreferencesForTests,
  useSplitPrPreferencesStore,
} from '@/hooks/useSplitPrPreferences';

// Renders only the modal shell/content, matching the mock used by
// SplitPreflightModal.test.tsx, so these tests exercise the Host's own
// sourcing logic (store subscriptions -> props) rather than DialogModal's
// portal/overlay mechanics.
jest.mock('@/components/shared/DialogModal', () => ({
  DialogModal: function MockDialogModal({
    children,
    dataTestId,
  }: {
    children: ReactNode;
    dataTestId?: string;
  }): JSX.Element {
    return <div data-testid={dataTestId}>{children}</div>;
  },
}));

interface MockWindowApi {
  github: {
    planSplitPr: jest.Mock;
    startSplitWorkflow: jest.Mock;
    discardSplitPr: jest.Mock<Promise<SplitPrDiscardResponse>, [unknown]>;
    getSplitPrMap: jest.Mock<Promise<SplitPrMap | null>, [unknown]>;
  };
}

function installWindowApiMock(): MockWindowApi {
  const api: MockWindowApi = {
    github: {
      planSplitPr: jest.fn().mockImplementation(
        () =>
          new Promise(() => {
            // Left pending; these tests only assert the call happened.
          }),
      ),
      startSplitWorkflow: jest.fn().mockImplementation(
        () =>
          new Promise(() => {
            // Left pending; these tests only assert the call happened.
          }),
      ),
      discardSplitPr: jest
        .fn<Promise<SplitPrDiscardResponse>, [unknown]>()
        .mockResolvedValue({ branches: [], prNumbers: [] }),
      getSplitPrMap: jest
        .fn<Promise<SplitPrMap | null>, [unknown]>()
        .mockResolvedValue(null),
    },
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api,
  });
  return api;
}

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const OTHER_WORKTREE_ID = 'wt-2';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;
const OTHER_KEY = `${PROJECT_ID}/${OTHER_WORKTREE_ID}`;

function makeSingleRepoProject(): SidebarItem {
  return {
    type: 'single-repo',
    id: PROJECT_ID,
    name: 'Workspace One',
    repoPath: '/repo',
    color: 'blue',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: 'feature/big-change',
        createdAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: OTHER_WORKTREE_ID,
        branchName: 'feature/other',
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ],
  };
}

function setGatingPrefs(enabled: boolean, thresholdLines: number): void {
  useSplitPrPreferencesStore.setState({
    splitPrEnabled: enabled,
    splitPrThresholdLines: thresholdLines,
    hasLoaded: true,
  });
}

function makeTerminalSession(
  id: string,
  overrides: Partial<KnownTerminalSession> = {},
): KnownTerminalSession {
  return {
    id,
    projectId: PROJECT_ID,
    worktreeId: WORKTREE_ID,
    shell: '/bin/zsh',
    shellBasename: 'zsh',
    cwd: '/repo',
    createdAt: Date.now(),
    live: true,
    scrollbackLines: [],
    exitCode: null,
    signal: null,
    ...overrides,
  };
}

function seedTerminals(
  key: string,
  sessions: Record<string, KnownTerminalSession>,
): void {
  useTerminalStore.setState((state) => ({
    worktrees: {
      ...state.worktrees,
      [key]: {
        drawerCollapsed: false,
        groups: [],
        activeGroupId: null,
        nextGroupOrdinal: 1,
        groupOrdinals: {},
        sessions,
        hydrated: true,
      },
    },
  }));
}

function seedBrowsers(key: string, live: Record<string, boolean>): void {
  const browserIds = Object.keys(live);
  const liveBrowserIds = browserIds.filter((browserId) => live[browserId]);
  useBrowserStore.setState((state) => ({
    worktrees: {
      ...state.worktrees,
      [key]: {
        browserOrder: browserIds,
        activeBrowserId: null,
        browsers: {},
        live: new Set(liveBrowserIds),
        hydrated: true,
      },
    },
  }));
}

function makeScriptRun(
  overrides: Partial<ScriptRunState> = {},
): ScriptRunState {
  return {
    label: 'Dev server',
    scriptName: 'dev',
    lifecycle: 'custom',
    command: 'npm run dev',
    target: 'project',
    status: 'running',
    outputLines: [],
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    startedAt: Date.now(),
    devServerHits: [],
    ...overrides,
  };
}

function seedScripts(key: string, runs: Record<string, ScriptRunState>): void {
  useScriptsStore.setState((state) => ({
    runs: { ...state.runs, [key]: runs },
  }));
}

let api: MockWindowApi;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  api = installWindowApiMock();
  __resetSplitPrPreferencesForTests();
  setGatingPrefs(true, 500);
  useGitHubStore.setState({
    prStatuses: {},
    planningSplitPr: new Set<string>(),
    splittingPr: new Set<string>(),
    splitPrPlans: {},
    splitPrProgress: {},
    splitPrResults: {},
    splitPrRefusals: {},
  });
  useProjectsStore.setState({
    projects: [makeSingleRepoProject()],
    diffStats: {},
    uncommittedChanges: {},
    hasUnpushedCommits: {},
  });
  useTerminalStore.setState({
    worktrees: {},
    terminalCustomNames: {},
    groupCustomNames: {},
  });
  useBrowserStore.setState({
    worktrees: {},
    consoleEntries: {},
    networkEntries: {},
    recordings: {},
    screenshots: {},
    inspectorOpen: {},
    inspectorTab: {},
    diagnosticsSeenAt: {},
  });
  useScriptsStore.setState({ runs: {} });
  useActivityStore.setState({
    splitPreflight: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  jest.clearAllMocks();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<SplitPreflightModalHost />);
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

describe('SplitPreflightModalHost resource sourcing', () => {
  it('omits the termination warning when no resources are running anywhere', async () => {
    await render();

    expect(query('split-preflight-modal')).not.toBeNull();
    expect(query('split-preflight-termination-warning')).toBeNull();
  });

  it('counts only live terminals for the target worktree, excluding a different worktree', async () => {
    seedTerminals(KEY, {
      't-1': makeTerminalSession('t-1', { live: true }),
      't-2': makeTerminalSession('t-2', { live: true }),
      // Exited terminal for the SAME worktree must not count.
      't-3': makeTerminalSession('t-3', { live: false }),
    });
    seedTerminals(OTHER_KEY, {
      // Live terminal for a DIFFERENT worktree must be excluded.
      'other-1': makeTerminalSession('other-1', {
        worktreeId: OTHER_WORKTREE_ID,
        live: true,
      }),
    });

    await render();

    const warning = query('split-preflight-termination-warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('2 terminals');
    expect(warning?.textContent).not.toContain('browser tab');
    expect(warning?.textContent).not.toContain('running script');
  });

  it('counts only live browsers for the target worktree, excluding a different worktree', async () => {
    seedBrowsers(KEY, { 'b-1': true, 'b-2': false });
    seedBrowsers(OTHER_KEY, { 'other-b-1': true });

    await render();

    const warning = query('split-preflight-termination-warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('1 browser tab');
    expect(warning?.textContent).not.toContain('terminal');
    expect(warning?.textContent).not.toContain('running script');
  });

  it('counts only running/stopping scripts for the target worktree, excluding a different worktree', async () => {
    seedScripts(KEY, {
      's-1': makeScriptRun({ status: 'running' }),
      's-2': makeScriptRun({ status: 'stopping' }),
      // Settled runs for the SAME worktree must not count.
      's-3': makeScriptRun({ status: 'success' }),
      's-4': makeScriptRun({ status: 'failed' }),
    });
    seedScripts(OTHER_KEY, {
      'other-s-1': makeScriptRun({ status: 'running' }),
    });

    await render();

    const warning = query('split-preflight-termination-warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('2 running scripts');
    expect(warning?.textContent).not.toContain('terminal');
    expect(warning?.textContent).not.toContain('browser tab');
  });

  it('omits the warning entirely when only a DIFFERENT worktree has running resources', async () => {
    seedTerminals(OTHER_KEY, {
      'other-1': makeTerminalSession('other-1', {
        worktreeId: OTHER_WORKTREE_ID,
        live: true,
      }),
    });
    seedBrowsers(OTHER_KEY, { 'other-b-1': true });
    seedScripts(OTHER_KEY, {
      'other-s-1': makeScriptRun({ status: 'running' }),
    });

    await render();

    expect(query('split-preflight-modal')).not.toBeNull();
    expect(query('split-preflight-termination-warning')).toBeNull();
  });

  it('combines all three resource kinds for the target worktree into one warning', async () => {
    seedTerminals(KEY, { 't-1': makeTerminalSession('t-1', { live: true }) });
    seedBrowsers(KEY, { 'b-1': true });
    seedScripts(KEY, { 's-1': makeScriptRun({ status: 'running' }) });

    await render();

    const warning = query('split-preflight-termination-warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('1 terminal');
    expect(warning?.textContent).toContain('1 browser tab');
    expect(warning?.textContent).toContain('1 running script');
  });

  it('updates the warning live when a terminal starts while the modal is already open', async () => {
    await render();

    expect(query('split-preflight-termination-warning')).toBeNull();

    await act(async () => {
      seedTerminals(KEY, {
        't-1': makeTerminalSession('t-1', { live: true }),
      });
      await Promise.resolve();
    });

    const warning = query('split-preflight-termination-warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('1 terminal');
  });

  it('updates the warning live when a running script stops while the modal is already open', async () => {
    seedScripts(KEY, { 's-1': makeScriptRun({ status: 'running' }) });
    await render();

    expect(query('split-preflight-termination-warning')?.textContent).toContain(
      '1 running script',
    );

    await act(async () => {
      seedScripts(KEY, { 's-1': makeScriptRun({ status: 'success' }) });
      await Promise.resolve();
    });

    expect(query('split-preflight-termination-warning')).toBeNull();
  });

  it('updates the warning live when a browser tab closes while the modal is already open', async () => {
    seedBrowsers(KEY, { 'b-1': true });
    await render();

    expect(query('split-preflight-termination-warning')?.textContent).toContain(
      '1 browser tab',
    );

    await act(async () => {
      seedBrowsers(KEY, { 'b-1': false });
      await Promise.resolve();
    });

    expect(query('split-preflight-termination-warning')).toBeNull();
  });

  it('invokes startSplitWorkflow for the target worktree and closes when Start is clicked', async () => {
    await render();

    const startButton = query('split-preflight-start');
    expect(startButton).not.toBeNull();
    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // A5: the shared launch path is now the lockdown-aware startSplitWorkflow.
    // A7: it now carries an explicit mode; the pre-flight Start is always
    // fresh-plan mode.
    expect(api.github.startSplitWorkflow).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'plan',
    });
    expect(api.github.planSplitPr).not.toHaveBeenCalled();
    expect(useActivityStore.getState().splitPreflight).toBeNull();
  });
});

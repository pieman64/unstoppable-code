/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCloudAccountPublicState,
  CodeGraphPreferences,
  MultiRepoSidebarItem,
  PreferencesData,
  PreferencesLoadResult,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { useProjectsStore } from '@/stores/projectsStore';
import { CodeGraphTab } from '../CodeGraphTab';

// Isolate the tab from the live generation queue (covered by its own suite).
jest.mock('../CodeGraphGenerationQueue', () => ({
  CodeGraphGenerationQueue: (): null => null,
}));

const DEFAULT_CODE_GRAPH: CodeGraphPreferences = {
  mode: 'enabled',
  selectedWorkspaceIds: [],
  generationTimeoutMinutes: 30,
};

interface MockApi {
  loadPreferences: jest.Mock<Promise<PreferencesLoadResult>, []>;
  loadCanopyCloudAccount: jest.Mock<Promise<CanopyCloudAccountPublicState>, []>;
  savePreferences: jest.Mock<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >;
}

let originalApiDescriptor: PropertyDescriptor | undefined;

function installApi(codeGraph: CodeGraphPreferences): MockApi {
  const prefs = makeTestPreferences({ codeGraph });
  const api: MockApi = {
    loadPreferences: jest
      .fn<Promise<PreferencesData>, []>()
      .mockResolvedValue(prefs),
    loadCanopyCloudAccount: jest
      .fn<Promise<CanopyCloudAccountPublicState>, []>()
      .mockResolvedValue({
        hasApiKey: false,
        authMode: 'oauth',
        credentialSource: null,
        capabilities: [],
        storageAvailable: true,
        account: null,
      }),
    savePreferences: jest.fn((patch) =>
      Promise.resolve(makeTestPreferences({ codeGraph, ...patch })),
    ),
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

function singleRepo(id: string, name: string): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id,
    name,
    repoPath: `/repos/${id}`,
    color: '#fff',
    worktrees: [],
    collapsed: false,
    order: 0,
  };
}

function sourceBackedWorkspace(id: string, name: string): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    id,
    name,
    color: '#fff',
    sourceRepoPath: `/workspaces/${id}`,
    repos: [
      {
        id: WORKSPACE_ROOT_REPO_ID,
        name,
        repoPath: `/workspaces/${id}`,
      },
    ],
    worktrees: [],
    collapsed: false,
    order: 0,
  };
}

async function renderTab(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<CodeGraphTab />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  );
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressEnter(input: HTMLInputElement): void {
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
}

describe('CodeGraphTab', () => {
  beforeEach(() => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    useProjectsStore.setState({ projects: [] });
  });

  afterEach(() => {
    useProjectsStore.setState({ projects: [] });
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('renders the Code Graph settings page', async () => {
    installApi(DEFAULT_CODE_GRAPH);
    const { container, cleanup } = await renderTab();
    expect(
      container.querySelector('[data-testid="settings-tab-code-graph"]'),
    ).not.toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('Code Graph');
    cleanup();
  });

  it('marks the selected availability mode as the pressed segment', async () => {
    installApi(DEFAULT_CODE_GRAPH);
    const { container, cleanup } = await renderTab();
    const enabled = container.querySelector<HTMLButtonElement>(
      '[data-testid="code-graph-mode-enabled"]',
    );
    const disabled = container.querySelector<HTMLButtonElement>(
      '[data-testid="code-graph-mode-disabled"]',
    );
    expect(enabled?.getAttribute('aria-pressed')).toBe('true');
    expect(disabled?.getAttribute('aria-pressed')).toBe('false');
    expect(enabled?.closest('[role="group"]')?.getAttribute('aria-label')).toBe(
      'Code Graph availability',
    );
    cleanup();
  });

  it('initializes the timeout from persisted preferences', async () => {
    installApi({ ...DEFAULT_CODE_GRAPH, generationTimeoutMinutes: 45 });
    const { container, cleanup } = await renderTab();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="code-graph-generation-timeout"]',
    );
    expect(input?.value).toBe('45');
    cleanup();
  });

  it('saves the complete codeGraph object when a mode is chosen', async () => {
    const api = installApi(DEFAULT_CODE_GRAPH);
    const { container, cleanup } = await renderTab();
    const disabled = container.querySelector<HTMLButtonElement>(
      '[data-testid="code-graph-mode-disabled"]',
    );
    act(() => disabled?.click());
    await flush();
    expect(api.savePreferences).toHaveBeenCalledWith({
      codeGraph: {
        mode: 'disabled',
        selectedWorkspaceIds: [],
        generationTimeoutMinutes: 30,
      },
    });
    cleanup();
  });

  it('rolls back and shows an error when a mode save fails', async () => {
    const api = installApi(DEFAULT_CODE_GRAPH);
    api.savePreferences.mockRejectedValueOnce(new Error('nope'));
    const { container, cleanup } = await renderTab();
    const disabled = container.querySelector<HTMLButtonElement>(
      '[data-testid="code-graph-mode-disabled"]',
    );
    act(() => disabled?.click());
    await flush();
    // Enabled remains selected after rollback.
    const enabled = container.querySelector(
      '[data-testid="code-graph-mode-enabled"]',
    );
    expect(enabled?.getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain(
      'Could not save Code Graph settings',
    );
    cleanup();
  });

  it('reveals the picker in select-workspaces mode and saves a toggle', async () => {
    useProjectsStore.setState({
      projects: [singleRepo('ws-1', 'Alpha'), singleRepo('ws-2', 'Beta')],
    });
    const api = installApi({
      ...DEFAULT_CODE_GRAPH,
      mode: 'selected-workspaces',
    });
    const { container, cleanup } = await renderTab();
    const option = container.querySelector<HTMLButtonElement>(
      '[data-testid="code-graph-workspace-picker-option-ws-1"]',
    );
    expect(option).not.toBeNull();
    act(() => option?.click());
    await flush();
    expect(api.savePreferences).toHaveBeenCalledWith({
      codeGraph: {
        mode: 'selected-workspaces',
        selectedWorkspaceIds: ['ws-1'],
        generationTimeoutMinutes: 30,
      },
    });
    cleanup();
  });

  it('shows the empty picker message when no code projects exist', async () => {
    installApi({ ...DEFAULT_CODE_GRAPH, mode: 'selected-workspaces' });
    const { container, cleanup } = await renderTab();
    expect(
      container.querySelector(
        '[data-testid="code-graph-workspace-picker-empty"]',
      ),
    ).not.toBeNull();
    cleanup();
  });

  it('includes a source-backed project whose only repo is the project root', async () => {
    useProjectsStore.setState({
      projects: [sourceBackedWorkspace('ws-root', 'Root project')],
    });
    installApi({ ...DEFAULT_CODE_GRAPH, mode: 'selected-workspaces' });
    const { container, cleanup } = await renderTab();

    expect(
      container.querySelector(
        '[data-testid="code-graph-workspace-picker-option-ws-root"]',
      ),
    ).not.toBeNull();
    cleanup();
  });

  it('saves a valid timeout on Enter with the complete object', async () => {
    const api = installApi(DEFAULT_CODE_GRAPH);
    const { container, cleanup } = await renderTab();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="code-graph-generation-timeout"]',
    );
    if (!input) throw new Error('timeout input missing');
    act(() => setInputValue(input, '120'));
    act(() => pressEnter(input));
    await flush();
    expect(api.savePreferences).toHaveBeenCalledWith({
      codeGraph: {
        mode: 'enabled',
        selectedWorkspaceIds: [],
        generationTimeoutMinutes: 120,
      },
    });
    cleanup();
  });

  it('keeps an invalid timeout draft local and does not persist it', async () => {
    const api = installApi(DEFAULT_CODE_GRAPH);
    const { container, cleanup } = await renderTab();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="code-graph-generation-timeout"]',
    );
    if (!input) throw new Error('timeout input missing');
    act(() => setInputValue(input, '5000'));
    act(() => pressEnter(input));
    await flush();
    expect(api.savePreferences).not.toHaveBeenCalled();
    expect(
      container.querySelector(
        '[data-testid="code-graph-generation-timeout-error"]',
      )?.textContent,
    ).toContain('1 to 1,440');
    cleanup();
  });

  it('keeps the timeout editable while the mode is Disabled', async () => {
    const api = installApi({ ...DEFAULT_CODE_GRAPH, mode: 'disabled' });
    const { container, cleanup } = await renderTab();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="code-graph-generation-timeout"]',
    );
    expect(input?.disabled).toBe(false);
    if (!input) throw new Error('timeout input missing');
    act(() => setInputValue(input, '1440'));
    act(() => pressEnter(input));
    await flush();
    expect(api.savePreferences).toHaveBeenCalledWith({
      codeGraph: {
        mode: 'disabled',
        selectedWorkspaceIds: [],
        generationTimeoutMinutes: 1440,
      },
    });
    cleanup();
  });
});

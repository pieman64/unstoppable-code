/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  EnvironmentConfigData,
  EnvironmentDefinition,
  LoadEnvironmentConfigResponse,
  SaveEnvironmentConfigResponse,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { createDefaultEnvironmentConfig } from '@canopy/desktop-shared/lib/user-environment';

import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { EnvironmentsTab } from '../EnvironmentsTab';
import { EnvironmentUsageList } from '../../environments/EnvironmentUsageList';
import { useEnvironmentsStore } from '@/stores/environmentsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { setNativeInputValue } from '@/test-utils/dom';

interface TestApi {
  loadEnvironmentConfig: jest.Mock<Promise<LoadEnvironmentConfigResponse>, []>;
  saveEnvironmentConfig: jest.Mock<
    Promise<SaveEnvironmentConfigResponse>,
    [EnvironmentConfigData]
  >;
}

function installApi(initial: EnvironmentConfigData): TestApi {
  const api: TestApi = {
    loadEnvironmentConfig: jest.fn(() =>
      Promise.resolve({ data: initial, encryptionAvailable: true }),
    ),
    saveEnvironmentConfig: jest.fn((data: EnvironmentConfigData) =>
      Promise.resolve({ ok: true as const, data, encryptionAvailable: true }),
    ),
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api,
  });
  return api;
}

function setProjects(): void {
  useProjectsStore.setState((state) => ({
    ...state,
    projects: [] as SidebarItem[],
  }));
}

function render(node: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(container: ParentNode, testId: string): void {
  const element = container.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (!element) throw new Error(`Missing ${testId}`);
  act(() => element.click());
}

function byTestId(container: ParentNode, testId: string): Element | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => setNativeInputValue(input, value));
}

function heading(container: ParentNode): string | null | undefined {
  return container.querySelector('h1')?.textContent;
}

function customEnvironment(
  overrides: Partial<EnvironmentDefinition> = {},
): EnvironmentDefinition {
  return {
    id: 'staging',
    name: 'Staging',
    parentId: null,
    isDefault: false,
    uiMode: 'key-value' as const,
    variables: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('EnvironmentsTab', () => {
  beforeEach(() => {
    useEnvironmentsStore.setState({
      data: null,
      encryptionAvailable: true,
      status: 'idle',
      error: null,
      secureStorageFailure: null,
      storageFailureAction: null,
      selectedEnvironmentId: null,
      loadVersion: 0,
      requestVersion: 0,
      dataVersion: 0,
      pendingSave: null,
      environmentSaveVersion: 0,
      lastSavedEnvironmentData: null,
      environmentBaseline: null,
    });
    setProjects();
    useNavigationStore.setState({
      pendingWorkspaceSettings: undefined,
      workspaceSettingsModalOpen: false,
      settingsOpen: true,
      settingsInitialSection: 'environment',
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('retries a failed read probe without saving the retained draft or duplicating notices', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api = installApi(initial);
    const failure = {
      version: 1 as const,
      code: 'SECURE_STORAGE_PROBE_FAILED' as const,
      operation: 'probe' as const,
      state: 'unknown' as const,
      backend: null,
      retryable: true,
    };
    useEnvironmentsStore.setState({
      data: initial,
      status: 'error',
      secureStorageFailure: failure,
      storageFailureAction: 'load',
    });
    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    expect(
      container.querySelector(
        '[data-testid="environment-editor-encryption-warning"]',
      ),
    ).toBeNull();
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="secure-storage-retry"]',
    );
    expect(retry).not.toBeNull();
    act(() => {
      retry?.click();
    });
    await flushPromises();
    expect(api.loadEnvironmentConfig).toHaveBeenCalledTimes(1);
    expect(api.saveEnvironmentConfig).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });

  it('uses only the typed notice for a failed initial read', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const api = installApi(initial);
    api.loadEnvironmentConfig.mockResolvedValue({
      ok: false,
      error: 'Read failed',
      secureStorageFailure: {
        version: 1,
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        operation: 'read',
        state: 'locked',
        backend: null,
        retryable: true,
      },
    });
    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    expect(
      container.querySelector('[data-testid="secure-storage-notice"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="environments-error"]'),
    ).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('tracks cowork assignment usage and deep-links to its Environment tab with Settings closed', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    initial.workspaceAssignments.push({
      workspaceId: 'cowork-1',
      runtimes: { agent: 'default-agent' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    initial.workspaceAssignments.push({
      workspaceId: 'code-1',
      runtimes: { agent: 'default-agent' },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    installApi(initial);
    useProjectsStore.setState((state) => ({
      ...state,
      projects: [
        {
          id: 'cowork-1',
          name: 'Research',
          type: 'cowork',
          color: '#123456',
          collapsed: false,
          order: 0,
        },
        {
          id: 'code-1',
          name: 'Code Workspace',
          type: 'single-repo',
          repoPath: '/repos/code-1',
          color: '#654321',
          collapsed: false,
          order: 1,
          worktrees: [],
        },
      ],
    }));

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    click(container, 'environments-list-row-default-agent');
    await flushPromises();

    const usageButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Research'),
    );
    expect(usageButton).toBeDefined();
    expect(
      usageButton?.querySelector(
        '[data-testid="environment-usage-workspace-icon-cowork"]',
      ),
    ).not.toBeNull();
    expect(
      usageButton?.querySelector(
        '[data-testid="environment-usage-workspace-icon-code"]',
      ),
    ).toBeNull();
    const codeUsageButton = Array.from(
      container.querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('Code Workspace'));
    expect(
      codeUsageButton?.querySelector(
        '[data-testid="environment-usage-workspace-icon-code"]',
      ),
    ).not.toBeNull();
    expect(
      codeUsageButton?.querySelector(
        '[data-testid="environment-usage-workspace-icon-cowork"]',
      ),
    ).toBeNull();
    act(() => usageButton?.click());

    // Settings closes first so the project dialog is not behind it.
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
    expect(useNavigationStore.getState().pendingWorkspaceSettings).toEqual({
      workspaceId: 'cowork-1',
      initialTab: 'environment',
    });

    act(() => root.unmount());
  });

  it('indexes project kinds once while building environment usage rows', () => {
    const config = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    config.workspaceAssignments.push({
      workspaceId: 'cowork-1',
      runtimes: {
        canopy: 'default-agent',
        agent: 'default-agent',
        pipeline: 'default-agent',
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    let idReads = 0;
    const workspace = {
      get id(): string {
        idReads += 1;
        return 'cowork-1';
      },
      name: 'Research',
      workspaceKind: 'cowork' as const,
    };

    const { container, root } = render(
      <EnvironmentUsageList
        environmentId="default-agent"
        config={config}
        workspaces={[workspace]}
        onOpenWorkspaceSettings={jest.fn()}
      />,
    );

    expect(container.querySelectorAll('button')).toHaveLength(3);
    expect(idReads).toBe(2);

    act(() => root.unmount());
  });

  it('renders the four seeded default environments and global runtime defaults modal', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    installApi(initial);

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();

    expect(byTestId(container, 'settings-tab-environment')).not.toBeNull();
    expect(heading(container)).toBe('Environments');
    expect(
      container.querySelectorAll('[data-testid^="environments-list-row-"]'),
    ).toHaveLength(4);
    expect(
      document.querySelector(
        '[data-testid="environments-global-runtime-canopy"]',
      ),
    ).toBeNull();

    click(container, 'environments-open-global-defaults');
    await flushPromises();

    for (const runtime of ['canopy', 'agent', 'pipeline']) {
      expect(
        document.querySelector(
          `[data-testid="environments-global-runtime-${runtime}"]`,
        ),
      ).not.toBeNull();
    }

    act(() => root.unmount());
  });

  it('orders default environments before custom environments using the protected default order', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    initial.environments = [
      customEnvironment({ id: 'aaa-custom', name: 'AAA Custom' }),
      initial.environments[3],
      initial.environments[1],
      initial.environments[2],
      initial.environments[0],
    ];
    installApi(initial);

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();

    const rows = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid^="environments-list-row-"]',
      ),
    );
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      'environments-list-row-default-overall',
      'environments-list-row-default-canopy',
      'environments-list-row-default-agent',
      'environments-list-row-default-pipeline',
      'environments-list-row-aaa-custom',
    ]);

    act(() => root.unmount());
  });

  it('blocks resolved values in session replay', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    initial.environments = [
      ...initial.environments,
      customEnvironment({
        id: 'staging-secrets',
        name: 'Staging Secrets',
        parentId: initial.environments[0].id,
        variables: [{ key: 'API_TOKEN', value: 'sk-live-123', secret: true }],
      }),
    ];
    installApi(initial);

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();

    expect(
      byTestId(container, 'environments-list-row-staging-secrets')?.textContent,
    ).toContain('Inherits');
    click(container, 'environments-list-row-staging-secrets');
    await flushPromises();

    const resolved = byTestId(container, 'environments-resolved-list');
    expect(resolved?.textContent).toContain('API_TOKEN');
    expect(resolved?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);

    click(container, 'environments-delete');
    const dialogTitle = Array.from(document.body.querySelectorAll('h2')).find(
      (element) =>
        element.textContent === 'Delete environment “Staging Secrets”?',
    );
    expect(dialogTitle).toBeDefined();

    act(() => root.unmount());
  });

  it('names the child environment in a parent usage row', async () => {
    installApi(createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z'));

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    click(container, 'environments-list-row-default-overall');
    await flushPromises();

    expect(
      byTestId(container, 'environment-usage-list')?.textContent,
    ).toContain('Parent of Canopy');

    act(() => root.unmount());
  });

  it('disables delete for default environments', async () => {
    installApi(createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z'));

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    click(container, 'environments-list-row-default-agent');

    const deleteButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="environments-delete"]',
    );
    expect(deleteButton?.disabled).toBe(true);
    expect(
      byTestId(container, 'environments-delete-blocked-reason')?.textContent,
    ).toBe('Default environments cannot be deleted.');

    act(() => root.unmount());
  });

  it('shows no-runtime-assignment copy for parent-only environments', async () => {
    installApi(createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z'));

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    click(container, 'environments-list-row-default-overall');
    await flushPromises();

    expect(byTestId(container, 'environment-usage-empty')?.textContent).toBe(
      'This environment is not assigned to any runtime.',
    );
    expect(
      byTestId(container, 'environment-usage-list')?.textContent,
    ).toContain('Parent of Canopy');

    act(() => root.unmount());
  });

  it('keeps local edits dirty until Save changes succeeds', async () => {
    installApi(createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z'));

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();

    expect(byTestId(container, 'environments-unsaved')).toBeNull();
    click(container, 'environments-new-environment');
    await flushPromises();
    expect(byTestId(container, 'environments-unsaved')?.textContent).toBe(
      'Unsaved changes',
    );

    click(container, 'environments-save');
    await flushPromises();
    expect(byTestId(container, 'environments-unsaved')).toBeNull();

    act(() => root.unmount());
  });

  it('keeps unsaved edits marked after the tab remounts', async () => {
    installApi(createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z'));

    const first = render(<EnvironmentsTab />);
    await flushPromises();
    click(first.container, 'environments-new-environment');
    await flushPromises();
    act(() => first.root.unmount());

    // Settings remounts the tab on every open and section switch.
    const second = render(<EnvironmentsTab />);
    await flushPromises();
    expect(
      byTestId(second.container, 'environments-unsaved')?.textContent,
    ).toBe('Unsaved changes');

    act(() => second.root.unmount());
  });

  it('keeps a draft unsaved after a workspace assignment save', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    installApi(initial);

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    click(container, 'environments-new-environment');
    await flushPromises();
    const draftCount =
      useEnvironmentsStore.getState().data?.environments.length;

    // The workspace dialog saves the persisted config with new assignments.
    await act(async () => {
      await useEnvironmentsStore.getState().saveWorkspaceAssignments({
        ...initial,
        workspaceAssignments: [
          {
            workspaceId: 'workspace-1',
            runtimes: { agent: 'default-agent' },
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      });
    });

    const state = useEnvironmentsStore.getState();
    expect(state.data?.environments).toHaveLength(draftCount ?? -1);
    expect(state.data?.workspaceAssignments).toHaveLength(1);
    expect(byTestId(container, 'environments-unsaved')?.textContent).toBe(
      'Unsaved changes',
    );

    act(() => root.unmount());
  });

  it('saves the config when Save changes is clicked', async () => {
    const api = installApi(
      createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z'),
    );

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    click(container, 'environments-new-environment');
    await flushPromises();

    expect(byTestId(container, 'environments-save')?.textContent).toBe(
      'Save changes',
    );
    click(container, 'environments-save');
    await flushPromises();

    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it('opens a row into its detail and Back returns to the list', async () => {
    installApi(createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z'));

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();

    expect(byTestId(container, 'settings-page-back')).toBeNull();
    expect(byTestId(container, 'environments-name-input')).toBeNull();

    click(container, 'environments-list-row-default-agent');
    expect(heading(container)).toBe('Agents');
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid="environments-name-input"]',
      )?.value,
    ).toBe('Agents');
    expect(byTestId(container, 'environments-list')).toBeNull();
    expect(useEnvironmentsStore.getState().selectedEnvironmentId).toBe(
      'default-agent',
    );

    click(container, 'settings-page-back');
    expect(heading(container)).toBe('Environments');
    expect(byTestId(container, 'environments-list')).not.toBeNull();
    // Back leaves the store selection alone.
    expect(useEnvironmentsStore.getState().selectedEnvironmentId).toBe(
      'default-agent',
    );

    act(() => root.unmount());
  });

  it('opens the detail of a newly created environment', async () => {
    installApi(createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z'));

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    click(container, 'environments-new-environment');

    expect(heading(container)).toBe('Untitled environment');
    expect(byTestId(container, 'environments-delete')).not.toBeNull();

    act(() => root.unmount());
  });

  it('returns to the list after deleting the open environment', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    initial.environments = [...initial.environments, customEnvironment()];
    installApi(initial);

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    click(container, 'environments-list-row-staging');
    click(container, 'environments-delete');
    click(document.body, 'environments-delete-confirm');

    expect(heading(container)).toBe('Environments');
    expect(byTestId(container, 'environments-list-row-staging')).toBeNull();
    expect(byTestId(container, 'environments-unsaved')).not.toBeNull();
    expect(useEnvironmentsStore.getState().selectedEnvironmentId).toBeNull();

    act(() => root.unmount());
  });

  it('keeps a detail edit unsaved after Back and saves it from the list', async () => {
    const api = installApi(
      createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z'),
    );

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    click(container, 'environments-list-row-default-agent');
    const nameInput = container.querySelector<HTMLInputElement>(
      '[data-testid="environments-name-input"]',
    );
    if (!nameInput) throw new Error('Missing name input');
    typeInto(nameInput, 'Agents (local)');
    expect(heading(container)).toBe('Agents (local)');

    click(container, 'settings-page-back');
    expect(byTestId(container, 'environments-unsaved')?.textContent).toBe(
      'Unsaved changes',
    );
    expect(
      byTestId(container, 'environments-list-row-default-agent')?.textContent,
    ).toContain('Agents (local)');

    click(container, 'environments-save');
    await flushPromises();

    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(1);
    const saved = api.saveEnvironmentConfig.mock.calls[0]?.[0];
    expect(
      saved?.environments.find(
        (environment) => environment.id === 'default-agent',
      )?.name,
    ).toBe('Agents (local)');
    expect(byTestId(container, 'environments-unsaved')).toBeNull();

    act(() => root.unmount());
  });

  it('keeps save blocked by an invalid variable after Back and names its environment', async () => {
    installApi(createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z'));

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    click(container, 'environments-list-row-default-agent');
    click(container, 'environment-editor-add-row');
    const keyInput = container.querySelector<HTMLInputElement>(
      'input[data-testid^="environment-editor-key-"]',
    );
    if (!keyInput) throw new Error('Missing key input');
    typeInto(keyInput, '1-invalid');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="environments-save"]',
      )?.disabled,
    ).toBe(true);

    click(container, 'settings-page-back');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="environments-save"]',
      )?.disabled,
    ).toBe(true);
    expect(byTestId(container, 'environments-validation')?.textContent).toMatch(
      /^Agents: /,
    );

    // Another environment's editor reports no problem on mount; that must not
    // clear the problem kept for Agents.
    click(container, 'environments-list-row-default-pipeline');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="environments-save"]',
      )?.disabled,
    ).toBe(true);
    expect(byTestId(container, 'environments-validation')?.textContent).toMatch(
      /^Agents: /,
    );

    act(() => root.unmount());
  });

  it('falls back to the list when the open environment leaves the store', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    initial.environments = [...initial.environments, customEnvironment()];
    installApi(initial);

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    click(container, 'environments-list-row-staging');
    expect(heading(container)).toBe('Staging');

    act(() => {
      const current = useEnvironmentsStore.getState().data;
      if (!current) throw new Error('Missing data');
      useEnvironmentsStore.getState().setLocal({
        ...current,
        environments: current.environments.filter(
          (environment) => environment.id !== 'staging',
        ),
      });
    });

    expect(heading(container)).toBe('Environments');
    expect(byTestId(container, 'environments-list')).not.toBeNull();

    act(() => root.unmount());
  });

  it('keeps the search text and shows a distinct message when nothing matches', async () => {
    installApi(createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z'));

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();

    const search = container.querySelector<HTMLInputElement>(
      '[data-testid="environments-search"]',
    );
    if (!search) throw new Error('Missing search');
    typeInto(search, 'agen');
    expect(
      container.querySelectorAll('[data-testid^="environments-list-row-"]'),
    ).toHaveLength(1);

    typeInto(search, 'nothing-like-this');
    expect(byTestId(container, 'environments-list-no-matches')).not.toBeNull();
    expect(byTestId(container, 'environments-list-empty')).toBeNull();
    expect(search.value).toBe('nothing-like-this');

    act(() => root.unmount());
  });
  it('retries a failed assignment save without submitting a later tab draft', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const assignment = {
      ...initial,
      workspaceAssignments: [
        {
          workspaceId: 'ws-1',
          runtimes: { agent: 'default-agent' },
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const draft = {
      ...initial,
      environments: initial.environments.map((environment) =>
        environment.id === 'default-overall'
          ? {
              ...environment,
              variables: [{ key: 'DRAFT', value: 'unsubmitted' }],
            }
          : environment,
      ),
    };
    const api = installApi(initial);
    api.saveEnvironmentConfig
      .mockResolvedValueOnce({
        ok: false,
        error: 'Storage failed.',
        secureStorageFailure: {
          version: 1,
          code: 'SECURE_STORAGE_ENCRYPT_FAILED',
          operation: 'write',
          state: 'locked',
          backend: null,
          retryable: true,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: assignment,
        encryptionAvailable: true,
      });
    useEnvironmentsStore.setState({ data: initial, status: 'ready' });
    await expect(
      useEnvironmentsStore.getState().saveWorkspaceAssignments(assignment),
    ).rejects.toThrow('Storage failed.');

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    act(() => useEnvironmentsStore.getState().setLocal(draft));
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="secure-storage-retry"]',
        )
        ?.click();
    });
    await flushPromises();

    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(2);
    expect(api.saveEnvironmentConfig.mock.calls[1][0]).toEqual(assignment);
    expect(useEnvironmentsStore.getState().data?.environments).toEqual(
      draft.environments,
    );
    act(() => root.unmount());
    container.remove();
  });

  it('marks an unchanged failed tab payload saved after exact retry', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const submitted = {
      ...initial,
      globalRuntimes: { ...initial.globalRuntimes, agent: 'default-overall' },
    };
    const api = installApi(initial);
    api.saveEnvironmentConfig.mockResolvedValueOnce({
      ok: false,
      error: 'Storage failed.',
      secureStorageFailure: {
        version: 1,
        code: 'SECURE_STORAGE_ENCRYPT_FAILED',
        operation: 'write',
        state: 'locked',
        backend: null,
        retryable: true,
      },
    });
    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    act(() => useEnvironmentsStore.getState().setLocal(submitted));
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="environments-save"]')
        ?.click(),
    );
    await flushPromises();
    expect(
      container.querySelector('[data-testid="secure-storage-retry"]'),
    ).not.toBeNull();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="secure-storage-retry"]',
        )
        ?.click(),
    );
    await flushPromises();
    expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="environments-unsaved"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="environments-save-status"]'),
    ).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('keeps a newer tab draft unsaved after replaying the failed payload', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const submitted = {
      ...initial,
      globalRuntimes: { ...initial.globalRuntimes, agent: 'default-overall' },
    };
    const newer = {
      ...submitted,
      globalRuntimes: { ...submitted.globalRuntimes, agent: 'default-canopy' },
    };
    const api = installApi(initial);
    api.saveEnvironmentConfig.mockResolvedValueOnce({
      ok: false,
      error: 'Storage failed.',
      secureStorageFailure: {
        version: 1,
        code: 'SECURE_STORAGE_ENCRYPT_FAILED',
        operation: 'write',
        state: 'locked',
        backend: null,
        retryable: true,
      },
    });
    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    act(() => useEnvironmentsStore.getState().setLocal(submitted));
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="environments-save"]')
        ?.click(),
    );
    await flushPromises();
    act(() => useEnvironmentsStore.getState().setLocal(newer));
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="secure-storage-retry"]',
        )
        ?.click(),
    );
    await flushPromises();
    expect(api.saveEnvironmentConfig.mock.calls[1][0]).toEqual(submitted);
    expect(useEnvironmentsStore.getState().data).toEqual(newer);
    expect(
      container.querySelector('[data-testid="environments-unsaved"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="environments-save-status"]'),
    ).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it.each(['generic error', 'rejection'] as const)(
    'retains the failed payload Retry across remount after a retry %s',
    async (retryFailure) => {
      const initial = createDefaultEnvironmentConfig(
        '2026-01-01T00:00:00.000Z',
      );
      const submitted = {
        ...initial,
        globalRuntimes: { ...initial.globalRuntimes, agent: 'default-overall' },
      };
      const newer = {
        ...submitted,
        globalRuntimes: {
          ...submitted.globalRuntimes,
          agent: 'default-canopy',
        },
      };
      const api = installApi(initial);
      api.saveEnvironmentConfig.mockResolvedValueOnce({
        ok: false,
        error: 'Storage failed.',
        secureStorageFailure: {
          version: 1,
          code: 'SECURE_STORAGE_ENCRYPT_FAILED',
          operation: 'write',
          state: 'locked',
          backend: null,
          retryable: true,
        },
      });
      if (retryFailure === 'rejection') {
        api.saveEnvironmentConfig.mockRejectedValueOnce(
          new Error('The retry failed.'),
        );
      } else {
        api.saveEnvironmentConfig.mockResolvedValueOnce({
          ok: false,
          error: 'The retry failed.',
        });
      }
      let mounted = render(<EnvironmentsTab />);
      try {
        await flushPromises();
        act(() => useEnvironmentsStore.getState().setLocal(submitted));
        act(() =>
          mounted.container
            .querySelector<HTMLButtonElement>(
              '[data-testid="environments-save"]',
            )
            ?.click(),
        );
        await flushPromises();
        act(() => useEnvironmentsStore.getState().setLocal(newer));
        act(() =>
          mounted.container
            .querySelector<HTMLButtonElement>(
              '[data-testid="secure-storage-retry"]',
            )
            ?.click(),
        );
        await flushPromises();
        expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(2);
        expect(api.saveEnvironmentConfig.mock.calls[1][0]).toEqual(submitted);
        expect(useEnvironmentsStore.getState().pendingSave?.data).toEqual(
          submitted,
        );
        expect(useEnvironmentsStore.getState().data).toEqual(newer);
        expect(
          mounted.container.querySelector(
            '[data-testid="secure-storage-notice"]',
          ),
        ).not.toBeNull();
        expect(
          mounted.container.querySelector(
            '[data-testid="environments-save-error"]',
          ),
        ).toBeNull();

        act(() => mounted.root.unmount());
        mounted.container.remove();
        mounted = render(<EnvironmentsTab />);
        await flushPromises();
        expect(
          mounted.container.querySelector(
            '[data-testid="secure-storage-notice"]',
          )?.textContent,
        ).toContain('Your credentials were not saved.');
        const retry = mounted.container.querySelector<HTMLButtonElement>(
          '[data-testid="secure-storage-retry"]',
        );
        expect(retry).not.toBeNull();
        expect(retry?.disabled).toBe(false);
        act(() => retry?.click());
        await flushPromises();
        expect(api.saveEnvironmentConfig).toHaveBeenCalledTimes(3);
        expect(api.saveEnvironmentConfig.mock.calls[2][0]).toEqual(submitted);
        expect(api.loadEnvironmentConfig).toHaveBeenCalledTimes(1);
        expect(useEnvironmentsStore.getState().data).toEqual(newer);
        expect(useEnvironmentsStore.getState().pendingSave).toBeNull();
        expect(
          mounted.container.querySelector(
            '[data-testid="secure-storage-notice"]',
          ),
        ).toBeNull();
        expect(
          mounted.container.querySelector(
            '[data-testid="environments-unsaved"]',
          ),
        ).not.toBeNull();
        expect(
          mounted.container.querySelector(
            '[data-testid="environments-save-status"]',
          ),
        ).toBeNull();
      } finally {
        act(() => mounted.root.unmount());
        mounted.container.remove();
      }
    },
  );

  it('keeps a newer tab draft unsaved when it changes during an explicit save', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    const submitted = {
      ...initial,
      globalRuntimes: { ...initial.globalRuntimes, agent: 'default-overall' },
    };
    const newer = {
      ...submitted,
      globalRuntimes: { ...submitted.globalRuntimes, agent: 'default-canopy' },
    };
    const api = installApi(initial);
    let resolveSave: (value: SaveEnvironmentConfigResponse) => void = () =>
      undefined;
    api.saveEnvironmentConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    act(() => useEnvironmentsStore.getState().setLocal(submitted));
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="environments-save"]')
        ?.click(),
    );
    await flushPromises();
    act(() => useEnvironmentsStore.getState().setLocal(newer));
    await act(async () => {
      resolveSave({ ok: true, data: submitted, encryptionAvailable: true });
      await Promise.resolve();
    });
    await flushPromises();
    expect(api.saveEnvironmentConfig.mock.calls[0][0]).toEqual(submitted);
    expect(useEnvironmentsStore.getState().data).toEqual(newer);
    expect(
      container.querySelector('[data-testid="environments-unsaved"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="environments-save-status"]'),
    ).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('keeps a newer draft dirty after a saved payload is replayed and the tab remounts', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    installApi(initial);
    const first = render(<EnvironmentsTab />);
    await flushPromises();
    const newer = {
      ...initial,
      globalRuntimes: { ...initial.globalRuntimes, agent: 'default-overall' },
    };
    await act(async () => {
      useEnvironmentsStore.getState().setLocal(newer);
      await useEnvironmentsStore.getState().save(initial, true);
    });
    act(() => first.root.unmount());
    first.container.remove();
    const second = render(<EnvironmentsTab />);
    await flushPromises();
    try {
      expect(
        second.container.querySelector('[data-testid="environments-unsaved"]'),
      ).not.toBeNull();
      expect(
        second.container.querySelector(
          '[data-testid="environments-save-status"]',
        ),
      ).toBeNull();
    } finally {
      act(() => second.root.unmount());
      second.container.remove();
    }
  });

  it('shows unsaved variable edits after an App Advisor assignment save before opening Environments', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    initial.environments[0].variables = [{ key: 'EXAMPLE', value: 'initial' }];
    initial.environments[0].uiMode = 'bulk';
    const api = installApi(initial);
    // App Advisor can save its assignment before the Environments tab loads.
    await useEnvironmentsStore.getState().saveWorkspaceAssignments({
      ...initial,
      workspaceAssignments: [
        {
          workspaceId: 'app-advisor',
          runtimes: { agent: 'default-agent' },
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    try {
      expect(api.loadEnvironmentConfig).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector('[data-testid="environments-unsaved"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="environments-save-status"]'),
      ).toBeNull();
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="environments-list-row-default-overall"]',
          )
          ?.click(),
      );
      const input = container.querySelector<HTMLTextAreaElement>(
        '[data-testid="environment-editor-bulk-textarea"]',
      );
      if (!input)
        throw new Error('Expected the environment variable value input.');
      const valueDescriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      );
      if (!valueDescriptor?.set)
        throw new Error('Expected the native input value setter.');
      act(() => {
        valueDescriptor.set?.call(input, 'EXAMPLE=edited');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(
        useEnvironmentsStore.getState().data?.environments[0].variables,
      ).toEqual([{ key: 'EXAMPLE', value: 'edited' }]);
      expect(
        container.querySelector('[data-testid="environments-unsaved"]')
          ?.textContent,
      ).toBe('Unsaved changes');
      expect(
        container.querySelector('[data-testid="environments-save-status"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('keeps external assignment saves out of the tab-owned dirty baseline', async () => {
    const initial = createDefaultEnvironmentConfig('2026-01-01T00:00:00.000Z');
    installApi(initial);
    const { container, root } = render(<EnvironmentsTab />);
    await flushPromises();
    try {
      await act(async () => {
        await useEnvironmentsStore.getState().saveWorkspaceAssignments({
          ...initial,
          workspaceAssignments: [
            {
              workspaceId: 'ws-1',
              runtimes: { agent: 'default-overall' },
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        });
      });
      expect(
        container.querySelector('[data-testid="environments-unsaved"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="environments-save-status"]'),
      ).toBeNull();
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="environments-new-environment"]',
          )
          ?.click(),
      );
      expect(
        container.querySelector('[data-testid="environments-unsaved"]'),
      ).not.toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it.each([false, true])(
    'does not replay a previous save on remount after assignment changes: %s',
    async (changeAssignment) => {
      const initial = createDefaultEnvironmentConfig(
        '2026-01-01T00:00:00.000Z',
      );
      installApi(initial);
      const first = render(<EnvironmentsTab />);
      await flushPromises();
      await act(async () => {
        await useEnvironmentsStore.getState().save(initial);
      });
      expect(
        first.container.querySelector(
          '[data-testid="environments-save-status"]',
        )?.textContent,
      ).toBe('Saved.');
      act(() => first.root.unmount());
      first.container.remove();

      if (changeAssignment) {
        await act(async () => {
          await useEnvironmentsStore.getState().saveWorkspaceAssignments({
            ...initial,
            workspaceAssignments: [
              {
                workspaceId: 'ws-1',
                runtimes: { agent: 'default-overall' },
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          });
        });
      }

      const second = render(<EnvironmentsTab />);
      await flushPromises();
      try {
        expect(
          second.container.querySelector(
            '[data-testid="environments-unsaved"]',
          ),
        ).toBeNull();
        expect(
          second.container.querySelector(
            '[data-testid="environments-save-status"]',
          ),
        ).toBeNull();
      } finally {
        act(() => second.root.unmount());
        second.container.remove();
      }
    },
  );
});

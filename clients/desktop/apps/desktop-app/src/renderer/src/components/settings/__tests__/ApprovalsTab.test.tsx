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
  ApprovalDefaults,
  ApprovalMode,
  ApprovalRule,
  ApprovalRulesListRequest,
  ApprovalRulesListResponse,
  ApprovalRuleAddRequest,
  ApprovalRuleRemoveRequest,
  PreferencesData,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { CANOPY_PREFERENCES_UPDATED_EVENT } from '@/lib/preferences-events';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { ApprovalsTab } from '../ApprovalsTab';
import {
  querySettingsSelect,
  type SettingsSelectProbe,
} from '@canopy/ui-app/settings/__tests__/helpers/settings-select';

type PreferencesSyncedCallback = (preferences: PreferencesData) => void;

interface MockApi {
  loadPreferences: jest.Mock<Promise<PreferencesData>, []>;
  savePreferences: jest.Mock<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >;
  setApprovalDefaultPreference: jest.Mock<
    Promise<PreferencesData>,
    [{ surface: keyof ApprovalDefaults; mode: ApprovalMode }]
  >;
  onPreferencesSynced: jest.Mock<() => void, [PreferencesSyncedCallback]>;
  approvals: {
    listRules: jest.Mock<
      Promise<ApprovalRulesListResponse>,
      [ApprovalRulesListRequest]
    >;
    addRule: jest.Mock<Promise<void>, [ApprovalRuleAddRequest]>;
    removeRule: jest.Mock<Promise<void>, [ApprovalRuleRemoveRequest]>;
  };
}

let originalApiDescriptor: PropertyDescriptor | undefined;

function installApi(options?: {
  approvalDefaults?: ApprovalDefaults;
  globalRules?: ApprovalRule[];
  projectRules?: ApprovalRule[];
}): MockApi {
  const prefs = makeTestPreferences(
    options?.approvalDefaults
      ? { approvalDefaults: options.approvalDefaults }
      : {},
  );
  const api: MockApi = {
    loadPreferences: jest
      .fn<Promise<PreferencesData>, []>()
      .mockResolvedValue(prefs),
    savePreferences: jest.fn((patch: Partial<PreferencesData>) =>
      Promise.resolve(makeTestPreferences({ ...prefs, ...patch })),
    ),
    // Mirrors the main handler: merges ONE key into the persisted object.
    setApprovalDefaultPreference: jest.fn(
      (request: { surface: keyof ApprovalDefaults; mode: ApprovalMode }) =>
        Promise.resolve(
          makeTestPreferences({
            ...prefs,
            approvalDefaults: {
              ...prefs.approvalDefaults,
              [request.surface]: request.mode,
            },
          }),
        ),
    ),
    onPreferencesSynced: jest
      .fn<() => void, [PreferencesSyncedCallback]>()
      .mockReturnValue(() => undefined),
    approvals: {
      listRules: jest
        .fn<Promise<ApprovalRulesListResponse>, [ApprovalRulesListRequest]>()
        .mockResolvedValue({
          project: options?.projectRules ?? [],
          global: options?.globalRules ?? [],
        }),
      addRule: jest
        .fn<Promise<void>, [ApprovalRuleAddRequest]>()
        .mockResolvedValue(undefined),
      removeRule: jest
        .fn<Promise<void>, [ApprovalRuleRemoveRequest]>()
        .mockResolvedValue(undefined),
    },
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

function makeRule(overrides?: Partial<ApprovalRule>): ApprovalRule {
  return {
    id: 'rule-1',
    behavior: 'allow',
    target: { kind: 'command', pattern: 'npm test*' },
    createdAt: '2026-01-01T00:00:00.000Z',
    origin: 'settings',
    ...overrides,
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
    root.render(<ApprovalsTab />);
    await Promise.resolve();
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

/** The control a field label names, through its `for` attribute. */
function findLabelledElement(
  scope: HTMLElement,
  labelText: string,
): HTMLElement | null {
  const label = Array.from(scope.querySelectorAll('label')).find(
    (entry) => entry.textContent === labelText,
  );
  return label?.htmlFor
    ? scope.ownerDocument.getElementById(label.htmlFor)
    : null;
}

function findLabelledControl<T extends HTMLElement>(
  scope: HTMLElement,
  labelText: string,
): T | null {
  const element = findLabelledElement(scope, labelText);
  return element?.parentElement?.querySelector<T>('input') ?? null;
}

function findLabelledSelect(
  scope: HTMLElement,
  labelText: string,
): SettingsSelectProbe | null {
  const element = findLabelledElement(scope, labelText);
  return element?.parentElement
    ? querySettingsSelect(element.parentElement, 'button[role="combobox"]')
    : null;
}

function getAddRuleFormContainer(
  container: HTMLElement,
  scope: 'global' | 'project',
): HTMLElement {
  const addButton = container.querySelector<HTMLButtonElement>(
    `[data-testid="approval-add-rule-${scope}"]`,
  );
  const formContainer = addButton?.parentElement;
  if (!(formContainer instanceof HTMLElement)) {
    throw new Error(`Could not find add-rule form for scope "${scope}"`);
  }
  return formContainer;
}

describe('ApprovalsTab', () => {
  beforeEach(() => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    useProjectsStore.setState({ projects: [] });
    useChatStore.setState({ approvalDefaultsCache: {} });
  });

  afterEach(() => {
    useProjectsStore.setState({ projects: [] });
    useChatStore.setState({ approvalDefaultsCache: {} });
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('renders the surface defaults from loaded preferences', async () => {
    installApi({
      approvalDefaults: {
        worktree: 'auto',
        cowork: 'ask',
        appAdvisor: 'full-access',
      },
    });
    const { container, cleanup } = await renderTab();

    const worktreeSelect = querySettingsSelect(
      container,
      '[data-testid="approval-default-worktree"]',
    );
    const coworkSelect = querySettingsSelect(
      container,
      '[data-testid="approval-default-cowork"]',
    );
    const appAdvisorSelect = querySettingsSelect(
      container,
      '[data-testid="approval-default-app-advisor"]',
    );

    expect(worktreeSelect?.value).toBe('auto');
    expect(coworkSelect?.value).toBe('ask');
    expect(appAdvisorSelect?.value).toBe('full-access');
    cleanup();
  });

  it('updates mounted surface defaults from a cross-window preference sync', async () => {
    const api = installApi({
      approvalDefaults: {
        worktree: 'ask',
        cowork: 'ask',
        appAdvisor: 'ask',
      },
    });
    const { container, cleanup } = await renderTab();
    const appAdvisorSelect = querySettingsSelect(
      container,
      '[data-testid="approval-default-app-advisor"]',
    );

    expect(appAdvisorSelect?.value).toBe('ask');
    expect(api.onPreferencesSynced).toHaveBeenCalledTimes(1);
    const onPreferencesSynced = api.onPreferencesSynced.mock.calls[0]?.[0];
    expect(onPreferencesSynced).toBeDefined();
    act(() => {
      onPreferencesSynced?.(
        makeTestPreferences({
          approvalDefaults: {
            worktree: 'ask',
            cowork: 'ask',
            appAdvisor: 'full-access',
          },
        }),
      );
    });

    expect(appAdvisorSelect?.value).toBe('full-access');
    cleanup();
  });

  it('does not let a late initial load overwrite a newer preference sync', async () => {
    const api = installApi();
    let resolveLoad: (preferences: PreferencesData) => void = () => undefined;
    api.loadPreferences.mockReturnValue(
      new Promise<PreferencesData>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { container, cleanup } = await renderTab();
    const onPreferencesSynced = api.onPreferencesSynced.mock.calls[0]?.[0];

    act(() => {
      onPreferencesSynced?.(
        makeTestPreferences({
          approvalDefaults: {
            worktree: 'ask',
            cowork: 'ask',
            appAdvisor: 'full-access',
          },
        }),
      );
    });
    const appAdvisorSelect = querySettingsSelect(
      container,
      '[data-testid="approval-default-app-advisor"]',
    );
    expect(appAdvisorSelect?.value).toBe('full-access');

    resolveLoad(
      makeTestPreferences({
        approvalDefaults: {
          worktree: 'ask',
          cowork: 'ask',
          appAdvisor: 'ask',
        },
      }),
    );
    await flush();

    expect(appAdvisorSelect?.value).toBe('full-access');
    cleanup();
  });

  it('lists app-managed projects even when they are absent from the sidebar', async () => {
    const api = installApi();
    const { container, cleanup } = await renderTab();
    const workspaceSelect = querySettingsSelect(
      container,
      '[data-testid="approval-project-workspace"]',
    );
    const options = Array.from(workspaceSelect?.options ?? []).map(
      (option) => ({
        label: option.textContent,
        value: option.value,
      }),
    );

    expect(options).toEqual(
      expect.arrayContaining([
        { label: 'Orchestrator', value: APP_ADVISOR_PROJECT_ID },
        { label: 'Workflow editor', value: PIPELINE_EDITOR_PROJECT_ID },
      ]),
    );
    expect(api.approvals.listRules).toHaveBeenCalledWith({
      workspaceId: APP_ADVISOR_PROJECT_ID,
    });
    cleanup();
  });

  it('saves the updated approvalDefaults patch when a default changes', async () => {
    const api = installApi({
      approvalDefaults: { worktree: 'ask', cowork: 'ask', appAdvisor: 'ask' },
    });
    const { container, cleanup } = await renderTab();
    useChatStore.setState({
      approvalDefaultsCache: { project: 'full-access' },
    });
    const updates: PreferencesData['approvalDefaults'][] = [];
    const onUpdated = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        throw new Error('Expected a preferences CustomEvent');
      }
      const detail: unknown = event.detail;
      if (
        typeof detail !== 'object' ||
        detail === null ||
        !('approvalDefaults' in detail)
      ) {
        throw new Error('Expected preferences update detail');
      }
      const defaults: unknown = detail.approvalDefaults;
      if (
        typeof defaults !== 'object' ||
        defaults === null ||
        !('worktree' in defaults) ||
        !('cowork' in defaults) ||
        !('appAdvisor' in defaults) ||
        (defaults.worktree !== 'ask' &&
          defaults.worktree !== 'auto' &&
          defaults.worktree !== 'full-access') ||
        (defaults.cowork !== 'ask' &&
          defaults.cowork !== 'auto' &&
          defaults.cowork !== 'full-access') ||
        (defaults.appAdvisor !== 'ask' &&
          defaults.appAdvisor !== 'auto' &&
          defaults.appAdvisor !== 'full-access')
      ) {
        throw new Error('Expected normalized approval defaults');
      }
      updates.push({
        worktree: defaults.worktree,
        cowork: defaults.cowork,
        appAdvisor: defaults.appAdvisor,
      });
    };
    window.addEventListener(CANOPY_PREFERENCES_UPDATED_EVENT, onUpdated);

    const coworkSelect = querySettingsSelect(
      container,
      '[data-testid="approval-default-cowork"]',
    );
    expect(coworkSelect).not.toBeNull();
    if (coworkSelect) {
      coworkSelect.choose('auto');
    }
    await flush();

    // Only the changed key is sent. Persisting a whole `approvalDefaults`
    // object here would clobber a concurrent in-chat write-back (CAN-3055).
    expect(api.setApprovalDefaultPreference).toHaveBeenCalledWith({
      surface: 'cowork',
      mode: 'auto',
    });
    expect(api.savePreferences).not.toHaveBeenCalled();
    expect(useChatStore.getState().approvalDefaultsCache).toEqual({});
    expect(updates[updates.length - 1]).toEqual({
      worktree: 'ask',
      cowork: 'auto',
      appAdvisor: 'ask',
    });
    window.removeEventListener(CANOPY_PREFERENCES_UPDATED_EVENT, onUpdated);
    cleanup();
  });

  it('ignores a stale rollback load from an older failed default change', async () => {
    const api = installApi({
      approvalDefaults: { worktree: 'ask', cowork: 'ask', appAdvisor: 'ask' },
    });
    const { container, cleanup } = await renderTab();
    let resolveStaleRollback: (preferences: PreferencesData) => void = () =>
      undefined;
    api.loadPreferences.mockReturnValueOnce(
      new Promise<PreferencesData>((resolve) => {
        resolveStaleRollback = resolve;
      }),
    );
    api.setApprovalDefaultPreference
      .mockRejectedValueOnce(new Error('older save failed'))
      .mockResolvedValueOnce(
        makeTestPreferences({
          approvalDefaults: {
            worktree: 'ask',
            cowork: 'full-access',
            appAdvisor: 'ask',
          },
        }),
      );
    const coworkSelect = querySettingsSelect(
      container,
      '[data-testid="approval-default-cowork"]',
    );
    expect(coworkSelect).not.toBeNull();
    if (!coworkSelect) {
      throw new Error('Expected the Cowork approval-default select.');
    }

    coworkSelect.choose('auto');
    await flush();
    expect(api.loadPreferences).toHaveBeenCalledTimes(2);

    coworkSelect.choose('full-access');
    await flush();
    expect(coworkSelect?.value).toBe('full-access');

    resolveStaleRollback(
      makeTestPreferences({
        approvalDefaults: {
          worktree: 'ask',
          cowork: 'ask',
          appAdvisor: 'ask',
        },
      }),
    );
    await flush();

    expect(coworkSelect?.value).toBe('full-access');
    cleanup();
  });

  it('renders loaded global rules in the rules table', async () => {
    installApi({ globalRules: [makeRule({ id: 'rule-a' })] });
    const { container, cleanup } = await renderTab();

    const row = container.querySelector(
      '[data-testid="approval-rules-table"] [data-testid="approval-rule-row-rule-a"]',
    );
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('npm test*');
    expect(row?.textContent).toContain('Allow');
    cleanup();
  });

  it('calls removeRule with the global scope when the remove button is clicked', async () => {
    const api = installApi({ globalRules: [makeRule({ id: 'rule-a' })] });
    const { container, cleanup } = await renderTab();

    const removeButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="approval-rule-remove-rule-a"]',
    );
    expect(removeButton).not.toBeNull();
    act(() => removeButton?.click());
    await flush();

    expect(api.approvals.removeRule).toHaveBeenCalledWith({
      scope: 'global',
      ruleId: 'rule-a',
    });
    cleanup();
  });

  it('lists project rules for the selected project and can remove one', async () => {
    useProjectsStore.setState({
      projects: [singleRepo('ws-1', 'Alpha')],
    });
    const api = installApi({
      projectRules: [makeRule({ id: 'proj-rule-1' })],
    });
    const { container, cleanup } = await renderTab();
    await flush();

    expect(api.approvals.listRules).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
    });
    const projectTable = container.querySelector(
      '[data-testid="approval-project-rules-table"]',
    );
    expect(projectTable?.textContent).toContain('npm test*');

    const removeButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="approval-rule-remove-proj-rule-1"]',
    );
    act(() => removeButton?.click());
    await flush();

    expect(api.approvals.removeRule).toHaveBeenCalledWith({
      scope: 'project',
      workspaceId: 'ws-1',
      ruleId: 'proj-rule-1',
    });
    cleanup();
  });

  it('adds a command rule for the global scope via the add-rule form', async () => {
    const api = installApi();
    const { container, cleanup } = await renderTab();

    const form = getAddRuleFormContainer(container, 'global');
    const behaviorSelect = findLabelledSelect(form, 'Behavior');
    expect(behaviorSelect).not.toBeNull();
    if (behaviorSelect) behaviorSelect.choose('deny');

    const valueInput = form.querySelector<HTMLInputElement>(
      '[data-testid="approval-add-rule-global-value"]',
    );
    expect(valueInput).not.toBeNull();
    if (valueInput) act(() => setInputValue(valueInput, 'npm test*'));

    const addButton = form.querySelector<HTMLButtonElement>(
      '[data-testid="approval-add-rule-global"]',
    );
    act(() => addButton?.click());
    await flush();

    expect(api.approvals.addRule).toHaveBeenCalledTimes(1);
    const addCall = api.approvals.addRule.mock.calls[0]?.[0];
    expect(addCall?.scope).toBe('global');
    expect(addCall?.rule).toMatchObject({
      behavior: 'deny',
      target: { kind: 'command', pattern: 'npm test*' },
      origin: 'settings',
    });
    cleanup();
  });

  it('omits the tool field when adding an mcp rule with a blank tool name', async () => {
    const api = installApi();
    const { container, cleanup } = await renderTab();

    const form = getAddRuleFormContainer(container, 'global');
    const kindSelect = findLabelledSelect(form, 'Kind');
    expect(kindSelect).not.toBeNull();
    if (kindSelect) kindSelect.choose('mcp');
    await flush();

    const updatedForm = getAddRuleFormContainer(container, 'global');
    const serverInput = findLabelledControl<HTMLInputElement>(
      updatedForm,
      'Server',
    );
    expect(serverInput).not.toBeNull();
    if (serverInput) act(() => setInputValue(serverInput, 'my-server'));

    const toolInput = findLabelledControl<HTMLInputElement>(
      updatedForm,
      'Tool (optional)',
    );
    expect(toolInput).not.toBeNull();
    expect(toolInput?.value).toBe('');

    const addButton = updatedForm.querySelector<HTMLButtonElement>(
      '[data-testid="approval-add-rule-global"]',
    );
    act(() => addButton?.click());
    await flush();

    expect(api.approvals.addRule).toHaveBeenCalledTimes(1);
    const addCall = api.approvals.addRule.mock.calls[0]?.[0];
    expect(addCall?.scope).toBe('global');
    expect(addCall?.rule).toMatchObject({
      behavior: 'allow',
      target: { kind: 'mcp', server: 'my-server' },
      origin: 'settings',
    });
    expect(addCall?.rule.target).not.toHaveProperty('tool');
    cleanup();
  });

  it('adds a browser upload rule by the site origin, with an optional path, and refuses a site that is not a URL', async () => {
    const api = installApi();
    const { container, cleanup } = await renderTab();

    const form = getAddRuleFormContainer(container, 'global');
    const kindSelect = findLabelledSelect(form, 'Kind');
    if (kindSelect) kindSelect.choose('browser-upload');
    await flush();

    const updatedForm = getAddRuleFormContainer(container, 'global');
    const siteInput = findLabelledControl<HTMLInputElement>(
      updatedForm,
      'Site',
    );
    const pathInput = findLabelledControl<HTMLInputElement>(
      updatedForm,
      'Path (optional)',
    );
    expect(siteInput).not.toBeNull();
    expect(pathInput).not.toBeNull();
    const addButton = updatedForm.querySelector<HTMLButtonElement>(
      '[data-testid="approval-add-rule-global"]',
    );

    if (siteInput) act(() => setInputValue(siteInput, 'upload.example'));
    act(() => addButton?.click());
    await flush();
    expect(api.approvals.addRule).not.toHaveBeenCalled();

    if (siteInput)
      act(() => setInputValue(siteInput, 'HTTPS://Upload.example/form?x=1'));
    if (pathInput) act(() => setInputValue(pathInput, 'exports/**'));
    act(() => addButton?.click());
    await flush();

    expect(api.approvals.addRule).toHaveBeenCalledTimes(1);
    expect(api.approvals.addRule.mock.calls[0]?.[0]?.rule).toMatchObject({
      behavior: 'allow',
      target: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
        path: 'exports/**',
      },
      origin: 'settings',
    });
    cleanup();
  });

  it('renders a canopy-json-origin project rule without a remove button', async () => {
    useProjectsStore.setState({
      projects: [singleRepo('ws-1', 'Alpha')],
    });
    installApi({
      projectRules: [
        makeRule({
          id: 'canopy-json:0',
          origin: 'canopy-json',
          behavior: 'deny',
          target: { kind: 'command', pattern: 'rm -rf *' },
        }),
        makeRule({
          id: 'canopy-json:1',
          origin: 'canopy-json',
          behavior: 'deny',
          target: { kind: 'network', host: 'example.com' },
        }),
      ],
    });
    const { container, cleanup } = await renderTab();
    await flush();

    const projectTable = container.querySelector(
      '[data-testid="approval-project-rules-table"]',
    );
    expect(projectTable?.textContent).toContain('rm -rf *');
    expect(projectTable?.textContent).toContain('example.com');
    expect(projectTable?.textContent).toContain('canopy.json');
    expect(
      container.querySelector(
        '[data-testid="approval-rule-remove-canopy-json:0"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="approval-rule-remove-canopy-json:1"]',
      ),
    ).toBeNull();
    expect(projectTable?.textContent).toContain('Repo-managed');
    cleanup();
  });

  it('rolls back the optimistic rule and shows an error when addRule rejects', async () => {
    const api = installApi({ globalRules: [] });
    api.approvals.addRule.mockRejectedValueOnce(new Error('add failed'));
    const { container, cleanup } = await renderTab();

    const form = getAddRuleFormContainer(container, 'global');
    const valueInput = form.querySelector<HTMLInputElement>(
      '[data-testid="approval-add-rule-global-value"]',
    );
    if (valueInput) act(() => setInputValue(valueInput, 'npm test*'));

    const addButton = form.querySelector<HTMLButtonElement>(
      '[data-testid="approval-add-rule-global"]',
    );
    act(() => addButton?.click());
    await flush();
    await flush();

    expect(api.approvals.addRule).toHaveBeenCalled();
    expect(api.approvals.listRules).toHaveBeenCalledWith({});

    const table = container.querySelector(
      '[data-testid="approval-rules-table"]',
    );
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain('No global rules yet.');
    expect(container.textContent).toContain('Could not add global rule.');
    cleanup();
  });

  // CAN-3055 round 2 regression: `FALLBACK_APPROVAL_DEFAULTS` is now all Full
  // Access, and it seeds `defaults` when `loadPreferences()` rejects even
  // though the real preferences file on disk is intact. If the tab persisted a
  // whole `approvalDefaults` object built from that synthetic snapshot, the
  // user's first change would silently overwrite the other two surfaces'
  // genuinely persisted `ask`/`auto` with `full-access`. Writing only the
  // changed key is what makes the failed-load seed non-destructive.
  it('does not write the untouched surfaces when the preferences load failed', async () => {
    const api = installApi();
    api.loadPreferences.mockRejectedValue(new Error('ipc unavailable'));

    const { container, cleanup } = await renderTab();
    await flush();

    const worktreeSelect = querySettingsSelect(
      container,
      '[data-testid="approval-default-worktree"]',
    );
    expect(worktreeSelect).not.toBeNull();
    if (worktreeSelect) {
      worktreeSelect.choose('ask');
    }
    await flush();

    expect(api.setApprovalDefaultPreference).toHaveBeenCalledTimes(1);
    expect(api.setApprovalDefaultPreference).toHaveBeenCalledWith({
      surface: 'worktree',
      mode: 'ask',
    });
    // Nothing that could carry cowork/appAdvisor values was ever sent.
    expect(api.savePreferences).not.toHaveBeenCalled();
    cleanup();
  });

  it('lists global and project rule targets', async () => {
    useProjectsStore.setState({
      projects: [singleRepo('ws-1', 'Secret Project')],
    });
    installApi({
      globalRules: [
        makeRule({
          id: 'rule-a',
          target: { kind: 'file-write', path: '/Users/me/secrets/*.env' },
        }),
      ],
      projectRules: [
        makeRule({
          id: 'proj-rule-1',
          target: { kind: 'mcp', server: 'acme-crm', tool: 'export' },
        }),
      ],
    });
    const { container, cleanup } = await renderTab();
    await flush();

    const codes = Array.from(container.querySelectorAll('code'));
    expect(codes.map((code) => code.textContent)).toEqual([
      '/Users/me/secrets/*.env',
      'acme-crm → export',
    ]);
    cleanup();
  });
});

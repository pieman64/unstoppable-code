/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AppAdvisorProjectAgentAccess,
  PreferencesData,
  PreferencesProjectionOptions,
  WorkspaceContextOrganization,
} from '@canopy/desktop-shared/types';
import {
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
} from '@canopy/desktop-shared/types';
// Provide a minimal stand-in so the AppAdvisorTab tests can mount without the
// unrelated bundle picker.
jest.mock('../SettingsPluginPicker', () => ({
  SettingsPluginPicker: (): null => null,
}));
// The default-model row opts into Cursor; its runtime hooks subscribe to the
// preload bridge, which this suite's window.api stub does not provide.
jest.mock('@/hooks/useCursorChatAvailable', () => ({
  useCursorChatAvailable: (): boolean => false,
}));
jest.mock('@/hooks/useCursorModels', () => ({
  useCursorModels: (): { models: never[]; message: undefined } => ({
    models: [],
    message: undefined,
  }),
}));

import { AppAdvisorTab } from '../AppAdvisorTab';
import { makeTestPreferences } from '../../../test-utils/preferences';
import { useAppAdvisorStore } from '../../../stores/appAdvisorStore';
import { useCurrentUiStateStore } from '../../../stores/currentUiStateStore';
import { useWorkspaceContextStore } from '../../../stores/workspaceContextStore';

const TEST_ORGANIZATIONS: WorkspaceContextOrganization[] = [
  { id: 'org-zulu', name: 'Zulu', role: 'MEMBER' },
  { id: 'org-acme', name: 'Acme', role: 'OWNER' },
];

describe('AppAdvisorTab', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const loadPreferencesMock = jest.fn<Promise<PreferencesData>, []>();
  const savePreferencesMock = jest.fn<
    Promise<PreferencesData>,
    [Partial<PreferencesData>, PreferencesProjectionOptions?]
  >();

  beforeAll(() => {
    initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
    initCodexModels([{ id: 'gpt-6-luna', label: 'GPT 6 Luna' }]);
    initOllamaModels([{ id: 'ollama-llama3:8b', label: 'Llama 3 8B' }]);
  });

  beforeEach(() => {
    loadPreferencesMock.mockReset();
    savePreferencesMock.mockReset();
    useAppAdvisorStore.setState({
      appAdvisorModel: 'gpt-6-luna',
      appAdvisorThinkingLevel: 'high',
      appAdvisorPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    useWorkspaceContextStore.setState((state) => ({
      state: { ...state.state, organizations: TEST_ORGANIZATIONS },
    }));
    useCurrentUiStateStore.setState({ slices: {} });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: loadPreferencesMock,
        savePreferences: savePreferencesMock,
      },
    });
  });

  afterEach(() => {
    useWorkspaceContextStore.setState((state) => ({
      state: { ...state.state, organizations: [] },
    }));
    useCurrentUiStateStore.setState({ slices: {} });
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('renders a form skeleton while preferences are pending', async () => {
    loadPreferencesMock.mockImplementation(
      () => new Promise<PreferencesData>(() => undefined),
    );
    const rendered = await renderTab();

    try {
      expect(
        rendered.container.querySelector(
          '[role="status"][data-testid="settings-skeleton-form"]',
        ),
      ).not.toBeNull();
      expect(rendered.container.textContent).not.toContain(
        'Loading preferences…',
      );
      expect(
        useCurrentUiStateStore.getState().slices[
          'settings.appAdvisorProjectAgentAccess'
        ],
      ).toEqual({
        loaded: false,
        mode: 'enabled',
        selectedOwners: [],
        saving: false,
        saveErrorVisible: false,
      });
      expect(
        rendered.container.querySelector(
          '[data-testid="app-advisor-project-agent-access"]',
        ),
      ).toBeNull();
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-tab-app-advisor"]',
        ),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps the access control hidden after preferences fail to load', async () => {
    loadPreferencesMock.mockRejectedValue(new Error('load failed'));
    const rendered = await renderTab();

    try {
      await flush();
      expect(
        rendered.container.querySelector(
          '[role="status"][data-testid="settings-skeleton-form"]',
        ),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector(
          '[data-testid="app-advisor-project-agent-access"]',
        ),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('renders the App Advisor heading and all setting groups', async () => {
    const prefs = makeTestPreferences();
    loadPreferencesMock.mockResolvedValue(prefs);
    savePreferencesMock.mockResolvedValue(prefs);
    const rendered = await renderTab();

    try {
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-tab-app-advisor"]',
        ),
      ).not.toBeNull();
      expect(rendered.container.textContent).toContain('App Advisor');
      expect(rendered.container.textContent).toContain('Embedded assistant');
      expect(rendered.container.textContent).toContain('Project agents');
      expect(
        rendered.container.querySelector(
          '[data-testid="settings-app-advisor-project-agent-access"]',
        ),
      ).not.toBeNull();
      const enabled = rendered.container.querySelector(
        '[data-testid="app-advisor-project-agent-access-mode-enabled"]',
      );
      expect(enabled?.getAttribute('aria-pressed')).toBe('true');
      expect(rendered.container.textContent).toContain('Default model');
      expect(rendered.container.textContent).toContain(
        'Model and thinking level used for new App Advisor chats.',
      );
      // `Default plugins` and its description are rendered by the real
      // `SettingsPluginPicker`, which is mocked out in this test suite (its
      // production dependency chain is outside this suite's scope).
      expect(rendered.container.textContent).toContain('Pipeline monitoring');
      expect(rendered.container.textContent).toContain(
        'Automatically monitor pipeline runs',
      );
      expect(rendered.container.textContent).toContain(
        'Pipeline monitor model',
      );
    } finally {
      rendered.cleanup();
    }
  });

  it('saves Select owners with the complete access object', async () => {
    const prefs = makeTestPreferences();
    loadPreferencesMock.mockResolvedValue(prefs);
    savePreferencesMock.mockImplementation((patch) =>
      Promise.resolve({ ...prefs, ...patch }),
    );
    const rendered = await renderTab();

    try {
      const selectOwners = rendered.container.querySelector(
        '[data-testid="app-advisor-project-agent-access-mode-selected-owners"]',
      );
      if (!(selectOwners instanceof HTMLButtonElement)) {
        throw new Error('Select owners mode button not found');
      }
      await act(async () => {
        selectOwners.click();
        await Promise.resolve();
      });
      expect(savePreferencesMock).toHaveBeenLastCalledWith(
        {
          appAdvisorProjectAgentAccess: {
            mode: 'selected-owners',
            selectedOwners: [],
          },
        },
        { view: 'persisted' },
      );
    } finally {
      rendered.cleanup();
    }
  });

  it('lists Personal first and organizations by name, then saves Personal selection', async () => {
    const access: AppAdvisorProjectAgentAccess = {
      mode: 'selected-owners',
      selectedOwners: [],
    };
    const prefs = makeTestPreferences({ appAdvisorProjectAgentAccess: access });
    loadPreferencesMock.mockResolvedValue(prefs);
    savePreferencesMock.mockImplementation((patch) =>
      Promise.resolve({ ...prefs, ...patch }),
    );
    const rendered = await renderTab();

    try {
      const rows = Array.from(
        rendered.container.querySelectorAll(
          'button[data-testid^="app-advisor-project-agent-access-owner-"]',
        ),
      );
      expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
        'app-advisor-project-agent-access-owner-personal',
        'app-advisor-project-agent-access-owner-organization-org-acme',
        'app-advisor-project-agent-access-owner-organization-org-zulu',
      ]);
      const personal = rows[0];
      if (!(personal instanceof HTMLButtonElement)) {
        throw new Error('Personal owner button not found');
      }
      await act(async () => {
        personal.click();
        await Promise.resolve();
      });
      expect(savePreferencesMock).toHaveBeenLastCalledWith(
        {
          appAdvisorProjectAgentAccess: {
            mode: 'selected-owners',
            selectedOwners: [{ kind: 'personal' }],
          },
        },
        { view: 'persisted' },
      );
    } finally {
      rendered.cleanup();
    }
  });

  it('shows a stale saved organization as unavailable and removes it when deselected', async () => {
    const access: AppAdvisorProjectAgentAccess = {
      mode: 'selected-owners',
      selectedOwners: [{ kind: 'organization', organizationId: 'org-removed' }],
    };
    const prefs = makeTestPreferences({ appAdvisorProjectAgentAccess: access });
    loadPreferencesMock.mockResolvedValue(prefs);
    savePreferencesMock.mockImplementation((patch) =>
      Promise.resolve({ ...prefs, ...patch }),
    );
    const rendered = await renderTab();

    try {
      const staleOwner = rendered.container.querySelector(
        '[data-testid="app-advisor-project-agent-access-owner-organization-org-removed"]',
      );
      expect(staleOwner?.getAttribute('data-unavailable')).toBe('true');
      expect(staleOwner?.textContent).toContain('Unavailable organization');
      if (!(staleOwner instanceof HTMLButtonElement)) {
        throw new Error('Unavailable organization button not found');
      }
      await act(async () => {
        staleOwner.click();
        await Promise.resolve();
      });
      expect(savePreferencesMock).toHaveBeenLastCalledWith(
        {
          appAdvisorProjectAgentAccess: {
            mode: 'selected-owners',
            selectedOwners: [],
          },
        },
        { view: 'persisted' },
      );
    } finally {
      rendered.cleanup();
    }
  });

  it('reports its loaded access state while saving', async () => {
    const initialAccess: AppAdvisorProjectAgentAccess = {
      mode: 'selected-owners',
      selectedOwners: [{ kind: 'personal' }],
    };
    const prefs = makeTestPreferences({
      appAdvisorProjectAgentAccess: initialAccess,
    });
    loadPreferencesMock.mockResolvedValue(prefs);
    let completeSave: ((saved: PreferencesData) => void) | undefined;
    savePreferencesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeSave = resolve;
        }),
    );
    const rendered = await renderTab();

    try {
      expect(
        useCurrentUiStateStore.getState().slices[
          'settings.appAdvisorProjectAgentAccess'
        ],
      ).toEqual({
        loaded: true,
        mode: 'selected-owners',
        selectedOwners: [{ kind: 'personal' }],
        saving: false,
        saveErrorVisible: false,
      });
      const disabled = rendered.container.querySelector(
        '[data-testid="app-advisor-project-agent-access-mode-disabled"]',
      );
      if (!(disabled instanceof HTMLButtonElement)) {
        throw new Error('Disabled mode button not found');
      }
      await act(async () => {
        disabled.click();
        await Promise.resolve();
      });
      expect(
        useCurrentUiStateStore.getState().slices[
          'settings.appAdvisorProjectAgentAccess'
        ],
      ).toEqual({
        loaded: true,
        mode: 'disabled',
        selectedOwners: [{ kind: 'personal' }],
        saving: true,
        saveErrorVisible: false,
      });
      await act(async () => {
        completeSave?.({
          ...prefs,
          appAdvisorProjectAgentAccess: {
            mode: 'disabled',
            selectedOwners: [{ kind: 'personal' }],
          },
        });
        await Promise.resolve();
      });
      expect(
        useCurrentUiStateStore.getState().slices[
          'settings.appAdvisorProjectAgentAccess'
        ],
      ).toEqual({
        loaded: true,
        mode: 'disabled',
        selectedOwners: [{ kind: 'personal' }],
        saving: false,
        saveErrorVisible: false,
      });
    } finally {
      rendered.cleanup();
    }
  });

  it('rolls back a failed access save and shows an error banner', async () => {
    const prefs = makeTestPreferences();
    loadPreferencesMock.mockResolvedValue(prefs);
    savePreferencesMock.mockRejectedValue(new Error('save failed'));
    const rendered = await renderTab();

    try {
      const disabled = rendered.container.querySelector(
        '[data-testid="app-advisor-project-agent-access-mode-disabled"]',
      );
      if (!(disabled instanceof HTMLButtonElement)) {
        throw new Error('Disabled mode button not found');
      }
      await act(async () => {
        disabled.click();
        await Promise.resolve();
      });
      expect(
        rendered.container
          .querySelector(
            '[data-testid="app-advisor-project-agent-access-mode-enabled"]',
          )
          ?.getAttribute('aria-pressed'),
      ).toBe('true');
      expect(rendered.container.textContent).toContain(
        "Couldn't save project agent access. Try again.",
      );
      expect(
        useCurrentUiStateStore.getState().slices[
          'settings.appAdvisorProjectAgentAccess'
        ],
      ).toEqual({
        loaded: true,
        mode: 'enabled',
        selectedOwners: [],
        saving: false,
        saveErrorVisible: true,
      });
    } finally {
      rendered.cleanup();
    }
  });

  it('saves the App Advisor model row to the appAdvisor* preference keys', async () => {
    const prefs = makeTestPreferences();
    loadPreferencesMock.mockResolvedValue(prefs);
    savePreferencesMock.mockImplementation((patch) =>
      Promise.resolve({ ...prefs, ...patch }),
    );
    loadPreferencesMock
      .mockResolvedValueOnce(prefs)
      .mockResolvedValue({ ...prefs, appAdvisorModel: 'claude-sonnet-4-6' });
    const rendered = await renderTab();

    try {
      const selects = rendered.container.querySelectorAll('select');
      // Expect: App Advisor model + thinking level (2) + Pipeline monitor
      // model + thinking level (2) = 4 selects.
      expect(selects).toHaveLength(4);
      const [appAdvisorModelSelect] = Array.from(selects);

      await act(async () => {
        appAdvisorModelSelect.value = 'claude-sonnet-4-6';
        appAdvisorModelSelect.dispatchEvent(
          new Event('change', { bubbles: true }),
        );
        await Promise.resolve();
      });
      expect(savePreferencesMock).toHaveBeenLastCalledWith(
        {
          appAdvisorModel: 'claude-sonnet-4-6',
          appAdvisorThinkingLevel: 'high',
        },
        { view: 'persisted' },
      );
      expect(useAppAdvisorStore.getState().appAdvisorModel).toBe(
        'claude-sonnet-4-6',
      );
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps unavailable saved defaults out of the runtime store during unrelated saves', async () => {
    const runtime = makeTestPreferences({ appAdvisorModel: 'gpt-6-luna' });
    const saved = { ...runtime, appAdvisorModel: 'gpt-future-advisor' };
    loadPreferencesMock.mockResolvedValueOnce(saved).mockResolvedValue(runtime);
    let completeSave: ((prefs: PreferencesData) => void) | undefined;
    savePreferencesMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeSave = resolve;
        }),
    );
    const rendered = await renderTab();
    try {
      expect(rendered.container.textContent).toContain(
        'gpt-future-advisor (unavailable)',
      );
      const toggle = rendered.container.querySelector(
        '[data-testid="pipeline-advisor-enabled-toggle"]',
      );
      if (!(toggle instanceof HTMLButtonElement))
        throw new Error('Missing pipeline toggle');
      act(() => {
        toggle.click();
      });
      expect(useAppAdvisorStore.getState().appAdvisorModel).toBe('gpt-6-luna');
      await act(async () => {
        completeSave?.({ ...saved, pipelineAdvisorEnabled: false });
        await Promise.resolve();
      });
      expect(useAppAdvisorStore.getState().appAdvisorModel).toBe('gpt-6-luna');
      expect(rendered.container.textContent).toContain(
        'gpt-future-advisor (unavailable)',
      );
    } finally {
      rendered.cleanup();
    }
  });

  it('toggles the automatic pipeline monitoring switch through the pipelineAdvisorEnabled key', async () => {
    const prefs = makeTestPreferences();
    loadPreferencesMock.mockResolvedValue(prefs);
    savePreferencesMock.mockResolvedValue(prefs);
    const rendered = await renderTab();

    try {
      const toggle = rendered.container.querySelector(
        '[data-testid="pipeline-advisor-enabled-toggle"]',
      );
      if (!(toggle instanceof HTMLButtonElement)) {
        throw new Error('Pipeline monitoring toggle not found');
      }
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      act(() => {
        toggle.click();
      });
      expect(savePreferencesMock).toHaveBeenLastCalledWith(
        {
          pipelineAdvisorEnabled: false,
        },
        { view: 'persisted' },
      );
    } finally {
      rendered.cleanup();
    }
  });
});

async function renderTab(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(<AppAdvisorTab />);
    await Promise.resolve();
  });

  return {
    container,
    cleanup: (): void => {
      act(() => {
        root?.unmount();
      });
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

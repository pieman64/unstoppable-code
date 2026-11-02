/** @jest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

// Covered by its own suite; it reads the skill suggestion preload API.
jest.mock('../SkillSuggestionsSettingsSection', () => ({
  SkillSuggestionsSettingsSection: (): null => null,
}));
import type { InstalledItemSnapshot } from '@canopy/protocol/installed-items';
import { useNavigationStore } from '@/stores/navigationStore';
import { DeferredToolsSettings, PluginsTab } from '../PluginsTab';
import {
  DEFERRED_TOOLS_ROW_DESCRIPTORS,
  buildDeferredToolsPreferencePatch,
  type DeferredToolsPreferenceField,
} from '../pluginsTabHelpers';

function preferences(
  overrides: Partial<Record<DeferredToolsPreferenceField, boolean>> = {},
): Record<DeferredToolsPreferenceField, boolean | undefined> {
  return {
    deferredToolsWorktreeChatsEnabled: undefined,
    deferredToolsStandaloneChatsEnabled: undefined,
    deferredToolsAppAdvisorEnabled: undefined,
    deferredToolsPipelineAssistantEnabled: undefined,
    ...overrides,
  };
}

const ACTIVE_SNAPSHOT: InstalledItemSnapshot = {
  items: [
    {
      target: { kind: 'plugin', marketplaceId: 'market', pluginName: 'one' },
      status: 'active',
      removable: true,
      notices: [],
    },
    {
      target: { kind: 'plugin', marketplaceId: 'market', pluginName: 'two' },
      status: 'disabled',
      removable: true,
      notices: [],
    },
    {
      target: { kind: 'skill', sourceId: 'user', skillName: 'review' },
      status: 'active',
      removable: true,
      notices: [],
    },
    // Two configurations of one device server count as one MCP server.
    {
      target: { kind: 'mcp-config', serverId: 'linear', configId: 'work' },
      status: 'active',
      removable: false,
      notices: [],
    },
    {
      target: { kind: 'mcp-config', serverId: 'linear', configId: 'home' },
      status: 'active',
      removable: false,
      notices: [],
    },
    {
      target: { kind: 'mcp-server', serverId: 'linear' },
      status: 'active',
      removable: true,
      notices: [],
    },
  ],
};

function installPreloads(
  listStatus: () => Promise<InstalledItemSnapshot>,
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: jest.fn().mockResolvedValue({}),
      savePreferences: jest.fn(),
      onPreferencesSynced: jest.fn(() => jest.fn()),
    },
  });
  Object.defineProperty(window, 'installedItems', {
    configurable: true,
    value: {
      listStatus: jest.fn(listStatus),
      setStatus: jest.fn(),
      uninstall: jest.fn(),
      onChanged: jest.fn(() => jest.fn()),
    },
  });
}

async function renderPluginsTab(): Promise<{
  container: HTMLDivElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PluginsTab />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('PluginsTab Active items summary', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('counts unique active items and each MCP server once', async () => {
    installPreloads(() => Promise.resolve(ACTIVE_SNAPSHOT));
    const { container, cleanup } = await renderPluginsTab();
    expect(
      container.querySelector('[data-testid="active-items-summary-counts"]')
        ?.textContent,
    ).toBe('1 plugin, 1 skill and 1 MCP server are active.');
    expect(container.textContent).toContain(
      'Active items are added to every new chat. Any project or chat can turn one off from its plugin picker.',
    );
    expect(container.textContent).not.toContain('Default plugins');
    cleanup();
  });

  it('says nothing is active for an empty snapshot', async () => {
    installPreloads(() => Promise.resolve({ items: [] }));
    const { container, cleanup } = await renderPluginsTab();
    expect(container.textContent).toContain('Nothing is active yet.');
    cleanup();
  });

  it('shows a failed read instead of a zero count', async () => {
    installPreloads(() => Promise.reject(new Error('offline')));
    const { container, cleanup } = await renderPluginsTab();
    expect(container.textContent).not.toContain('Nothing is active yet.');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Status could not be loaded. Refresh to try again.',
    );
    cleanup();
  });

  it('closes Settings and opens Installed filtered to Active items', async () => {
    installPreloads(() => Promise.resolve(ACTIVE_SNAPSHOT));
    const closeSettings = jest.fn();
    const openPluginsNavigation = jest.fn();
    useNavigationStore.setState({ closeSettings, openPluginsNavigation });
    const { container, cleanup } = await renderPluginsTab();
    const manage = container.querySelector(
      '[data-testid="active-items-summary-manage"]',
    );
    if (!(manage instanceof HTMLButtonElement))
      throw new Error('Manage button not rendered');
    expect(manage.textContent).toBe('Open Customize');
    act(() => manage.click());
    expect(closeSettings).toHaveBeenCalledTimes(1);
    expect(openPluginsNavigation).toHaveBeenCalledWith({
      kind: 'marketplace-browse',
      query: '',
      tab: 'all',
      focusSection: 'installed',
      installedExpanded: true,
      installedStatusFilter: 'active',
    });
    cleanup();
  });
});

describe('PluginsTab deferred-tools settings', () => {
  it('exposes one setting for every supported chat surface', () => {
    expect(DEFERRED_TOOLS_ROW_DESCRIPTORS.map((row) => row.field)).toEqual([
      'deferredToolsWorktreeChatsEnabled',
      'deferredToolsStandaloneChatsEnabled',
      'deferredToolsAppAdvisorEnabled',
      'deferredToolsPipelineAssistantEnabled',
    ]);
  });

  it('builds a patch containing only the changed setting', () => {
    for (const row of DEFERRED_TOOLS_ROW_DESCRIPTORS) {
      expect(buildDeferredToolsPreferencePatch(row.field, false)).toEqual({
        [row.field]: false,
      });
    }
  });

  it('renders missing settings as enabled for backward compatibility', () => {
    const html = renderToStaticMarkup(
      <DeferredToolsSettings
        preferences={preferences()}
        onToggle={jest.fn()}
      />,
    );

    expect(html).toContain('Deferred plugin loading');
    expect(html.match(/role="switch"/g)).toHaveLength(
      DEFERRED_TOOLS_ROW_DESCRIPTORS.length,
    );
    expect(html.match(/aria-checked="true"/g)).toHaveLength(
      DEFERRED_TOOLS_ROW_DESCRIPTORS.length,
    );
    for (const row of DEFERRED_TOOLS_ROW_DESCRIPTORS) {
      expect(html).toContain(`data-testid="${row.testId}"`);
    }
  });

  it('routes each switch change to its matching preference', () => {
    const onToggle = jest.fn<void, [DeferredToolsPreferenceField, boolean]>();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <DeferredToolsSettings
          preferences={preferences()}
          onToggle={onToggle}
        />,
      );
    });

    try {
      const switches = container.querySelectorAll('[role="switch"]');
      expect(switches).toHaveLength(DEFERRED_TOOLS_ROW_DESCRIPTORS.length);
      DEFERRED_TOOLS_ROW_DESCRIPTORS.forEach((row) => {
        const toggle = container.querySelector(`[data-testid="${row.testId}"]`);
        if (!(toggle instanceof HTMLButtonElement)) {
          throw new Error(`Missing switch for ${row.field}`);
        }
        expect(toggle.getAttribute('role')).toBe('switch');
        expect(toggle.getAttribute('aria-checked')).toBe('true');
        act(() => {
          toggle.click();
        });
        expect(onToggle).toHaveBeenLastCalledWith(row.field, false);
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

/**
 * @jest-environment jsdom
 */
/**
 * Unit coverage for the shared {@link PortalPluginsPicker} (CAN-1219). The
 * trigger chip shows a selection-count badge, opens a browser-safe selector
 * listing the host-projected catalog (collections / skills / plugins / MCP
 * servers), toggles selections locally, and fires
 * `portal.chat.set_plugin_selections` (via `onChange`) with the rebuilt refs on
 * Save. Plugins unsupported by the active provider render disabled.
 *
 * The picker moved here with the composer's other child components. One case
 * stayed behind in `apps/web` because it builds its catalog through the web
 * app's real server-side projection, which this package cannot import.
 */
import { StrictMode, act, useEffect, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PortalChatTabPluginSelections,
  PortalPluginCatalog,
} from '@canopy/protocol/portal';
import type { InstalledItemSnapshot } from '@canopy/protocol/installed-items';
import type { CapabilityUnavailable } from '@canopy/protocol/capability-bundle';
import type { SkillRiskInfo } from '@canopy/protocol/skills';
import {
  PORTAL_PLUGINS_DESKTOP_ONLY_LABEL,
  PORTAL_PLUGINS_NO_LONGER_AVAILABLE_LABEL,
  PORTAL_PLUGINS_TURNED_OFF_LABEL,
  PORTAL_PLUGINS_MCP_NEEDS_RECONNECTING_LABEL,
  PORTAL_PLUGINS_MCP_NOT_SIGNED_IN_LABEL,
  PORTAL_PLUGINS_PROJECT_DEFAULT_LABEL,
  PortalPluginsPicker,
  type AccountMcpEntryComponentProps,
  type AccountMcpSeam,
  type AddMarketplaceSeam,
} from '../PortalPluginsPicker';

/** Opens the unified table's Kind filter and chooses an option by value. */
function chooseKindFilter(value: string): void {
  const trigger = document.querySelector(
    '[role="combobox"][aria-label="Kind filter"]',
  );
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error('Kind filter missing');
  }
  act(() => trigger.click());
  const option = document.querySelector(
    `[role="listbox"] [role="option"][data-value="${value}"]`,
  );
  if (!(option instanceof HTMLElement)) {
    throw new Error(`Kind option ${value} missing`);
  }
  act(() => option.click());
}

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const catalog: PortalPluginCatalog = {
  collections: [
    {
      id: 'col-1',
      name: 'Research',
      description: 'Research collection',
      skillCount: 2,
      pluginCount: 1,
      mcpServerCount: 0,
    },
  ],
  skills: [
    {
      sourceId: 'built-in',
      skillName: 'summarize',
      name: 'Summarize',
      description: 'Summarize text',
      source: 'Built-in',
      builtIn: true,
    },
  ],
  plugins: [
    {
      marketplaceId: 'mkt',
      pluginName: 'linter',
      name: 'Linter',
      description: 'Lints code',
      marketplaceName: 'Official',
      claudeSupported: true,
      codexSupported: false,
    },
  ],
  mcpServers: [
    {
      serverId: 'srv',
      configId: 'cfg',
      serverName: 'Files',
      configName: 'default',
      description: 'File server',
      transport: 'http',
    },
  ],
};

const emptySelections: PortalChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
};

function curatedWritingCatalog(memberCount: number): PortalPluginCatalog {
  const memberKeys = Array.from(
    { length: memberCount },
    (_, index) => `writing-${String(index)}`,
  );
  const summary = {
    skills: 1,
    commands: 0,
    agents: 0,
    hooks: 0,
    mcpServers: 0,
    lspServers: 0,
  };
  const entryBase = {
    state: 'available',
    name: 'Writing',
    description: 'Writing help',
    providerSupport: { claude: true, codex: true },
    cloudCapabilities: {
      hasSkills: true,
      hasCommands: false,
      hasAgents: false,
      mcpOnly: false,
      hooksStripped: false,
    },
    lastUpdated: '',
    memberSummary: summary,
  } as const;
  return {
    collections: [],
    skills: memberKeys.map((key) => ({
      sourceId: 'cloud-curated',
      skillName: key,
      name: 'Writing',
      description: 'Writing help',
      source: 'Curated',
      builtIn: false,
    })),
    plugins: [],
    mcpServers: [],
    entries: [
      {
        ...entryBase,
        id: 'plugin:cloud-curated/writing',
        kind: 'plugin',
        origin: 'curated',
        source: { id: 'cloud-curated', label: 'Curated' },
        memberSummary: { ...summary, skills: memberCount },
        memberInventory: {
          skills: memberKeys.map((key) => ({
            name: key,
            description: 'Writing help',
            path: `skills/${key}`,
          })),
          commands: [],
          agents: [],
          hooks: [],
          mcpServers: [],
          lspServers: [],
        },
        selectionRef: {
          type: 'marketplace-plugin',
          marketplaceId: 'cloud-curated',
          pluginName: 'writing',
        },
      },
      {
        ...entryBase,
        id: 'skill:cloud-custom/writing-0',
        kind: 'skill',
        origin: 'custom',
        source: { id: 'cloud-custom', label: 'My skills' },
        selectionRef: {
          type: 'skill',
          sourceId: 'cloud-custom',
          skillName: 'writing-0',
        },
      },
    ],
  };
}

/**
 * Stands in for the host's add-marketplace dialog. The real one lives in
 * `apps/web` and talks to that app's marketplace endpoints; all this package
 * owns is the contract — it renders while open, and it can close itself and ask
 * the host to refresh the catalog.
 */
function StubMarketplaceDialog({
  onClose,
  onCatalogRefresh,
  onAdded,
}: {
  onClose: () => void;
  onCatalogRefresh: () => void | Promise<void>;
  onAdded?: (confirmation: {
    message: string;
    intent: 'positive' | 'attention';
  }) => void;
}): JSX.Element {
  return (
    <div data-testid="stub-marketplace-dialog">
      <button
        type="button"
        data-testid="stub-marketplace-added"
        onClick={() => {
          onAdded?.({ message: 'Marketplace added.', intent: 'positive' });
          onClose();
        }}
      >
        Add
      </button>
      <button
        type="button"
        data-testid="stub-marketplace-refresh"
        onClick={() => void onCatalogRefresh()}
      >
        Refresh
      </button>
      <button
        type="button"
        data-testid="stub-marketplace-close"
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );
}

/** The seam the host would hand in, with a stub dialog. */
function stubSeam(onCatalogRefresh: () => void = () => undefined): {
  dialog: typeof StubMarketplaceDialog;
  onCatalogRefresh: () => void;
} {
  return { dialog: StubMarketplaceDialog, onCatalogRefresh };
}

function StubToolsEditor({
  entry,
}: AccountMcpEntryComponentProps): JSX.Element {
  return <span data-testid="stub-tools-editor">{entry.name}</span>;
}

function StubCatalogRefresh({
  enabled,
  onRefresh,
}: {
  enabled: boolean;
  onRefresh?: () => void | Promise<void>;
}): null {
  useEffect(() => {
    if (!enabled || !onRefresh) return;
    const onFocus = (): void => {
      void onRefresh();
    };
    window.addEventListener('focus', onFocus);
    return (): void => {
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, onRefresh]);
  return null;
}

function stubAccountMcpSeam(
  onCatalogRefresh: () => void = (): void => undefined,
): AccountMcpSeam {
  return {
    toolsEditor: StubToolsEditor,
    catalogRefresh: StubCatalogRefresh,
    onCatalogRefresh,
  };
}

describe('PortalPluginsPicker', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('opens once under Strict Mode from the plus menu and keeps edits on prop updates', () => {
    const opened = jest.fn();
    const changed = jest.fn<void, [PortalChatTabPluginSelections]>();
    const setOpen = jest.fn();
    const render = (selected: PortalChatTabPluginSelections): void => {
      act(() =>
        root.render(
          <StrictMode>
            <PortalPluginsPicker
              catalog={catalog}
              selections={selected}
              brandDisplayName="desktop"
              onChange={changed}
              onOpen={opened}
              open
              onOpenChange={setOpen}
              hideTrigger
            />
          </StrictMode>,
        ),
      );
    };
    render(emptySelections);
    expect(
      container.querySelector('[data-testid="portal-chat-plugins-button"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="portal-plugins-modal"]'),
    ).not.toBeNull();
    expect(opened).toHaveBeenCalledTimes(1);
    const collection = document.querySelector<HTMLInputElement>(
      '[data-testid="portal-plugins-row-checkbox"][data-row-key="collection:col-1"]',
    );
    // Select through the real row checkbox rather than inspecting private draft state.
    const checkbox = collection;
    expect(checkbox).not.toBeNull();
    act(() => checkbox?.click());
    render({ ...emptySelections });
    expect(opened).toHaveBeenCalledTimes(1);
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="portal-plugins-save"]')
        ?.click(),
    );
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][0].collectionIds).toEqual(['col-1']);
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it('does not restore focus into another scope when a controlled picker unmounts', () => {
    const origin = document.createElement('button');
    document.body.append(origin);
    origin.focus();
    let currentScope = true;
    act(() =>
      root.render(
        <PortalPluginsPicker
          catalog={catalog}
          selections={emptySelections}
          brandDisplayName="desktop"
          onChange={jest.fn()}
          open
          onOpenChange={jest.fn()}
          hideTrigger
          canRestoreFocus={(): boolean => currentScope}
        />,
      ),
    );
    expect(document.activeElement).not.toBe(origin);
    currentScope = false;
    act(() => root.render(<div />));
    expect(document.activeElement).not.toBe(origin);
    origin.remove();
  });

  function mount(props: {
    installedItems?: InstalledItemSnapshot;
    scopeKey?: string;
    deferredTools?: {
      key: string;
      allowed: boolean;
      save: (
        selections: PortalChatTabPluginSelections,
        allowed: boolean,
      ) => Promise<void>;
    };
    catalogValue?: PortalPluginCatalog;
    selections?: PortalChatTabPluginSelections;
    providerType?: string;
    notice?: string;
    cloudScope?: boolean;
    marketplacesEnabled?: boolean;
    addMarketplace?: AddMarketplaceSeam;
    accountMcp?: AccountMcpSeam;
    inheritedSelections?: PortalChatTabPluginSelections;
    onChange: (selections: PortalChatTabPluginSelections) => void;
    onApplied?: (
      next: PortalChatTabPluginSelections,
      previous: PortalChatTabPluginSelections,
    ) => void;
  }): void {
    act(() => {
      root.render(
        <PortalPluginsPicker
          installedItems={props.installedItems}
          {...(props.scopeKey === undefined
            ? {}
            : { scopeKey: props.scopeKey })}
          deferredTools={props.deferredTools}
          catalog={props.catalogValue ?? catalog}
          selections={props.selections ?? emptySelections}
          providerType={props.providerType}
          brandDisplayName="the desktop app"
          onChange={props.onChange}
          notice={props.notice}
          cloudScope={props.cloudScope}
          marketplacesEnabled={props.marketplacesEnabled}
          addMarketplace={props.addMarketplace}
          accountMcp={props.accountMcp}
          inheritedSelections={props.inheritedSelections}
          {...(props.onApplied === undefined
            ? {}
            : { onApplied: props.onApplied })}
        />,
      );
    });
  }

  function control(id: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      `[data-testid="${id}"]`,
    );
    if (!element) throw new Error(`Missing ${id}`);
    return element;
  }
  it.each(['linter', 'LiNtEr'])(
    'hides Disabled %s and keeps its selected row badged',
    (pluginName) => {
      const catalogValue = {
        ...catalog,
        plugins: catalog.plugins.map((plugin) => ({ ...plugin, pluginName })),
      };
      const installedItems: InstalledItemSnapshot = {
        items: [
          {
            target: {
              kind: 'plugin',
              marketplaceId: 'mkt',
              pluginName: 'linter',
            },
            status: 'disabled',
            removable: true,
            notices: [],
          },
        ],
      };
      mount({ catalogValue, installedItems, onChange: jest.fn() });
      click(trigger());
      expect(document.body.textContent).not.toContain('Lints code');
      const close = document.querySelector<HTMLElement>(
        'button[aria-label="Close"]',
      );
      if (!close) throw new Error('Missing close');
      click(close);
      mount({
        catalogValue,
        installedItems,
        selections: {
          ...emptySelections,
          pluginRefs: [{ marketplaceId: 'mkt', pluginName }],
        },
        onChange: jest.fn(),
      });
      click(trigger());
      expect(document.body.textContent).toContain('Disabled');
      expect(document.body.textContent).toContain('Lints code');
    },
  );

  it('keeps the policy draft open until its atomic save is confirmed and prevents duplicate saves', async () => {
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const save = jest.fn(() => pending),
      onChange = jest.fn();
    mount({
      onChange,
      deferredTools: { key: 'account/chat', allowed: true, save },
    });
    click(trigger());
    click(control('chat-plugins-deferred-tools-toggle'));
    click(control('portal-plugins-save'));
    click(control('portal-plugins-save'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining(emptySelections),
      false,
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      finish();
      await pending;
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('reopens the confirmed selections while the host projection is catching up', async () => {
    const save = jest
      .fn<Promise<void>, [PortalChatTabPluginSelections, boolean]>()
      .mockResolvedValue(undefined);
    const onApplied = jest.fn();
    const props = {
      onChange: jest.fn(),
      onApplied,
      deferredTools: { key: 'account/chat', allowed: true, save },
    };
    mount(props);
    click(trigger());
    const selected = document.querySelector(
      '[data-testid="portal-plugins-row-checkbox"][data-row-key="collection:col-1"]',
    );
    if (!(selected instanceof HTMLInputElement))
      throw new Error('Missing collection');
    click(selected);
    click(control('chat-plugins-deferred-tools-toggle'));
    await act(async () => {
      click(control('portal-plugins-save'));
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ collectionIds: ['col-1'] }),
      false,
    );
    click(trigger());
    const reopened = document.querySelector(
      '[data-testid="portal-plugins-row-checkbox"][data-row-key="collection:col-1"]',
    );
    if (!(reopened instanceof HTMLInputElement))
      throw new Error('Missing reopened collection');
    expect(reopened.checked).toBe(true);
    expect(
      control('chat-plugins-deferred-tools-toggle').getAttribute(
        'aria-checked',
      ),
    ).toBe('false');
    expect(onApplied).toHaveBeenCalledWith(
      expect.objectContaining({ collectionIds: ['col-1'] }),
      emptySelections,
    );
  });

  it('retains the staged policy on failure and saves it on retry', async () => {
    const save = jest
      .fn<Promise<void>, [PortalChatTabPluginSelections, boolean]>()
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockResolvedValue(undefined);
    mount({
      onChange: jest.fn(),
      deferredTools: { key: 'account/chat', allowed: true, save },
    });
    click(trigger());
    click(control('chat-plugins-deferred-tools-toggle'));
    await act(async () => {
      click(control('portal-plugins-save'));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't save",
    );
    expect(
      control('chat-plugins-deferred-tools-toggle').getAttribute(
        'aria-checked',
      ),
    ).toBe('false');
    await act(async () => {
      click(control('portal-plugins-save'));
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('discards an unsaved policy when cancelled', () => {
    const save = jest.fn<
      Promise<void>,
      [PortalChatTabPluginSelections, boolean]
    >();
    mount({
      onChange: jest.fn(),
      deferredTools: { key: 'account/chat', allowed: true, save },
    });
    click(trigger());
    click(control('chat-plugins-deferred-tools-toggle'));
    const close = document.querySelector<HTMLElement>(
      'button[aria-label="Close"]',
    );
    if (!close) throw new Error('Missing close');
    click(close);
    click(trigger());
    expect(
      control('chat-plugins-deferred-tools-toggle').getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    expect(save).not.toHaveBeenCalled();
  });
  it('ignores a prior target save finishing after the account or chat changes', async () => {
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    mount({
      onChange: jest.fn(),
      deferredTools: { key: 'old/chat', allowed: true, save: () => pending },
    });
    click(trigger());
    click(control('portal-plugins-save'));
    await act(async () => {
      await Promise.resolve();
    });
    mount({
      onChange: jest.fn(),
      deferredTools: { key: 'new/chat', allowed: false, save: async () => {} },
    });
    click(trigger());
    await act(async () => {
      finish();
      await pending;
    });
    expect(
      control('chat-plugins-deferred-tools-toggle').getAttribute(
        'aria-checked',
      ),
    ).toBe('false');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
  it.each([false, true])(
    'keeps an open picker when policy allowed=%s arrives for the same target',
    (allowed) => {
      mount({ scopeKey: 'session/chat', onChange: jest.fn() });
      click(trigger());
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      mount({
        scopeKey: 'session/chat',
        onChange: jest.fn(),
        deferredTools: {
          key: 'session/chat',
          allowed,
          save: async () => {},
        },
      });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(
        control('chat-plugins-deferred-tools-toggle').getAttribute(
          'aria-checked',
        ),
      ).toBe(String(allowed));
      mount({ scopeKey: 'other-session/chat', onChange: jest.fn() });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it('hides deferred policy for a host without the commit capability', () => {
    mount({ onChange: jest.fn() });
    click(trigger());
    expect(
      document.querySelector(
        '[data-testid="chat-plugins-deferred-tools-toggle"]',
      ),
    ).toBeNull();
  });

  function accountCatalog(): PortalPluginCatalog {
    const base = curatedWritingCatalog(1).entries?.[0];
    if (!base) throw new Error('Missing curated catalog entry');
    return {
      collections: [],
      skills: [],
      plugins: [],
      mcpServers: [],
      entries: (
        [
          'not_connected',
          'reauth_required',
          'desktop_only',
          'connected',
        ] as const
      ).map((connectionState, index) => ({
        ...base,
        id: `mcp-${String(index)}`,
        kind: 'app',
        name: `Server ${String(index)}`,
        connectionState,
        selectionRef: {
          type: 'mcp-server',
          serverId: `server-${String(index)}`,
          configId: 'default',
        },
      })),
    };
  }

  function rowText(index: number): string {
    return (
      document
        .querySelector(
          `input[data-row-key="mcp:server-${String(index)}/default"]`,
        )
        ?.closest('tr')?.textContent ?? ''
    );
  }

  it('lists every account server in cloud scope as selectable, keeps desktop-only rows unselectable, and never offers sign-in', () => {
    const onChange = jest.fn<void, [PortalChatTabPluginSelections]>();
    const onCatalogRefresh = jest.fn();
    mount({
      catalogValue: accountCatalog(),
      onChange,
      cloudScope: true,
      accountMcp: stubAccountMcpSeam(onCatalogRefresh),
    });
    click(trigger());
    const table = document.querySelector('[data-testid="unified-table"]');
    expect(table?.getAttribute('data-row-count')).toBe('4');
    expect(
      Array.from(document.querySelectorAll('button')).filter((button) =>
        ['Connect', 'Reconnect', 'Enable'].includes(button.textContent ?? ''),
      ),
    ).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Manage MCP servers');
    expect(rowText(0)).toContain(PORTAL_PLUGINS_MCP_NOT_SIGNED_IN_LABEL);
    expect(rowText(1)).toContain(PORTAL_PLUGINS_MCP_NEEDS_RECONNECTING_LABEL);
    expect(rowText(3)).not.toContain(PORTAL_PLUGINS_MCP_NOT_SIGNED_IN_LABEL);
    expect(rowText(3)).not.toContain(
      PORTAL_PLUGINS_MCP_NEEDS_RECONNECTING_LABEL,
    );
    const desktopOnly = document.querySelector(
      'input[aria-label="Select Server 2 (Available on desktop only)"]',
    );
    if (!(desktopOnly instanceof HTMLInputElement))
      throw new Error('Missing desktop-only checkbox');
    expect(desktopOnly.disabled).toBe(true);
    expect(desktopOnly.getAttribute('data-toggle-mode')).toBe('unsupported');
    for (const index of [0, 1, 3]) {
      const checkbox = document.querySelector(
        `input[aria-label="Select Server ${String(index)}"]`,
      );
      if (!(checkbox instanceof HTMLInputElement))
        throw new Error(`Missing checkbox for server ${String(index)}`);
      expect(checkbox.disabled).toBe(false);
      click(checkbox);
    }
    const save = document.querySelector('[data-testid="portal-plugins-save"]');
    if (!(save instanceof HTMLButtonElement))
      throw new Error('Missing picker save button');
    click(save);
    expect(onChange.mock.calls[0][0].mcpServerRefs).toEqual([
      { serverId: 'server-0', configId: 'default' },
      { serverId: 'server-1', configId: 'default' },
      { serverId: 'server-3', configId: 'default' },
    ]);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(onCatalogRefresh).toHaveBeenCalled();
  });

  it('reports the saved and the previous selection within the Save click (REG-3030)', () => {
    const order: string[] = [];
    const onChange = jest.fn<void, [PortalChatTabPluginSelections]>(() => {
      order.push('change');
    });
    let sawEvent = false;
    const onApplied = jest.fn(
      (
        next: PortalChatTabPluginSelections,
        previous: PortalChatTabPluginSelections,
      ) => {
        // Inside the click handler: a sign-in popup opened here keeps the
        // user's gesture.
        sawEvent = window.event?.type === 'click';
        order.push('applied');
        expect(previous).toBe(emptySelections);
        expect(next.mcpServerRefs).toEqual([
          { serverId: 'server-0', configId: 'default' },
        ]);
      },
    );
    mount({
      catalogValue: accountCatalog(),
      onChange,
      onApplied,
      cloudScope: true,
    });
    click(trigger());
    const checkbox = document.querySelector(
      'input[aria-label="Select Server 0"]',
    );
    if (!(checkbox instanceof HTMLInputElement))
      throw new Error('Missing checkbox for server 0');
    click(checkbox);
    const save = document.querySelector('[data-testid="portal-plugins-save"]');
    if (!(save instanceof HTMLButtonElement))
      throw new Error('Missing picker save button');
    click(save);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(sawEvent).toBe(true);
    expect(order).toEqual(['change', 'applied']);
  });

  it('keeps a selected server checked after it needs reconnecting', () => {
    const onChange = jest.fn<void, [PortalChatTabPluginSelections]>();
    const selectedRef = { serverId: 'server-1', configId: 'default' };
    mount({
      catalogValue: accountCatalog(),
      onChange,
      cloudScope: true,
      selections: { ...emptySelections, mcpServerRefs: [selectedRef] },
      accountMcp: stubAccountMcpSeam(),
    });
    click(trigger());
    const table = document.querySelector('[data-testid="unified-table"]');
    expect(table?.getAttribute('data-row-count')).toBe('4');
    expect(rowText(1)).toContain(PORTAL_PLUGINS_MCP_NEEDS_RECONNECTING_LABEL);
    const retained = document.querySelector(
      'input[aria-label="Select Server 1"]',
    );
    if (!(retained instanceof HTMLInputElement))
      throw new Error('Missing retained checkbox');
    expect(retained.checked).toBe(true);
    expect(retained.disabled).toBe(false);
    click(retained);
    const save = document.querySelector('[data-testid="portal-plugins-save"]');
    if (!(save instanceof HTMLButtonElement))
      throw new Error('Missing picker save button');
    click(save);
    expect(onChange).toHaveBeenLastCalledWith(emptySelections);
  });

  it('lists connected account servers without a sign-in status', () => {
    const catalogValue = accountCatalog();
    catalogValue.entries = catalogValue.entries?.filter(
      (entry) => entry.connectionState === 'connected',
    );
    mount({ catalogValue, onChange: jest.fn(), cloudScope: true });
    click(trigger());
    expect(
      document
        .querySelector('[data-testid="unified-table"]')
        ?.getAttribute('data-row-count'),
    ).toBe('1');
    expect(rowText(3)).not.toContain(PORTAL_PLUGINS_MCP_NOT_SIGNED_IN_LABEL);
  });

  it('badges project default rows and still saves the full effective selection', () => {
    const onChange = jest.fn<void, [PortalChatTabPluginSelections]>();
    const inheritedRefs = [
      { serverId: 'server-0', configId: 'default' },
      { serverId: 'server-3', configId: 'default' },
    ];
    const selections: PortalChatTabPluginSelections = {
      ...emptySelections,
      mcpServerRefs: [
        ...inheritedRefs,
        { serverId: 'server-1', configId: 'default' },
      ],
    };
    mount({
      catalogValue: accountCatalog(),
      onChange,
      cloudScope: true,
      selections,
      inheritedSelections: { ...emptySelections, mcpServerRefs: inheritedRefs },
    });
    click(trigger());
    expect(rowText(0)).toContain(PORTAL_PLUGINS_MCP_NOT_SIGNED_IN_LABEL);
    expect(rowText(0)).toContain(PORTAL_PLUGINS_PROJECT_DEFAULT_LABEL);
    expect(rowText(3)).toContain(PORTAL_PLUGINS_PROJECT_DEFAULT_LABEL);
    expect(rowText(1)).not.toContain(PORTAL_PLUGINS_PROJECT_DEFAULT_LABEL);
    expect(rowText(2)).not.toContain(PORTAL_PLUGINS_PROJECT_DEFAULT_LABEL);
    const inherited = document.querySelector(
      'input[aria-label="Select Server 3"]',
    );
    if (!(inherited instanceof HTMLInputElement))
      throw new Error('Missing inherited checkbox');
    expect(inherited.checked).toBe(true);
    expect(inherited.disabled).toBe(false);
    const save = document.querySelector('[data-testid="portal-plugins-save"]');
    if (!(save instanceof HTMLButtonElement))
      throw new Error('Missing picker save button');
    click(save);
    expect(onChange).toHaveBeenLastCalledWith(selections);
  });

  it('shows no project default badge without inherited selections', () => {
    mount({
      catalogValue: accountCatalog(),
      onChange: jest.fn(),
      cloudScope: true,
      selections: {
        ...emptySelections,
        mcpServerRefs: [{ serverId: 'server-3', configId: 'default' }],
      },
    });
    click(trigger());
    expect(document.body.textContent).not.toContain(
      PORTAL_PLUGINS_PROJECT_DEFAULT_LABEL,
    );
  });

  it('keeps a desktop-only server unselectable in a catalog without account state (REG-3035)', () => {
    // Guests and the account-connections flag off: only the brand-wide
    // desktop-only state is set, so that row is listed but cannot be picked,
    // and nothing turns on the account catalog refresh.
    const catalog = accountCatalog();
    const entries = (catalog.entries ?? []).map((entry) =>
      entry.connectionState === 'desktop_only'
        ? entry
        : { ...entry, connectionState: undefined },
    );
    const onCatalogRefresh = jest.fn();
    mount({
      catalogValue: { ...catalog, entries },
      onChange: jest.fn(),
      cloudScope: true,
      accountMcp: stubAccountMcpSeam(onCatalogRefresh),
    });
    click(trigger());
    const desktopOnly = document.querySelector(
      'input[aria-label="Select Server 2 (Available on desktop only)"]',
    );
    if (!(desktopOnly instanceof HTMLInputElement))
      throw new Error('Missing desktop-only checkbox');
    expect(desktopOnly.disabled).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(onCatalogRefresh).not.toHaveBeenCalled();
  });

  it('lists every account server outside cloud scope with the same statuses', () => {
    mount({ catalogValue: accountCatalog(), onChange: jest.fn() });
    click(trigger());
    expect(
      document
        .querySelector('[data-testid="unified-table"]')
        ?.getAttribute('data-row-count'),
    ).toBe('4');
    expect(rowText(0)).toContain(PORTAL_PLUGINS_MCP_NOT_SIGNED_IN_LABEL);
    for (const index of [0, 1, 3]) {
      const checkbox = document.querySelector(
        `input[aria-label="Select Server ${String(index)}"]`,
      );
      if (!(checkbox instanceof HTMLInputElement))
        throw new Error(`Missing checkbox for server ${String(index)}`);
      expect(checkbox.disabled).toBe(false);
    }
    const desktopOnly = document.querySelector(
      'input[aria-label="Select Server 2 (Available on desktop only)"]',
    );
    if (!(desktopOnly instanceof HTMLInputElement))
      throw new Error('Missing desktop-only checkbox');
    expect(desktopOnly.disabled).toBe(true);
  });

  it.each([
    ['not_connected', PORTAL_PLUGINS_MCP_NOT_SIGNED_IN_LABEL],
    ['reauth_required', PORTAL_PLUGINS_MCP_NEEDS_RECONNECTING_LABEL],
  ] as const)(
    'lists a %s account server in cloud scope as a selectable row',
    (connectionState, status) => {
      const onChange = jest.fn<void, [PortalChatTabPluginSelections]>();
      const catalogValue = accountCatalog();
      catalogValue.entries = catalogValue.entries?.filter(
        (entry) => entry.connectionState === connectionState,
      );
      mount({ catalogValue, onChange, cloudScope: true });
      click(trigger());
      expect(
        document
          .querySelector('[data-testid="unified-table"]')
          ?.getAttribute('data-row-count'),
      ).toBe('1');
      const index = connectionState === 'not_connected' ? 0 : 1;
      expect(rowText(index)).toContain(status);
      const checkbox = document.querySelector(
        `input[aria-label="Select Server ${String(index)}"]`,
      );
      if (!(checkbox instanceof HTMLInputElement))
        throw new Error('Missing server checkbox');
      click(checkbox);
      const save = document.querySelector(
        '[data-testid="portal-plugins-save"]',
      );
      if (!(save instanceof HTMLButtonElement))
        throw new Error('Missing picker save button');
      click(save);
      expect(onChange.mock.calls[0][0].mcpServerRefs).toEqual([
        { serverId: `server-${String(index)}`, configId: 'default' },
      ]);
    },
  );

  // With `canopy-shared-mcp-account-connections` off the catalog carries no
  // `connectionState`. Such rows keep the CAN-2966 cloud rule (listed only
  // while selected).
  function statelessAndConnectedCatalog(): PortalPluginCatalog {
    const catalogValue = accountCatalog();
    catalogValue.entries = catalogValue.entries
      ?.filter((entry) => entry.connectionState === 'connected')
      .flatMap((entry) => [
        entry,
        {
          ...entry,
          id: 'mcp-stateless',
          name: 'Stateless server',
          connectionState: undefined,
          selectionRef: {
            type: 'mcp-server',
            serverId: 'stateless-server',
            configId: 'default',
          },
        },
      ]);
    return catalogValue;
  }

  it('keeps stateless MCP rows on the pre-existing cloud rule', () => {
    mount({
      catalogValue: statelessAndConnectedCatalog(),
      onChange: jest.fn(),
      cloudScope: true,
    });
    click(trigger());
    expect(
      document
        .querySelector('[data-testid="unified-table"]')
        ?.getAttribute('data-row-count'),
    ).toBe('1');
    expect(
      document.querySelector('[data-row-key="mcp:stateless-server/default"]'),
    ).toBeNull();
    const connected = document.querySelector(
      'input[aria-label="Select Server 3"]',
    );
    if (!(connected instanceof HTMLInputElement))
      throw new Error('Missing connected checkbox');
    expect(connected.disabled).toBe(false);
  });

  it('keeps a selected stateless MCP row listed in cloud scope', () => {
    mount({
      catalogValue: statelessAndConnectedCatalog(),
      onChange: jest.fn(),
      cloudScope: true,
      selections: {
        ...emptySelections,
        mcpServerRefs: [{ serverId: 'stateless-server', configId: 'default' }],
      },
    });
    click(trigger());
    expect(
      document
        .querySelector('[data-testid="unified-table"]')
        ?.getAttribute('data-row-count'),
    ).toBe('2');
    const retained = document.querySelector(
      'input[aria-label="Select Stateless server"]',
    );
    if (!(retained instanceof HTMLInputElement))
      throw new Error('Missing retained stateless checkbox');
    expect(retained.checked).toBe(true);
    expect(retained.disabled).toBe(false);
  });

  it('renders account entries as plain rows without the seam', () => {
    const onChange = jest.fn();
    mount({ catalogValue: accountCatalog(), onChange, cloudScope: true });
    click(trigger());
    const selected = document.querySelector(
      'input[aria-label="Select Server 3"]',
    );
    if (!(selected instanceof HTMLInputElement))
      throw new Error('Missing server checkbox');
    expect(selected.disabled).toBe(false);
  });

  it('does not project a closed picker when the composer has no selections', () => {
    const reads = jest.fn(() => catalog.skills);
    const catalogValue = { ...catalog };
    Object.defineProperty(catalogValue, 'skills', { get: reads });
    const onChange = jest.fn();
    mount({ catalogValue, onChange });
    mount({ catalogValue, onChange, notice: 'changed' });
    expect(reads).not.toHaveBeenCalled();
    act(() => trigger().click());
    expect(reads).toHaveBeenCalled();
  });

  function trigger(): HTMLElement {
    const el = container.querySelector(
      '[data-testid="portal-chat-plugins-button"]',
    );
    if (!(el instanceof HTMLElement)) throw new Error('trigger not found');
    return el;
  }

  function click(el: HTMLElement): void {
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  function inputValue(el: HTMLInputElement, value: string): void {
    // React tracks the input's value on the DOM node, so a plain `el.value =`
    // assignment is swallowed; the native setter has to be invoked against the
    // element. Pulling it off the prototype is the point, and it is called with
    // an explicit receiver below, so the unbound-method warning does not apply.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    if (!setter) throw new Error('input value setter not found');
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it.each([false, true])(
    'limits standalone MCP browsing to existing selections only in cloud scope=%s',
    (cloudScope) => {
      const catalogValue = curatedWritingCatalog(1);
      for (const serverId of ['selected-server', 'hidden-server']) {
        catalogValue.entries?.push({
          id: `app:${serverId}/default`,
          kind: 'app',
          origin: 'curated',
          state: 'available',
          name: serverId,
          description: 'Standalone curated MCP',
          source: { id: serverId, label: serverId },
          providerSupport: { claude: true, codex: true },
          cloudCapabilities: {
            hasSkills: false,
            hasCommands: false,
            hasAgents: false,
            mcpOnly: true,
            hooksStripped: false,
          },
          lastUpdated: '',
          memberSummary: {
            skills: 0,
            commands: 0,
            agents: 0,
            hooks: 0,
            mcpServers: 1,
            lspServers: 0,
          },
          selectionRef: { type: 'mcp-server', serverId, configId: 'default' },
        });
      }
      const selectedRef = { serverId: 'selected-server', configId: 'default' };
      const selections = { ...emptySelections, mcpServerRefs: [selectedRef] };
      const onChange = jest.fn();
      mount({ catalogValue, cloudScope, selections, onChange });
      click(trigger());
      const table = document.querySelector('[data-testid="unified-table"]');
      expect(table?.getAttribute('data-row-count')).toBe(
        cloudScope ? '3' : '4',
      );
      expect(
        document.querySelector('[data-row-key="mcp:hidden-server/default"]') ===
          null,
      ).toBe(cloudScope);
      const sources = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('All sources'),
      );
      if (!sources) throw new Error('Source filter missing');
      click(sources);
      expect(
        Array.from(document.querySelectorAll('label')).some(
          (label) => label.textContent === 'hidden-server',
        ),
      ).toBe(!cloudScope);
      click(sources);
      const selected = document.querySelector<HTMLInputElement>(
        '[data-row-key="mcp:selected-server/default"]',
      );
      if (!selected) throw new Error('Selected MCP control missing');
      expect(selected.checked).toBe(true);
      const save = document.querySelector<HTMLElement>(
        '[data-testid="portal-plugins-save"]',
      );
      if (!save) throw new Error('Save missing');
      click(save);
      expect(onChange).toHaveBeenLastCalledWith(selections);
      click(trigger());
      const retained = document.querySelector<HTMLElement>(
        '[data-row-key="mcp:selected-server/default"]',
      );
      if (!retained) throw new Error('Selected MCP missing after reopening');
      click(retained);
      const nextSave = document.querySelector<HTMLElement>(
        '[data-testid="portal-plugins-save"]',
      );
      if (!nextSave) throw new Error('Save missing');
      click(nextSave);
      expect(onChange).toHaveBeenLastCalledWith(emptySelections);
    },
  );

  it('hides unselected legacy cloud MCP configs without dropping selected exact refs', () => {
    const selectedRef = { serverId: 'srv', configId: 'other' };
    const onChange = jest.fn();
    const catalogValue: PortalPluginCatalog = {
      ...catalog,
      mcpServers: [
        { ...catalog.mcpServers[0], connectionState: 'not_connected' },
        {
          serverId: 'srv',
          configId: 'other',
          serverName: 'Files',
          configName: 'other',
          description: 'Selected config',
          transport: 'http',
        },
      ],
    };
    mount({
      catalogValue,
      cloudScope: true,
      selections: { ...emptySelections, mcpServerRefs: [selectedRef] },
      onChange,
    });
    click(trigger());
    expect(document.querySelector('[data-row-key="mcp:srv/cfg"]')).toBeNull();
    const selected = document.querySelector<HTMLInputElement>(
      '[data-row-key="mcp:srv/other"]',
    );
    if (!selected) throw new Error('Selected config missing');
    expect(selected.checked).toBe(true);
    const save = document.querySelector<HTMLElement>(
      '[data-testid="portal-plugins-save"]',
    );
    if (!save) throw new Error('Save missing');
    click(save);
    expect(onChange).toHaveBeenCalledWith({
      ...emptySelections,
      mcpServerRefs: [selectedRef],
    });
  });

  it.each([1, 3])(
    'shows the plugin and same-name custom skill, with %i bundled skills only in details',
    (memberCount) => {
      mount({
        catalogValue: curatedWritingCatalog(memberCount),
        cloudScope: true,
        onChange: () => undefined,
      });
      click(trigger());

      const table = document.querySelector('[data-testid="unified-table"]');
      expect(table?.getAttribute('data-row-count')).toBe('2');
      expect(
        document.querySelector(
          '[data-row-key="skill:cloud-curated/writing-0"]',
        ),
      ).toBeNull();
      expect(
        document.querySelector('[data-row-key="skill:cloud-custom/writing-0"]'),
      ).not.toBeNull();

      chooseKindFilter('skill');
      expect(table?.getAttribute('data-row-count')).toBe('1');
      chooseKindFilter('all');

      const view = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'View',
      );
      if (!view) throw new Error('View missing');
      click(view);
      expect(
        document
          .querySelector(
            '[data-testid="portal-plugin-details-modal"] section[aria-label="Skills"]',
          )
          ?.querySelectorAll('li'),
      ).toHaveLength(memberCount);
    },
  );

  it('keeps an individually selected member manageable without selecting its plugin or siblings', () => {
    const onChange = jest.fn();
    const memberRef = { sourceId: 'cloud-curated', skillName: 'writing-0' };
    const selections = { ...emptySelections, skillRefs: [memberRef] };
    const catalogValue = curatedWritingCatalog(3);
    mount({ catalogValue, selections, cloudScope: true, onChange });
    click(trigger());

    const member = document.querySelector<HTMLInputElement>(
      '[data-row-key="skill:cloud-curated/writing-0"]',
    );
    const plugin = document.querySelector<HTMLInputElement>(
      '[data-row-key="plugin:cloud-curated/writing"]',
    );
    if (!member || !plugin) throw new Error('Selection controls missing');
    expect(member.checked).toBe(true);
    expect(plugin.checked).toBe(false);
    expect(
      document.querySelector('[data-row-key="skill:cloud-curated/writing-1"]'),
    ).toBeNull();

    click(member);
    expect(member.checked).toBe(false);
    click(member);
    expect(member.checked).toBe(true);
    click(plugin);
    const save = document.querySelector<HTMLElement>(
      '[data-testid="portal-plugins-save"]',
    );
    if (!save) throw new Error('Save missing');
    click(save);
    expect(onChange).toHaveBeenLastCalledWith({
      ...selections,
      pluginRefs: [{ marketplaceId: 'cloud-curated', pluginName: 'writing' }],
    });

    mount({ catalogValue, selections, cloudScope: true, onChange });
    click(trigger());
    const retained = document.querySelector<HTMLElement>(
      '[data-row-key="skill:cloud-curated/writing-0"]',
    );
    if (!retained) throw new Error('Retained member missing');
    click(retained);
    const nextSave = document.querySelector<HTMLElement>(
      '[data-testid="portal-plugins-save"]',
    );
    if (!nextSave) throw new Error('Save missing');
    click(nextSave);
    expect(onChange).toHaveBeenLastCalledWith(emptySelections);

    mount({ catalogValue, cloudScope: true, onChange });
    click(trigger());
    expect(
      document.querySelector('[data-row-key="skill:cloud-curated/writing-0"]'),
    ).toBeNull();
  });

  it('shows a selection-count badge from the persisted selections', () => {
    mount({
      selections: {
        collectionIds: ['col-1'],
        skillRefs: [{ sourceId: 'built-in', skillName: 'summarize' }],
        pluginRefs: [],
      },
      onChange: () => undefined,
    });
    const badge = container.querySelector(
      '[data-testid="portal-plugins-count"]',
    );
    expect(badge?.textContent).toBe('2');
  });

  /**
   * The button is gated on the flag, on cloud scope, on a refresh callback, and
   * — since the dialog became a host-injected component — on the host actually
   * supplying one. Without the last gate the button would open nothing.
   */
  it.each([
    { name: 'the marketplaces flag is off', flagOn: false, withSeam: true },
    { name: 'the host supplies no dialog', flagOn: true, withSeam: false },
  ])('hides Add marketplace when $name', ({ flagOn, withSeam }) => {
    mount({
      cloudScope: true,
      marketplacesEnabled: flagOn,
      addMarketplace: withSeam ? stubSeam() : undefined,
      onChange: () => undefined,
    });
    click(trigger());
    expect(
      document.querySelector('[data-testid="portal-plugins-add-marketplace"]'),
    ).toBeNull();
  });

  it('shows Add marketplace for a flag-enabled cloud picker with a dialog', () => {
    mount({
      cloudScope: true,
      marketplacesEnabled: true,
      addMarketplace: stubSeam(),
      onChange: () => undefined,
    });
    click(trigger());
    expect(
      document.querySelector('[data-testid="portal-plugins-add-marketplace"]'),
    ).not.toBeNull();
  });

  it('renders the host dialog on Add marketplace and closes it again', () => {
    const refresh = jest.fn();
    mount({
      cloudScope: true,
      marketplacesEnabled: true,
      addMarketplace: stubSeam(refresh),
      onChange: () => undefined,
    });
    click(trigger());
    const add = document.querySelector<HTMLButtonElement>(
      '[data-testid="portal-plugins-add-marketplace"]',
    );
    if (!add) throw new Error('Add marketplace not found');
    click(add);
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="stub-marketplace-dialog"]',
    );
    expect(dialog).not.toBeNull();

    // The picker hands its own refresh callback down untouched, so the host's
    // dialog can tell the host to reload the catalog it owns.
    const refreshButton = dialog?.querySelector<HTMLButtonElement>(
      '[data-testid="stub-marketplace-refresh"]',
    );
    if (!refreshButton) throw new Error('stub refresh button not found');
    click(refreshButton);
    expect(refresh).toHaveBeenCalledTimes(1);

    const closeButton = dialog?.querySelector<HTMLButtonElement>(
      '[data-testid="stub-marketplace-close"]',
    );
    if (!closeButton) throw new Error('stub close button not found');
    click(closeButton);
    expect(
      document.querySelector('[data-testid="stub-marketplace-dialog"]'),
    ).toBeNull();
  });

  it('confirms an added marketplace inline once its dialog closes', () => {
    mount({
      cloudScope: true,
      marketplacesEnabled: true,
      addMarketplace: stubSeam(),
      onChange: () => undefined,
    });
    click(trigger());
    const add = document.querySelector<HTMLButtonElement>(
      '[data-testid="portal-plugins-add-marketplace"]',
    );
    if (!add) throw new Error('Add marketplace not found');
    click(add);
    const added = document.querySelector<HTMLButtonElement>(
      '[data-testid="stub-marketplace-added"]',
    );
    if (!added) throw new Error('stub add button not found');
    click(added);

    expect(
      document.querySelector('[data-testid="stub-marketplace-dialog"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="portal-plugins-marketplace-added"]')
        ?.textContent,
    ).toContain('Marketplace added.');

    // Opening the dialog again clears the previous confirmation.
    click(add);
    expect(
      document.querySelector(
        '[data-testid="portal-plugins-marketplace-added"]',
      ),
    ).toBeNull();
  });

  it('opens the selector and rebuilds selections on Save', () => {
    let saved: PortalChatTabPluginSelections | null = null;
    mount({ onChange: (next) => (saved = next) });
    click(trigger());
    expect(
      document.querySelector('[data-testid="portal-plugins-modal"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="unified-table"]'),
    ).not.toBeNull();

    const collectionRow = document.querySelector(
      '[data-testid="portal-plugins-row-checkbox"][data-row-key="collection:col-1"]',
    );
    if (!(collectionRow instanceof HTMLInputElement)) {
      throw new Error('collection row not found');
    }
    click(collectionRow);

    const save = document.querySelector('[data-testid="portal-plugins-save"]');
    if (!(save instanceof HTMLElement)) throw new Error('save not found');
    click(save);

    expect(saved).not.toBeNull();
    const result: PortalChatTabPluginSelections = saved ?? emptySelections;
    expect(result.collectionIds).toEqual(['col-1']);
    expect(result.skillRefs).toEqual([]);
  });

  it('disables plugins unsupported by the active provider', () => {
    mount({ providerType: 'codex', onChange: () => undefined });
    click(trigger());
    const checkboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '[data-testid="portal-plugins-row-checkbox"]',
      ),
    );
    const pluginRow = checkboxes.find(
      (input) => input.getAttribute('data-row-key') === 'plugin:mkt/linter',
    );
    expect(pluginRow).toBeDefined();
    expect(pluginRow?.disabled).toBe(true);
  });

  it('preserves selections absent from the catalog on Save unless the server says they are gone', () => {
    // A skill the user already has selected but which the (partial) catalog
    // does not list must survive a Save that only toggles a collection — Save
    // resolves keys from the catalog UNION the current selections, never a
    // strict intersection that would silently drop it. Only a ref the server
    // classified gone for good is left out (REG-3042); everything it has not
    // classified is still carried.
    let saved: PortalChatTabPluginSelections | null = null;
    act(() => {
      root.render(
        <PortalPluginsPicker
          catalog={{
            collections: catalog.collections,
            skills: [],
            plugins: [],
            mcpServers: [],
          }}
          selections={{
            collectionIds: [],
            bundleIds: ['legacy-collection'],
            skillRefs: [
              { sourceId: 'ext', skillName: 'ghost' },
              { sourceId: 'cloud-custom', skillName: 'deleted' },
            ],
            pluginRefs: [],
            mcpHttpAuthPreferences: [
              {
                target: {
                  kind: 'standalone',
                  serverId: 'srv',
                  configId: 'cfg',
                },
                handler: 'canopy',
              },
            ],
          }}
          brandDisplayName="the desktop app"
          unavailable={[
            {
              ref: {
                kind: 'skill',
                sourceId: 'cloud-custom',
                skillName: 'deleted',
                via: { kind: 'direct' },
              },
              reason: 'deleted',
              disposition: 'gone',
            },
          ]}
          onChange={(next): void => {
            saved = next;
          }}
        />,
      );
    });
    click(trigger());
    const collectionRow = document.querySelector(
      '[data-testid="portal-plugins-row-checkbox"][data-row-key="collection:col-1"]',
    );
    if (!(collectionRow instanceof HTMLInputElement)) {
      throw new Error('collection row not found');
    }
    click(collectionRow);
    const save = document.querySelector('[data-testid="portal-plugins-save"]');
    if (!(save instanceof HTMLElement)) throw new Error('save not found');
    click(save);

    const result: PortalChatTabPluginSelections = saved ?? emptySelections;
    expect(result.collectionIds).toEqual(['col-1']);
    // The uncataloged skill selection is retained, not dropped; the one the
    // server says is gone is not carried back.
    expect(result.skillRefs).toEqual([{ sourceId: 'ext', skillName: 'ghost' }]);
    expect(result.bundleIds).toEqual(['legacy-collection']);
    expect(result.mcpHttpAuthPreferences).toEqual([
      {
        target: { kind: 'standalone', serverId: 'srv', configId: 'cfg' },
        handler: 'canopy',
      },
    ]);
  });

  it('omits mcpServerRefs when none are selected', () => {
    let saved: PortalChatTabPluginSelections | null = null;
    mount({ onChange: (next) => (saved = next) });
    click(trigger());
    const save = document.querySelector('[data-testid="portal-plugins-save"]');
    if (!(save instanceof HTMLElement)) throw new Error('save not found');
    click(save);
    const result: PortalChatTabPluginSelections = saved ?? emptySelections;
    expect(result.mcpServerRefs).toBeUndefined();
  });

  // Cloud hot-swap status (REG-2782): the host's notice renders above the
  // catalog, one line per newline-separated entry; absent notice renders none.
  it('renders the host-supplied notice inside the dialog', () => {
    mount({
      onChange: () => undefined,
      notice:
        'Capability changes are staged and apply at the next turn.\nskill "ghost" was not found',
    });
    click(trigger());

    const notice = document.querySelector(
      '[data-testid="portal-plugins-notice"]',
    );
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(
      'Capability changes are staged and apply at the next turn.',
    );
    expect(notice?.textContent).toContain('skill "ghost" was not found');
  });

  it('renders no notice element when the host supplies none', () => {
    mount({ onChange: () => undefined });
    click(trigger());
    expect(
      document.querySelector('[data-testid="portal-plugins-notice"]'),
    ).toBeNull();
  });

  it('renders unified search, kind/source filters, provider badges, and member details', () => {
    const unifiedCatalog: PortalPluginCatalog = {
      ...catalog,
      collections: [],
      entries: [
        {
          id: 'plugin:cloud-curated/docs-plugin',
          kind: 'plugin',
          origin: 'curated',
          state: 'available',
          name: 'Docs Plugin',
          description: 'Writes and checks docs',
          source: { id: 'cloud-curated', label: 'Curated' },
          providerSupport: { claude: true, codex: true },
          cloudCapabilities: {
            hasSkills: true,
            hasCommands: true,
            hasAgents: false,
            mcpOnly: false,
            hooksStripped: true,
          },
          lastUpdated: '2026-08-26T00:00:00.000Z',
          memberSummary: {
            skills: 1,
            commands: 1,
            agents: 0,
            apps: 1,
            hooks: 1,
            mcpServers: 1,
            lspServers: 0,
          },
          memberInventory: {
            skills: [
              {
                name: 'writing-docs',
                description: 'Writes docs',
                path: 'skills/writing-docs',
              },
            ],
            commands: [
              {
                name: 'check-docs',
                description: 'Checks docs',
                filePath: 'commands/check-docs.md',
              },
            ],
            agents: [],
            apps: [
              {
                name: 'docs-dashboard',
                description: 'Opens the docs dashboard',
                filePath: 'apps/docs-dashboard.md',
              },
            ],
            hooks: [{ event: 'PreToolUse', hookType: 'command' }],
            mcpServers: [{ name: 'docs', type: 'http' }],
            lspServers: [],
          },
          selectionRef: {
            type: 'marketplace-plugin',
            marketplaceId: 'cloud-curated',
            pluginName: 'docs-plugin',
          },
        },
        {
          id: 'skill:cloud-custom/release-notes',
          kind: 'skill',
          origin: 'custom',
          state: 'available',
          name: 'Release Notes',
          description: 'Writes release notes',
          source: { id: 'cloud-custom', label: 'My skills' },
          providerSupport: { claude: true, codex: true },
          cloudCapabilities: {
            hasSkills: true,
            hasCommands: false,
            hasAgents: false,
            mcpOnly: false,
            hooksStripped: false,
          },
          lastUpdated: '2026-08-25T00:00:00.000Z',
          memberSummary: {
            skills: 1,
            commands: 0,
            agents: 0,
            hooks: 0,
            mcpServers: 0,
            lspServers: 0,
          },
          selectionRef: {
            type: 'skill',
            sourceId: 'cloud-custom',
            skillName: 'release-notes',
          },
        },
      ],
    };
    mount({
      catalogValue: unifiedCatalog,
      providerType: 'codex',
      onChange: () => undefined,
    });
    click(trigger());

    const table = document.querySelector('[data-testid="unified-table"]');
    expect(table?.getAttribute('data-row-count')).toBe('2');
    expect(
      document.querySelector('[data-testid="provider-support-icon-claude"]'),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="provider-support-icon-codex-compat"]',
      ),
    ).not.toBeNull();

    const search = document.querySelector('[aria-label="Search by name"]');
    if (!(search instanceof HTMLInputElement)) {
      throw new Error('search input not found');
    }
    inputValue(search, 'Docs');
    expect(table?.getAttribute('data-row-count')).toBe('1');

    inputValue(search, '');
    chooseKindFilter('plugin');
    expect(table?.getAttribute('data-row-count')).toBe('1');
    chooseKindFilter('all');
    const sourceButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('All sources'),
    );
    if (!(sourceButton instanceof HTMLElement)) {
      throw new Error('source filter not found');
    }
    click(sourceButton);
    const sourceCheckbox = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).find((input) =>
      input.closest('label')?.textContent?.includes('My skills'),
    );
    if (!(sourceCheckbox instanceof HTMLInputElement)) {
      throw new Error('source option not found');
    }
    click(sourceCheckbox);
    expect(table?.getAttribute('data-row-count')).toBe('1');
    click(sourceCheckbox);

    const view = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'View',
    );
    if (!(view instanceof HTMLElement)) throw new Error('View not found');
    click(view);
    const details = document.querySelector(
      '[data-testid="portal-plugin-details-modal"]',
    );
    const picker = document.querySelector(
      '[data-testid="portal-plugins-modal"]',
    );
    expect(picker?.getAttribute('aria-labelledby')).toBe(
      'portal-plugins-dialog-title',
    );
    expect(details?.getAttribute('aria-labelledby')).toBe(
      'portal-plugin-details-dialog-title',
    );
    expect(picker?.getAttribute('aria-labelledby')).not.toBe(
      details?.getAttribute('aria-labelledby'),
    );
    expect(
      document.getElementById('portal-plugins-dialog-title')?.textContent,
    ).toContain('Plugins');
    expect(
      document.getElementById('portal-plugin-details-dialog-title')
        ?.textContent,
    ).toContain('Docs Plugin');
    expect(details?.textContent).toContain('Skills');
    expect(details?.textContent).toContain('Agents');
    expect(details?.textContent).toContain('Commands');
    expect(details?.textContent).toContain('Apps');
    expect(details?.textContent).toContain('docs-dashboard');
    expect(details?.textContent).toContain('Hooks');
    expect(details?.textContent).toContain('MCP servers');
    expect(details?.textContent).toContain('LSP servers');
    expect(details?.textContent).toContain('Stripped in cloud sessions');
    expect(details?.textContent).toContain(
      'Not yet available in cloud sessions',
    );
  });

  function provenanceEntry(provenance: {
    sourceUrl?: string;
    license?: string;
    securityAudit?: SkillRiskInfo;
  }): NonNullable<PortalPluginCatalog['entries']>[number] {
    return {
      id: 'plugin:marketplace:openai/build-web-apps',
      kind: 'plugin',
      origin: 'marketplace',
      state: 'available',
      name: 'Build web apps',
      description: 'Scaffold and ship web apps',
      source: { id: 'marketplace:openai', label: 'OpenAI plugins' },
      providerSupport: { claude: true, codex: true },
      cloudCapabilities: {
        hasSkills: true,
        hasCommands: false,
        hasAgents: false,
        mcpOnly: false,
        hooksStripped: false,
      },
      lastUpdated: '2026-09-28T00:00:00.000Z',
      memberSummary: {
        skills: 1,
        commands: 0,
        agents: 0,
        apps: 0,
        hooks: 0,
        mcpServers: 0,
        lspServers: 0,
      },
      memberInventory: {
        skills: [
          {
            name: 'web-app',
            description: 'Builds a web app',
            path: 'skills/web-app',
          },
        ],
        commands: [],
        agents: [],
        apps: [],
        hooks: [],
        mcpServers: [],
        lspServers: [],
      },
      ...provenance,
      selectionRef: {
        type: 'marketplace-plugin',
        marketplaceId: 'marketplace:openai',
        pluginName: 'build-web-apps',
      },
    };
  }

  it('links a marketplace plugin to its pinned source and shows its license in the details', () => {
    const sourceUrl =
      'https://github.com/openai/plugins/tree/5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f/plugins/build-web-apps';
    const provenanceCatalog: PortalPluginCatalog = {
      ...catalog,
      collections: [],
      entries: [
        {
          id: 'plugin:marketplace:openai/build-web-apps',
          kind: 'plugin',
          origin: 'marketplace',
          state: 'available',
          name: 'Build web apps',
          description: 'Scaffold and ship web apps',
          source: { id: 'marketplace:openai', label: 'OpenAI plugins' },
          providerSupport: { claude: true, codex: true },
          cloudCapabilities: {
            hasSkills: true,
            hasCommands: false,
            hasAgents: false,
            mcpOnly: false,
            hooksStripped: false,
          },
          lastUpdated: '2026-09-28T00:00:00.000Z',
          memberSummary: {
            skills: 1,
            commands: 0,
            agents: 0,
            apps: 0,
            hooks: 0,
            mcpServers: 0,
            lspServers: 0,
          },
          memberInventory: {
            skills: [
              {
                name: 'web-app',
                description: 'Builds a web app',
                path: 'skills/web-app',
              },
            ],
            commands: [],
            agents: [],
            apps: [],
            hooks: [],
            mcpServers: [],
            lspServers: [],
          },
          sourceUrl,
          license: 'MIT',
          selectionRef: {
            type: 'marketplace-plugin',
            marketplaceId: 'marketplace:openai',
            pluginName: 'build-web-apps',
          },
        },
      ],
    };
    mount({ catalogValue: provenanceCatalog, onChange: () => undefined });
    click(trigger());
    const view = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'View',
    );
    if (!(view instanceof HTMLElement)) throw new Error('View not found');
    click(view);

    const provenance = document.querySelector(
      '[data-testid="portal-plugin-details-provenance"]',
    );
    expect(provenance?.textContent).toContain('MIT');
    const link = provenance?.querySelector('a');
    expect(link?.getAttribute('href')).toBe(sourceUrl);
    expect(link?.textContent).toBe('View source');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('ignores relayed provenance fields that are not strings', () => {
    // A desktop relay can hand the picker fields the wire type does not
    // promise; Reflect.set writes them without a cast.
    const entry = provenanceEntry({});
    Reflect.set(entry, 'sourceUrl', {
      href: 'https://github.com/openai/plugins',
    });
    Reflect.set(entry, 'license', ['MIT']);
    mount({
      catalogValue: { ...catalog, collections: [], entries: [entry] },
      onChange: () => undefined,
    });
    click(trigger());
    const view = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'View',
    );
    if (!(view instanceof HTMLElement)) throw new Error('View not found');
    click(view);
    expect(
      document.querySelector('[data-testid="portal-plugin-details-modal"]'),
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="portal-plugin-details-provenance"]',
      ),
    ).toBeNull();
  });

  it('shows the license but no link when a relayed source URL is not a GitHub tree', () => {
    const entry = provenanceEntry({
      sourceUrl: 'https://evil.example/tree/abc',
      license: 'MIT',
    });
    mount({
      catalogValue: { ...catalog, collections: [], entries: [entry] },
      onChange: () => undefined,
    });
    click(trigger());
    const view = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'View',
    );
    if (!(view instanceof HTMLElement)) throw new Error('View not found');
    click(view);
    const provenance = document.querySelector(
      '[data-testid="portal-plugin-details-provenance"]',
    );
    expect(provenance?.textContent).toContain('MIT');
    expect(provenance?.querySelector('a')).toBeNull();
  });

  function openFirstDetails(): Element | null {
    click(trigger());
    const view = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'View',
    );
    if (!(view instanceof HTMLElement)) throw new Error('View not found');
    click(view);
    return document.querySelector(
      '[data-testid="portal-plugin-details-provenance"]',
    );
  }

  it('shows the security scan result beside the license in the details', () => {
    mount({
      catalogValue: {
        ...catalog,
        collections: [],
        entries: [
          provenanceEntry({
            license: 'MIT',
            securityAudit: { level: 'medium', socketAlerts: 2 },
          }),
        ],
      },
      onChange: () => undefined,
    });
    const provenance = openFirstDetails();
    const audit = provenance?.querySelector(
      '[data-testid="portal-plugin-details-security-audit"]',
    );
    expect(audit?.textContent).toContain('Security scan');
    expect(audit?.textContent).toContain('Medium');
    expect(audit?.textContent).toContain('2 Socket alerts');
    expect(provenance?.textContent).toContain('License: MIT');
  });

  it('shows the scan alone when a plugin has no license or source recorded', () => {
    mount({
      catalogValue: {
        ...catalog,
        collections: [],
        entries: [
          provenanceEntry({
            securityAudit: { level: 'safe', socketAlerts: 0 },
          }),
        ],
      },
      onChange: () => undefined,
    });
    const provenance = openFirstDetails();
    expect(provenance).not.toBeNull();
    expect(provenance?.textContent).toContain('Safe');
    expect(provenance?.textContent).not.toContain('License:');
    expect(provenance?.querySelector('a')).toBeNull();
  });

  it('ignores a relayed security audit that is not the expected shape', () => {
    const entry = provenanceEntry({ license: 'MIT' });
    Reflect.set(entry, 'securityAudit', { level: 'green', socketAlerts: 'no' });
    mount({
      catalogValue: { ...catalog, collections: [], entries: [entry] },
      onChange: () => undefined,
    });
    const provenance = openFirstDetails();
    expect(provenance?.textContent).toContain('License: MIT');
    expect(provenance?.textContent).not.toContain('Security scan');
  });

  it('labels projected Codex plugin support as compatibility-only', () => {
    const entryBase = {
      state: 'available' as const,
      description: 'Plugin',
      source: { id: 'source', label: 'Source' },
      cloudCapabilities: {
        hasSkills: true,
        hasCommands: false,
        hasAgents: false,
        mcpOnly: false,
        hooksStripped: false,
      },
      lastUpdated: '2026-08-26T00:00:00.000Z',
      memberSummary: {
        skills: 1,
        commands: 0,
        agents: 0,
        hooks: 0,
        mcpServers: 0,
        lspServers: 0,
      },
    };
    mount({
      catalogValue: {
        collections: [],
        skills: [],
        plugins: [],
        mcpServers: [],
        entries: [
          {
            ...entryBase,
            id: 'plugin:cloud-curated/curated',
            kind: 'plugin',
            origin: 'curated',
            name: 'Curated plugin',
            providerSupport: { claude: true, codex: true },
            selectionRef: {
              type: 'marketplace-plugin',
              marketplaceId: 'cloud-curated',
              pluginName: 'curated',
            },
          },
          {
            ...entryBase,
            id: 'plugin:marketplace:official/marketplace',
            kind: 'plugin',
            origin: 'marketplace',
            name: 'Marketplace plugin',
            providerSupport: { claude: true, codex: true },
            selectionRef: {
              type: 'marketplace-plugin',
              marketplaceId: 'marketplace:official',
              pluginName: 'marketplace',
            },
          },
          {
            ...entryBase,
            id: 'plugin:marketplace:official/claude-only',
            kind: 'plugin',
            origin: 'marketplace',
            name: 'Claude-only plugin',
            providerSupport: { claude: true, codex: false },
            selectionRef: {
              type: 'marketplace-plugin',
              marketplaceId: 'marketplace:official',
              pluginName: 'claude-only',
            },
          },
        ],
      },
      onChange: () => undefined,
    });
    click(trigger());

    const curatedRow = document
      .querySelector('[data-row-key="plugin:cloud-curated/curated"]')
      ?.closest('tr');
    const marketplaceRow = document
      .querySelector('[data-row-key="plugin:marketplace:official/marketplace"]')
      ?.closest('tr');
    const unsupportedRow = document
      .querySelector('[data-row-key="plugin:marketplace:official/claude-only"]')
      ?.closest('tr');

    expect(
      curatedRow?.querySelector(
        '[data-testid="provider-support-icon-codex-compat"]',
      ),
    ).not.toBeNull();
    expect(
      marketplaceRow?.querySelector(
        '[data-testid="provider-support-icon-codex-compat"]',
      ),
    ).not.toBeNull();
    expect(
      marketplaceRow?.querySelector(
        '[data-testid="provider-support-icon-codex-native"]',
      ),
    ).toBeNull();
    expect(
      unsupportedRow?.querySelector(
        '[data-testid^="provider-support-icon-codex"]',
      ),
    ).toBeNull();
  });

  it('shows a marketplace sync error and retains the generic fallback without one', () => {
    const syncError = 'git fetch failed: authentication rejected';
    const entryBase = {
      kind: 'plugin' as const,
      origin: 'marketplace' as const,
      state: 'needs-auth' as const,
      description: 'Unavailable plugin',
      source: { id: 'marketplace:official', label: 'Official' },
      providerSupport: { claude: false, codex: false },
      cloudCapabilities: {
        hasSkills: false,
        hasCommands: false,
        hasAgents: false,
        mcpOnly: false,
        hooksStripped: false,
      },
      lastUpdated: '2026-08-26T00:00:00.000Z',
      memberSummary: {
        skills: 0,
        commands: 0,
        agents: 0,
        hooks: 0,
        mcpServers: 0,
        lspServers: 0,
      },
    };
    mount({
      catalogValue: {
        collections: [],
        skills: [],
        plugins: [],
        mcpServers: [],
        entries: [
          {
            ...entryBase,
            id: 'plugin:marketplace:official/failed',
            name: 'Failed plugin',
            syncError,
            selectionRef: {
              type: 'marketplace-plugin',
              marketplaceId: 'marketplace:official',
              pluginName: 'failed',
            },
          },
          {
            ...entryBase,
            id: 'plugin:marketplace:official/pending',
            name: 'Pending plugin',
            selectionRef: {
              type: 'marketplace-plugin',
              marketplaceId: 'marketplace:official',
              pluginName: 'pending',
            },
          },
        ],
      },
      onChange: () => undefined,
    });
    click(trigger());

    expect(
      document
        .querySelector('[data-row-key="plugin:marketplace:official/failed"]')
        ?.closest('tr')
        ?.getAttribute('title'),
    ).toBe(syncError);
    expect(
      document
        .querySelector('[data-row-key="plugin:marketplace:official/pending"]')
        ?.closest('tr')
        ?.getAttribute('title'),
    ).toBe('Unavailable until marketplace sync succeeds');
  });

  it('disables MCP-only plugins without changing first-class app selection behavior', () => {
    const baseEntry = {
      origin: 'curated' as const,
      state: 'available' as const,
      source: { id: 'cloud-curated', label: 'Curated' },
      providerSupport: { claude: true, codex: true },
      cloudCapabilities: {
        hasSkills: false,
        hasCommands: false,
        hasAgents: false,
        mcpOnly: true,
        hooksStripped: false,
      },
      lastUpdated: '2026-08-26T00:00:00.000Z',
      memberSummary: {
        skills: 0,
        commands: 0,
        agents: 0,
        hooks: 0,
        mcpServers: 1,
        lspServers: 0,
      },
    };
    mount({
      catalogValue: {
        collections: [],
        skills: [],
        plugins: [],
        mcpServers: [],
        entries: [
          {
            ...baseEntry,
            id: 'plugin:cloud-curated/mcp-wrapper',
            kind: 'plugin',
            name: 'MCP wrapper',
            description: 'Plugin wrapper',
            selectionRef: {
              type: 'marketplace-plugin',
              marketplaceId: 'cloud-curated',
              pluginName: 'mcp-wrapper',
            },
          },
          {
            ...baseEntry,
            id: 'plugin:marketplace:official/mcp-wrapper',
            kind: 'plugin',
            origin: 'marketplace',
            state: 'needs-auth',
            name: 'Marketplace MCP wrapper',
            description: 'Marketplace plugin wrapper',
            source: {
              id: 'marketplace:official',
              label: 'Official marketplace',
            },
            selectionRef: {
              type: 'marketplace-plugin',
              marketplaceId: 'marketplace:official',
              pluginName: 'mcp-wrapper',
            },
          },
          {
            ...baseEntry,
            id: 'app:server/default',
            kind: 'app',
            name: 'Cloud app',
            description: 'Existing curated server',
            selectionRef: {
              type: 'mcp-server',
              serverId: 'server',
              configId: 'default',
            },
          },
        ],
      },
      onChange: () => undefined,
    });
    click(trigger());

    const plugin = document.querySelector<HTMLInputElement>(
      '[data-row-key="plugin:cloud-curated/mcp-wrapper"]',
    );
    const app = document.querySelector<HTMLInputElement>(
      '[data-row-key="mcp:server/default"]',
    );
    const marketplacePlugin = document.querySelector<HTMLInputElement>(
      '[data-row-key="plugin:marketplace:official/mcp-wrapper"]',
    );
    expect(plugin?.disabled).toBe(true);
    expect(plugin?.closest('tr')?.getAttribute('title')).toBe(
      'Not yet available in cloud sessions',
    );
    expect(marketplacePlugin?.disabled).toBe(true);
    expect(marketplacePlugin?.closest('tr')?.getAttribute('title')).toBe(
      'Not yet available in cloud sessions',
    );
    expect(app?.disabled).toBe(false);
  });

  it('keeps kind-colliding selection refs independent', () => {
    let saved: PortalChatTabPluginSelections | null = null;
    mount({
      catalogValue: {
        collections: [],
        skills: [],
        plugins: [],
        mcpServers: [],
        entries: [
          {
            id: 'skill:cloud-curated/shared',
            kind: 'skill',
            origin: 'curated',
            state: 'available',
            name: 'Shared skill',
            description: 'Skill',
            source: { id: 'cloud-curated', label: 'Curated' },
            providerSupport: { claude: true, codex: true },
            cloudCapabilities: {
              hasSkills: true,
              hasCommands: false,
              hasAgents: false,
              mcpOnly: false,
              hooksStripped: false,
            },
            lastUpdated: '2026-08-26T00:00:00.000Z',
            memberSummary: {
              skills: 1,
              commands: 0,
              agents: 0,
              hooks: 0,
              mcpServers: 0,
              lspServers: 0,
            },
            selectionRef: {
              type: 'skill',
              sourceId: 'cloud-curated',
              skillName: 'shared',
            },
          },
          {
            id: 'plugin:cloud-curated/shared',
            kind: 'plugin',
            origin: 'curated',
            state: 'available',
            name: 'Shared plugin',
            description: 'Plugin',
            source: { id: 'cloud-curated', label: 'Curated' },
            providerSupport: { claude: true, codex: true },
            cloudCapabilities: {
              hasSkills: true,
              hasCommands: false,
              hasAgents: false,
              mcpOnly: false,
              hooksStripped: false,
            },
            lastUpdated: '2026-08-26T00:00:00.000Z',
            memberSummary: {
              skills: 1,
              commands: 0,
              agents: 0,
              hooks: 0,
              mcpServers: 0,
              lspServers: 0,
            },
            selectionRef: {
              type: 'marketplace-plugin',
              marketplaceId: 'cloud-curated',
              pluginName: 'shared',
            },
          },
        ],
      },
      onChange: (next) => {
        saved = next;
      },
    });
    click(trigger());

    const skill = document.querySelector<HTMLInputElement>(
      '[data-row-key="skill:cloud-curated/shared"]',
    );
    const plugin = document.querySelector<HTMLInputElement>(
      '[data-row-key="plugin:cloud-curated/shared"]',
    );
    expect(skill).not.toBeNull();
    expect(plugin).not.toBeNull();
    if (skill) click(skill);
    const save = document.querySelector<HTMLElement>(
      '[data-testid="portal-plugins-save"]',
    );
    if (save) click(save);

    expect(saved).toEqual({
      collectionIds: [],
      skillRefs: [{ sourceId: 'cloud-curated', skillName: 'shared' }],
      pluginRefs: [],
    });
  });

  it('lets an already-selected MCP-only plugin be removed', () => {
    let saved: PortalChatTabPluginSelections | null = null;
    const mcpOnlyPlugin: PortalPluginCatalog['entries'] = [
      {
        id: 'plugin:cloud-curated/mcp-wrapper',
        kind: 'plugin',
        origin: 'curated',
        state: 'available',
        name: 'MCP wrapper',
        description: 'Plugin wrapper',
        source: { id: 'cloud-curated', label: 'Curated' },
        providerSupport: { claude: true, codex: true },
        cloudCapabilities: {
          hasSkills: false,
          hasCommands: false,
          hasAgents: false,
          mcpOnly: true,
          hooksStripped: false,
        },
        lastUpdated: '2026-08-26T00:00:00.000Z',
        memberSummary: {
          skills: 0,
          commands: 0,
          agents: 0,
          hooks: 0,
          mcpServers: 1,
          lspServers: 0,
        },
        selectionRef: {
          type: 'marketplace-plugin',
          marketplaceId: 'cloud-curated',
          pluginName: 'mcp-wrapper',
        },
      },
    ];
    mount({
      catalogValue: {
        collections: [],
        skills: [],
        plugins: [],
        mcpServers: [],
        entries: mcpOnlyPlugin,
      },
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [
          { marketplaceId: 'cloud-curated', pluginName: 'mcp-wrapper' },
        ],
      },
      onChange: (next) => {
        saved = next;
      },
    });
    click(trigger());

    const checkbox = document.querySelector<HTMLInputElement>(
      '[data-row-key="plugin:cloud-curated/mcp-wrapper"]',
    );
    expect(checkbox?.checked).toBe(true);
    expect(checkbox?.disabled).toBe(false);
    if (checkbox) click(checkbox);
    const save = document.querySelector<HTMLElement>(
      '[data-testid="portal-plugins-save"]',
    );
    if (save) click(save);
    const result: PortalChatTabPluginSelections = saved ?? emptySelections;
    expect(result.pluginRefs).toEqual([]);
  });
});

describe('selected capabilities that are unavailable (REG-3042)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const dropbox = { serverId: 'dropbox', configId: 'default' };
  const goneDropbox: CapabilityUnavailable = {
    ref: { kind: 'mcpServer', ...dropbox, via: { kind: 'direct' } },
    displayName: 'Dropbox',
    reason: 'removed_from_catalog',
    disposition: 'gone',
  };
  const selected: PortalChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [{ sourceId: 'cloud-custom', skillName: 'f3c1' }],
    pluginRefs: [],
    mcpServerRefs: [dropbox, { serverId: 'canva', configId: 'default' }],
  };
  const records: CapabilityUnavailable[] = [
    { ...goneDropbox, reason: 'turned_off', disposition: 'unavailable' },
    {
      ref: {
        kind: 'skill',
        sourceId: 'cloud-custom',
        skillName: 'f3c1',
        via: { kind: 'direct' },
      },
      reason: 'deleted',
      disposition: 'unavailable',
    },
    {
      ref: {
        kind: 'mcpServer',
        serverId: 'canva',
        configId: 'default',
        via: { kind: 'direct' },
      },
      displayName: 'Canva',
      reason: 'desktop_only',
      disposition: 'unsupported',
    },
  ];

  function render(
    unavailable: CapabilityUnavailable[],
    onChange: (next: PortalChatTabPluginSelections) => void = () => undefined,
  ): void {
    act(() => {
      root.render(
        <PortalPluginsPicker
          catalog={{
            collections: [],
            skills: [],
            plugins: [],
            mcpServers: [],
            entries: [],
          }}
          selections={selected}
          brandDisplayName="Canopy"
          cloudScope
          unavailable={unavailable}
          onChange={onChange}
        />,
      );
    });
  }

  function click(el: Element | null): void {
    if (!(el instanceof HTMLElement)) throw new Error('element not found');
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  function row(key: string): HTMLTableRowElement {
    const checkbox = document.querySelector(
      `[data-testid="portal-plugins-row-checkbox"][data-row-key="${key}"]`,
    );
    const element = checkbox?.closest('tr');
    if (!(element instanceof HTMLTableRowElement))
      throw new Error(`row ${key} not found`);
    return element;
  }

  it('lists every selected capability the catalog no longer has, with its status, so the count and rows agree', () => {
    render(records);
    expect(
      container.querySelector('[data-testid="portal-plugins-count"]')
        ?.textContent,
    ).toBe('3');
    click(
      container.querySelector('[data-testid="portal-chat-plugins-button"]'),
    );

    expect(
      document.querySelector('[data-testid="portal-plugins-modal"]')
        ?.textContent,
    ).toContain('3 selected');
    expect(row('mcp:dropbox/default').textContent).toContain('Dropbox');
    expect(row('mcp:dropbox/default').textContent).toContain(
      PORTAL_PLUGINS_TURNED_OFF_LABEL,
    );
    expect(row('mcp:canva/default').textContent).toContain(
      PORTAL_PLUGINS_DESKTOP_ONLY_LABEL,
    );
    // No raw key stands in for a missing name.
    const skill = row('skill:cloud-custom/f3c1');
    expect(skill.textContent).toContain('Skill');
    expect(skill.textContent).not.toContain('f3c1');
    expect(skill.textContent).toContain(
      PORTAL_PLUGINS_NO_LONGER_AVAILABLE_LABEL,
    );
  });

  it('removes one with Remove and saves without it', () => {
    let saved: PortalChatTabPluginSelections | null = null;
    render(records, (next) => {
      saved = next;
    });
    click(
      container.querySelector('[data-testid="portal-chat-plugins-button"]'),
    );
    click(
      row('mcp:canva/default').querySelector(
        '[data-testid="portal-plugins-remove-unavailable"]',
      ),
    );
    expect(
      document.querySelector('[data-testid="portal-plugins-modal"]')
        ?.textContent,
    ).toContain('2 selected');
    click(document.querySelector('[data-testid="portal-plugins-save"]'));
    const result: PortalChatTabPluginSelections = saved ?? selected;
    expect(result.mcpServerRefs).toEqual([dropbox]);
    expect(result.skillRefs).toEqual(selected.skillRefs);
  });

  it("badges a listed row the server recorded, alongside the catalog's own status", () => {
    act(() => {
      root.render(
        <PortalPluginsPicker
          catalog={{
            collections: [],
            skills: [],
            plugins: [],
            mcpServers: [],
            entries: (curatedWritingCatalog(1).entries ?? [])
              .slice(0, 1)
              .map((entry) => ({
                ...entry,
                id: 'mcp-canva',
                kind: 'app' as const,
                name: 'Canva',
                connectionState: 'desktop_only' as const,
                selectionRef: {
                  type: 'mcp-server' as const,
                  serverId: 'canva',
                  configId: 'default',
                },
              })),
          }}
          selections={selected}
          brandDisplayName="Canopy"
          cloudScope
          unavailable={[records[2]]}
          onChange={() => undefined}
        />,
      );
    });
    click(
      container.querySelector('[data-testid="portal-chat-plugins-button"]'),
    );
    const canva = row('mcp:canva/default');
    expect(canva.textContent).toContain(PORTAL_PLUGINS_DESKTOP_ONLY_LABEL);
    expect(
      canva.querySelector('[data-testid="portal-plugins-remove-unavailable"]'),
    ).not.toBeNull();
  });

  it('drops every gone ref from the save, inherited ones included, so the server prunes defaults and the count matches', () => {
    let saved: PortalChatTabPluginSelections | null = null;
    act(() => {
      root.render(
        <PortalPluginsPicker
          catalog={{
            collections: [],
            skills: [],
            plugins: [],
            mcpServers: [],
            entries: [],
          }}
          selections={selected}
          inheritedSelections={{
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [dropbox],
          }}
          brandDisplayName="Canopy"
          cloudScope
          unavailable={[
            goneDropbox,
            {
              ref: {
                kind: 'skill',
                sourceId: 'cloud-custom',
                skillName: 'f3c1',
                via: { kind: 'direct' },
              },
              reason: 'deleted',
              disposition: 'gone',
            },
          ]}
          onChange={(next) => {
            saved = next;
          }}
        />,
      );
    });
    click(
      container.querySelector('[data-testid="portal-chat-plugins-button"]'),
    );
    click(document.querySelector('[data-testid="portal-plugins-save"]'));
    const result: PortalChatTabPluginSelections = saved ?? selected;
    // Both are dropped. The server prunes the inherited one from the project
    // defaults (never into the chat's removals), so what the picker saved is
    // what the server answers with.
    expect(result.skillRefs).toEqual([]);
    expect(result.mcpServerRefs).not.toContainEqual(dropbox);
  });

  it('never offers a listed row the server calls gone: once removed it cannot be selected again', () => {
    act(() => {
      root.render(
        <PortalPluginsPicker
          catalog={{
            collections: [],
            skills: [],
            plugins: [],
            mcpServers: [],
            entries: (curatedWritingCatalog(1).entries ?? [])
              .slice(0, 1)
              .map((entry) => ({
                ...entry,
                id: 'mcp-dropbox',
                kind: 'app' as const,
                name: 'Dropbox',
                selectionRef: { type: 'mcp-server' as const, ...dropbox },
              })),
          }}
          selections={selected}
          brandDisplayName="Canopy"
          cloudScope
          unavailable={[goneDropbox]}
          onChange={() => undefined}
        />,
      );
    });
    click(
      container.querySelector('[data-testid="portal-chat-plugins-button"]'),
    );
    click(
      row('mcp:dropbox/default').querySelector(
        '[data-testid="portal-plugins-remove-unavailable"]',
      ),
    );
    const checkbox = row('mcp:dropbox/default').querySelector(
      '[data-testid="portal-plugins-row-checkbox"]',
    );
    expect(checkbox).toBeInstanceOf(HTMLInputElement);
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
  });

  it('treats a reason or disposition from a newer producer as degraded: no row, no badge, still saved', () => {
    let saved: PortalChatTabPluginSelections | null = null;
    render(
      [
        { ...records[0], reason: 'quarantined', disposition: 'gone' },
        { ...records[1], reason: 'deleted', disposition: 'retired' },
      ],
      (next) => {
        saved = next;
      },
    );
    click(
      container.querySelector('[data-testid="portal-chat-plugins-button"]'),
    );
    expect(
      document.querySelector('[data-row-key="mcp:dropbox/default"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-row-key="skill:cloud-custom/f3c1"]'),
    ).toBeNull();
    click(document.querySelector('[data-testid="portal-plugins-save"]'));
    const result: PortalChatTabPluginSelections = saved ?? selected;
    expect(result.mcpServerRefs).toEqual(selected.mcpServerRefs);
    expect(result.skillRefs).toEqual(selected.skillRefs);
  });

  it('adds no row or badge for a capability that is only degraded', () => {
    render([
      {
        ref: {
          kind: 'mcpServer',
          serverId: 'linear',
          configId: 'default',
          via: {
            kind: 'plugin',
            marketplaceId: 'cloud-curated',
            pluginName: 'kit',
          },
        },
        reason: 'removed_from_catalog',
        disposition: 'degraded',
      },
    ]);
    click(
      container.querySelector('[data-testid="portal-chat-plugins-button"]'),
    );
    expect(
      document.querySelector('[data-row-key="mcp:linear/default"]'),
    ).toBeNull();
  });
});

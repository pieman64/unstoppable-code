/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InstalledItemUninstallTarget } from '@canopy/protocol/installed-items';
import type { PluginsEntryStatusBinding } from '@canopy/ui-shared/components';
import {
  installedItemTargetKey,
  type InstalledEntryStatusState,
  type InstalledItemMutationOutcome,
} from '@canopy/ui-shared/lib';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { InstalledItemStatus } from '@canopy/protocol/installed-items';
import type { CustomizeWorkflowActions } from '../customizeWorkflowActions';
import {
  EMPTY_INSTALLED_STATUS_SNAPSHOT,
  WORKFLOW_INSTALLED_FOOTNOTE,
  type InstalledStatusSnapshot,
} from '../customizeSections';
import {
  CustomizeTabSections,
  type CustomizeTabSectionsProps,
  type CustomizeUpdateFailure,
} from '../CustomizeTabSections';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

// `null` is a host without a client provider, as on the Portal page.
let mockClient: { capabilities: { customSkillEdit?: boolean } } | null = null;
jest.mock('@canopy/app-state', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/app-state'),
  useOptionalCanopyClient: (): typeof mockClient => mockClient,
}));

function entry(
  id: string,
  overrides: Partial<UnifiedPluginEntry> = {},
): UnifiedPluginEntry {
  return {
    id,
    kind: 'skill',
    origin: 'installed-standalone',
    name: id,
    description: '',
    categories: [],
    components: { skills: 1, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: false, codex: false },
    state: 'installed',
    recommended: false,
    ref: { type: 'skill', sourceId: 'github:example:repo', skillName: id },
    ...overrides,
  };
}

function ready(
  status: 'active' | 'available' | 'disabled',
): InstalledEntryStatusState {
  return {
    kind: 'ready',
    item: {
      target: { kind: 'skill', sourceId: 'source', skillName: 'x' },
      status,
      removable: true,
      notices: [],
    },
    configurations: [],
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve = (): void => {};
  let reject = (error: unknown): void => {
    void error;
  };
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('CustomizeTabSections', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<CustomizeTabSectionsProps> = {}): void {
    act(() =>
      root.render(
        <CustomizeTabSections
          tab="all"
          entries={[]}
          query=""
          installedInventory="ready"
          onSelectEntry={() => {}}
          {...props}
        />,
      ),
    );
  }

  function q(testId: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  function dq(testId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  function openMenu(sectionTestId: string, id: string): void {
    act(() =>
      q(sectionTestId)
        ?.querySelector<HTMLElement>(`[data-testid="customize-row-menu-${id}"]`)
        ?.click(),
    );
  }

  function sectionOrder(): string[] {
    return Array.from(
      container.querySelectorAll('section[id^="customize-section-"]'),
    ).map((node) => node.id);
  }

  const updatable = (id: string): UnifiedPluginEntry =>
    entry(id, { updateAvailable: true });
  const catalog = (id: string): UnifiedPluginEntry =>
    entry(id, { origin: 'marketplace', state: 'available' });

  it('keeps upstream installed status in the headed Installed list', () => {
    render({
      entries: [entry('installed-skill')],
      entryStatus: {
        states: {
          'installed-skill': {
            kind: 'read-only',
            reason: 'Connect your desktop to manage status.',
          },
        },
        pendingKeys: new Set(),
      },
    });
    expect(
      q('plugins-entry-status-installed-skill-unavailable'),
    ).not.toBeNull();
    expect(q('customize-section-installed-rows')).not.toBeNull();
  });

  it('keeps the read-only status on a row whose connection was never checked', () => {
    render({
      entries: [
        entry('unchecked-mcp', {
          kind: 'app',
          connection: { status: 'unknown' },
        }),
      ],
      entryStatus: {
        states: {
          'unchecked-mcp': {
            kind: 'read-only',
            reason: 'Connect your desktop to manage status.',
          },
        },
        pendingKeys: new Set(),
      },
    });
    // No "Not checked" chip, so the row still shows its one status.
    expect(q('plugins-connection-status-unchecked-mcp')).toBeNull();
    expect(q('plugins-entry-status-unchecked-mcp-unavailable')).not.toBeNull();
  });

  it('shows one status on a connected row: its connection, not a read-only Unavailable', () => {
    render({
      entries: [
        entry('cloud-mcp', {
          kind: 'app',
          connection: { status: 'connected' },
        }),
        entry('local-skill'),
      ],
      entryStatus: {
        states: {
          'cloud-mcp': {
            kind: 'read-only',
            reason: 'Connect your desktop to manage status.',
          },
          'local-skill': {
            kind: 'read-only',
            reason: 'Connect your desktop to manage status.',
          },
        },
        pendingKeys: new Set(),
      },
    });
    // CAN-4261: "Connected" beside "Unavailable" reads as two contradicting
    // statuses; the connection badge is the row's one status.
    expect(q('plugins-connection-status-cloud-mcp')).not.toBeNull();
    expect(q('plugins-entry-status-cloud-mcp-unavailable')).toBeNull();
    // A row without a connection badge keeps its read-only status.
    expect(q('plugins-entry-status-local-skill-unavailable')).not.toBeNull();
    // The hidden status leaves no empty slot squeezing the row's name.
    expect(
      q('customize-installed-row-cloud-mcp')?.querySelector(
        '[data-testid="customize-row-status-slot"]',
      ),
    ).toBeNull();
    expect(
      q('customize-installed-row-local-skill')?.querySelector(
        '[data-testid="customize-row-status-slot"]',
      ),
    ).not.toBeNull();
  });

  it('renders Updates, Installed, Shared by me and Browse in order', () => {
    render({
      ownershipAvailable: true,
      supportedUpdateKinds: ['skill'],
      onUpdateEntry: () => Promise.resolve(),
      entries: [
        updatable('outdated'),
        entry('mine', {
          origin: 'shared',
          state: 'available',
          ownedByViewer: true,
          isShared: true,
        }),
        catalog('catalog'),
      ],
    });
    expect(sectionOrder()).toEqual([
      'customize-section-updates',
      'customize-section-installed',
      'customize-section-shared-by-me',
      'customize-section-browse',
    ]);
  });

  it('shows no Installed section for ready, empty inventory', () => {
    render({ tab: 'skill', entries: [catalog('catalog')] });
    expect(q('customize-section-installed')).toBeNull();
    expect(q('customize-section-browse')).not.toBeNull();
  });

  it('renders the gated state for unavailable inventory and keeps Browse', () => {
    render({
      tab: 'skill',
      entries: [catalog('catalog')],
      installedInventory: 'unavailable',
      installedUnavailable: {
        title: 'Pair a desktop',
        body: 'Installed items live on your desktop.',
        action: <button data-testid="pair">Pair</button>,
      },
    });
    const installed = q('customize-section-installed');
    expect(
      installed?.querySelector(
        '[data-testid="customize-installed-unavailable"]',
      ),
    ).not.toBeNull();
    expect(installed?.querySelector('[data-testid="pair"]')).not.toBeNull();
    // An unread inventory has no count; "0" would claim nothing is installed.
    expect(q('customize-section-installed-count')).toBeNull();
    expect(q('plugins-entry-catalog')).not.toBeNull();
  });

  it('counts known installs while the desktop inventory is unavailable', () => {
    render({
      tab: 'app',
      entries: [entry('cloud-mcp', { kind: 'app' })],
      installedInventory: 'unavailable',
    });
    expect(q('customize-section-installed-count')?.textContent).toBe('1');
  });

  it('reports a failed read with a retry instead of an empty inventory', () => {
    const onRetry = jest.fn();
    render({
      tab: 'skill',
      installedInventory: 'error',
      onRetryInventory: onRetry,
    });
    const error = q('customize-installed-error');
    expect(error).not.toBeNull();
    expect(q('customize-section-installed-count')).toBeNull();
    act(() => error?.querySelector('button')?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('previews eight installs on All and resets expansion on tab changes', () => {
    const entries = Array.from({ length: 10 }, (_unused, index) =>
      entry(`skill-${index}`),
    );
    render({ entries });
    const rows = (): number =>
      container.querySelectorAll(
        '[data-testid="customize-section-installed-rows"] > li',
      ).length;
    expect(rows()).toBe(8);
    act(() => q('customize-section-installed-show-all')?.click());
    expect(rows()).toBe(10);
    // An inventory refresh with new array identity keeps the list expanded.
    render({ entries: [...entries] });
    expect(rows()).toBe(10);
    render({ entries, tab: 'skill' });
    render({ entries, tab: 'all' });
    expect(rows()).toBe(8);
    render({ entries, query: 'skill' });
    expect(rows()).toBe(10);
  });

  it('lists installed catalog rows only in Installed', () => {
    const installedCatalog = entry('catalog-alpha', {
      origin: 'marketplace',
      state: 'installed',
    });
    render({ tab: 'skill', entries: [installedCatalog] });
    expect(
      container.querySelector(
        '[data-testid="customize-section-installed"] [data-testid="customize-row-catalog-alpha"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="customize-section-browse"] [data-testid="plugins-entry-catalog-alpha"]',
      ),
    ).toBeNull();
  });

  it('hides an available catalog alias when its installed entry is present', () => {
    const installed = entry('installed-alpha', {
      origin: 'installed-standalone',
      state: 'installed',
    });
    const catalogAlias = entry('catalog-alpha', {
      origin: 'marketplace',
      state: 'available',
      installedEntryId: installed.id,
    });
    render({ tab: 'skill', entries: [installed, catalogAlias] });
    expect(
      container.querySelector(
        '[data-testid="customize-section-installed"] [data-testid="customize-row-installed-alpha"]',
      ),
    ).not.toBeNull();
    expect(q('plugins-entry-catalog-alpha')).toBeNull();
  });

  it('guards a row update against rapid duplicate clicks and clears busy on rejection', async () => {
    const pending = deferred();
    const onUpdateEntry = jest.fn(() => pending.promise);
    const onUpdateFailures = jest.fn<
      void,
      [readonly CustomizeUpdateFailure[]]
    >();
    const onUpdatesSettled = jest.fn();
    render({
      tab: 'skill',
      supportedUpdateKinds: ['skill'],
      entries: [updatable('outdated')],
      onUpdateEntry,
      onUpdateFailures,
      onUpdatesSettled,
    });
    const button = q('customize-update-outdated');
    act(() => {
      button?.click();
      button?.click();
    });
    expect(onUpdateEntry).toHaveBeenCalledTimes(1);
    expect(q('customize-update-outdated')?.hasAttribute('disabled')).toBe(true);
    await act(async () => {
      pending.reject(new Error('IPC failed'));
      await pending.promise.catch(() => {});
    });
    expect(onUpdateFailures.mock.calls[0][0][0].entry.id).toBe('outdated');
    expect(onUpdatesSettled).toHaveBeenCalledTimes(1);
    expect(q('customize-update-outdated')?.hasAttribute('disabled')).toBe(
      false,
    );
  });

  it.each([undefined, '2.0.0'])(
    'shows only an Update icon in Updates and Installed with tooltip %s and shared busy state',
    async (latestVersion) => {
      const pending = deferred();
      const onUpdateEntry = jest.fn(() => pending.promise);
      render({
        tab: 'skill',
        entries: [entry('outdated', { updateAvailable: true, latestVersion })],
        supportedUpdateKinds: ['skill'],
        onUpdateEntry,
      });
      const buttons = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="customize-update-outdated"]',
        ),
      );
      expect(buttons).toHaveLength(2);
      for (const button of buttons) {
        expect(button.textContent).toBe('');
        expect(button.getAttribute('aria-label')).toBe('Update outdated');
        expect(button.querySelector('svg')).not.toBeNull();
      }
      expect(
        container.querySelector(
          '[data-testid="customize-row-update-marker-outdated"]',
        ),
      ).toBeNull();
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
        );
        buttons[0].focus();
      });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        latestVersion ? 'Update to v2.0.0' : 'Update available',
      );
      act(() => {
        buttons[0].click();
        buttons[1].click();
      });
      expect(onUpdateEntry).toHaveBeenCalledTimes(1);
      for (const button of buttons) {
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');
      }
      await act(async () => {
        pending.resolve();
        await pending.promise;
      });
      for (const button of buttons) {
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-busy')).toBe('false');
      }
    },
  );

  it('updates all batchable skills sequentially and continues after a failure', async () => {
    const calls: string[] = [];
    const onUpdateEntry = jest.fn(
      (target: UnifiedPluginEntry): Promise<void> => {
        calls.push(target.id);
        return target.id === 'first'
          ? Promise.reject(new Error('nope'))
          : Promise.resolve();
      },
    );
    const onUpdateFailures = jest.fn<
      void,
      [readonly CustomizeUpdateFailure[]]
    >();
    render({
      tab: 'all',
      supportedUpdateKinds: ['skill', 'automation'],
      entries: [
        updatable('first'),
        updatable('second'),
        entry('automation', {
          kind: 'automation',
          updateAvailable: true,
          ref: { type: 'automation', activityId: 'a1' },
        }),
        updatable('custom'),
      ].map((row) => (row.id === 'custom' ? { ...row, custom: true } : row)),
      onUpdateEntry,
      onUpdateFailures,
    });
    // Automations are never batched; custom skills are never update-eligible.
    expect(q('customize-update-automation')).not.toBeNull();
    expect(q('customize-update-custom')).toBeNull();
    await act(async () => {
      q('customize-update-all')?.click();
      await Promise.resolve();
    });
    expect(calls).toEqual(['first', 'second']);
    expect(onUpdateFailures).toHaveBeenCalledTimes(1);
    expect(onUpdateFailures.mock.calls[0][0]).toHaveLength(1);
  });

  it('offers Update all only for more than one batchable row', () => {
    render({
      tab: 'skill',
      supportedUpdateKinds: ['skill'],
      entries: [updatable('only')],
      onUpdateEntry: () => Promise.resolve(),
    });
    expect(q('customize-update-all')).toBeNull();
  });

  it('does not start a batch during a row update, even before a rerender', async () => {
    const pending = deferred();
    const onUpdateEntry = jest.fn(() => pending.promise);
    render({
      supportedUpdateKinds: ['skill'],
      entries: [updatable('one'), updatable('two')],
      onUpdateEntry,
    });
    const batch = q('customize-update-all');
    act(() => {
      q('customize-update-one')?.click();
      batch?.click();
    });
    expect(onUpdateEntry).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(onUpdateEntry).toHaveBeenCalledTimes(1);
  });

  it('spends a focus intent once data settles, whether or not the section exists', () => {
    const onSettled = jest.fn();
    render({
      tab: 'workflow',
      focusSection: 'shared-by-me',
      focusPending: true,
      onFocusSectionSettled: onSettled,
    });
    expect(onSettled).not.toHaveBeenCalled();
    render({
      tab: 'workflow',
      focusSection: 'shared-by-me',
      focusPending: false,
      onFocusSectionSettled: onSettled,
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('prefers the search empty message over the creation empty state', () => {
    render({
      tab: 'collection',
      emptyState: <div data-testid="create-collection" />,
    });
    expect(q('create-collection')).not.toBeNull();
    render({
      tab: 'collection',
      query: 'zzz',
      emptyState: <div data-testid="create-collection" />,
    });
    expect(q('create-collection')).toBeNull();
    expect(q('customize-sections-empty')?.textContent).toBe(
      'Nothing matches your search.',
    );
  });

  it("offers Clear search as the search empty state's one action", () => {
    const onClearSearch = jest.fn();
    render({ tab: 'skill', query: 'zzz', onClearSearch });
    const empty = q('customize-sections-empty');
    expect(empty?.querySelector('svg')).toBeInstanceOf(Element);
    const clear = q('customize-sections-clear-search');
    expect(clear?.textContent).toBe('Clear search');
    act(() => {
      clear?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClearSearch).toHaveBeenCalledTimes(1);
  });

  it('treats a whitespace query as no search', () => {
    render({ tab: 'skill', query: '   ', entries: [catalog('catalog')] });
    expect(q('customize-result-count')).toBeNull();
    expect(q('customize-sections')?.getAttribute('data-result-count')).toBe(
      '1',
    );
  });

  it('places menu actions in contract order', () => {
    render({
      tab: 'skill',
      supportedUpdateKinds: ['skill'],
      onUpdateEntry: () => Promise.resolve(),
      onConnectEntry: () => {},
      onShareEntry: () => {},
      entryShareStates: new Map([['outdated', { status: 'shareable' }]]),
      entries: [updatable('outdated')].map((row) => ({
        ...row,
        latestVersion: '2.0.0',
        state: 'needs-auth' as const,
      })),
    });
    const installed = q('customize-section-installed');
    act(() =>
      installed
        ?.querySelector<HTMLElement>(
          '[data-testid="customize-row-menu-outdated"]',
        )
        ?.click(),
    );
    const labels = Array.from(
      document.querySelectorAll(
        '[data-testid="customize-row-menu-outdated-surface"] [data-testid^="customize-row-menu-outdated-"], [data-testid="customize-row-menu-outdated-surface"] [role="separator"]',
      ),
    ).map((node) => node.textContent || node.getAttribute('role'));
    expect(labels).toEqual([
      'Connect',
      'Open details',
      'Update to v2.0.0',
      'Share…',
    ]);
  });

  it('labels the update item Update when the version is unknown', () => {
    render({
      tab: 'skill',
      supportedUpdateKinds: ['skill'],
      onUpdateEntry: () => Promise.resolve(),
      entries: [updatable('outdated')],
    });
    openMenu('customize-section-installed', 'outdated');
    expect(dq('customize-row-menu-outdated-update')?.textContent).toBe(
      'Update',
    );
  });

  describe('CAN-4840 — removal from the row menu', () => {
    const pluginTarget: InstalledItemUninstallTarget = {
      kind: 'plugin',
      marketplaceId: 'claude',
      pluginName: 'slack',
    };
    const plugin = entry('mkt:claude/slack', {
      kind: 'plugin',
      origin: 'marketplace',
      name: 'Slack',
      ref: {
        type: 'marketplace-plugin',
        marketplaceId: 'claude',
        pluginName: 'slack',
      },
    });

    function ready(
      target: InstalledItemUninstallTarget,
      overrides: {
        removable?: boolean;
        uninstallTarget?: InstalledItemUninstallTarget | null;
      } = {},
    ): InstalledEntryStatusState {
      const uninstallTarget =
        overrides.uninstallTarget === null
          ? undefined
          : (overrides.uninstallTarget ?? target);
      return {
        kind: 'ready',
        item: {
          target,
          status: 'active',
          removable: overrides.removable ?? true,
          ...(uninstallTarget ? { uninstallTarget } : {}),
          uninstallDescription: 'Removes the provider installations.',
          notices: [],
        },
        configurations: [],
      };
    }

    function binding(
      states: Record<string, InstalledEntryStatusState>,
      overrides: Partial<PluginsEntryStatusBinding> = {},
    ): PluginsEntryStatusBinding {
      return {
        states,
        pendingKeys: new Set(),
        onUninstall: jest.fn(
          (): Promise<InstalledItemMutationOutcome> =>
            Promise.resolve({ ok: true, notices: [] }),
        ),
        onUninstalled: jest.fn(),
        ...overrides,
      };
    }

    function menuLabels(id: string): (string | null)[] {
      return Array.from(
        document.querySelectorAll(
          `[data-testid="customize-row-menu-${id}-surface"] [data-testid^="customize-row-menu-${id}-"], [data-testid="customize-row-menu-${id}-surface"] [role="separator"]`,
        ),
      ).map((node) => node.textContent || node.getAttribute('role'));
    }

    it('offers Uninstall… for a removable plugin and confirms with the shared dialog', async () => {
      const onSelectEntry = jest.fn();
      const entryStatus = binding({ [plugin.id]: ready(pluginTarget) });
      render({ entries: [plugin], entryStatus, onSelectEntry });
      openMenu('customize-section-installed', plugin.id);
      expect(menuLabels(plugin.id).slice(-2)).toEqual([
        'separator',
        'Uninstall…',
      ]);
      act(() => dq(`customize-row-menu-${plugin.id}-remove`)?.click());
      const dialog = document.querySelector<HTMLElement>(
        '[data-testid="customize-row-remove-dialog"]',
      );
      expect(dialog?.textContent).toContain('Uninstall Slack?');
      expect(dialog?.textContent).toContain(
        'Removes the provider installations.',
      );
      const confirm = document.querySelector<HTMLElement>(
        '[data-testid="customize-row-remove-confirm"]',
      );
      expect(confirm?.textContent).toBe('Uninstall');
      expect(onSelectEntry).not.toHaveBeenCalled();
      await act(async () => {
        confirm?.click();
        await Promise.resolve();
      });
      expect(entryStatus.onUninstall).toHaveBeenCalledWith(pluginTarget);
      expect(entryStatus.onUninstalled).toHaveBeenCalledWith(plugin);
      expect(
        document.querySelector('[data-testid="customize-row-remove-dialog"]'),
      ).toBeNull();
    });

    it.each([
      [
        'an MCP server',
        entry('mcp-local:notes', {
          kind: 'app',
          name: 'Notes',
          ref: { type: 'local-mcp', serverId: 'notes' },
        }),
        { kind: 'mcp-server', serverId: 'notes' },
        'Remove',
      ],
      [
        'a custom skill',
        entry('skill:custom:app:review', {
          name: 'Review',
          custom: true,
          ref: { type: 'skill', sourceId: 'custom:app', skillName: 'review' },
        }),
        { kind: 'skill', sourceId: 'custom:app', skillName: 'review' },
        'Delete',
      ],
    ] satisfies [
      string,
      UnifiedPluginEntry,
      InstalledItemUninstallTarget,
      string,
    ][])('labels %s with its verb', (_label, row, target, verb) => {
      render({
        entries: [row],
        entryStatus: binding({ [row.id]: ready(target) }),
      });
      openMenu('customize-section-installed', row.id);
      expect(dq(`customize-row-menu-${row.id}-remove`)?.textContent).toBe(
        `${verb}…`,
      );
      act(() => dq(`customize-row-menu-${row.id}-remove`)?.click());
      expect(
        document.querySelector('[data-testid="customize-row-remove-confirm"]')
          ?.textContent,
      ).toBe(verb);
      expect(
        document.querySelector('[data-testid="customize-row-remove-dialog"]')
          ?.textContent,
      ).toContain(`${verb} ${row.name}?`);
    });

    it.each([
      [
        'without onUninstall',
        binding(
          { [plugin.id]: ready(pluginTarget) },
          { onUninstall: undefined },
        ),
      ],
      ['while loading', binding({ [plugin.id]: { kind: 'loading' } })],
      [
        'read-only',
        binding({
          [plugin.id]: { kind: 'read-only', reason: 'Connect your desktop.' },
        }),
      ],
      [
        'not removable',
        binding({ [plugin.id]: ready(pluginTarget, { removable: false }) }),
      ],
      [
        'without an uninstall target',
        binding({
          [plugin.id]: ready(pluginTarget, { uninstallTarget: null }),
        }),
      ],
    ])('shows no destructive item %s', (_label, entryStatus) => {
      render({ entries: [plugin], entryStatus });
      openMenu('customize-section-installed', plugin.id);
      expect(dq(`customize-row-menu-${plugin.id}-remove`)).toBeNull();
    });

    it('disables the destructive item while its uninstall target is pending', () => {
      const server = entry('mcp-local:notes', {
        kind: 'app',
        name: 'Notes',
        ref: { type: 'local-mcp', serverId: 'notes' },
      });
      const target: InstalledItemUninstallTarget = {
        kind: 'plugin',
        marketplaceId: 'claude',
        pluginName: 'notes',
      };
      const uninstallTarget: InstalledItemUninstallTarget = {
        kind: 'mcp-server',
        serverId: 'notes',
      };
      const states = { [server.id]: ready(target, { uninstallTarget }) };
      render({
        entries: [server],
        entryStatus: binding(states, {
          pendingKeys: new Set([installedItemTargetKey(uninstallTarget)]),
        }),
      });
      openMenu('customize-section-installed', server.id);
      expect(
        dq(`customize-row-menu-${server.id}-remove`)?.getAttribute(
          'aria-disabled',
        ),
      ).toBe('true');
      act(() => q(`customize-row-menu-${server.id}`)?.click());
      render({
        entries: [server],
        entryStatus: binding(states, {
          pendingKeys: new Set([installedItemTargetKey(target)]),
        }),
      });
      openMenu('customize-section-installed', server.id);
      expect(
        dq(`customize-row-menu-${server.id}-remove`)?.getAttribute(
          'aria-disabled',
        ),
      ).toBeNull();
    });

    it('renders one dialog for many removable rows', () => {
      const second = entry('mkt:claude/notion', {
        kind: 'plugin',
        name: 'Notion',
        ref: {
          type: 'marketplace-plugin',
          marketplaceId: 'claude',
          pluginName: 'notion',
        },
      });
      render({
        entries: [plugin, second],
        entryStatus: binding({
          [plugin.id]: ready(pluginTarget),
          [second.id]: ready({
            kind: 'plugin',
            marketplaceId: 'claude',
            pluginName: 'notion',
          }),
        }),
      });
      openMenu('customize-section-installed', plugin.id);
      act(() => dq(`customize-row-menu-${plugin.id}-remove`)?.click());
      expect(
        document.querySelectorAll(
          '[data-testid="customize-row-remove-dialog"]',
        ),
      ).toHaveLength(1);
    });

    it('keeps the dialog open with the failure message, and cancel closes it', async () => {
      const entryStatus = binding(
        { [plugin.id]: ready(pluginTarget) },
        {
          onUninstall: jest.fn(
            (): Promise<InstalledItemMutationOutcome> =>
              Promise.resolve({
                ok: false,
                message: 'Uninstall cannot finish while the provider is busy.',
                notices: [],
              }),
          ),
        },
      );
      render({ entries: [plugin], entryStatus });
      openMenu('customize-section-installed', plugin.id);
      act(() => dq(`customize-row-menu-${plugin.id}-remove`)?.click());
      await act(async () => {
        document
          .querySelector<HTMLElement>(
            '[data-testid="customize-row-remove-confirm"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(
        document.querySelector('[data-testid="customize-row-remove-dialog"]')
          ?.textContent,
      ).toContain('Uninstall cannot finish while the provider is busy.');
      expect(entryStatus.onUninstalled).not.toHaveBeenCalled();
      act(() =>
        document
          .querySelector<HTMLElement>(
            '[data-testid="customize-row-remove-cancel"]',
          )
          ?.click(),
      );
      expect(
        document.querySelector('[data-testid="customize-row-remove-dialog"]'),
      ).toBeNull();
      expect(entryStatus.onUninstall).toHaveBeenCalledTimes(1);
    });

    it('cancelling before confirming never uninstalls', () => {
      const entryStatus = binding({ [plugin.id]: ready(pluginTarget) });
      render({ entries: [plugin], entryStatus });
      openMenu('customize-section-installed', plugin.id);
      act(() => dq(`customize-row-menu-${plugin.id}-remove`)?.click());
      act(() =>
        document
          .querySelector<HTMLElement>(
            '[data-testid="customize-row-remove-cancel"]',
          )
          ?.click(),
      );
      expect(entryStatus.onUninstall).not.toHaveBeenCalled();
      expect(
        document.querySelector('[data-testid="customize-row-remove-dialog"]'),
      ).toBeNull();
    });

    it('drops a pending confirmation when the host withdraws removal', () => {
      const entryStatus = binding({ [plugin.id]: ready(pluginTarget) });
      render({ entries: [plugin], entryStatus });
      openMenu('customize-section-installed', plugin.id);
      act(() => dq(`customize-row-menu-${plugin.id}-remove`)?.click());
      const dialog = (): Element | null =>
        document.querySelector('[data-testid="customize-row-remove-dialog"]');
      expect(dialog()).not.toBeNull();
      render({
        entries: [plugin],
        entryStatus: { ...entryStatus, onUninstall: undefined },
      });
      expect(dialog()).toBeNull();
      render({ entries: [plugin], entryStatus });
      expect(dialog()).toBeNull();
      expect(entryStatus.onUninstall).not.toHaveBeenCalled();
    });

    it('closes a pending confirmation when the host moves to another desktop', () => {
      const first = binding(
        { [plugin.id]: ready(pluginTarget) },
        { removalScope: 'desktop-a' },
      );
      render({ entries: [plugin], entryStatus: first });
      openMenu('customize-section-installed', plugin.id);
      act(() => dq(`customize-row-menu-${plugin.id}-remove`)?.click());
      const dialog = (): Element | null =>
        document.querySelector('[data-testid="customize-row-remove-dialog"]');
      expect(dialog()).not.toBeNull();
      const second = binding(
        { [plugin.id]: ready(pluginTarget) },
        { removalScope: 'desktop-b' },
      );
      render({ entries: [plugin], entryStatus: second });
      expect(dialog()).toBeNull();
      // Returning to the first desktop does not bring the stale dialog back.
      render({ entries: [plugin], entryStatus: first });
      expect(dialog()).toBeNull();
      expect(first.onUninstall).not.toHaveBeenCalled();
      expect(second.onUninstall).not.toHaveBeenCalled();
    });

    it('keeps a pending confirmation open across host re-renders in the same scope', async () => {
      const first = binding(
        { [plugin.id]: ready(pluginTarget) },
        { removalScope: 'desktop-a' },
      );
      render({ entries: [plugin], entryStatus: first });
      openMenu('customize-section-installed', plugin.id);
      act(() => dq(`customize-row-menu-${plugin.id}-remove`)?.click());
      // A status poll hands over a new binding and a new callback identity.
      const next = binding(
        { [plugin.id]: ready(pluginTarget) },
        { removalScope: 'desktop-a' },
      );
      render({ entries: [plugin], entryStatus: next });
      const confirm = document.querySelector<HTMLElement>(
        '[data-testid="customize-row-remove-confirm"]',
      );
      expect(confirm).not.toBeNull();
      await act(async () => {
        confirm?.click();
        await Promise.resolve();
      });
      expect(first.onUninstall).not.toHaveBeenCalled();
      expect(next.onUninstall).toHaveBeenCalledWith(pluginTarget);
    });

    it('offers no removal item on Shared by me rows', () => {
      const shared = entry('skill:shared:s1', {
        origin: 'shared',
        ownedByViewer: true,
        isShared: true,
        ref: { type: 'shared-skill', skillId: 's1' },
      });
      render({
        ownershipAvailable: true,
        entries: [shared],
        entryStatus: binding({
          [shared.id]: ready({
            kind: 'skill',
            sourceId: 'shared',
            skillName: 's1',
          }),
        }),
      });
      const section = q('customize-section-shared-by-me');
      expect(section).not.toBeNull();
      openMenu('customize-section-shared-by-me', shared.id);
      expect(dq(`customize-row-menu-${shared.id}-remove`)).toBeNull();
    });

    it('badges only the linked Shared by me row and clears it on refresh (CAN-5220)', () => {
      const shared = (id: string, linked: boolean): UnifiedPluginEntry =>
        entry(`skill:shared:${id}`, {
          origin: 'shared',
          ownedByViewer: true,
          isShared: true,
          sharedWith: { audience: 'organization', name: 'Northwind' },
          ...(linked ? { publicShare: { upToDate: true } } : {}),
          ref: { type: 'shared-skill', skillId: id },
        });
      const section = (): HTMLElement | null =>
        q('customize-section-shared-by-me');
      const badge = (id: string): Element | null =>
        section()?.querySelector(
          `[data-testid="customize-row-public-link-skill:shared:${id}"]`,
        ) ?? null;
      render({
        ownershipAvailable: true,
        entries: [shared('linked', true), shared('org', false)],
      });
      expect(badge('linked')?.textContent).toBe('Public link');
      expect(badge('org')).toBeNull();
      render({
        ownershipAvailable: true,
        entries: [shared('linked', false), shared('org', false)],
      });
      expect(badge('linked')).toBeNull();
      expect(
        section()?.querySelector(
          '[data-testid="customize-row-subtitle-skill:shared:linked"]',
        )?.textContent,
      ).toBe('Northwind');
    });

    it('renders shared actions only on Shared by me rows', () => {
      const shared = entry('skill:shared:s1', {
        origin: 'shared',
        ownedByViewer: true,
        isShared: true,
        ref: { type: 'shared-skill', skillId: 's1' },
      });
      render({
        ownershipAvailable: true,
        entries: [shared],
        renderSharedActions: (row) => (
          <button type="button" data-testid={`x-${row.id}`} />
        ),
      });
      expect(
        q('customize-section-shared-by-me')?.querySelector(
          `[data-testid="x-${shared.id}"]`,
        ),
      ).not.toBeNull();
      expect(
        q('customize-section-installed')?.querySelector(
          `[data-testid="x-${shared.id}"]`,
        ) ?? null,
      ).toBeNull();
    });

    it('passes onConnect to the row sign-in chip', () => {
      const onConnectEntry = jest.fn();
      const row = entry('mcp-local:github', {
        kind: 'app',
        state: 'needs-auth',
        ref: { type: 'local-mcp', serverId: 'github' },
      });
      render({ entries: [row], onConnectEntry });
      act(() => q(`customize-row-sign-in-${row.id}`)?.click());
      expect(onConnectEntry).toHaveBeenCalledWith(row);
    });

    it('signs in to the waiting bundled server from a plugin row', () => {
      const onConnectEntry = jest.fn();
      const signedIn = entry('mcp-local:docs', {
        kind: 'app',
        ref: { type: 'local-mcp', serverId: 'docs' },
      });
      const waiting = entry('mcp-local:slack', {
        kind: 'app',
        pendingSignIns: 1,
        ref: { type: 'local-mcp', serverId: 'slack' },
      });
      const plugin = entry('mkt:community/slack', {
        kind: 'plugin',
        origin: 'marketplace',
        name: 'Slack',
        pendingSignIns: 1,
        bundledServerRows: [
          {
            serverName: 'docs',
            endpoint: 'https://docs.example.test/mcp',
            entryId: signedIn.id,
            serverId: 'docs',
          },
          {
            serverName: 'slack',
            endpoint: 'https://slack.example.test/mcp',
            entryId: waiting.id,
            serverId: 'slack',
          },
        ],
        ref: {
          type: 'marketplace-plugin',
          marketplaceId: 'community',
          pluginName: 'slack',
        },
      });
      render({ entries: [plugin, signedIn, waiting], onConnectEntry });
      const chip = q(`customize-row-sign-in-${plugin.id}`);
      expect(chip?.tagName).toBe('BUTTON');
      expect(chip?.getAttribute('aria-label')).toBe(
        `1 sign-in pending. Connect ${waiting.name}`,
      );
      act(() => chip?.click());
      expect(onConnectEntry).toHaveBeenCalledWith(waiting);
      openMenu('customize-section-installed', plugin.id);
      expect(dq(`customize-row-menu-${plugin.id}-connect`)).not.toBeNull();
      // A row with nothing waiting offers no Connect.
      expect(q(`customize-row-sign-in-${signedIn.id}`)).toBeNull();
    });

    it('skips a bundled server that keeps its own row when picking what to connect', () => {
      const onConnectEntry = jest.fn();
      const listed = entry('mcp-local:listed', {
        kind: 'app',
        state: 'needs-auth',
        pendingSignIns: 1,
        ref: { type: 'local-mcp', serverId: 'listed' },
      });
      const hidden = entry('mcp-local:hidden', {
        kind: 'app',
        pendingSignIns: 1,
        ref: { type: 'local-mcp', serverId: 'hidden' },
      });
      const plugin = entry('mkt:community/tools', {
        kind: 'plugin',
        origin: 'marketplace',
        name: 'Tools',
        pendingSignIns: 1,
        bundledServerRows: [listed, hidden].map((server) => ({
          serverName: server.id,
          endpoint: `https://${server.id}.example.test/mcp`,
          entryId: server.id,
          serverId: server.id,
        })),
        ref: {
          type: 'marketplace-plugin',
          marketplaceId: 'community',
          pluginName: 'tools',
        },
      });
      render({ entries: [plugin, listed, hidden], onConnectEntry });
      act(() => q(`customize-row-sign-in-${plugin.id}`)?.click());
      expect(onConnectEntry).toHaveBeenCalledWith(hidden);
      expect(onConnectEntry).not.toHaveBeenCalledWith(listed);
    });

    it('connects an installed integration card that still has a pending sign-in', () => {
      // One working connection makes the card installed; an expired one
      // beside it still waits for sign-in.
      const onConnectEntry = jest.fn();
      const card = entry('mcp-catalog:github', {
        kind: 'app',
        origin: 'curated',
        name: 'GitHub',
        pendingSignIns: 1,
        ref: { type: 'curated-mcp', key: 'github' },
      });
      render({ entries: [card], onConnectEntry });
      const chip = q(`customize-row-sign-in-${card.id}`);
      expect(chip?.tagName).toBe('BUTTON');
      expect(chip?.getAttribute('aria-label')).toBe(
        '1 sign-in pending. Connect GitHub',
      );
      act(() => chip?.click());
      expect(onConnectEntry).toHaveBeenCalledWith(card);
      openMenu('customize-section-installed', card.id);
      act(() => dq(`customize-row-menu-${card.id}-connect`)?.click());
      expect(onConnectEntry).toHaveBeenCalledTimes(2);
    });
  });
  it('expands all installed rows when a manager deep link focuses Installed (CAN-4267)', () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      entry(`installed-${index}`),
    );
    render({
      entries,
      focusSection: 'installed',
      onFocusSectionSettled: jest.fn(),
    });
    expect(
      container.querySelector('[data-testid="customize-installed-show-all"]'),
    ).toBeNull();
    expect(container.textContent).toContain('installed-11');
  });

  it('retains an empty Installed destination for explicit manager navigation (CAN-4267)', () => {
    render({
      entries: [],
      focusSection: 'installed',
      onFocusSectionSettled: jest.fn(),
    });
    expect(
      container.querySelector('#customize-section-installed'),
    ).not.toBeNull();
  });
  it('filters all Installed pages by effective Active status and hides Browse until Any status (CAN-4267, CAN-5272)', () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      entry(`installed-${index}`),
    );
    const states: Record<string, InstalledEntryStatusState> = {};
    entries.forEach((row, index) => {
      states[row.id] = ready(index === 11 ? 'active' : 'available');
    });
    const props: Partial<CustomizeTabSectionsProps> = {
      entries: [
        ...entries,
        entry('browse-only', { origin: 'curated', state: 'available' }),
      ],
      installedStatusInventory: 'ready',
      entryStatus: { states, pendingKeys: new Set() },
    };
    render({ ...props, installedStatusFilter: 'active' });
    expect(q('customize-row-installed-11')).not.toBeNull();
    expect(q('customize-row-installed-0')).toBeNull();
    expect(q('customize-section-installed-count')?.textContent).toBe('1');
    expect(q('customize-section-browse')).toBeNull();
    expect(q('plugins-entry-browse-only')).toBeNull();
    render(props);
    expect(q('customize-row-installed-0')).not.toBeNull();
    expect(q('plugins-entry-browse-only')).not.toBeNull();
  });

  it('shows a provider-connected desktop-only row as fixed Active and drops unreadable rows under a filter (CAN-5272)', () => {
    const gmail = entry('gmail', {
      kind: 'app',
      origin: 'curated',
      surface: 'desktop',
      ref: { type: 'curated-mcp', key: 'gmail' },
    });
    const unreadable = entry('unreadable');
    const props: Partial<CustomizeTabSectionsProps> = {
      entries: [gmail, unreadable],
      installedStatusInventory: 'ready',
      entryStatus: {
        states: {
          gmail: { kind: 'fixed', status: 'active', reason: 'Connected.' },
          unreadable: { kind: 'read-only', reason: 'Offline.' },
        },
        pendingKeys: new Set(),
      },
    };
    render({ ...props, installedStatusFilter: 'active' });
    const status = q('plugins-entry-status-gmail');
    expect(status?.getAttribute('data-status')).toBe('active');
    expect(status?.getAttribute('aria-disabled')).toBe('true');
    expect(q('plugins-entry-status-gmail-unavailable')).toBeNull();
    expect(q('plugins-surface-gmail')).not.toBeNull();
    expect(q('customize-row-unreadable')).toBeNull();
    expect(q('customize-section-installed-count')?.textContent).toBe('1');
    render({ ...props, installedStatusFilter: 'available' });
    expect(q('customize-row-gmail')).toBeNull();
    render(props);
    expect(q('customize-row-gmail')).not.toBeNull();
    expect(q('customize-row-unreadable')).not.toBeNull();
  });

  it.each(['loading', 'error', 'unavailable'] as const)(
    'never reports a filtered-empty state while status inventory is %s',
    (installedStatusInventory) => {
      render({
        entries: [],
        installedStatusFilter: 'disabled',
        installedStatusInventory,
      });
      expect(container.textContent).not.toContain('Nothing is disabled.');
      expect(container.textContent).not.toContain('Nothing is active');
      expect(q('customize-installed-empty')).toBeNull();
      expect(q('customize-installed-status-description')).toBeNull();
    },
  );

  it.each(['active', 'available', 'disabled'] as const)(
    'reads "Nothing is %s." when the filtered list is empty',
    (status) => {
      render({
        entries: [],
        installedStatusFilter: status,
        installedStatusInventory: 'ready',
        focusSection: 'installed',
        onFocusSectionSettled: jest.fn(),
      });
      expect(q('customize-installed-empty')?.textContent).toBe(
        `Nothing is ${status}.`,
      );
      expect(q('customize-installed-status-description')).not.toBeNull();
    },
  );

  it('keeps unknown statuses visible and spends focus without a clear control', () => {
    const settled = jest.fn();
    render({
      entries: [entry('unknown')],
      installedStatusFilter: 'active',
      installedStatusInventory: 'ready',
      entryStatus: {
        states: { unknown: { kind: 'loading' } },
        pendingKeys: new Set(),
      },
      focusSection: 'installed',
      onFocusSectionSettled: settled,
    });
    expect(q('customize-row-unknown')).not.toBeNull();
    expect(q('customize-installed-active-filter')).toBeNull();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  describe('CAN-4838 installed status filter', () => {
    function statusProps(
      states: Record<string, InstalledEntryStatusState>,
    ): Partial<CustomizeTabSectionsProps> {
      return {
        installedStatusInventory: 'ready',
        entryStatus: { states, pendingKeys: new Set() },
      };
    }
    const dimmed = (id: string): boolean =>
      q(`customize-installed-row-${id}`)?.getAttribute('data-dimmed') ===
      'true';

    it('keeps a mutated row in place until the filter changes', () => {
      const entries = [entry('a'), entry('b')];
      render({
        entries,
        installedStatusFilter: 'disabled',
        ...statusProps({ a: ready('disabled'), b: ready('active') }),
      });
      expect(q('customize-row-a')).not.toBeNull();
      expect(q('customize-row-b')).toBeNull();
      expect(dimmed('a')).toBe(true);
      render({
        entries,
        installedStatusFilter: 'disabled',
        ...statusProps({ a: ready('available'), b: ready('active') }),
      });
      expect(q('customize-row-a')).not.toBeNull();
      expect(dimmed('a')).toBe(false);
      expect(q('customize-row-b')).toBeNull();
      render({
        entries,
        installedStatusFilter: 'available',
        ...statusProps({ a: ready('available'), b: ready('active') }),
      });
      expect(q('customize-row-a')).not.toBeNull();
      expect(q('customize-row-b')).toBeNull();
      render({
        entries,
        installedStatusFilter: 'active',
        ...statusProps({ a: ready('available'), b: ready('active') }),
      });
      expect(q('customize-row-a')).toBeNull();
      expect(q('customize-row-b')).not.toBeNull();
    });

    it('pins an entry once its status becomes ready', () => {
      const entries = [entry('a')];
      render({
        entries,
        installedStatusFilter: 'active',
        ...statusProps({ a: { kind: 'loading' } }),
      });
      expect(q('customize-row-a')).not.toBeNull();
      render({
        entries,
        installedStatusFilter: 'active',
        ...statusProps({ a: ready('disabled') }),
      });
      expect(q('customize-row-a')).toBeNull();
      render({
        entries,
        installedStatusFilter: 'active',
        ...statusProps({ a: ready('active') }),
      });
      expect(q('customize-row-a')).toBeNull();
    });

    it('does not reset membership when the search query changes', () => {
      const entries = [entry('a')];
      render({
        entries,
        installedStatusFilter: 'disabled',
        ...statusProps({ a: ready('disabled') }),
      });
      expect(q('customize-row-a')).not.toBeNull();
      render({
        entries,
        query: 'a',
        installedStatusFilter: 'disabled',
        ...statusProps({ a: ready('active') }),
      });
      expect(q('customize-row-a')).not.toBeNull();
    });

    it('keeps membership in a host-held snapshot across an unmount until the filter changes', () => {
      let held: InstalledStatusSnapshot = EMPTY_INSTALLED_STATUS_SNAPSHOT;
      const onSnapshot = (next: InstalledStatusSnapshot): void => {
        held = next;
      };
      const entries = [entry('a'), entry('b')];
      const hosted = (
        filter: InstalledItemStatus,
        states: Record<string, InstalledEntryStatusState>,
      ): Partial<CustomizeTabSectionsProps> => ({
        entries,
        installedStatusFilter: filter,
        installedStatusSnapshot: held,
        onInstalledStatusSnapshotChange: onSnapshot,
        ...statusProps(states),
      });
      render(hosted('active', { a: ready('active'), b: ready('disabled') }));
      expect(q('customize-row-a')).not.toBeNull();
      expect(q('customize-row-b')).toBeNull();
      expect(held.members).toEqual({ a: true, b: false });
      // An entry detail page unmounts the list; the row changed meanwhile.
      act(() => root.render(<></>));
      render(hosted('active', { a: ready('disabled'), b: ready('disabled') }));
      expect(q('customize-row-a')).not.toBeNull();
      expect(dimmed('a')).toBe(true);
      render(
        hosted('disabled', { a: ready('disabled'), b: ready('disabled') }),
      );
      render(hosted('active', { a: ready('disabled'), b: ready('disabled') }));
      expect(q('customize-row-a')).toBeNull();
    });

    it('keeps a host-held snapshot through a remount that briefly lacks its context', () => {
      let held: InstalledStatusSnapshot = EMPTY_INSTALLED_STATUS_SNAPSHOT;
      const onSnapshot = (next: InstalledStatusSnapshot): void => {
        held = next;
      };
      const entries = [entry('a'), entry('b')];
      const hosted = (
        contextKey: string,
        filter: InstalledItemStatus | undefined,
        states: Record<string, InstalledEntryStatusState>,
      ): Partial<CustomizeTabSectionsProps> => ({
        entries,
        contextKey,
        installedStatusFilter: filter,
        installedStatusSnapshot: held,
        onInstalledStatusSnapshotChange: onSnapshot,
        ...statusProps(states),
      });
      render(
        hosted('project-1', 'active', {
          a: ready('active'),
          b: ready('disabled'),
        }),
      );
      expect(held.members).toEqual({ a: true, b: false });
      act(() => root.render(<></>));
      // A Portal page remounts before its project resolves and before the
      // paired desktop's statuses arrive again.
      render(hosted('', 'active', { a: { kind: 'loading' } }));
      render(
        hosted('project-1', 'active', {
          a: ready('disabled'),
          b: ready('disabled'),
        }),
      );
      expect(q('customize-row-a')).not.toBeNull();
      expect(q('customize-row-b')).toBeNull();
      // Clearing the filter still ends the snapshot, even with nothing pinned.
      render(hosted('project-1', undefined, { a: ready('disabled') }));
      render(
        hosted('project-1', 'active', {
          a: ready('disabled'),
          b: ready('disabled'),
        }),
      );
      expect(q('customize-row-a')).toBeNull();
    });

    it('reads the search empty copy when a search narrows a status filter to nothing', () => {
      render({
        entries: [entry('a', { name: 'Alpha' })],
        query: 'zzz',
        installedStatusFilter: 'disabled',
        ...statusProps({ a: ready('disabled') }),
      });
      expect(q('customize-installed-empty')?.textContent).toBe(
        'Nothing matches your search.',
      );
      expect(container.textContent).not.toContain('Nothing is disabled.');
    });

    it('hides the status description line when the host cannot read statuses', () => {
      render({
        entries: [entry('a')],
        installedStatusInventory: 'unavailable',
      });
      expect(q('customize-row-a')).not.toBeNull();
      expect(q('customize-installed-status-description')).toBeNull();
    });

    it('shows the status description line only on tabs with statuses, ready inventory and rows or a filter', () => {
      render({ entries: [entry('a')] });
      expect(q('customize-installed-status-description')?.textContent).toBe(
        'Active items are added to every new chat. Available ones load when you or an agent need them. Disabled ones stay installed but are hidden.',
      );
      render({
        tab: 'agent',
        agentsAvailable: true,
        entries: [
          entry('agent-1', {
            kind: 'agent',
            ref: { type: 'local-agent', agentId: 'agent-1' },
          }),
        ],
      });
      expect(q('customize-row-agent-1')).not.toBeNull();
      expect(q('customize-installed-status-description')).toBeNull();
      render({ entries: [entry('a')], installedInventory: 'loading' });
      expect(q('customize-installed-status-description')).toBeNull();
      render({
        entries: [],
        focusSection: 'installed',
        onFocusSectionSettled: jest.fn(),
      });
      expect(q('customize-installed-empty')).not.toBeNull();
      expect(q('customize-installed-status-description')).toBeNull();
    });

    it('dims Disabled rows in place', () => {
      render({
        entries: [entry('a'), entry('b')],
        ...statusProps({ a: ready('disabled'), b: ready('active') }),
      });
      expect(dimmed('a')).toBe(true);
      expect(q('customize-installed-row-b')?.hasAttribute('data-dimmed')).toBe(
        false,
      );
    });

    it('expands a collapsed Installed section when a status filter is applied', () => {
      const entries = Array.from({ length: 10 }, (_unused, index) =>
        entry(`skill-${index}`),
      );
      const states: Record<string, InstalledEntryStatusState> = {};
      for (const row of entries) states[row.id] = ready('disabled');
      const rows = (): number =>
        container.querySelectorAll(
          '[data-testid="customize-section-installed-rows"] > li',
        ).length;
      const onExpanded = jest.fn();
      render({
        entries,
        onInstalledExpandedChange: onExpanded,
        ...statusProps(states),
      });
      expect(rows()).toBe(8);
      render({
        entries,
        installedStatusFilter: 'disabled',
        onInstalledExpandedChange: onExpanded,
        ...statusProps(states),
      });
      expect(rows()).toBe(10);
      expect(onExpanded).toHaveBeenCalledWith(true);
    });

    it('expands a collapsed Installed section when the status filter changes', () => {
      const entries = Array.from({ length: 10 }, (_unused, index) =>
        entry(`skill-${index}`),
      );
      const states: Record<string, InstalledEntryStatusState> = {};
      for (const row of entries) states[row.id] = ready('disabled');
      const rows = (): number =>
        container.querySelectorAll(
          '[data-testid="customize-section-installed-rows"] > li',
        ).length;
      const onExpanded = jest.fn();
      render({
        entries,
        installedStatusFilter: 'active',
        onInstalledExpandedChange: onExpanded,
        ...statusProps(states),
      });
      expect(rows()).toBe(0);
      render({
        entries,
        installedStatusFilter: 'disabled',
        onInstalledExpandedChange: onExpanded,
        ...statusProps(states),
      });
      expect(rows()).toBe(10);
      expect(onExpanded).toHaveBeenCalledWith(true);
    });

    it('ignores a stale filter on tabs without statuses', () => {
      render({
        tab: 'agent',
        agentsAvailable: true,
        entries: [
          entry('agent-1', {
            kind: 'agent',
            ref: { type: 'local-agent', agentId: 'agent-1' },
          }),
        ],
        installedStatusFilter: 'active',
      });
      expect(q('customize-row-agent-1')).not.toBeNull();
      expect(q('customize-installed-empty')).toBeNull();
    });
  });

  describe('CAN-3653 — a plugin-bundled server row', () => {
    const bundled = entry('mcp-local:slack', {
      kind: 'app',
      name: 'Slack',
      state: 'needs-auth',
      ref: { type: 'local-mcp', serverId: 'slack' },
      bundledBy: { entryId: 'mkt:openai-curated/slack', name: 'Slack' },
    });

    function menuLabels(id: string): string[] {
      act(() =>
        q('customize-section-installed')
          ?.querySelector<HTMLElement>(
            `[data-testid="customize-row-menu-${id}"]`,
          )
          ?.click(),
      );
      return Array.from(
        document.querySelectorAll(
          `[data-testid="customize-row-menu-${id}-surface"] [data-testid^="customize-row-menu-${id}-"]`,
        ),
      ).map((node) => node.textContent ?? '');
    }

    it('names its plugin and opens it from the row menu', () => {
      const opened: string[] = [];
      render({
        tab: 'app',
        entries: [bundled],
        onConnectEntry: () => {},
        onOpenEntryId: (id) => opened.push(id),
      });
      expect(q('customize-row-from-plugin-mcp-local:slack')?.textContent).toBe(
        'From the Slack plugin',
      );
      expect(menuLabels('mcp-local:slack')).toEqual([
        'Connect',
        'Open details',
        'Open the Slack plugin',
      ]);
      act(() =>
        document
          .querySelector<HTMLElement>(
            '[data-testid="customize-row-menu-mcp-local:slack-open-plugin"]',
          )
          ?.click(),
      );
      expect(opened).toEqual(['mkt:openai-curated/slack']);
    });

    it('offers no plugin item without a bundling plugin', () => {
      render({
        tab: 'app',
        entries: [{ ...bundled, bundledBy: undefined }],
        onOpenEntryId: () => {},
      });
      expect(menuLabels('mcp-local:slack')).toEqual(['Open details']);
    });
  });
  describe('CAN-4844 — a custom skill row', () => {
    const customSkill = entry('skill:custom:app:mine', {
      name: 'mine',
      custom: true,
      editedAt: '2026-10-10T12:00:00.000Z',
      ref: { type: 'skill', sourceId: 'custom:app', skillName: 'mine' },
    });
    const skillTarget: InstalledItemUninstallTarget = {
      kind: 'skill',
      sourceId: 'custom:app',
      skillName: 'mine',
    };
    const editItem = (): HTMLElement | null =>
      dq('customize-row-menu-skill:custom:app:mine-edit');

    afterEach(() => {
      mockClient = null;
    });

    function labels(id: string): (string | null)[] {
      return Array.from(
        document.querySelectorAll(
          `[data-testid="customize-row-menu-${id}-surface"] [data-testid^="customize-row-menu-${id}-"], [data-testid="customize-row-menu-${id}-surface"] [role="separator"]`,
        ),
      ).map((node) => node.textContent || node.getAttribute('role'));
    }

    it('shares the avatar badge and Updated subtitle without an inline icon or creator row', () => {
      render({ tab: 'skill', entries: [customSkill] });
      expect(q(`customize-row-creator-${customSkill.id}`)).toBeNull();
      expect(
        q(`customize-row-edited-${customSkill.id}`)?.textContent?.replace(
          /\s/g,
          ' ',
        ),
      ).toMatch(/^Updated \d+[smhd] ago$/);
      const marker = q(`customize-row-custom-${customSkill.id}`);
      expect(marker?.getAttribute('aria-label')).toBe('Custom skill');
      expect(
        q(`customize-row-name-line-${customSkill.id}`)?.contains(marker),
      ).toBe(false);
      expect(marker?.classList.contains('bg-fg-primary')).toBe(true);
    });

    it('offers Edit on a custom skill when the host can edit it', () => {
      mockClient = { capabilities: { customSkillEdit: true } };
      const onEditEntry = jest.fn();
      render({
        tab: 'skill',
        entries: [customSkill],
        onEditEntry,
        onShareEntry: () => {},
        entryShareStates: new Map([
          [customSkill.id, { status: 'shareable' as const }],
        ]),
        entryStatus: {
          states: {
            [customSkill.id]: {
              kind: 'ready',
              item: {
                target: skillTarget,
                status: 'active',
                removable: true,
                uninstallTarget: skillTarget,
                notices: [],
              },
              configurations: [],
            },
          },
          pendingKeys: new Set(),
          onUninstall: () => Promise.resolve({ ok: true, notices: [] }),
        },
      });
      openMenu('customize-section-installed', customSkill.id);
      expect(labels(customSkill.id)).toEqual([
        'Open details',
        'Share…',
        'Edit',
        'separator',
        'Delete…',
      ]);
      expect(editItem()?.getAttribute('aria-disabled')).toBeNull();
      act(() => editItem()?.click());
      expect(onEditEntry).toHaveBeenCalledWith(customSkill);
    });

    it.each([
      ['the host does not report the capability', { customSkillEdit: false }],
      ['the capability is unset', {}],
    ])('shows Edit disabled with a reason when %s', (_label, capabilities) => {
      mockClient = { capabilities };
      const onEditEntry = jest.fn();
      render({ tab: 'skill', entries: [customSkill], onEditEntry });
      openMenu('customize-section-installed', customSkill.id);
      expect(editItem()?.getAttribute('aria-disabled')).toBe('true');
      expect(editItem()?.getAttribute('title')).toBe(
        'Edit this skill in the desktop app.',
      );
      act(() => editItem()?.click());
      expect(onEditEntry).not.toHaveBeenCalled();
    });

    it('shows Edit disabled when the host reports the capability but passes no onEditEntry', () => {
      mockClient = { capabilities: { customSkillEdit: true } };
      render({ tab: 'skill', entries: [customSkill] });
      openMenu('customize-section-installed', customSkill.id);
      expect(editItem()?.getAttribute('aria-disabled')).toBe('true');
    });

    it('shows Edit disabled when no client provider is mounted', () => {
      mockClient = null;
      render({ tab: 'skill', entries: [customSkill], onEditEntry: jest.fn() });
      openMenu('customize-section-installed', customSkill.id);
      expect(editItem()?.getAttribute('aria-disabled')).toBe('true');
    });

    it('offers no Edit on a non-custom skill', () => {
      mockClient = { capabilities: { customSkillEdit: true } };
      render({
        tab: 'skill',
        entries: [entry('plain')],
        onEditEntry: jest.fn(),
      });
      openMenu('customize-section-installed', 'plain');
      expect(dq('customize-row-menu-plain-edit')).toBeNull();
    });
  });

  const pluginIds = ['mkt:openai-curated/slack', 'curated:slack'];
  describe.each(pluginIds)('CAN-4844 — bundled skill (%s)', (pluginId) => {
    const bundledSkill = entry(
      'plugin-skill:openai-curated/slack:summarize-channel',
      {
        name: 'summarize-channel',
        origin: 'marketplace',
        bundledBy: { entryId: pluginId, name: 'Slack' },
        ref: {
          type: 'plugin-skill',
          marketplaceId: 'openai-curated',
          pluginName: 'slack',
          skillName: 'summarize-channel',
        },
      },
    );
    const pluginTarget: InstalledItemUninstallTarget = {
      kind: 'plugin',
      marketplaceId: 'openai-curated',
      pluginName: 'slack',
    };

    function pluginState(
      status: 'active' | 'available' | 'disabled',
    ): InstalledEntryStatusState {
      return {
        kind: 'ready',
        item: {
          target: pluginTarget,
          status,
          removable: true,
          uninstallTarget: pluginTarget,
          notices: [],
        },
        configurations: [],
      };
    }

    function binding(
      states: Record<string, InstalledEntryStatusState>,
    ): PluginsEntryStatusBinding {
      return {
        states,
        pendingKeys: new Set(),
        onSetStatus: jest.fn(),
        onUninstall: jest.fn(() =>
          Promise.resolve<InstalledItemMutationOutcome>({
            ok: true,
            notices: [],
          }),
        ),
      };
    }

    function menuLabels(id: string): string[] {
      openMenu('customize-section-installed', id);
      return Array.from(
        document.querySelectorAll(
          `[data-testid="customize-row-menu-${id}-surface"] [data-testid^="customize-row-menu-${id}-"]`,
        ),
      ).map((node) => node.textContent ?? '');
    }

    it.each(['active', 'available', 'disabled'] as const)(
      'shows the parent %s status in a disabled, aligned control',
      (status) => {
        const entryStatus = binding({
          [pluginId]: pluginState(status),
          [bundledSkill.id]: pluginState(
            status === 'active' ? 'disabled' : 'active',
          ),
        });
        render({ tab: 'skill', entries: [bundledSkill], entryStatus });
        const control = q(`plugins-entry-status-${bundledSkill.id}`);
        expect(control?.getAttribute('data-status')).toBe(status);
        expect(control?.getAttribute('aria-disabled')).toBe('true');
        expect(control?.classList.contains('fg-disabled')).toBe(true);
        expect(
          control?.querySelector(`[data-status-dot="${status}"]`),
        ).not.toBeNull();
        expect(control?.querySelector('svg')).toBeNull();
        expect(
          control?.closest('[data-testid="customize-row-status-slot"]'),
        ).not.toBeNull();
        expect(control?.getAttribute('aria-haspopup')).toBeNull();
        const reason = 'Set by the Slack plugin. Change it on the plugin.';
        const descriptionId = control?.getAttribute('aria-describedby');
        expect(
          descriptionId && document.getElementById(descriptionId)?.textContent,
        ).toBe(reason);
        act(() => {
          control?.click();
        });
        expect(entryStatus.onSetStatus).not.toHaveBeenCalled();
        expect(q(`plugins-entry-status-${bundledSkill.id}-menu`)).toBeNull();
        act(() => {
          control?.parentElement?.dispatchEvent(
            new MouseEvent('mouseover', { bubbles: true }),
          );
        });
        expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
          reason,
        );
        expect(q(`customize-row-follows-${bundledSkill.id}`)).toBeNull();
      },
    );

    it('keeps Update icons beside inherited status and custom skill metadata', () => {
      const outdated = entry('outdated', { updateAvailable: true });
      const custom = entry('custom', {
        custom: true,
        authorName: 'Sergii',
        editedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      });
      render({
        tab: 'skill',
        entries: [bundledSkill, outdated, custom],
        supportedUpdateKinds: ['skill'],
        onUpdateEntry: jest.fn(() => Promise.resolve()),
        entryStatus: binding({
          [pluginId]: pluginState('disabled'),
          [outdated.id]: ready('available'),
        }),
      });
      for (const section of ['installed', 'updates']) {
        const update = q(`customize-section-${section}`)?.querySelector(
          '[data-testid="customize-update-outdated"]',
        );
        expect(update?.getAttribute('aria-label')).toBe('Update outdated');
        expect(update?.textContent).toBe('');
        expect(update?.querySelector('svg')).not.toBeNull();
      }
      const status = q(`plugins-entry-status-${bundledSkill.id}`);
      expect(status?.getAttribute('data-status')).toBe('disabled');
      expect(status?.getAttribute('aria-disabled')).toBe('true');
      const ring = status?.querySelector<HTMLElement>(
        '[data-status-dot="disabled"]',
      );
      expect(ring?.style.borderColor).toBe('var(--fg-tertiary)');
      expect(q(`customize-update-${bundledSkill.id}`)).toBeNull();
      expect(
        q(`customize-row-custom-${custom.id}`)?.getAttribute('aria-label'),
      ).toBe('Custom skill by Sergii');
      expect(
        q(`customize-row-edited-${custom.id}`)?.textContent?.replace(
          /\s/g,
          ' ',
        ),
      ).toBe('Updated 4h ago');
      expect(
        container.querySelector('[data-testid^="customize-row-update-"]'),
      ).toBeNull();
    });

    it('updates the existing child control when the canonical parent state changes', () => {
      const entries = [bundledSkill];
      render({
        tab: 'skill',
        entries,
        entryStatus: binding({ [pluginId]: pluginState('active') }),
      });
      const original = q(`plugins-entry-status-${bundledSkill.id}`);
      for (const status of ['disabled', 'available', 'active'] as const) {
        render({
          tab: 'skill',
          entries,
          entryStatus: binding({ [pluginId]: pluginState(status) }),
        });
        const control = q(`plugins-entry-status-${bundledSkill.id}`);
        expect(control).toBe(original);
        expect(control?.getAttribute('data-status')).toBe(status);
        expect(
          q(`customize-row-content-${bundledSkill.id}`)?.classList.contains(
            'opacity-60',
          ),
        ).toBe(status === 'disabled');
      }
    });

    it.each(['loading', 'read-only', 'null', 'missing'] as const)(
      'does not invent a parent status while it is %s',
      (kind) => {
        const readyState = pluginState('active');
        const state: InstalledEntryStatusState | undefined =
          kind === 'missing'
            ? undefined
            : kind === 'null' && readyState.kind === 'ready'
              ? { ...readyState, item: { ...readyState.item, status: null } }
              : kind === 'read-only'
                ? { kind: 'read-only', reason: 'Desktop unavailable' }
                : { kind: 'loading' };
        render({
          tab: 'skill',
          entries: [bundledSkill],
          entryStatus: binding(state ? { [pluginId]: state } : {}),
        });
        expect(q(`plugins-entry-status-${bundledSkill.id}`)).toBeNull();
        const fallback = q(
          `plugins-entry-status-${bundledSkill.id}-${kind === 'loading' ? 'loading' : 'unavailable'}`,
        );
        expect(fallback).not.toBeNull();
        expect(fallback?.hasAttribute('data-status')).toBe(false);
      },
    );

    it('offers Open details and Open the Slack plugin only', () => {
      const opened: string[] = [];
      render({
        tab: 'skill',
        entries: [bundledSkill],
        onOpenEntryId: (id) => opened.push(id),
        onShareEntry: () => {},
        entryShareStates: new Map([
          [bundledSkill.id, { status: 'shareable' as const }],
        ]),
        // The plugin is ready and removable; its skill must not offer that.
        entryStatus: binding({
          [pluginId]: pluginState('active'),
          [bundledSkill.id]: pluginState('active'),
        }),
      });
      expect(menuLabels(bundledSkill.id)).toEqual([
        'Open details',
        'Open the Slack plugin',
      ]);
      act(() =>
        dq(`customize-row-menu-${bundledSkill.id}-open-plugin`)?.click(),
      );
      expect(opened).toEqual([pluginId]);
    });

    it('shows the footnote only when a bundled skill is listed', () => {
      render({ tab: 'skill', entries: [bundledSkill, entry('plain')] });
      expect(q('customize-installed-footnote')?.textContent).toBe(
        "A skill that comes with a plugin follows that plugin's status.",
      );
      render({ tab: 'skill', entries: [entry('plain')] });
      expect(q('customize-installed-footnote')).toBeNull();
    });

    it('hides the footnote when no bundled skill is visible', () => {
      render({
        tab: 'skill',
        query: 'plain',
        entries: [bundledSkill, entry('plain')],
      });
      expect(q('customize-installed-footnote')).toBeNull();
    });

    it('filters and dims a bundled skill by its plugin status', () => {
      const entryStatus = binding({ [pluginId]: pluginState('disabled') });
      render({
        query: 'Slack',
        tab: 'skill',
        entries: [bundledSkill],
        entryStatus,
        installedStatusInventory: 'ready',
        installedStatusFilter: 'disabled',
      });
      expect(
        q(`customize-row-content-${bundledSkill.id}`)?.className,
      ).toContain('opacity-60');
      expect(q('customize-installed-footnote')).not.toBeNull();
      act(() => root.unmount());
      root = createRoot(container);
      render({
        tab: 'skill',
        entries: [bundledSkill],
        entryStatus,
        installedStatusInventory: 'ready',
        installedStatusFilter: 'active',
      });
      expect(q(`customize-row-${bundledSkill.id}`)).toBeNull();
      expect(q('customize-installed-footnote')).toBeNull();
    });

    it('keeps a bundled skill visible while its plugin status is unknown', () => {
      render({
        tab: 'skill',
        entries: [bundledSkill],
        entryStatus: binding({}),
        installedStatusInventory: 'ready',
        installedStatusFilter: 'active',
      });
      expect(q(`customize-row-${bundledSkill.id}`)).not.toBeNull();
      expect(
        q(`customize-row-content-${bundledSkill.id}`)?.className,
      ).not.toContain('opacity-60');
      expect(
        q(`plugins-entry-status-${bundledSkill.id}-unavailable`)?.getAttribute(
          'aria-disabled',
        ),
      ).toBe('true');
    });
  });
  describe('CAN-4845 — workflow rows', () => {
    const CAPABILITIES: CanopyCapabilities = {
      localExecution: true,
      terminalPty: true,
      fileSystemAccess: 'read-write',
      voice: true,
      settingsScope: 'full',
      pipelines: 'execute',
      routing: 'in-memory',
      overviewNotifications: true,
      automations: true,
      workflowManagement: true,
    };
    const automationRow = (
      enabled = true,
      overrides: Partial<UnifiedPluginEntry> = {},
    ): UnifiedPluginEntry =>
      entry('automation:local:triage', {
        kind: 'automation',
        name: 'Daily triage',
        typeLabel: 'Automation',
        workflow: { triggerText: 'Every day at 09:00', enabled, lastRun: null },
        ref: { type: 'automation', activityId: 'triage' },
        ...overrides,
      });
    const pipelineRow = (): UnifiedPluginEntry =>
      entry('pipeline:user:nightly', {
        kind: 'pipeline',
        name: 'Nightly build',
        typeLabel: 'Pipeline',
        workflow: { triggerText: 'Manual', runnable: true },
        ref: { type: 'pipeline', pipelineId: 'nightly', source: 'user' },
      });

    function actions(
      overrides: Partial<CustomizeWorkflowActions> = {},
    ): CustomizeWorkflowActions {
      return {
        capabilities: CAPABILITIES,
        onRun: jest.fn(),
        onSetEnabled: jest.fn(() => Promise.resolve()),
        onRunNow: jest.fn(() => Promise.resolve()),
        onEdit: jest.fn(),
        onViewRuns: jest.fn(),
        onDelete: jest.fn(() => Promise.resolve(null)),
        onActionError: jest.fn(),
        ...overrides,
      };
    }

    function openMenu(id: string): void {
      act(() =>
        q('customize-section-installed')
          ?.querySelector<HTMLElement>(
            `[data-testid="customize-row-menu-${id}"]`,
          )
          ?.click(),
      );
    }

    function menuLabels(id: string): (string | null)[] {
      openMenu(id);
      return Array.from(
        document.querySelectorAll(
          `[data-testid="customize-row-menu-${id}-surface"] [data-testid^="customize-row-menu-${id}-"], [data-testid="customize-row-menu-${id}-surface"] [role="separator"]`,
        ),
      ).map((node) => node.textContent || node.getAttribute('role'));
    }

    function menuItem(id: string, itemId: string): HTMLElement | null {
      return document.querySelector<HTMLElement>(
        `[data-testid="customize-row-menu-${id}-${itemId}"]`,
      );
    }

    async function flush(): Promise<void> {
      await act(async () => {
        await Promise.resolve();
      });
    }

    it('orders the workflow menu and puts Delete… after the divider', () => {
      const automation = automationRow(true, {
        updateAvailable: true,
        latestVersion: '2.1.0',
      });
      render({
        tab: 'workflow',
        entries: [automation, pipelineRow()],
        supportedUpdateKinds: ['automation'],
        onUpdateEntry: () => Promise.resolve(),
        onShareEntry: () => {},
        entryShareStates: new Map([
          [automation.id, { status: 'shareable' }],
          ['pipeline:user:nightly', { status: 'shareable' }],
        ]),
        workflowActions: actions(),
      });
      expect(menuLabels(automation.id)).toEqual([
        'Open details',
        'Update to v2.1.0',
        'Edit',
        'View runs',
        'Run now',
        'Share…',
        'separator',
        'Delete…',
      ]);
      act(() => document.body.click());
      expect(menuLabels('pipeline:user:nightly')).toEqual([
        'Open details',
        'Edit',
        'View runs',
        'Share…',
        'separator',
        'Delete…',
      ]);
    });

    it('keeps the switch on a local copy installed from a team share', async () => {
      const automation = automationRow(false, {
        id: 'automation:local:team-digest-copy',
        name: 'Team digest',
        workflow: {
          schedule: { label: 'Daily · 09:00', tooltip: 'Every day at 09:00' },
          sourceText: 'Shared by Platform',
          enabled: false,
          lastRun: null,
        },
        ref: { type: 'automation', activityId: 'team-digest-copy' },
      });
      const workflowActions = actions();
      render({ tab: 'workflow', entries: [automation], workflowActions });
      const toggle = q(
        `customize-installed-row-${automation.id}`,
      )?.querySelector<HTMLButtonElement>(
        `[data-testid="customize-workflow-toggle-${automation.id}"]`,
      );
      expect(toggle).toBeInstanceOf(HTMLButtonElement);
      expect(toggle?.disabled).toBe(false);
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      await act(async () => {
        toggle?.click();
        await Promise.resolve();
      });
      expect(workflowActions.onSetEnabled).toHaveBeenCalledWith(
        automation,
        true,
      );
    });

    it('turns an automation off and reports a failure without flipping it', async () => {
      const failure = deferred();
      const workflowActions = actions({
        onSetEnabled: jest.fn(() => failure.promise),
      });
      const automation = automationRow(true);
      render({ tab: 'workflow', entries: [automation], workflowActions });
      const toggle = (): HTMLButtonElement | null =>
        container.querySelector<HTMLButtonElement>(
          `[data-testid="customize-workflow-toggle-${automation.id}"]`,
        );
      act(() => toggle()?.click());
      expect(workflowActions.onSetEnabled).toHaveBeenCalledWith(
        automation,
        false,
      );
      expect(toggle()?.disabled).toBe(true);
      failure.reject(new Error('boom'));
      await flush();
      expect(workflowActions.onActionError).toHaveBeenCalledWith(
        "Couldn't turn off Daily triage",
      );
      expect(toggle()?.disabled).toBe(false);
      expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    });

    it('confirms Delete… and keeps the dialog open on a failure', async () => {
      const onDelete = jest
        .fn<Promise<string | null>, [UnifiedPluginEntry]>()
        .mockResolvedValueOnce('Nope')
        .mockResolvedValueOnce(null);
      const automation = automationRow();
      render({
        tab: 'workflow',
        entries: [automation],
        workflowActions: actions({ onDelete }),
      });
      openMenu(automation.id);
      act(() => menuItem(automation.id, 'delete')?.click());
      const dialog = (): HTMLElement | null =>
        document.querySelector<HTMLElement>(
          '[data-testid="customize-workflow-delete"]',
        );
      expect(dialog()?.textContent).toContain('Delete "Daily triage"?');
      expect(dialog()?.textContent).toContain('This cannot be undone.');
      const confirm = (): HTMLElement | null =>
        document.querySelector<HTMLElement>(
          '[data-testid="customize-workflow-delete-confirm"]',
        );
      expect(confirm()?.textContent).toBe('Delete');
      act(() => confirm()?.click());
      await flush();
      expect(onDelete).toHaveBeenCalledWith(automation);
      expect(dialog()?.textContent).toContain('Nope');
      act(() => confirm()?.click());
      await flush();
      expect(onDelete).toHaveBeenCalledTimes(2);
      expect(dialog()).toBeNull();
    });

    it('disables management on a host without it, with the reason', () => {
      const pipeline = pipelineRow();
      render({
        tab: 'workflow',
        entries: [pipeline],
        workflowActions: actions({
          capabilities: { ...CAPABILITIES, workflowManagement: undefined },
        }),
      });
      openMenu(pipeline.id);
      for (const itemId of ['edit', 'view-runs', 'delete']) {
        const item = menuItem(pipeline.id, itemId);
        expect(item?.getAttribute('aria-disabled')).toBe('true');
        expect(item?.getAttribute('title')).toBe(
          'Available in the desktop app',
        );
      }
    });

    it('shows the footnote only under a non-empty Workflows Installed list', () => {
      render({
        tab: 'workflow',
        entries: [pipelineRow()],
        workflowActions: actions(),
      });
      expect(q('customize-installed-footnote')?.textContent).toBe(
        WORKFLOW_INSTALLED_FOOTNOTE,
      );
      render({ tab: 'workflow', entries: [], installedExpanded: true });
      expect(q('customize-installed-footnote')).toBeNull();
      render({ tab: 'skill', entries: [entry('alpha')] });
      expect(q('customize-installed-footnote')).toBeNull();
    });

    it('adds no workflow controls or items without host actions', () => {
      const pipeline = pipelineRow();
      render({ tab: 'workflow', entries: [pipeline] });
      expect(q(`customize-workflow-run-${pipeline.id}`)).toBeNull();
      expect(menuLabels(pipeline.id)).toEqual(['Open details']);
    });

    it('keeps the row busy while a run is pending and reports a failure', async () => {
      const pending = deferred();
      const onRun = jest.fn(() => pending.promise);
      const workflowActions = actions({ onRun });
      const pipeline = pipelineRow();
      render({ tab: 'workflow', entries: [pipeline], workflowActions });
      const run = (): HTMLButtonElement | null =>
        container.querySelector<HTMLButtonElement>(
          `[data-testid="customize-workflow-run-${pipeline.id}"]`,
        );
      act(() => run()?.click());
      act(() => run()?.click());
      expect(onRun).toHaveBeenCalledTimes(1);
      expect(run()?.disabled).toBe(true);
      openMenu(pipeline.id);
      expect(
        menuItem(pipeline.id, 'delete')?.getAttribute('aria-disabled'),
      ).toBe('true');
      pending.reject(new Error('offline'));
      await flush();
      expect(workflowActions.onActionError).toHaveBeenCalledWith(
        "Couldn't start Nightly build",
      );
      expect(run()?.disabled).toBe(false);
    });

    it('keeps a skill row’s Update label', () => {
      render({
        tab: 'skill',
        entries: [updatable('outdated')],
        supportedUpdateKinds: ['skill'],
        onUpdateEntry: () => Promise.resolve(),
        workflowActions: actions(),
      });
      expect(menuLabels('outdated')).toEqual(['Open details', 'Update']);
    });
  });
});

/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  InstalledItemMutationResult,
  InstalledItemSnapshot,
  InstalledItemSnapshotEntry,
} from '@canopy/protocol/installed-items';
import {
  InstalledItemStatusIcon,
  InstalledItemStatusPicker,
} from '../InstalledItemStatusPicker';
import {
  InstalledItemStatusControl,
  InstalledItemStatusRow,
} from '../InstalledItemStatusRow';
import { UninstallConfirmDialog } from '../UninstallConfirmDialog';
import { DetailMoreItemsProvider } from '../DetailMoreMenu';
import {
  DetailActionBar,
  DetailActionSlotsProvider,
  useDetailActionSlots,
} from '../DetailActionBar';
import {
  ActiveItemsSummary,
  activeItemsSummaryText,
} from '../ActiveItemsSummary';
import { PluginsDiscoveryList } from '../PluginsDiscoveryList';
import {
  installedEntryStatusStates,
  PROVIDER_CONNECTED_STATUS_REASON,
  type InstalledItemStatusController,
  type InstalledItemStatusSource,
  installedItemStatusDescription,
} from '../../lib/installed-item-status';
import { useInstalledItemStatuses } from '../../lib/useInstalledItemStatuses';
import type { UnifiedPluginEntry } from '../../lib/unified-plugin-entry';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const activeRoots: Root[] = [];

function render(node: JSX.Element): Root {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push(root);
  act(() => {
    root.render(node);
  });
  return root;
}

function byTestId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`${id} not found`);
  return element;
}

function queryTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function describedBy(element: HTMLElement): string | null {
  const id = element.getAttribute('aria-describedby');
  return id ? (document.getElementById(id)?.textContent ?? null) : null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

it.each([false, true])(
  'keeps the Disabled ring at 8px with a 2px Available-colored stroke (read-only: %s)',
  (disabled) => {
    render(<InstalledItemStatusIcon status="disabled" disabled={disabled} />);
    const ring = document.querySelector<HTMLElement>(
      '[data-status-dot="disabled"]',
    );
    // Inline color must beat the unlayered universal border-color rule in the token stylesheet.
    expect(ring?.style.borderColor).toBe('var(--fg-tertiary)');
    expect(ring?.classList.contains('h-2')).toBe(true);
    expect(ring?.classList.contains('w-2')).toBe(true);
    expect(ring?.classList.contains('box-border')).toBe(true);
    expect(ring?.classList.contains('border-2')).toBe(true);
    expect(ring?.className).not.toContain('bg-');
  },
);

afterEach(() => {
  act(() => {
    while (activeRoots.length > 0) activeRoots.pop()?.unmount();
  });
  document.body.innerHTML = '';
});

const PLUGIN_ITEM: InstalledItemSnapshotEntry = {
  target: { kind: 'plugin', marketplaceId: 'market', pluginName: 'linter' },
  status: 'available',
  removable: true,
  uninstallTarget: {
    kind: 'plugin',
    marketplaceId: 'market',
    pluginName: 'linter',
  },
  removalScope: 'item',
  uninstallDescription:
    'Removes the provider installations, managed cache and saved selections.',
  notices: [],
};

function snapshot(
  ...items: InstalledItemSnapshotEntry[]
): InstalledItemSnapshot {
  return { items };
}

function mutation(
  next: InstalledItemSnapshot,
  overrides: Partial<InstalledItemMutationResult> = {},
): InstalledItemMutationResult {
  return {
    success: true,
    snapshot: next,
    removed: [],
    errors: [],
    ...overrides,
  };
}

function entry(overrides: Partial<UnifiedPluginEntry>): UnifiedPluginEntry {
  return {
    id: 'mkt:market/linter',
    kind: 'plugin',
    name: 'Linter',
    origin: 'marketplace',
    description: '',
    categories: [],
    components: { skills: 0, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: true, codex: true },
    recommended: false,
    state: 'installed',
    ref: {
      type: 'marketplace-plugin',
      marketplaceId: 'market',
      pluginName: 'Linter',
    },
    ...overrides,
  };
}

describe('InstalledItemStatusPicker', () => {
  it('lists the three statuses with exact copy and checks the current one', () => {
    const onChange = jest.fn();
    render(
      <InstalledItemStatusPicker
        itemName="Linter"
        status="active"
        onChange={onChange}
      />,
    );
    const trigger = byTestId('installed-item-status-picker');
    expect(trigger.getAttribute('aria-label')).toBe(
      'Status for Linter: Active',
    );
    act(() => trigger.click());
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    );
    expect(options.map((option) => option.textContent)).toEqual([
      'ActiveAdded to every new chat',
      'AvailableType / and the plugin name to use its skills',
      'DisabledInstalled, but turned off',
    ]);
    expect(
      options.map((option) => option.getAttribute('aria-checked')),
    ).toEqual(['true', 'false', 'false']);
    act(() => byTestId('installed-item-status-picker-option-disabled').click());
    expect(onChange).toHaveBeenCalledWith('disabled');
    expect(queryTestId('installed-item-status-picker-menu')).toBeNull();
  });

  it.each([
    ['skill', 'Type / and the skill name to use it'],
    ['plugin', 'Type / and the plugin name to use its skills'],
    ['collection', 'Loads when you or an agent need it'],
    ['mcp-server', 'Loads when you or an agent need it'],
    ['account-mcp', 'Loads when you or an agent need it'],
    ['mcp-config', 'Loads when you or an agent need it'],
  ] as const)(
    'describes Available for a %s by how it is reached',
    (targetKind, description) => {
      render(
        <InstalledItemStatusPicker
          itemName="Linter"
          status="active"
          targetKind={targetKind}
          onChange={jest.fn()}
        />,
      );
      act(() => byTestId('installed-item-status-picker').click());
      expect(
        byTestId('installed-item-status-picker-option-available').textContent,
      ).toBe(`Available${description}`);
      expect(
        byTestId('installed-item-status-picker-option-active').textContent,
      ).toBe('ActiveAdded to every new chat');
    },
  );

  it('keeps non-Available and kind-less descriptions unchanged', () => {
    expect(installedItemStatusDescription('available')).toBe(
      'Type / and the plugin name to use its skills',
    );
    for (const kind of ['skill', 'collection', undefined] as const) {
      expect(installedItemStatusDescription('active', kind)).toBe(
        'Added to every new chat',
      );
      expect(installedItemStatusDescription('disabled', kind)).toBe(
        'Installed, but turned off',
      );
    }
  });

  it('does not report reselecting the current status', () => {
    const onChange = jest.fn();
    render(
      <InstalledItemStatusPicker
        itemName="Linter"
        status="available"
        onChange={onChange}
      />,
    );
    act(() => byTestId('installed-item-status-picker').click());
    act(() =>
      byTestId('installed-item-status-picker-option-available').click(),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('stays focusable and names its reason when read-only', () => {
    render(
      <InstalledItemStatusPicker
        itemName="Linter"
        status="disabled"
        disabledReason="Update your desktop app to manage status."
      />,
    );
    const trigger = byTestId('installed-item-status-picker');
    expect(trigger.hasAttribute('disabled')).toBe(false);
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.textContent).toContain(
      'Update your desktop app to manage status.',
    );
    act(() => trigger.click());
    expect(queryTestId('installed-item-status-picker-menu')).toBeNull();
    // Disabled style, no chevron, and the reason as its description.
    expect(trigger.className).toContain('fg-disabled');
    expect(trigger.querySelectorAll('svg')).toHaveLength(0);
    expect(trigger.querySelectorAll('[data-status-dot]')).toHaveLength(1);
    expect(describedBy(trigger)).toBe(
      'Update your desktop app to manage status.',
    );
  });

  it('blocks a second change while busy', () => {
    render(
      <InstalledItemStatusPicker
        itemName="Linter"
        status="active"
        onChange={jest.fn()}
        busy
      />,
    );
    const trigger = byTestId('installed-item-status-picker');
    expect(trigger.getAttribute('aria-busy')).toBe('true');
    expect(trigger.hasAttribute('disabled')).toBe(true);
  });
});

describe('installedEntryStatusStates', () => {
  it('gives browse-only rows no status and resolves installed plugins case-insensitively', () => {
    const states = installedEntryStatusStates(
      [entry({}), entry({ id: 'browse', state: 'available' })],
      { kind: 'ready', snapshot: snapshot(PLUGIN_ITEM) },
    );
    expect(Object.keys(states)).toEqual(['mkt:market/linter']);
    const state = states['mkt:market/linter'];
    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') expect(state.item.status).toBe('available');
  });

  it('keeps a failed read distinct from Available', () => {
    const states = installedEntryStatusStates([entry({})], {
      kind: 'error',
      message: 'Status could not be loaded.',
    });
    expect(states['mkt:market/linter']).toEqual({
      kind: 'read-only',
      reason: 'Status could not be loaded.',
    });
  });

  it('collects every configuration of a device MCP server', () => {
    const work: InstalledItemSnapshotEntry = {
      target: { kind: 'mcp-config', serverId: 'linear', configId: 'work' },
      status: 'disabled',
      removable: false,
      notices: [],
    };
    const home: InstalledItemSnapshotEntry = {
      ...work,
      target: { kind: 'mcp-config', serverId: 'linear', configId: 'home' },
      status: 'active',
    };
    const server: InstalledItemSnapshotEntry = {
      target: { kind: 'mcp-server', serverId: 'linear' },
      status: 'active',
      removable: true,
      uninstallTarget: { kind: 'mcp-server', serverId: 'linear' },
      configurations: [
        { kind: 'mcp-config', serverId: 'linear', configId: 'work' },
        { kind: 'mcp-config', serverId: 'linear', configId: 'home' },
      ],
      notices: [],
    };
    const states = installedEntryStatusStates(
      [
        entry({
          id: 'mcp:linear',
          kind: 'app',
          ref: { type: 'local-mcp', serverId: 'linear' },
        }),
      ],
      { kind: 'ready', snapshot: snapshot(work, home, server) },
    );
    const state = states['mcp:linear'];
    if (state.kind !== 'ready') throw new Error('expected ready');
    expect(state.item.target).toEqual(server.target);
    expect(state.configurations.map((item) => item.status)).toEqual([
      'disabled',
      'active',
    ]);
  });
});

function HookProbe({
  source,
  onController,
}: {
  source: InstalledItemStatusSource | null;
  onController: (controller: InstalledItemStatusController) => void;
}): null {
  onController(useInstalledItemStatuses(source, 'Unsupported here.'));
  return null;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('useInstalledItemStatuses', () => {
  it('refetches after out-of-order mutations instead of reverting another item', async () => {
    const other = {
      ...PLUGIN_ITEM,
      target: { kind: 'plugin', marketplaceId: 'market', pluginName: 'other' },
    } satisfies InstalledItemSnapshotEntry;
    const initial = snapshot(PLUGIN_ITEM, other);
    const latest = snapshot(
      { ...PLUGIN_ITEM, status: 'active' },
      { ...other, status: 'disabled' },
    );
    const first = deferred<InstalledItemMutationResult>();
    const second = deferred<InstalledItemMutationResult>();
    const source: InstalledItemStatusSource = {
      listStatus: jest
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValue(latest),
      setStatus: jest
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
      uninstall: jest.fn(),
    };
    let controller: InstalledItemStatusController | undefined;
    render(
      <HookProbe
        source={source}
        onController={(next) => (controller = next)}
      />,
    );
    await flush();
    act(() => {
      void controller?.setStatus(PLUGIN_ITEM.target, 'active');
      void controller?.setStatus(other.target, 'disabled');
    });
    second.resolve(mutation(latest));
    await flush();
    first.resolve(
      mutation(snapshot({ ...PLUGIN_ITEM, status: 'active' }, other)),
    );
    await flush();
    expect(controller?.state).toEqual({ kind: 'ready', snapshot: latest });
  });
  it('ignores an old-host mutation after the source is replaced', async () => {
    const pending = deferred<InstalledItemMutationResult>();
    const first: InstalledItemStatusSource = {
      listStatus: () => Promise.resolve(snapshot(PLUGIN_ITEM)),
      setStatus: () => pending.promise,
      uninstall: jest.fn(),
    };
    const second: InstalledItemStatusSource = {
      listStatus: () =>
        Promise.resolve(snapshot({ ...PLUGIN_ITEM, status: 'active' })),
      setStatus: jest.fn(),
      uninstall: jest.fn(),
    };
    let controller: InstalledItemStatusController | undefined;
    const onController = (next: InstalledItemStatusController): void => {
      controller = next;
    };
    const root = render(
      <HookProbe source={first} onController={onController} />,
    );
    await flush();
    act(() => {
      void controller?.setStatus(PLUGIN_ITEM.target, 'disabled');
    });
    act(() =>
      root.render(<HookProbe source={second} onController={onController} />),
    );
    await flush();
    pending.resolve(mutation(snapshot({ ...PLUGIN_ITEM, status: 'disabled' })));
    await flush();
    const state = controller?.state;
    if (state?.kind !== 'ready') throw new Error('expected ready');
    expect(state.snapshot.items[0].status).toBe('active');
  });
  it('reports a completed uninstall after the consumer unmounts', async () => {
    // The removed item leaves the host's inventory before the mutation
    // response arrives, so the detail that started it unmounts first.
    const pending = deferred<InstalledItemMutationResult>();
    const source: InstalledItemStatusSource = {
      listStatus: () => Promise.resolve(snapshot(PLUGIN_ITEM)),
      setStatus: jest.fn(),
      uninstall: () => pending.promise,
    };
    let controller: InstalledItemStatusController | undefined;
    const root = render(
      <HookProbe
        source={source}
        onController={(next) => (controller = next)}
      />,
    );
    await flush();
    let outcome: Promise<unknown> | undefined;
    act(() => {
      outcome = controller?.uninstall({
        kind: 'plugin',
        marketplaceId: 'market',
        pluginName: 'linter',
      });
    });
    act(() => root.unmount());
    pending.resolve(mutation(snapshot()));
    await expect(outcome).resolves.toEqual({ ok: true, notices: [] });
  });
  it('drops a slow earlier read that resolves after a newer one', async () => {
    const first = deferred<InstalledItemSnapshot>();
    const second = deferred<InstalledItemSnapshot>();
    const reads = [first.promise, second.promise];
    let changed: () => void = () => undefined;
    const source: InstalledItemStatusSource = {
      listStatus: jest.fn(
        () => reads.shift() ?? Promise.reject(new Error('extra')),
      ),
      setStatus: jest.fn(),
      uninstall: jest.fn(),
      subscribe: (onChange) => {
        changed = onChange;
        return () => undefined;
      },
    };
    let controller: InstalledItemStatusController | undefined;
    render(
      <HookProbe
        source={source}
        onController={(next) => (controller = next)}
      />,
    );
    act(() => changed());
    second.resolve(snapshot({ ...PLUGIN_ITEM, status: 'disabled' }));
    await flush();
    first.resolve(snapshot({ ...PLUGIN_ITEM, status: 'active' }));
    await flush();
    const state = controller?.state;
    if (state?.kind !== 'ready') throw new Error('expected ready');
    expect(state.snapshot.items[0].status).toBe('disabled');
  });

  it('refetches the effective snapshot and reports structured failures', async () => {
    const effective = snapshot({
      ...PLUGIN_ITEM,
      status: 'disabled',
      notices: [
        {
          code: 'provider_pending',
          provider: 'claude',
          message: 'Claude may still load this plugin.',
          retryable: true,
        },
      ],
    });
    const source: InstalledItemStatusSource = {
      listStatus: jest
        .fn()
        .mockResolvedValueOnce(snapshot(PLUGIN_ITEM))
        .mockResolvedValue(effective),
      setStatus: jest.fn().mockResolvedValue(
        mutation(effective, {
          success: false,
          requestedStatus: 'disabled',
          errors: [
            {
              target: PLUGIN_ITEM.target,
              code: 'provider_failed',
              message: 'Claude did not apply the change.',
              retryable: true,
            },
          ],
        }),
      ),
      uninstall: jest.fn(),
    };
    let controller: InstalledItemStatusController | undefined;
    render(
      <HookProbe
        source={source}
        onController={(next) => (controller = next)}
      />,
    );
    await flush();
    let outcome:
      | Awaited<ReturnType<InstalledItemStatusController['setStatus']>>
      | undefined;
    await act(async () => {
      outcome = await controller?.setStatus(PLUGIN_ITEM.target, 'disabled');
    });
    expect(outcome?.ok).toBe(false);
    expect(outcome?.message).toBe('Claude did not apply the change.');
    expect(outcome?.notices).toHaveLength(1);
    const state = controller?.state;
    if (state?.kind !== 'ready') throw new Error('expected ready');
    expect(state.snapshot.items[0].status).toBe('disabled');
  });

  it('reports the unsupported reason without reading', () => {
    let controller: InstalledItemStatusController | undefined;
    render(
      <HookProbe source={null} onController={(next) => (controller = next)} />,
    );
    expect(controller?.state).toEqual({
      kind: 'unsupported',
      reason: 'Unsupported here.',
    });
  });
});

describe('InstalledItemStatusControl', () => {
  it('lets the current status retry a pending provider transition', async () => {
    const onSetStatus = jest.fn().mockResolvedValue({ ok: true, notices: [] });
    render(
      <InstalledItemStatusControl
        itemName="Linter"
        state={{
          kind: 'ready',
          item: {
            ...PLUGIN_ITEM,
            status: 'disabled',
            notices: [
              {
                code: 'provider_pending',
                message: 'Parking is still pending.',
                retryable: true,
              },
            ],
          },
          configurations: [],
        }}
        pendingKeys={new Set()}
        onSetStatus={onSetStatus}
        testId="retry-status"
      />,
    );
    act(() => byTestId('retry-status').click());
    act(() => byTestId('retry-status-option-disabled').click());
    await flush();
    expect(onSetStatus).toHaveBeenCalledWith(PLUGIN_ITEM.target, 'disabled');
  });
  it('shows loading and unavailable states instead of a picker', () => {
    render(
      <>
        <InstalledItemStatusControl
          itemName="Linter"
          state={{ kind: 'loading' }}
          pendingKeys={new Set()}
          testId="a"
        />
        <InstalledItemStatusControl
          itemName="Linter"
          state={{ kind: 'read-only', reason: 'Offline.' }}
          pendingKeys={new Set()}
          testId="b"
        />
      </>,
    );
    // The picker's capsule in skeleton, announced but carrying no visible text.
    expect(byTestId('a-loading').getAttribute('role')).toBe('status');
    expect(byTestId('a-loading').textContent).toBe('Loading status');
    expect(
      byTestId('a-loading').querySelector('.sr-only + [skullet-bar].h-7'),
    ).not.toBeNull();
    // An unreadable status keeps the picker's shape, disabled, with its
    // reason as the tooltip and accessible description.
    const unavailable = byTestId('b-unavailable');
    expect(unavailable.tagName).toBe('BUTTON');
    expect(unavailable.getAttribute('aria-disabled')).toBe('true');
    expect(unavailable.getAttribute('aria-label')).toBe(
      'Status for Linter: Unavailable',
    );
    expect(unavailable.className).toContain('fg-disabled');
    expect(describedBy(unavailable)).toBe('Offline.');
  });
});

describe('InstalledItemStatusRow', () => {
  // CAN-4261: the heading, current state and helper text read as one unit,
  // and the state is a clear dot, not a dashed circle.
  it('describes the current Available status for a standalone skill', () => {
    render(
      <InstalledItemStatusRow
        itemName="Review"
        state={{
          kind: 'ready',
          item: {
            ...PLUGIN_ITEM,
            target: { kind: 'skill', sourceId: 'source', skillName: 'review' },
          },
          configurations: [],
        }}
        pendingKeys={new Set()}
        onSetStatus={jest.fn()}
      />,
    );
    expect(byTestId('installed-item-status-row-description').textContent).toBe(
      'Type / and the skill name to use it',
    );
  });

  it('keeps Status, its control and the helper text on one row', () => {
    render(
      <InstalledItemStatusRow
        itemName="Linter"
        state={{ kind: 'ready', item: PLUGIN_ITEM, configurations: [] }}
        pendingKeys={new Set()}
        onSetStatus={jest.fn()}
      />,
    );
    const line = byTestId('installed-item-status-row-line');
    expect(line.querySelector('h3')?.textContent).toBe('Status');
    expect(
      line.querySelector('[data-testid="installed-item-status-row-picker"]'),
    ).not.toBeNull();
    expect(
      line.querySelector(
        '[data-testid="installed-item-status-row-description"]',
      )?.textContent,
    ).toBe('Type / and the plugin name to use its skills');
    const picker = byTestId('installed-item-status-row-picker');
    expect(picker.querySelector('[data-glyph="circle-dashed"]')).toBeNull();
    expect(
      picker.querySelector('[data-status-dot="available"]'),
    ).not.toBeNull();
  });

  it("lists the host's rows above Uninstall in one ⋯ menu (CAN-4842)", () => {
    const onUpdate = jest.fn();
    render(
      <DetailMoreItemsProvider
        items={[
          {
            id: 'update',
            label: 'Update',
            icon: null,
            testId: 'host-update',
            onSelect: onUpdate,
          },
        ]}
      >
        <InstalledItemStatusRow
          itemName="Linter"
          state={{ kind: 'ready', item: PLUGIN_ITEM, configurations: [] }}
          pendingKeys={new Set()}
          onSetStatus={jest.fn()}
          onUninstall={jest.fn()}
        />
      </DetailMoreItemsProvider>,
    );
    act(() => byTestId('installed-item-status-row-more').click());
    const menu = byTestId('installed-item-status-row-menu');
    const rows = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
      (row) => row.textContent,
    );
    expect(rows).toEqual(['Update', 'Uninstall…']);
    act(() => byTestId('host-update').click());
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('confirms uninstall with the backend description and keeps failures reviewable', async () => {
    const onUninstall = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        message: 'Codex removal failed.',
        notices: [],
      })
      .mockResolvedValueOnce({ ok: true, notices: [] });
    const onUninstalled = jest.fn();
    render(
      <InstalledItemStatusRow
        itemName="Linter"
        state={{ kind: 'ready', item: PLUGIN_ITEM, configurations: [] }}
        pendingKeys={new Set()}
        onSetStatus={jest.fn()}
        onUninstall={onUninstall}
        onUninstalled={onUninstalled}
      />,
    );
    act(() => byTestId('installed-item-status-row-more').click());
    const uninstall = byTestId('installed-item-status-row-uninstall');
    expect(uninstall.textContent).toBe('Uninstall…');
    expect(uninstall.getAttribute('role')).toBe('menuitem');
    act(() => uninstall.click());
    const dialog = byTestId('installed-item-status-row-uninstall-dialog');
    expect(dialog.textContent).toContain('Uninstall Linter?');
    expect(dialog.textContent).toContain(PLUGIN_ITEM.uninstallDescription);
    expect(document.activeElement).toBe(
      byTestId('installed-item-status-row-uninstall-cancel'),
    );
    act(() => byTestId('installed-item-status-row-uninstall-confirm').click());
    await flush();
    expect(byTestId('confirm-dialog-error').textContent).toBe(
      'Codex removal failed.',
    );
    expect(onUninstalled).not.toHaveBeenCalled();
    act(() => byTestId('installed-item-status-row-uninstall-confirm').click());
    await flush();
    expect(onUninstall).toHaveBeenCalledWith(PLUGIN_ITEM.uninstallTarget);
    expect(onUninstalled).toHaveBeenCalledTimes(1);
    expect(
      queryTestId('installed-item-status-row-uninstall-dialog'),
    ).toBeNull();
  });

  it('declares its More menu into the enclosing detail action bar', () => {
    function Shell(): JSX.Element {
      const slots = useDetailActionSlots();
      return (
        <>
          <div data-testid="shell-bar">
            <DetailActionBar
              slots={slots}
              secondary={<button data-testid="shell-edit">Edit</button>}
            />
          </div>
          <DetailActionSlotsProvider slots={slots}>
            <InstalledItemStatusRow
              itemName="Linter"
              state={{ kind: 'ready', item: PLUGIN_ITEM, configurations: [] }}
              pendingKeys={new Set()}
              onUninstall={jest.fn()}
            />
          </DetailActionSlotsProvider>
        </>
      );
    }
    render(<Shell />);
    const more = byTestId('installed-item-status-row-more');
    expect(byTestId('shell-bar').contains(more)).toBe(true);
    // The More menu leads the secondaries, even when it mounts after them.
    expect(byTestId('shell-edit').compareDocumentPosition(more)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
    expect(byTestId('installed-item-status-row').contains(more)).toBe(false);
  });

  it('explains a non-removable item instead of offering Uninstall', () => {
    render(
      <InstalledItemStatusRow
        itemName="Built-in"
        state={{
          kind: 'ready',
          item: {
            ...PLUGIN_ITEM,
            removable: false,
            uninstallTarget: undefined,
            reason: 'Built-in skills cannot be uninstalled.',
          },
          configurations: [],
        }}
        pendingKeys={new Set()}
        onUninstall={jest.fn()}
      />,
    );
    expect(queryTestId('installed-item-status-row-uninstall')).toBeNull();
    expect(
      byTestId('installed-item-status-row-not-removable').textContent,
    ).toBe('Built-in skills cannot be uninstalled.');
  });
});

describe('UninstallConfirmDialog', () => {
  it('ignores a repeated confirm while the removal is in flight', async () => {
    const pending = deferred<string | null>();
    const onConfirm = jest.fn(() => pending.promise);
    render(
      <UninstallConfirmDialog
        title="Uninstall Linter?"
        message="Removes it."
        onConfirm={onConfirm}
        onCancel={jest.fn()}
        onUninstalled={jest.fn()}
      />,
    );
    act(() => byTestId('uninstall-confirm-dialog-confirm').click());
    act(() => byTestId('uninstall-confirm-dialog-confirm').click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(byTestId('uninstall-confirm-dialog-confirm').textContent).toContain(
      'Uninstalling…',
    );
    pending.resolve(null);
    await flush();
  });

  it('keeps the Uninstall labels by default and takes custom ones', async () => {
    render(
      <UninstallConfirmDialog
        title="Uninstall Linter?"
        message="Removes it."
        onConfirm={() => Promise.resolve(null)}
        onCancel={jest.fn()}
        onUninstalled={jest.fn()}
      />,
    );
    expect(byTestId('uninstall-confirm-dialog-confirm').textContent).toBe(
      'Uninstall',
    );
    for (const root of activeRoots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = '';

    const pending = deferred<string | null>();
    render(
      <UninstallConfirmDialog
        title={'Delete "Nightly build"?'}
        message="This cannot be undone."
        confirmLabel="Delete"
        busyLabel="Deleting…"
        onConfirm={() => pending.promise}
        onCancel={jest.fn()}
        onUninstalled={jest.fn()}
      />,
    );
    expect(byTestId('uninstall-confirm-dialog-confirm').textContent).toBe(
      'Delete',
    );
    act(() => byTestId('uninstall-confirm-dialog-confirm').click());
    expect(byTestId('uninstall-confirm-dialog-confirm').textContent).toContain(
      'Deleting…',
    );
    pending.resolve(null);
    await flush();
  });
});

describe('activeItemsSummaryText', () => {
  it('uses numerals and singular forms, and nothing for zero', () => {
    expect(
      activeItemsSummaryText({
        plugins: 0,
        skills: 0,
        collections: 0,
        mcpServers: 0,
      }),
    ).toBeNull();
    expect(
      activeItemsSummaryText({
        plugins: 1,
        skills: 0,
        collections: 0,
        mcpServers: 0,
      }),
    ).toBe('1 plugin');
    expect(
      activeItemsSummaryText({
        plugins: 3,
        skills: 1,
        collections: 2,
        mcpServers: 2,
      }),
    ).toBe('3 plugins, 1 skill, 2 MCP servers and 2 collections');
  });
});

describe('PluginsDiscoveryList entry status', () => {
  it('shows the picker on installed cards only and routes changes to the item target', () => {
    const installed = entry({});
    const browse = entry({ id: 'browse', state: 'available' });
    const onSetStatus = jest.fn().mockResolvedValue({ ok: true, notices: [] });
    render(
      <PluginsDiscoveryList
        sections={[
          { id: 'installed', title: '', entries: [installed, browse] },
        ]}
        selectedEntryId={null}
        onSelectEntry={jest.fn()}
        emptyMessage="Empty"
        entryStatus={{
          states: installedEntryStatusStates([installed, browse], {
            kind: 'ready',
            snapshot: snapshot(PLUGIN_ITEM),
          }),
          pendingKeys: new Set(),
          onSetStatus,
        }}
      />,
    );
    expect(queryTestId('plugins-entry-status-browse')).toBeNull();
    act(() => byTestId(`plugins-entry-status-${installed.id}`).click());
    act(() =>
      byTestId(`plugins-entry-status-${installed.id}-option-active`).click(),
    );
    expect(onSetStatus).toHaveBeenCalledWith(PLUGIN_ITEM.target, 'active');
  });
  it('keeps one fixed status slot on every installed row and badges on one line', () => {
    const installed = entry({ connection: { status: 'connected' } });
    const pipeline = entry({
      id: 'pipeline:builtin',
      kind: 'pipeline',
      name: 'Code Review',
      ref: { type: 'pipeline', pipelineId: 'builtin', source: 'bundled' },
    });
    render(
      <PluginsDiscoveryList
        sections={[
          { id: 'installed', title: '', entries: [installed, pipeline] },
        ]}
        selectedEntryId={null}
        onSelectEntry={jest.fn()}
        emptyMessage="Empty"
        entryStatus={{
          states: installedEntryStatusStates([installed, pipeline], {
            kind: 'ready',
            snapshot: snapshot(PLUGIN_ITEM),
          }),
          pendingKeys: new Set(),
          onSetStatus: jest.fn(),
        }}
      />,
    );
    const pickerSlot = byTestId(
      `plugins-entry-status-${installed.id}`,
    ).parentElement;
    expect(pickerSlot?.className).toContain('w-36');
    expect(pickerSlot?.className).toContain('justify-end');
    // CAN-4847: workflows without a binding keep their status slot empty.
    expect(queryTestId('plugins-entry-status-pipeline:builtin')).toBeNull();
    const pipelineRow = byTestId('customize-discovery-row-pipeline:builtin');
    expect(pipelineRow.querySelector('.w-36')).not.toBeNull();
    expect(
      byTestId(`plugins-connection-status-${installed.id}`).textContent,
    ).toBe('Connected');
  });
});

test('summary uses a singular verb for one active item', () => {
  render(
    <ActiveItemsSummary
      state={{
        kind: 'ready',
        counts: { plugins: 1, skills: 0, collections: 0, mcpServers: 0 },
      }}
      onManage={() => undefined}
    />,
  );
  expect(byTestId('active-items-summary-counts').textContent).toBe(
    '1 plugin is active.',
  );
});

test('curated integration rows resolve the actual installed device identity', () => {
  const states = installedEntryStatusStates(
    [
      entry({
        id: 'curated-mcp:example',
        state: 'installed',
        ref: { type: 'curated-mcp', key: 'example' },
        integration: {
          curatedKey: 'example',
          connections: [
            {
              serverId: 'real-id',
              name: 'Example',
              binding: 'device',
              state: 'installed',
            },
          ],
        },
      }),
    ],
    {
      kind: 'ready',
      snapshot: snapshot({
        target: { kind: 'mcp-server', serverId: 'real-id' },
        status: 'disabled',
        removable: true,
        notices: [],
      }),
    },
  );
  expect(states['curated-mcp:example']).toMatchObject({
    kind: 'ready',
    item: {
      target: { kind: 'mcp-server', serverId: 'real-id' },
      status: 'disabled',
    },
  });
});

test('a removed catalog row retains its pending-uninstall controls after restart', () => {
  const candidate = entry({
    id: 'pending',
    state: 'available',
    ref: {
      type: 'marketplace-plugin',
      marketplaceId: 'market',
      pluginName: 'linter',
    },
  });
  const states = installedEntryStatusStates([candidate], {
    kind: 'ready',
    snapshot: snapshot({
      ...PLUGIN_ITEM,
      status: null,
      notices: [
        {
          code: 'partial_removal',
          message: 'Uninstall is still pending.',
          retryable: true,
        },
      ],
    }),
  });
  expect(states.pending).toMatchObject({
    kind: 'ready',
    item: { status: null },
  });
});

describe('CAN-5272 provider-connected MCP status', () => {
  type Connection = NonNullable<
    UnifiedPluginEntry['integration']
  >['connections'][number];
  const provider = (
    name = 'Claude account',
    state: Connection['state'] = 'installed',
  ): Connection => ({ serverId: 'gmail', name, binding: 'provider', state });
  const device: Connection = {
    serverId: 'gmail-device',
    name: 'Gmail',
    binding: 'device',
    state: 'installed',
  };
  const account: Connection = {
    serverId: 'gmail-account',
    name: 'Gmail',
    binding: 'account',
    state: 'installed',
    accountConnectionId: 'conn-1',
  };
  const gmail = (
    connections: readonly Connection[],
    overrides: Partial<UnifiedPluginEntry> = {},
  ): UnifiedPluginEntry =>
    entry({
      id: 'curated-mcp:gmail',
      kind: 'app',
      name: 'Gmail',
      state: 'installed',
      ref: { type: 'curated-mcp', key: 'gmail' },
      integration: { curatedKey: 'gmail', connections },
      ...overrides,
    });
  const DEVICE_ITEM: InstalledItemSnapshotEntry = {
    target: { kind: 'mcp-server', serverId: 'gmail-device' },
    status: 'available',
    removable: true,
    notices: [],
  };
  const reads = {
    ready: { kind: 'ready', snapshot: snapshot() },
    loading: { kind: 'loading' },
    error: { kind: 'error', message: 'Desktop is offline.' },
    unsupported: { kind: 'unsupported', reason: 'Pair a desktop.' },
  } as const;

  it.each(Object.keys(reads) as (keyof typeof reads)[])(
    'resolves established provider-only connections as Active under a %s read',
    (read) => {
      for (const connections of [
        [provider()],
        [provider(), provider('Codex account')],
      ]) {
        const states = installedEntryStatusStates(
          [gmail(connections)],
          reads[read],
        );
        expect(states['curated-mcp:gmail']).toMatchObject({
          kind: 'fixed',
          status: 'active',
        });
      }
    },
  );

  it('keeps the existing resolution without qualifying provider connections', () => {
    const read = reads.error;
    for (const candidate of [
      gmail([]),
      gmail([provider('Claude account', 'needs-auth')]),
      gmail([provider('Claude account', 'available')]),
      gmail([provider(), device]),
      gmail([provider(), account]),
      gmail([provider()], {
        id: 'local-mcp:gmail',
        ref: { type: 'local-mcp', serverId: 'gmail' },
      }),
    ]) {
      expect(
        installedEntryStatusStates([candidate], read)[candidate.id],
      ).toEqual({ kind: 'read-only', reason: 'Desktop is offline.' });
    }
  });

  it('lets the device status win when provider and device connections mix', () => {
    const states = installedEntryStatusStates([gmail([provider(), device])], {
      kind: 'ready',
      snapshot: snapshot(DEVICE_ITEM),
    });
    expect(states['curated-mcp:gmail']).toMatchObject({
      kind: 'ready',
      item: { status: 'available' },
    });
  });

  it('keeps ambiguous multiple device bindings unreadable beside a provider connection', () => {
    const secondDevice: Connection = { ...device, serverId: 'second-device' };
    const states = installedEntryStatusStates(
      [gmail([provider(), device, secondDevice])],
      {
        kind: 'ready',
        snapshot: snapshot(DEVICE_ITEM, {
          ...DEVICE_ITEM,
          target: { kind: 'mcp-server', serverId: 'second-device' },
          status: 'active',
        }),
      },
    );
    expect(states['curated-mcp:gmail']).toMatchObject({ kind: 'read-only' });
  });

  it('renders a provider-only row as a fixed Active control, not Unavailable', () => {
    const states = installedEntryStatusStates(
      [gmail([provider()])],
      reads.unsupported,
    );
    const onSetStatus = jest.fn();
    render(
      <InstalledItemStatusControl
        itemName="Gmail"
        state={states['curated-mcp:gmail']}
        pendingKeys={new Set()}
        onSetStatus={onSetStatus}
        testId="gmail"
      />,
    );
    expect(queryTestId('gmail-unavailable')).toBeNull();
    const trigger = byTestId('gmail');
    expect(trigger.textContent).toContain('Active');
    expect(trigger.getAttribute('data-status')).toBe('active');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.getAttribute('aria-label')).toBe('Status for Gmail: Active');
    expect(describedBy(trigger)).toBe(PROVIDER_CONNECTED_STATUS_REASON);
    act(() => trigger.click());
    act(() => {
      trigger.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(onSetStatus).not.toHaveBeenCalled();
  });

  it('renders the detail Status row as fixed Active without Uninstall', () => {
    const onSetStatus = jest.fn();
    render(
      <InstalledItemStatusRow
        itemName="Gmail"
        state={{
          kind: 'fixed',
          status: 'active',
          reason: PROVIDER_CONNECTED_STATUS_REASON,
        }}
        pendingKeys={new Set()}
        onSetStatus={onSetStatus}
        onUninstall={jest.fn()}
      />,
    );
    const picker = byTestId('installed-item-status-row-picker');
    expect(picker.getAttribute('data-status')).toBe('active');
    expect(picker.getAttribute('aria-disabled')).toBe('true');
    expect(describedBy(picker)).toBe(PROVIDER_CONNECTED_STATUS_REASON);
    expect(byTestId('installed-item-status-row-description').textContent).toBe(
      'Added to every new chat',
    );
    expect(queryTestId('installed-item-status-row-reason')).toBeNull();
    expect(queryTestId('installed-item-status-row-more')).toBeNull();
    act(() => picker.click());
    act(() => {
      for (const key of ['Enter', ' '])
        picker.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(onSetStatus).not.toHaveBeenCalled();
  });
});

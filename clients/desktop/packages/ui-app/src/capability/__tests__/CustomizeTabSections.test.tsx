/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UnifiedPluginEntry } from '@canopy/ui-shared/lib';
import {
  CustomizeTabSections,
  type CustomizeTabSectionsProps,
  type CustomizeUpdateFailure,
} from '../CustomizeTabSections';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

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

  it('labels installed catalog rows Installed in Browse and lists them in Installed', () => {
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
        '[data-testid="customize-section-browse"] [data-testid="plugins-entry-installed-catalog-alpha"]',
      ),
    ).not.toBeNull();
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
      menuExtensions: () => [
        {
          id: 'remove',
          label: 'Remove',
          onSelect: (): void => {},
          destructive: true,
        },
        { id: 'extra', label: 'Extra', onSelect: (): void => {} },
      ],
      entries: [updatable('outdated')].map((row) => ({
        ...row,
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
      'Update',
      'Share',
      'Extra',
      'separator',
      'Remove',
    ]);
  });
});

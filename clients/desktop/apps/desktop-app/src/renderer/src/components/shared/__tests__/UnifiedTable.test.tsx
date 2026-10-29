/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PluginInfo } from '@canopy/desktop-shared/types/plugins';
import type {
  SourceOption,
  UnifiedTableRow,
} from '../../../hooks/useUnifiedTableData';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { UnifiedTable } from '../UnifiedTable';
import { getUnifiedTableItemKey } from '../unified-table-virtualization';

function makePluginOriginal(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name: 'p',
    sourcePath: 'plugins/p',
    marketplaceId: 'mkt-1',
    providerSupport: { claude: 'native', codex: 'native' },
    facets: {},
    ...overrides,
  };
}

function makePluginRow(
  overrides: Partial<UnifiedTableRow> = {},
): UnifiedTableRow {
  const base: UnifiedTableRow = {
    rowOrigin: 'catalog',
    kind: 'plugin',
    key: 'mkt-1/p',
    name: 'p',
    description: '',
    source: 'acme/plugins',
    sourceSubtitle: 'Acme Plugins',
    sourceIcon: 'mixed',
    lastUpdated: '2026-05-01T00:00:00.000Z',
    original: makePluginOriginal(),
    providerSupport: { claude: 'native', codex: 'native' },
  };
  return { ...base, ...overrides } as UnifiedTableRow;
}

function requireCheckbox(
  node: Element | null,
  label: string,
): HTMLInputElement {
  if (!(node instanceof HTMLInputElement) || node.type !== 'checkbox') {
    throw new Error(`${label} not found or not a checkbox`);
  }
  return node;
}

describe('UnifiedTable provider scoping', () => {
  let container: HTMLElement;
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

  function render(
    rows: UnifiedTableRow[],
    selectedKeys: Set<string>,
    sourceOptions: SourceOption[] = [],
    loading = false,
  ): {
    onToggle: jest.Mock;
    onView: jest.Mock;
  } {
    const onToggle = jest.fn();
    const onView = jest.fn();
    act(() => {
      root.render(
        <UnifiedTable
          rows={rows}
          sourceOptions={sourceOptions}
          selectedKeys={selectedKeys}
          onToggle={onToggle}
          onView={onView}
          showBundleKind={true}
          loading={loading}
        />,
      );
    });
    return { onToggle, onView };
  }

  it('disables the checkbox for unsupported rows that are not currently selected', () => {
    render(
      [
        makePluginRow({
          toggleMode: 'unsupported',
          toggleReason: 'Only available for Codex',
        }),
      ],
      new Set(),
    );

    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][data-toggle-mode="unsupported"]',
      ),
      'Unsupported checkbox',
    );
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(false);
    expect(checkbox.getAttribute('aria-label')).toBe(
      'Select p (Only available for Codex)',
    );
  });

  it('keeps unsupported rows interactive while they remain checked so users can uncheck them', () => {
    const row = makePluginRow({
      toggleMode: 'unsupported',
      toggleReason: 'Only available for Codex',
    });
    const { onToggle } = render([row], new Set([row.key]));

    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][data-toggle-mode="unsupported"]',
      ),
      'Unsupported (checked) checkbox',
    );
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(true);
    expect(checkbox.getAttribute('aria-label')).toBe(
      'Select p (Only available for Codex)',
    );

    act(() => {
      checkbox.click();
    });
    expect(onToggle).toHaveBeenCalledWith(row.key);
  });

  it('still toggles normal plugin rows in mixed scope', () => {
    const row = makePluginRow();
    const { onToggle } = render([row], new Set());

    const checkbox = requireCheckbox(
      container.querySelector(
        'input[type="checkbox"][data-toggle-mode="normal"]',
      ),
      'Normal checkbox',
    );
    expect(checkbox.disabled).toBe(false);

    act(() => {
      checkbox.click();
    });
    expect(onToggle).toHaveBeenCalledWith(row.key);
  });

  it('renders both Claude and Codex source glyphs for sourceIcon=mixed', () => {
    render([makePluginRow({ sourceIcon: 'mixed' })], new Set());
    expect(
      container.querySelector('[data-testid="source-icon-mixed"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="source-icon-mixed-claude"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="source-icon-mixed-codex"]'),
    ).not.toBeNull();
  });

  it('renders provider support markers on plugin rows, including amber Codex compatibility', () => {
    render(
      [
        makePluginRow({
          providerSupport: { claude: 'native', codex: 'compat' },
        }),
      ],
      new Set(),
    );

    expect(
      container.querySelector('[data-testid="provider-support-icon-claude"]'),
    ).not.toBeNull();
    const compatIcon = container.querySelector(
      '[data-testid="provider-support-icon-codex-compat"]',
    );
    expect(compatIcon).not.toBeNull();
    expect(compatIcon?.getAttribute('data-tooltip')).toBe(
      'Generated from Claude plugin for Codex compatibility.',
    );
  });

  it('renders only the Codex source glyph for sourceIcon=codex', () => {
    render([makePluginRow({ sourceIcon: 'codex' })], new Set());
    expect(
      container.querySelector('[data-testid="source-icon-codex"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="source-icon-mixed"]'),
    ).toBeNull();
  });

  it('summarises selected plugins as "plugins" instead of "Claude plugins"', () => {
    const row1 = makePluginRow({ key: 'mkt/a', name: 'a' });
    const row2 = makePluginRow({ key: 'mkt/b', name: 'b' });
    render([row1, row2], new Set([row1.key, row2.key]));
    expect(
      container
        .querySelector('[data-testid="unified-table-selected-count"]')
        ?.textContent?.trim(),
    ).toBe('2');
    const selectedSegment = container.querySelector(
      '[data-testid="unified-table-filter-selected"]',
    );
    act(() => {
      selectedSegment?.dispatchEvent(
        new MouseEvent('mouseover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('2 plugins selected');
    expect(document.body.textContent).not.toMatch(/Claude plugin/);
  });

  it('blocks only the rows from session replay, keeping search and filters recorded', () => {
    render([makePluginRow({ key: 'mkt/p-0', name: 'p-000' })], new Set());

    // The recorder keeps a same-size placeholder for the rows and records
    // nothing inside them; the picker's controls and headers stay recorded.
    const body = container.querySelector('[data-testid="unified-table"] tbody');
    // ui-shared cannot import the instrumentation package; this pins its
    // literal to the recorder's `blockClass`.
    expect(body?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
    for (const selector of [
      'input[aria-label="Search by name"]',
      'select[aria-label="Kind filter"]',
      'thead',
    ]) {
      const element = container.querySelector(selector);
      expect(element).not.toBeNull();
      expect(element?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
    }
  });

  it('renders every row when the list stays under the windowing threshold', () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      makePluginRow({
        key: `mkt/p-${index}`,
        name: `p-${String(index).padStart(3, '0')}`,
      }),
    );
    render(rows, new Set());

    const table = container.querySelector('[data-testid="unified-table"]');
    expect(table?.getAttribute('data-virtualized')).toBe('false');
    expect(table?.getAttribute('data-row-count')).toBe('40');
    expect(container.querySelectorAll('tbody tr')).toHaveLength(40);
  });

  it('windows the body past the threshold while still reporting the filtered total', () => {
    const rows = Array.from({ length: 400 }, (_, index) =>
      makePluginRow({
        key: `mkt/p-${index}`,
        name: `p-${String(index).padStart(3, '0')}`,
      }),
    );
    render(rows, new Set());

    const table = container.querySelector('[data-testid="unified-table"]');
    expect(table?.getAttribute('data-virtualized')).toBe('true');
    // The logical count survives windowing; the mounted row count does not.
    expect(table?.getAttribute('data-row-count')).toBe('400');
    expect(
      container.querySelectorAll('tbody tr[data-index]').length,
    ).toBeLessThan(400);
  });

  it('keys virtualized items by row identity instead of filtered index', () => {
    const rows = [
      makePluginRow({ key: 'mkt/bravo', name: 'bravo' }),
      makePluginRow({ key: 'mkt/alpha', name: 'alpha' }),
    ];

    expect(getUnifiedTableItemKey(rows, 0)).toBe('mkt/bravo');
    expect(getUnifiedTableItemKey(rows, 1)).toBe('mkt/alpha');
  });

  it('sorts rows by name before filtering', () => {
    render(
      [
        makePluginRow({ key: 'mkt/c', name: 'charlie' }),
        makePluginRow({ key: 'mkt/a', name: 'alpha' }),
        makePluginRow({ key: 'mkt/b', name: 'bravo' }),
      ],
      new Set(),
    );

    const names = Array.from(
      container.querySelectorAll('tbody tr td:nth-child(2) span.font-medium'),
    ).map((node) => node.textContent);
    expect(names).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('shows loading while the backing row list is empty', () => {
    render([], new Set(), [], true);
    expect(container.textContent).toContain('Loading');
    expect(container.textContent).not.toContain('No items available.');
  });

  it('keeps filtered empty results visible during background loading', () => {
    render([makePluginRow({ name: 'alpha plugin' })], new Set(), [], true);

    const selectedFilter = container.querySelector<HTMLButtonElement>(
      '[data-testid="unified-table-filter-selected"]',
    );
    if (!selectedFilter) {
      throw new Error('Selected filter not found');
    }

    act(() => {
      selectedFilter.click();
    });

    expect(container.textContent).toContain(
      'No results match the current filters.',
    );
    expect(container.textContent).not.toContain('Loading');
  });
});

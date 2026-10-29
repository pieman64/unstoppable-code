/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LoadingIndicatorStyleProvider } from '../LoadingIndicatorStyle';
import { UnifiedTable, type UnifiedTableRow } from '../UnifiedTable';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function row(index: number): UnifiedTableRow {
  return {
    kind: 'plugin',
    key: `cloud/plugin-${String(index)}`,
    name: `Plugin ${String(index).padStart(3, '0')}`,
    description: 'Test plugin',
    source: 'Curated',
    sourceId: 'cloud-curated',
    sourceSubtitle: '',
    sourceIcon: 'mixed',
    lastUpdated: '2026-08-26T00:00:00.000Z',
    providerSupport: { claude: 'native', codex: 'native' },
  };
}

describe('UnifiedTable shared large-catalog path', () => {
  let container: HTMLDivElement;
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

  function render(
    rows: UnifiedTableRow[],
    options: {
      selectedKeys?: Set<string>;
      loading?: boolean;
      onToggle?: jest.Mock;
      spinnerStyle?: boolean;
    } = {},
  ): jest.Mock {
    const onToggle = options.onToggle ?? jest.fn();
    act(() => {
      root.render(
        <LoadingIndicatorStyleProvider
          value={options.spinnerStyle === true ? 'spinner' : 'text'}
        >
          <UnifiedTable
            rows={rows}
            sourceOptions={[
              { value: 'cloud-curated', label: 'Curated', icon: 'marketplace' },
            ]}
            selectedKeys={options.selectedKeys ?? new Set()}
            onToggle={onToggle}
            onView={() => undefined}
            showCollectionKind={false}
            loading={options.loading}
          />
        </LoadingIndicatorStyleProvider>,
      );
    });
    return onToggle;
  }

  it('lists source filter option names and subtitles', () => {
    act(() => {
      root.render(
        <UnifiedTable
          rows={[row(0)]}
          sourceOptions={[
            {
              value: 'github:acme/private-market',
              label: 'acme/private-market',
              subtitle: 'github.com/acme/private-market',
              icon: 'marketplace',
            },
          ]}
          selectedKeys={new Set()}
          onToggle={jest.fn()}
          onView={() => undefined}
          showCollectionKind={false}
        />,
      );
    });
    const trigger = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('All sources'),
    );
    expect(trigger).toBeDefined();
    act(() => trigger?.click());
    const label = Array.from(document.body.querySelectorAll('span')).find(
      (span) => span.textContent === 'acme/private-market',
    );
    const subtitle = Array.from(document.body.querySelectorAll('span')).find(
      (span) => span.textContent === 'github.com/acme/private-market',
    );
    expect(label).toBeDefined();
    expect(subtitle).toBeDefined();
  });

  it('reveals plugin members without changing its selection', () => {
    const onToggle = render([
      {
        ...row(0),
        members: [
          {
            name: 'Create ticket',
            description: 'Create an issue in a project',
            kind: 'Skill',
          },
        ],
      },
    ]);
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="plugin-members-toggle"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector('[aria-label="Plugin 000 capabilities"]')
        ?.textContent,
    ).toContain('Create ticket');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('uses a scope-neutral caption for selected plugins', () => {
    render([{ ...row(0), members: [] }], {
      selectedKeys: new Set([row(0).key]),
    });
    const caption = container.querySelector('tbody td:nth-child(2) > p');
    expect(caption?.textContent).toBe('Selected');
  });

  it('renders and sorts every row below the virtualization threshold', () => {
    render([
      { ...row(2), name: 'Charlie' },
      { ...row(0), name: 'Alpha' },
      { ...row(1), name: 'Bravo' },
    ]);

    const table = container.querySelector('[data-testid="unified-table"]');
    expect(table?.getAttribute('data-virtualized')).toBe('false');
    expect(table?.getAttribute('data-row-count')).toBe('3');
    const names = Array.from(
      container.querySelectorAll('tbody tr td:nth-child(2) span.font-medium'),
    ).map((node) => node.textContent);
    expect(names).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('retains member expansion when a row is temporarily unmounted', () => {
    const plugin = {
      ...row(0),
      members: [
        {
          name: 'Create ticket',
          description: 'Create an issue',
          kind: 'Skill',
        },
      ],
    };
    render([plugin]);
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="plugin-members-toggle"]',
        )
        ?.click(),
    );
    render([]);
    render([plugin]);
    expect(
      container
        .querySelector('[data-testid="plugin-members-toggle"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('filters by deferred name and kind', async () => {
    render(
      [
        row(0),
        {
          ...row(1),
          kind: 'skill',
          name: 'Writing helper',
          source: 'My skills',
          sourceId: 'cloud-custom',
          sourceIcon: 'repo',
          providerSupport: undefined,
        },
      ],
      { selectedKeys: new Set(['cloud/plugin-0']) },
    );

    const search = container.querySelector<HTMLInputElement>(
      '[aria-label="Search by name"]',
    );
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.bind(search);
    await act(async () => {
      if (!search || !valueSetter) throw new Error('Search input missing');
      valueSetter('writing');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      container
        .querySelector('[data-testid="unified-table"]')
        ?.getAttribute('data-row-count'),
    ).toBe('1');

    const kind = container.querySelector<HTMLSelectElement>(
      '[aria-label="Kind filter"]',
    );
    act(() => {
      if (!kind) throw new Error('Kind filter missing');
      kind.value = 'plugin';
      kind.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain(
      'No results match the current filters.',
    );
  });

  it('offers one MCP server kind, never a separate App kind (REG-3033)', () => {
    // The portal picker produced `kind: 'app'` for mcp-server refs while the
    // desktop produced `kind: 'mcp'` for the same servers, so the dropdown
    // showed "App" and "MCP server" as two kinds for one concept.
    render([row(0), { ...row(1), kind: 'mcp', key: 'srv/default' }]);
    const kind = container.querySelector<HTMLSelectElement>(
      '[aria-label="Kind filter"]',
    );
    const labels = Array.from(kind?.options ?? []).map(
      (option) => option.textContent,
    );
    expect(labels).toEqual(['All kinds', 'Skill', 'Plugin', 'MCP server']);
    expect(labels).not.toContain('App');
    act(() => {
      if (!kind) throw new Error('Kind filter missing');
      kind.value = 'mcp';
      kind.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(
      container
        .querySelector('[data-testid="unified-table"]')
        ?.getAttribute('data-row-count'),
    ).toBe('1');
  });

  it('filters selected and unselected rows without changing row identity', () => {
    const rows = [row(0), row(1)];
    render(rows, { selectedKeys: new Set(['cloud/plugin-0']) });
    const segment = (testId: string): HTMLButtonElement => {
      const button = container.querySelector<HTMLButtonElement>(
        `[role="group"][aria-label="Selection filter"] [data-testid="${testId}"]`,
      );
      if (!button) throw new Error(`${testId} missing`);
      return button;
    };
    act(() => {
      segment('unified-table-filter-selected').click();
    });
    expect(
      container
        .querySelector('[data-testid="unified-table"]')
        ?.getAttribute('data-row-count'),
    ).toBe('1');
    expect(container.textContent).toContain('Plugin 000');

    act(() => {
      segment('unified-table-filter-not-selected').click();
    });
    expect(container.textContent).toContain('Plugin 001');
    expect(container.textContent).not.toContain('Plugin 000');
  });

  it('preserves unsupported-selection removal and provider badges', () => {
    const unsupported = {
      ...row(0),
      toggleMode: 'unsupported' as const,
      toggleReason: 'Only available for Codex',
      providerSupport: { claude: 'native' as const, codex: 'compat' as const },
    };
    const onToggle = render([unsupported], {
      selectedKeys: new Set([unsupported.key]),
    });
    const checkbox = container.querySelector<HTMLInputElement>(
      'input[data-toggle-mode="unsupported"]',
    );
    expect(checkbox?.disabled).toBe(false);
    expect(
      container.querySelector('[data-testid="provider-support-icon-claude"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="provider-support-icon-codex-compat"]',
      ),
    ).not.toBeNull();
    act(() => checkbox?.click());
    expect(onToggle).toHaveBeenCalledWith(unsupported.key);
  });

  it('shows loading only when the backing row list is empty', () => {
    render([], { loading: true });
    expect(container.textContent).toContain('Loading…');
    expect(container.querySelector('[aria-label="Loading"]')).toBeNull();
    expect(container.textContent).not.toContain('No items available.');
  });

  it('shows a spinner for loading under the spinner style', () => {
    render([], { loading: true, spinnerStyle: true });
    expect(container.querySelector('[aria-label="Loading"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Loading…');
    expect(container.textContent).not.toContain('No items available.');
  });

  it('windows large catalogs and reports the logical row count', () => {
    render(Array.from({ length: 400 }, (_, index) => row(index)));

    const table = container.querySelector('[data-testid="unified-table"]');
    expect(table?.getAttribute('data-virtualized')).toBe('true');
    expect(table?.getAttribute('data-row-count')).toBe('400');
    expect(
      container.querySelectorAll('tbody tr[data-index]').length,
    ).toBeLessThan(400);
  });
});

describe('UnifiedTable rows that are not selectable', () => {
  let container: HTMLDivElement;
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

  function renderRow(
    overrides: Pick<UnifiedTableRow, 'toggleMode'>,
  ): HTMLInputElement {
    const subject: UnifiedTableRow = { ...row(1), ...overrides };
    act(() => {
      root.render(
        <UnifiedTable
          rows={[subject]}
          sourceOptions={[]}
          selectedKeys={new Set()}
          onToggle={() => undefined}
          onView={() => undefined}
          showCollectionKind={false}
        />,
      );
    });
    const box = container.querySelector('tbody input[type="checkbox"]');
    if (!(box instanceof HTMLInputElement)) {
      throw new Error('no row checkbox rendered');
    }
    return box;
  }

  it('renders a disabled row unchecked', () => {
    // `checked={locked || checked}`, so `locked` asserts the capability is
    // active. A provider connector nobody has linked must not claim one — a
    // ticked box for an account that was never connected is the same false
    // claim the connector work exists to remove.
    const box = renderRow({ toggleMode: 'disabled' });
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
  });

  it('renders a locked row checked, because locked means it is active', () => {
    const box = renderRow({ toggleMode: 'locked' });
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(true);
  });

  it('renders the source cell only when the row supplies a source', () => {
    // The subtitle is dead without it, which silently swallowed the one line
    // explaining where a connector is managed.
    act(() => {
      root.render(
        <UnifiedTable
          rows={[
            { ...row(1), source: '', sourceSubtitle: 'Linked' },
            { ...row(2), source: 'Claude account', sourceSubtitle: 'Linked' },
          ]}
          sourceOptions={[]}
          selectedKeys={new Set()}
          onToggle={() => undefined}
          onView={() => undefined}
          showCollectionKind={false}
        />,
      );
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Claude account');
    // The subtitle appears once — for the row that supplied a source.
    expect(text.split('Linked').length - 1).toBe(1);
  });

  it('keeps the checkbox beside a row action, so setup does not block selection', () => {
    const onToggle = jest.fn();
    act(() => {
      root.render(
        <UnifiedTable
          rows={[
            {
              ...row(1),
              rowAction: (
                <button type="button" data-testid="row-connect">
                  Connect
                </button>
              ),
            },
          ]}
          sourceOptions={[]}
          selectedKeys={new Set()}
          onToggle={onToggle}
          onView={() => undefined}
          showCollectionKind={false}
        />,
      );
    });
    const action = container.querySelector('[data-testid="row-connect"]');
    expect(action).not.toBeNull();
    const box = container.querySelector('tbody input[type="checkbox"]');
    if (!(box instanceof HTMLInputElement)) {
      throw new Error('no row checkbox rendered');
    }
    expect(box.disabled).toBe(false);
    act(() => box.click());
    expect(onToggle).toHaveBeenCalledWith('cloud/plugin-1');
    // The action lives in the trailing cell, apart from the selection cell.
    expect(action?.closest('td')?.contains(box)).toBe(false);
  });
});

describe('rows that are checked to state a fact', () => {
  let container: HTMLDivElement;
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

  it('are not counted in the selection summary', () => {
    // A capability linked on the user's provider account renders checked so
    // the box tells the truth, and sits in `selectedKeys` so the Selected
    // filter finds it — but it is account-level, is never written to any saved
    // configuration, and the user never chose it. Counting it reports a
    // selection they did not make and cannot undo.
    const connector: UnifiedTableRow = {
      ...row(1),
      kind: 'mcp',
      key: 'provider-account/gmail',
      name: 'Gmail',
      toggleMode: 'locked',
      excludeFromSelectionCount: true,
    };
    const chosen: UnifiedTableRow = { ...row(2), kind: 'mcp' };

    act(() => {
      root.render(
        <UnifiedTable
          rows={[connector, chosen]}
          sourceOptions={[]}
          selectedKeys={new Set([connector.key, chosen.key])}
          onToggle={() => undefined}
          onView={() => undefined}
          showCollectionKind={false}
        />,
      );
    });

    expect(
      container
        .querySelector('[data-testid="unified-table-selected-count"]')
        ?.textContent?.trim(),
    ).toBe('1');
    act(() => {
      container
        .querySelector('[data-testid="unified-table-filter-selected"]')
        ?.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
    });
    const summary =
      document.body.querySelector('[role="tooltip"]')?.textContent ?? '';
    expect(summary).toContain('1 MCP server selected');
    expect(summary).not.toContain('2 MCP servers selected');
  });
});

describe('UnifiedTable selection filter counts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function renderTable(
    selectedKeys: Set<string>,
    hideSelectionSummary = false,
  ): void {
    act(() => {
      root.render(
        <UnifiedTable
          rows={[row(0), row(1), row(2)]}
          sourceOptions={[]}
          selectedKeys={selectedKeys}
          onToggle={() => undefined}
          onView={() => undefined}
          showCollectionKind={false}
          hideSelectionSummary={hideSelectionSummary}
        />,
      );
    });
  }

  function segmentText(testId: string): string | undefined {
    return container
      .querySelector(`[data-testid="${testId}"]`)
      ?.textContent?.trim();
  }

  it('shows the total and selected counts on the filter segments', () => {
    renderTable(new Set([row(1).key]));

    expect(segmentText('unified-table-filter-all')).toBe('All 3');
    expect(segmentText('unified-table-filter-selected')).toBe('Selected 1');
    expect(segmentText('unified-table-filter-not-selected')).toBe(
      'Not selected',
    );
    expect(container.textContent).not.toContain('Nothing selected');
  });

  it('counts zero selections without a separate summary line', () => {
    renderTable(new Set());

    expect(segmentText('unified-table-selected-count')).toBe('0');
    expect(container.textContent).not.toContain('Nothing selected');
  });

  it('drops the counts when the host shows its own summary', () => {
    renderTable(new Set([row(0).key]), true);

    expect(segmentText('unified-table-filter-all')).toBe('All');
    expect(segmentText('unified-table-filter-selected')).toBe('Selected');
  });

  it('keeps descriptions to one line with the full text in a title', () => {
    renderTable(new Set());

    const description = Array.from(
      container.querySelectorAll<HTMLElement>('tbody span.truncate'),
    ).find((node) => node.textContent === row(0).description);
    expect(description?.getAttribute('title')).toBe(row(0).description);
  });
});

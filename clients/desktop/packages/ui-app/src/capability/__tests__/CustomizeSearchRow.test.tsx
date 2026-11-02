/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CustomizeSearchRow } from '../CustomizeSearchRow';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const search = {
  value: '',
  onChange: (): void => {},
  ariaLabel: 'Search',
  clearAriaLabel: 'Clear',
  testId: 'plugins-search',
  clearTestId: 'plugins-search-clear',
};

describe('CustomizeSearchRow (CAN-4838)', () => {
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

  function q(testId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  it.each(['all', 'plugin', 'app', 'skill', 'collection'] as const)(
    'shows the status dropdown on %s',
    (tab) => {
      act(() =>
        root.render(
          <CustomizeSearchRow
            tab={tab}
            search={search}
            installedStatusFilter={null}
            onInstalledStatusFilterChange={() => {}}
          />,
        ),
      );
      expect(q('plugins-search')).not.toBeNull();
      expect(q('customize-installed-status-filter')).not.toBeNull();
    },
  );

  it('lets the 32px search take the row and follows it with the quiet 28px dropdown', () => {
    act(() =>
      root.render(
        <CustomizeSearchRow
          tab="all"
          search={search}
          installedStatusFilter={null}
          onInstalledStatusFilterChange={() => {}}
        />,
      ),
    );
    const row = q('customize-search-row');
    const field = row?.firstElementChild;
    const filter = row?.lastElementChild?.firstElementChild;
    expect(row?.hasAttribute('data-page-search-row')).toBe(true);
    expect(field?.getAttribute('data-search-field')).toBe('md');
    expect(field?.className).toContain('flex-1');
    expect(field?.className).toContain('min-w-40');
    // The page-search width cap would leave the dropdown mid-row.
    expect(field?.className).not.toContain('max-w-md');
    expect(filter?.getAttribute('data-testid')).toBe(
      'customize-installed-status-filter',
    );
    expect(filter?.className).toContain('shrink-0');
    // The page row's quiet dropdown: 28px, small text, no resting fill.
    expect(filter?.className).toContain('h-7');
    expect(filter?.className).toContain('text-xs');
    expect(filter?.className).toContain('bg-transparent');
  });

  it.each(['workflow', 'agent', 'sources', 'blueprint'] as const)(
    'hides it on %s',
    (tab) => {
      act(() =>
        root.render(
          <CustomizeSearchRow
            tab={tab}
            search={search}
            installedStatusFilter={null}
            onInstalledStatusFilterChange={() => {}}
          />,
        ),
      );
      expect(q('plugins-search')).not.toBeNull();
      expect(q('customize-installed-status-filter')).toBeNull();
    },
  );

  it('renders the search alone without a change handler', () => {
    act(() => root.render(<CustomizeSearchRow tab="all" search={search} />));
    expect(q('customize-search-row')).not.toBeNull();
    expect(q('customize-installed-status-filter')).toBeNull();
  });

  it('reflects the applied value and forwards changes', () => {
    const onChange = jest.fn();
    act(() =>
      root.render(
        <CustomizeSearchRow
          tab="all"
          search={search}
          installedStatusFilter="disabled"
          onInstalledStatusFilterChange={onChange}
        />,
      ),
    );
    expect(
      q('customize-installed-status-filter')?.getAttribute('data-status'),
    ).toBe('disabled');
    act(() => q('customize-installed-status-filter')?.click());
    act(() => q('customize-installed-status-filter-option-available')?.click());
    expect(onChange).toHaveBeenCalledWith('available');
  });
});

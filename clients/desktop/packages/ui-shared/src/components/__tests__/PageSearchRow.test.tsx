/**
 * @jest-environment jsdom
 */
import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  FilterDropdown,
  PageSearchField,
  PageSearchFilters,
  PageSearchRow,
  SortDropdown,
  filterMenuLabel,
  pageFilter,
  type PageFilter,
} from '../PageSearchRow';
import { PickerTrigger } from '../PickerMenu';
import { SearchField } from '../SearchField';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const activeRoots: Root[] = [];

function render(node: JSX.Element): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push(root);
  act(() => {
    root.render(node);
  });
}

function byTestId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`${id} not found`);
  return element;
}

function queryTestId(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function click(element: HTMLElement): void {
  act(() => element.click());
}

afterEach(() => {
  for (const root of activeRoots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
});

type Color = 'red' | 'green' | 'blue';

const COLORS = [
  { value: 'red', label: 'Red', count: 2 },
  { value: 'green', label: 'Green', count: 1 },
  { value: 'blue', label: 'Blue' },
] as const;

function colorFilter(
  key: string,
  selected: readonly Color[],
  onToggle: (value: Color) => void = jest.fn(),
): PageFilter {
  return pageFilter<Color>({
    key,
    title: `Color ${key}`,
    anyLabel: 'Any color',
    options: COLORS,
    selected,
    onToggle,
    onClear: jest.fn(),
    testId: `filter-${key}`,
  });
}

describe('PageSearchRow', () => {
  it('fills the row with the 32px search on the subtle fill, never nesting controls', () => {
    render(
      <PageSearchRow testId="row" className="mt-4">
        <PageSearchField
          value="dig"
          onValueChange={jest.fn()}
          aria-label="Search workflows"
          fieldTestId="field"
          count="2 of 6"
        />
        <PageSearchFilters
          filters={[colorFilter('a', [])]}
          onClearAll={jest.fn()}
          testId="filter"
        />
      </PageSearchRow>,
    );
    const row = byTestId('row');
    expect(row.hasAttribute('data-page-search-row')).toBe(true);
    expect(row.className).toContain('mt-4');
    // On a narrow page the dropdowns wrap under the field rather than
    // squeezing it below 160px.
    expect(row.className).toContain('flex-wrap');
    const field = byTestId('field');
    expect(field.getAttribute('data-search-field')).toBe('md');
    expect(field.className).toContain('h-8');
    expect(field.className).toContain('bg-subtle');
    expect(field.className).toContain('text-xs');
    // The shared inset hairline at rest; focus swaps it for the field focus
    // edge and keeps the fill.
    expect(field.className).toContain('ring-line-base');
    expect(field.className).toContain('ring-inset');
    expect(field.className).toContain('has-[input:focus]:ring-0');
    expect(field.className).toContain('has-[input:focus]:shadow-field-focus');
    expect(field.className).not.toContain('has-[input:focus]:bg-');
    expect(field.className).toContain('flex-1');
    expect(field.className).toContain('min-w-40');
    expect(field.querySelector('[data-search-field-count]')?.textContent).toBe(
      '2 of 6',
    );
    // Clear is the 12px glyph in the page field.
    const clear = field.querySelector('button[aria-label="Clear search"] svg');
    expect(clear?.getAttribute('style')).toContain('width: 12px');
    // The filter follows the field; nothing nests in its end cap.
    expect(field.contains(byTestId('filter-a'))).toBe(false);
    expect(row.lastElementChild).toBe(byTestId('filter-a'));
  });

  it('keeps the 28px toolbar search transparent', () => {
    render(
      <SearchField
        value=""
        onValueChange={jest.fn()}
        aria-label="Search runs"
        fieldTestId="field"
      />,
    );
    expect(byTestId('field').className).toContain('bg-transparent');
    expect(byTestId('field').className).not.toContain('bg-subtle');
  });
});

describe('PickerTrigger page size', () => {
  it('is a quiet 28px capsule in the small text, filled only on hover or open', () => {
    render(
      <PickerTrigger size="page" labelOnly data-testid="trigger">
        Any status
      </PickerTrigger>,
    );
    const { className } = byTestId('trigger');
    // 12px before the label and 8px after the chevron.
    expect(className).toContain('pl-3');
    expect(className).toContain('pr-2 ');
    expect(className).not.toContain('pl-3.5');
    expect(className).toContain('aria-expanded:bg-subtle');
    expect(className).toContain('h-7');
    expect(className).toContain('text-xs');
    expect(className).toContain('bg-transparent');
    expect(className).toContain('hover:bg-subtle');
    expect(className).not.toContain('shadow-field');
  });

  it('keeps the toolbar capsule in the small text', () => {
    render(
      <PickerTrigger size="compact" data-testid="trigger">
        Levels
      </PickerTrigger>,
    );
    expect(byTestId('trigger').className).toContain('h-7');
    expect(byTestId('trigger').className).toContain('text-xs');
  });

  it('leaves a field trigger at its own text size', () => {
    render(
      <PickerTrigger variant="field" data-testid="trigger">
        main
      </PickerTrigger>,
    );
    expect(byTestId('trigger').className).toContain('text-s');
    expect(byTestId('trigger').className).not.toContain('text-xs');
  });
});

describe('FilterDropdown', () => {
  it('names what it keeps and reports picks and the any row', () => {
    const onToggle = jest.fn();
    const onClear = jest.fn();
    render(
      <FilterDropdown<Color>
        title="Color"
        label="Red"
        anyLabel="Any color"
        options={COLORS}
        selected={['red']}
        onToggle={onToggle}
        onClear={onClear}
        testId="color"
      />,
    );
    const trigger = byTestId('color');
    expect(trigger.textContent).toBe('Red');
    expect(trigger.getAttribute('aria-label')).toBe('Color: Red');
    expect(trigger.getAttribute('data-active')).toBe('true');
    expect(trigger.className).toContain('h-7');
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(byTestId('color-option-red').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(byTestId('color-option-red').textContent).toBe('Red2');
    // The sidebar's row-menu look: small text in every row.
    expect(byTestId('color-option-red').className).toContain('text-xs');
    click(byTestId('color-option-green'));
    expect(onToggle).toHaveBeenCalledWith('green');
    click(trigger);
    click(byTestId('color-any'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('blocks picked values from session replay and keeps them out of its name', () => {
    render(
      <FilterDropdown<string>
        title="Member"
        label="Ada Lovelace"
        anyLabel="All members"
        options={[{ value: 'ada', label: 'Ada Lovelace' }]}
        selected={['ada']}
        onToggle={jest.fn()}
        onClear={jest.fn()}
        testId="member"
        replayPrivacy={{ blockClassName: 'ph-no-capture' }}
      />,
    );
    const trigger = byTestId('member');
    expect(trigger.getAttribute('aria-label')).toBe('Member');
    expect(trigger.querySelector('.ph-no-capture')?.textContent).toBe(
      'Ada Lovelace',
    );
    click(trigger);
    expect(
      byTestId('member-option-ada').querySelector('.ph-no-capture')
        ?.textContent,
    ).toBe('Ada Lovelace');
  });
});

describe('PageSearchFilters', () => {
  it('keeps three filters inline as their own dropdowns', () => {
    render(
      <PageSearchFilters
        filters={[
          colorFilter('a', []),
          colorFilter('b', ['green']),
          colorFilter('c', ['red', 'blue']),
        ]}
        onClearAll={jest.fn()}
        testId="filter"
      />,
    );
    expect(queryTestId('filter')).toBeNull();
    expect(byTestId('filter-a').textContent).toBe('Any color');
    expect(byTestId('filter-b').textContent).toBe('Green');
    expect(byTestId('filter-c').textContent).toBe('Color c: 2');
  });

  it('puts more than three behind one Filter dropdown that counts the ones on', () => {
    const onToggle = jest.fn();
    const onClearAll = jest.fn();
    render(
      <PageSearchFilters
        filters={[
          colorFilter('a', [], onToggle),
          colorFilter('b', ['green']),
          colorFilter('c', ['red']),
          colorFilter('d', []),
        ]}
        onClearAll={onClearAll}
        testId="filter"
      />,
    );
    const trigger = byTestId('filter');
    expect(trigger.textContent).toBe('Filter · 2');
    expect(trigger.getAttribute('aria-label')).toBe('Filters: 2 on');
    expect(trigger.getAttribute('data-active')).toBe('true');
    // No filter shows as its own dropdown until the menu opens.
    expect(queryTestId('filter-a-menu')).toBeNull();
    click(trigger);
    // One row per filter (glyph, name, chevron); no flat list of every
    // value, and no value line under the name.
    expect(
      ['a', 'b', 'c', 'd'].map((key) => byTestId(`filter-${key}`).textContent),
    ).toEqual(['Color a', 'Color b', 'Color c', 'Color d']);
    expect(byTestId('filter-a').querySelector('svg')).not.toBeNull();
    expect(queryTestId('filter-a-option-blue')).toBeNull();
    expect(byTestId('filter-b').getAttribute('data-contains-selection')).toBe(
      'true',
    );
    // Each row opens its own submenu, one at a time.
    click(byTestId('filter-a'));
    expect(byTestId('filter-a-menu')).toBeTruthy();
    click(byTestId('filter-a-option-blue'));
    expect(onToggle).toHaveBeenCalledWith('blue');
    click(byTestId('filter-b'));
    expect(queryTestId('filter-a-menu')).toBeNull();
    expect(byTestId('filter-b-menu')).toBeTruthy();
    // The menu stays open for more picks, then clears every filter at once.
    click(byTestId('filter-clear'));
    expect(onClearAll).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it('says Filter with nothing on and offers nothing to clear', () => {
    render(
      <PageSearchFilters
        filters={['a', 'b', 'c', 'd'].map((key) => colorFilter(key, []))}
        onClearAll={jest.fn()}
        testId="filter"
      />,
    );
    expect(byTestId('filter').textContent).toBe('Filter');
    expect(byTestId('filter').getAttribute('data-active')).toBe('false');
    click(byTestId('filter'));
    expect(queryTestId('filter-clear')).toBeNull();
  });

  it('labels the Filter dropdown by its count', () => {
    expect(filterMenuLabel(0)).toBe('Filter');
    expect(filterMenuLabel(3)).toBe('Filter · 3');
  });
});

describe('SortDropdown', () => {
  function Sorted(): JSX.Element {
    const [value, setValue] = useState<'recent' | 'name'>('recent');
    return (
      <SortDropdown
        value={value}
        options={[
          { value: 'recent', label: 'Recently run' },
          { value: 'name', label: 'Name' },
        ]}
        onChange={setValue}
        testId="sort"
      />
    );
  }

  it('names the order and changes it', () => {
    render(<Sorted />);
    const trigger = byTestId('sort');
    expect(trigger.textContent).toBe('Sort: Recently run');
    expect(trigger.getAttribute('aria-label')).toBe('Sort: Recently run');
    click(trigger);
    click(byTestId('sort-option-name'));
    expect(byTestId('sort').textContent).toBe('Sort: Name');
  });
});

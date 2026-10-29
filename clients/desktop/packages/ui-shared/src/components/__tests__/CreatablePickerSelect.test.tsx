/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CreatablePickerSelect,
  type CreatablePickerOption,
  type CreatablePickerSelectProps,
} from '../CreatablePickerSelect';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const OPTIONS: readonly CreatablePickerOption[] = [
  { value: 'Alpha', label: 'Alpha' },
  { value: 'Beta', label: 'Beta' },
];

describe('CreatablePickerSelect', () => {
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

  function mount(props: Partial<CreatablePickerSelectProps> = {}): void {
    const defaultProps: CreatablePickerSelectProps = {
      options: OPTIONS,
      value: '',
      onValueChange: (): void => undefined,
      emptyLabel: 'No group',
      createLabel: (text: string): string => `Create “${text}”`,
      'data-testid': 'group-picker',
    };
    const mergedProps: CreatablePickerSelectProps = {
      ...defaultProps,
      ...props,
    };
    act(() => root.render(<CreatablePickerSelect {...mergedProps} />));
  }

  function trigger(): HTMLButtonElement {
    const element = container.querySelector('[data-testid="group-picker"]');
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error('missing picker trigger');
    }
    return element;
  }

  function searchInput(): HTMLInputElement {
    const element = document.querySelector(
      '[data-testid="group-picker-search"]',
    );
    if (!(element instanceof HTMLInputElement)) {
      throw new Error('missing picker search input');
    }
    return element;
  }

  function option(testId: string): HTMLButtonElement {
    const element = document.querySelector(`[data-testid="${testId}"]`);
    if (!(element instanceof HTMLButtonElement)) {
      throw new Error(`missing picker option ${testId}`);
    }
    return element;
  }

  function openPicker(): void {
    act(() => trigger().click());
  }

  function typeSearch(text: string): void {
    const input = searchInput();
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.bind(input);
    if (!setValue) throw new Error('missing input value setter');
    act(() => {
      setValue(text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function pressSearchKey(key: string): void {
    act(() => {
      searchInput().dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );
    });
  }

  it('shows the empty label, a case-insensitive matched option, and an unmatched value with its hint', () => {
    mount();
    expect(trigger().textContent).toContain('No group');
    expect(trigger().className).toContain('fg-tertiary');

    mount({ value: 'aLPHa' });
    expect(trigger().textContent).toContain('Alpha');
    expect(trigger().textContent).not.toContain('New group');

    mount({ value: 'Future group', unmatchedValueHint: 'New group' });
    expect(trigger().textContent).toContain('Future group');
    expect(trigger().textContent).toContain('New group');
  });

  it('chooses an existing option and returns focus to the trigger', () => {
    const onValueChange = jest.fn();
    mount({ onValueChange });
    openPicker();

    act(() => option('group-picker-option-1').click());

    expect(onValueChange).toHaveBeenCalledWith('Beta');
    expect(
      document.querySelector('[data-testid="group-picker-option-1"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('chooses the empty option', () => {
    const onValueChange = jest.fn();
    mount({ value: 'Alpha', onValueChange });
    openPicker();

    act(() => option('group-picker-option-empty').click());

    expect(onValueChange).toHaveBeenCalledWith('');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('pins an unmatched saved value with its hint before existing options', () => {
    mount({ value: 'Future group', unmatchedValueHint: 'New group' });
    openPicker();

    const rows = Array.from(document.querySelectorAll('[role="option"]'));
    expect(rows[0]?.getAttribute('data-testid')).toBe(
      'group-picker-option-empty',
    );
    expect(rows[1]?.getAttribute('data-testid')).toBe(
      'group-picker-option-unmatched',
    );
    expect(rows[1]?.textContent).toContain('Future group');
    expect(rows[1]?.textContent).toContain('New group');
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('creates normalized text when Enter is pressed on the create row', () => {
    const onValueChange = jest.fn();
    mount({ onValueChange });
    openPicker();
    typeSearch('  New group  ');

    expect(option('group-picker-option-create').textContent).toContain(
      'Create “New group”',
    );
    expect(searchInput().getAttribute('aria-activedescendant')).toBe(
      option('group-picker-option-create').id,
    );
    pressSearchKey('Enter');

    expect(onValueChange).toHaveBeenCalledWith('New group');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('creates normalized text when the create row is clicked', () => {
    const onValueChange = jest.fn();
    mount({ onValueChange });
    openPicker();
    typeSearch('  Another group  ');

    act(() => option('group-picker-option-create').click());

    expect(onValueChange).toHaveBeenCalledWith('Another group');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('does not offer a create row when the query matches an existing option in another case', () => {
    mount();
    openPicker();
    typeSearch('aLpHa');

    expect(option('group-picker-option-0').textContent).toContain('Alpha');
    expect(
      document.querySelector('[data-testid="group-picker-option-create"]'),
    ).toBeNull();
  });

  it('filters options by a case-insensitive label substring', () => {
    mount();
    openPicker();
    typeSearch('eT');

    expect(option('group-picker-option-1').textContent).toContain('Beta');
    expect(
      document.querySelector('[data-testid="group-picker-option-0"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="group-picker-option-empty"]'),
    ).toBeNull();
  });

  it('marks the selected row with a check and no persistent background', () => {
    mount({ value: 'Alpha' });
    openPicker();

    const selected = option('group-picker-option-0');
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(
      selected.querySelector('[data-picker-selected-check="true"]'),
    ).not.toBeNull();
    expect(selected.classList).not.toContain('bg-subtle');
  });

  it('closes on Escape and returns focus to the trigger', () => {
    mount();
    openPicker();
    expect(document.activeElement).toBe(searchInput());

    pressSearchKey('Escape');

    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('leaves length limits to normalizeText so code points are not cut short', () => {
    const onValueChange = jest.fn();
    mount({
      onValueChange,
      normalizeText: (text: string): string =>
        Array.from(text.trim()).slice(0, 3).join(''),
    });
    openPicker();

    // A native maxLength would count each emoji as two UTF-16 units.
    expect(searchInput().maxLength).toBe(-1);
    typeSearch('😀😀😀😀');
    pressSearchKey('Enter');

    expect(onValueChange).toHaveBeenCalledWith('😀😀😀');
  });

  it('keeps an option that matches only after normalization selectable', () => {
    const onValueChange = jest.fn();
    const key = (text: string): string =>
      text.trim().replace(/\s+/g, ' ').toLowerCase();
    mount({
      onValueChange,
      options: [{ value: 'Daily review', label: 'Daily review' }],
      findOption: (candidates, text) =>
        candidates.find((candidate) => key(candidate.label) === key(text)),
    });
    openPicker();
    typeSearch('Daily   review');

    expect(
      document.querySelector('[data-testid="group-picker-option-create"]'),
    ).toBeNull();
    expect(option('group-picker-option-0').textContent).toContain(
      'Daily review',
    );
    pressSearchKey('Enter');

    expect(onValueChange).toHaveBeenCalledWith('Daily review');
  });

  it('selects the exact match on Enter when an earlier option also contains the text', () => {
    const onValueChange = jest.fn();
    mount({
      onValueChange,
      options: [
        { value: 'Alphabet', label: 'Alphabet' },
        { value: 'Alpha', label: 'Alpha' },
      ],
    });
    openPicker();
    typeSearch('alpha');

    expect(
      document.querySelector('[data-testid="group-picker-option-create"]'),
    ).toBeNull();
    expect(searchInput().getAttribute('aria-activedescendant')).toBe(
      option('group-picker-option-1').id,
    );
    pressSearchKey('Enter');

    expect(onValueChange).toHaveBeenCalledWith('Alpha');
  });
});

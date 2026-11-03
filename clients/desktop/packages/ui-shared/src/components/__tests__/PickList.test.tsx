/**
 * @jest-environment jsdom
 */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PickList } from '../PickList';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Command {
  readonly id: string;
  readonly name: string;
}

const COMMANDS: readonly Command[] = [
  { id: 'review', name: 'Review changes' },
  { id: 'plan', name: 'Plan a task' },
  { id: 'push', name: 'Push branch' },
];

let root: Root;

beforeEach(() => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

type Props = ComponentProps<typeof PickList<Command>>;

function render(overrides: Partial<Props> = {}): jest.Mock {
  const onPick = jest.fn();
  act(() =>
    root.render(
      <PickList<Command>
        items={COMMANDS}
        getKey={(item) => item.id}
        getLabel={(item) => item.name}
        onPick={onPick}
        searchLabel="Search commands"
        listLabel="Commands"
        emptyLabel="No commands match."
        optionTestId={(item) => `command-${item.id}`}
        {...overrides}
      />,
    ),
  );
  return onPick;
}

function input(): HTMLInputElement {
  const element = document.querySelector('input');
  if (!element) throw new Error('search field missing');
  return element;
}

function options(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

function activeTestId(): string | null {
  const id = input().getAttribute('aria-activedescendant');
  return id
    ? (document.getElementById(id)?.getAttribute('data-testid') ?? null)
    : null;
}

function key(name: string): void {
  act(() => {
    input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function type(value: string): void {
  act(() => {
    // Through the prototype's setter, so React sees a user edit.
    Reflect.set(HTMLInputElement.prototype, 'value', value, input());
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('PickList', () => {
  it('owns the combobox, listbox and option semantics', () => {
    render();
    expect(input().getAttribute('role')).toBe('combobox');
    expect(document.activeElement).toBe(input());
    const list = document.querySelector('[role="listbox"]');
    expect(list?.getAttribute('aria-label')).toBe('Commands');
    expect(input().getAttribute('aria-controls')).toBe(list?.id);
    expect(options()).toHaveLength(3);
    expect(activeTestId()).toBe('command-review');
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('moves the active row with the arrows, Home and End, and picks on Enter', () => {
    const onPick = render();
    key('ArrowDown');
    expect(activeTestId()).toBe('command-plan');
    key('End');
    expect(activeTestId()).toBe('command-push');
    key('ArrowDown');
    expect(activeTestId()).toBe('command-review');
    key('ArrowUp');
    expect(activeTestId()).toBe('command-push');
    key('Home');
    expect(activeTestId()).toBe('command-review');
    key('Enter');
    expect(onPick).toHaveBeenCalledWith(COMMANDS[0]);
    expect(document.activeElement).toBe(input());
  });

  it('leaves keys that confirm an IME composition to the input method', () => {
    const onPick = render();
    // Enter confirms the candidate (Japanese, Chinese, Korean input); it must
    // not also pick the highlighted row and close the picker mid-query.
    for (const name of ['Enter', 'ArrowDown']) {
      act(() => {
        input().dispatchEvent(
          new KeyboardEvent('keydown', {
            key: name,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }
    expect(onPick).not.toHaveBeenCalled();
    expect(activeTestId()).toBe('command-review');
  });

  it('marks the active row with the neutral picker highlight', () => {
    render();
    const [first, second] = options();
    expect(first?.className).toContain('bg-subtle');
    expect(first?.className).not.toContain('accent');
    expect(second?.className).not.toContain(' bg-subtle ');
  });

  it('keeps the active row when the host re-renders with the same results', () => {
    // A host passing fresh arrays and inline callbacks on every render (as
    // SearchableSelect does) must not move the highlight under the user.
    const onPick = render({ items: [...COMMANDS], selectedKey: 'review' });
    key('ArrowDown');
    expect(activeTestId()).toBe('command-plan');

    render({ items: [...COMMANDS], selectedKey: 'review', onPick });
    expect(activeTestId()).toBe('command-plan');
  });

  it('starts again when the host passes different results', () => {
    render({ items: [...COMMANDS] });
    key('ArrowDown');
    expect(activeTestId()).toBe('command-plan');

    render({ items: COMMANDS.filter((command) => command.id !== 'plan') });
    expect(activeTestId()).toBe('command-review');
  });

  it('filters as you type and starts again on the first match', () => {
    const onPick = render();
    type('pu');
    expect(options().map((row) => row.textContent)).toEqual(['Push branch']);
    expect(activeTestId()).toBe('command-push');
    key('Enter');
    expect(onPick).toHaveBeenCalledWith(COMMANDS[2]);
  });

  it('picks a row on click', () => {
    const onPick = render();
    act(() => options()[1]?.click());
    expect(onPick).toHaveBeenCalledWith(COMMANDS[1]);
  });

  it('shows the empty sentence when nothing matches', () => {
    const onPick = render();
    type('zzz');
    expect(options()).toHaveLength(0);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      'No commands match.',
    );
    expect(input().getAttribute('aria-activedescendant')).toBeNull();
    key('Enter');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('shows placeholder rows while loading', () => {
    render({ loading: true, loadingLabel: 'Loading commands' });
    expect(options()).toHaveLength(0);
    expect(
      document.querySelector('[role="listbox"]')?.getAttribute('aria-busy'),
    ).toBe('true');
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'Loading commands',
    );
  });

  it('leaves results to the host when the query is controlled', () => {
    const onQueryChange = jest.fn();
    render({ query: 'zzz', onQueryChange });
    expect(options()).toHaveLength(3);
    type('re');
    expect(onQueryChange).toHaveBeenLastCalledWith('re');
  });

  it('starts on the current value and hands Escape to the host', () => {
    const onEscape = jest.fn();
    render({ selectedKey: 'plan', onEscape });
    expect(activeTestId()).toBe('command-plan');
    key('Escape');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

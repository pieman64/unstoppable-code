/** @jest-environment jsdom */

import { act, useState, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SearchEmptyState,
  SearchField,
  SearchFieldButton,
  type SearchFieldSize,
} from '../SearchField';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

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

function render(element: JSX.Element): void {
  act(() => root.render(element));
}

function get<T extends Element = HTMLElement>(selector: string): T {
  const element = document.body.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function input(): HTMLInputElement {
  return get<HTMLInputElement>('[data-testid="search"]');
}

function type(value: string): void {
  const field = input();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- native value setter used to trigger React's onChange
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  act(() => {
    setValue?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    input().dispatchEvent(event);
  });
  return event;
}

interface FixtureProps {
  readonly initial?: string;
  readonly size?: SearchFieldSize;
  readonly count?: ReactNode;
  readonly trailing?: ReactNode;
  readonly actions?: ReactNode;
  readonly clearOnEscape?: boolean;
  readonly onEscapeEmpty?: () => void;
  readonly onChange?: (value: string) => void;
}

function Fixture({
  initial = '',
  size,
  count,
  trailing,
  actions,
  clearOnEscape,
  onEscapeEmpty,
  onChange,
}: FixtureProps): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <SearchField
      value={value}
      onValueChange={(next): void => {
        setValue(next);
        onChange?.(next);
      }}
      size={size}
      aria-label="Search workflows"
      placeholder="Search workflows"
      data-testid="search"
      fieldTestId="search-field"
      clearTestId="search-clear"
      count={count}
      trailing={trailing}
      actions={actions}
      clearOnEscape={clearOnEscape}
      onEscapeEmpty={onEscapeEmpty}
    />
  );
}

describe('SearchField', () => {
  it('renders each size with its own geometry', () => {
    const geometry: Record<SearchFieldSize, string> = {
      sm: 'h-7',
      md: 'h-8',
      lg: 'h-11',
    };
    for (const size of ['sm', 'md', 'lg'] as const) {
      render(<Fixture size={size} />);
      const field = get('[data-testid="search-field"]');
      expect(field.getAttribute('data-search-field')).toBe(size);
      expect(field.className).toContain(geometry[size]);
      // sm and md are capsules on the field edge; lg is a borderless header.
      expect(field.className.includes('rounded-full')).toBe(size !== 'lg');
      expect(field.className.includes('shadow-field')).toBe(size !== 'lg');
    }
  });

  it('keeps the browser clear control and the accent focus out', () => {
    render(<Fixture />);
    expect(input().type).toBe('search');
    expect(input().className).toContain(
      '[&::-webkit-search-cancel-button]:appearance-none',
    );
    expect(get('[data-testid="search-field"]').className).toContain(
      'has-[input:focus]:shadow-field-focus',
    );
    expect(input().getAttribute('aria-label')).toBe('Search workflows');
  });

  it('shows the count and Clear only while there is a query', () => {
    render(<Fixture count="3 of 6" />);
    expect(document.querySelector('[data-search-field-count]')).toBeNull();
    expect(document.querySelector('[data-testid="search-clear"]')).toBeNull();

    type('plan');
    expect(get('[data-search-field-count]').textContent).toBe('3 of 6');
    const clear = get<HTMLButtonElement>('[data-testid="search-clear"]');
    expect(clear.getAttribute('aria-label')).toBe('Clear search');

    act(() => {
      clear.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(input().value).toBe('');
    expect(document.activeElement).toBe(input());
    expect(document.querySelector('[data-search-field-count]')).toBeNull();
  });

  it('keeps a trailing hint whatever the query', () => {
    render(<Fixture trailing={<span data-testid="hint">Hint</span>} />);
    expect(get('[data-testid="hint"]').textContent).toBe('Hint');
    type('x');
    expect(get('[data-testid="hint"]').textContent).toBe('Hint');
  });

  it('clears on the first Escape without letting it reach the host', () => {
    const outer = jest.fn();
    document.body.addEventListener('keydown', outer);
    render(<Fixture initial="plan" />);
    const event = pressEscape();
    expect(input().value).toBe('');
    expect(event.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', outer);
  });

  it('backs out on an Escape with nothing to clear', () => {
    const onEscapeEmpty = jest.fn();
    render(<Fixture onEscapeEmpty={onEscapeEmpty} />);
    pressEscape();
    expect(onEscapeEmpty).toHaveBeenCalledTimes(1);

    render(<Fixture />);
    act(() => input().focus());
    pressEscape();
    expect(document.activeElement).not.toBe(input());
  });

  it('leaves Escape to the host when told to', () => {
    const outer = jest.fn();
    document.body.addEventListener('keydown', outer);
    render(<Fixture initial="plan" clearOnEscape={false} />);
    const event = pressEscape();
    expect(input().value).toBe('plan');
    expect(event.defaultPrevented).toBe(false);
    expect(outer).toHaveBeenCalledTimes(1);
    document.body.removeEventListener('keydown', outer);
  });

  it('nests its buttons after a hairline while there is a query', () => {
    render(
      <Fixture
        actions={
          <SearchFieldButton
            aria-label="Filters: 1 on"
            data-testid="filter"
            active
            icon={<svg />}
          />
        }
      />,
    );
    const filter = get('[data-testid="filter"]');
    expect(filter.getAttribute('data-active')).toBe('true');
    expect(filter.className).toContain('rounded-full');
    // The 24px disc nests in the 28px capsule's 2px end inset.
    expect(filter.className).toContain('h-6');
    expect(get('[data-testid="search-field"]').className).toContain('pr-0.5');
    expect(document.querySelector('[aria-hidden="true"].h-3\\.5')).toBeNull();
    type('x');
    expect(
      document.querySelector('[aria-hidden="true"].h-3\\.5'),
    ).toBeInstanceOf(Element);
  });

  it('nests a 28px button in the lg header', () => {
    render(
      <Fixture
        size="lg"
        actions={
          <SearchFieldButton
            aria-label="Filter"
            data-testid="filter"
            icon={<svg />}
          />
        }
      />,
    );
    expect(get('[data-testid="filter"]').className).toContain('h-7');
    expect(
      get('[data-testid="filter"]').getAttribute('data-active'),
    ).toBeNull();
  });
});

describe('SearchEmptyState', () => {
  it('shows the quiet search-x glyph, one sentence and one action', () => {
    const onAction = jest.fn();
    render(
      <SearchEmptyState
        testId="empty"
        title="Nothing matches your search."
        actionLabel="Clear search"
        onAction={onAction}
        actionTestId="empty-clear"
      />,
    );
    const empty = get('[data-testid="empty"]');
    const glyph = empty.querySelector('svg');
    expect(glyph).toBeInstanceOf(Element);
    expect(glyph?.getAttribute('class')).toContain('fg-tertiary');
    expect(empty.querySelector('h3')?.textContent).toBe(
      'Nothing matches your search.',
    );
    const action = get('[data-testid="empty-clear"]');
    expect(action.textContent).toBe('Clear search');
    act(() => {
      action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(empty.querySelectorAll('button')).toHaveLength(1);
  });

  it('renders no action without a label and handler', () => {
    render(<SearchEmptyState testId="empty" title="Nothing matches." />);
    expect(get('[data-testid="empty"]').querySelector('button')).toBeNull();
  });
});

/**
 * @jest-environment jsdom
 */
import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChoiceField } from '../Choice';
import { ChoiceList, ChoiceListRow } from '../ChoiceList';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (node: JSX.Element): void => {
  act(() => root.render(node));
};

const key = (element: Element, name: string): void => {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true }),
    );
  });
};

describe('ChoiceList semantics', () => {
  it('draws checkbox rows as checkboxes with aria-checked, not pressed buttons', () => {
    render(
      <ChoiceList aria-label="Projects">
        <ChoiceListRow selected data-testid="on">
          Alpha
        </ChoiceListRow>
        <ChoiceListRow selected={false} data-testid="off">
          Beta
        </ChoiceListRow>
      </ChoiceList>,
    );
    expect(container.firstElementChild?.getAttribute('role')).toBe('group');
    const on = container.querySelector('[data-testid="on"]');
    const off = container.querySelector('[data-testid="off"]');
    expect(on?.getAttribute('role')).toBe('checkbox');
    expect(on?.getAttribute('aria-checked')).toBe('true');
    expect(off?.getAttribute('aria-checked')).toBe('false');
    expect(on?.hasAttribute('aria-pressed')).toBe(false);
  });

  it('draws a row focus ring inside the row, so the scrolling list cannot clip it', () => {
    render(
      <ChoiceList aria-label="Projects">
        <ChoiceListRow selected data-testid="on">
          Alpha
        </ChoiceListRow>
      </ChoiceList>,
    );
    expect(container.querySelector('[data-testid="on"]')?.classList).toContain(
      'focus-ring-inset',
    );
  });

  function RadioHarness(): JSX.Element {
    const [plan, setPlan] = useState<string | null>(null);
    return (
      <ChoiceList aria-label="Plan" kind="radio">
        {['team', 'business', 'enterprise'].map((value) => (
          <ChoiceListRow
            key={value}
            kind="radio"
            selected={plan === value}
            disabled={value === 'business'}
            data-testid={value}
            onClick={() => setPlan(value)}
          >
            {value}
          </ChoiceListRow>
        ))}
      </ChoiceList>
    );
  }

  it('makes a radio list a radiogroup with one tab stop and arrow keys that select', () => {
    render(<RadioHarness />);
    const group = container.firstElementChild;
    expect(group?.getAttribute('role')).toBe('radiogroup');
    const row = (id: string): HTMLElement => {
      const element = container.querySelector<HTMLElement>(
        `[data-testid="${id}"]`,
      );
      if (!element) throw new Error(id);
      return element;
    };
    expect(row('team').getAttribute('role')).toBe('radio');
    // Nothing chosen: the first row is the one tab stop.
    expect(row('team').tabIndex).toBe(0);
    expect(row('enterprise').tabIndex).toBe(-1);

    act(() => row('team').focus());
    // ArrowDown skips the disabled row, moves focus, and selects.
    key(row('team'), 'ArrowDown');
    expect(document.activeElement).toBe(row('enterprise'));
    expect(row('enterprise').getAttribute('aria-checked')).toBe('true');
    expect(row('enterprise').tabIndex).toBe(0);
    expect(row('team').tabIndex).toBe(-1);
    // ArrowDown wraps to the first enabled row.
    key(row('enterprise'), 'ArrowDown');
    expect(document.activeElement).toBe(row('team'));
    expect(row('team').getAttribute('aria-checked')).toBe('true');
    key(row('team'), 'ArrowUp');
    expect(document.activeElement).toBe(row('enterprise'));
  });
});

describe('ChoiceField', () => {
  function Harness({ kind }: { kind: 'checkbox' | 'radio' }): JSX.Element {
    const [checked, setChecked] = useState(false);
    return (
      <ChoiceField
        kind={kind}
        label="Trust this device"
        description="Skip the code on this computer for 30 days."
        checked={checked}
        onChange={(event) => setChecked(event.target.checked)}
        data-testid="trust"
      />
    );
  }

  it('toggles a checkbox when its text is clicked', () => {
    render(<Harness kind="checkbox" />);
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="trust"]',
    );
    expect(input?.type).toBe('checkbox');
    const label = container.querySelector('label');
    expect(label?.contains(input ?? null)).toBe(true);
    const text = Array.from(container.querySelectorAll('span')).find(
      (span) => span.textContent === 'Trust this device',
    );
    act(() => text?.click());
    expect(input?.checked).toBe(true);
    act(() => text?.click());
    expect(input?.checked).toBe(false);
    expect(container.textContent).toContain('Skip the code');
  });

  it('selects a radio when its text is clicked', () => {
    render(<Harness kind="radio" />);
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="trust"]',
    );
    expect(input?.type).toBe('radio');
    act(() => container.querySelector('label')?.click());
    expect(input?.checked).toBe(true);
  });
});

describe('ChoiceField trailing content', () => {
  function Consent(): JSX.Element {
    const [checked, setChecked] = useState(false);
    return (
      <ChoiceField
        label="I have read and agree to the"
        checked={checked}
        onChange={(event) => setChecked(event.target.checked)}
        data-testid="consent"
        trailing={
          <>
            <a href="#terms">Terms of Service</a> and{' '}
            <a href="#privacy">Privacy Policy</a>.
          </>
        }
      />
    );
  }

  it('puts trailing content under the label text, outside the clickable label', () => {
    render(<Consent />);
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="consent"]',
    );
    const label = container.querySelector('label');
    const terms =
      container.querySelector<HTMLAnchorElement>('a[href="#terms"]');
    expect(label?.contains(terms ?? null)).toBe(false);
    // Aligned with the label text: the 16px mark plus the 8px gap.
    expect(terms?.closest('[data-choice-field-trailing]')?.className).toContain(
      'pl-6',
    );
    // A link never toggles the box; the label text still does.
    act(() => terms?.click());
    expect(input?.checked).toBe(false);
    act(() => label?.click());
    expect(input?.checked).toBe(true);
  });
});

describe('ChoiceField row layout', () => {
  function Row(): JSX.Element {
    const [checked, setChecked] = useState(false);
    return (
      <ChoiceField
        kind="radio"
        layout="row"
        label="Use the default"
        checked={checked}
        onChange={(event) => setChecked(event.target.checked)}
        data-testid="row"
        end={<span data-testid="row-end">A</span>}
      />
    );
  }

  it('makes the label the padded, touch-sized row, its end content included', () => {
    render(<Row />);
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="row"]',
    );
    const label = container.querySelector('label');
    const classes = label?.className.split(/\s+/) ?? [];
    expect(classes).toEqual(
      expect.arrayContaining([
        'w-full',
        'min-h-9',
        'px-2',
        'py-2',
        'pointer-coarse:min-h-11',
        'pointer-coarse:py-3',
      ]),
    );
    const end = container.querySelector('[data-testid="row-end"]');
    expect(label?.contains(end)).toBe(true);
    act(() => (end as HTMLElement | null)?.click());
    expect(input?.checked).toBe(true);
  });

  it('keeps the inline layout fitted to its text', () => {
    render(<ChoiceField label="Inline" />);
    expect(container.querySelector('label')?.className).not.toContain('px-2');
  });
});

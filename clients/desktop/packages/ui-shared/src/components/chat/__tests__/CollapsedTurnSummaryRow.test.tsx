/** @jest-environment jsdom */
/**
 * DOM tests for the shared {@link CollapsedTurnSummaryRow} shell: the toggle
 * button both the desktop transcript and the shared `CollapsedTurnSummary`
 * mount. Phone-tier sizing is covered server-rendered in
 * `CollapsedTurnSummary.test.tsx`.
 */
import { act, createRef, type ComponentProps, type MouseEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CollapsedTurnSummaryRow } from '../CollapsedTurnSummary';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function renderRow(
  props: Partial<ComponentProps<typeof CollapsedTurnSummaryRow>> = {},
): HTMLButtonElement {
  act(() =>
    root.render(
      <CollapsedTurnSummaryRow
        isExpanded={false}
        ariaLabel="Agent steps: 2 bash"
        dataTestId="chat-turn-summary"
        {...props}
      >
        <span data-turn-step-count="2">2 steps</span>
      </CollapsedTurnSummaryRow>,
    ),
  );
  const button = host.querySelector<HTMLButtonElement>(
    '[data-testid="chat-turn-summary"]',
  );
  if (!button) throw new Error('Missing summary row button');
  return button;
}

function rowOf(button: HTMLElement): HTMLElement {
  const row = button.closest<HTMLElement>('[data-turn-summary-row]');
  if (!row) throw new Error('Missing summary row wrapper');
  return row;
}

describe('CollapsedTurnSummaryRow', () => {
  it('renders a native button with the accessible name and test ID', () => {
    const button = renderRow();

    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Agent steps: 2 bash');
    expect(button.getAttribute('data-testid')).toBe('chat-turn-summary');
  });

  it('reflects expanded state via aria-expanded', () => {
    expect(renderRow().getAttribute('aria-expanded')).toBe('false');
    expect(renderRow({ isExpanded: true }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  /**
   * The desktop banner takes its user bubble's width through this ref, so it
   * must be the whole row (toggle, outcome and chips), not the toggle alone.
   */
  it('forwards its ref to the row wrapper around the toggle', () => {
    const ref = createRef<HTMLDivElement>();
    const button = renderRow({ ref });

    expect(ref.current).toBe(rowOf(button));
    expect(ref.current?.contains(button)).toBe(true);
  });

  it('calls the click handler once per activation', () => {
    const onClick = jest.fn();
    const button = renderRow({ onClick });

    act(() => button.click());

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  /**
   * Enter and Space reach the handler through the browser's native button
   * activation, which arrives as a click. A key handler of its own would
   * toggle twice per key press.
   */
  it('adds no key handling on top of native button activation', () => {
    const onClick = jest.fn();
    const button = renderRow({ onClick });

    act(() => {
      button.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      button.dispatchEvent(
        new KeyboardEvent('keyup', { key: ' ', bubbles: true }),
      );
    });

    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders host children after a decorative chevron', () => {
    const button = renderRow();
    const [chevron, words] = Array.from(button.children);

    expect(chevron?.getAttribute('aria-hidden')).toBe('true');
    expect(chevron?.querySelector('svg')).not.toBeNull();
    expect(words?.getAttribute('data-turn-step-count')).toBe('2');
  });

  it('renders the outcome and trailing slots beside the toggle, not in it', () => {
    const button = renderRow({
      outcome: <button type="button" data-testid="outcome" />,
      trailing: <span data-tool-chip="bash">2</span>,
    });
    const row = rowOf(button);

    expect(button.querySelector('[data-testid="outcome"]')).toBeNull();
    expect(button.querySelector('[data-tool-chip]')).toBeNull();
    expect(row.querySelector('[data-testid="outcome"]')).not.toBeNull();
    expect(row.querySelector('[data-tool-chip="bash"]')).not.toBeNull();
  });

  it('toggles from a chip click, which keeps its own title', () => {
    const targets: EventTarget[] = [];
    const onClick = jest.fn((event: MouseEvent<HTMLButtonElement>) => {
      targets.push(event.currentTarget);
    });
    const button = renderRow({
      onClick,
      trailing: (
        <span data-tool-chip="bash" title="bash">
          2
        </span>
      ),
    });
    const chip = rowOf(button).querySelector<HTMLElement>('[data-tool-chip]');

    act(() => chip?.click());

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(targets).toEqual([button]);
  });

  it('never toggles from a click on the outcome slot', () => {
    const onClick = jest.fn();
    const button = renderRow({
      onClick,
      outcome: <button type="button" data-testid="outcome" />,
    });

    act(() =>
      rowOf(button)
        .querySelector<HTMLElement>('[data-testid="outcome"]')
        ?.click(),
    );

    expect(onClick).not.toHaveBeenCalled();
  });

  /**
   * CAN-4281: the row sits on the chat background. Rendered appearance is
   * asserted with computed styles in the desktop and web flows; this pins the
   * shell's own classes so a surface cannot creep back in unnoticed.
   */
  it('has no surface of its own, only a hover foreground and focus ring', () => {
    const button = renderRow();
    const buttonClasses = button.className.split(/\s+/);
    const rowClasses = rowOf(button).className.split(/\s+/);

    // The ring outlines the row through the toggle's stretched `::before`.
    expect(buttonClasses).toContain('focus-ring');
    expect(buttonClasses).toContain('focus-ring-stretched');
    expect(buttonClasses).toContain('before:absolute');
    expect(buttonClasses).toContain('before:inset-0');
    expect(rowClasses).toContain('relative');
    expect(rowClasses).toContain('hover:fg-primary');
    expect(
      [...buttonClasses, ...rowClasses].filter((name) =>
        /^(hover:)?(bg-|border|rounded|shadow)/.test(name),
      ),
    ).toEqual([]);
  });

  it('appends host classes to the shell layout', () => {
    const classes = rowOf(renderRow({ className: 'ml-auto' })).className.split(
      /\s+/,
    );

    expect(classes).toContain('ml-auto');
    expect(classes).toContain('w-full');
  });
});

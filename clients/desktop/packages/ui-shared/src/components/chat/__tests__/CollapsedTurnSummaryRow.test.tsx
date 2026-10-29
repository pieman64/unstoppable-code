/** @jest-environment jsdom */
/**
 * DOM tests for the shared {@link CollapsedTurnSummaryRow} shell: the toggle
 * button both the desktop transcript and the shared `CollapsedTurnSummary`
 * mount. Phone-tier sizing is covered server-rendered in
 * `CollapsedTurnSummary.test.tsx`.
 */
import { act, createRef, type ComponentProps } from 'react';
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
        <span data-tool-chip="bash">2</span>
      </CollapsedTurnSummaryRow>,
    ),
  );
  const button = host.querySelector('button');
  if (!button) throw new Error('Missing summary row button');
  return button;
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

  it('forwards its ref to the button', () => {
    const ref = createRef<HTMLButtonElement>();
    const button = renderRow({ ref });

    expect(ref.current).toBe(button);
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
    const [chevron, chip] = Array.from(button.children);

    expect(chevron?.getAttribute('aria-hidden')).toBe('true');
    expect(chevron?.querySelector('svg')).not.toBeNull();
    expect(chip?.getAttribute('data-tool-chip')).toBe('bash');
  });

  /**
   * CAN-4281: the row sits on the chat background. Rendered appearance is
   * asserted with computed styles in the desktop and web flows; this pins the
   * shell's own classes so a surface cannot creep back in unnoticed.
   */
  it('has no surface of its own, only a hover foreground and focus ring', () => {
    const classes = renderRow().className.split(/\s+/);

    expect(classes).toContain('focus-ring');
    expect(classes).toContain('hover:fg-primary');
    expect(
      classes.filter((name) =>
        /^(hover:)?(bg-|border|rounded|shadow)/.test(name),
      ),
    ).toEqual([]);
  });

  it('appends host classes to the shell layout', () => {
    const classes = renderRow({ className: 'ml-auto' }).className.split(/\s+/);

    expect(classes).toContain('ml-auto');
    expect(classes).toContain('w-full');
  });
});

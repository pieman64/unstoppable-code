/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfirmDialog } from '../ConfirmDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * Roots created by `render`, torn down in `afterEach`.
 *
 * Clearing `document.body.innerHTML` alone detaches the DOM but leaves the
 * React root mounted: effects never clean up, and React logs a warning when a
 * root's container disappears from under it. Unmount first, then clear.
 */
const activeRoots: Root[] = [];

function render(node: JSX.Element): { root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoots.push(root);
  act(() => {
    root.render(node);
  });
  return { root };
}

function confirmButton(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    '[data-testid="confirm-dialog-confirm"]',
  );
  if (!el) throw new Error('confirm button not found');
  return el;
}

const baseProps = {
  title: 'Continue on Codex?',
  message: 'This starts a new chat on the other harness.',
  confirmLabel: 'Continue',
  onConfirm: (): void => {},
  onCancel: (): void => {},
};

describe('ConfirmDialog busy state', () => {
  afterEach(() => {
    act(() => {
      while (activeRoots.length > 0) {
        activeRoots.pop()?.unmount();
      }
    });
    document.body.innerHTML = '';
  });

  it('renders no spinner while idle', () => {
    render(<ConfirmDialog {...baseProps} />);
    expect(
      document.querySelector('[data-testid="confirm-dialog-spinner"]'),
    ).toBeNull();
    expect(confirmButton().textContent).toContain('Continue');
  });

  it('renders the spinner INSIDE the confirm button while busy', () => {
    // CAN-2349 decision 5. Before this, `ConfirmDialog` only swapped
    // `confirmLabel` → `busyLabel`, so the just-merged cross-harness continue
    // dialog (#2487) reported an in-flight continue with a bare label change
    // and no motion at all. The spinner must live in the button the user
    // pressed — that is the affordance whose progress they are watching.
    render(<ConfirmDialog {...baseProps} busy busyLabel="Continuing…" />);
    const spinner = document.querySelector(
      '[data-testid="confirm-dialog-spinner"]',
    );
    expect(spinner).not.toBeNull();
    expect(confirmButton().contains(spinner)).toBe(true);
  });

  it('leaves busyLabel semantics untouched', () => {
    // No caller has to move: `busyLabel` still replaces the label when busy,
    // and its absence still leaves `confirmLabel` in place.
    const { root } = render(
      <ConfirmDialog {...baseProps} busy busyLabel="Continuing…" />,
    );
    expect(confirmButton().textContent).toContain('Continuing…');
    expect(confirmButton().disabled).toBe(true);

    act(() => {
      root.render(<ConfirmDialog {...baseProps} busy />);
    });
    expect(confirmButton().textContent).toContain('Continue');
    expect(
      document.querySelector('[data-testid="confirm-dialog-spinner"]'),
    ).not.toBeNull();
  });
});

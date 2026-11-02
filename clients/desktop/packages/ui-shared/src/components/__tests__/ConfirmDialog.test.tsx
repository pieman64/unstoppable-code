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

/** A button's label without the key chip drawn inside it. */
function labelOf(button: HTMLButtonElement): string {
  const chip = button.querySelector('[data-testid="kbd-chip"]');
  const text = button.textContent ?? '';
  return chip ? text.replace(chip.textContent ?? '', '') : text;
}

/** The key chip inside a button, or null. */
function chipOf(button: HTMLButtonElement): string | null {
  return button.querySelector('[data-testid="kbd-chip"]')?.textContent ?? null;
}

function withPlatform(platform: string, run: () => void): void {
  const spy = jest.spyOn(navigator, 'platform', 'get');
  spy.mockReturnValue(platform);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
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

function cancelButton(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(
    '[data-testid="confirm-dialog-cancel"]',
  );
  if (!el) throw new Error('cancel button not found');
  return el;
}

function card(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!el) throw new Error('dialog not found');
  return el;
}

function pressEscape(): void {
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
}

describe('ConfirmDialog shape and keyboard', () => {
  afterEach(() => {
    act(() => {
      while (activeRoots.length > 0) {
        activeRoots.pop()?.unmount();
      }
    });
    document.body.innerHTML = '';
  });

  it('is a narrow card with capsule buttons, no header rule and no close button', () => {
    render(<ConfirmDialog {...baseProps} />);
    expect(card().className).toContain('max-w-95');
    expect(card().querySelector('[aria-label="Close"]')).toBeNull();
    expect(card().querySelector('.border-b')).toBeNull();
    expect(card().querySelector('h2')?.className).toContain('text-balance');
    const labels = Array.from(card().querySelectorAll('button')).map(labelOf);
    expect(labels).toEqual(['Cancel', 'Continue']);
    for (const button of [cancelButton(), confirmButton()]) {
      expect(button.className).toContain('rounded-full');
    }
  });

  it('puts the keys inside the buttons: esc on Cancel, enter on the default', () => {
    withPlatform('MacIntel', () => {
      render(<ConfirmDialog {...baseProps} />);
      expect(chipOf(cancelButton())).toBe('esc');
      expect(chipOf(confirmButton())).toBe('↵');
      // The chip is hidden from assistive technology, so names stay labels.
      expect(
        confirmButton()
          .querySelector('[data-testid="kbd-chip"]')
          ?.getAttribute('aria-hidden'),
      ).toBe('true');
    });
  });

  it('spells the keys as words off macOS', () => {
    withPlatform('Win32', () => {
      render(<ConfirmDialog {...baseProps} />);
      expect(chipOf(cancelButton())).toBe('Esc');
      expect(chipOf(confirmButton())).toBe('Enter');
    });
  });

  it('draws no enter key on an action that is not the default', () => {
    const { root } = render(<ConfirmDialog {...baseProps} destructive />);
    expect(chipOf(confirmButton())).toBeNull();
    expect(chipOf(cancelButton())).not.toBeNull();
    act(() => {
      root.render(<ConfirmDialog {...baseProps} focusCancel />);
    });
    expect(chipOf(confirmButton())).toBeNull();
    act(() => {
      root.render(<ConfirmDialog {...baseProps} confirmDisabled />);
    });
    expect(chipOf(confirmButton())).toBeNull();
    act(() => {
      root.render(<ConfirmDialog {...baseProps} busy busyLabel="Working…" />);
    });
    // While busy the spinner takes the key's place.
    expect(chipOf(confirmButton())).toBeNull();
  });

  it('makes a non-destructive action the default button, so Enter presses it', () => {
    render(<ConfirmDialog {...baseProps} />);
    expect(confirmButton().className).toContain('bg-accent');
    expect(document.activeElement).toBe(confirmButton());
  });

  it('gives a destructive dialog no default: focus starts on Cancel', () => {
    render(
      <ConfirmDialog
        {...baseProps}
        title="Delete worktree “owl”?"
        confirmLabel="Delete worktree"
        destructive
      />,
    );
    expect(confirmButton().className).toContain('bg-destructive');
    expect(confirmButton().className).not.toContain('bg-accent');
    expect(document.activeElement).toBe(cancelButton());
  });

  it('starts on Cancel while the default action is disabled', () => {
    render(<ConfirmDialog {...baseProps} confirmDisabled />);
    expect(confirmButton().disabled).toBe(true);
    expect(document.activeElement).toBe(cancelButton());
  });

  it('cancels on Escape, except while busy', () => {
    const onCancel = jest.fn();
    const { root } = render(
      <ConfirmDialog {...baseProps} onCancel={onCancel} />,
    );
    pressEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => {
      root.render(<ConfirmDialog {...baseProps} onCancel={onCancel} busy />);
    });
    pressEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(cancelButton().disabled).toBe(true);
  });

  it('contains Tab inside the dialog', () => {
    render(<ConfirmDialog {...baseProps} />);
    expect(document.activeElement).toBe(confirmButton());
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.activeElement?.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancelButton());
  });

  it('keeps the action width while it spins', () => {
    const { root } = render(<ConfirmDialog {...baseProps} />);
    Object.defineProperty(confirmButton(), 'offsetWidth', {
      configurable: true,
      value: 96,
    });
    // Re-measure at rest with the stubbed width, then go busy.
    act(() => {
      root.render(<ConfirmDialog {...baseProps} confirmLabel="Continue now" />);
    });
    act(() => {
      root.render(
        <ConfirmDialog
          {...baseProps}
          confirmLabel="Continue now"
          busy
          busyLabel="Continuing…"
        />,
      );
    });
    expect(confirmButton().style.minWidth).toBe('96px');
    act(() => {
      root.render(<ConfirmDialog {...baseProps} confirmLabel="Continue now" />);
    });
    expect(confirmButton().style.minWidth).toBe('');
  });

  it('lays out a two-way choice: Cancel alone at the left, then the options, at 400px', () => {
    const onDiscard = jest.fn();
    render(
      <ConfirmDialog
        {...baseProps}
        title="Save changes to “Nightly dependency check”?"
        confirmLabel="Save changes"
        secondaryAction={{
          label: 'Discard',
          onSelect: onDiscard,
          testId: 'discard',
        }}
      />,
    );
    expect(card().className).toContain('max-w-100');
    const labels = Array.from(card().querySelectorAll('button')).map(labelOf);
    expect(labels).toEqual(['Cancel', 'Discard', 'Save changes']);
    expect(cancelButton().className).toContain('mr-auto');
    expect(document.activeElement).toBe(confirmButton());
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="discard"]')
        ?.click();
    });
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('renders one control between the sentence and the buttons', () => {
    render(
      <ConfirmDialog {...baseProps}>
        <span data-testid="slot">Keep the local branch</span>
      </ConfirmDialog>,
    );
    const slot = document.querySelector('[data-testid="slot"]');
    expect(slot).toBeInstanceOf(Element);
    expect(
      slot?.compareDocumentPosition(cancelButton()) ===
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(true);
  });
});

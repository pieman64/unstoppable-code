/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SharedContainerInvitationDialog,
  type SharedContainerInvitationDialogProps,
} from '../SharedContainerInvitationDialog';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '../../lib/replay-privacy';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function query(suffix = ''): HTMLElement | null {
  return document.body.querySelector(
    `[data-testid="shared-container-invitation-dialog${suffix}"]`,
  );
}

function render(
  overrides: Partial<SharedContainerInvitationDialogProps> = {},
): {
  onAccept: jest.Mock;
  onRemove: jest.Mock;
  onCancel: jest.Mock;
} {
  const handlers = {
    onAccept: jest.fn(),
    onRemove: jest.fn(),
    onCancel: jest.fn(),
  };
  act(() => {
    root.render(
      <SharedContainerInvitationDialog
        title="Checkout flow"
        ownerName="Dana"
        kind="code"
        accepting={false}
        removing={false}
        acceptFailed={false}
        {...handlers}
        {...overrides}
      />,
    );
  });
  return handlers;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SharedContainerInvitationDialog', () => {
  it('names the share, who shared it, and what kind it is', () => {
    render({ organizationName: 'Acme' });

    const dialog = query();
    expect(dialog?.textContent).toContain('Checkout flow');
    expect(dialog?.textContent).toContain('Shared by Dana · Acme');
    expect(query('-kind')?.textContent).toBe('Code project');
    expect(query('-consent')).not.toBeNull();
    expect(query('-error')).toBeNull();
    expect(query('-remove')?.textContent).toBe('Remove share');
    expect(query('-accept')?.textContent).toBe('Accept and open');
  });

  it('labels a cowork share and omits an unresolved owner', () => {
    render({ kind: 'cowork', ownerName: undefined });

    expect(query('-kind')?.textContent).toBe('Cowork project');
    expect(query()?.textContent).not.toContain('Shared by');
  });

  it('masks the title and blocks only the owner name from replay', () => {
    render();

    const dialog = query();
    expect(dialog?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent).toBe(
      'Checkout flow',
    );
    expect(dialog?.querySelector(`.${REPLAY_BLOCK_CLASS}`)?.textContent).toBe(
      'Dana',
    );
  });

  it('runs each action from its button, with no Cancel beside them', () => {
    const handlers = render();

    expect(query('-cancel')).toBeNull();
    act(() => query('-accept')?.click());
    act(() => query('-remove')?.click());
    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Close"]')
        ?.click(),
    );

    expect(handlers.onAccept).toHaveBeenCalledTimes(1);
    expect(handlers.onRemove).toHaveBeenCalledTimes(1);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['accepting', { accepting: true }, '-accept', 'Opening…'],
    ['removing', { removing: true }, '-remove', 'Removing…'],
  ] as const)(
    'disables both actions and the close button while %s',
    (_name, overrides, busyButton, busyLabel) => {
      const handlers = render(overrides);

      for (const suffix of ['-accept', '-remove']) {
        expect(query(suffix)?.hasAttribute('disabled')).toBe(true);
      }
      expect(
        document
          .querySelector('button[aria-label="Close"]')
          ?.hasAttribute('disabled'),
      ).toBe(true);
      expect(query(busyButton)?.textContent).toBe(busyLabel);
      act(() => query('-accept')?.click());
      expect(handlers.onAccept).not.toHaveBeenCalled();
    },
  );

  it('stays open and explains a failed accept', () => {
    render({ acceptFailed: true });

    expect(query('-error')?.textContent).toBe(
      "Couldn't accept this share. Try again.",
    );
    expect(query('-error')?.getAttribute('role')).toBe('alert');
    expect(query('-accept')?.hasAttribute('disabled')).toBe(false);
  });

  it('takes focus on open and falls back to the named target on close', () => {
    const fallback = document.createElement('button');
    document.body.append(fallback);
    const restoreFocusRef = { current: fallback };
    render({ restoreFocusRef });

    expect(query()?.contains(document.activeElement)).toBe(true);

    act(() => root.render(<span />));

    expect(document.activeElement).toBe(fallback);
    fallback.remove();
  });
});

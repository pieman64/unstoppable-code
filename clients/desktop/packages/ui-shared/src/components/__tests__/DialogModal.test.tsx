/**
 * @jest-environment jsdom
 */
import { act, useRef, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DialogModal } from '../DialogModal';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Every root this creates is tracked so a suite can unmount them. A
// `trapFocus` dialog that is never unmounted leaves a capture-phase `keydown`
// listener on `document` closing over a detached card, and those stale handlers
// `preventDefault()` every later Tab — which silently masks other tests.
const mountedRoots: Root[] = [];

function unmountAllRoots(): void {
  while (mountedRoots.length > 0) {
    const root = mountedRoots.pop();
    if (root) act(() => root.unmount());
  }
}

function render(node: JSX.Element): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function dispatchEscape(target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('DialogModal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('portals into the supplied container without losing Escape dismissal', () => {
    const portalContainer = document.createElement('section');
    document.body.appendChild(portalContainer);
    const onClose = jest.fn();
    const { root, container } = render(
      <DialogModal
        title="Attachment"
        onClose={onClose}
        portalContainer={portalContainer}
      >
        <span>Original bytes</span>
      </DialogModal>,
    );
    try {
      expect(portalContainer.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      dispatchEscape();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it('drops the width cap, overlay padding, and corner radius below sm for the full size', () => {
    const { root } = render(
      <DialogModal onClose={jest.fn()} title="Full dialog" maxWidth="full">
        <div>Body</div>
      </DialogModal>,
    );

    try {
      const card = document.querySelector('[role="dialog"]');
      // A typed width rather than a `className` override: two `max-w-*`
      // utilities of equal specificity would resolve by stylesheet order.
      expect(card?.className).toContain('max-w-none');
      expect(card?.className).not.toContain('max-w-lg');
      expect(card?.className).toContain('rounded-none');
      expect(card?.className).toContain('sm:rounded-2xl');

      const overlay = document.querySelector(
        '[data-canopy-overlay-root="modal"]',
      );
      expect(overlay?.className).toContain('p-0');
      expect(overlay?.className).toContain('sm:p-4');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('applies the max-w-5xl width class for the 5xl size', () => {
    const { root } = render(
      <DialogModal onClose={jest.fn()} title="Wide dialog" maxWidth="5xl">
        <div>Body</div>
      </DialogModal>,
    );

    try {
      const card = document.querySelector('[role="dialog"]');
      expect(card?.className).toContain('max-w-5xl');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('uses the semantic black scrim with no backdrop blur or entrance motion', () => {
    const { root } = render(
      <DialogModal onClose={jest.fn()} title="Scrim dialog">
        <div>Body</div>
      </DialogModal>,
    );

    try {
      const overlay = document.querySelector('[role="dialog"]')?.parentElement;
      const dialog = document.querySelector('[role="dialog"]');
      expect(overlay?.className).toContain('bg-overlay-scrim');
      expect(overlay?.className).not.toContain('backdrop-blur');
      expect(overlay?.className).not.toContain('bg-base/');
      expect(overlay?.className).not.toContain('animate-fade-in');
      expect(dialog?.className).not.toContain('animate-scale-in');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('wraps children in a scrollable body by default', () => {
    const { root } = render(
      <DialogModal onClose={jest.fn()} title="Scrollable dialog">
        <div data-testid="dialog-body">Body</div>
      </DialogModal>,
    );

    try {
      const body = document.querySelector('[data-testid="dialog-body"]');
      expect(body?.parentElement?.classList.contains('overflow-y-auto')).toBe(
        true,
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders children without a body wrapper when scrolling is disabled', () => {
    const { root } = render(
      <DialogModal
        onClose={jest.fn()}
        title="Custom layout dialog"
        scrollableBody={false}
      >
        <div data-testid="dialog-body">Body</div>
      </DialogModal>,
    );

    try {
      const body = document.querySelector('[data-testid="dialog-body"]');
      expect(body?.parentElement?.getAttribute('role')).toBe('dialog');
      expect(body?.parentElement?.classList.contains('overflow-y-auto')).toBe(
        false,
      );
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('uses a dynamic viewport-aware default max height', () => {
    const { root } = render(
      <DialogModal onClose={jest.fn()} title="Sized dialog">
        <div>Body</div>
      </DialogModal>,
    );

    try {
      const dialog = document.querySelector('[role="dialog"]');
      if (!(dialog instanceof HTMLElement)) {
        throw new Error('Expected dialog card element');
      }
      expect(dialog.style.maxHeight).toBe('min(80vh, 85dvh)');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('closes on Escape by default', () => {
    const onClose = jest.fn();
    const { root } = render(
      <DialogModal onClose={onClose} title="Cloud sync">
        <div>Body</div>
      </DialogModal>,
    );

    try {
      dispatchEscape();

      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('can hide the header close button while keeping the dialog mounted', () => {
    const { root } = render(
      <DialogModal
        onClose={jest.fn()}
        title="Pending operation"
        showCloseButton={false}
      >
        <div>Body</div>
      </DialogModal>,
    );

    try {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(document.querySelector('button[aria-label="Close"]')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('portals the dialog card into the document body', () => {
    const { container, root } = render(
      <DialogModal onClose={jest.fn()} title="Portaled dialog">
        <div>Body</div>
      </DialogModal>,
    );

    try {
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(container.contains(dialog)).toBe(false);
      expect(document.body.contains(dialog)).toBe(true);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('listens for Escape on the provided owner document', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const ownerDocument = iframe.contentDocument;
    if (ownerDocument === null) {
      throw new Error('Expected iframe content document');
    }

    const onClose = jest.fn();
    const { root } = render(
      <DialogModal
        onClose={onClose}
        ownerDocument={ownerDocument}
        title="Auxiliary dialog"
      >
        <div>Body</div>
      </DialogModal>,
    );

    try {
      const dialog = ownerDocument.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(ownerDocument.body.contains(dialog)).toBe(true);
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      dispatchEscape(document);
      expect(onClose).not.toHaveBeenCalled();

      dispatchEscape(ownerDocument);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('keeps Escape ordering isolated per owner document', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const ownerDocument = iframe.contentDocument;
    if (ownerDocument === null) {
      throw new Error('Expected iframe content document');
    }

    const onAuxClose = jest.fn();
    const aux = render(
      <DialogModal
        onClose={onAuxClose}
        ownerDocument={ownerDocument}
        title="Auxiliary dialog"
      >
        <div>Body</div>
      </DialogModal>,
    );
    const main = render(
      <DialogModal
        onClose={jest.fn()}
        title="Main pending operation"
        closeOnEscape={false}
      >
        <div>Body</div>
      </DialogModal>,
    );

    try {
      dispatchEscape(ownerDocument);
      expect(onAuxClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        main.root.unmount();
        aux.root.unmount();
      });
      iframe.remove();
    }
  });

  it('does not close on Escape when backdrop closing is disabled', () => {
    const onClose = jest.fn();
    const { root } = render(
      <DialogModal onClose={onClose} title="Setup" closeOnBackdrop={false}>
        <div>Body</div>
      </DialogModal>,
    );

    try {
      dispatchEscape();

      expect(onClose).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('closes on Escape when explicitly enabled with backdrop closing disabled', () => {
    const onClose = jest.fn();
    const { root } = render(
      <DialogModal
        onClose={onClose}
        title="Setup"
        closeOnBackdrop={false}
        closeOnEscape={true}
      >
        <div>Body</div>
      </DialogModal>,
    );

    try {
      dispatchEscape();

      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('does not close on Escape when explicitly disabled with backdrop closing enabled', () => {
    const onClose = jest.fn();
    const { root } = render(
      <DialogModal onClose={onClose} title="Setup" closeOnEscape={false}>
        <div>Body</div>
      </DialogModal>,
    );

    try {
      dispatchEscape();

      expect(onClose).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('closes only the topmost stacked dialog on Escape', () => {
    const onBottomClose = jest.fn();
    const onTopClose = jest.fn();
    const { root } = render(
      <>
        <DialogModal onClose={onBottomClose} title="Settings">
          <div>Background</div>
        </DialogModal>
        <DialogModal onClose={onTopClose} title="Confirm">
          <div>Foreground</div>
        </DialogModal>
      </>,
    );

    try {
      dispatchEscape();

      expect(onBottomClose).not.toHaveBeenCalled();
      expect(onTopClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('blocks Escape from reaching a lower dialog while the top dialog is non-dismissible', () => {
    const onBottomClose = jest.fn();
    const onTopClose = jest.fn();
    const { root } = render(
      <>
        <DialogModal onClose={onBottomClose} title="Settings">
          <div>Background</div>
        </DialogModal>
        <DialogModal
          onClose={onTopClose}
          title="Pending operation"
          closeOnEscape={false}
        >
          <div>Foreground</div>
        </DialogModal>
      </>,
    );

    try {
      const event = dispatchEscape();

      expect(event.defaultPrevented).toBe(true);
      expect(onBottomClose).not.toHaveBeenCalled();
      expect(onTopClose).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('does not close when Escape starts inside an expanded combobox', () => {
    const onClose = jest.fn();
    const { root } = render(
      <DialogModal onClose={onClose} title="Picker">
        <button type="button" role="combobox" aria-expanded="true">
          Branches
        </button>
      </DialogModal>,
    );

    try {
      const expandedControl = document.querySelector('[aria-expanded="true"]');
      if (expandedControl === null) {
        throw new Error('Expected expanded control');
      }

      dispatchEscape(expandedControl);

      expect(onClose).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it.each([false, true])(
    'only leaves Escape to a disclosure that handles it (handled=%s)',
    (handled) => {
      const onClose = jest.fn();
      const { root } = render(
        <DialogModal onClose={onClose} title="Details">
          <button
            type="button"
            aria-expanded="true"
            onKeyDown={(event): void => {
              if (handled && event.key === 'Escape') event.preventDefault();
            }}
          >
            Details
          </button>
        </DialogModal>,
      );
      try {
        const disclosure = document.querySelector('[aria-expanded="true"]');
        if (!disclosure) throw new Error('Expected disclosure');
        dispatchEscape(disclosure);
        expect(onClose).toHaveBeenCalledTimes(handled ? 0 : 1);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('keeps one Escape listener while using the latest onClose callback', () => {
    const addListener = jest.spyOn(document, 'addEventListener');
    const removeListener = jest.spyOn(document, 'removeEventListener');
    const firstOnClose = jest.fn();
    const secondOnClose = jest.fn();
    const { root } = render(
      <DialogModal onClose={firstOnClose} title="Settings">
        <div>Body</div>
      </DialogModal>,
    );

    try {
      const initialKeydownAdds = addListener.mock.calls.filter(
        ([type]) => type === 'keydown',
      );
      expect(initialKeydownAdds).toHaveLength(1);

      act(() => {
        root.render(
          <DialogModal onClose={secondOnClose} title="Settings">
            <div>Body</div>
          </DialogModal>,
        );
      });

      const keydownAddsAfterRerender = addListener.mock.calls.filter(
        ([type]) => type === 'keydown',
      );
      const keydownRemovesAfterRerender = removeListener.mock.calls.filter(
        ([type]) => type === 'keydown',
      );
      expect(keydownAddsAfterRerender).toHaveLength(1);
      expect(keydownRemovesAfterRerender).toHaveLength(0);

      dispatchEscape();

      expect(firstOnClose).not.toHaveBeenCalled();
      expect(secondOnClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }

    const keydownRemovesAfterUnmount = removeListener.mock.calls.filter(
      ([type]) => type === 'keydown',
    );
    expect(keydownRemovesAfterUnmount).toHaveLength(1);
  });
});

/**
 * `trapFocus` is opt-in (default off) because `DialogModal` has ~120 callers.
 * These cover the behavior directly in this package: it shipped exercised only
 * indirectly through an `apps/web` feature test, so a refactor of the effect
 * would have gone green here while breaking every adopter.
 */
describe('DialogModal trapFocus', () => {
  afterEach(() => {
    // Unmount BEFORE clearing the DOM: the effect cleanup is what removes the
    // document-level Tab handler. Without this, six of these tests leak a
    // listener that `preventDefault()`s every subsequent Tab in the file and
    // masks the empty-focusables assertion below.
    unmountAllRoots();
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  function Body(): JSX.Element {
    return (
      <div>
        <button type="button" data-testid="one">
          One
        </button>
        <button type="button" data-testid="two">
          Two
        </button>
      </div>
    );
  }

  function query(testId: string): HTMLButtonElement {
    const value = document.body.querySelector(`[data-testid="${testId}"]`);
    if (!(value instanceof HTMLButtonElement))
      throw new Error(`Missing ${testId}`);
    return value;
  }

  function dispatchTab(shiftKey = false): void {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  it('leaves focus alone when trapFocus is not set', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    render(
      <DialogModal onClose={() => undefined} title="t">
        <Body />
      </DialogModal>,
    );

    expect(document.activeElement).toBe(outside);
  });

  it('moves focus to the first focusable descendant by default', () => {
    render(
      <DialogModal onClose={() => undefined} title="t" trapFocus>
        <Body />
      </DialogModal>,
    );

    // The header close button precedes the body in DOM order.
    expect(document.activeElement).toBe(
      document.body.querySelector('button[aria-label="Close"]'),
    );
  });

  it('honors initialFocusRef over the first focusable', () => {
    function Harness(): JSX.Element {
      const ref = useRef<HTMLButtonElement | null>(null);
      return (
        <DialogModal
          onClose={() => undefined}
          title="t"
          trapFocus
          initialFocusRef={ref}
        >
          <button type="button" ref={ref} data-testid="two">
            Two
          </button>
        </DialogModal>
      );
    }
    render(<Harness />);

    expect(document.activeElement).toBe(query('two'));
  });

  it('cycles Tab from the last focusable back to the first', () => {
    render(
      <DialogModal onClose={() => undefined} title="t" trapFocus>
        <Body />
      </DialogModal>,
    );

    query('two').focus();
    dispatchTab();

    expect(document.activeElement).toBe(
      document.body.querySelector('button[aria-label="Close"]'),
    );
  });

  it('cycles Shift+Tab from the first focusable back to the last', () => {
    render(
      <DialogModal onClose={() => undefined} title="t" trapFocus>
        <Body />
      </DialogModal>,
    );

    const close = document.body.querySelector('button[aria-label="Close"]');
    if (!(close instanceof HTMLButtonElement)) throw new Error('Missing close');
    close.focus();
    dispatchTab(true);

    expect(document.activeElement).toBe(query('two'));
  });

  it('pulls Tab back in when focus escaped to content behind the dialog', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    render(
      <DialogModal onClose={() => undefined} title="t" trapFocus>
        <Body />
      </DialogModal>,
    );

    outside.focus();
    dispatchTab();

    expect(document.activeElement).not.toBe(outside);
    expect(document.activeElement).toBe(
      document.body.querySelector('button[aria-label="Close"]'),
    );
  });

  it('lets only the topmost nested dialog move focus on Tab', () => {
    function Harness(): JSX.Element {
      const [childOpen, setChildOpen] = useState(false);
      return (
        <DialogModal onClose={() => undefined} title="Parent" trapFocus>
          <button
            type="button"
            data-testid="open-child"
            onClick={() => setChildOpen(true)}
          >
            Open child
          </button>
          {childOpen ? (
            <DialogModal
              onClose={() => setChildOpen(false)}
              title="Child"
              trapFocus
            >
              <button type="button" data-testid="child-last">
                Child action
              </button>
            </DialogModal>
          ) : null}
        </DialogModal>
      );
    }

    render(<Harness />);
    act(() => query('open-child').click());

    const parentClose = document.body.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Close"]',
    )[0];
    const parentFocus = jest.spyOn(parentClose, 'focus');
    query('child-last').focus();
    parentFocus.mockClear();

    dispatchTab();

    expect(parentFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      document.body.querySelectorAll('button[aria-label="Close"]')[1],
    );
  });

  it('restores focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { root } = render(
      <DialogModal onClose={() => undefined} title="t" trapFocus>
        <Body />
      </DialogModal>,
    );
    expect(document.activeElement).not.toBe(opener);

    act(() => root.unmount());

    expect(document.activeElement).toBe(opener);
  });

  it('does NOT reclaim focus another surface already took', () => {
    const opener = document.createElement('button');
    const claimant = document.createElement('button');
    document.body.append(opener, claimant);
    opener.focus();

    const { root } = render(
      <DialogModal onClose={() => undefined} title="t" trapFocus>
        <Body />
      </DialogModal>,
    );

    // Stand in for a caller reopening its own surface as the dialog resolves.
    claimant.focus();
    act(() => root.unmount());

    expect(document.activeElement).toBe(claimant);
  });

  it('falls back when confirming removed the element that opened it', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { root } = render(
      <DialogModal onClose={() => undefined} title="t" trapFocus>
        <Body />
      </DialogModal>,
    );

    // The confirmed action destroys its own trigger — removing a member,
    // revoking a key. Focusing a detached node is a silent no-op.
    opener.remove();
    act(() => root.unmount());

    expect(document.activeElement).toBe(document.body);
  });

  it('restores to the named tab when a removed menu leaves body focused on open', () => {
    const tab = document.createElement('button');
    document.body.append(tab);
    expect(document.activeElement).toBe(document.body);
    const { root } = render(
      <DialogModal
        onClose={() => undefined}
        title="Rename chat"
        trapFocus
        restoreFocusRef={{ current: tab }}
      >
        <Body />
      </DialogModal>,
    );
    act(() => root.unmount());
    expect(document.activeElement).toBe(tab);
    tab.remove();
  });

  it('restores to restoreFocusRef when the opener is gone', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    // The fallback must OUTLIVE the dialog, so unmount only the dialog. Tearing
    // down the whole root would detach the fallback too, and this would then
    // assert `<body>` and pass even if `restoreFocusRef` were never read.
    function Harness({ show }: { show: boolean }): JSX.Element {
      const ref = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <button type="button" ref={ref} data-testid="fallback">
            Fallback
          </button>
          {show && (
            <DialogModal
              onClose={() => undefined}
              title="t"
              trapFocus
              restoreFocusRef={ref}
            >
              <Body />
            </DialogModal>
          )}
        </>
      );
    }
    const { root } = render(<Harness show />);

    const fallback = query('fallback');
    // The confirmed action destroyed the control that opened the dialog.
    opener.remove();
    act(() => {
      root.render(<Harness show={false} />);
    });

    expect(document.activeElement).toBe(fallback);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('prefers the first focusable when initialFocusRef names a disabled node', () => {
    // Callers name a semantic target ("Cancel"), which can be disabled at
    // mount — ConfirmDialog disables Cancel while busy. Focusing it would
    // silently no-op and strand focus on <body> inside an aria-modal surface.
    function Harness(): JSX.Element {
      const ref = useRef<HTMLButtonElement | null>(null);
      return (
        <DialogModal
          onClose={() => undefined}
          title="t"
          trapFocus
          initialFocusRef={ref}
        >
          <button type="button" ref={ref} disabled data-testid="disabled">
            Disabled
          </button>
          <button type="button" data-testid="two">
            Two
          </button>
        </DialogModal>
      );
    }
    render(<Harness />);

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(
      document.body.querySelector('button[aria-label="Close"]'),
    );
  });

  it('holds Tab rather than letting it escape when nothing is focusable', () => {
    render(
      <DialogModal
        onClose={() => undefined}
        title="t"
        trapFocus
        headerBorder={false}
      >
        <span>no focusable content</span>
      </DialogModal>,
    );

    // The header close button is always focusable, so removing it is the only
    // way to reach the empty case; assert the guard holds the event instead.
    const close = document.body.querySelector('button[aria-label="Close"]');
    close?.remove();

    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });
});

it('adds no session-replay block to the card or overlay', () => {
  render(
    <DialogModal onClose={jest.fn()} title="Dialog title">
      <p>Body</p>
    </DialogModal>,
  );
  // Dialogs are recorded; blocked content inside a dialog carries its own
  // block.
  expect(document.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  unmountAllRoots();
  document.body.innerHTML = '';
});

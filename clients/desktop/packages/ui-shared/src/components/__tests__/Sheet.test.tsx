/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DialogModal } from '../DialogModal';
import { Sheet } from '../Sheet';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: JSX.Element): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

// `Sheet` portals to `<body>` (so no ancestor containing block can re-anchor a
// `position: fixed` scrim), which is why every query below scopes to
// `document.body` rather than to the mount container.
function getOverlay(): HTMLElement {
  const overlay = document.body.querySelector(
    '[data-canopy-browser-native-overlay="true"]',
  );
  if (!(overlay instanceof HTMLElement)) {
    throw new Error('Sheet overlay is not rendered');
  }
  return overlay;
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

describe('Sheet', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('renders nothing when closed', () => {
    const { root } = render(
      <Sheet
        side="left"
        open={false}
        onClose={jest.fn()}
        ariaLabel="Navigation"
      >
        <div>Body</div>
      </Sheet>,
    );

    try {
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.textContent).toBe('');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('renders the panel with the provided aria-label and test id when open', () => {
    const { root } = render(
      <Sheet
        side="right"
        open={true}
        onClose={jest.fn()}
        ariaLabel="Session details"
        dataTestId="portal-sheet"
      >
        <div>Body</div>
      </Sheet>,
    );

    try {
      const panel = document.body.querySelector('[role="dialog"]');
      expect(panel).not.toBeNull();
      expect(panel?.getAttribute('aria-label')).toBe('Session details');
      expect(panel?.getAttribute('aria-modal')).toBe('true');
      expect(
        document.body.querySelector('[data-testid="portal-sheet"]'),
      ).not.toBeNull();
      expect(document.body.textContent).toContain('Body');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('portals the overlay to <body> so no ancestor can re-anchor it', () => {
    const { container, root } = render(
      <Sheet side="right" open={true} onClose={jest.fn()} ariaLabel="Details">
        <div>Body</div>
      </Sheet>,
    );

    try {
      // `position: fixed` is viewport-relative only while no ancestor
      // establishes a containing block for it. The web app shell's scrolling
      // content region carries `[container-type:size]` for its `100cqh`
      // consumers, which computes to `contain: size layout style` — layout
      // containment does exactly that. Rendering in place would inset this
      // scrim by the sidebar rail's width instead of covering the viewport.
      expect(container.children).toHaveLength(0);
      expect(getOverlay().parentElement).toBe(document.body);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('uses the semantic black scrim without backdrop blur', () => {
    const { root } = render(
      <Sheet side="right" open={true} onClose={jest.fn()} ariaLabel="Details">
        <div>Body</div>
      </Sheet>,
    );

    try {
      const overlay = getOverlay();
      expect(overlay.className).toContain('bg-overlay-scrim');
      expect(overlay.className).not.toContain('backdrop-blur');
      expect(overlay.className).not.toContain('bg-base/');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('slides in from the left with left-edge chrome', () => {
    const { root } = render(
      <Sheet side="left" open={true} onClose={jest.fn()} ariaLabel="Navigation">
        <div>Body</div>
      </Sheet>,
    );

    try {
      const overlay = getOverlay();
      const panel = document.body.querySelector('[role="dialog"]');
      expect(overlay.className).toContain('justify-start');
      expect(panel?.className).toContain('animate-slide-in-left');
      expect(panel?.className).toContain('border-r');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('slides in from the right with right-edge chrome', () => {
    const { root } = render(
      <Sheet side="right" open={true} onClose={jest.fn()} ariaLabel="Details">
        <div>Body</div>
      </Sheet>,
    );

    try {
      const overlay = getOverlay();
      const panel = document.body.querySelector('[role="dialog"]');
      expect(overlay.className).toContain('justify-end');
      expect(panel?.className).toContain('animate-slide-in-right');
      expect(panel?.className).toContain('border-l');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('applies a custom width class name over the default', () => {
    const { root } = render(
      <Sheet
        side="left"
        open={true}
        onClose={jest.fn()}
        ariaLabel="Navigation"
        widthClassName="w-[90vw] max-w-md"
      >
        <div>Body</div>
      </Sheet>,
    );

    try {
      const panel = document.body.querySelector('[role="dialog"]');
      expect(panel?.className).toContain('w-[90vw]');
      expect(panel?.className).toContain('max-w-md');
      expect(panel?.className).not.toContain('max-w-sm');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('closes when clicking the backdrop by default', () => {
    const onClose = jest.fn();
    const { root } = render(
      <Sheet side="left" open={true} onClose={onClose} ariaLabel="Navigation">
        <div>Body</div>
      </Sheet>,
    );

    try {
      const overlay = getOverlay();
      act(() => {
        overlay.click();
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('does not close when clicking inside the panel', () => {
    const onClose = jest.fn();
    const { root } = render(
      <Sheet side="left" open={true} onClose={onClose} ariaLabel="Navigation">
        <button type="button">Inside</button>
      </Sheet>,
    );

    try {
      const button = document.body.querySelector('button');
      if (!button) throw new Error('panel button is not rendered');
      act(() => {
        button.click();
      });
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('does not close on backdrop click when disabled', () => {
    const onClose = jest.fn();
    const { root } = render(
      <Sheet
        side="left"
        open={true}
        onClose={onClose}
        ariaLabel="Navigation"
        closeOnBackdrop={false}
      >
        <div>Body</div>
      </Sheet>,
    );

    try {
      const overlay = getOverlay();
      act(() => {
        overlay.click();
      });
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('closes on Escape by default', () => {
    const onClose = jest.fn();
    const { root } = render(
      <Sheet side="left" open={true} onClose={onClose} ariaLabel="Navigation">
        <div>Body</div>
      </Sheet>,
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

  it('does not listen for Escape while closed', () => {
    const onClose = jest.fn();
    const { root } = render(
      <Sheet side="left" open={false} onClose={onClose} ariaLabel="Navigation">
        <div>Body</div>
      </Sheet>,
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

  it('does not close on Escape when backdrop closing is disabled', () => {
    const onClose = jest.fn();
    const { root } = render(
      <Sheet
        side="left"
        open={true}
        onClose={onClose}
        ariaLabel="Navigation"
        closeOnBackdrop={false}
      >
        <div>Body</div>
      </Sheet>,
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

  it('closes only the topmost stacked sheet on Escape', () => {
    const onBottomClose = jest.fn();
    const onTopClose = jest.fn();
    const { root } = render(
      <>
        <Sheet
          side="left"
          open={true}
          onClose={onBottomClose}
          ariaLabel="Navigation"
        >
          <div>Background</div>
        </Sheet>
        <Sheet
          side="right"
          open={true}
          onClose={onTopClose}
          ariaLabel="Details"
        >
          <div>Foreground</div>
        </Sheet>
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

  it('lets a non-dismissible top sheet consume Escape without closing the sheet below', () => {
    const onBottomClose = jest.fn();
    const onTopClose = jest.fn();
    const { root } = render(
      <>
        <Sheet
          side="left"
          open={true}
          onClose={onBottomClose}
          ariaLabel="Navigation"
        >
          <div>Background</div>
        </Sheet>
        <Sheet
          side="right"
          open={true}
          onClose={onTopClose}
          ariaLabel="Pending details"
          closeOnEscape={false}
        >
          <div>Foreground</div>
        </Sheet>
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

  it('closes only the topmost overlay when a sheet is stacked over a dialog', () => {
    const onDialogClose = jest.fn();
    const onSheetClose = jest.fn();
    const { root } = render(
      <>
        <DialogModal onClose={onDialogClose} title="Settings">
          <div>Dialog body</div>
        </DialogModal>
        <Sheet
          side="right"
          open={true}
          onClose={onSheetClose}
          ariaLabel="Details"
        >
          <div>Sheet body</div>
        </Sheet>
      </>,
    );

    try {
      dispatchEscape();
      expect(onDialogClose).not.toHaveBeenCalled();
      expect(onSheetClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('closes only the topmost overlay when a dialog is stacked over a sheet', () => {
    const onDialogClose = jest.fn();
    const onSheetClose = jest.fn();
    const { root } = render(
      <>
        <Sheet
          side="left"
          open={true}
          onClose={onSheetClose}
          ariaLabel="Navigation"
        >
          <div>Sheet body</div>
        </Sheet>
        <DialogModal onClose={onDialogClose} title="Settings">
          <div>Dialog body</div>
        </DialogModal>
      </>,
    );

    try {
      dispatchEscape();
      expect(onSheetClose).not.toHaveBeenCalled();
      expect(onDialogClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('cleans up its Escape listener on unmount', () => {
    const removeListener = jest.spyOn(document, 'removeEventListener');
    const { root } = render(
      <Sheet side="left" open={true} onClose={jest.fn()} ariaLabel="Navigation">
        <div>Body</div>
      </Sheet>,
    );

    act(() => {
      root.unmount();
    });

    const keydownRemoves = removeListener.mock.calls.filter(
      ([type]) => type === 'keydown',
    );
    expect(keydownRemoves).toHaveLength(1);
  });
});

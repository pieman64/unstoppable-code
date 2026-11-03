/** @jest-environment jsdom */

import { act, useRef, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  computeFloatingMenuPosition,
  FLOATING_PICKER_GAP,
  FloatingMenu,
  type FloatingMenuPlacement,
} from '../FloatingMenu';
import { DropdownMenuItem } from '../DropdownMenu';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { resetInputModality } from '../../lib/input-modality';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ANCHOR_RECT = {
  top: 300,
  right: 340,
  bottom: 340,
  left: 300,
  width: 40,
};

describe('computeFloatingMenuPosition', () => {
  it('keeps a fixed-side menu below its anchor and limits its height', () => {
    const position = computeFloatingMenuPosition({
      anchorRect: ANCHOR_RECT,
      menuWidth: 160,
      menuHeight: 400,
      viewportWidth: 800,
      viewportHeight: 600,
      placement: 'bottom-left',
      allowFlip: false,
    });
    expect(position.placement).toBe('bottom-left');
    expect(position.top).toBe(344);
    expect(position.maxHeight).toBe(248);
  });

  it.each([
    ['bottom-left', 'top left'],
    ['bottom-center', 'top center'],
    ['bottom-right', 'top right'],
    ['top-left', 'bottom left'],
    ['top-center', 'bottom center'],
    ['top-right', 'bottom right'],
  ] satisfies ReadonlyArray<[FloatingMenuPlacement, string]>)(
    'maps %s to the anchor-aware %s transform origin',
    (placement, transformOrigin) => {
      const position = computeFloatingMenuPosition({
        anchorRect: ANCHOR_RECT,
        menuWidth: 160,
        menuHeight: 80,
        viewportWidth: 800,
        viewportHeight: 800,
        placement,
      });

      expect(position.placement).toBe(placement);
      expect(position.transformOrigin).toBe(transformOrigin);
    },
  );

  it('flips vertically, shifts into the viewport, and sizes to available height', () => {
    const position = computeFloatingMenuPosition({
      anchorRect: {
        top: 360,
        right: 390,
        bottom: 380,
        left: 370,
        width: 20,
      },
      menuWidth: 160,
      menuHeight: 240,
      viewportWidth: 400,
      viewportHeight: 400,
      placement: 'bottom-left',
    });

    expect(position).toEqual({
      top: 116,
      left: 232,
      maxHeight: 348,
      placement: 'top-right',
      transformOrigin: 'bottom right',
    });
  });
});

interface HarnessProps {
  readonly onFirst?: () => void;
  readonly onThird?: () => void;
}

function Harness({ onFirst, onThird }: HarnessProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Actions
      </button>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        aria-label="Actions"
        data-testid="menu"
        className="w-48"
      >
        <DropdownMenuItem data-testid="first" onClick={onFirst}>
          First
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="disabled" disabled>
          Disabled
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="third" onClick={onThird}>
          Third
        </DropdownMenuItem>
      </FloatingMenu>
    </>
  );
}

function ListboxHarness({
  closeOnSelect = true,
}: {
  readonly closeOnSelect?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="listbox-trigger"
        onClick={() => setOpen((value) => !value)}
      >
        Choose
      </button>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        gap={FLOATING_PICKER_GAP}
        interaction="listbox"
        closeOnSelect={closeOnSelect}
        role="listbox"
        data-testid="listbox"
      >
        <button type="button" role="option" aria-disabled="true">
          Disabled
        </button>
        <button
          type="button"
          role="option"
          aria-selected="true"
          data-testid="selected-option"
        >
          Selected
        </button>
        <button type="button" role="option" data-testid="last-option">
          Last
        </button>
      </FloatingMenu>
    </>
  );
}

function ManualHarness(): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="manual-trigger"
        onClick={() => setOpen(true)}
      >
        Search
      </button>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        interaction="manual"
        role="dialog"
        data-testid="manual-menu"
      >
        <input data-testid="manual-input" aria-label="Search" />
        <div data-testid="manual-scroll-region">Results</div>
      </FloatingMenu>
    </>
  );
}

function ClickThroughHarness({
  onSend,
  onOutside,
  outsidePressSwallowsClick,
}: {
  readonly onSend: () => void;
  readonly onOutside: () => void;
  readonly outsidePressSwallowsClick?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);

  return (
    <>
      <div ref={composerRef}>
        <span ref={anchorRef} />
        <div ref={editorRef} data-testid="editor" />
        <button type="button" data-testid="send" onClick={onSend}>
          Send
        </button>
      </div>
      <button type="button" data-testid="outside" onClick={onOutside}>
        Outside
      </button>
      <FloatingMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        outsidePressBoundaryRef={editorRef}
        outsidePressClickThroughRef={composerRef}
        {...(outsidePressSwallowsClick === undefined
          ? {}
          : { outsidePressSwallowsClick })}
        interaction="manual"
        role="dialog"
        data-testid="click-through-menu"
      >
        <div>Rows</div>
      </FloatingMenu>
    </>
  );
}

describe('FloatingMenu', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // jsdom shares one document across cases; a press in one must not make
    // the next case's open look pointer-driven.
    resetInputModality(document);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function renderHarness(props: HarnessProps = {}): void {
    act(() => root.render(<Harness {...props} />));
  }

  function pressWithMouse(testId: string): void {
    const target = container.querySelector(`[data-testid="${testId}"]`);
    if (!target) throw new Error(`${testId} missing`);
    act(() => {
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
  }

  function clickThroughMenu(): Element | null {
    return document.body.querySelector('[data-testid="click-through-menu"]');
  }

  function trigger(): HTMLButtonElement {
    const element = container.querySelector<HTMLButtonElement>(
      '[data-testid="trigger"]',
    );
    if (!element) throw new Error('Trigger missing');
    return element;
  }

  function menu(): HTMLElement | null {
    return document.body.querySelector('[data-testid="menu"]');
  }

  it('portals only after open, resolves geometry before reveal, and unmounts synchronously', () => {
    renderHarness();
    expect(menu()).toBeNull();

    act(() => trigger().click());
    expect(menu()).not.toBeNull();
    expect(container.contains(menu())).toBe(false);
    expect(menu()?.getAttribute('data-positioned')).toBe('true');
    expect(menu()?.style.visibility).toBe('');
    expect(menu()?.style.position).toBe('fixed');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('first');
    const scrollViewport = menu()?.querySelector(
      '[data-floating-menu-scroll-viewport="true"]',
    );
    expect(menu()?.getAttribute('data-scroll-viewport')).toBe('true');
    expect(scrollViewport?.getAttribute('role')).toBe('presentation');
    expect(
      scrollViewport?.querySelector('[data-testid="first"]'),
    ).not.toBeNull();

    act(() => trigger().click());
    expect(menu()).toBeNull();

    act(() => trigger().click());
    expect(menu()?.getAttribute('data-positioned')).toBe('true');
  });

  it('exposes the resolved height cap to composites with their own scroller', () => {
    renderHarness();
    act(() => trigger().click());
    const cap = menu()?.style.getPropertyValue('--floating-menu-max-height');
    // Mirrors the inline max-height, so an inner list can bound itself to it.
    expect(cap).toMatch(/^\d+(\.\d+)?px$/);
    expect(cap).toBe(menu()?.style.maxHeight);
  });

  it('opens from arrow keys, skips disabled items, activates, and returns focus', () => {
    const onThird = jest.fn();
    renderHarness({ onThird });

    act(() => {
      trigger().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(document.activeElement?.getAttribute('data-testid')).toBe('third');
    expect(menu()?.getAttribute('data-scroll-viewport')).toBe('true');

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(document.activeElement?.getAttribute('data-testid')).toBe('first');

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onThird).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('returns focus without the keyboard ring after a pointer pick', () => {
    renderHarness({ onThird: jest.fn() });
    act(() => {
      trigger().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    const focusSpy = jest.spyOn(trigger(), 'focus');
    act(() => {
      document.activeElement?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      );
    });
    expect(menu()).toBeNull();
    expect(focusSpy).toHaveBeenCalledWith({
      focusVisible: false,
      preventScroll: true,
    });
    focusSpy.mockRestore();
  });

  it('supports typeahead, Escape, Tab, and outside pointer dismissal', () => {
    renderHarness();
    act(() => trigger().click());

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 't', bubbles: true }),
      );
    });
    expect(document.activeElement?.getAttribute('data-testid')).toBe('third');

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());

    act(() => trigger().click());
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });
    expect(menu()).toBeNull();

    act(() => trigger().click());
    act(() => {
      // A real dismissing press delivers the full sequence; the click is
      // swallowed by the dismiss (suppressNextClick) and consumes the trap.
      document.body.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true }),
      );
      document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      document.body.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(menu()).toBeNull();
  });

  it('dismisses on a click-through press without swallowing its click', () => {
    const onSend = jest.fn();
    const onOutside = jest.fn();

    act(() =>
      root.render(
        <ClickThroughHarness onSend={onSend} onOutside={onOutside} />,
      ),
    );
    pressWithMouse('editor');
    expect(clickThroughMenu()).not.toBeNull();

    pressWithMouse('send');
    expect(clickThroughMenu()).toBeNull();
    expect(onSend).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    root = createRoot(container);
    act(() =>
      root.render(
        <ClickThroughHarness onSend={onSend} onOutside={onOutside} />,
      ),
    );
    pressWithMouse('outside');
    expect(clickThroughMenu()).toBeNull();
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('lets every outside press through when it does not swallow clicks', () => {
    const onSend = jest.fn();
    const onOutside = jest.fn();
    act(() =>
      root.render(
        <ClickThroughHarness
          onSend={onSend}
          onOutside={onOutside}
          outsidePressSwallowsClick={false}
        />,
      ),
    );
    pressWithMouse('outside');
    expect(clickThroughMenu()).toBeNull();
    expect(onOutside).toHaveBeenCalledTimes(1);
  });

  it('uses the document that owns the trigger as its portal and event boundary', () => {
    act(() => root.unmount());
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const frameDocument = frame.contentDocument;
    if (!frameDocument) throw new Error('Iframe document missing');
    const frameContainer = frameDocument.createElement('div');
    frameDocument.body.appendChild(frameContainer);
    root = createRoot(frameContainer);

    act(() => root.render(<Harness />));
    const frameTrigger = frameContainer.querySelector<HTMLButtonElement>(
      '[data-testid="trigger"]',
    );
    act(() => frameTrigger?.click());

    expect(
      frameDocument.body.querySelector('[data-testid="menu"]'),
    ).not.toBeNull();
    expect(document.body.querySelector('[data-testid="menu"]')).toBeNull();
  });

  it('portals a modal-owned dropdown to the owning document body', () => {
    container.dataset.canopyOverlayRoot = 'modal';
    renderHarness();

    act(() => trigger().click());

    expect(menu()).not.toBeNull();
    expect(container.contains(menu())).toBe(false);
    expect(document.body.contains(menu())).toBe(true);
    expect(menu()?.className).toContain('canopy-floating-menu');
  });

  function pressKey(key: string): void {
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );
    });
  }

  it('opens from a click with the first row focused but unpainted, and the first arrow paints it', () => {
    const onFirst = jest.fn();
    renderHarness({ onFirst });
    const focusSpy = jest.spyOn(HTMLElement.prototype, 'focus');

    act(() => {
      trigger().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      trigger().click();
    });

    const first = document.body.querySelector<HTMLElement>(
      '[data-testid="first"]',
    );
    expect(document.activeElement).toBe(first);
    // Keyboard focus paints a row like hover, never with the accent ring.
    expect(first?.className).toContain('focus-visible:bg-subtle');
    expect(first?.className).not.toContain('focus-ring');
    // Chromium's option: the row holds focus without the keyboard look.
    expect(
      focusSpy.mock.calls.some(([options]) => options?.focusVisible === false),
    ).toBe(true);
    focusSpy.mockRestore();

    // The first arrow paints the focused row instead of skipping past it.
    pressKey('ArrowDown');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('first');
    // Later arrows move, skipping the disabled row.
    pressKey('ArrowDown');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('third');
    pressKey('ArrowUp');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('first');
    // Enter picks the painted row.
    pressKey('Enter');
    expect(onFirst).toHaveBeenCalledTimes(1);
  });

  it('opens from the keyboard with the first row painted, so the first arrow moves', () => {
    renderHarness();

    act(() => {
      trigger().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      trigger().click();
    });
    expect(document.activeElement?.getAttribute('data-testid')).toBe('first');

    pressKey('ArrowDown');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('third');
  });

  it('uses the 8px picker gap, focuses the selected option, and skips disabled rows', () => {
    expect(FLOATING_PICKER_GAP).toBe(8);
    act(() => root.render(<ListboxHarness />));
    const listboxTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="listbox-trigger"]',
    );

    act(() => listboxTrigger?.click());
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'selected-option',
    );

    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'last-option',
    );
  });

  it('keeps a multi-select menu open when requested and still dismisses immediately', () => {
    act(() => root.render(<ListboxHarness closeOnSelect={false} />));
    const listboxTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="listbox-trigger"]',
    );
    act(() => listboxTrigger?.click());

    const selected = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="selected-option"]',
    );
    act(() => selected?.click());
    expect(
      document.body.querySelector('[data-testid="listbox"]'),
    ).not.toBeNull();

    act(() => {
      selected?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.body.querySelector('[data-testid="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(listboxTrigger);
  });

  it('leaves manual composites in charge of their single internal scroll region', () => {
    act(() => root.render(<ManualHarness />));
    const manualTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="manual-trigger"]',
    );
    act(() => manualTrigger?.click());

    const manualMenu = document.body.querySelector<HTMLElement>(
      '[data-testid="manual-menu"]',
    );
    expect(manualMenu?.getAttribute('data-scroll-viewport')).toBe('false');
    expect(
      manualMenu?.querySelector('[data-floating-menu-scroll-viewport]'),
    ).toBeNull();
    expect(
      manualMenu?.querySelector('[data-testid="manual-scroll-region"]'),
    ).not.toBeNull();
  });

  it('dismisses a manual composite on Tab without returning focus to its trigger', () => {
    act(() => root.render(<ManualHarness />));
    const manualTrigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="manual-trigger"]',
    );
    act(() => manualTrigger?.click());

    const manualInput = document.body.querySelector<HTMLInputElement>(
      '[data-testid="manual-input"]',
    );
    act(() => {
      manualInput?.focus();
      manualInput?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      );
    });

    expect(
      document.body.querySelector('[data-testid="manual-menu"]'),
    ).toBeNull();
    expect(document.activeElement).not.toBe(manualTrigger);
  });
});

describe('FloatingMenu session replay (CAN-3119)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function Harness(): JSX.Element {
    const anchorRef = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={anchorRef} type="button">
          Open
        </button>
        <FloatingMenu
          open
          onOpenChange={jest.fn()}
          anchorRef={anchorRef}
          aria-label="Options"
          data-testid="menu"
          className="w-56"
        >
          <DropdownMenuItem>npm run deploy --prod</DropdownMenuItem>
        </FloatingMenu>
      </>
    );
  }

  it('records the portaled menu root without a replay block', () => {
    act(() => root.render(<Harness />));
    const menu = document.body.querySelector('[data-testid="menu"]');
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
    expect(menu?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(false);
    expect(menu?.className).toBe(
      'rounded-lg bg-quaternary outline-none p-1 shadow-xl canopy-floating-menu  w-56',
    );
  });
});

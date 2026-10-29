import type { CanopyApi, PreferencesData } from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '../../test-utils/preferences';
import type * as SidebarStoreModule from '../../stores/sidebarStore';
import type * as ControllerModule from '../sidebar-preview-controller';

const savePreferencesMock = jest.fn<Promise<PreferencesData>, [unknown]>();

declare global {
  interface Window {
    api: CanopyApi;
  }
}

interface LoadedModules {
  useSidebarStore: typeof SidebarStoreModule.useSidebarStore;
  controller: typeof ControllerModule;
}

interface StubRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Boxes the stubbed `document.querySelector` reports, keyed by the selector
 * the controller looks them up with. Empty by default, so tests that do not
 * care about geometry keep the original "nothing is on screen" behavior.
 */
const stubRects = new Map<string, StubRect>();

/** Registers a box for `selector`, as `getBoundingClientRect` would report it. */
function stubElementBox(
  selector: string,
  box: { left: number; top: number; width: number; height: number },
): void {
  stubRects.set(selector, {
    left: box.left,
    top: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    width: box.width,
    height: box.height,
  });
}

/** The shape the edge watch reads off a pointermove event. */
interface StubPointerEvent {
  pointerType: string;
  clientX: number;
  clientY: number;
}

/** The shape the edge watch reads off a pointerout event. */
interface StubPointerOutEvent {
  pointerType: string;
  relatedTarget: object | null;
}

/**
 * Stands in for `document.activeElement`. `null` unless a test parks keyboard
 * focus inside the preview; `closest`/`matches` answer just enough for the
 * controller's keyboard-focus hold.
 */
let activeElementStub: {
  closest: (selector: string) => object | null;
  matches: (selector: string) => boolean;
} | null = null;

/** Parks keyboard-visible focus inside the preview for the duration of a test. */
function focusKeyboardInsidePreview(): void {
  activeElementStub = {
    closest: (): object => ({}),
    matches: (selector: string): boolean => selector === ':focus-visible',
  };
}

/** Registered pointermove listeners, so the edge watch can be driven directly. */
const pointerMoveListeners = new Set<EventListenerOrEventListenerObject>();
/** Registered pointerout listeners (the pointer-left-the-window signal). */
const pointerOutListeners = new Set<EventListenerOrEventListenerObject>();

function notifyListener(
  listener: EventListenerOrEventListenerObject,
  event: Event,
): void {
  if (typeof listener === 'function') {
    listener(event);
    return;
  }
  listener.handleEvent(event);
}

function createStubPointerEvent(
  type: string,
  properties: StubPointerEvent | StubPointerOutEvent,
): Event {
  const event = new Event(type);
  for (const [name, value] of Object.entries(properties)) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
  return event;
}

/** Delivers one pointermove to whatever the edge watch has registered. */
function dispatchPointerMove(event: StubPointerEvent): void {
  const pointerEvent = createStubPointerEvent('pointermove', event);
  pointerMoveListeners.forEach((listener) =>
    notifyListener(listener, pointerEvent),
  );
}

/** Delivers one pointerout to whatever the edge watch has registered. */
function dispatchPointerOut(event: StubPointerOutEvent): void {
  const pointerEvent = createStubPointerEvent('pointerout', event);
  pointerOutListeners.forEach((listener) =>
    notifyListener(listener, pointerEvent),
  );
}

/**
 * Minimal `document` for the node environment: the controller only ever asks
 * whether a sidebar menu is open (a body attribute), whether a modal scrim or
 * hovered preview surface exists (selectors), reads element boxes, and
 * installs observers.
 */
function installDocumentStub(): void {
  const attributes = new Set<string>();
  const documentStub = {
    body: {
      hasAttribute: (name: string): boolean => attributes.has(name),
      setAttribute: (name: string): void => void attributes.add(name),
      removeAttribute: (name: string): void => void attributes.delete(name),
    },
    querySelector: (
      selector: string,
    ): { getBoundingClientRect: () => StubRect } | null => {
      const rect = stubRects.get(selector);
      if (rect === undefined) return null;
      return { getBoundingClientRect: (): StubRect => rect };
    },
    querySelectorAll: (): readonly Element[] => [],
    // A getter, not a captured value: the stub is installed before a test
    // parks focus, so a snapshot would always read `null`.
    get activeElement(): typeof activeElementStub {
      return activeElementStub;
    },
  };
  Object.defineProperty(global, 'document', {
    configurable: true,
    value: documentStub,
  });
  Object.defineProperty(global, 'MutationObserver', {
    configurable: true,
    value: class {
      observe(): void {}
      disconnect(): void {}
    },
  });
}

function loadModules(): LoadedModules {
  jest.resetModules();
  installDocumentStub();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        savePreferences: savePreferencesMock,
      },
      addEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
      ): void => {
        if (type === 'pointermove') pointerMoveListeners.add(listener);
        if (type === 'pointerout') pointerOutListeners.add(listener);
      },
      removeEventListener: (
        type: string,
        listener: EventListenerOrEventListenerObject,
      ): void => {
        if (type === 'pointermove') pointerMoveListeners.delete(listener);
        if (type === 'pointerout') pointerOutListeners.delete(listener);
      },
    },
  });

  const { useSidebarStore } = jest.requireActual<typeof SidebarStoreModule>(
    '../../stores/sidebarStore',
  );
  const controller = jest.requireActual<typeof ControllerModule>(
    '../sidebar-preview-controller',
  );
  return { useSidebarStore, controller };
}

function loadHiddenSidebar(): LoadedModules {
  const modules = loadModules();
  modules.useSidebarStore
    .getState()
    .hydrateFromPreferences(makeTestPreferences({ sidebarCollapsed: true }));
  return modules;
}

beforeEach(() => {
  jest.useFakeTimers();
  stubRects.clear();
  pointerMoveListeners.clear();
  pointerOutListeners.clear();
  activeElementStub = null;
  savePreferencesMock.mockReset().mockResolvedValue(makeTestPreferences());
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('requestSidebarPreviewOpen', () => {
  it('opens after the hover dwell delay', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();

    controller.requestSidebarPreviewOpen();
    expect(useSidebarStore.getState().previewing).toBe(false);

    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_OPEN_DELAY_MS);
    expect(useSidebarStore.getState().previewing).toBe(true);
  });

  it('opens immediately for keyboard focus', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();

    controller.requestSidebarPreviewOpen({ immediate: true });

    expect(useSidebarStore.getState().previewing).toBe(true);
  });

  it('does nothing while the sidebar is visible', () => {
    const { useSidebarStore, controller } = loadModules();

    controller.requestSidebarPreviewOpen();
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_OPEN_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(false);
  });

  it('does not open when the sidebar was pinned during the dwell delay', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();

    controller.requestSidebarPreviewOpen();
    useSidebarStore.getState().setHidden(false);
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_OPEN_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(false);
  });

  it('cancels a pending close so re-entering keeps the preview open', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();
    controller.requestSidebarPreviewOpen({ immediate: true });
    controller.requestSidebarPreviewClose();

    controller.requestSidebarPreviewOpen();
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_CLOSE_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(true);
  });
});

describe('cancelSidebarPreviewOpen', () => {
  it('cancels a pending delayed open', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();

    controller.requestSidebarPreviewOpen();
    controller.cancelSidebarPreviewOpen();
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_OPEN_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(false);
  });
});

describe('requestSidebarPreviewClose', () => {
  it('closes after the grace period', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();
    controller.requestSidebarPreviewOpen({ immediate: true });

    controller.requestSidebarPreviewClose();
    expect(useSidebarStore.getState().previewing).toBe(true);

    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_CLOSE_DELAY_MS);
    expect(useSidebarStore.getState().previewing).toBe(false);
  });

  it('closes immediately when requested', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();
    controller.requestSidebarPreviewOpen({ immediate: true });

    controller.requestSidebarPreviewClose({ immediate: true });

    expect(useSidebarStore.getState().previewing).toBe(false);
  });

  it('cancels a pending delayed open (pointer passed through the toggle)', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();

    controller.requestSidebarPreviewOpen();
    controller.requestSidebarPreviewClose();
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_OPEN_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(false);
  });

  it('never persists preferences', () => {
    const { controller } = loadHiddenSidebar();
    savePreferencesMock.mockClear();

    controller.requestSidebarPreviewOpen({ immediate: true });
    controller.requestSidebarPreviewClose({ immediate: true });

    expect(savePreferencesMock).not.toHaveBeenCalled();
  });
});

describe('menu-deferred close', () => {
  it('still closes after the menu clears when the leave had no destination', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();
    controller.requestSidebarPreviewOpen({ immediate: true });
    expect(useSidebarStore.getState().previewing).toBe(true);

    // A sidebar menu is open and the pointer left to nowhere the renderer can
    // see (a window-drag region). The recheck must hand off to the menu
    // deferral rather than dropping the close: by the time the menu closes the
    // pointer is already outside, so no further pointer event will arrive.
    document.body.setAttribute('data-sidebar-menu-open', '');
    controller.requestSidebarPreviewClose({ unknownDestination: true });
    jest.advanceTimersByTime(
      controller.SIDEBAR_PREVIEW_UNKNOWN_LEAVE_RECHECK_MS,
    );
    expect(useSidebarStore.getState().previewing).toBe(true);

    document.body.removeAttribute('data-sidebar-menu-open');
    // The observer runs on the attribute change; drive it directly since
    // MutationObserver callbacks are microtasks under fake timers.
    controller.requestSidebarPreviewClose();
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_CLOSE_DELAY_MS);
    expect(useSidebarStore.getState().previewing).toBe(false);
  });
});

describe('cancelSidebarPreviewClose', () => {
  it('keeps the preview open when the pointer re-enters within the grace period', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();
    controller.requestSidebarPreviewOpen({ immediate: true });

    controller.requestSidebarPreviewClose();
    controller.cancelSidebarPreviewClose();
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_CLOSE_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(true);
  });
});

describe('handleSidebarEdgePointerMove', () => {
  const PANEL = '[data-testid="sidebar-panel"]';
  const CORNER = '[data-testid="app-titlebar-corner"]';

  /** A revealed 220px panel with the titlebar corner across the top-left. */
  function stubRevealedSidebar(): void {
    stubElementBox(PANEL, { left: 0, top: 0, width: 220, height: 900 });
    stubElementBox(CORNER, { left: 0, top: 0, width: 212, height: 40 });
  }

  it('reveals the hidden sidebar when the pointer reaches the left edge', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();
    // Below the titlebar, so only the edge itself can explain the reveal.
    stubElementBox(CORNER, { left: 0, top: 0, width: 212, height: 40 });

    controller.handleSidebarEdgePointerMove({
      x: controller.SIDEBAR_EDGE_TRIGGER_PX,
      y: 400,
    });

    // Immediate, matching the toggle: no dwell to wait out.
    expect(useSidebarStore.getState().previewing).toBe(true);
  });

  it('ignores travel just outside the edge band', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();

    controller.handleSidebarEdgePointerMove({
      x: controller.SIDEBAR_EDGE_TRIGGER_PX + 1,
      y: 400,
    });
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_OPEN_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(false);
  });

  it('leaves the window controls alone at the same edge', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();
    stubElementBox(CORNER, { left: 0, top: 0, width: 212, height: 40 });

    // Reaching for a traffic light travels through the very same band.
    controller.handleSidebarEdgePointerMove({ x: 1, y: 20 });
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_OPEN_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(false);
  });

  it('does nothing while the sidebar is pinned open', () => {
    const { useSidebarStore, controller } = loadModules();

    controller.handleSidebarEdgePointerMove({ x: 0, y: 400 });
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_OPEN_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(false);
  });

  it('closes a preview the panel never saw the pointer enter', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();
    stubRevealedSidebar();
    controller.handleSidebarEdgePointerMove({ x: 0, y: 400 });
    expect(useSidebarStore.getState().previewing).toBe(true);

    // A brush past the edge: the panel mounts a frame later, by which time the
    // pointer is already elsewhere, so it never receives an enter — and so no
    // leave of its own would ever arrive to dismiss the preview.
    controller.handleSidebarEdgePointerMove({ x: 700, y: 400 });
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_CLOSE_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(false);
  });

  it('keeps the preview open while the pointer is over the panel', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();
    stubRevealedSidebar();
    controller.handleSidebarEdgePointerMove({ x: 0, y: 400 });

    controller.handleSidebarEdgePointerMove({ x: 120, y: 500 });
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_CLOSE_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(true);
  });

  it('keeps the preview open while a sidebar menu is being used', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();
    stubRevealedSidebar();
    controller.handleSidebarEdgePointerMove({ x: 0, y: 400 });

    // Sidebar menus portal outside the panel, so using one puts the pointer
    // legitimately outside its box. The panel's own leave handler already
    // defers that close until the menu clears; this must not pre-empt it.
    document.body.setAttribute('data-sidebar-menu-open', '');
    controller.handleSidebarEdgePointerMove({ x: 400, y: 500 });
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_CLOSE_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(true);
  });
});

describe('startSidebarEdgeHoverWatch', () => {
  it('reveals the sidebar from pointer travel and stops on teardown', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();

    const stop = controller.startSidebarEdgeHoverWatch();
    expect(pointerMoveListeners.size).toBe(1);
    dispatchPointerMove({ pointerType: 'mouse', clientX: 0, clientY: 400 });
    expect(useSidebarStore.getState().previewing).toBe(true);

    stop();
    expect(pointerMoveListeners.size).toBe(0);
  });

  it('ignores touch pointers, which have no hover to speak of', () => {
    const { useSidebarStore, controller } = loadHiddenSidebar();

    controller.startSidebarEdgeHoverWatch();
    dispatchPointerMove({ pointerType: 'touch', clientX: 0, clientY: 400 });
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_OPEN_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(false);
  });
});

describe('edge watch — pointer leaving the window', () => {
  const PANEL = '[data-testid="sidebar-panel"]';
  const CORNER = '[data-testid="app-titlebar-corner"]';

  function revealedFromEdge(): ReturnType<typeof loadHiddenSidebar> {
    const modules = loadHiddenSidebar();
    stubElementBox(PANEL, { left: 0, top: 0, width: 220, height: 900 });
    stubElementBox(CORNER, { left: 0, top: 0, width: 212, height: 40 });
    modules.controller.startSidebarEdgeHoverWatch();
    dispatchPointerMove({ pointerType: 'mouse', clientX: 0, clientY: 400 });
    expect(modules.useSidebarStore.getState().previewing).toBe(true);
    return modules;
  }

  it('closes a preview the pointer left the window from', () => {
    const { useSidebarStore, controller } = revealedFromEdge();

    // Opening at the edge and continuing off the window delivers no further
    // move to read, and a panel that mounted after the pointer had gone never
    // received an enter — so it has no leave of its own either.
    dispatchPointerOut({ pointerType: 'mouse', relatedTarget: null });
    jest.advanceTimersByTime(
      controller.SIDEBAR_PREVIEW_UNKNOWN_LEAVE_RECHECK_MS,
    );

    expect(useSidebarStore.getState().previewing).toBe(false);
  });

  it('ignores a leave that names a destination inside the page', () => {
    const { useSidebarStore, controller } = revealedFromEdge();

    // An ordinary element-to-element transition is not the pointer leaving the
    // web contents, so it must not reach the close path at all.
    dispatchPointerOut({ pointerType: 'mouse', relatedTarget: {} });
    jest.advanceTimersByTime(
      controller.SIDEBAR_PREVIEW_UNKNOWN_LEAVE_RECHECK_MS,
    );

    expect(useSidebarStore.getState().previewing).toBe(true);
  });

  it('holds while a sidebar menu is open', () => {
    const { useSidebarStore, controller } = revealedFromEdge();

    document.body.setAttribute('data-sidebar-menu-open', '');
    dispatchPointerOut({ pointerType: 'mouse', relatedTarget: null });
    jest.advanceTimersByTime(
      controller.SIDEBAR_PREVIEW_UNKNOWN_LEAVE_RECHECK_MS,
    );

    expect(useSidebarStore.getState().previewing).toBe(true);
  });

  it('detaches the window-leave listener on teardown', () => {
    const { controller } = loadHiddenSidebar();

    const stop = controller.startSidebarEdgeHoverWatch();
    expect(pointerOutListeners.size).toBe(1);
    stop();

    expect(pointerOutListeners.size).toBe(0);
  });
});

describe('edge watch — keyboard-opened previews', () => {
  const PANEL = '[data-testid="sidebar-panel"]';
  const CORNER = '[data-testid="app-titlebar-corner"]';

  function revealedByKeyboard(): ReturnType<typeof loadHiddenSidebar> {
    const modules = loadHiddenSidebar();
    stubElementBox(PANEL, { left: 0, top: 0, width: 220, height: 900 });
    stubElementBox(CORNER, { left: 0, top: 0, width: 212, height: 40 });
    modules.controller.requestSidebarPreviewOpenFromFocus();
    focusKeyboardInsidePreview();
    expect(modules.useSidebarStore.getState().previewing).toBe(true);
    return modules;
  }

  it('survives incidental pointer travel outside the panel', () => {
    const { useSidebarStore, controller } = revealedByKeyboard();

    // The preview belongs to the keyboard; the pointer may be resting anywhere,
    // and a nudge must not collapse a sidebar being navigated by tab.
    controller.handleSidebarEdgePointerMove({ x: 900, y: 500 });
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_CLOSE_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(true);
  });

  it('survives the pointer leaving the window', () => {
    const { useSidebarStore, controller } = revealedByKeyboard();
    controller.startSidebarEdgeHoverWatch();

    dispatchPointerOut({ pointerType: 'mouse', relatedTarget: null });
    jest.advanceTimersByTime(
      controller.SIDEBAR_PREVIEW_UNKNOWN_LEAVE_RECHECK_MS,
    );

    expect(useSidebarStore.getState().previewing).toBe(true);
  });

  it('still closes on pointer travel once focus is elsewhere', () => {
    const { useSidebarStore, controller } = revealedByKeyboard();

    // Guard the guard: without focus inside the preview the ordinary
    // outside-travel close must still run, or the hold would strand it.
    activeElementStub = null;
    controller.handleSidebarEdgePointerMove({ x: 900, y: 500 });
    jest.advanceTimersByTime(controller.SIDEBAR_PREVIEW_CLOSE_DELAY_MS);

    expect(useSidebarStore.getState().previewing).toBe(false);
  });
});

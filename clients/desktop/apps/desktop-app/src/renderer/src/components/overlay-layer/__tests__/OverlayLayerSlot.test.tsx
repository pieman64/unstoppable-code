/**
 * @jest-environment jsdom
 */
import { act, useEffect, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT } from '@/lib/browserViewBounds';
import * as browserNativeOverlay from '@/lib/browserNativeOverlay';
import * as remoteControlStore from '@/stores/remoteControlStore';
import { useExperimentalFeaturesStore } from '@/stores/experimentalFeaturesStore';
import { useGitHubStore } from '@/stores/githubStore';
import type {
  InAppNotificationPlacement,
  OverlayLayerRect,
  OverlayLayerSlot as OverlayLayerSlotType,
} from '@canopy/desktop-shared/types';
import { OverlayLayerSlot } from '../OverlayLayerSlot';
import { calculateOverlayLayerBounds } from '../overlayLayerBounds';
import { resetOverlayLayersForTests } from '@/lib/overlayLayer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type FrameCallback = (time: number) => void;

const frameQueue = new Map<number, FrameCallback>();
let nextFrameId = 0;
let root: Root | null = null;
let mountPoint: HTMLDivElement | null = null;
let resizeObservers: ControlledResizeObserver[] = [];
let overlayApi: {
  focus: jest.Mock<
    Promise<void>,
    [{ slot: OverlayLayerSlotType; target: 'layer' | 'main' }]
  >;
  setBounds: jest.Mock<
    Promise<void>,
    [{ slot: OverlayLayerSlotType; bounds: OverlayLayerRect | null }]
  >;
};
let openSpy: jest.SpyInstance;

class ControlledResizeObserver implements ResizeObserver {
  static instances: ControlledResizeObserver[] = [];

  readonly targets = new Set<Element>();
  private disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.targets.clear();
  }

  takeRecords(): ResizeObserverEntry[] {
    return [];
  }

  get isDisconnected(): boolean {
    return this.disconnected;
  }

  emit(target: Element, height: number, width = 320): void {
    const rect = new DOMRect(0, 0, width, height);
    const entry = {
      target,
      contentRect: rect,
      borderBoxSize: [{ inlineSize: width, blockSize: height }],
      contentBoxSize: [{ inlineSize: width, blockSize: height }],
      devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }],
    } satisfies ResizeObserverEntry;
    this.callback([entry], this);
  }
}

interface RectInput {
  left: number;
  top: number;
  width: number;
  height: number;
}

function domRect({ left, top, width, height }: RectInput): DOMRect {
  return new DOMRect(left, top, width, height);
}

function setRect(element: Element, rect: DOMRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect,
  });
}

function installFrames(target: Window): void {
  const request = jest.fn((callback: FrameRequestCallback): number => {
    const id = ++nextFrameId;
    frameQueue.set(id, callback);
    return id;
  });
  const cancel = jest.fn((id: number): void => {
    frameQueue.delete(id);
  });
  Object.defineProperty(target, 'requestAnimationFrame', {
    configurable: true,
    value: request,
  });
  Object.defineProperty(target, 'cancelAnimationFrame', {
    configurable: true,
    value: cancel,
  });
}

function flushFrame(): void {
  const callbacks = Array.from(frameQueue.values());
  frameQueue.clear();
  act(() => {
    callbacks.forEach((callback) => callback(16));
  });
}

function installResizeObservers(): void {
  resizeObservers = [];
  ControlledResizeObserver.instances = resizeObservers;
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: ControlledResizeObserver,
  });
}

function installOverlayApi(): void {
  overlayApi = {
    focus: jest.fn<
      Promise<void>,
      [{ slot: OverlayLayerSlotType; target: 'layer' | 'main' }]
    >(() => Promise.resolve()),
    setBounds: jest.fn<
      Promise<void>,
      [{ slot: OverlayLayerSlotType; bounds: OverlayLayerRect | null }]
    >(() => Promise.resolve()),
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { overlayLayer: overlayApi },
    writable: true,
  });
}

function createPopup(): WindowProxy {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const childWindow = iframe.contentWindow;
  if (!childWindow) {
    throw new Error('Expected iframe contentWindow to be available.');
  }
  Object.defineProperty(childWindow, 'ResizeObserver', {
    configurable: true,
    value: ControlledResizeObserver,
  });
  Object.defineProperty(childWindow, 'setTimeout', {
    configurable: true,
    value: window.setTimeout.bind(window),
  });
  Object.defineProperty(childWindow, 'clearTimeout', {
    configurable: true,
    value: window.clearTimeout.bind(window),
  });
  installFrames(childWindow);
  return childWindow;
}

function installPopupWindows(...windows: Array<WindowProxy | null>): void {
  openSpy = jest.spyOn(window, 'open').mockImplementation(() => {
    const next = windows.shift();
    return next ?? null;
  });
}

function addBrowserArea(
  marker: 'true' | 'false',
  rect: RectInput = { left: 700, top: 0, width: 400, height: 600 },
): HTMLDivElement {
  const area = document.createElement('div');
  area.setAttribute('data-browser-native-view-available', marker);
  setRect(area, domRect(rect));
  document.body.appendChild(area);
  return area;
}

function renderSlot(
  children: ReactNode,
  placement:
    | 'top-right'
    | 'bottom-right'
    | 'top-left'
    | 'bottom-left' = 'top-right',
): void {
  mountPoint = document.createElement('div');
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  act(() => {
    root?.render(
      <OverlayLayerSlot slot="notifications" placement={placement}>
        {children}
      </OverlayLayerSlot>,
    );
  });
  const placeholder = getPlaceholder();
  setRect(placeholder, domRect({ left: 900, top: 20, width: 300, height: 60 }));
}

function getPlaceholder(): HTMLDivElement {
  const placeholder = document.querySelector<HTMLDivElement>(
    '[data-testid="overlay-layer-placeholder"]',
  );
  if (!placeholder) {
    throw new Error('Expected an overlay layer placeholder.');
  }
  return placeholder;
}

function getContent(): HTMLDivElement {
  const content = document.querySelector<HTMLDivElement>(
    '[data-testid="overlay-layer-content"]',
  );
  if (!content) {
    throw new Error('Expected the overlay layer content container.');
  }
  return content;
}

function emitContentHeight(height: number): void {
  const content = getContent();
  emitObserverHeight(content, height);
}

function emitObserverHeight(target: Element, height: number): void {
  const observer = [...resizeObservers]
    .reverse()
    .find(
      (candidate) => !candidate.isDisconnected && candidate.targets.has(target),
    );
  if (!observer) {
    throw new Error('Expected an active ResizeObserver for overlay content.');
  }
  act(() => observer.emit(target, height, 300));
}

function requestTopologyEvaluation(): void {
  act(() => {
    window.dispatchEvent(new Event(BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT));
  });
}

let componentMounts = 0;
let componentUnmounts = 0;

function StableToast({ revision }: { revision: number }): JSX.Element {
  useEffect(() => {
    componentMounts += 1;
    return (): void => {
      componentUnmounts += 1;
    };
  }, []);

  return (
    <section data-testid="stable-toast">
      <button
        key={revision}
        data-testid="revisioned-toast"
        data-revision={revision}
      >
        Toast {revision}
      </button>
    </section>
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  frameQueue.clear();
  nextFrameId = 0;
  componentMounts = 0;
  componentUnmounts = 0;
  installResizeObservers();
  installFrames(window);
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1280,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: 800,
  });
  installOverlayApi();
  jest.spyOn(remoteControlStore, 'readRemoteControlContext').mockReturnValue({
    mode: 'local',
  });
  resetOverlayLayersForTests();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  mountPoint = null;
  resetOverlayLayersForTests();
  document.body.replaceChildren();
  useGitHubStore.setState({ toasts: [], notifications: [] });
  useExperimentalFeaturesStore.setState({ enabled: false });
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
  frameQueue.clear();
  resizeObservers = [];
});

describe('OverlayLayerSlot', () => {
  it('keeps an empty stack in the main document without observers or listeners', () => {
    addBrowserArea('true');
    installPopupWindows(createPopup());
    const subscribeSpy = jest.spyOn(
      browserNativeOverlay,
      'subscribeBrowserOverlayTopology',
    );
    const addEventListenerSpy = jest.spyOn(window, 'addEventListener');

    renderSlot(<div data-testid="empty-stack" />);
    const content = getContent();
    emitObserverHeight(content, 0);
    flushFrame();

    expect(openSpy).not.toHaveBeenCalled();
    expect(overlayApi.setBounds).not.toHaveBeenCalled();
    expect(
      getPlaceholder().getAttribute('data-canopy-browser-native-overlay'),
    ).toBe('true');
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(addEventListenerSpy).not.toHaveBeenCalled();
  });

  it('layers only over an intersecting available browser area, after a main-document frame', async () => {
    addBrowserArea('false');
    addBrowserArea('true', { left: 0, top: 500, width: 300, height: 200 });
    const popup = createPopup();
    installPopupWindows(popup);
    renderSlot(<div data-testid="filled-stack">Toast</div>);
    const content = getContent();

    emitContentHeight(60);
    expect(openSpy).not.toHaveBeenCalled();
    flushFrame();
    expect(openSpy).not.toHaveBeenCalled();

    addBrowserArea('true', {
      left: 880,
      top: 0,
      width: 400,
      height: 400,
    });
    requestTopologyEvaluation();
    await act(async () => Promise.resolve());
    flushFrame();

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(content.ownerDocument).toBe(popup.document);
    expect(
      getPlaceholder().getAttribute('data-canopy-browser-native-overlay'),
    ).toBe('false');
  });

  it('moves one portal container between documents without remounting React children', () => {
    const firstWindow = createPopup();
    installPopupWindows(firstWindow);
    const area = addBrowserArea('true');
    renderSlot(<StableToast revision={1} />);
    const originalContent = getContent();
    const firstDescendant = originalContent.querySelector(
      '[data-testid="revisioned-toast"]',
    );
    setRect(
      getPlaceholder(),
      domRect({ left: 900, top: 20, width: 300, height: 60 }),
    );

    emitContentHeight(60);
    flushFrame();

    const iframeDocument = firstWindow.document;
    expect(originalContent.ownerDocument).toBe(iframeDocument);
    expect(iframeDocument.body.contains(originalContent)).toBe(true);
    expect(componentMounts).toBe(1);
    expect(componentUnmounts).toBe(0);
    expect(
      getPlaceholder().getAttribute('data-canopy-browser-native-overlay'),
    ).toBe('false');
    expect(getPlaceholder().style.height).toBe('60px');

    act(() => {
      root?.render(
        <OverlayLayerSlot slot="notifications" placement="top-right">
          <StableToast revision={2} />
        </OverlayLayerSlot>,
      );
    });
    const updatedDescendant = iframeDocument.querySelector(
      '[data-testid="revisioned-toast"]',
    );
    expect(updatedDescendant).not.toBe(firstDescendant);
    expect(updatedDescendant?.ownerDocument).toBe(iframeDocument);
    expect(updatedDescendant?.getAttribute('data-revision')).toBe('2');
    expect(componentMounts).toBe(1);

    const callsBeforeUnlayer = overlayApi.setBounds.mock.calls.length;
    area.remove();
    requestTopologyEvaluation();
    flushFrame();
    expect(overlayApi.setBounds).toHaveBeenCalledTimes(callsBeforeUnlayer);
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).not.toBeNull();
    flushFrame();
    expect(overlayApi.setBounds).toHaveBeenCalledTimes(callsBeforeUnlayer + 1);
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).toBeNull();

    expect(originalContent.ownerDocument).toBe(document);
    expect(getPlaceholder().contains(originalContent)).toBe(true);
    expect(
      originalContent.querySelector('[data-testid="revisioned-toast"]')
        ?.ownerDocument,
    ).toBe(document);
    expect(
      getPlaceholder().getAttribute('data-canopy-browser-native-overlay'),
    ).toBe('true');
    expect(getPlaceholder().style.height).toBe('');

    act(() => {
      root?.render(
        <OverlayLayerSlot slot="notifications" placement="top-right">
          <StableToast revision={3} />
        </OverlayLayerSlot>,
      );
    });
    expect(
      originalContent.querySelector('[data-testid="revisioned-toast"]')
        ?.ownerDocument,
    ).toBe(document);
    expect(
      originalContent
        .querySelector('[data-testid="revisioned-toast"]')
        ?.getAttribute('data-revision'),
    ).toBe('3');
    expect(componentMounts).toBe(1);
    expect(componentUnmounts).toBe(0);
  });

  it('unlayers immediately when content height reaches zero', () => {
    const popup = createPopup();
    installPopupWindows(popup);
    addBrowserArea('true');
    renderSlot(<div>Toast</div>);
    const content = getContent();
    emitContentHeight(60);
    expect(openSpy).not.toHaveBeenCalled();
    flushFrame();
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(content.ownerDocument).toBe(popup.document);

    emitObserverHeight(content, 0);

    expect(content.ownerDocument).toBe(document);
    expect(getPlaceholder().style.height).toBe('');
    expect(
      getPlaceholder().getAttribute('data-canopy-browser-native-overlay'),
    ).toBe('true');
  });

  it('keeps a leaving toast in the layer until its exit finishes', async () => {
    const popup = createPopup();
    installPopupWindows(popup);
    addBrowserArea('true');
    const leaving = (
      <div>
        <div data-testid="leaving-toast" data-ending-style="">
          Toast
        </div>
      </div>
    );
    renderSlot(<div data-testid="leaving-toast">Toast</div>);
    const content = getContent();
    emitContentHeight(60);
    flushFrame();
    expect(content.ownerDocument).toBe(popup.document);

    // The last card starts to leave: the stack drops its reserved height at
    // once, while the card is still sliding out.
    act(() => {
      root?.render(
        <OverlayLayerSlot slot="notifications" placement="top-right">
          {leaving}
        </OverlayLayerSlot>,
      );
    });
    const hideCallsBefore = overlayApi.setBounds.mock.calls.filter(
      ([request]) => request.bounds === null,
    ).length;
    emitObserverHeight(content, 0);
    await act(async () => Promise.resolve());
    flushFrame();

    // Compared as booleans: Jest cannot print a cross-realm Document diff.
    expect(content.ownerDocument === popup.document).toBe(true);
    expect(
      content.querySelector('[data-testid="leaving-toast"]')?.ownerDocument ===
        popup.document,
    ).toBe(true);
    expect(
      overlayApi.setBounds.mock.calls.filter(
        ([request]) => request.bounds === null,
      ),
    ).toHaveLength(hideCallsBefore);

    // Once the card is gone the stack is empty for real.
    act(() => {
      root?.render(
        <OverlayLayerSlot slot="notifications" placement="top-right">
          {null}
        </OverlayLayerSlot>,
      );
    });
    await act(async () => Promise.resolve());
    flushFrame();

    expect(content.ownerDocument).toBe(document);
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).toBeNull();
  });

  it('recomputes bounds and anchored edges when placement changes while layered', () => {
    const popup = createPopup();
    installPopupWindows(popup);
    addBrowserArea('true');
    renderSlot(<div>Toast</div>);
    const content = getContent();
    emitContentHeight(60);
    flushFrame();

    const initialBoundsCalls = overlayApi.setBounds.mock.calls.length;
    act(() => {
      root?.render(
        <OverlayLayerSlot slot="notifications" placement="bottom-left">
          <div>Toast</div>
        </OverlayLayerSlot>,
      );
    });
    expect(overlayApi.setBounds).toHaveBeenCalledTimes(initialBoundsCalls);
    flushFrame();

    expect(overlayApi.setBounds).toHaveBeenCalledTimes(initialBoundsCalls + 1);
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).toEqual({
      x: 0,
      y: 8,
      width: 1212,
      height: 108,
    });
    expect(content.style.left).toBe('900px');
    expect(content.style.right).toBe('');
    expect(content.style.top).toBe('');
    expect(content.style.bottom).toBe('36px');
  });

  it('routes F6 and focusout through the live layer only', () => {
    const popup = createPopup();
    installPopupWindows(popup);
    addBrowserArea('true');
    renderSlot(<button>Toast</button>);
    const content = getContent();
    emitContentHeight(60);
    flushFrame();
    const layerDocument = popup.document;
    const keydown = new KeyboardEvent('keydown', { key: 'F6', bubbles: true });
    window.dispatchEvent(keydown);
    expect(overlayApi.focus).toHaveBeenCalledWith({
      slot: 'notifications',
      target: 'layer',
    });
    expect(keydown.defaultPrevented).toBe(false);

    overlayApi.focus.mockClear();
    Object.defineProperty(layerDocument, 'hasFocus', {
      configurable: true,
      value: () => false,
    });
    layerDocument.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    jest.advanceTimersByTime(0);
    expect(overlayApi.focus).not.toHaveBeenCalled();

    Object.defineProperty(layerDocument, 'hasFocus', {
      configurable: true,
      value: () => true,
    });
    layerDocument.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    jest.advanceTimersByTime(0);
    expect(overlayApi.focus).toHaveBeenLastCalledWith({
      slot: 'notifications',
      target: 'main',
    });

    addBrowserArea('false', { left: 0, top: 500, width: 300, height: 200 });
    document
      .querySelector('[data-browser-native-view-available="true"]')
      ?.remove();
    requestTopologyEvaluation();
    flushFrame();
    const callsBeforeMainF6 = overlayApi.focus.mock.calls.length;
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F6', bubbles: true }),
    );
    expect(overlayApi.focus).toHaveBeenCalledTimes(callsBeforeMainF6);
    expect(content.ownerDocument).toBe(document);
  });

  it('returns content on layer loss, cancels stale geometry work, and reopens on the next trigger', () => {
    const firstWindow = createPopup();
    const secondWindow = createPopup();
    installPopupWindows(firstWindow, secondWindow);
    addBrowserArea('true');
    renderSlot(<div>Toast</div>);
    const content = getContent();
    emitContentHeight(60);
    flushFrame();
    expect(content.ownerDocument).toBe(firstWindow.document);
    const initialBoundsCalls = overlayApi.setBounds.mock.calls.length;

    requestTopologyEvaluation();
    firstWindow.dispatchEvent(new Event('pagehide'));
    flushFrame();

    expect(content.ownerDocument).toBe(document);
    expect(
      getPlaceholder().getAttribute('data-canopy-browser-native-overlay'),
    ).toBe('true');
    expect(overlayApi.setBounds).toHaveBeenCalledTimes(initialBoundsCalls);

    requestTopologyEvaluation();
    flushFrame();
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(content.ownerDocument).toBe(secondWindow.document);
  });

  it('stays in the main document after an unsuccessful popup open without retrying', () => {
    installPopupWindows(null);
    addBrowserArea('true');
    renderSlot(<div>Toast</div>);
    emitContentHeight(60);
    flushFrame();

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(getContent().ownerDocument).toBe(document);
    expect(
      getPlaceholder().getAttribute('data-canopy-browser-native-overlay'),
    ).toBe('true');
    expect(overlayApi.setBounds).not.toHaveBeenCalled();

    requestTopologyEvaluation();
    flushFrame();
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('grows bounds on the next frame, delays only shrink, and drops a pending hide when reused', () => {
    const popup = createPopup();
    installPopupWindows(popup);
    const area = addBrowserArea('true');
    renderSlot(<div>Toast</div>);
    const content = getContent();
    emitContentHeight(60);
    flushFrame();

    const initialCalls = overlayApi.setBounds.mock.calls.length;
    requestTopologyEvaluation();
    flushFrame();
    expect(overlayApi.setBounds).toHaveBeenCalledTimes(initialCalls);

    setRect(
      getPlaceholder(),
      domRect({ left: 850, top: 40, width: 400, height: 60 }),
    );
    requestTopologyEvaluation();
    expect(overlayApi.setBounds).toHaveBeenCalledTimes(initialCalls);
    flushFrame();
    expect(overlayApi.setBounds).toHaveBeenCalledTimes(initialCalls + 1);
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).toEqual({
      x: 838,
      y: 28,
      width: 442,
      height: 108,
    });

    setRect(
      getPlaceholder(),
      domRect({ left: 860, top: 50, width: 400, height: 50 }),
    );
    requestTopologyEvaluation();
    flushFrame();
    const beforeShrinkSettles = overlayApi.setBounds.mock.calls.length;
    jest.advanceTimersByTime(449);
    expect(overlayApi.setBounds).toHaveBeenCalledTimes(beforeShrinkSettles);
    jest.advanceTimersByTime(1);
    expect(overlayApi.setBounds).toHaveBeenCalledTimes(beforeShrinkSettles + 1);

    area.remove();
    requestTopologyEvaluation();
    flushFrame();
    expect(content.ownerDocument).toBe(document);
    const beforePendingHide = overlayApi.setBounds.mock.calls.length;
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).not.toBeNull();

    addBrowserArea('true');
    requestTopologyEvaluation();
    flushFrame();

    expect(content.ownerDocument).toBe(popup.document);
    expect(overlayApi.setBounds).toHaveBeenCalledTimes(beforePendingHide);
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).not.toBeNull();
  });

  it('covers bottom-right content growth in the same bounds evaluation', () => {
    const popup = createPopup();
    installPopupWindows(popup);
    addBrowserArea('true', { left: 700, top: 0, width: 400, height: 800 });
    renderSlot(<div>Toast</div>, 'bottom-right');
    const placeholder = getPlaceholder();
    Object.defineProperty(placeholder, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const height = Number.parseFloat(placeholder.style.height) || 60;
        return domRect({
          left: 900,
          top: 780 - height,
          width: 300,
          height,
        });
      },
    });
    const content = getContent();

    emitContentHeight(60);
    flushFrame();
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).toEqual({
      x: 888,
      y: 708,
      width: 392,
      height: 92,
    });

    emitObserverHeight(content, 100);
    flushFrame();

    expect(placeholder.style.height).toBe('100px');
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).toEqual({
      x: 888,
      y: 668,
      width: 392,
      height: 132,
    });
  });

  it('observes expanded and swipe attributes inside the adopted content', async () => {
    const popup = createPopup();
    installPopupWindows(popup);
    addBrowserArea('true');
    renderSlot(
      <div>
        <div data-testid="motion-toast">Toast</div>
      </div>,
    );
    const content = getContent();
    const motionToast = content.querySelector<HTMLElement>(
      '[data-testid="motion-toast"]',
    );
    if (!motionToast) {
      throw new Error('Expected the motion test toast.');
    }

    emitContentHeight(60);
    flushFrame();
    expect(content.ownerDocument).toBe(popup.document);

    motionToast.setAttribute('data-expanded', '');
    await act(async () => Promise.resolve());
    flushFrame();
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).toEqual({
      x: 888,
      y: 8,
      width: 392,
      height: 792,
    });

    motionToast.removeAttribute('data-expanded');
    motionToast.setAttribute('data-ending-style', '');
    motionToast.setAttribute('data-swipe-flung', '');
    await act(async () => Promise.resolve());
    flushFrame();
    // A swipe extends the far edge only; the origin stays where the press
    // started.
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).toEqual({
      x: 888,
      y: 8,
      width: 392,
      height: 792,
    });
  });

  it('keeps a hovered bottom stack origin fixed for a press held past the swipe transition', async () => {
    const popup = createPopup();
    installPopupWindows(popup);
    addBrowserArea('true', { left: 700, top: 0, width: 400, height: 800 });
    renderSlot(
      <div>
        <div data-testid="motion-toast">Toast</div>
      </div>,
      'bottom-right',
    );
    setRect(
      getPlaceholder(),
      domRect({ left: 900, top: 720, width: 300, height: 60 }),
    );
    const content = getContent();
    const motionToast = content.querySelector<HTMLElement>(
      '[data-testid="motion-toast"]',
    );
    if (!motionToast) {
      throw new Error('Expected the motion test toast.');
    }
    emitContentHeight(60);
    flushFrame();
    expect(content.ownerDocument).toBe(popup.document);

    motionToast.setAttribute('data-expanded', '');
    await act(async () => Promise.resolve());
    flushFrame();
    const hovered = overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds;
    expect(hovered).toMatchObject({ y: 0 });

    motionToast.setAttribute('data-swipe-dragging', '');
    await act(async () => Promise.resolve());
    flushFrame();
    jest.advanceTimersByTime(450);
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).toEqual(
      hovered,
    );
  });

  it('recreates motion observation in the main document after unlayering', async () => {
    const popup = createPopup();
    installPopupWindows(popup);
    const area = addBrowserArea('true');
    renderSlot(<div data-testid="focus-test-toast">Toast</div>);
    const content = getContent();
    emitContentHeight(60);
    flushFrame();

    const movedToast = content.querySelector<HTMLElement>(
      '[data-testid="focus-test-toast"]',
    );
    if (!movedToast) {
      throw new Error('Expected the focus test toast.');
    }
    movedToast.setAttribute('data-expanded', '');
    await act(async () => Promise.resolve());
    flushFrame();
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds?.height).toBe(
      792,
    );

    area.remove();
    requestTopologyEvaluation();
    flushFrame();
    expect(content.ownerDocument).toBe(document);
    movedToast.removeAttribute('data-expanded');
    await act(async () => Promise.resolve());
    flushFrame();
    expect(overlayApi.setBounds.mock.calls.at(-1)?.[0]?.bounds).toBeNull();
  });
});

describe('overlay layer bounds', () => {
  const rect = domRect({ left: 800.3, top: 40.2, width: 180.2, height: 60.4 });

  it.each([
    ['top-right', { x: 788, y: 28, width: 212, height: 109 }],
    ['bottom-right', { x: 788, y: 28, width: 212, height: 109 }],
    ['top-left', { x: 0, y: 28, width: 993, height: 109 }],
    ['bottom-left', { x: 0, y: 28, width: 993, height: 109 }],
  ] as const)(
    'adds the shadow margin (12px, 36px below) and grows toward the viewport edge for %s',
    (placement, expected) => {
      expect(
        calculateOverlayLayerBounds(rect, placement, 1000, 200, false, false),
      ).toEqual(expected);
    },
  );

  // A mouse hovers (spreads) the stack before its press starts a swipe.
  const placementExpansionCases: Array<[InAppNotificationPlacement, boolean]> =
    (['top-right', 'bottom-right', 'top-left', 'bottom-left'] as const).flatMap(
      (placement): Array<[InAppNotificationPlacement, boolean]> =>
        [false, true].map((expanded): [InAppNotificationPlacement, boolean] => [
          placement,
          expanded,
        ]),
    );

  it.each(placementExpansionCases)(
    'keeps the layer origin fixed when a %s swipe starts (expanded: %s), so a press stays a click',
    (placement, expanded) => {
      const resting = calculateOverlayLayerBounds(
        rect,
        placement,
        1000,
        200,
        expanded,
        false,
      );
      const swiping = calculateOverlayLayerBounds(
        rect,
        placement,
        1000,
        200,
        expanded,
        true,
      );
      expect({ x: swiping.x, y: swiping.y }).toEqual({
        x: resting.x,
        y: resting.y,
      });
    },
  );

  it('extends spread and swipe bounds in the placement growth direction and clamps outward', () => {
    expect(
      calculateOverlayLayerBounds(rect, 'top-right', 1000, 200, true, false),
    ).toEqual({
      x: 788,
      y: 28,
      width: 212,
      height: 172,
    });
    expect(
      calculateOverlayLayerBounds(rect, 'bottom-left', 1000, 200, true, false),
    ).toEqual({
      x: 0,
      y: 0,
      width: 993,
      height: 137,
    });
    expect(
      calculateOverlayLayerBounds(rect, 'top-left', 1000, 200, false, true),
    ).toEqual({
      x: 0,
      y: 28,
      width: 993,
      height: 172,
    });

    const offscreen = domRect({
      left: -30.2,
      top: 185.4,
      width: 40,
      height: 40,
    });
    expect(
      calculateOverlayLayerBounds(
        offscreen,
        'bottom-left',
        1000,
        200,
        false,
        false,
      ),
    ).toEqual({
      x: 0,
      y: 173,
      width: 22,
      height: 27,
    });
  });
});

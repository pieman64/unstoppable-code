import { EventEmitter } from 'node:events';
import { BrowserWindow, type Rectangle } from 'electron';
import type { OverlayLayerHostOptions } from '../overlay-layer-host';
import {
  decideOverlayLayerWindowOpen,
  OverlayLayerHost,
} from '../overlay-layer-host';
import { ipcWindowLabel } from '../../lib/web-contents-send';

interface TestRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ZoomableContents {
  isDestroyed(): boolean;
  setZoomFactor(factor: number): void;
}

interface MockLayerViewContract {
  readonly webContents: MockGuest;
  bounds: Rectangle | null;
  visible: boolean;
  hiddenAtFirstAttachment: boolean | null;
  backgroundColor: string | null;
  readonly setBounds: jest.Mock<void, [Rectangle]>;
  readonly setVisible: jest.Mock<void, [boolean]>;
  readonly setBackgroundColor: jest.Mock<void, [string]>;
}

class MockGuest extends EventEmitter {
  destroyed = false;
  focused = false;
  zoomFactor = 1;
  windowOpenHandler:
    | ((details: { readonly url: string }) => { readonly action: 'deny' })
    | null = null;
  readonly setZoomFactor = jest.fn<void, [number]>((factor) => {
    this.zoomFactor = factor;
  });
  readonly focus = jest.fn<void, []>(() => {
    this.focused = true;
  });
  readonly close = jest.fn<void, [Electron.CloseOpts]>((options) => {
    void options;
    this.destroyed = true;
    this.emit('destroyed');
  });

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  setWindowOpenHandler(
    handler: (details: { readonly url: string }) => {
      readonly action: 'deny';
    },
  ): void {
    this.windowOpenHandler = handler;
  }

  send(): void {}
}

class MockLayerView implements MockLayerViewContract {
  bounds: Rectangle | null = null;
  visible = true;
  hiddenAtFirstAttachment: boolean | null = null;
  backgroundColor: string | null = null;
  readonly setBounds = jest.fn<void, [Rectangle]>((bounds) => {
    this.bounds = bounds;
  });
  readonly setVisible = jest.fn<void, [boolean]>((visible) => {
    this.visible = visible;
  });
  readonly setBackgroundColor = jest.fn<void, [string]>((color) => {
    this.backgroundColor = color;
  });

  constructor(readonly webContents: MockGuest) {}
}

class MockContentView {
  children: unknown[] = [];

  addChildView(view: unknown): void {
    if (
      view instanceof MockLayerView &&
      view.hiddenAtFirstAttachment === null
    ) {
      view.hiddenAtFirstAttachment = !view.visible;
    }
    this.children = [...this.children.filter((child) => child !== view), view];
  }

  removeChildView(view: unknown): void {
    this.children = this.children.filter((child) => child !== view);
  }
}

class MockMainContents extends EventEmitter {
  focused = false;
  destroyed = false;
  readonly focus = jest.fn<void, []>(() => {
    this.focused = true;
  });
  readonly setZoomFactor = jest.fn<void, [number]>();

  constructor(readonly id: number) {
    super();
  }

  getZoomFactor(): number {
    return mockMainZoomFactor;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

const mockGuestRegistry = new Map<number, unknown>();
const mockCreatedViews: MockLayerView[] = [];
const mockMainContents: MockMainContents[] = [];
const mockContentViews: MockContentView[] = [];
const mockZoomCallbacks = new Map<object, (zoomFactor: number) => void>();
const mockRouteAppLink = jest.fn<Promise<unknown>, [string]>();
const mockOpenExternalGuarded = jest.fn<Promise<void>, [string]>();
const mockAttachInputGuardsToContents = jest.fn<void, [unknown]>();
const mockRegisterUiZoomContents = jest.fn(
  (contents: ZoomableContents, onZoom: (zoomFactor: number) => void) => {
    mockZoomCallbacks.set(contents, onZoom);
    return (): void => {
      mockZoomCallbacks.delete(contents);
    };
  },
);
let mockMainZoomFactor = 1;

function testCssRectToWindowDips(rect: TestRect, zoomFactor: number): TestRect {
  const left = Math.round(rect.x * zoomFactor);
  const top = Math.round(rect.y * zoomFactor);
  return {
    x: left,
    y: top,
    width: Math.round((rect.x + rect.width) * zoomFactor) - left,
    height: Math.round((rect.y + rect.height) * zoomFactor) - top,
  };
}

jest.mock('electron', () => ({
  BrowserWindow: class extends EventEmitter {
    readonly webContents: MockMainContents;
    readonly contentView: MockContentView;
    private destroyed = false;

    constructor() {
      super();
      this.webContents = new MockMainContents(500 + mockMainContents.length);
      this.contentView = new MockContentView();
      mockMainContents.push(this.webContents);
      mockContentViews.push(this.contentView);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    close(): void {
      this.destroyed = true;
      this.contentView.children = [];
      this.emit('closed');
    }
  },
  WebContentsView: jest.fn().mockImplementation((options: unknown) => {
    if (typeof options !== 'object' || options === null) {
      throw new Error('Expected overlay layer constructor options.');
    }
    const candidate: unknown = Reflect.get(options, 'webContents');
    if (!(candidate instanceof MockGuest)) {
      throw new Error('Expected an overlay layer guest.');
    }
    const view = new MockLayerView(candidate);
    mockCreatedViews.push(view);
    return view;
  }),
  webContents: {
    fromId: (id: number): unknown => mockGuestRegistry.get(id),
  },
}));

jest.mock('../../menu', () => ({
  attachInputGuardsToContents: (contents: unknown): void => {
    mockAttachInputGuardsToContents(contents);
  },
}));

jest.mock('../../lib/open-external', () => ({
  openExternalGuarded: (url: string): Promise<void> =>
    mockOpenExternalGuarded(url),
}));

jest.mock('../../lib/ui-zoom', () => ({
  cssRectToWindowDips: (rect: TestRect, zoomFactor: number): TestRect =>
    testCssRectToWindowDips(rect, zoomFactor),
  registerUiZoomContents: (
    contents: ZoomableContents,
    onZoom: (zoomFactor: number) => void,
  ): (() => void) => mockRegisterUiZoomContents(contents, onZoom),
}));

interface TestSetup {
  readonly host: OverlayLayerHost;
  readonly window: BrowserWindow;
  readonly mainContents: MockMainContents;
  readonly contentView: MockContentView;
  readonly onLayerAttached: jest.Mock<void, [BrowserWindow]>;
}

function lastOrThrow<T>(values: readonly T[], label: string): T {
  const value = values.at(-1);
  if (!value) throw new Error(`Expected a ${label}.`);
  return value;
}

function setupHost(
  onLayerAttached?: (window: BrowserWindow) => void,
): TestSetup {
  const window = new BrowserWindow();
  const mainContents = lastOrThrow(mockMainContents, 'main WebContents');
  const contentView = lastOrThrow(mockContentViews, 'content view');
  const attached = jest.fn<void, [BrowserWindow]>(onLayerAttached);
  const options: OverlayLayerHostOptions = {
    routeAppLink: mockRouteAppLink,
    onLayerAttached: attached,
  };
  const host = new OverlayLayerHost(options);
  host.observeWindow(window);
  return { host, window, mainContents, contentView, onLayerAttached: attached };
}

function createLayer(
  host: OverlayLayerHost,
  window: BrowserWindow,
  guest = new MockGuest(100 + mockGuestRegistry.size),
): { readonly guest: MockGuest; readonly view: MockLayerView } {
  mockGuestRegistry.set(guest.id, guest);
  const response = host.createWindowOpenResponse(window, 'notifications');
  const createWindow = response.createWindow;
  if (!createWindow) throw new Error('Expected an overlay layer factory.');
  const options: Electron.BrowserWindowConstructorOptions = {};
  Reflect.set(options, 'webContents', guest);
  expect(createWindow(options)).toBe(guest);
  return { guest, view: lastOrThrow(mockCreatedViews, 'layer view') };
}

function registeredZoom(guest: MockGuest, zoomFactor: number): void {
  guest.setZoomFactor(zoomFactor);
  const onZoom = mockZoomCallbacks.get(guest);
  if (!onZoom) throw new Error('Expected overlay zoom registration.');
  onZoom(zoomFactor);
}

function mockEvent(url: string): {
  preventDefault: jest.Mock<void, []>;
  url: string;
} {
  return { preventDefault: jest.fn<void, []>(), url };
}

beforeEach(() => {
  mockGuestRegistry.clear();
  mockCreatedViews.splice(0);
  mockMainContents.splice(0);
  mockContentViews.splice(0);
  mockZoomCallbacks.clear();
  mockMainZoomFactor = 1;
  mockRouteAppLink.mockReset().mockResolvedValue(undefined);
  mockOpenExternalGuarded.mockReset().mockResolvedValue(undefined);
  mockAttachInputGuardsToContents.mockClear();
  mockRegisterUiZoomContents.mockClear();
});

describe('decideOverlayLayerWindowOpen', () => {
  it('allows a recognized blank popup from the main renderer', () => {
    expect(
      decideOverlayLayerWindowOpen(
        {
          url: 'about:blank',
          frameName: 'canopy-overlay-layer:notifications:nonce-1',
        },
        42,
        42,
      ),
    ).toBe('notifications');
  });

  it.each([
    [
      {
        url: 'about:blank#fragment',
        frameName: 'canopy-overlay-layer:notifications:n1',
      },
      42,
      42,
    ],
    [
      {
        url: 'https://example.test',
        frameName: 'canopy-overlay-layer:notifications:n1',
      },
      42,
      42,
    ],
    [
      {
        url: 'about:blank',
        frameName: 'canopy-overlay-layer:unknown:n1',
      },
      42,
      42,
    ],
    [
      {
        url: 'about:blank',
        frameName: 'canopy-overlay-layer:notifications:',
      },
      42,
      42,
    ],
    [
      {
        url: 'about:blank',
        frameName: 'canopy-overlay-layer:notifications:n1',
      },
      41,
      42,
    ],
  ] as const)(
    'denies an out-of-contract popup',
    (details, sourceId, mainId) => {
      expect(
        decideOverlayLayerWindowOpen(details, sourceId, mainId),
      ).toBeNull();
    },
  );
});

describe('OverlayLayerHost', () => {
  it('hardens and adopts a validated guest hidden above the window', () => {
    mockMainZoomFactor = 1.25;
    const { host, window, contentView, onLayerAttached } = setupHost();
    const { guest, view } = createLayer(host, window);
    const response = host.createWindowOpenResponse(window, 'notifications');

    expect(response).toMatchObject({
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          preload: undefined,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      },
    });
    expect(view.backgroundColor).toBe('#00000000');
    expect(view.visible).toBe(false);
    expect(view.hiddenAtFirstAttachment).toBe(true);
    expect(contentView.children).toEqual([view]);
    expect(guest.zoomFactor).toBe(1.25);
    expect(mockRegisterUiZoomContents).toHaveBeenCalledTimes(1);
    expect(mockAttachInputGuardsToContents).toHaveBeenCalledWith(guest);
    expect(ipcWindowLabel(guest)).toBe('aux');
    expect(onLayerAttached).toHaveBeenCalledWith(window);
    expect(onLayerAttached).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid guests without replacing a live layer', () => {
    const { host, window, contentView } = setupHost();
    const original = createLayer(host, window);
    const response = host.createWindowOpenResponse(window, 'notifications');
    const createWindow = response.createWindow;
    if (!createWindow) throw new Error('Expected an overlay layer factory.');

    expect(() => createWindow({})).toThrow(
      'Overlay layer popup did not provide a WebContents.',
    );

    const registeredGuest = new MockGuest(900);
    mockGuestRegistry.set(registeredGuest.id, registeredGuest);
    const unregistered = new MockGuest(registeredGuest.id);
    const options: Electron.BrowserWindowConstructorOptions = {};
    Reflect.set(options, 'webContents', unregistered);
    expect(() => createWindow(options)).toThrow(
      'Overlay layer popup did not provide a WebContents.',
    );
    expect(contentView.children).toEqual([original.view]);
    expect(original.guest.close).not.toHaveBeenCalled();
  });

  it('replaces the old slot guest and unregisters its zoom listener', () => {
    const { host, window, contentView } = setupHost();
    const first = createLayer(host, window);
    const second = createLayer(host, window);

    expect(first.guest.close).toHaveBeenCalledWith({
      waitForBeforeUnload: false,
    });
    expect(mockZoomCallbacks.has(first.guest)).toBe(false);
    expect(mockZoomCallbacks.has(second.guest)).toBe(true);
    expect(contentView.children).toEqual([second.view]);
    expect(second.view.visible).toBe(false);
  });

  it('sets CSS bounds at zoom 1 and 1.25, and hides on null', () => {
    const { host, window } = setupHost();
    const { guest, view } = createLayer(host, window);
    const bounds: TestRect = { x: 10.4, y: 20.2, width: 100.3, height: 50.6 };

    host.setBounds(window, { slot: 'notifications', bounds });
    expect(view.bounds).toEqual(testCssRectToWindowDips(bounds, 1));
    expect(view.visible).toBe(true);

    registeredZoom(guest, 1.25);
    expect(view.bounds).toEqual(testCssRectToWindowDips(bounds, 1.25));
    expect(guest.zoomFactor).toBe(1.25);

    host.setBounds(window, { slot: 'notifications', bounds: null });
    expect(view.visible).toBe(false);
    expect(view.bounds).toEqual(testCssRectToWindowDips(bounds, 1.25));
  });

  it('converts fresh bounds using the main page current zoom', () => {
    const { host, window } = setupHost();
    const { view } = createLayer(host, window);
    const bounds: TestRect = { x: 10, y: 20, width: 100, height: 50 };

    // A bounds request reads the owning page, not a cached guest scale.
    mockMainZoomFactor = 1.25;
    host.setBounds(window, { slot: 'notifications', bounds });

    expect(view.bounds).toEqual(testCssRectToWindowDips(bounds, 1.25));
  });

  it('focuses the layer or main page and leaves absent slots as no-ops', () => {
    const { host, window, mainContents } = setupHost();
    host.focus(window, { slot: 'notifications', target: 'layer' });
    host.focus(window, { slot: 'notifications', target: 'main' });
    expect(mainContents.focus).not.toHaveBeenCalled();

    const { guest } = createLayer(host, window);
    host.focus(window, { slot: 'notifications', target: 'layer' });
    expect(guest.focus).toHaveBeenCalledTimes(1);
    host.focus(window, { slot: 'notifications', target: 'main' });
    expect(mainContents.focus).toHaveBeenCalledTimes(1);
  });

  it('returns focus on mouseUp and ignores a disposed layer', async () => {
    const { host, window, mainContents } = setupHost();
    const { guest } = createLayer(host, window);

    guest.emit('before-mouse-event', {}, { type: 'mouseUp', x: 0, y: 0 });
    expect(mainContents.focus).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mainContents.focus).toHaveBeenCalledTimes(1);

    guest.emit('before-mouse-event', {}, { type: 'mouseUp', x: 0, y: 0 });
    window.webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mainContents.focus).toHaveBeenCalledTimes(1);
  });

  it('routes safe nested opens and pins navigation to about:blank', () => {
    const { host, window } = setupHost();
    const { guest } = createLayer(host, window);
    const open = guest.windowOpenHandler;
    if (!open) throw new Error('Expected nested popup hardening.');

    expect(open({ url: 'https://example.test/path' })).toEqual({
      action: 'deny',
    });
    expect(open({ url: 'mailto:team@example.test' })).toEqual({
      action: 'deny',
    });
    expect(mockRouteAppLink).toHaveBeenCalledWith('https://example.test/path');
    expect(mockOpenExternalGuarded).toHaveBeenCalledWith(
      'mailto:team@example.test',
    );
    expect(open({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    expect(mockRouteAppLink).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalGuarded).toHaveBeenCalledTimes(1);

    const allowedNavigation = mockEvent('about:blank');
    guest.emit('will-navigate', allowedNavigation);
    expect(allowedNavigation.preventDefault).not.toHaveBeenCalled();
    const deniedNavigation = mockEvent('https://example.test/redirect');
    guest.emit('will-navigate', deniedNavigation);
    expect(deniedNavigation.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockRouteAppLink).toHaveBeenCalledWith(
      'https://example.test/redirect',
    );

    const frameNavigation = mockEvent('https://example.test/frame');
    guest.emit('will-frame-navigate', frameNavigation);
    expect(frameNavigation.preventDefault).toHaveBeenCalledTimes(1);
    const blankFrameNavigation = mockEvent('about:blank');
    guest.emit('will-frame-navigate', blankFrameNavigation);
    expect(blankFrameNavigation.preventDefault).not.toHaveBeenCalled();
  });

  it('destroys layers on hard main-frame navigation only', () => {
    const { host, window, mainContents, contentView } = setupHost();
    const { guest, view } = createLayer(host, window);
    host.observeWindow(window);
    expect(mainContents.listenerCount('did-start-navigation')).toBe(1);

    mainContents.emit('did-start-navigation', {
      isMainFrame: false,
      isSameDocument: false,
    });
    mainContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: true,
    });
    expect(contentView.children).toEqual([view]);
    expect(guest.close).not.toHaveBeenCalled();

    mainContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(contentView.children).toEqual([]);
    expect(guest.close).toHaveBeenCalledWith({
      waitForBeforeUnload: false,
    });
    expect(mockZoomCallbacks.has(guest)).toBe(false);
    expect(mainContents.listenerCount('did-start-navigation')).toBe(1);
  });

  it('destroys layers when the main renderer crashes', () => {
    const { host, window, mainContents, contentView } = setupHost();
    const { guest, view } = createLayer(host, window);

    mainContents.emit('render-process-gone', {}, {});

    expect(contentView.children).not.toContain(view);
    expect(guest.close).toHaveBeenCalledTimes(1);
    expect(mockZoomCallbacks.has(guest)).toBe(false);
  });

  it('cleans guests and main-window listeners when the window closes', () => {
    const { host, window, mainContents, contentView } = setupHost();
    const { guest, view } = createLayer(host, window);

    window.close();

    expect(contentView.children).not.toContain(view);
    expect(guest.close).toHaveBeenCalledTimes(1);
    expect(mockZoomCallbacks.has(guest)).toBe(false);
    expect(mainContents.listenerCount('did-start-navigation')).toBe(0);
    expect(mainContents.listenerCount('render-process-gone')).toBe(0);
    expect(window.listenerCount('closed')).toBe(0);
  });

  it('closes a destroyed window without reading its webContents', () => {
    const { host, window, mainContents } = setupHost();
    createLayer(host, window);
    // Electron throws "Object has been destroyed" for these after `closed`.
    Object.defineProperty(window, 'webContents', {
      get() {
        if (window.isDestroyed())
          throw new TypeError('Object has been destroyed');
        return mainContents;
      },
    });

    expect(() => window.close()).not.toThrow();
    expect(mainContents.listenerCount('did-start-navigation')).toBe(0);
    expect(mainContents.listenerCount('render-process-gone')).toBe(0);
    expect(window.listenerCount('closed')).toBe(0);
  });

  it('cleans up idempotently when a guest is destroyed directly', () => {
    const { host, window, contentView } = setupHost();
    const { guest, view } = createLayer(host, window);
    guest.destroyed = true;
    guest.emit('destroyed');
    guest.emit('destroyed');

    expect(contentView.children).not.toContain(view);
    expect(mockZoomCallbacks.has(guest)).toBe(false);
    expect(guest.close).not.toHaveBeenCalled();
    expect(guest.listenerCount('destroyed')).toBe(0);
    expect(guest.listenerCount('before-mouse-event')).toBe(0);
    expect(guest.listenerCount('will-navigate')).toBe(0);
    expect(guest.listenerCount('will-frame-navigate')).toBe(0);
    host.setBounds(window, {
      slot: 'notifications',
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    });
    host.focus(window, { slot: 'notifications', target: 'layer' });
    expect(view.setBounds).not.toHaveBeenCalled();
    expect(guest.focus).not.toHaveBeenCalled();
  });

  it('keeps App Advisor above a lazy layer and a later Browser view', () => {
    const window = new BrowserWindow();
    const contentView = lastOrThrow(mockContentViews, 'content view');
    const advisor = new MockLayerView(new MockGuest(700));
    const browser = new MockLayerView(new MockGuest(701));
    contentView.addChildView(advisor);
    const host = new OverlayLayerHost({
      routeAppLink: mockRouteAppLink,
      onLayerAttached: (): void => {
        contentView.addChildView(advisor);
      },
    });
    host.observeWindow(window);

    const { view: overlay } = createLayer(host, window);
    expect(contentView.children).toEqual([overlay, advisor]);

    contentView.addChildView(browser);
    host.raise(window);
    // Main wiring raises App Advisor after overlayLayerHost.raise.
    contentView.addChildView(advisor);
    expect(contentView.children).toEqual([browser, overlay, advisor]);
  });
});

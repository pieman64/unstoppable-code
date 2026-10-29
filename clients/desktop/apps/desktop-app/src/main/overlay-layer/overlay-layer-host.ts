import {
  WebContentsView,
  webContents,
  type BrowserWindow,
  type HandlerDetails,
  type WebContents,
} from 'electron';
import { parseOverlayLayerFrameName } from '@canopy/desktop-shared/lib/overlay-layer';
import type {
  OverlayLayerFocusRequest,
  OverlayLayerRect,
  OverlayLayerSetBoundsRequest,
  OverlayLayerSlot,
} from '@canopy/desktop-shared/types';
import { attachInputGuardsToContents } from '../menu';
import { cssRectToWindowDips, registerUiZoomContents } from '../lib/ui-zoom';
import { openExternalGuarded } from '../lib/open-external';
import { registerIpcSurface } from '../lib/web-contents-send';

const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const OVERLAY_LAYER_BACKGROUND = '#00000000';

export interface OverlayLayerHostOptions {
  readonly routeAppLink: (url: string) => Promise<unknown>;
  readonly onLayerAttached: (window: BrowserWindow) => void;
}

interface LayerRecord {
  readonly window: BrowserWindow;
  readonly slot: OverlayLayerSlot;
  readonly view: WebContentsView;
  readonly contents: WebContents;
  readonly onWillNavigate: (
    details: Electron.Event<Electron.WebContentsWillNavigateEventParams>,
  ) => void;
  readonly onWillFrameNavigate: (
    details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>,
  ) => void;
  readonly onDestroyed: () => void;
  readonly onBeforeMouseEvent: (
    event: Electron.Event,
    mouse: Electron.MouseInputEvent,
  ) => void;
  unregisterZoom: () => void;
  bounds: OverlayLayerRect | null;
  zoomFactor: number;
  disposed: boolean;
}

function isElectronWebContents(value: unknown): value is WebContents {
  if (typeof value !== 'object' || value === null) return false;
  const id: unknown = Reflect.get(value, 'id');
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return false;
  return webContents.fromId(id) === value;
}

function isAllowedOverlayNavigation(url: string): boolean {
  return url === 'about:blank';
}

function routeExternalIfSafe(
  url: string,
  options: OverlayLayerHostOptions,
): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      void options.routeAppLink(url).catch(() => undefined);
    } else if (SAFE_EXTERNAL_SCHEMES.has(parsed.protocol)) {
      void openExternalGuarded(url).catch(() => undefined);
    }
  } catch {
    // Malformed URLs are not opened externally.
  }
}

/**
 * Returns the overlay slot for a narrowly recognized same-origin popup.
 * The opener identity is mandatory: only the main renderer may create layers.
 */
export function decideOverlayLayerWindowOpen(
  details: Pick<HandlerDetails, 'url' | 'frameName'>,
  sourceWebContentsId: number,
  mainWindowWebContentsId: number,
): OverlayLayerSlot | null {
  if (
    details.url !== 'about:blank' ||
    sourceWebContentsId !== mainWindowWebContentsId
  ) {
    return null;
  }
  return parseOverlayLayerFrameName(details.frameName);
}

/**
 * Owns adopted same-origin popup pages as transparent, per-slot native views
 * above the main window's Browser views.
 */
export class OverlayLayerHost {
  private readonly layersByWindow = new WeakMap<
    BrowserWindow,
    Map<OverlayLayerSlot, LayerRecord>
  >();
  private readonly observedWindows = new WeakSet<BrowserWindow>();

  constructor(private readonly options: OverlayLayerHostOptions) {}

  /** Installs lifecycle cleanup once for the lifetime of a main window. */
  observeWindow(window: BrowserWindow): void {
    if (window.isDestroyed() || this.observedWindows.has(window)) return;
    // Captured now: a destroyed window throws on `webContents` inside `closed`.
    const contents = window.webContents;

    const onNavigation = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ): void => {
      if (details.isMainFrame && !details.isSameDocument) {
        this.disposeWindowLayers(window);
      }
    };
    const onRenderProcessGone = (): void => {
      this.disposeWindowLayers(window);
    };
    const onClosed = (): void => {
      this.disposeWindowLayers(window);
      contents.off('did-start-navigation', onNavigation);
      contents.off('render-process-gone', onRenderProcessGone);
      window.removeListener('closed', onClosed);
      this.observedWindows.delete(window);
    };

    this.observedWindows.add(window);
    contents.on('did-start-navigation', onNavigation);
    contents.on('render-process-gone', onRenderProcessGone);
    window.on('closed', onClosed);
  }

  /**
   * Creates a narrowly allowed popup response. Electron supplies the real
   * guest WebContents in `options`; validating it via Electron's registry
   * keeps untrusted callback data from being adopted as a view.
   */
  createWindowOpenResponse(
    window: BrowserWindow,
    slot: OverlayLayerSlot,
  ): Electron.WindowOpenHandlerResponse {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          preload: undefined,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      },
      createWindow: (
        options: Electron.BrowserWindowConstructorOptions,
      ): WebContents => {
        const candidate: unknown = Reflect.get(options, 'webContents');
        if (!isElectronWebContents(candidate)) {
          throw new Error('Overlay layer popup did not provide a WebContents.');
        }
        this.adoptGuest(window, slot, candidate);
        return candidate;
      },
    };
  }

  /** Applies a main-renderer CSS rectangle or hides the requested slot. */
  setBounds(
    window: BrowserWindow,
    request: OverlayLayerSetBoundsRequest,
  ): void {
    const record = this.layersByWindow.get(window)?.get(request.slot);
    if (!record || record.disposed) return;

    record.bounds = request.bounds;
    if (request.bounds === null) {
      record.view.setVisible(false);
      return;
    }
    record.zoomFactor = window.webContents.getZoomFactor();
    this.fitRecord(record);
    record.view.setVisible(true);
  }

  /** Moves keyboard focus into the layer or back to the main renderer. */
  focus(window: BrowserWindow, request: OverlayLayerFocusRequest): void {
    const record = this.layersByWindow.get(window)?.get(request.slot);
    if (!record || record.disposed) return;

    if (request.target === 'layer') {
      if (!record.contents.isDestroyed()) record.contents.focus();
      return;
    }
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.focus();
    }
  }

  /** Re-adds each slot to place it above Browser views attached later. */
  raise(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    const layers = this.layersByWindow.get(window);
    if (!layers) return;
    for (const record of Array.from(layers.values())) {
      if (!record.disposed) window.contentView.addChildView(record.view);
    }
  }

  private adoptGuest(
    window: BrowserWindow,
    slot: OverlayLayerSlot,
    contents: WebContents,
  ): void {
    const view = new WebContentsView({ webContents: contents });
    view.setBackgroundColor(OVERLAY_LAYER_BACKGROUND);
    view.setVisible(false);

    contents.setWindowOpenHandler((details) => {
      routeExternalIfSafe(details.url, this.options);
      return { action: 'deny' };
    });
    const onWillNavigate = (
      details: Electron.Event<Electron.WebContentsWillNavigateEventParams>,
    ): void => {
      if (isAllowedOverlayNavigation(details.url)) return;
      details.preventDefault();
      routeExternalIfSafe(details.url, this.options);
    };
    const onWillFrameNavigate = (
      details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>,
    ): void => {
      if (!isAllowedOverlayNavigation(details.url)) details.preventDefault();
    };
    contents.on('will-navigate', onWillNavigate);
    contents.on('will-frame-navigate', onWillFrameNavigate);
    attachInputGuardsToContents(contents);
    registerIpcSurface(contents, 'aux');

    const oldRecord = this.layersByWindow.get(window)?.get(slot);
    if (oldRecord) this.disposeRecord(oldRecord, true);
    const layers = this.layersForWindow(window);

    const record: LayerRecord = {
      window,
      slot,
      view,
      contents,
      onWillNavigate,
      onWillFrameNavigate,
      onDestroyed: (): void => this.disposeRecord(record, false),
      onBeforeMouseEvent: (_event, mouse): void => {
        if (mouse.type !== 'mouseUp') return;
        setImmediate((): void => {
          if (
            record.disposed ||
            this.layersByWindow.get(window)?.get(slot) !== record ||
            window.isDestroyed() ||
            window.webContents.isDestroyed() ||
            contents.isDestroyed()
          ) {
            return;
          }
          window.webContents.focus();
        });
      },
      unregisterZoom: (): void => undefined,
      bounds: null,
      zoomFactor: window.webContents.getZoomFactor(),
      disposed: false,
    };

    contents.setZoomFactor(record.zoomFactor);
    window.contentView.addChildView(view);
    layers.set(slot, record);
    contents.on('destroyed', record.onDestroyed);
    contents.on('before-mouse-event', record.onBeforeMouseEvent);
    record.unregisterZoom = registerUiZoomContents(contents, (zoomFactor) => {
      record.zoomFactor = zoomFactor;
      this.fitRecord(record);
    });
    this.options.onLayerAttached(window);
  }

  private fitRecord(record: LayerRecord): void {
    if (record.disposed || record.bounds === null) return;
    if (record.contents.isDestroyed() || record.window.isDestroyed()) return;
    record.view.setBounds(
      cssRectToWindowDips(record.bounds, record.zoomFactor),
    );
  }

  private layersForWindow(
    window: BrowserWindow,
  ): Map<OverlayLayerSlot, LayerRecord> {
    let layers = this.layersByWindow.get(window);
    if (!layers) {
      layers = new Map<OverlayLayerSlot, LayerRecord>();
      this.layersByWindow.set(window, layers);
    }
    return layers;
  }

  private disposeWindowLayers(window: BrowserWindow): void {
    const layers = this.layersByWindow.get(window);
    if (!layers) return;
    for (const record of Array.from(layers.values())) {
      this.disposeRecord(record, true);
    }
  }

  private disposeRecord(record: LayerRecord, closeContents: boolean): void {
    if (record.disposed) return;
    record.disposed = true;

    const layers = this.layersByWindow.get(record.window);
    if (layers?.get(record.slot) === record) {
      layers.delete(record.slot);
      if (layers.size === 0) this.layersByWindow.delete(record.window);
    }

    record.contents.off('destroyed', record.onDestroyed);
    record.contents.off('before-mouse-event', record.onBeforeMouseEvent);
    record.contents.off('will-navigate', record.onWillNavigate);
    record.contents.off('will-frame-navigate', record.onWillFrameNavigate);
    record.unregisterZoom();
    if (!record.window.isDestroyed()) {
      record.window.contentView.removeChildView(record.view);
    }
    if (closeContents && !record.contents.isDestroyed()) {
      record.contents.close({ waitForBeforeUnload: false });
    }
  }
}

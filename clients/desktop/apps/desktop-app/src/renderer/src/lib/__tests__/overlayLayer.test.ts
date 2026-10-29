/** @jest-environment jsdom */

import { getWindows } from '@canopy/ui-shared/panels';
import { parseOverlayLayerFrameName } from '@canopy/desktop-shared/lib/overlay-layer';
import type {
  OverlayLayerApi,
  OverlayLayerRect,
  OverlayLayerSlot,
} from '@canopy/desktop-shared/types';
import * as remoteControlStore from '../../stores/remoteControlStore';
import {
  disposeOverlayLayer,
  getOpenOverlayLayer,
  isOverlayLayerAvailable,
  openOverlayLayer,
  resetOverlayLayersForTests,
} from '../overlayLayer';

interface PopupHarness {
  childWindow: WindowProxy;
}

interface OverlayApiHarness {
  api: OverlayLayerApi;
  focus: jest.Mock<
    Promise<void>,
    [{ slot: OverlayLayerSlot; target: 'layer' | 'main' }]
  >;
  setBounds: jest.Mock<
    Promise<void>,
    [{ slot: OverlayLayerSlot; bounds: OverlayLayerRect | null }]
  >;
}

interface OpenHarness {
  frameNames: string[];
  open: jest.SpyInstance;
}

const slot: OverlayLayerSlot = 'notifications';

function createPopup(): PopupHarness {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  const childWindow = iframe.contentWindow;

  if (!childWindow) {
    throw new Error('The test iframe did not create a child window.');
  }

  return { childWindow };
}

function createOverlayApi(): OverlayApiHarness {
  const setBounds = jest.fn<
    Promise<void>,
    [{ slot: OverlayLayerSlot; bounds: OverlayLayerRect | null }]
  >(() => Promise.resolve());
  const focus = jest.fn<
    Promise<void>,
    [{ slot: OverlayLayerSlot; target: 'layer' | 'main' }]
  >(() => Promise.resolve());
  const api: OverlayLayerApi = { setBounds, focus };

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { overlayLayer: api },
    writable: true,
  });

  return { api, focus, setBounds };
}

function mockOpenWith(...windows: Array<WindowProxy | null>): OpenHarness {
  const frameNames: string[] = [];
  const open = jest.spyOn(window, 'open').mockImplementation((_url, target) => {
    if (typeof target === 'string') {
      frameNames.push(target);
    }
    return windows.shift() ?? null;
  });

  return { frameNames, open };
}

function stubClosed(childWindow: WindowProxy): (closed: boolean) => void {
  let isClosed = false;
  Object.defineProperty(childWindow, 'closed', {
    configurable: true,
    get: () => isClosed,
  });

  return (closed: boolean): void => {
    isClosed = closed;
  };
}

function installRandomUUID(): void {
  let sequence = 0;
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: (): string => `overlay-test-${++sequence}`,
  });
}

beforeEach(() => {
  resetOverlayLayersForTests();
  installRandomUUID();
  createOverlayApi();
  jest.spyOn(remoteControlStore, 'readRemoteControlContext').mockReturnValue({
    mode: 'local',
  });
});

afterEach(() => {
  resetOverlayLayersForTests();
  jest.restoreAllMocks();
  jest.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
  document.head
    .querySelectorAll('[data-overlay-test-style]')
    .forEach((node) => {
      node.remove();
    });
});

describe('overlay layer opening and preparation', () => {
  it('opens lazily with a slot-specific frame name and reuses the open layer', () => {
    const popup = createPopup();
    const { frameNames, open } = mockOpenWith(popup.childWindow);

    expect(open).not.toHaveBeenCalled();
    expect(isOverlayLayerAvailable(slot)).toBe(true);
    expect(open).not.toHaveBeenCalled();

    const first = openOverlayLayer(slot);
    const second = openOverlayLayer(slot);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      'about:blank',
      expect.stringMatching(/^canopy-overlay-layer:notifications:/),
    );
    const frameName = frameNames[0];
    if (!frameName) throw new Error('Expected a popup frame name.');
    expect(parseOverlayLayerFrameName(frameName)).toBe(slot);
  });

  it('prepares a transparent child document and adopts an opener-realm root', () => {
    const sourceStyle = document.createElement('style');
    sourceStyle.dataset.overlayTestStyle = 'source';
    sourceStyle.textContent = '.overlay-test { color: rgb(1, 2, 3); }';
    document.head.appendChild(sourceStyle);
    document.documentElement.setAttribute('data-theme', 'dark');

    const popup = createPopup();
    mockOpenWith(popup.childWindow);

    const layer = openOverlayLayer(slot);

    expect(layer).not.toBeNull();
    if (!layer) return;

    expect(
      layer.document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content'),
    ).toBe("script-src 'none'");
    expect(layer.document.head.querySelector('style')?.textContent).toContain(
      '.overlay-test { color: rgb(1, 2, 3); }',
    );
    expect(layer.document.documentElement.getAttribute('data-theme')).toBe(
      'dark',
    );
    expect(
      Array.from(layer.document.head.querySelectorAll('style')).at(-1)
        ?.textContent,
    ).toContain('background: transparent !important');
    expect(
      Array.from(layer.document.head.querySelectorAll('style')).at(-1)
        ?.textContent,
    ).toContain('overflow: hidden !important');
    expect(layer.document.body.style.background).toBe('var(--bg-base)');
    expect(layer.root.getAttribute('data-canopy-overlay-layer-root')).toBe(
      slot,
    );
    expect(layer.root.style.position).toBe('fixed');
    expect(layer.root.style.inset).toBe('0');
    expect(layer.root.style.overflow).toBe('hidden');
    expect(layer.root.style.pointerEvents).toBe('none');
    expect(layer.root.style.margin).toBe('0px');
    expect(layer.root.ownerDocument).toBe(layer.document);
    expect(layer.root instanceof window.HTMLElement).toBe(true);
    expect(layer.document.body.contains(layer.root)).toBe(true);
    expect(getWindows()).toContain(popup.childWindow);
  });

  it('marks an unavailable slot when opening returns null and never retries', () => {
    const { open } = mockOpenWith(null);

    expect(openOverlayLayer(slot)).toBeNull();
    expect(isOverlayLayerAvailable(slot)).toBe(false);
    expect(openOverlayLayer(slot)).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('marks an unavailable slot when opening throws and never retries', () => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => {
      throw new Error('popup blocked');
    });

    expect(openOverlayLayer(slot)).toBeNull();
    expect(isOverlayLayerAvailable(slot)).toBe(false);
    expect(openOverlayLayer(slot)).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does not open in remote-control mode', () => {
    const open = jest.spyOn(window, 'open');
    jest.mocked(remoteControlStore.readRemoteControlContext).mockReturnValue({
      mode: 'remote',
      deviceId: 'device-1',
      name: 'Remote device',
      platform: 'darwin',
    });

    expect(isOverlayLayerAvailable(slot)).toBe(false);
    expect(openOverlayLayer(slot)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('does not open without the overlay API', () => {
    const open = jest.spyOn(window, 'open');
    jest.mocked(remoteControlStore.readRemoteControlContext).mockReturnValue({
      mode: 'local',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: undefined,
      writable: true,
    });

    expect(isOverlayLayerAvailable(slot)).toBe(false);
    expect(openOverlayLayer(slot)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('overlay layer lifecycle', () => {
  it('loses on child pagehide before teardown and reopens with a fresh frame name', () => {
    const firstPopup = createPopup();
    const secondPopup = createPopup();
    const { frameNames, open } = mockOpenWith(
      firstPopup.childWindow,
      secondPopup.childWindow,
    );
    const first = openOverlayLayer(slot);
    if (!first) throw new Error('Expected first layer to open.');
    const lost = jest.fn(() => {
      expect(first.root.isConnected).toBe(true);
    });
    first.onLost(lost);

    firstPopup.childWindow.dispatchEvent(new Event('pagehide'));

    expect(lost).toHaveBeenCalledTimes(1);
    expect(first.isLost()).toBe(true);
    expect(first.root.isConnected).toBe(false);
    expect(getWindows()).not.toContain(firstPopup.childWindow);
    expect(getOpenOverlayLayer(slot)).toBeNull();
    const lateListener = jest.fn();
    first.onLost(lateListener);
    expect(lateListener).not.toHaveBeenCalled();
    const second = openOverlayLayer(slot);
    expect(second).not.toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
    expect(frameNames[0]).not.toBe(frameNames[1]);
  });

  it('loses when the closed-window poll detects a closed child', () => {
    jest.useFakeTimers();
    const popup = createPopup();
    const setClosed = stubClosed(popup.childWindow);
    mockOpenWith(popup.childWindow);
    const layer = openOverlayLayer(slot);
    if (!layer) throw new Error('Expected layer to open.');
    const lost = jest.fn(() => {
      expect(layer.root.isConnected).toBe(true);
    });
    layer.onLost(lost);

    setClosed(true);
    jest.advanceTimersByTime(500);

    expect(lost).toHaveBeenCalledTimes(1);
    expect(layer.root.isConnected).toBe(false);
    expect(getOpenOverlayLayer(slot)).toBeNull();
    jest.useRealTimers();
  });

  it.each(['setBounds', 'focus'] as const)(
    'loses on a rejected %s IPC, runs listeners before teardown, and reopens',
    async (operation) => {
      const firstPopup = createPopup();
      const secondPopup = createPopup();
      const { frameNames, open } = mockOpenWith(
        firstPopup.childWindow,
        secondPopup.childWindow,
      );
      const api = createOverlayApi();
      const layer = openOverlayLayer(slot);
      if (!layer) throw new Error('Expected first layer to open.');
      const lost = jest.fn(() => {
        expect(layer.root.isConnected).toBe(true);
      });
      layer.onLost(lost);
      if (operation === 'setBounds') {
        api.setBounds.mockRejectedValueOnce(
          new Error('native layer unavailable'),
        );
        await layer.setBounds({ x: 1, y: 2, width: 30, height: 40 });
        expect(api.setBounds).toHaveBeenCalledWith({
          slot,
          bounds: { x: 1, y: 2, width: 30, height: 40 },
        });
      } else {
        api.focus.mockRejectedValueOnce(new Error('native layer unavailable'));
        await layer.focus('layer');
        expect(api.focus).toHaveBeenCalledWith({ slot, target: 'layer' });
      }

      expect(lost).toHaveBeenCalledTimes(1);
      expect(layer.root.isConnected).toBe(false);
      expect(getOpenOverlayLayer(slot)).toBeNull();
      const second = openOverlayLayer(slot);
      expect(second).not.toBeNull();
      expect(open).toHaveBeenCalledTimes(2);
      expect(frameNames[0]).not.toBe(frameNames[1]);
    },
  );

  it('does not call IPC after loss and calls each loss listener exactly once', async () => {
    const popup = createPopup();
    const api = createOverlayApi();
    mockOpenWith(popup.childWindow);
    const layer = openOverlayLayer(slot);
    if (!layer) throw new Error('Expected layer to open.');
    const listener = jest.fn();
    layer.onLost(listener);

    popup.childWindow.dispatchEvent(new Event('pagehide'));
    popup.childWindow.dispatchEvent(new Event('pagehide'));
    await layer.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    await layer.focus('main');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(api.setBounds).not.toHaveBeenCalled();
    expect(api.focus).not.toHaveBeenCalled();
  });

  it('continues notifying listeners when one loss listener throws', () => {
    const popup = createPopup();
    mockOpenWith(popup.childWindow);
    const layer = openOverlayLayer(slot);
    if (!layer) throw new Error('Expected layer to open.');
    const laterListener = jest.fn();
    layer.onLost(() => {
      throw new Error('consumer cleanup failed');
    });
    layer.onLost(laterListener);

    popup.childWindow.dispatchEvent(new Event('pagehide'));

    expect(laterListener).toHaveBeenCalledTimes(1);
  });

  it('counts three consecutive losses before any successful setBounds as unavailable', () => {
    const popups = [createPopup(), createPopup(), createPopup()];
    mockOpenWith(...popups.map((popup) => popup.childWindow));

    for (const popup of popups) {
      const layer = openOverlayLayer(slot);
      if (!layer) throw new Error('Expected layer to open before the guard.');
      popup.childWindow.dispatchEvent(new Event('pagehide'));
    }

    expect(isOverlayLayerAvailable(slot)).toBe(false);
    expect(openOverlayLayer(slot)).toBeNull();
    expect(window.open).toHaveBeenCalledTimes(3);
  });

  it('resets consecutive losses after a successful setBounds', async () => {
    const popups = [createPopup(), createPopup(), createPopup(), createPopup()];
    const { open } = mockOpenWith(...popups.map((popup) => popup.childWindow));
    const api = createOverlayApi();
    const first = openOverlayLayer(slot);
    if (!first) throw new Error('Expected first layer to open.');
    popups[0]?.childWindow.dispatchEvent(new Event('pagehide'));

    const second = openOverlayLayer(slot);
    if (!second) throw new Error('Expected second layer to open.');
    await second.setBounds({ x: 0, y: 0, width: 10, height: 10 });
    expect(api.setBounds).toHaveBeenCalledTimes(1);
    popups[1]?.childWindow.dispatchEvent(new Event('pagehide'));

    const third = openOverlayLayer(slot);
    if (!third) throw new Error('Expected third layer to open.');
    popups[2]?.childWindow.dispatchEvent(new Event('pagehide'));

    const fourth = openOverlayLayer(slot);
    expect(fourth).not.toBeNull();
    expect(isOverlayLayerAvailable(slot)).toBe(true);
    expect(open).toHaveBeenCalledTimes(4);
  });

  it('disposes and closes the child without making the slot unavailable', () => {
    const popup = createPopup();
    const close = jest.spyOn(popup.childWindow, 'close');
    mockOpenWith(popup.childWindow);
    const layer = openOverlayLayer(slot);
    if (!layer) throw new Error('Expected layer to open.');
    const lost = jest.fn(() => {
      expect(layer.root.isConnected).toBe(true);
    });
    layer.onLost(lost);

    disposeOverlayLayer(slot);

    expect(lost).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(layer.root.isConnected).toBe(false);
    expect(isOverlayLayerAvailable(slot)).toBe(true);
    expect(getOpenOverlayLayer(slot)).toBeNull();
  });

  it('disposes open layers when the opener page hides', () => {
    const popup = createPopup();
    mockOpenWith(popup.childWindow);
    const layer = openOverlayLayer(slot);
    if (!layer) throw new Error('Expected layer to open.');
    const lost = jest.fn();
    layer.onLost(lost);

    window.dispatchEvent(new Event('pagehide'));

    expect(lost).toHaveBeenCalledTimes(1);
    expect(layer.root.isConnected).toBe(false);
    expect(getOpenOverlayLayer(slot)).toBeNull();
  });
});

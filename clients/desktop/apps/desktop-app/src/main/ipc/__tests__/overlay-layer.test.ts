import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type OverlayLayerFocusRequest,
  type OverlayLayerSetBoundsRequest,
} from '@canopy/desktop-shared/types';

type CapturedHandler = (event: unknown, ...args: unknown[]) => unknown;

const handlers = new Map<string, CapturedHandler>();
const setBounds = jest.fn<
  void,
  [BrowserWindow, OverlayLayerSetBoundsRequest]
>();
const focus = jest.fn<void, [BrowserWindow, OverlayLayerFocusRequest]>();

jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: CapturedHandler): void => {
    handlers.set(channel, handler);
  },
}));

import {
  registerOverlayLayerHandlers,
  type OverlayLayerHandlerAccessors,
} from '../overlay-layer';

const INVALID_REQUEST = 'Invalid overlay layer request.';
const INVALID_SENDER = 'Overlay layer IPC requires the live main window.';

class FakeSender {
  readonly mainFrame: object = {};
  destroyed = false;

  constructor(readonly id: number) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

class FakeWindow {
  destroyed = false;

  constructor(readonly webContents: FakeSender) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

interface FakeInvokeEvent {
  sender: FakeSender;
  senderFrame: object | null;
}

function accessorsFor(window: FakeWindow | null): OverlayLayerHandlerAccessors {
  return {
    getMainWindow: (): BrowserWindow | null =>
      window as unknown as BrowserWindow | null,
    overlayLayerHost: {
      setBounds,
      focus,
    },
  };
}

function invoke(
  channel: string,
  event: FakeInvokeEvent,
  request: unknown,
): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return handler(event, request);
}

describe('registerOverlayLayerHandlers', () => {
  let sender: FakeSender;
  let mainWindow: FakeWindow;
  let accessors: OverlayLayerHandlerAccessors;

  beforeEach(() => {
    handlers.clear();
    setBounds.mockClear();
    focus.mockClear();
    sender = new FakeSender(1);
    mainWindow = new FakeWindow(sender);
    accessors = accessorsFor(mainWindow);
    registerOverlayLayerHandlers(accessors);
  });

  function mainFrameEvent(): FakeInvokeEvent {
    return { sender, senderFrame: sender.mainFrame };
  }

  it('delegates valid bounds, including null to hide a layer', () => {
    const request: OverlayLayerSetBoundsRequest = {
      slot: 'notifications',
      bounds: { x: 1, y: 2, width: 30, height: 40 },
    };
    const zeroBoundsRequest: OverlayLayerSetBoundsRequest = {
      slot: 'notifications',
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    };

    invoke(IPC_CHANNELS.overlayLayerSetBounds, mainFrameEvent(), request);
    invoke(IPC_CHANNELS.overlayLayerSetBounds, mainFrameEvent(), {
      slot: 'notifications',
      bounds: null,
    });
    invoke(
      IPC_CHANNELS.overlayLayerSetBounds,
      mainFrameEvent(),
      zeroBoundsRequest,
    );

    expect(setBounds).toHaveBeenNthCalledWith(1, mainWindow, request);
    expect(setBounds).toHaveBeenNthCalledWith(2, mainWindow, {
      slot: 'notifications',
      bounds: null,
    });
    expect(setBounds).toHaveBeenNthCalledWith(3, mainWindow, zeroBoundsRequest);
  });

  it.each<OverlayLayerFocusRequest['target']>(['layer', 'main'])(
    'delegates the %s focus target',
    (target) => {
      const request: OverlayLayerFocusRequest = {
        slot: 'notifications',
        target,
      };

      invoke(IPC_CHANNELS.overlayLayerFocus, mainFrameEvent(), request);

      expect(focus).toHaveBeenCalledWith(mainWindow, request);
    },
  );

  it('rejects malformed bounds requests before delegating', () => {
    const invalidRequests: unknown[] = [
      undefined,
      null,
      'notifications',
      [],
      {},
      { bounds: null },
      { slot: 'unknown', bounds: null },
      { slot: 'notifications' },
      { slot: 'notifications', bounds: {} },
      {
        slot: 'notifications',
        bounds: { x: 1, y: 2, width: 3, height: 4, extra: true },
      },
      {
        slot: 'notifications',
        bounds: { x: Infinity, y: 0, width: 1, height: 1 },
      },
      {
        slot: 'notifications',
        bounds: { x: 0, y: NaN, width: 1, height: 1 },
      },
      {
        slot: 'notifications',
        bounds: { x: -1, y: 0, width: 1, height: 1 },
      },
      {
        slot: 'notifications',
        bounds: { x: 0, y: -1, width: 1, height: 1 },
      },
      {
        slot: 'notifications',
        bounds: { x: 0, y: 0, width: -1, height: 1 },
      },
      {
        slot: 'notifications',
        bounds: { x: 0, y: 0, width: 1, height: -1 },
      },
      {
        slot: 'notifications',
        bounds: { x: '0', y: 0, width: 1, height: 1 },
      },
      {
        slot: 'notifications',
        bounds: { x: 0, y: '0', width: 1, height: 1 },
      },
      {
        slot: 'notifications',
        bounds: { x: 0, y: 0, width: '1', height: 1 },
      },
      {
        slot: 'notifications',
        bounds: { x: 0, y: 0, width: 1, height: '1' },
      },
      {
        slot: 'notifications',
        bounds: { x: 0, y: 0, width: Number.NEGATIVE_INFINITY, height: 1 },
      },
      {
        slot: 'notifications',
        bounds: { x: 0, y: 0, width: 1, height: Number.POSITIVE_INFINITY },
      },
    ];

    for (const request of invalidRequests) {
      expect(() =>
        invoke(IPC_CHANNELS.overlayLayerSetBounds, mainFrameEvent(), request),
      ).toThrow(INVALID_REQUEST);
    }
    expect(setBounds).not.toHaveBeenCalled();
  });

  it('rejects malformed focus requests and unknown focus targets', () => {
    const invalidRequests: unknown[] = [
      undefined,
      null,
      {},
      { slot: 'unknown', target: 'layer' },
      { slot: 'notifications' },
      { slot: 'notifications', target: 'unknown' },
      { slot: 'notifications', target: null },
      { slot: 'notifications', target: 'layer', extra: true },
    ];

    for (const request of invalidRequests) {
      expect(() =>
        invoke(IPC_CHANNELS.overlayLayerFocus, mainFrameEvent(), request),
      ).toThrow(INVALID_REQUEST);
    }
    expect(focus).not.toHaveBeenCalled();
  });

  it('delegates valid requests even when the host does not have a layer', () => {
    invoke(IPC_CHANNELS.overlayLayerSetBounds, mainFrameEvent(), {
      slot: 'notifications',
      bounds: null,
    });
    invoke(IPC_CHANNELS.overlayLayerFocus, mainFrameEvent(), {
      slot: 'notifications',
      target: 'main',
    });

    expect(setBounds).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it.each<{
    label: string;
    event: () => FakeInvokeEvent;
    window: () => FakeWindow | null;
  }>([
    {
      label: 'a subframe',
      event: (): FakeInvokeEvent => ({ sender, senderFrame: {} }),
      window: (): FakeWindow => mainWindow,
    },
    {
      label: 'a missing frame',
      event: (): FakeInvokeEvent => ({ sender, senderFrame: null }),
      window: (): FakeWindow => mainWindow,
    },
    {
      label: 'different web contents with the same id',
      event: (): FakeInvokeEvent => ({
        sender: new FakeSender(sender.id),
        senderFrame: sender.mainFrame,
      }),
      window: (): FakeWindow => mainWindow,
    },
    {
      label: 'destroyed web contents',
      event: (): FakeInvokeEvent => {
        sender.destroyed = true;
        return mainFrameEvent();
      },
      window: (): FakeWindow => mainWindow,
    },
    {
      label: 'a destroyed main window',
      event: mainFrameEvent,
      window: (): FakeWindow => {
        mainWindow.destroyed = true;
        return mainWindow;
      },
    },
    {
      label: 'no main window',
      event: mainFrameEvent,
      window: (): null => null,
    },
  ])('rejects requests from $label', ({ event, window }) => {
    const currentAccessors = accessorsFor(window());
    registerOverlayLayerHandlers(currentAccessors);

    expect(() =>
      invoke(IPC_CHANNELS.overlayLayerSetBounds, event(), {
        slot: 'notifications',
        bounds: null,
      }),
    ).toThrow(INVALID_SENDER);
    expect(() =>
      invoke(IPC_CHANNELS.overlayLayerFocus, event(), {
        slot: 'notifications',
        target: 'layer',
      }),
    ).toThrow(INVALID_SENDER);
    expect(setBounds).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});

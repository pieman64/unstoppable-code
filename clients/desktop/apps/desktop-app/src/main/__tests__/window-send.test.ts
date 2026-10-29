import {
  sendToWindow,
  sendToWindowDetailed,
  type SendableBrowserWindow,
} from '../lib/window-send';
import {
  addRendererDeliveryBarrier,
  interceptWebContentsSends,
  observeWebContentsSends,
  sendToWebContents,
  sendWrappedToWebContents,
  setRendererMessageEncoder,
} from '../lib/web-contents-send';

interface WindowOverrides {
  detached?: boolean;
  frameDestroyed?: boolean;
  sendError?: Error;
  webContentsCrashed?: boolean;
  webContentsDestroyed?: boolean;
  windowDestroyed?: boolean;
}

function createWindow(overrides: WindowOverrides = {}): SendableBrowserWindow {
  return {
    isDestroyed(): boolean {
      return overrides.windowDestroyed ?? false;
    },
    webContents: {
      isCrashed(): boolean {
        return overrides.webContentsCrashed ?? false;
      },
      isDestroyed(): boolean {
        return overrides.webContentsDestroyed ?? false;
      },
      mainFrame: {
        detached: overrides.detached ?? false,
        isDestroyed(): boolean {
          return overrides.frameDestroyed ?? false;
        },
      },
      send(channel: string, ...args: unknown[]): void {
        if (overrides.sendError) {
          throw overrides.sendError;
        }

        void channel;
        void args;
      },
    },
  };
}

describe('sendToWindow', () => {
  it('returns the exact frame-detached failure reason', () => {
    expect(
      sendToWindowDetailed(createWindow({ detached: true }), 'channel'),
    ).toEqual({
      delivered: false,
      reason: 'frame_detached',
    });
  });

  it('returns false when Electron reports a disposed render frame', () => {
    expect(
      sendToWindowDetailed(
        createWindow({
          sendError: new Error(
            'Render frame was disposed before WebFrameMain could be accessed',
          ),
        }),
        'channel',
      ),
    ).toEqual({
      delivered: false,
      reason: 'render_frame_disposed',
    });
    expect(
      sendToWindow(
        createWindow({
          sendError: new Error(
            'Render frame was disposed before WebFrameMain could be accessed',
          ),
        }),
        'channel',
      ),
    ).toBe(false);
  });

  it('returns the exact destroyed/crashed failure reasons', () => {
    expect(sendToWindowDetailed(null, 'channel')).toEqual({
      delivered: false,
      reason: 'no_window',
    });
    expect(
      sendToWindowDetailed(createWindow({ windowDestroyed: true }), 'channel'),
    ).toEqual({
      delivered: false,
      reason: 'window_destroyed',
    });
    expect(
      sendToWindowDetailed(
        createWindow({ webContentsDestroyed: true }),
        'channel',
      ),
    ).toEqual({
      delivered: false,
      reason: 'webcontents_destroyed',
    });
    expect(
      sendToWindowDetailed(
        createWindow({ webContentsCrashed: true }),
        'channel',
      ),
    ).toEqual({
      delivered: false,
      reason: 'webcontents_crashed',
    });
    expect(
      sendToWindowDetailed(createWindow({ frameDestroyed: true }), 'channel'),
    ).toEqual({
      delivered: false,
      reason: 'frame_destroyed',
    });
  });

  it('rethrows unrelated send errors', () => {
    expect(() =>
      sendToWindow(
        createWindow({ sendError: new Error('serialization failed') }),
        'channel',
      ),
    ).toThrow('serialization failed');
  });
});

describe('renderer delivery barriers', () => {
  it('run before every send to that target, with the channel', () => {
    const order: string[] = [];
    const target = {
      send(channel: string): void {
        order.push(`send:${channel}`);
      },
    };
    const remove = addRendererDeliveryBarrier((barrierTarget, channel) => {
      order.push(
        `barrier:${channel}:${barrierTarget === target ? 'same' : 'other'}`,
      );
    });
    try {
      sendToWebContents(target, 'chat:event', { id: 1 });
      sendToWindow(
        { isDestroyed: () => false, webContents: createWindow().webContents },
        'other',
      );
    } finally {
      remove();
    }
    sendToWebContents(target, 'after-removal');
    expect(order).toEqual([
      'barrier:chat:event:same',
      'send:chat:event',
      'barrier:other:other',
      'send:after-removal',
    ]);
  });

  it('cannot block or fail a send', () => {
    const send = jest.fn();
    const remove = addRendererDeliveryBarrier(() => {
      throw new Error('barrier failed');
    });
    try {
      expect(() => {
        sendToWebContents({ send }, 'channel', 'payload');
      }).not.toThrow();
    } finally {
      remove();
    }
    expect(send).toHaveBeenCalledWith('channel', 'payload');
  });
});

describe('send interceptors, observers and wrapped sends', () => {
  it('hands an intercepted target its messages unencoded, unless it declines', () => {
    const send = jest.fn();
    const target = { send };
    const taken: Array<[string, readonly unknown[]]> = [];
    const removeEncoder = setRendererMessageEncoder('encoded:channel', {
      encode: (_target, message) => ({ encoded: message }),
      discard: () => undefined,
    });
    const removeInterceptor = interceptWebContentsSends(
      target,
      (channel, args): boolean => {
        if (channel === 'page:only') return false;
        taken.push([channel, args]);
        return true;
      },
    );
    try {
      sendToWebContents(target, 'encoded:channel', { id: 1 });
      sendToWebContents(target, 'page:only', 'hello');
    } finally {
      removeInterceptor();
      removeEncoder();
    }
    sendToWebContents(target, 'after-removal');
    expect(taken).toEqual([['encoded:channel', [{ id: 1 }]]]);
    expect(send.mock.calls).toEqual([
      ['page:only', 'hello'],
      ['after-removal'],
    ]);
  });

  it('reports each delivered message as published, never failing the send', () => {
    const send = jest.fn();
    const target = { send };
    const seen: Array<[object, string, readonly unknown[]]> = [];
    const removeEncoder = setRendererMessageEncoder('encoded:channel', {
      encode: (_target, message) => ({ encoded: message }),
      discard: () => undefined,
    });
    const removeObserver = observeWebContentsSends(
      (observed, channel, args) => {
        seen.push([observed, channel, args]);
      },
    );
    const removeFailing = observeWebContentsSends(() => {
      throw new Error('observer failed');
    });
    try {
      sendToWebContents(target, 'encoded:channel', { id: 1 });
      expect(() => {
        sendToWebContents(
          {
            send: (): void => {
              throw new Error('send failed');
            },
          },
          'failed:send',
        );
      }).toThrow('send failed');
    } finally {
      removeFailing();
      removeObserver();
      removeEncoder();
    }
    expect(send).toHaveBeenCalledWith('encoded:channel', {
      encoded: { id: 1 },
    });
    expect(seen).toEqual([[target, 'encoded:channel', [{ id: 1 }]]]);
  });

  it('wraps a message in an envelope, encoded for the target', () => {
    const send = jest.fn();
    const target = { send };
    const order: string[] = [];
    const removeEncoder = setRendererMessageEncoder('encoded:channel', {
      encode: (encodedFor, message) => ({
        encoded: message,
        same: encodedFor === target,
      }),
      discard: () => undefined,
    });
    const removeBarrier = addRendererDeliveryBarrier((_target, channel) => {
      order.push(channel);
    });
    try {
      sendWrappedToWebContents(target, 'envelope', 'encoded:channel', [
        { id: 1 },
      ]);
      sendWrappedToWebContents(target, 'envelope', 'plain:channel', [1, 2]);
    } finally {
      removeBarrier();
      removeEncoder();
    }
    expect(order).toEqual(['encoded:channel', 'plain:channel']);
    expect(send.mock.calls).toEqual([
      ['envelope', 'encoded:channel', [{ encoded: { id: 1 }, same: true }]],
      ['envelope', 'plain:channel', [1, 2]],
    ]);
  });
});

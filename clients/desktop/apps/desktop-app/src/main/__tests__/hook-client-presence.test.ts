import { EventEmitter } from 'node:events';

const appEvents = new EventEmitter();

jest.mock('electron', () => ({
  app: {
    on: (event: string, listener: () => void): void => {
      appEvents.on(event, listener);
    },
    removeListener: (event: string, listener: () => void): void => {
      appEvents.removeListener(event, listener);
    },
  },
}));

import type { BrowserWindow } from 'electron';
import { hookClientPresence } from '../lib/hook-client-presence';

function windowDouble(): BrowserWindow {
  const window = new EventEmitter();
  return Object.assign(window, {
    isDestroyed: (): boolean => false,
  }) as unknown as BrowserWindow;
}

describe('hookClientPresence (CAN-4145)', () => {
  afterEach(() => {
    appEvents.removeAllListeners();
  });

  it('waits on app.on browser-window-created until the window is stored', async () => {
    let window: BrowserWindow | null = null;
    const presence = hookClientPresence(() => window);
    expect(presence.attached()).toBe(false);
    let attached = false;
    const waiting = presence
      .whenAttached(new AbortController().signal)
      .then(() => {
        attached = true;
      });
    // The event fires before the creator stores the window.
    appEvents.emit('browser-window-created');
    window = windowDouble();
    await waiting;
    expect(attached).toBe(true);
    expect(appEvents.listenerCount('browser-window-created')).toBe(0);
  });

  it('keeps waiting when another window opens, and stops when cancelled', async () => {
    const presence = hookClientPresence(() => null);
    const controller = new AbortController();
    const waiting = presence.whenAttached(controller.signal);
    appEvents.emit('browser-window-created');
    await Promise.resolve();
    expect(appEvents.listenerCount('browser-window-created')).toBe(1);
    controller.abort();
    await waiting;
    expect(appEvents.listenerCount('browser-window-created')).toBe(0);
  });
});

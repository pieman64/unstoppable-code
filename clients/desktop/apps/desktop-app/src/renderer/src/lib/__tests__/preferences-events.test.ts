import type { PreferencesData } from '@canopy/desktop-shared/types';
import {
  CANOPY_PREFERENCES_UPDATED_EVENT,
  emitPreferencesUpdated,
  subscribePreferencesUpdated,
} from '../preferences-events';
import { makeTestPreferences } from '@/test-utils/preferences';

interface ListenerEntry {
  type: string;
  handler: (event: Event) => void;
}

interface MockWindow {
  addEventListener: (type: string, handler: (event: Event) => void) => void;
  removeEventListener: (type: string, handler: (event: Event) => void) => void;
  dispatchEvent: (event: Event) => boolean;
  listeners: ListenerEntry[];
}

function installMockWindow(): MockWindow {
  const listeners: ListenerEntry[] = [];
  const mock: MockWindow = {
    listeners,
    addEventListener: (type, handler): void => {
      listeners.push({ type, handler });
    },
    removeEventListener: (type, handler): void => {
      const index = listeners.findIndex(
        (entry) => entry.type === type && entry.handler === handler,
      );
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    },
    dispatchEvent: (event): boolean => {
      for (const entry of listeners.slice()) {
        if (entry.type === event.type) {
          entry.handler(event);
        }
      }
      return true;
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: mock,
  });
  return mock;
}

describe('preferences event bridge', () => {
  let originalWindow: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  });

  afterEach(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('uses the documented event channel name', () => {
    expect(CANOPY_PREFERENCES_UPDATED_EVENT).toBe('canopy:preferences-updated');
  });

  it('subscribers receive emitted preferences and unsubscribe cleanly', () => {
    installMockWindow();

    const received: PreferencesData[] = [];
    const unsubscribe = subscribePreferencesUpdated((next) => {
      received.push(next);
    });

    emitPreferencesUpdated(makeTestPreferences({ showDiagnosticsPill: true }));

    emitPreferencesUpdated(makeTestPreferences({ showDiagnosticsPill: false }));

    unsubscribe();

    emitPreferencesUpdated(makeTestPreferences({ showDiagnosticsPill: true }));

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ showDiagnosticsPill: true });
    expect(received[1]).toMatchObject({ showDiagnosticsPill: false });
  });

  it('emit is a no-op when window is undefined', () => {
    Reflect.deleteProperty(globalThis, 'window');
    expect(() =>
      emitPreferencesUpdated(
        makeTestPreferences({ showDiagnosticsPill: true }),
      ),
    ).not.toThrow();
  });

  it('subscribe returns a no-op cleanup when window is undefined', () => {
    Reflect.deleteProperty(globalThis, 'window');
    const cleanup = subscribePreferencesUpdated(() => {});
    expect(() => cleanup()).not.toThrow();
  });
});

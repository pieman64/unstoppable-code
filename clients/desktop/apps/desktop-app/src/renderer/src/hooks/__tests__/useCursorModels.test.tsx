/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  getModelDisplayName,
  initCursorModels,
  type CursorConnectionStatus,
  type CursorModelEntry,
} from '@canopy/desktop-shared/types';
import { useCursorModels } from '../useCursorModels';
import { hydrateCursorModelCache } from '../cursor-model-cache';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const entries: CursorModelEntry[] = [
  { id: 'cursor:gpt-test', rawModelId: 'gpt-test', label: 'GPT Test' },
];
const connected: CursorConnectionStatus = {
  enabled: true,
  supported: true,
  installed: true,
  version: 'test',
  phase: 'connected',
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(): {
  listModels: jest.Mock<Promise<CursorModelEntry[]>, []>;
  loadPreferences: jest.Mock<Promise<{ cursorEnabled: boolean }>, []>;
  render: (open: boolean, available?: boolean, key?: string) => Promise<void>;
  pair: () => Promise<void>;
  text: () => string | null;
  progress: (status: CursorConnectionStatus) => Promise<void>;
  hostPreferences: (enabled: boolean) => Promise<void>;
  close: () => Promise<void>;
} {
  const original = Object.getOwnPropertyDescriptor(window, 'api');
  const listModels = jest.fn<Promise<CursorModelEntry[]>, []>();
  const progressListeners = new Set<(status: CursorConnectionStatus) => void>();
  const hostPreferencesListeners = new Set<() => void>();
  let enabled = true;
  const loadPreferences = jest.fn(() =>
    Promise.resolve({ cursorEnabled: enabled }),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      cursorConnection: {
        listModels,
        onProgress: (listener: (status: CursorConnectionStatus) => void) => {
          progressListeners.add(listener);
          return (): void => {
            progressListeners.delete(listener);
          };
        },
      },
      loadPreferences,
      onPreferencesChanged: (listener: () => void) => {
        hostPreferencesListeners.add(listener);
        return (): void => {
          hostPreferencesListeners.delete(listener);
        };
      },
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  function Probe({
    open,
    available,
  }: {
    open: boolean;
    available: boolean;
  }): React.JSX.Element {
    return <pre>{JSON.stringify(useCursorModels(available, open))}</pre>;
  }
  return {
    listModels,
    loadPreferences,
    render: async (open, available = true, key = 'picker'): Promise<void> => {
      await act(async () => {
        root.render(<Probe key={key} open={open} available={available} />);
        await Promise.resolve();
      });
    },
    pair: async (): Promise<void> => {
      await act(async () => {
        root.render(
          <>
            <Probe open available />
            <Probe open available />
          </>,
        );
        await Promise.resolve();
      });
    },
    text: () => container.textContent,
    progress: async (status): Promise<void> => {
      await act(async () => {
        progressListeners.forEach((listener) => listener(status));
        await Promise.resolve();
      });
    },
    hostPreferences: async (value): Promise<void> => {
      enabled = value;
      await act(async () => {
        hostPreferencesListeners.forEach((listener) => listener());
        await Promise.resolve();
      });
    },
    close: async (): Promise<void> => {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      // Cache listeners live for the renderer lifetime, including between picker mounts.
      window.dispatchEvent(new Event('pagehide'));
      if (original) Object.defineProperty(window, 'api', original);
      else Reflect.deleteProperty(window, 'api');
    },
  };
}

test('discovers only on open, preserves Default on failure, and retries on reopen', async () => {
  const f = setup();
  try {
    await f.render(false);
    expect(f.listModels).not.toHaveBeenCalled();
    f.listModels.mockRejectedValueOnce(new Error('offline'));
    await f.render(true);
    expect(f.text()).toContain('cursor-default');
    expect(f.text()).toContain('Reopen this menu');
    await f.render(false);
    f.listModels.mockResolvedValueOnce(entries);
    await f.render(true);
    expect(f.listModels).toHaveBeenCalledTimes(2);
    expect(f.text()).toContain('GPT Test');
    expect(getModelDisplayName('cursor:gpt-test')).toBe('GPT Test');
    expect(f.text()).not.toContain('message');
  } finally {
    await f.close();
  }
});

test('a new renderer uses the host catalog immediately while discovery is pending', async () => {
  const f = setup();
  try {
    // Bootstrap already hydrated the registry before this picker mounted.
    initCursorModels(entries);
    f.listModels.mockReturnValueOnce(deferred<CursorModelEntry[]>().promise);
    await f.render(false);
    expect(f.text()).toContain('GPT Test');
    await f.render(true);
    expect(f.text()).toContain('GPT Test');
    // Its models are already listed, so the refresh behind them stays quiet.
    expect(f.text()).not.toContain('Loading Cursor models');
  } finally {
    await f.close();
  }
});

test('a new picker immediately shows the last catalog during refresh and after failure', async () => {
  const f = setup();
  try {
    f.listModels.mockResolvedValueOnce(entries);
    await f.render(true);
    await f.render(false);
    const refresh = deferred<CursorModelEntry[]>();
    f.listModels.mockReturnValueOnce(refresh.promise);
    await f.render(true, true, 'new-picker');
    expect(f.text()).toContain('GPT Test');
    expect(f.text()).not.toContain('Loading Cursor models');
    await act(async () => {
      refresh.reject(new Error('offline'));
      await Promise.resolve();
    });
    expect(f.text()).toContain('GPT Test');
    expect(f.text()).toContain('Reopen this menu');
  } finally {
    await f.close();
  }
});

test('closing or remounting during discovery shares one request and warms the cache', async () => {
  const f = setup();
  const discovery = deferred<CursorModelEntry[]>();
  f.listModels.mockReturnValue(discovery.promise);
  try {
    await f.render(true);
    await f.render(false);
    await f.render(true, true, 'other-picker');
    expect(f.listModels).toHaveBeenCalledTimes(1);
    await f.render(false);
    await act(async () => {
      discovery.resolve(entries);
      await Promise.resolve();
    });
    await f.render(false, true, 'third-picker');
    expect(f.text()).toContain('GPT Test');
    expect(f.text()).not.toContain('message');
    // Ineligible surfaces must not erase a connected account's cache.
    await f.render(false, false, 'unsupported-surface');
    expect(f.text()).not.toContain('GPT Test');
    await f.render(false, true, 'fourth-picker');
    expect(f.text()).toContain('GPT Test');
  } finally {
    await f.close();
  }
});

test('disconnect clears all cached entries and ignores a late discovery response', async () => {
  const f = setup();
  try {
    f.listModels.mockResolvedValueOnce(entries);
    await f.render(true);
    await f.render(false);
    const old = deferred<CursorModelEntry[]>();
    f.listModels.mockReturnValueOnce(old.promise);
    await f.render(true);
    await f.render(false, false);
    await f.hostPreferences(false);
    await act(async () => {
      old.resolve(entries);
      await Promise.resolve();
    });
    await f.hostPreferences(true);
    await f.render(false, true, 'reconnected-picker');
    expect(f.text()).not.toContain('GPT Test');
  } finally {
    await f.close();
  }
});

test('reconnecting for another account invalidates pending work even without an unavailable render', async () => {
  const f = setup();
  try {
    const old = deferred<CursorModelEntry[]>();
    f.listModels.mockReturnValueOnce(old.promise);
    await f.render(true);
    await f.render(false);
    await f.progress({ ...connected, phase: 'signing-in' });
    await f.progress(connected);
    await act(async () => {
      old.resolve(entries);
      await Promise.resolve();
    });
    await f.render(false, true, 'reconnected-picker');
    expect(f.text()).not.toContain('GPT Test');
    f.listModels.mockResolvedValueOnce([
      { id: 'cursor:other', rawModelId: 'other', label: 'Other account model' },
    ]);
    await f.render(true);
    expect(f.text()).toContain('Other account model');
    expect(f.text()).not.toContain('GPT Test');
  } finally {
    await f.close();
  }
});

test('a failed refresh retains the catalog in the same picker', async () => {
  const f = setup();
  try {
    f.listModels.mockResolvedValueOnce(entries);
    await f.render(true);
    await f.render(false);
    f.listModels.mockRejectedValueOnce(new Error('offline'));
    await f.render(true);
    expect(f.text()).toContain('GPT Test');
    expect(f.text()).toContain('Reopen this menu');
  } finally {
    await f.close();
  }
});

test('connection progress clears an already visible catalog', async () => {
  const f = setup();
  try {
    f.listModels.mockResolvedValueOnce(entries);
    await f.render(true);
    await f.render(false);
    await f.progress({ ...connected, phase: 'signing-in' });
    expect(f.text()).not.toContain('GPT Test');
    await f.progress(connected);
    expect(f.text()).not.toContain('GPT Test');
  } finally {
    await f.close();
  }
});

test('an old completion cannot overwrite a new connection refresh', async () => {
  const f = setup();
  try {
    const old = deferred<CursorModelEntry[]>();
    const fresh = deferred<CursorModelEntry[]>();
    f.listModels
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    await f.render(true);
    await f.render(false);
    await f.progress({ ...connected, phase: 'signing-in' });
    await f.progress(connected);
    await f.render(true);
    await act(async () => {
      old.resolve(entries);
      await Promise.resolve();
    });
    expect(f.text()).not.toContain('GPT Test');
    expect(f.text()).toContain('Loading Cursor models');
    await act(async () => {
      fresh.resolve([
        { id: 'cursor:new', rawModelId: 'new', label: 'New account model' },
      ]);
      await Promise.resolve();
    });
    expect(f.text()).toContain('New account model');
  } finally {
    await f.close();
  }
});

test('simultaneous pickers share discovery and receive the same catalog', async () => {
  const f = setup();
  const discovery = deferred<CursorModelEntry[]>();
  f.listModels.mockReturnValue(discovery.promise);
  try {
    await f.pair();
    expect(f.listModels).toHaveBeenCalledTimes(1);
    await act(async () => {
      discovery.resolve(entries);
      await Promise.resolve();
    });
    expect(f.text()?.match(/GPT Test/g)).toHaveLength(2);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('canopy:preferences-updated', {
          detail: { cursorEnabled: false, showDiagnosticsPill: false },
        }),
      );
      await Promise.resolve();
    });
    expect(f.text()).not.toContain('GPT Test');
    expect(getModelDisplayName('cursor:gpt-test')).not.toBe('GPT Test');
  } finally {
    await f.close();
  }
});

test('a delayed preference read cannot clear a new connection catalog', async () => {
  const f = setup();
  try {
    f.listModels.mockResolvedValueOnce(entries);
    await f.render(true);
    await f.render(false);
    const oldPreferences = deferred<{ cursorEnabled: boolean }>();
    f.loadPreferences.mockReturnValueOnce(oldPreferences.promise);
    await f.hostPreferences(false);
    expect(f.loadPreferences).toHaveBeenCalledTimes(1);
    expect(f.loadPreferences).toHaveReturnedWith(oldPreferences.promise);
    await f.progress({ ...connected, phase: 'signing-in' });
    await f.progress(connected);
    f.listModels.mockResolvedValueOnce([
      { id: 'cursor:new', rawModelId: 'new', label: 'New account model' },
    ]);
    await f.render(true);
    expect(f.text()).toContain('New account model');
    await act(async () => {
      oldPreferences.resolve({ cursorEnabled: false });
      await Promise.resolve();
    });
    expect(f.text()).toContain('New account model');
  } finally {
    await f.close();
  }
});

test('host broadcasts hydrate an already mounted picker and clear revoked entries', async () => {
  const f = setup();
  try {
    await f.render(false);
    act(() => {
      hydrateCursorModelCache(window.api, entries);
    });
    expect(f.text()).toContain('GPT Test');
    act(() => {
      hydrateCursorModelCache(window.api, []);
    });
    expect(f.text()).not.toContain('GPT Test');
  } finally {
    await f.close();
  }
});

test('an unchanged host catalog clears a previous refresh failure', async () => {
  const f = setup();
  try {
    f.listModels.mockResolvedValueOnce(entries);
    await f.render(true);
    await f.render(false);
    f.listModels.mockRejectedValueOnce(new Error('offline'));
    await f.render(true);
    expect(f.text()).toContain('Could not load Cursor models');
    act(() => {
      hydrateCursorModelCache(window.api, entries);
    });
    expect(f.text()).toContain('GPT Test');
    expect(f.text()).not.toContain('message');
  } finally {
    await f.close();
  }
});

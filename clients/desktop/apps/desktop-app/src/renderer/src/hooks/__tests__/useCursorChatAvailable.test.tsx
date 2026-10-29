/** @jest-environment jsdom */
let mockCursorFlagEnabled = true;
jest.mock('@/stores/featureFlagsStore', () => ({
  useFeatureFlagsStore: (
    selector: (state: { isEnabled: () => boolean }) => boolean,
  ): boolean => selector({ isEnabled: () => mockCursorFlagEnabled }),
}));
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { CursorConnectionStatus } from '@canopy/desktop-shared/types';
import { useCursorChatAvailable } from '../useCursorChatAvailable';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

it.each([
  {
    enabled: true,
    installed: true,
    supported: true,
    development: false,
    path: '',
    expected: true,
  },
  {
    enabled: true,
    installed: false,
    supported: true,
    development: true,
    path: '/user/agent',
    expected: false,
  },
  {
    enabled: true,
    installed: true,
    supported: false,
    development: true,
    path: '/user/agent',
    expected: false,
  },
  {
    enabled: false,
    installed: false,
    supported: true,
    development: true,
    path: '/user/agent',
    expected: false,
  },
  {
    enabled: false,
    installed: true,
    supported: true,
    development: false,
    path: '/user/agent',
    expected: false,
  },
  {
    enabled: false,
    installed: true,
    supported: false,
    development: true,
    path: '/user/agent',
    expected: false,
  },
  {
    enabled: false,
    installed: true,
    supported: true,
    development: true,
    path: '',
    expected: false,
  },
])('requires enabled, supported, installed managed chat: %j', async (input) => {
  mockCursorFlagEnabled = true;
  const original = Object.getOwnPropertyDescriptor(window, 'api');
  const status: CursorConnectionStatus = {
    supported: input.supported,
    enabled: input.enabled,
    installed: input.installed,
    version: 'test',
    phase: 'idle',
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      cursorApprovalCheck: {
        available: (): Promise<boolean> => Promise.resolve(input.development),
      },
      cursorConnection: {
        status: (): Promise<CursorConnectionStatus> => Promise.resolve(status),
      },
      loadPreferences: () =>
        Promise.resolve({
          cursorEnabled: input.enabled,
          cursorAgentPath: input.path,
        }),
      onPreferencesChanged: () => (): void => {},
    },
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  function Probe(): null {
    container.dataset.available = String(useCursorChatAvailable(true));
    return null;
  }
  try {
    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    expect(container.dataset.available).toBe(String(input.expected));
    mockCursorFlagEnabled = false;
    act(() => {
      root.render(<Probe />);
    });
    expect(container.dataset.available).toBe('false');
  } finally {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    if (original) Object.defineProperty(window, 'api', original);
    else Reflect.deleteProperty(window, 'api');
  }
});

it('starts a later mount from the last known answer instead of false', async () => {
  mockCursorFlagEnabled = true;
  const original = Object.getOwnPropertyDescriptor(window, 'api');
  const connected: CursorConnectionStatus = {
    supported: true,
    enabled: true,
    installed: true,
    version: 'test',
    phase: 'idle',
  };
  let statusReads = 0;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      cursorConnection: {
        // The first read answers; later reads stay pending, like a slow probe.
        status: (): Promise<CursorConnectionStatus> => {
          statusReads += 1;
          return statusReads === 1
            ? Promise.resolve(connected)
            : new Promise<CursorConnectionStatus>(() => undefined);
        },
      },
      loadPreferences: () => Promise.resolve({ cursorEnabled: true }),
      onPreferencesChanged: () => (): void => {},
    },
  });
  const container = document.createElement('div');
  const first = createRoot(container);
  function Probe(): null {
    container.dataset.available = String(useCursorChatAvailable(true));
    return null;
  }
  try {
    await act(async () => {
      first.render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.dataset.available).toBe('true');
    act(() => first.unmount());

    const second = createRoot(container);
    act(() => second.render(<Probe />));
    expect(container.dataset.available).toBe('true');
    act(() => second.unmount());
  } finally {
    if (original) Object.defineProperty(window, 'api', original);
    else Reflect.deleteProperty(window, 'api');
  }
});

it('does not cache a superseded Cursor status response', async () => {
  mockCursorFlagEnabled = true;
  const original = Object.getOwnPropertyDescriptor(window, 'api');
  const connected: CursorConnectionStatus = {
    supported: true,
    enabled: true,
    installed: true,
    version: 'test',
    phase: 'idle',
  };
  let cursorEnabled = true;
  let notifyPreferencesChanged: () => void = () => undefined;
  let resolveStatus: (status: CursorConnectionStatus) => void = () => undefined;
  const pendingStatus = new Promise<CursorConnectionStatus>((resolve) => {
    resolveStatus = resolve;
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      cursorConnection: { status: () => pendingStatus },
      loadPreferences: () => Promise.resolve({ cursorEnabled }),
      onPreferencesChanged: (listener: () => void) => {
        notifyPreferencesChanged = listener;
        return (): void => {};
      },
    },
  });
  const container = document.createElement('div');
  const first = createRoot(container);
  function Probe(): null {
    container.dataset.available = String(useCursorChatAvailable(true));
    return null;
  }
  try {
    await act(async () => {
      first.render(<Probe />);
      await Promise.resolve();
    });
    cursorEnabled = false;
    await act(async () => {
      notifyPreferencesChanged();
      await Promise.resolve();
    });
    expect(container.dataset.available).toBe('false');

    await act(async () => {
      resolveStatus(connected);
      await Promise.resolve();
    });
    act(() => first.unmount());

    const second = createRoot(container);
    act(() => second.render(<Probe />));
    expect(container.dataset.available).toBe('false');
    act(() => second.unmount());
  } finally {
    if (original) Object.defineProperty(window, 'api', original);
    else Reflect.deleteProperty(window, 'api');
  }
});

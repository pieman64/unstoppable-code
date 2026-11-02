const mockAppFocus = jest.fn();
const mockGetFocusedWindow = jest.fn<unknown, []>(() => null);

interface MockWindow {
  isDestroyed: jest.Mock<boolean, []>;
  isMinimized: jest.Mock<boolean, []>;
  isVisible: jest.Mock<boolean, []>;
  isAlwaysOnTop: jest.Mock<boolean, []>;
  restore: jest.Mock<void, []>;
  show: jest.Mock<void, []>;
  focus: jest.Mock<void, []>;
  setAlwaysOnTop: jest.Mock<void, [boolean]>;
  moveTop: jest.Mock<void, []>;
}

jest.mock('electron', () => ({
  app: {
    get focus(): typeof mockAppFocus {
      return mockAppFocus;
    },
    isPackaged: false,
  },
  BrowserWindow: {
    get getFocusedWindow(): typeof mockGetFocusedWindow {
      return mockGetFocusedWindow;
    },
  },
}));

import type { BrowserWindow } from 'electron';
import {
  focusMainWindow,
  focusWindow,
  isAppFrontmost,
  setMainWindowResolver,
} from '../lib/main-window-focus';
import {
  getUiAutomationWindowWebPreferences,
  isHeadlessUiAutomationLaunch,
  shouldShowUiAutomationWindow,
} from '../lib/ui-automation-window';

const REAL_PLATFORM = process.platform;
const ORIGINAL_ISOLATED_LOGGING = process.env.CANOPY_E2E_ISOLATED_LOGGING;
const ORIGINAL_SHOW_WINDOW = process.env.CANOPY_E2E_SHOW_WINDOW;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function createWindow(options?: {
  minimized?: boolean;
  visible?: boolean;
  alwaysOnTop?: boolean;
}): BrowserWindow & MockWindow {
  const window = jest.createMockFromModule<BrowserWindow>('electron');
  return Object.assign(window, {
    isDestroyed: jest.fn(() => false),
    isMinimized: jest.fn(() => options?.minimized ?? false),
    isVisible: jest.fn(() => options?.visible ?? true),
    isAlwaysOnTop: jest.fn(() => options?.alwaysOnTop ?? false),
    restore: jest.fn<void, []>(),
    show: jest.fn<void, []>(),
    focus: jest.fn<void, []>(),
    setAlwaysOnTop: jest.fn<void, [boolean]>(),
    moveTop: jest.fn<void, []>(),
  });
}

describe('main window focus', () => {
  beforeEach(() => {
    delete process.env.CANOPY_E2E_ISOLATED_LOGGING;
    delete process.env.CANOPY_E2E_SHOW_WINDOW;
  });

  afterEach(() => {
    setMainWindowResolver(() => null);
    setPlatform(REAL_PLATFORM);
    if (ORIGINAL_ISOLATED_LOGGING === undefined) {
      delete process.env.CANOPY_E2E_ISOLATED_LOGGING;
    } else {
      process.env.CANOPY_E2E_ISOLATED_LOGGING = ORIGINAL_ISOLATED_LOGGING;
    }
    if (ORIGINAL_SHOW_WINDOW === undefined) {
      delete process.env.CANOPY_E2E_SHOW_WINDOW;
    } else {
      process.env.CANOPY_E2E_SHOW_WINDOW = ORIGINAL_SHOW_WINDOW;
    }
    jest.clearAllMocks();
  });

  it('restores, shows, and focuses the resolved main window', () => {
    const window = createWindow({ minimized: true, visible: false });
    setMainWindowResolver(() => window);

    focusMainWindow();

    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('reports whether any app window currently has OS focus (CAN-1993)', () => {
    // Agent-driven raises gate `show()`/`focus()`/`moveTop()` on this so a
    // background automation never pulls the app in front of another one.
    mockGetFocusedWindow.mockReturnValueOnce(null);
    expect(isAppFrontmost()).toBe(false);
    mockGetFocusedWindow.mockReturnValueOnce({});
    expect(isAppFrontmost()).toBe(true);
  });

  it('does not reveal an unpackaged release-like automation window by default', () => {
    process.env.CANOPY_E2E_ISOLATED_LOGGING = '1';
    process.env.CANOPY_E2E_SHOW_WINDOW = '0';
    const window = createWindow({ minimized: true, visible: false });
    setMainWindowResolver(() => window);

    focusMainWindow({ steal: true, moveTop: true });

    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
    expect(window.moveTop).not.toHaveBeenCalled();
    expect(mockAppFocus).not.toHaveBeenCalled();
    expect(shouldShowUiAutomationWindow()).toBe(false);
  });

  it('limits headless release-like markers to unpackaged automation launches', () => {
    expect(isHeadlessUiAutomationLaunch(true, true, {})).toBe(true);
    expect(
      isHeadlessUiAutomationLaunch(true, true, {
        CANOPY_E2E_SHOW_WINDOW: '1',
      }),
    ).toBe(false);
    expect(
      isHeadlessUiAutomationLaunch(false, false, {
        CANOPY_E2E_ISOLATED_LOGGING: '1',
        CANOPY_E2E_SHOW_WINDOW: '0',
      }),
    ).toBe(true);
    expect(
      isHeadlessUiAutomationLaunch(false, false, {
        CANOPY_E2E_ISOLATED_LOGGING: '1',
        CANOPY_E2E_SHOW_WINDOW: '1',
      }),
    ).toBe(false);
    expect(
      isHeadlessUiAutomationLaunch(false, true, {
        CANOPY_E2E_ISOLATED_LOGGING: '1',
        CANOPY_E2E_SHOW_WINDOW: '0',
      }),
    ).toBe(false);
  });

  it('keeps Linux hidden automation drawing without changing visible or production windows', () => {
    expect(
      getUiAutomationWindowWebPreferences('linux', true, false, {}),
    ).toEqual({ offscreen: true });
    expect(
      getUiAutomationWindowWebPreferences('linux', true, false, {
        CANOPY_E2E_SHOW_WINDOW: '1',
      }),
    ).toEqual({});
    expect(
      getUiAutomationWindowWebPreferences('linux', false, false, {}),
    ).toEqual({});
    expect(
      getUiAutomationWindowWebPreferences('linux', false, false, {
        CANOPY_E2E_ISOLATED_LOGGING: '1',
      }),
    ).toEqual({ offscreen: true });
    expect(
      getUiAutomationWindowWebPreferences('linux', false, true, {
        CANOPY_E2E_ISOLATED_LOGGING: '1',
      }),
    ).toEqual({});
    for (const platform of ['darwin', 'win32'] as const) {
      expect(
        getUiAutomationWindowWebPreferences(platform, true, false, {}),
      ).toEqual({});
    }
  });

  it('renders hidden Windows automation offscreen only when the launch opts in', () => {
    const optIn = { CANOPY_E2E_OFFSCREEN_WINDOW: '1' };
    expect(
      getUiAutomationWindowWebPreferences('win32', true, false, optIn),
    ).toEqual({ offscreen: true });
    expect(
      getUiAutomationWindowWebPreferences('win32', false, false, {
        ...optIn,
        CANOPY_E2E_ISOLATED_LOGGING: '1',
      }),
    ).toEqual({ offscreen: true });
    expect(
      getUiAutomationWindowWebPreferences('win32', true, false, {
        ...optIn,
        CANOPY_E2E_SHOW_WINDOW: '1',
      }),
    ).toEqual({});
    expect(
      getUiAutomationWindowWebPreferences('win32', false, false, optIn),
    ).toEqual({});
    expect(
      getUiAutomationWindowWebPreferences('win32', false, true, {
        ...optIn,
        CANOPY_E2E_ISOLATED_LOGGING: '1',
      }),
    ).toEqual({});
    expect(
      getUiAutomationWindowWebPreferences('win32', true, false, {
        CANOPY_E2E_OFFSCREEN_WINDOW: '0',
      }),
    ).toEqual({});
    expect(
      getUiAutomationWindowWebPreferences('darwin', true, false, optIn),
    ).toEqual({});
  });

  it('does not steal the foreground unless asked to', () => {
    // Deep links (CAN-2361) call this without `steal`, and must keep their
    // pre-existing restore/show/focus behavior.
    setPlatform('darwin');
    const window = createWindow();
    setMainWindowResolver(() => window);

    focusMainWindow();

    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(mockAppFocus).not.toHaveBeenCalled();
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it('steals the foreground on macOS when requested', () => {
    setPlatform('darwin');
    const window = createWindow();
    setMainWindowResolver(() => window);

    focusMainWindow({ steal: true });

    expect(mockAppFocus).toHaveBeenCalledWith({ steal: true });
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it('raises the window on Windows via the always-on-top toggle', () => {
    setPlatform('win32');
    const window = createWindow();
    setMainWindowResolver(() => window);

    focusMainWindow({ steal: true });

    // Windows blocks a background process from taking the foreground outright,
    // so the supported path is a brief always-on-top toggle plus moveTop().
    expect(window.setAlwaysOnTop.mock.calls).toEqual([[true], [false]]);
    expect(window.moveTop).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(mockAppFocus).not.toHaveBeenCalled();

    // Ordering is load-bearing: un-pinning before the focus lands loses the
    // raise, so `focus()` must happen while the window is still pinned.
    const pinOrder = window.setAlwaysOnTop.mock.invocationCallOrder;
    const focusOrder = window.focus.mock.invocationCallOrder[0];
    const moveTopOrder = window.moveTop.mock.invocationCallOrder[0];
    expect(pinOrder[0]).toBeLessThan(moveTopOrder);
    expect(moveTopOrder).toBeLessThan(focusOrder);
    expect(focusOrder).toBeLessThan(pinOrder[1]);
  });

  it('un-pins the window on Windows even when the raise throws', () => {
    // Callers treat focusing as best-effort and swallow throws, so without a
    // `finally` the app would be left pinned above every other application.
    setPlatform('win32');
    const window = createWindow();
    window.moveTop.mockImplementation(() => {
      throw new Error('moveTop failed');
    });
    setMainWindowResolver(() => window);

    expect(() => focusMainWindow({ steal: true })).toThrow('moveTop failed');
    expect(window.setAlwaysOnTop.mock.calls).toEqual([[true], [false]]);
  });

  it('un-pins the window on Windows even when focus throws', () => {
    setPlatform('win32');
    const window = createWindow();
    window.focus.mockImplementation(() => {
      throw new Error('focus failed');
    });
    setMainWindowResolver(() => window);

    expect(() => focusMainWindow({ steal: true })).toThrow('focus failed');
    expect(window.setAlwaysOnTop.mock.calls).toEqual([[true], [false]]);
  });

  it('leaves an already-pinned window pinned on Windows', () => {
    setPlatform('win32');
    const window = createWindow({ alwaysOnTop: true });
    setMainWindowResolver(() => window);

    focusMainWindow({ steal: true });

    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('focuses an explicitly supplied window with moveTop', () => {
    // This is the shape ipc/app-advisor.ts uses; it must keep its original
    // restore -> show -> focus -> moveTop behavior after the dedupe.
    setPlatform('darwin');
    const window = createWindow({ minimized: true, visible: false });

    focusWindow(window, { moveTop: true });

    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.moveTop).toHaveBeenCalledTimes(1);
    // No steal requested, so the foreground is not taken.
    expect(mockAppFocus).not.toHaveBeenCalled();
    expect(window.focus.mock.invocationCallOrder[0]).toBeLessThan(
      window.moveTop.mock.invocationCallOrder[0],
    );
  });

  it('does not moveTop unless asked', () => {
    const window = createWindow();

    focusWindow(window);

    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(window.moveTop).not.toHaveBeenCalled();
  });

  it('ignores a null or destroyed explicit window', () => {
    const destroyed = createWindow();
    destroyed.isDestroyed.mockReturnValue(true);

    focusWindow(null, { moveTop: true });
    focusWindow(destroyed, { moveTop: true });

    expect(destroyed.focus).not.toHaveBeenCalled();
    expect(destroyed.moveTop).not.toHaveBeenCalled();
  });

  it('does nothing when the resolved window is missing or destroyed', () => {
    const destroyedWindow = createWindow();
    destroyedWindow.isDestroyed.mockReturnValue(true);

    focusMainWindow({ steal: true });
    setMainWindowResolver(() => destroyedWindow);
    focusMainWindow({ steal: true });

    expect(destroyedWindow.restore).not.toHaveBeenCalled();
    expect(destroyedWindow.show).not.toHaveBeenCalled();
    expect(destroyedWindow.focus).not.toHaveBeenCalled();
    expect(mockAppFocus).not.toHaveBeenCalled();
  });
});

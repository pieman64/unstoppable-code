import { EventEmitter } from 'node:events';

class MockWebContents extends EventEmitter {
  readonly session = { setPermissionRequestHandler: jest.fn() };
  setWindowOpenHandler = jest.fn();
  reload = jest.fn();
  isDestroyed = (): boolean => false;
}

class MockBrowserWindow extends EventEmitter {
  static created: MockBrowserWindow[] = [];
  readonly webContents = new MockWebContents();
  visible = false;
  focused = false;
  destroyed = false;

  constructor() {
    super();
    MockBrowserWindow.created.push(this);
  }

  isDestroyed = (): boolean => this.destroyed;
  isMinimized = (): boolean => false;
  isVisible = (): boolean => this.visible;
  isFocused = (): boolean => this.focused;
  restore = (): void => undefined;
  show = (): void => {
    this.visible = true;
  };
  showInactive = (): void => {
    this.visible = true;
  };
  focus = (): void => {
    this.focused = true;
  };
  hide = (): void => {
    this.visible = false;
    this.focused = false;
  };
  destroy = (): void => {
    this.destroyed = true;
    this.emit('closed');
  };
  close = (): void => {
    const event = {
      defaultPrevented: false,
      preventDefault: (): void => {
        event.defaultPrevented = true;
      },
    };
    this.emit('close', event);
    if (!event.defaultPrevented) this.destroy();
  };
}

jest.mock('electron', () => ({
  BrowserWindow: MockBrowserWindow,
  dialog: { showOpenDialog: jest.fn() },
  shell: { openExternal: jest.fn() },
}));

jest.mock('../../lib/window-focus-recency', () => ({
  primaryWindowFocus: { track: jest.fn() },
}));

jest.mock('../../lib/web-contents-send', () => ({
  sendToWebContents: jest.fn(),
  sendWrappedToWebContents: jest.fn(),
}));

import { sendWrappedToWebContents } from '../../lib/web-contents-send';
import { RemoteMachineWindows } from '../client/remote-windows';
import type { AppAdvisorWindowStateParams } from '../remote-protocol';

const HOST = {
  deviceId: 'host-1',
  name: 'Desktop',
  platform: 'darwin' as const,
};

function createWindows(
  options: {
    quitting?: { value: boolean };
    showLocalWindow?: () => void;
  } = {},
): {
  windows: RemoteMachineWindows;
  states: AppAdvisorWindowStateParams[];
} {
  const states: AppAdvisorWindowStateParams[] = [];
  const windows = new RemoteMachineWindows({
    preloadPath: '/preload.js',
    title: (): string => 'Desktop',
    baseWindowOptions: (): Record<string, never> => ({}),
    loadRenderer: (): Promise<void> => Promise.resolve(),
    getMainWindow: (): null => null,
    isAllowedNavigation: (): boolean => false,
    onClosed: (): void => undefined,
    onAppAdvisorStateChanged: (_deviceId, state): void => {
      states.push(state);
    },
    isQuitting: (): boolean => options.quitting?.value === true,
    showLocalWindow: options.showLocalWindow ?? ((): void => undefined),
  });
  return { windows, states };
}

beforeEach(() => {
  MockBrowserWindow.created = [];
  jest.mocked(sendWrappedToWebContents).mockClear();
});

describe('RemoteMachineWindows App Advisor', () => {
  it('reports the window state again once its page reloads after a reconnect', async () => {
    const { windows, states } = createWindows();
    windows.open(HOST);
    await windows.appAdvisorWindow(HOST.deviceId, {
      action: 'open',
      focus: true,
    });
    windows.markAppAdvisorReady(HOST.deviceId);
    states.length = 0;

    // A reconnect reloads the page; the window itself stays showing.
    windows.reload(HOST.deviceId);
    MockBrowserWindow.created[1]?.webContents.emit('did-navigate');
    windows.markAppAdvisorReady(HOST.deviceId);
    expect(states).toEqual([{ open: true, focused: true }]);
  });

  it('keeps delivering pushes when only a frame inside the page loads', async () => {
    const { windows } = createWindows();
    windows.open(HOST);
    await windows.appAdvisorWindow(HOST.deviceId, { action: 'ensure' });
    windows.markAppAdvisorReady(HOST.deviceId);

    // A chat visualization iframe starts loading; the page stays mounted.
    MockBrowserWindow.created[1]?.webContents.emit('did-start-loading');
    windows.deliverPush(HOST.deviceId, 'channel', [1], 'app-advisor');
    expect(sendWrappedToWebContents).toHaveBeenCalledTimes(1);

    // A committed reload holds pushes until the new page is ready.
    MockBrowserWindow.created[1]?.webContents.emit('did-navigate');
    windows.deliverPush(HOST.deviceId, 'channel', [2], 'app-advisor');
    expect(sendWrappedToWebContents).toHaveBeenCalledTimes(1);
    windows.markAppAdvisorReady(HOST.deviceId);
    expect(sendWrappedToWebContents).toHaveBeenCalledTimes(2);
  });

  it('holds pushes until the page is ready, then delivers them', async () => {
    const { windows } = createWindows();
    windows.open(HOST);
    await windows.appAdvisorWindow(HOST.deviceId, { action: 'ensure' });
    windows.deliverPush(HOST.deviceId, 'channel', [1], 'app-advisor');
    expect(sendWrappedToWebContents).not.toHaveBeenCalled();
    windows.markAppAdvisorReady(HOST.deviceId);
    expect(sendWrappedToWebContents).toHaveBeenCalledTimes(1);
  });

  it('hides on close, but closes while the app is quitting', async () => {
    const quitting = { value: false };
    const { windows } = createWindows({ quitting });
    windows.open(HOST);
    await windows.appAdvisorWindow(HOST.deviceId, { action: 'open' });
    const advisor = MockBrowserWindow.created[1];
    if (!advisor) throw new Error('No App Advisor window.');

    advisor.close();
    expect(advisor.destroyed).toBe(false);
    expect(advisor.visible).toBe(false);

    quitting.value = true;
    advisor.close();
    expect(advisor.destroyed).toBe(true);
  });
});

describe('RemoteMachineWindows.appAdvisorWindow focus_main', () => {
  it('brings the window showing the other computer forward', async () => {
    const { windows } = createWindows();
    windows.open(HOST);
    const main = MockBrowserWindow.created[0];
    if (!main) throw new Error('No main window.');
    main.hide();
    await windows.appAdvisorWindow(HOST.deviceId, { action: 'focus_main' });
    expect(main.visible).toBe(true);
    expect(main.focused).toBe(true);
  });
});

describe('RemoteMachineWindows.focusLocal', () => {
  it('asks for the local window even when the main window was closed', () => {
    const showLocalWindow = jest.fn();

    createWindows({ showLocalWindow }).windows.focusLocal();

    expect(showLocalWindow).toHaveBeenCalledTimes(1);
  });
});

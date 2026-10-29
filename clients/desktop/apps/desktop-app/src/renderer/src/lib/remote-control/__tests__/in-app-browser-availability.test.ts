import type { RemoteControlContext } from '@canopy/desktop-shared/types';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import {
  isExternalBrowserOpenAvailable,
  isInAppBrowserAvailable,
} from '../in-app-browser-availability';

const REMOTE_CONTEXT: RemoteControlContext = {
  mode: 'remote',
  deviceId: 'device-b',
  name: 'Studio',
  platform: 'darwin',
};

function setContext(context: RemoteControlContext | null): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value:
      context === null
        ? { api: {} }
        : {
            api: {
              remoteControl: {
                getContext: (): RemoteControlContext => context,
              },
            },
          },
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('in-app browser availability', () => {
  it('is available where no remote-access bridge is installed', () => {
    setContext(null);
    expect(isInAppBrowserAvailable()).toBe(true);
    expect(isExternalBrowserOpenAvailable()).toBe(true);
  });

  it('is available in a window that shows this computer', () => {
    setContext({ mode: 'local' });
    expect(isInAppBrowserAvailable()).toBe(true);
    expect(isExternalBrowserOpenAvailable()).toBe(true);
  });

  it('follows the remote disposition of the browser channels in a window that shows another computer', () => {
    setContext(REMOTE_CONTEXT);
    expect(isInAppBrowserAvailable()).toBe(
      IPC_REMOTE_DISPOSITIONS.browserCreate === 'tunnel',
    );
    expect(isExternalBrowserOpenAvailable()).toBe(
      IPC_REMOTE_DISPOSITIONS.browserOpenExternal === 'tunnel',
    );
  });

  it('is unavailable remotely while the in-app browser channels are blocked', () => {
    setContext(REMOTE_CONTEXT);
    expect(IPC_REMOTE_DISPOSITIONS.browserCreate).toBe('blocked');
    expect(isInAppBrowserAvailable()).toBe(false);
    expect(isExternalBrowserOpenAvailable()).toBe(false);
  });
});

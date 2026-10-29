/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RemoteControlContext } from '@canopy/desktop-shared/types';
import {
  byTestId,
  createFakeRemoteControl,
  installRemoteControlApi,
  makeRemoteState,
  maybeByTestId,
  resetRemoteControlStore,
  seedRemoteControlStore,
} from '@/components/remote-access/__tests__/fakeRemoteControlApi';
import { MainWindowApp } from '../MainWindowApp';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// App holds its loading screen until preferences load, and in a window that
// shows another computer those load over the very connection that is down.
jest.mock('../App', () => ({
  __esModule: true,
  default: (): JSX.Element => <div data-testid="app-loading-screen" />,
}));
jest.mock('../components/DesktopResourceContextProvider', () => ({
  DesktopResourceContextProvider: ({
    children,
  }: {
    readonly children: JSX.Element;
  }): JSX.Element => children,
}));

const REMOTE_STUDIO: RemoteControlContext = {
  mode: 'remote',
  deviceId: 'dev-studio',
  name: 'Studio desktop',
  platform: 'linux',
};

describe('MainWindowApp', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    installRemoteControlApi(createFakeRemoteControl(REMOTE_STUDIO));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    installRemoteControlApi(null);
    resetRemoteControlStore();
  });

  it('shows an ended session while the app is still loading', () => {
    seedRemoteControlStore(
      makeRemoteState({
        hosts: [
          {
            deviceId: 'dev-studio',
            name: 'Studio desktop',
            platform: 'linux',
            pairedAt: '2026-10-01T00:00:00.000Z',
            online: true,
            connection: 'error',
            error: 'The other computer ended this session.',
            ended: true,
          },
        ],
      }),
      REMOTE_STUDIO,
    );
    act(() => {
      root.render(<MainWindowApp />);
    });
    expect(maybeByTestId('app-loading-screen')).not.toBeNull();
    expect(
      byTestId('remote-access-connection-notice').getAttribute('data-state'),
    ).toBe('ended');
    expect(
      maybeByTestId('remote-access-connection-notice-reconnect'),
    ).not.toBeNull();
  });
});

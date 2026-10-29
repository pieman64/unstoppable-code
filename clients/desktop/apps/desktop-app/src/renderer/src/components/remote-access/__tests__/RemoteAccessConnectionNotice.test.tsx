/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  RemoteControlContext,
  RemoteControlHost,
} from '@canopy/desktop-shared/types';
import { RemoteAccessConnectionNotice } from '../RemoteAccessConnectionNotice';
import {
  byTestId,
  createFakeRemoteControl,
  flushPromises,
  installRemoteControlApi,
  makeRemoteState,
  maybeByTestId,
  resetRemoteControlStore,
  seedRemoteControlStore,
  type FakeRemoteControl,
} from './fakeRemoteControlApi';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const STUDIO: RemoteControlHost = {
  deviceId: 'dev-studio',
  name: 'Studio desktop',
  platform: 'linux',
  pairedAt: '2026-10-01T00:00:00.000Z',
  online: true,
  connection: 'connected',
  error: null,
  ended: false,
};
const REMOTE_STUDIO: RemoteControlContext = {
  mode: 'remote',
  deviceId: 'dev-studio',
  name: 'Studio desktop',
  platform: 'linux',
};
const NOTICE = 'remote-access-connection-notice';

describe('RemoteAccessConnectionNotice', () => {
  let container: HTMLElement;
  let root: Root;
  let fake: FakeRemoteControl;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fake = createFakeRemoteControl(REMOTE_STUDIO);
    installRemoteControlApi(fake);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    installRemoteControlApi(null);
    resetRemoteControlStore();
  });

  function render(): void {
    act(() => {
      root.render(<RemoteAccessConnectionNotice />);
    });
  }

  it('shows nothing while the other computer is connected', () => {
    seedRemoteControlStore(makeRemoteState({ hosts: [STUDIO] }), REMOTE_STUDIO);
    render();
    expect(maybeByTestId(NOTICE)).toBeNull();
  });

  it("shows nothing in this computer's own windows", () => {
    seedRemoteControlStore(
      makeRemoteState({ hosts: [{ ...STUDIO, connection: 'connecting' }] }),
    );
    render();
    expect(maybeByTestId(NOTICE)).toBeNull();
  });

  it('says it is connecting while the connection is down', () => {
    seedRemoteControlStore(
      makeRemoteState({ hosts: [{ ...STUDIO, connection: 'connecting' }] }),
      REMOTE_STUDIO,
    );
    render();
    const notice = byTestId(NOTICE);
    expect(notice.getAttribute('data-state')).toBe('reconnecting');
    expect(notice.textContent).toContain('Connecting to Studio desktop…');
    expect(maybeByTestId(`${NOTICE}-reconnect`)).toBeNull();
  });

  it('keeps retrying after a failed attempt and says why', () => {
    seedRemoteControlStore(
      makeRemoteState({
        hosts: [
          {
            ...STUDIO,
            online: false,
            connection: 'error',
            error: 'The other computer is offline.',
          },
        ],
      }),
      REMOTE_STUDIO,
    );
    render();
    const notice = byTestId(NOTICE);
    expect(notice.getAttribute('data-state')).toBe('reconnecting');
    expect(notice.textContent).toContain("Can't reach Studio desktop");
    expect(notice.textContent).toContain('The other computer is offline.');
    expect(maybeByTestId(`${NOTICE}-reconnect`)).toBeNull();
  });

  it('explains an ended session and reconnects on request', async () => {
    seedRemoteControlStore(
      makeRemoteState({
        hosts: [
          {
            ...STUDIO,
            connection: 'error',
            error: 'The other computer ended this session.',
            ended: true,
          },
        ],
      }),
      REMOTE_STUDIO,
    );
    render();
    const notice = byTestId(NOTICE);
    expect(notice.getAttribute('data-state')).toBe('ended');
    expect(notice.textContent).toContain('Disconnected from Studio desktop');
    expect(notice.textContent).toContain(
      'The other computer ended this session.',
    );

    await act(async () => {
      byTestId(`${NOTICE}-reconnect`).click();
      await flushPromises();
    });
    expect(fake.mocks.openMachine).toHaveBeenCalledWith('dev-studio');
  });

  it('shows why reconnecting failed', async () => {
    fake.mocks.openMachine.mockRejectedValueOnce(
      new Error('Remote access is off.'),
    );
    seedRemoteControlStore(
      makeRemoteState({
        hosts: [
          {
            ...STUDIO,
            connection: 'error',
            error: 'The other computer ended this session.',
            ended: true,
          },
        ],
      }),
      REMOTE_STUDIO,
    );
    render();
    await act(async () => {
      byTestId(`${NOTICE}-reconnect`).click();
      await flushPromises();
    });
    expect(byTestId(NOTICE).textContent).toContain('Remote access is off.');
  });
});

/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  RemoteControlController,
  RemoteControlHost,
  RemoteControlState,
} from '@canopy/desktop-shared/types';
import { useNavigationStore } from '@/stores/navigationStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { RemoteAccessTab } from '../RemoteAccessTab';
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
} from '@/components/remote-access/__tests__/fakeRemoteControlApi';

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
const LAPTOP: RemoteControlController = {
  deviceId: 'dev-laptop',
  name: 'Travel laptop',
  platform: 'darwin',
  pairedAt: '2026-10-01T00:00:00.000Z',
  online: true,
  connected: true,
};

describe('RemoteAccessTab', () => {
  let container: HTMLElement;
  let root: Root;
  let fake: FakeRemoteControl;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    installRemoteControlApi(null);
    resetRemoteControlStore();
    useNavigationStore.setState({
      settingsOpen: false,
      settingsInitialSection: undefined,
    });
  });

  async function render(state: RemoteControlState): Promise<void> {
    fake = createFakeRemoteControl({ mode: 'local' }, state);
    installRemoteControlApi(fake);
    seedRemoteControlStore(state);
    await act(async () => {
      root.render(<RemoteAccessTab />);
      await flushPromises();
    });
  }

  it('explains the risk next to the toggle and saves it', async () => {
    await render(makeRemoteState({ allowIncoming: false }));
    const row = byTestId('settings-remote-access-allow-row');
    expect(row.textContent).toContain(
      'Allow other computers to control this one',
    );
    expect(row.textContent).toContain(
      'can see and change everything on this computer, including running commands',
    );
    expect(row.textContent).toContain('needs your approval on this computer');

    const toggle = byTestId('settings-remote-access-allow-incoming');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      toggle.click();
      await flushPromises();
    });
    expect(fake.mocks.setAllowIncoming).toHaveBeenCalledWith(true);
    expect(
      byTestId('settings-remote-access-allow-incoming').getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
  });

  it('lists computers this one can control and opens one', async () => {
    await render(makeRemoteState({ hosts: [STUDIO] }));
    const row = byTestId('settings-remote-access-host-dev-studio');
    expect(row.textContent).toContain('Studio desktop');
    expect(row.textContent).toContain('Linux · Connected');
    await act(async () => {
      byTestId('settings-remote-access-host-open-dev-studio').click();
      await flushPromises();
    });
    expect(fake.mocks.openMachine).toHaveBeenCalledWith('dev-studio');
  });

  it('removes a computer only after confirmation', async () => {
    await render(makeRemoteState({ hosts: [STUDIO] }));
    act(() => {
      byTestId('settings-remote-access-host-remove-dev-studio').click();
    });
    const dialog = byTestId('settings-remote-access-remove-dialog');
    expect(dialog.textContent).toContain('Remove Studio desktop?');
    expect(fake.mocks.forgetDevice).not.toHaveBeenCalled();
    fake.current = makeRemoteState({ hosts: [] });
    await act(async () => {
      byTestId('settings-remote-access-remove-confirm').click();
      await flushPromises();
    });
    expect(fake.mocks.forgetDevice).toHaveBeenCalledWith({
      deviceId: 'dev-studio',
      role: 'host',
    });
    expect(maybeByTestId('settings-remote-access-remove-dialog')).toBeNull();
    expect(maybeByTestId('settings-remote-access-host-dev-studio')).toBeNull();
  });

  it('lists computers that can control this one, with disconnect and remove', async () => {
    await render(makeRemoteState({ controllers: [LAPTOP] }));
    const row = byTestId('settings-remote-access-controller-dev-laptop');
    expect(row.textContent).toContain('Travel laptop');
    expect(row.textContent).toContain('Controlling now');
    await act(async () => {
      byTestId(
        'settings-remote-access-controller-disconnect-dev-laptop',
      ).click();
      await flushPromises();
    });
    expect(fake.mocks.disconnectController).toHaveBeenCalledWith('dev-laptop');

    act(() => {
      byTestId('settings-remote-access-controller-remove-dev-laptop').click();
    });
    await act(async () => {
      byTestId('settings-remote-access-remove-confirm').click();
      await flushPromises();
    });
    expect(fake.mocks.forgetDevice).toHaveBeenCalledWith({
      deviceId: 'dev-laptop',
      role: 'controller',
    });
  });

  it('offers Disconnect only while the computer is connected', async () => {
    await render(
      makeRemoteState({ controllers: [{ ...LAPTOP, connected: false }] }),
    );
    expect(
      byTestId('settings-remote-access-controller-dev-laptop').textContent,
    ).toContain('Online');
    expect(
      maybeByTestId('settings-remote-access-controller-disconnect-dev-laptop'),
    ).toBeNull();
  });

  it('hides the controllers section when nothing is paired', async () => {
    await render(makeRemoteState());
    expect(maybeByTestId('settings-remote-access-controllers')).toBeNull();
  });

  it('opens the pairing dialog from Add a computer', async () => {
    await render(makeRemoteState());
    expect(
      byTestId('settings-remote-access-add').classList.contains('rounded-full'),
    ).toBe(true);
    expect(
      byTestId('settings-remote-access-add').classList.contains('w-52'),
    ).toBe(false);
    act(() => {
      byTestId('settings-remote-access-add').click();
    });
    expect(useRemoteControlStore.getState().pairDialogOpen).toBe(true);
  });

  it('asks a signed-out user to sign in', async () => {
    await render(makeRemoteState({ signedIn: false }));
    const notice = byTestId('settings-remote-access-signed-out');
    expect(notice.textContent).toContain('Sign in to pair computers');
    expect(maybeByTestId('settings-remote-access-allow-incoming')).toBeNull();
    act(() => {
      const button = notice.querySelector('button');
      if (!button) throw new Error('missing button');
      button.click();
    });
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'account',
    );
  });

  it('leads with the state when the connection service is unreachable', async () => {
    await render(
      makeRemoteState({
        relayStatus: 'unavailable',
        relayDetail: 'getaddrinfo ENOTFOUND relay.example.com',
      }),
    );
    const notice = byTestId('settings-remote-access-unavailable');
    expect(notice.textContent).toContain("Can't reach the connection service");
    expect(notice.textContent).toContain('Retrying automatically');
    // Raw connection diagnostics are not user-facing copy.
    expect(notice.textContent).not.toContain('ENOTFOUND');
  });

  it('shows an inline error when an action fails', async () => {
    await render(makeRemoteState({ allowIncoming: false }));
    fake.mocks.setAllowIncoming.mockRejectedValueOnce(
      new Error('Sign in again to change this.'),
    );
    await act(async () => {
      byTestId('settings-remote-access-allow-incoming').click();
      await flushPromises();
    });
    expect(byTestId('settings-remote-access-error').textContent).toContain(
      'Sign in again to change this.',
    );
  });
});

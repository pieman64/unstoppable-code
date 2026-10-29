/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RemoteOutgoingPairing } from '@canopy/desktop-shared/types';
import { useNavigationStore } from '@/stores/navigationStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { PairComputerDialog } from '../PairComputerDialog';
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

const DESK = {
  deviceId: 'dev-desk',
  name: 'Desk PC',
  platform: 'win32' as const,
};

function outgoing(
  overrides: Partial<RemoteOutgoingPairing> = {},
): RemoteOutgoingPairing {
  return {
    ...DESK,
    status: 'awaiting-approval',
    code: '482913',
    error: null,
    ...overrides,
  };
}

describe('PairComputerDialog', () => {
  let container: HTMLElement;
  let root: Root;
  let fake: FakeRemoteControl;
  let onClose: jest.Mock<void, []>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = jest.fn<void, []>();
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

  async function render(
    initial = makeRemoteState({ discoverable: [DESK] }),
  ): Promise<void> {
    fake = createFakeRemoteControl({ mode: 'local' }, initial);
    installRemoteControlApi(fake);
    seedRemoteControlStore(initial);
    await act(async () => {
      root.render(<PairComputerDialog onClose={onClose} />);
      await flushPromises();
    });
  }

  /** Main moves the attempt along and pushes the snapshot. */
  function push(pairing: RemoteOutgoingPairing | null): void {
    act(() => {
      useRemoteControlStore
        .getState()
        .setState(
          makeRemoteState({ discoverable: [DESK], outgoingPairing: pairing }),
        );
    });
  }

  it('asks main to discover computers and lists them', async () => {
    await render();
    expect(fake.mocks.getState).toHaveBeenCalledWith({ discover: true });
    const option = byTestId('remote-access-pair-option-dev-desk');
    expect(option.textContent).toContain('Desk PC');
    expect(option.textContent).toContain('Windows');
  });

  it('explains how to make a computer pairable when none are found', async () => {
    await render(makeRemoteState({ discoverable: [] }));
    const empty = byTestId('remote-access-pair-empty');
    expect(empty.textContent).toContain('No computers ready to pair');
    expect(empty.textContent).toContain('Settings → Remote access');
    expect(empty.textContent).toContain('same account');
  });

  it('says the connection service is unreachable without raw diagnostics', async () => {
    await render(
      makeRemoteState({
        relayStatus: 'unavailable',
        relayDetail: 'relay handshake failed: ECONNREFUSED',
      }),
    );
    // The dialog renders in a portal on the body.
    const text = document.body.textContent ?? '';
    expect(text).toContain("Can't reach the connection service");
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('handshake');
  });

  it('points a signed-out user at account settings', async () => {
    await render(makeRemoteState({ signedIn: false }));
    const notice = byTestId('remote-access-pair-signed-out');
    expect(notice.textContent).toContain('Sign in to pair computers');
    act(() => {
      const button = notice.querySelector('button');
      if (!button) throw new Error('missing button');
      button.click();
    });
    expect(onClose).toHaveBeenCalled();
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'account',
    );
  });

  it('starts pairing and shows the code grouped for comparison', async () => {
    await render();
    fake.current = makeRemoteState({
      discoverable: [DESK],
      outgoingPairing: outgoing({ status: 'connecting', code: null }),
    });
    await act(async () => {
      byTestId('remote-access-pair-option-dev-desk').click();
      await flushPromises();
    });
    expect(fake.mocks.startPairing).toHaveBeenCalledWith('dev-desk');
    expect(byTestId('remote-access-pair-status').textContent).toContain(
      'Connecting to Desk PC',
    );

    push(outgoing());
    expect(byTestId('remote-access-pair-code').textContent).toBe('482 913');
    expect(byTestId('remote-access-pair-dialog').textContent).toContain(
      'select Allow on that computer',
    );
  });

  it('cancels a pairing in progress when the user leaves', async () => {
    await render(
      makeRemoteState({ discoverable: [DESK], outgoingPairing: outgoing() }),
    );
    await act(async () => {
      byTestId('remote-access-pair-cancel').click();
      await flushPromises();
    });
    expect(fake.mocks.cancelPairing).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('cancels an attempt that was still starting when the user left', async () => {
    await render();
    let finishStart = (): void => undefined;
    fake.mocks.startPairing.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = (): void => resolve(fake.current);
        }),
    );
    await act(async () => {
      byTestId(`remote-access-pair-option-${DESK.deviceId}`).click();
      await flushPromises();
    });
    await act(async () => {
      byTestId('remote-access-pair-cancel').click();
      await flushPromises();
    });
    expect(onClose).toHaveBeenCalled();
    expect(fake.mocks.cancelPairing).not.toHaveBeenCalled();
    await act(async () => {
      finishStart();
      await flushPromises();
    });
    expect(fake.mocks.cancelPairing).toHaveBeenCalledTimes(1);
  });

  it('offers to open the computer once it is paired', async () => {
    await render(
      makeRemoteState({
        discoverable: [],
        outgoingPairing: outgoing({ status: 'approved' }),
      }),
    );
    expect(byTestId('remote-access-pair-approved').textContent).toContain(
      'Desk PC is paired',
    );
    await act(async () => {
      byTestId('remote-access-pair-open').click();
      await flushPromises();
    });
    expect(fake.mocks.openMachine).toHaveBeenCalledWith('dev-desk');
    expect(fake.mocks.cancelPairing).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open and explains when the paired computer cannot open', async () => {
    await render(
      makeRemoteState({
        discoverable: [],
        outgoingPairing: outgoing({ status: 'approved' }),
      }),
    );
    fake.mocks.openMachine.mockRejectedValueOnce(new Error('Not online.'));
    await act(async () => {
      byTestId('remote-access-pair-open').click();
      await flushPromises();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(fake.mocks.cancelPairing).not.toHaveBeenCalled();
    expect(byTestId('remote-access-pair-error').textContent).toContain(
      'Not online.',
    );
  });

  it('reports a declined request and returns to the list', async () => {
    await render(
      makeRemoteState({
        discoverable: [DESK],
        outgoingPairing: outgoing({ status: 'rejected' }),
      }),
    );
    expect(byTestId('remote-access-pair-rejected').textContent).toContain(
      'Desk PC declined the request',
    );
    await act(async () => {
      byTestId('remote-access-pair-back').click();
      await flushPromises();
    });
    expect(fake.mocks.cancelPairing).toHaveBeenCalled();
    expect(maybeByTestId('remote-access-pair-option-dev-desk')).not.toBeNull();
  });

  it('shows why pairing failed and retries the same computer', async () => {
    await render(
      makeRemoteState({
        discoverable: [DESK],
        outgoingPairing: outgoing({
          status: 'failed',
          code: null,
          error: 'The other computer stopped responding.',
        }),
      }),
    );
    const failed = byTestId('remote-access-pair-failed');
    expect(failed.textContent).toContain("Couldn't pair with Desk PC.");
    expect(failed.textContent).toContain('stopped responding');
    await act(async () => {
      byTestId('remote-access-pair-retry').click();
      await flushPromises();
    });
    expect(fake.mocks.startPairing).toHaveBeenCalledWith('dev-desk');
  });

  it('keeps the list and shows the error when pairing cannot start', async () => {
    await render();
    fake.mocks.startPairing.mockRejectedValueOnce(
      new Error('That computer is not online.'),
    );
    await act(async () => {
      byTestId('remote-access-pair-option-dev-desk').click();
      await flushPromises();
    });
    expect(byTestId('remote-access-pair-error').textContent).toBe(
      'That computer is not online.',
    );
    expect(maybeByTestId('remote-access-pair-option-dev-desk')).not.toBeNull();
  });
});

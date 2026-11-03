/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  RemoteControlContext,
  RemoteControlHost,
} from '@canopy/desktop-shared/types';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import {
  AccountMenuComputersSection,
  SidebarMachinePicker,
} from '../SidebarMachinePicker';
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
  connection: 'idle',
  error: null,
  ended: false,
};
const STUDIO_WINDOW: RemoteControlContext = {
  mode: 'remote',
  deviceId: 'dev-studio',
  name: 'Studio desktop',
  platform: 'linux',
};
const OLD_MAC: RemoteControlHost = {
  deviceId: 'dev-old',
  name: 'Old Mac',
  platform: 'darwin',
  pairedAt: '2026-09-01T00:00:00.000Z',
  online: false,
  connection: 'idle',
  error: null,
  ended: false,
};

describe('SidebarMachinePicker', () => {
  let container: HTMLElement;
  let root: Root;
  let fake: FakeRemoteControl;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fake = createFakeRemoteControl();
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
      root.render(<SidebarMachinePicker />);
    });
  }

  function openMenu(): void {
    act(() => {
      byTestId('sidebar-machine-picker').click();
    });
  }

  it('renders nothing while remote access is off or signed out', () => {
    seedRemoteControlStore(
      makeRemoteState({ available: false }),
      STUDIO_WINDOW,
    );
    render();
    expect(maybeByTestId('sidebar-machine-picker')).toBeNull();

    act(() => {
      seedRemoteControlStore(
        makeRemoteState({ signedIn: false }),
        STUDIO_WINDOW,
      );
    });
    expect(maybeByTestId('sidebar-machine-picker')).toBeNull();
  });

  it("renders nothing in this computer's own window", () => {
    seedRemoteControlStore(makeRemoteState({ hosts: [STUDIO, OLD_MAC] }));
    render();
    expect(maybeByTestId('sidebar-machine-picker')).toBeNull();
  });

  it('opens another paired computer from a remote window', async () => {
    seedRemoteControlStore(
      makeRemoteState({
        hosts: [{ ...STUDIO, connection: 'connected' }, OLD_MAC],
      }),
      STUDIO_WINDOW,
    );
    render();
    openMenu();
    await act(async () => {
      byTestId('sidebar-machine-option-dev-old').click();
      await flushPromises();
    });
    expect(fake.mocks.openMachine).toHaveBeenCalledWith('dev-old');
    expect(maybeByTestId('sidebar-machine-picker-menu')).toBeNull();
  });

  it('does not reopen the computer the window already shows', async () => {
    seedRemoteControlStore(
      makeRemoteState({ hosts: [{ ...STUDIO, connection: 'connected' }] }),
      STUDIO_WINDOW,
    );
    render();
    expect(
      maybeByTestId('sidebar-machine-picker-status')?.getAttribute(
        'data-dot-tone',
      ),
    ).toBe('success');
    openMenu();
    await act(async () => {
      byTestId('sidebar-machine-option-dev-studio').click();
      await flushPromises();
    });
    expect(fake.mocks.openMachine).not.toHaveBeenCalled();
  });

  it('reconnects the computer the window shows when it is not connected', async () => {
    seedRemoteControlStore(
      makeRemoteState({ hosts: [{ ...STUDIO, connection: 'error' }] }),
      {
        mode: 'remote',
        deviceId: 'dev-studio',
        name: 'Studio desktop',
        platform: 'linux',
      },
    );
    render();
    openMenu();
    await act(async () => {
      byTestId('sidebar-machine-option-dev-studio').click();
      await flushPromises();
    });
    expect(fake.mocks.openMachine).toHaveBeenCalledWith('dev-studio');
  });

  it('shows the host with its connection status in a remote window', async () => {
    seedRemoteControlStore(
      makeRemoteState({ hosts: [{ ...STUDIO, connection: 'connecting' }] }),
      {
        mode: 'remote',
        deviceId: 'dev-studio',
        name: 'Studio desktop',
        platform: 'linux',
      },
    );
    render();
    const trigger = byTestId('sidebar-machine-picker');
    expect(trigger.textContent).toContain('Studio desktop');
    expect(trigger.getAttribute('data-machine-mode')).toBe('remote');
    expect(trigger.getAttribute('aria-label')).toBe(
      'Computer: Studio desktop, Connecting…',
    );
    // Connecting is named by the label; the connection Dot is only green
    // (connected) or red (can't connect).
    expect(maybeByTestId('sidebar-machine-picker-status')).toBeNull();

    openMenu();
    expect(
      byTestId('sidebar-machine-option-dev-studio').getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    expect(
      byTestId('sidebar-machine-option-local').getAttribute('aria-checked'),
    ).toBe('false');
    // Settings in this window belong to the other computer.
    expect(maybeByTestId('sidebar-machine-settings')).toBeNull();

    await act(async () => {
      byTestId('sidebar-machine-option-local').click();
      await flushPromises();
    });
    expect(fake.mocks.openMachine).toHaveBeenCalledWith(null);
  });

  it('lists every computer and opens the pairing dialog from a remote window', () => {
    seedRemoteControlStore(makeRemoteState({ hosts: [STUDIO, OLD_MAC] }), {
      mode: 'remote',
      deviceId: 'dev-studio',
      name: 'Studio desktop',
      platform: 'linux',
    });
    render();
    openMenu();
    const local = byTestId('sidebar-machine-option-local');
    expect(local.textContent).toContain('Work laptop');
    expect(local.textContent).toContain('This computer');
    expect(byTestId('sidebar-machine-option-dev-old').textContent).toContain(
      'Offline',
    );
    act(() => {
      byTestId('sidebar-machine-add').click();
    });
    expect(useRemoteControlStore.getState().pairDialogOpen).toBe(true);
  });

  describe('account menu computers section', () => {
    function renderSection(onClose: () => void = () => undefined): void {
      act(() => {
        root.render(<AccountMenuComputersSection onClose={onClose} />);
      });
    }

    it("lists this computer and paired computers in this computer's window", () => {
      seedRemoteControlStore(makeRemoteState({ hosts: [STUDIO, OLD_MAC] }));
      renderSection();
      expect(byTestId('sidebar-account-menu-computers-label').textContent).toBe(
        'Computers',
      );
      const local = byTestId('sidebar-account-menu-computer-option-local');
      expect(local.getAttribute('aria-checked')).toBe('true');
      expect(local.textContent).toContain('Work laptop');
      expect(local.textContent).toContain('This computer');
      expect(
        byTestId('sidebar-account-menu-computer-option-dev-studio').textContent,
      ).toContain('Online');
      expect(
        byTestId('sidebar-account-menu-computer-option-dev-old').textContent,
      ).toContain('Offline');
      expect(maybeByTestId('sidebar-account-menu-computer-add')).not.toBeNull();
    });

    it('opens a paired computer and closes the menu', async () => {
      seedRemoteControlStore(makeRemoteState({ hosts: [STUDIO] }));
      const onClose = jest.fn();
      renderSection(onClose);
      await act(async () => {
        byTestId('sidebar-account-menu-computer-option-dev-studio').click();
        await flushPromises();
      });
      expect(onClose).toHaveBeenCalled();
      expect(fake.mocks.openMachine).toHaveBeenCalledWith('dev-studio');
    });

    it('does nothing for this computer and opens pairing from Add a computer', async () => {
      seedRemoteControlStore(makeRemoteState({ hosts: [STUDIO] }));
      renderSection();
      await act(async () => {
        byTestId('sidebar-account-menu-computer-option-local').click();
        await flushPromises();
      });
      expect(fake.mocks.openMachine).not.toHaveBeenCalled();
      act(() => {
        byTestId('sidebar-account-menu-computer-add').click();
      });
      expect(useRemoteControlStore.getState().pairDialogOpen).toBe(true);
    });

    it('renders nothing in a remote window or while remote access is off', () => {
      seedRemoteControlStore(
        makeRemoteState({ hosts: [STUDIO] }),
        STUDIO_WINDOW,
      );
      renderSection();
      expect(maybeByTestId('sidebar-account-menu-computers')).toBeNull();

      act(() => {
        seedRemoteControlStore(makeRemoteState({ available: false }));
      });
      expect(maybeByTestId('sidebar-account-menu-computers')).toBeNull();
    });
  });
});

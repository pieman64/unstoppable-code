/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  RemoteControlContext,
  RemoteControlController,
  RemoteControlState,
  RemoteDirectoryListing,
} from '@canopy/desktop-shared/types';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { RemoteAccessHost } from '../RemoteAccessHost';
import { RemoteAccessControlledNotice } from '../RemoteAccessControlledNotice';
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

const REMOTE: RemoteControlContext = {
  mode: 'remote',
  deviceId: 'dev-studio',
  name: 'Studio desktop',
  platform: 'linux',
};

const INCOMING = {
  pairingId: 'pair-1',
  deviceId: 'dev-laptop',
  name: 'Travel laptop',
  platform: 'darwin' as const,
  code: '105733',
};

const CONTROLLER: RemoteControlController = {
  deviceId: 'dev-laptop',
  name: 'Travel laptop',
  platform: 'darwin',
  pairedAt: '2026-10-01T00:00:00.000Z',
  online: true,
  connected: true,
};

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
});

async function mount(
  state: RemoteControlState,
  context: RemoteControlContext = { mode: 'local' },
): Promise<void> {
  fake = createFakeRemoteControl(context, state);
  installRemoteControlApi(fake);
  seedRemoteControlStore(state, context);
  await act(async () => {
    root.render(
      <>
        <RemoteAccessHost />
        <RemoteAccessControlledNotice />
      </>,
    );
    await flushPromises();
  });
}

describe('incoming pairing prompt', () => {
  it('asks to allow the computer, states the consequence and shows the code', async () => {
    await mount(makeRemoteState({ incomingPairings: [INCOMING] }));
    const prompt = byTestId('remote-access-incoming-pairing');
    expect(prompt.textContent).toContain(
      'Allow Travel laptop to control this computer?',
    );
    expect(prompt.textContent).toContain(
      'can see and change everything on this computer, including running commands',
    );
    expect(byTestId('remote-access-incoming-pairing-code').textContent).toBe(
      '105 733',
    );
  });

  it('sends Allow', async () => {
    await mount(makeRemoteState({ incomingPairings: [INCOMING] }));
    await act(async () => {
      byTestId('remote-access-incoming-pairing-allow').click();
      await flushPromises();
    });
    expect(fake.mocks.respondToPairing).toHaveBeenCalledWith({
      pairingId: 'pair-1',
      approve: true,
    });
  });

  it('sends Decline', async () => {
    await mount(makeRemoteState({ incomingPairings: [INCOMING] }));
    await act(async () => {
      byTestId('remote-access-incoming-pairing-decline').click();
      await flushPromises();
    });
    expect(fake.mocks.respondToPairing).toHaveBeenCalledWith({
      pairingId: 'pair-1',
      approve: false,
    });
  });

  it('closes once main drops the request', async () => {
    await mount(makeRemoteState({ incomingPairings: [INCOMING] }));
    act(() => {
      useRemoteControlStore.getState().setState(makeRemoteState());
    });
    expect(maybeByTestId('remote-access-incoming-pairing')).toBeNull();
  });

  it('never prompts in a window that shows another computer', async () => {
    await mount(makeRemoteState({ incomingPairings: [INCOMING] }), REMOTE);
    expect(maybeByTestId('remote-access-incoming-pairing')).toBeNull();
  });
});

describe('being-controlled notice', () => {
  it('names the controlling computer and disconnects it', async () => {
    await mount(makeRemoteState({ controllers: [CONTROLLER] }));
    const notice = byTestId('remote-access-controlled-notice');
    expect(notice.textContent).toContain(
      'Travel laptop is controlling this computer',
    );
    await act(async () => {
      byTestId('remote-access-controlled-notice-disconnect').click();
      await flushPromises();
    });
    expect(fake.mocks.disconnectController).toHaveBeenCalledWith('dev-laptop');
  });

  it('stays hidden while no session is open', async () => {
    await mount(
      makeRemoteState({ controllers: [{ ...CONTROLLER, connected: false }] }),
    );
    expect(maybeByTestId('remote-access-controlled-notice')).toBeNull();
  });

  it('stays hidden in a window that shows another computer', async () => {
    await mount(makeRemoteState({ controllers: [CONTROLLER] }), REMOTE);
    expect(maybeByTestId('remote-access-controlled-notice')).toBeNull();
  });
});

describe('remote path picker', () => {
  const HOME: RemoteDirectoryListing = {
    path: '/home/ada',
    parent: '/home',
    entries: [
      { name: 'notes.md', path: '/home/ada/notes.md', kind: 'file' },
      { name: 'src', path: '/home/ada/src', kind: 'directory' },
      { name: 'Apps', path: '/home/ada/Apps', kind: 'directory' },
    ],
  };
  const SRC: RemoteDirectoryListing = {
    path: '/home/ada/src',
    parent: '/home/ada',
    entries: [{ name: 'main.ts', path: '/home/ada/src/main.ts', kind: 'file' }],
  };

  async function openPicker(mode: 'directory' | 'file'): Promise<void> {
    await mount(makeRemoteState(), REMOTE);
    fake.mocks.listDirectory.mockImplementation(({ path }) =>
      Promise.resolve(path === '/home/ada/src' ? SRC : HOME),
    );
    await act(async () => {
      fake.emitPathPicker({
        requestId: 'req-1',
        mode,
        title:
          mode === 'directory' ? 'Choose a project folder' : 'Choose a file',
      });
      await flushPromises();
    });
  }

  function entryNames(): string[] {
    return Array.from(
      byTestId('remote-path-picker-entries').querySelectorAll<HTMLElement>(
        '[data-entry-kind]',
      ),
    ).map((entry) => entry.textContent ?? '');
  }

  function pathField(): HTMLInputElement {
    const field = byTestId('remote-path-picker-path');
    if (!(field instanceof HTMLInputElement)) {
      throw new Error('The path is not an input.');
    }
    return field;
  }

  it('goes to a typed path, such as another drive', async () => {
    await openPicker('directory');
    const field = pathField();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(field, 'D:\\');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await flushPromises();
    });
    expect(fake.mocks.listDirectory).toHaveBeenLastCalledWith({
      path: 'D:\\',
    });
  });

  it('shows the folder it is in again when a typed path fails', async () => {
    await openPicker('directory');
    fake.mocks.listDirectory.mockRejectedValueOnce(
      new Error('No such folder.'),
    );
    const field = pathField();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(field, '/missing');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await flushPromises();
    });
    expect(byTestId('remote-path-picker-error').textContent).toContain(
      'No such folder.',
    );
    // What the field shows is what Choose returns.
    expect(pathField().value).toBe('/home/ada');
  });

  it('only listens for picker requests in a window for another computer', async () => {
    await mount(makeRemoteState());
    act(() => {
      fake.emitPathPicker({
        requestId: 'req-0',
        mode: 'directory',
        title: 'x',
      });
    });
    expect(maybeByTestId('remote-path-picker')).toBeNull();
  });

  it('opens at home with folders only and resolves the chosen folder', async () => {
    await openPicker('directory');
    const picker = byTestId('remote-path-picker');
    expect(picker.textContent).toContain('Choose a project folder');
    expect(fake.mocks.listDirectory).toHaveBeenCalledWith({ path: null });
    expect(pathField().value).toBe('/home/ada');
    expect(entryNames()).toEqual(['Apps', 'src']);

    await act(async () => {
      byTestId('remote-path-picker-entry-src').click();
      await flushPromises();
    });
    expect(fake.mocks.listDirectory).toHaveBeenLastCalledWith({
      path: '/home/ada/src',
    });
    expect(pathField().value).toBe('/home/ada/src');

    await act(async () => {
      byTestId('remote-path-picker-up').click();
      await flushPromises();
    });
    expect(fake.mocks.listDirectory).toHaveBeenLastCalledWith({
      path: '/home/ada',
    });

    await act(async () => {
      byTestId('remote-path-picker-confirm').click();
      await flushPromises();
    });
    expect(fake.mocks.resolvePathPicker).toHaveBeenCalledWith({
      requestId: 'req-1',
      path: '/home/ada',
    });
    expect(maybeByTestId('remote-path-picker')).toBeNull();
  });

  it('lists folders before files and needs a file selected in file mode', async () => {
    await openPicker('file');
    expect(entryNames()).toEqual(['Apps', 'src', 'notes.md']);
    const confirm = byTestId<HTMLButtonElement>('remote-path-picker-confirm');
    expect(confirm.disabled).toBe(true);
    act(() => {
      byTestId('remote-path-picker-entry-notes.md').click();
    });
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      confirm.click();
      await flushPromises();
    });
    expect(fake.mocks.resolvePathPicker).toHaveBeenCalledWith({
      requestId: 'req-1',
      path: '/home/ada/notes.md',
    });
  });

  it('resolves null on Cancel', async () => {
    await openPicker('directory');
    await act(async () => {
      byTestId('remote-path-picker-cancel').click();
      await flushPromises();
    });
    expect(fake.mocks.resolvePathPicker).toHaveBeenCalledWith({
      requestId: 'req-1',
      path: null,
    });
  });

  it('shows a listing error inline and keeps the current folder', async () => {
    await openPicker('directory');
    fake.mocks.listDirectory.mockRejectedValueOnce(
      new Error('Permission denied: /home/ada/src'),
    );
    await act(async () => {
      byTestId('remote-path-picker-entry-src').click();
      await flushPromises();
    });
    expect(byTestId('remote-path-picker-error').textContent).toContain(
      'Permission denied',
    );
    expect(pathField().value).toBe('/home/ada');
  });
});

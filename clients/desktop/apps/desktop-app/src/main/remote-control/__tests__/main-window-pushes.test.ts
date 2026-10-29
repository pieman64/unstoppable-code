import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  sendToWebContents,
  setRendererDeliveryFilter,
  setRendererMessageEncoder,
} from '../../lib/web-contents-send';
import { sendToWindow } from '../../lib/window-send';
import { createMainWindowPushSource } from '../host/main-window-pushes';

function fakeContents(): { send: jest.Mock } {
  return { send: jest.fn() };
}

describe('main window push source', () => {
  it('mirrors a locally filtered off-screen update to a remote subscriber', () => {
    const main = fakeContents();
    const source = createMainWindowPushSource(() => main);
    const seen: unknown[] = [];
    const unsubscribe = source.subscribe((_channel, args) =>
      seen.push(args[0]),
    );
    const removeFilter = setRendererDeliveryFilter(
      IPC_CHANNELS.chatEvent,
      () => true,
    );
    const update = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'background',
      data: { type: 'codex', event: { type: 'item.updated' } },
    };
    try {
      sendToWebContents(main, IPC_CHANNELS.chatEvent, update);
      expect(main.send).not.toHaveBeenCalled();
      expect(seen).toEqual([update]);
    } finally {
      removeFilter();
      unsubscribe();
    }
  });
  it('mirrors what main sends the app window, as published', () => {
    const main = fakeContents();
    const other = fakeContents();
    const source = createMainWindowPushSource(() => main);
    const seen: Array<[string, ReadonlyArray<unknown>]> = [];
    const removeEncoder = setRendererMessageEncoder(IPC_CHANNELS.chatEvent, {
      encode: (_target, message) => ({ appended: message }),
      discard: () => undefined,
    });
    const unsubscribe = source.subscribe((channel, args) => {
      seen.push([channel, args]);
    });
    try {
      sendToWebContents(main, IPC_CHANNELS.chatEvent, { chatId: 'c1' });
      sendToWebContents(other, IPC_CHANNELS.chatEvent, { chatId: 'c2' });
      // Coalesced per subscribing page: the bridge receives its own copy.
      sendToWebContents(main, IPC_CHANNELS.chatStateChanged, { chatId: 'c1' });
    } finally {
      unsubscribe();
      removeEncoder();
    }
    sendToWebContents(main, IPC_CHANNELS.chatEvent, { chatId: 'c3' });
    expect(seen).toEqual([[IPC_CHANNELS.chatEvent, [{ chatId: 'c1' }]]]);
    expect(main.send).toHaveBeenCalledWith(IPC_CHANNELS.chatEvent, {
      appended: { chatId: 'c1' },
    });
  });

  it('follows the app window when it is recreated', () => {
    let main = fakeContents();
    const source = createMainWindowPushSource(() => main);
    const channels: string[] = [];
    const unsubscribe = source.subscribe((channel) => {
      channels.push(channel);
    });
    const previous = main;
    main = fakeContents();
    sendToWebContents(previous, 'old:window');
    sendToWebContents(main, 'new:window');
    unsubscribe();
    expect(channels).toEqual(['new:window']);
  });

  it('still mirrors main-window events while the app window is closed', () => {
    let main: { send: jest.Mock } | null = fakeContents();
    const source = createMainWindowPushSource(() => main);
    const seen: string[] = [];
    const unsubscribe = source.subscribe((channel) => {
      seen.push(channel);
    });
    try {
      // A send to a window that is not there, while the app window is open,
      // was meant for some other window: not mirrored.
      sendToWindow(null, 'other:window', 1);
      // The app window closed (macOS keeps the app running): main's sends
      // to it now go nowhere, but the controller still needs them.
      main = null;
      sendToWindow(null, IPC_CHANNELS.terminalOutput, { seq: 1 });
    } finally {
      unsubscribe();
    }
    expect(seen).toEqual([IPC_CHANNELS.terminalOutput]);
  });

  it('never mirrors requests main addresses to one App Advisor window', () => {
    const main = fakeContents();
    const source = createMainWindowPushSource(() => main);
    const seen: string[] = [];
    const unsubscribe = source.subscribe((channel) => {
      seen.push(channel);
    });
    try {
      for (const channel of [
        IPC_CHANNELS.appAdvisorToolRequest,
        IPC_CHANNELS.appAdvisorToolRequestCancelled,
        IPC_CHANNELS.appAdvisorWindowCommand,
        IPC_CHANNELS.appAdvisorWindowStateChanged,
        IPC_CHANNELS.appAdvisorWindowUiStateChanged,
        IPC_CHANNELS.chatEvent,
      ]) {
        sendToWebContents(main, channel, { id: 1 });
      }
    } finally {
      unsubscribe();
    }
    expect(seen).toEqual([IPC_CHANNELS.chatEvent]);
  });
});

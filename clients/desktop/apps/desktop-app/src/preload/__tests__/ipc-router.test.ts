import { EventEmitter } from 'node:events';

jest.mock('electron', () => ({ ipcRenderer: {} }));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  createRemoteIpcRenderer,
  type IpcRendererTransport,
} from '../ipc-router';

class FakeIpcRenderer extends EventEmitter {
  readonly invocations: Array<[string, unknown[]]> = [];
  readonly sends: Array<[string, unknown[]]> = [];

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invocations.push([channel, args]);
    return Promise.resolve('ok');
  }

  send(channel: string, ...args: unknown[]): void {
    this.sends.push([channel, args]);
  }

  sendSync(): unknown {
    return null;
  }
}

function fakeEvent(): object {
  return {};
}

function createRouter(create = createRemoteIpcRenderer): {
  fake: FakeIpcRenderer;
  router: ReturnType<typeof createRemoteIpcRenderer>;
} {
  const fake = new FakeIpcRenderer();
  const ipc: IpcRendererTransport = {
    invoke: fake.invoke.bind(fake),
    send: fake.send.bind(fake),
    sendSync: fake.sendSync.bind(fake),
    on: (channel, listener) => fake.on(channel, listener),
    once: (channel, listener) => fake.once(channel, listener),
    removeListener: (channel, listener) =>
      fake.removeListener(channel, listener),
    removeAllListeners: (channel) => fake.removeAllListeners(channel),
  };
  return { fake, router: create(ipc) };
}

describe('remote IPC router', () => {
  it.each([false, true])(
    'keeps preload harness hooks local only with the E2E build gate (%s)',
    (e2e) => {
      const originalE2e = __CANOPY_E2E__;
      Object.assign(globalThis, { __CANOPY_E2E__: e2e });
      try {
        jest.isolateModules(() => {
          const { createRemoteIpcRenderer: create } = jest.requireActual<{
            createRemoteIpcRenderer: typeof createRemoteIpcRenderer;
          }>('../ipc-router');
          const { fake, router } = createRouter(create);
          const channel = 'canopy:e2e:first-projects-load';
          const stopChannel = 'canopy:e2e:first-projects-load-stop';
          const stopped = jest.fn();
          router.send(channel, 'preload-ready');
          router.once(stopChannel, stopped);
          fake.emit(stopChannel, fakeEvent());
          expect(fake.sends).toEqual(
            e2e
              ? [[channel, ['preload-ready']]]
              : [
                  [
                    IPC_CHANNELS.remoteControlSend,
                    [channel, ['preload-ready']],
                  ],
                ],
          );
          expect(stopped).toHaveBeenCalledTimes(e2e ? 1 : 0);
        });
      } finally {
        Object.assign(globalThis, { __CANOPY_E2E__: originalE2e });
      }
    },
  );

  it('tunnels data channels and keeps local channels local', async () => {
    const { fake, router } = createRouter();
    await router.invoke(IPC_CHANNELS.chatSendMessage, { text: 'hi' });
    await router.invoke(IPC_CHANNELS.updateCheck);
    router.send(IPC_CHANNELS.telemetrySyncRecordActivity, 'p', 'w');
    expect(fake.invocations).toEqual([
      [
        IPC_CHANNELS.remoteControlInvoke,
        [IPC_CHANNELS.chatSendMessage, [{ text: 'hi' }]],
      ],
      [IPC_CHANNELS.updateCheck, []],
    ]);
    expect(fake.sends).toEqual([
      [
        IPC_CHANNELS.remoteControlSend,
        [IPC_CHANNELS.telemetrySyncRecordActivity, ['p', 'w']],
      ],
    ]);
  });

  it('delivers remote pushes only to listeners of tunneled channels', () => {
    const { fake, router } = createRouter();
    const remote = jest.fn();
    const local = jest.fn();
    router.on(IPC_CHANNELS.chatEvent, remote);
    router.on(IPC_CHANNELS.updateEvent, local);
    // This computer's own broadcast on a tunneled channel is ignored.
    fake.emit(IPC_CHANNELS.chatEvent, fakeEvent(), { from: 'local' });
    expect(remote).not.toHaveBeenCalled();
    // The controlled computer's push arrives on the multiplexed channel.
    fake.emit(
      IPC_CHANNELS.remoteControlPush,
      fakeEvent(),
      IPC_CHANNELS.chatEvent,
      [{ from: 'remote' }],
    );
    expect(remote).toHaveBeenCalledWith(expect.anything(), { from: 'remote' });
    fake.emit(IPC_CHANNELS.updateEvent, fakeEvent(), { type: 'available' });
    expect(local).toHaveBeenCalledTimes(1);
  });

  it('removes remote listeners and honors once', () => {
    const { fake, router } = createRouter();
    const listener = jest.fn();
    const onceListener = jest.fn();
    router.on(IPC_CHANNELS.chatEvent, listener);
    router.once(IPC_CHANNELS.chatEvent, onceListener);
    const push = (): void => {
      fake.emit(
        IPC_CHANNELS.remoteControlPush,
        fakeEvent(),
        IPC_CHANNELS.chatEvent,
        [1],
      );
    };
    push();
    push();
    expect(onceListener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(2);
    router.removeListener(IPC_CHANNELS.chatEvent, listener);
    push();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

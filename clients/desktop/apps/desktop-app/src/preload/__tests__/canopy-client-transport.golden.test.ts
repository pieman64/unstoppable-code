/**
 * Golden: `window.canopyClientTransport`, the preload transport the desktop
 * CanopyClient runs over. It must reach exactly the portable adapter's
 * channels through the preload IPC router, never arbitrary IPC; strip the
 * Electron event from pushes; unsubscribe cleanly; and serve `chat:event`
 * from the page's one decoding listener so the output reset stays local.
 */
import { IPC_CHANNELS, type ChatEvent } from '@canopy/desktop-shared/types';
import {
  REMOTE_IPC_CHANNELS,
  deriveRemoteIpcChannels,
} from '@canopy/protocol/remote-control/channels';
import {
  createCanopyClientTransport,
  type CanopyClientTransportIpc,
} from '../api/canopy-client-transport-api';

type Listener = (event: unknown, ...payload: unknown[]) => void;

function fakeIpc(): {
  ipc: CanopyClientTransportIpc;
  invoked: { channel: string; args: unknown[] }[];
  listeners: Map<string, Set<Listener>>;
} {
  const invoked: { channel: string; args: unknown[] }[] = [];
  const listeners = new Map<string, Set<Listener>>();
  return {
    invoked,
    listeners,
    ipc: {
      invoke: (channel, ...args) => {
        invoked.push({ channel, args });
        return Promise.resolve({ channel });
      },
      on: (channel, listener) => {
        const set = listeners.get(channel) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(channel, set);
      },
      removeListener: (channel, listener) => {
        listeners.get(channel)?.delete(listener);
      },
    },
  };
}

function noChatEvents(): () => void {
  return (): void => undefined;
}

describe('preload canopyClientTransport (golden)', () => {
  test('invokes every adapter channel through the router and nothing else', async () => {
    const { ipc, invoked } = fakeIpc();
    const transport = createCanopyClientTransport(ipc, noChatEvents);
    await expect(
      transport.invoke(REMOTE_IPC_CHANNELS.projectsLoad, 'a', 1),
    ).resolves.toEqual({ channel: 'projects:load' });
    expect(invoked).toEqual([{ channel: 'projects:load', args: ['a', 1] }]);

    for (const channel of [
      IPC_CHANNELS.canopyCoreRelay,
      IPC_CHANNELS.chatEventOutputReset,
      IPC_CHANNELS.appWindowReload,
      'anything:else',
    ]) {
      await expect(transport.invoke(channel)).rejects.toThrow(
        'is not available to the CanopyClient',
      );
    }
    expect(invoked).toHaveLength(1);
    expect(() => transport.send(REMOTE_IPC_CHANNELS.projectsLoad)).toThrow(
      'is not available to the CanopyClient',
    );
  });

  test('allows exactly the channels the adapter manifest reaches', async () => {
    const { ipc, invoked } = fakeIpc();
    const transport = createCanopyClientTransport(ipc, noChatEvents);
    const reachable = deriveRemoteIpcChannels();
    expect([...reachable].sort()).toEqual(
      [...new Set<string>(Object.values(REMOTE_IPC_CHANNELS))].sort(),
    );
    let usable = 0;
    for (const channel of reachable) {
      const viaInvoke = await transport.invoke(channel).then(
        () => true,
        () => false,
      );
      let viaListen = false;
      try {
        transport.on(channel, () => undefined)();
        viaListen = true;
      } catch {
        viaListen = false;
      }
      expect({ channel, usable: viaInvoke || viaListen }).toEqual({
        channel,
        usable: true,
      });
      usable += 1;
    }
    expect(usable).toBe(reachable.length);
    expect(invoked.length).toBeGreaterThan(0);
  });

  test('pushes arrive without the Electron event and unsubscribe once', () => {
    const { ipc, listeners } = fakeIpc();
    const transport = createCanopyClientTransport(ipc, noChatEvents);
    const received: unknown[][] = [];
    const stop = transport.on(
      REMOTE_IPC_CHANNELS.terminalOutput,
      (...payload) => received.push(payload),
    );
    for (const listener of listeners.get('terminal:output') ?? []) {
      listener({ sender: 'electron-event' }, { terminalId: 't1' });
    }
    expect(received).toEqual([[{ terminalId: 't1' }]]);
    stop();
    stop();
    expect(listeners.get('terminal:output')?.size).toBe(0);
    expect(() =>
      transport.on(IPC_CHANNELS.appWindowReload, () => undefined),
    ).toThrow('is not available to the CanopyClient');
  });

  test('chat events come from the decoded page subscription, not raw IPC', () => {
    const { ipc, listeners } = fakeIpc();
    const subscribers = new Set<(event: ChatEvent) => void>();
    const transport = createCanopyClientTransport(
      ipc,
      (listener): (() => void) => {
        subscribers.add(listener);
        return (): void => {
          subscribers.delete(listener);
        };
      },
    );
    const received: unknown[] = [];
    const stop = transport.on(REMOTE_IPC_CHANNELS.chatEvent, (event) =>
      received.push(event),
    );
    expect(listeners.has('chat:event')).toBe(false);
    const event: ChatEvent = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      data: { type: 'assistant' },
    };
    for (const subscriber of subscribers) subscriber(event);
    expect(received).toEqual([event]);
    stop();
    expect(subscribers.size).toBe(0);
  });
});

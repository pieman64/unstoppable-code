import type { ChatEvent } from '@canopy/desktop-shared/types';
import type { RemoteIpcTransport } from '@canopy/protocol/remote-control';
import {
  REMOTE_COMMAND_CHANNELS,
  REMOTE_EVENT_CHANNELS,
  REMOTE_IPC_CHANNELS,
  REMOTE_MEMBER_CHANNELS,
  REMOTE_QUERY_CHANNELS,
  remoteOperationChannelUse,
  type RemoteOperationChannels,
} from '@canopy/protocol/remote-control/channels';

type TransportListener = (event: unknown, ...payload: unknown[]) => void;

/** The preload IPC router surface this transport forwards to. */
export interface CanopyClientTransportIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: TransportListener): void;
  removeListener(channel: string, listener: TransportListener): void;
}

interface AdapterChannels {
  readonly invoke: ReadonlySet<string>;
  readonly listen: ReadonlySet<string>;
}

/** Exactly the channels the portable adapter's operations can reach. */
function adapterChannels(): AdapterChannels {
  const invoke = new Set<string>();
  const listen = new Set<string>();
  const entries: RemoteOperationChannels[] = [
    ...Object.values(REMOTE_QUERY_CHANNELS),
    ...Object.values(REMOTE_COMMAND_CHANNELS),
    ...Object.values(REMOTE_EVENT_CHANNELS),
    ...Object.values(REMOTE_MEMBER_CHANNELS),
  ];
  for (const entry of entries) {
    const use = remoteOperationChannelUse(entry);
    use.invoke.forEach((channel) => invoke.add(channel));
    use.listen.forEach((channel) => listen.add(channel));
  }
  return { invoke, listen };
}

/**
 * `window.canopyClientTransport`: the `RemoteIpcTransport` the renderer's
 * portable CanopyClient (`@canopy/ipc-canopy-client`) runs over.
 *
 * It is not general IPC. Invokes and listeners are limited to the channels
 * the adapter's operations reach (the protocol manifest, a subset of the
 * channels this preload's `window.api` already exposes); anything else
 * rejects. Calls go through the preload IPC router, so remote-control windows
 * route by channel disposition and every invoke rejection is restored with
 * `restoreIpcAppError`, as for `window.api`. `chat:event` arrives already
 * decoded from the preload's one decoding listener, so the output reset stays
 * local to this page. The adapter sends nothing.
 */
export function createCanopyClientTransport(
  ipc: CanopyClientTransportIpc,
  subscribeToChatEvents: (listener: (event: ChatEvent) => void) => () => void,
): RemoteIpcTransport {
  const allowed = adapterChannels();
  return {
    invoke: (channel, ...args): Promise<unknown> => {
      if (!allowed.invoke.has(channel)) {
        return Promise.reject(
          new Error(`"${channel}" is not available to the CanopyClient.`),
        );
      }
      return ipc.invoke(channel, ...args);
    },
    send: (channel): void => {
      throw new Error(`"${channel}" is not available to the CanopyClient.`);
    },
    on: (channel, listener): (() => void) => {
      if (!allowed.listen.has(channel)) {
        throw new Error(`"${channel}" is not available to the CanopyClient.`);
      }
      if (channel === REMOTE_IPC_CHANNELS.chatEvent) {
        return subscribeToChatEvents((event) => listener(event));
      }
      const handler: TransportListener = (_event, ...payload) => {
        listener(...payload);
      };
      ipc.on(channel, handler);
      return (): void => {
        ipc.removeListener(channel, handler);
      };
    },
  };
}

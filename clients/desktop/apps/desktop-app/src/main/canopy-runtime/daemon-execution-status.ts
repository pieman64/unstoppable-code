import type { CanopyClientStreamHandle } from '@canopy/core-client';
import type {
  CoreExecutionStatus,
  CoreExecutionStatusEventsItem,
} from '@canopy/protocol/canopy-core';
import type { ElectronDaemonSession } from './electron-daemon-connection';
import type { ElectronDaemonClient } from './electron-daemon-host';

/*
 * The daemon's execution status for Electron main's resource monitor
 * (CAN-5690). It rides the daemon sessions Electron main's migrated
 * consumers already hold and never opens, leases or starts one, so it never
 * keeps a daemon alive. While a session is live it follows
 * `core.execution.status.events` on that connection. A daemon that does not
 * serve the stream (an older build, or one without terminal or graph hosts)
 * refuses it, and that connection is not asked again; neither is one whose
 * stream ended. With no stream the status is null and the monitor reports
 * Electron main's accounting alone. A dropped connection moves to another
 * observed session at once; the resource monitor asks again at each of its
 * samples, so a session whose lease reconnects is followed once it is live.
 */

/** The one stream the source opens, on a daemon session's connection. */
interface StatusClient {
  readonly signal: AbortSignal;
  openStream(
    name: 'core.execution.status.events',
    params: { cursor: null },
  ): Promise<CanopyClientStreamHandle<CoreExecutionStatusEventsItem, unknown>>;
}
export interface DaemonExecutionStatusSession {
  readonly client: StatusClient;
  readonly lease: Pick<
    ElectronDaemonSession<ElectronDaemonClient>['lease'],
    'state'
  >;
}

export type DaemonExecutionStatusListener = (
  status: CoreExecutionStatus | null,
) => void;

export interface DaemonExecutionStatusSource {
  /** Notes a live session; never opens one. */
  observe(session: DaemonExecutionStatusSession): void;
  /**
   * Follows an observed session again once it is live, such as after its
   * lease adopted a replacement connection. Reads only local state.
   */
  reattach(): void;
  /** The daemon's last status while its stream is open, otherwise null. */
  current(): CoreExecutionStatus | null;
  subscribe(listener: DaemonExecutionStatusListener): () => void;
  close(): void;
}

export function createDaemonExecutionStatusSource(): DaemonExecutionStatusSource {
  const sessions = new Set<DaemonExecutionStatusSession>();
  const listeners = new Set<DaemonExecutionStatusListener>();
  // Connections whose daemon refused or ended the stream.
  const settled = new WeakSet<StatusClient>();
  let attached: { client: StatusClient; close(): void } | null = null;
  let opening: StatusClient | null = null;
  let status: CoreExecutionStatus | null = null;
  let closed = false;

  const publish = (next: CoreExecutionStatus | null): void => {
    if (next === null && status === null) return;
    status = next;
    for (const listener of Array.from(listeners)) {
      try {
        listener(next);
      } catch {
        // A failing listener never stops delivery to the others.
      }
    }
  };

  /** The session's live connection, or null; forgets an ended session. */
  const liveClient = (
    session: DaemonExecutionStatusSession,
  ): StatusClient | null => {
    try {
      const { state } = session.lease;
      if (state === 'failed' || state === 'released') {
        sessions.delete(session);
        return null;
      }
      if (state !== 'active') return null;
      const { client } = session;
      return client.signal.aborted || settled.has(client) ? null : client;
    } catch {
      sessions.delete(session);
      return null;
    }
  };

  const detach = (client: StatusClient): void => {
    if (attached?.client !== client) return;
    const current = attached;
    attached = null;
    current.close();
    publish(null);
    ensure();
  };

  const open = (client: StatusClient): void => {
    opening = client;
    void client
      .openStream('core.execution.status.events', { cursor: null })
      .then(
        (handle) => {
          opening = null;
          if (closed || client.signal.aborted) {
            handle.close();
            if (!closed) ensure();
            return;
          }
          // A dropped connection ends the stream without an end frame.
          const lost = (): void => detach(client);
          client.signal.addEventListener('abort', lost, { once: true });
          let unsubscribe = (): void => undefined;
          attached = {
            client,
            close: (): void => {
              client.signal.removeEventListener('abort', lost);
              unsubscribe();
              handle.close();
            },
          };
          unsubscribe = handle.onFrame((frame) => {
            if (attached?.client !== client) return;
            if (frame.kind === 'item') {
              publish(frame.item.status);
              return;
            }
            settled.add(client);
            detach(client);
          });
        },
        () => {
          opening = null;
          if (!client.signal.aborted) settled.add(client);
          ensure();
        },
      );
  };

  function ensure(): void {
    if (closed || opening) return;
    if (attached) {
      if (!attached.client.signal.aborted) return;
      detach(attached.client);
    }
    for (const session of Array.from(sessions)) {
      const client = liveClient(session);
      if (!client) continue;
      open(client);
      return;
    }
  }

  return {
    observe(session): void {
      if (closed) return;
      sessions.add(session);
      ensure();
    },
    reattach: (): void => ensure(),
    current: () => status,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close(): void {
      closed = true;
      sessions.clear();
      const current = attached;
      attached = null;
      current?.close();
      status = null;
      listeners.clear();
    },
  };
}

let source: DaemonExecutionStatusSource | undefined;

/** Electron main's one source, shared by the daemon access and the monitor. */
export function getDaemonExecutionStatus(): DaemonExecutionStatusSource {
  source ??= createDaemonExecutionStatusSource();
  return source;
}

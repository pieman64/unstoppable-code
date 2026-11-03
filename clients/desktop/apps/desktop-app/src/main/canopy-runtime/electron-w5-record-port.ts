import { randomUUID } from 'node:crypto';
import {
  W5_RECORD_PORT_GRANTS,
  type W5RecordPortTransport,
} from '@canopy/core-runtime/node/w5/record-port';
import {
  w5RecordPortTransportOver,
  type W5RecordPortClient,
} from '../lib/w5-daemon-record-store';
import {
  getElectronDaemonConnections,
  getElectronDaemonFilesContext,
} from './electron-daemon-access';
import { markUnreachable } from './electron-daemon-connection';
import { getElectronDaemonHealth } from './electron-daemon-health';
import { guardW5RecordPortCalls } from './w5-record-port-guard';

/*
 * W6g's record-port client for the daemon-backed W5 store, leased through
 * main's daemon connection service (CAN-5528). The service records the
 * lease's client instance as this process's own origin, which the daemon
 * attributes the store's commits to, so W5e skips them and handles a peer's.
 * Only a flip build's startup handoff (CAN-5543) leases it in production.
 */

export interface ElectronW5RecordPortLease {
  /** The lease identity the daemon attributes this store's commits to. */
  readonly clientInstanceId: string;
  /** Opens no connection until its first call. */
  readonly transport: W5RecordPortTransport;
  /** Releases the session; later calls are refused `cancelled`. */
  close(): void;
}

// Open leases: the notice covers W5 records until the last one closes.
let openLeases = 0;

export function leaseElectronW5RecordPort(): ElectronW5RecordPortLease {
  const owner = new AbortController();
  // Unique per process, so no other Electron's commits count as this one's.
  const clientInstanceId = `electron-main:w5-records:${randomUUID()}`;
  const client = async (): Promise<W5RecordPortClient> => {
    let authorityId: string;
    try {
      ({ authorityId } = await getElectronDaemonFilesContext());
    } catch (error) {
      // Without a trusted host no daemon can start.
      throw markUnreachable(error, 'host_unavailable');
    }
    const session = await getElectronDaemonConnections().get(
      {
        principalId: 'local-desktop-user',
        clientInstanceId,
        authorityId,
        interfaceKind: 'desktop',
        grants: [...W5_RECORD_PORT_GRANTS],
      },
      owner.signal,
    );
    // Read per call: after a drop the lease adopts a replacement connection.
    // Until then the getter throws its failure tagged `connection_lost`.
    return session.client;
  };
  // While leased, the background service notice covers W5 records too; its
  // reachability comes from this lease's own `get` calls.
  const health = getElectronDaemonHealth();
  openLeases += 1;
  health.setConsumerEnabled('workspace_records', true);
  return {
    clientInstanceId,
    transport: w5RecordPortTransportOver(
      guardW5RecordPortCalls({
        connect: client,
        owner: owner.signal,
        // A start-class failure since the last reach: refuse without a
        // respawn or a setup timeout per call, until Try again or a reach.
        held: () => health.isLatched(),
        // Like a Files fallback read: shows the notice and latches even when
        // no connection event did; a dropped session (`connection_lost`)
        // stays hidden while the lease restarts the daemon.
        onUnreachable: (tag) => health.noteFallback('workspace_records', tag),
      }),
    ),
    close: (): void => {
      if (owner.signal.aborted) return;
      owner.abort();
      openLeases -= 1;
      if (openLeases === 0)
        health.setConsumerEnabled('workspace_records', false);
    },
  };
}

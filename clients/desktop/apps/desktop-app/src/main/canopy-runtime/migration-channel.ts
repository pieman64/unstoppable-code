import {
  daemonRequirement,
  peerCaptureFor,
  type OwnedChildServices,
  type PeerIdentityServices,
} from '@canopy/core-platform';
import {
  authenticateMigrationDestination,
  type MigrationDaemonExpectation,
} from '@canopy/core-runtime/node/vault';
import { createCanopyFramedConnection } from '@canopy/core-transport';
import {
  migrationChannelDuplex,
  migrationFirstFrame,
  type MigrationByteChannel,
} from '@canopy/core-transport/node/migration-channel';
import { createCanopyClient } from '@canopy/core-client';
import type {
  CanopyDaemonMigrationLaunch,
  CanopyOwnedDaemonChild,
} from '@canopy/core-client/node';
import { CORE_MIGRATION_INSTRUCTION_DEFINITIONS } from '@canopy/protocol/canopy-core';

export const ELECTRON_MIGRATION_ROLE = Object.freeze({
  enabled: false,
  reason: 'release-gate-and-v5-ports',
} as const);

/** Electron main only. The native channel and authenticated client never leave this closure. */
export function createElectronMigrationLaunch(
  options:
    | { readonly enabled: false }
    | {
        readonly enabled: true;
        readonly children: OwnedChildServices;
        readonly peerIdentity: PeerIdentityServices;
        readonly expected: MigrationDaemonExpectation;
      },
): CanopyDaemonMigrationLaunch | undefined {
  if (!options.enabled) return undefined;
  const required = daemonRequirement(
    {
      team: options.expected.teamId,
      identifier: options.expected.identifier,
      build: options.expected.binding,
    },
    true,
  );
  return {
    async spawn(request, auth, signal): Promise<CanopyOwnedDaemonChild> {
      signal.throwIfAborted();
      const { child, channel } =
        await options.children.spawnWithChannel(request);
      let transport: MigrationByteChannel = channel;
      const close = (): void => transport.close();
      signal.addEventListener('abort', close, { once: true });
      try {
        signal.throwIfAborted();
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
        transport = await migrationFirstFrame(
          channel,
          'launcher',
          () => {
            if (
              !options.peerIdentity.captureDaemonEvidence(channel, required).ok
            )
              return false;
            return authenticateMigrationDestination(peerCaptureFor(channel), {
              os: 'darwin',
              expected: options.expected,
            }).authenticated;
          },
          bounded,
        );
        const duplex = migrationChannelDuplex(transport);
        const connection = await createCanopyFramedConnection(duplex, {
          role: 'client',
          auth,
          handshakeTimeoutMs: 2000,
        });
        // The removable channel listener owns startup cancellation, not the client.
        const client = await createCanopyClient({
          connection,
          definitions: {
            queries: {},
            instructions: CORE_MIGRATION_INSTRUCTION_DEFINITIONS,
            streams: {},
          },
          clientName: 'migration-launcher',
          clientVersion: '1',
        });
        // V5 owns source reads and deletion; no plaintext is read by this disabled leg.
        void child.exited
          .then(
            () => client.close(),
            () => client.close(),
          )
          .catch(() => undefined);
        return {
          pid: child.pid,
          exited: child.exited,
          commit: (commitSignal): void => {
            child.commit(commitSignal);
            signal.removeEventListener('abort', close);
          },
          terminate: async (stopSignal): Promise<void> => {
            try {
              await client.close();
            } finally {
              close();
              await child.terminate(stopSignal);
              signal.removeEventListener('abort', close);
            }
          },
        };
      } catch (error) {
        close();
        signal.removeEventListener('abort', close);
        // Retain startup ownership if the launched child cannot be proved stopped.
        await child.terminate(AbortSignal.timeout(2000)).catch(() => {
          throw Object.assign(new Error('Migration child cleanup failed.'), {
            code: 'unavailable',
          });
        });
        throw error;
      }
    },
  };
}

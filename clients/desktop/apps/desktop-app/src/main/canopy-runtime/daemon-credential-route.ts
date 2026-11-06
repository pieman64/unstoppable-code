import { randomUUID } from 'node:crypto';
import type {
  CoreIntegrationCredentialSetParams,
  CoreIntegrationCredentialClearParams,
  CoreIntegrationCredentialResult,
} from '@canopy/protocol/canopy-core';
import type { CanopyClientInstructionOptions } from '@canopy/core-client';

export interface DaemonCredentialClient {
  readonly signal: AbortSignal;
  instruction(
    name: 'core.integration.credential.set',
    params: CoreIntegrationCredentialSetParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<CoreIntegrationCredentialResult>;
  instruction(
    name: 'core.integration.credential.clear',
    params: CoreIntegrationCredentialClearParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<CoreIntegrationCredentialResult>;
}
export interface DaemonCredentialSession {
  readonly signal: AbortSignal;
  readonly client: DaemonCredentialClient;
  readonly lease: { readonly state: string };
}

/** Observes established sessions only. Saving never attaches, reconnects or starts a daemon. */
export function createDaemonCredentialRoute(): {
  observe(session: DaemonCredentialSession): void;
  writeThrough(
    secret: string,
    expectedLegacyGeneration?: string,
  ): Promise<void>;
} {
  const sessions = new Set<DaemonCredentialSession>();
  return {
    observe(session): void {
      if (sessions.has(session) || session.signal.aborted) return;
      sessions.add(session);
      session.signal.addEventListener('abort', () => sessions.delete(session), {
        once: true,
      });
    },
    async writeThrough(secret, expectedLegacyGeneration): Promise<void> {
      try {
        for (const session of sessions) {
          const state = session.lease.state;
          if (
            session.signal.aborted ||
            state === 'released' ||
            state === 'failed'
          ) {
            sessions.delete(session);
            continue;
          }
          if (state !== 'active') continue;
          let client: DaemonCredentialClient;
          try {
            // A lease replaces its client in place; its getter can refuse during recovery.
            client = session.client;
          } catch {
            continue;
          }
          if (client.signal.aborted) continue;
          const options = { signal: AbortSignal.timeout(2000) };
          if (secret) {
            if (!expectedLegacyGeneration) return;
            await client.instruction(
              'core.integration.credential.set',
              {
                credentialKind: 'github.pat',
                secret,
                expectedLegacyGeneration,
              },
              { ...options, metadata: { idempotencyKey: randomUUID() } },
            );
          } else {
            await client.instruction(
              'core.integration.credential.clear',
              { credentialKind: 'github.pat' },
              options,
            );
          }
          return;
        }
      } catch {
        // The legacy save already committed; generation fencing invalidates stale copies.
      }
    },
  };
}

export const daemonCredentialRoute = createDaemonCredentialRoute();

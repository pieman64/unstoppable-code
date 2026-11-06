import { Buffer } from 'node:buffer';
import {
  CORE_VAULT_QUERY_DEFINITIONS,
  CORE_VAULT_INSTRUCTION_DEFINITIONS,
  vaultError,
} from '@canopy/protocol/canopy-core';
import {
  defineRuntimeModule,
  type RuntimeModule,
} from '../../kernel/runtime-profile-graph';
import {
  CanopyOperationError,
  canopyInvalidArgumentError,
} from '../../runtime/errors';
import type { DaemonVault } from './daemon-vault';

function cursorAfter(
  cursor: string | undefined,
  family: string | undefined,
): string | null {
  if (!cursor) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(decoded) &&
      decoded.length === 2 &&
      decoded[0] === (family ?? null) &&
      typeof decoded[1] === 'string' &&
      decoded[1].length > 0
    )
      return decoded[1];
  } catch {
    // Reject foreign and malformed cursors alike.
  }
  throw canopyInvalidArgumentError('Invalid operation parameters.');
}

// No domain instruction writer is installed in V6-a. Grant possession alone
// cannot mint a family capability; CAN-4415 / CAN-4513 supply those writers.
function writerRefused(): never {
  throw new CanopyOperationError(
    vaultError('core.vault.entry.writerRefused', { reason: 'managed_family' }),
  );
}

/** Metadata reads and registered, custody-gated instructions; never secret reads. */
export function createVaultModule(vault: DaemonVault): RuntimeModule {
  return defineRuntimeModule({
    name: 'core.vault',
    plane: 'core',
    services: [vault.service],
    definitions: {
      queries: CORE_VAULT_QUERY_DEFINITIONS,
      instructions: CORE_VAULT_INSTRUCTION_DEFINITIONS,
      streams: {},
    },
    handlers: {
      queries: {
        'core.vault.status.get': () => vault.status(),
        'core.vault.entry.list': async ({ family, pageSize, cursor }) => {
          const after = cursorAfter(cursor, family);
          const items = (await vault.list())
            .filter(
              (entry) =>
                (!family || entry.family === family) &&
                (after === null || entry.ref.entryId > after),
            )
            .sort((a, b) =>
              a.ref.entryId < b.ref.entryId
                ? -1
                : a.ref.entryId > b.ref.entryId
                  ? 1
                  : 0,
            );
          const page = items.slice(0, pageSize);
          const tail = page[page.length - 1];
          return {
            items: page,
            nextCursor:
              items.length > pageSize && tail
                ? Buffer.from(
                    JSON.stringify([family ?? null, tail.ref.entryId]),
                  ).toString('base64url')
                : null,
          };
        },
        'core.vault.entry.get': async ({ ref }) => {
          const entry = await vault.get(ref);
          if (entry) return entry;
          throw new CanopyOperationError(
            vaultError('core.vault.entry.notFound', {
              ref,
              reason: 'absent',
            }),
          );
        },
      },
      instructions: {
        'core.vault.entry.put': writerRefused,
        'core.vault.entry.delete': writerRefused,
      },
      streams: {},
    },
  });
}

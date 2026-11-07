import type { VaultKeyHolder } from '../key-holder';
import type {
  VaultFamilyWriter,
  VaultPutRequest,
} from '../../../../vault/contracts';
import {
  createMigrationStorage,
  type MigrationStorage,
} from '../migration-storage';
import { createVaultWritePath, type VaultPutHooks } from '../put-path';
import type { VaultDeleteHooks } from '../delete-path';
import { replayVaultStore } from '../read-view';
import type { VaultStore } from '../store';
import { deriveVaultSubkeys, type VaultSubkeys } from '../vault-keys';
import { STORE_VAULT_ID } from './store-fixtures';

export const migrationIdentity = {
  brand: 'canopy',
  build: 'internal',
  sourceFlavor: 'canopy-internal',
  sourceMode: 'development',
  slot: 'copilot-account',
  generation: 'ciphertext-generation-1',
} as const;

export interface MigrationFixture {
  readonly keys: VaultSubkeys;
  readonly migration: MigrationStorage;
  readonly writer: VaultFamilyWriter;
  readonly github: VaultFamilyWriter;
}

export function migrationFixture(
  store: VaultStore,
  hooks: VaultPutHooks & VaultDeleteHooks = {},
): MigrationFixture {
  const keys = deriveVaultSubkeys(new Uint8Array(32).fill(53), STORE_VAULT_ID);
  const migration = createMigrationStorage(store, keys);
  const holder: VaultKeyHolder = {
    keys: () => keys,
    entryBlock: () => null,
    status: () => ({
      protection: { state: 'available', backend: 'macos_keychain' },
      observedAt: null,
    }),
    probeIfDue: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    adopt: () => undefined,
    dispose: () => undefined,
  };
  const writes = createVaultWritePath({
    store,
    holder,
    view: replayVaultStore(store, STORE_VAULT_ID),
    clock: () => new Date('2026-11-06T12:00:00Z'),
    isCorrupt: () => false,
    migrationIntent: migration.bindIntent,
    ...hooks,
  });
  return {
    keys,
    migration,
    writer: writes.writer('copilot-account'),
    github: writes.writer('github-pat'),
  };
}
export function importRequest(
  key: string,
): Extract<VaultPutRequest, { readonly entryId: null }> {
  return {
    entryId: null,
    family: 'copilot-account',
    expectedRevision: null,
    idempotencyKey: key,
    label: 'Copilot',
    expiresAt: null,
    material: new TextEncoder().encode('credential-sentinel'),
  } as const;
}

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { PlatformSecretProtectionServices } from '../../../../platform/secret-protection';
import {
  createFakeSecretProtection,
  type FakeSecretProtection,
} from '../../../../platform/testing/fake-secret-protection';
import {
  openVaultReadRepository,
  type VaultReadRepository,
} from '../read-repository';
import type { VaultDeleteHooks } from '../delete-path';
import type { VaultPutHooks } from '../put-path';
import { sealVaultSecret } from '../sealed-secret';
import {
  VAULT_STORE_FILE,
  type VaultStore,
  type VaultStoreFaults,
} from '../store';
import { initializeVault } from '../store-init';
import type { VaultStoredHeader } from '../store-records';
import {
  deriveVaultSubkeys,
  disposeVaultSubkeys,
  type VaultSubkeys,
} from '../vault-keys';
import { zeroBytes } from '../zero-bytes';
import { storeFolder, type StoreFolder } from './store-fixtures';

/** Matches the store fixture's clock. */
export const NOW = Date.parse('2026-10-29T12:00:00.000Z');
export const PAST = '2026-10-29T11:00:00.000Z';
export const FUTURE = '2026-10-30T12:00:00.000Z';
export const FAMILY = 'test.family';

export interface SeedEntry {
  readonly entryId: string;
  readonly label?: string;
  readonly expiresAt?: string | null;
  readonly material?: Uint8Array;
}

export interface VaultRestartOptions extends VaultPutHooks, VaultDeleteHooks {
  readonly faults?: VaultStoreFaults;
}

export interface BackendCalls {
  reads: number;
  statuses: number;
}

/**
 * One vault on a real SQLite store and the fake key-slot backend. Seeds go
 * straight through the store with subkeys derived from the init data key, the
 * way the put path (unit D1) will write them.
 */
export interface VaultHarness {
  readonly dir: StoreFolder;
  readonly fake: FakeSecretProtection;
  readonly header: VaultStoredHeader;
  readonly slotName: string;
  readonly calls: BackendCalls;
  readonly store: () => VaultStore;
  /** Holds the next `status()` call until `release`; `started` marks its call. */
  holdNextStatus(): {
    readonly started: Promise<void>;
    readonly release: () => void;
  };
  /** Commits revision 0 of an entry, through its put intent. */
  commit(entry: SeedEntry): void;
  /** Commits `entry` again as the next revision. */
  replace(entry: SeedEntry, expectedRevision: number): void;
  recordPut(entryId: string, idempotencyKey: string): void;
  recordReplace(
    entryId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): void;
  recordDelete(entryId: string, expectedRevision: number, key: string): number;
  tombstone(entryId: string, expectedRevision: number): void;
  /** Closes the store, runs SQL on the file, and reopens it. */
  raw(sql: (db: DatabaseSync) => void): Promise<void>;
  /** Reopens the store and the repository over it: a restart. */
  restart(options?: VaultRestartOptions): Promise<VaultReadRepository>;
  advance(ms: number): void;
  dispose(): void;
}

function receipt(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

export async function createVaultHarness(): Promise<VaultHarness> {
  const dir = storeFolder();
  const fake = createFakeSecretProtection({ backend: 'macos_keychain' });
  const calls: BackendCalls = { reads: 0, statuses: 0 };
  let statusHold: {
    readonly onCall: () => void;
    readonly released: Promise<void>;
  } | null = null;
  const slots: PlatformSecretProtectionServices = {
    ...fake.port,
    readKeySlot: (slot, options) => {
      calls.reads += 1;
      return fake.port.readKeySlot(slot, options);
    },
    status: async (options) => {
      calls.statuses += 1;
      const hold = statusHold;
      statusHold = null;
      if (hold) {
        hold.onCall();
        await hold.released;
      }
      return fake.port.status(options);
    },
  };
  let store = await dir.opened();
  const initialized = await initializeVault(
    store,
    fake.port,
    new AbortController().signal,
  );
  if (initialized.kind !== 'initialized')
    throw new Error(`Vault not initialized: ${initialized.kind}`);
  const { header } = initialized;
  const keys: VaultSubkeys = deriveVaultSubkeys(
    initialized.dataKey,
    header.vaultId,
  );
  zeroBytes(initialized.dataKey);
  let now = NOW;
  let vault: VaultReadRepository | null = null;
  let sequence = 0;

  function write<T>(
    result: { kind: 'written'; value: T } | { kind: string },
  ): T {
    if (!('value' in result)) throw new Error(`Not written: ${result.kind}`);
    return result.value;
  }

  function intent(
    kind: 'put' | 'delete',
    entryId: string,
    expectedRevision: number | null,
    idempotencyKey: string,
  ): number {
    sequence += 1;
    return write(
      store.recordIntent({
        kind,
        family: FAMILY,
        idempotencyKey,
        entryId,
        expectedRevision,
        receipt: receipt(sequence),
      }),
    ).sequence;
  }

  function commitRevision(entry: SeedEntry, revision: number): void {
    const fields = {
      vaultId: header.vaultId,
      entryId: entry.entryId,
      family: FAMILY,
      revision,
      expiresAt: entry.expiresAt ?? null,
      label: entry.label ?? 'Token',
    };
    const at = intent(
      'put',
      entry.entryId,
      revision === 0 ? null : revision - 1,
      `put-${entry.entryId}-${String(revision)}`,
    );
    const material = entry.material ?? new TextEncoder().encode('s3cr3t');
    write(
      store.commitEntry(at, {
        ...fields,
        sealed: sealVaultSecret(keys, fields, material),
      }),
    );
  }

  return {
    dir,
    fake,
    header,
    slotName: `vault-${header.vaultId}`,
    calls,
    store: () => store,
    holdNextStatus(): ReturnType<VaultHarness['holdNextStatus']> {
      let onCall = (): void => undefined;
      let release = (): void => undefined;
      const started = new Promise<void>((resolve) => {
        onCall = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      statusHold = { onCall, released };
      return { started, release };
    },
    commit: (entry) => commitRevision(entry, 0),
    replace: (entry, expectedRevision) =>
      commitRevision(entry, expectedRevision + 1),
    recordPut: (entryId, key) => void intent('put', entryId, null, key),
    recordReplace: (entryId, expectedRevision, key) =>
      void intent('put', entryId, expectedRevision, key),
    recordDelete: (entryId, expectedRevision, key) =>
      intent('delete', entryId, expectedRevision, key),
    tombstone(entryId, expectedRevision): void {
      const at = intent('delete', entryId, expectedRevision, `del-${entryId}`);
      write(store.commitTombstone(at, expectedRevision + 1));
    },
    async raw(sql): Promise<void> {
      vault?.dispose();
      store.close();
      const db = new DatabaseSync(join(dir.folder, VAULT_STORE_FILE));
      try {
        sql(db);
      } finally {
        db.close();
      }
      store = await dir.opened();
    },
    async restart(options = {}): Promise<VaultReadRepository> {
      vault?.dispose();
      store.close();
      store = await dir.opened(options.faults);
      calls.reads = 0;
      calls.statuses = 0;
      const opened = await openVaultReadRepository({
        store,
        slots,
        signal: new AbortController().signal,
        clock: () => new Date(now),
        probeTimeoutMs: 50,
        minProbeIntervalMs: 1_000,
        holdPut: options.holdPut,
        onPutRefused: options.onPutRefused,
        holdDelete: options.holdDelete,
        onDeleteRefused: options.onDeleteRefused,
      });
      if (opened.kind !== 'opened')
        throw new Error(`Repository not opened: ${opened.step}`);
      vault = opened.vault;
      return opened.vault;
    },
    advance(ms): void {
      now += ms;
    },
    dispose(): void {
      vault?.dispose();
      disposeVaultSubkeys(keys);
      store.close();
      dir.remove();
    },
  };
}

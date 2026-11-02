import {
  toVaultEntryMetadata,
  type VaultEntryState,
  type VaultStatusGetResult,
} from '@canopy/protocol/canopy-core';

import type { PlatformSecretProtectionServices } from '../../../platform/secret-protection';
import type {
  VaultAdmission,
  VaultBlockReason,
  VaultEntryMetadata,
  VaultFamilyWriter,
  VaultReadOutcome,
  VaultRepository,
  VaultSecretRef,
} from '../../../vault/contracts';
import type { VaultDeleteHooks } from './delete-path';
import { createVaultKeyHolder, type VaultKeyHolder } from './key-holder';
import { createVaultWritePath, type VaultPutHooks } from './put-path';
import {
  replayVaultStore,
  sealedFields,
  type VaultReadView,
  type VaultViewEntry,
} from './read-view';
import { pruneExpiredTombstones } from './reconciliation';
import { openVaultSecret, verifyVaultSecret } from './sealed-secret';
import type { VaultStore } from './store';
import { initializeVault } from './store-init';
import type { VaultStoredEntry } from './store-records';
import type { VaultSubkeys } from './vault-keys';
import { zeroBytes } from './zero-bytes';

/*
 * `get`, `list`, `admit` and `status` on the durable store (CAN-4500 unit C),
 * the put and delete paths beside them (units D1 and D2), and tombstone
 * retention and reconciliation (unit E). Entry state precedence follows
 * `VaultRepository`; only `get` (while the key is not held) and the trusted
 * `refresh` reach the backend after open.
 */

export interface VaultReadRepositoryOptions
  extends VaultPutHooks, VaultDeleteHooks {
  /** An open store; the caller keeps ownership and closes it. */
  readonly store: VaultStore;
  readonly slots: PlatformSecretProtectionServices;
  /** Aborts the key-slot create of a new vault. */
  readonly signal: AbortSignal;
  readonly clock?: () => Date;
  readonly probeTimeoutMs?: number;
  readonly minProbeIntervalMs?: number;
}

export interface VaultReadRepository {
  readonly vaultId: string;
  readonly repository: VaultRepository;
  /** Trusted internal re-probe; never handed to a repository consumer. */
  refresh(): Promise<void>;
  /**
   * Trusted in-process reconciliation (unit E): reopens a faulted store,
   * promotes each uncertain write that landed and nothing superseded, and
   * prunes tombstones past retention, as each open does. Best effort.
   */
  reconcile(): Promise<void>;
  /** Trusted composition only: mints a family's put and delete capability. */
  writer(family: string): VaultFamilyWriter;
  /** Drops the key and aborts a probe in flight. Idempotent. */
  dispose(): void;
}

export type VaultReadOpenStep =
  /** The store is not open. */
  | 'store'
  /** A new vault could not be started (its slot or header). */
  | 'init'
  /** A stored row is malformed, or retention faulted the store for good. */
  | 'replay';

/** Every refused open; `step` is internal context, never a branch for callers. */
export interface VaultReadUnavailable {
  readonly kind: 'vault_unavailable';
  readonly step: VaultReadOpenStep;
}

export type VaultReadOpenResult =
  | { readonly kind: 'opened'; readonly vault: VaultReadRepository }
  | VaultReadUnavailable;

const PROBE_TIMEOUT_MS = 5_000;
const MIN_PROBE_INTERVAL_MS = 2_000;

function unavailable(step: VaultReadOpenStep): VaultReadUnavailable {
  return Object.freeze({ kind: 'vault_unavailable', step });
}

type Usability =
  | {
      readonly kind: 'available';
      readonly keys: VaultSubkeys;
      readonly record: VaultStoredEntry;
    }
  | { readonly kind: 'blocked'; readonly reason: VaultBlockReason };

function blocked(reason: VaultBlockReason): Usability {
  return { kind: 'blocked', reason };
}

function createReadRepository(
  view: VaultReadView,
  holder: VaultKeyHolder,
  store: VaultStore,
  options: VaultReadRepositoryOptions & { readonly clock: () => Date },
): VaultReadRepository {
  const { clock } = options;
  const { vaultId, entries, deleted } = view;

  function find(ref: VaultSecretRef): VaultViewEntry | VaultReadOutcome {
    if (ref.vaultId !== vaultId)
      return { kind: 'not_found', reason: 'foreign_vault' };
    const entry = entries.get(ref.entryId);
    if (entry) return entry;
    return {
      kind: 'not_found',
      reason: deleted.has(ref.entryId) ? 'deleted' : 'absent',
    };
  }

  function closedRead(entry: VaultViewEntry): VaultReadOutcome | null {
    if (entry.closure === 'put_pending')
      return { kind: 'unconfirmed', state: 'unconfirmed' };
    if (entry.closure === 'delete_pending')
      return { kind: 'unconfirmed', state: 'delete_unconfirmed' };
    return null;
  }

  function isExpired(entry: VaultViewEntry): boolean {
    return (
      entry.expiresAt !== null &&
      Date.parse(entry.expiresAt) <= clock().getTime()
    );
  }

  function verified(
    entry: VaultViewEntry,
    record: VaultStoredEntry,
    keys: VaultSubkeys,
  ): boolean {
    if (entry.verification === null) {
      const result = verifyVaultSecret(
        keys,
        sealedFields(vaultId, record),
        record.sealed,
      );
      entry.verification = result.kind === 'verified' ? 'verified' : 'corrupt';
    }
    return entry.verification === 'verified';
  }

  /** Precedence for an entry with no pending closure. */
  function usability(entry: VaultViewEntry): Usability {
    const keys = holder.keys();
    if (keys === null)
      return blocked(
        isExpired(entry) ? 'expired' : (holder.entryBlock() ?? 'unavailable'),
      );
    if (entry.record === null || !verified(entry, entry.record, keys))
      return blocked('corrupt');
    if (isExpired(entry)) return blocked('expired');
    return { kind: 'available', keys, record: entry.record };
  }

  function state(entry: VaultViewEntry): VaultEntryState {
    if (entry.closure === 'put_pending') return 'unconfirmed';
    if (entry.closure === 'delete_pending') return 'delete_unconfirmed';
    const usable = usability(entry);
    return usable.kind === 'available' ? 'available' : usable.reason;
  }

  // The verification pass: every stored tag, once the key is held.
  function verifyAll(): void {
    const keys = holder.keys();
    if (keys === null) return;
    entries.forEach((entry) => {
      if (entry.record) verified(entry, entry.record, keys);
    });
  }

  function lookup(ref: VaultSecretRef): VaultViewEntry | VaultReadOutcome {
    const found = find(ref);
    if (!('closure' in found)) return found;
    return closedRead(found) ?? found;
  }

  function read(entry: VaultViewEntry): VaultReadOutcome {
    const usable = usability(entry);
    if (usable.kind !== 'available') return usable;
    const { keys, record } = usable;
    const opened = openVaultSecret(
      keys,
      sealedFields(vaultId, record),
      record.sealed,
    );
    if (opened.kind !== 'opened') {
      entry.verification = 'corrupt';
      return { kind: 'blocked', reason: 'corrupt' };
    }
    return {
      kind: 'available',
      pin: {
        ref: { vaultId, entryId: entry.entryId },
        revision: entry.revision,
      },
      material: opened.material,
    };
  }

  async function refreshed(probe: Promise<void>): Promise<void> {
    await probe;
    verifyAll();
  }

  const repository: VaultRepository = {
    async get(ref): Promise<VaultReadOutcome> {
      const before = lookup(ref);
      if (!('closure' in before)) return before;
      if (holder.keys() === null) await refreshed(holder.probeIfDue());
      // The view may have changed while the probe was in flight.
      const after = lookup(ref);
      return 'closure' in after ? read(after) : after;
    },
    list(): Promise<readonly VaultEntryMetadata[]> {
      return Promise.resolve(
        Array.from(entries.values())
          .filter((entry) => entry.listed)
          .map((entry) =>
            toVaultEntryMetadata({
              ref: { vaultId, entryId: entry.entryId },
              family: entry.family,
              label: entry.label,
              revision: entry.revision,
              state: state(entry),
              expiresAt: entry.expiresAt,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
            }),
          ),
      );
    },
    admit(pin): VaultAdmission {
      const found = find(pin.ref);
      if (!('closure' in found) || found.closure === 'delete_pending')
        return { kind: 'revoked' };
      if (found.closure === 'put_pending') return { kind: 'unconfirmed' };
      if (pin.revision !== found.revision) return { kind: 'stale' };
      const usable = usability(found);
      return usable.kind === 'available' ? { kind: 'admitted' } : usable;
    },
    status(): VaultStatusGetResult {
      return holder.status();
    },
  };

  const writes = createVaultWritePath({
    view,
    holder,
    store,
    clock,
    isCorrupt: (entry, keys) =>
      entry.record !== null && !verified(entry, entry.record, keys),
    holdPut: options.holdPut,
    onPutRefused: options.onPutRefused,
    holdDelete: options.holdDelete,
    onDeleteRefused: options.onDeleteRefused,
  });

  return {
    vaultId,
    repository,
    refresh: () => refreshed(holder.refresh()),
    reconcile(): Promise<void> {
      try {
        writes.reconcile();
      } catch {
        // A malformed row keeps every outcome it has not reached as it was.
      }
      return Promise.resolve();
    },
    writer: (family) => writes.writer(family),
    dispose: () => holder.dispose(),
  };
}

/**
 * Replays the store and probes the key slot once. A store without a header
 * starts a new vault (plan Q4c item 7) and holds the key it just wrapped.
 */
export async function openVaultReadRepository(
  options: VaultReadRepositoryOptions,
): Promise<VaultReadOpenResult> {
  const { store, slots, signal } = options;
  const clock = options.clock ?? ((): Date => new Date());
  if (store.state !== 'open') return unavailable('store');
  let dataKey: Uint8Array | null = null;
  let header = store.header;
  if (header === null) {
    const initialized = await initializeVault(store, slots, signal);
    if (initialized.kind !== 'initialized') return unavailable('init');
    ({ header, dataKey } = initialized);
  }
  let view: VaultReadView;
  try {
    pruneExpiredTombstones(store, clock());
    // An uncertain prune faults the store; reopening shows what it removed.
    if (!store.reopen()) throw new Error('The vault store is unavailable.');
    view = replayVaultStore(store, header.vaultId);
  } catch {
    if (dataKey) zeroBytes(dataKey);
    return unavailable('replay');
  }
  const holder = createVaultKeyHolder({
    slots,
    header,
    clock,
    probeTimeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
    minProbeIntervalMs: options.minProbeIntervalMs ?? MIN_PROBE_INTERVAL_MS,
  });
  const vault = createReadRepository(view, holder, store, {
    ...options,
    clock,
  });
  if (dataKey) holder.adopt(dataKey);
  else await vault.refresh();
  return { kind: 'opened', vault };
}

import {
  VaultEntryDeleteParamsSchema,
  VaultEntryPutParamsSchema,
  VaultFamilySchema,
  VaultSecretRefSchema,
  toVaultEntryMetadata,
  type VaultStatusGetResult,
} from '@canopy/protocol/canopy-core';
import type {
  VaultDeleteOutcome,
  VaultDeleteRequest,
  VaultEntryMetadata,
  VaultFamilyWriter,
  VaultNotFound,
  VaultPutOutcome,
  VaultPutRequest,
  VaultRepository,
  VaultReadOutcome,
  VaultSecretRef,
} from '../contracts';

const MEMORY_ORACLE_BACKEND = 'test_memory_oracle';

export type VaultTestCommit =
  | { readonly kind: 'committed' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'outcome_unknown'; readonly applied: boolean };

export interface VaultRepositoryTestSubject {
  readonly repository: VaultRepository;
  /** Trusted test composition only; never injected into a domain consumer. */
  writer(family: string): VaultFamilyWriter;
  /** Holds the next accepted mutation at its durability boundary. */
  holdNextCommit(): { release(outcome: VaultTestCommit): void };
  /** Confirms an applied unknown outcome, not a general admission override. */
  reconcile(ref: VaultSecretRef): Promise<void>;
  dispose?(): Promise<void>;
}

type MutationOutcome = VaultPutOutcome | VaultDeleteOutcome;
interface Entry {
  metadata: VaultEntryMetadata;
  material: Uint8Array;
  deleted: boolean;
  pending: boolean;
  uncertain: boolean;
  revoked: boolean;
  active?: Receipt;
}
interface Receipt {
  readonly fingerprint: string;
  readonly promise: Promise<MutationOutcome>;
  outcome?: MutationOutcome;
  entry?: Entry;
  candidate?: Entry;
  applied?: boolean;
}

/** Test-only semantic oracle. No encryption, filesystem, persistence or crash safety. */
export function createMemoryVaultRepository(
  vaultId = 'test-vault',
): VaultRepositoryTestSubject {
  VaultSecretRefSchema.parse({ vaultId, entryId: 'validation' });
  const entries = new Map<string, Entry>();
  const receipts = new Map<string, Receipt>();
  let nextId = 0;
  let held: Promise<VaultTestCommit> | undefined;
  const now = (): string => new Date().toISOString();
  const observedAt = now();

  function find(ref: VaultSecretRef): Entry | VaultNotFound {
    if (ref.vaultId !== vaultId)
      return { kind: 'not_found', reason: 'foreign_vault' };
    const entry = entries.get(ref.entryId);
    if (!entry) return { kind: 'not_found', reason: 'absent' };
    if (entry.deleted) return { kind: 'not_found', reason: 'deleted' };
    return entry;
  }
  function pin(entry: Entry): { ref: VaultSecretRef; revision: number } {
    return {
      ref: { ...entry.metadata.ref },
      revision: entry.metadata.revision,
    };
  }
  function expired(entry: Entry): boolean {
    return (
      entry.metadata.expiresAt !== null &&
      Date.parse(entry.metadata.expiresAt) <= Date.now()
    );
  }
  const repository: VaultRepository = {
    get(ref): Promise<VaultReadOutcome> {
      return new Promise((resolve) => {
        const entry = find(ref);
        if ('kind' in entry) return resolve(entry);
        const state = entry.metadata.state;
        if (state === 'unconfirmed' || state === 'delete_unconfirmed')
          return resolve({ kind: 'unconfirmed', state });
        if (expired(entry))
          return resolve({ kind: 'blocked', reason: 'expired' });
        resolve({
          kind: 'available',
          pin: pin(entry),
          material: new Uint8Array(entry.material),
        });
      });
    },
    list(): Promise<readonly VaultEntryMetadata[]> {
      return new Promise((resolve) => {
        resolve(
          Array.from(entries.values())
            .filter((entry) => !entry.deleted)
            .map((entry) =>
              toVaultEntryMetadata({
                ...entry.metadata,
                state:
                  entry.metadata.state === 'available' && expired(entry)
                    ? 'expired'
                    : entry.metadata.state,
              }),
            ),
        );
      });
    },
    admit(pinned) {
      const entry = find(pinned.ref);
      if ('kind' in entry || entry.revoked) return { kind: 'revoked' };
      if (
        entry.metadata.state === 'unconfirmed' ||
        entry.metadata.state === 'delete_unconfirmed'
      )
        return { kind: 'unconfirmed' };
      if (pinned.revision !== entry.metadata.revision) return { kind: 'stale' };
      if (expired(entry)) return { kind: 'blocked', reason: 'expired' };
      return { kind: 'admitted' };
    },
    status(): VaultStatusGetResult {
      // The oracle always holds its key, matching get. The backend is not in
      // VAULT_BACKENDS: the oracle protects nothing, so no adapter may report it.
      return {
        protection: { state: 'available', backend: MEMORY_ORACLE_BACKEND },
        observedAt,
      };
    },
  };

  function validate(
    request: VaultPutRequest | VaultDeleteRequest,
    operation: 'put' | 'delete',
  ): void {
    const { idempotencyKey, ...params } = request;
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 512
    )
      throw new TypeError('Invalid idempotency key.');
    if (operation === 'put' && 'material' in params) {
      const { material, ...fields } = params;
      if (
        !(material instanceof Uint8Array) ||
        material.byteLength < 1 ||
        material.byteLength > 1_000_000
      )
        throw new TypeError('Invalid vault material.');
      if (
        'secret' in fields ||
        !VaultEntryPutParamsSchema.safeParse({ ...fields, secret: 'validated' })
          .success
      )
        throw new TypeError('Invalid vault put.');
    } else if (
      operation !== 'delete' ||
      !VaultEntryDeleteParamsSchema.safeParse(params).success
    ) {
      throw new TypeError('Invalid vault mutation.');
    }
  }

  function start(
    family: string,
    request: VaultPutRequest | VaultDeleteRequest,
    operation: 'put' | 'delete',
  ): Promise<MutationOutcome> {
    validate(request, operation);
    const creating = 'entryId' in request;
    if (creating && request.family !== family)
      return Promise.resolve({ kind: 'refused', reason: 'managed_family' });
    // Canonical field order also snapshots refs and binary input before the first await.
    const input =
      'material' in request
        ? {
            label: request.label,
            expiresAt: request.expiresAt,
            material: Array.from(request.material),
          }
        : null;
    const fingerprint = JSON.stringify([
      operation,
      creating ? request.family : request.ref.vaultId,
      creating ? null : request.ref.entryId,
      request.expectedRevision,
      input,
    ]);
    const key = JSON.stringify([family, request.idempotencyKey]);
    const previous = receipts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return Promise.resolve({ kind: 'idempotency_conflict' });
      if (previous.outcome?.kind !== 'unavailable')
        return previous.outcome
          ? Promise.resolve(structuredClone(previous.outcome))
          : previous.promise.then((result) => structuredClone(result));
    }
    let entry: Entry;
    if (creating) {
      entry = previous?.entry ?? {
        metadata: {
          ref: { vaultId, entryId: `entry-${++nextId}` },
          family,
          label: request.label,
          revision: 0,
          state: 'unconfirmed',
          expiresAt: request.expiresAt,
          createdAt: now(),
          updatedAt: now(),
        },
        material: new Uint8Array(),
        deleted: false,
        pending: false,
        uncertain: false,
        revoked: false,
      };
    } else {
      const found = find(request.ref);
      if ('kind' in found) return Promise.resolve(found);
      if (found.metadata.family !== family)
        return Promise.resolve({ kind: 'refused', reason: 'managed_family' });
      entry = found;
    }
    if (
      creating &&
      previous?.entry &&
      entries.get(entry.metadata.ref.entryId) !== entry
    )
      return Promise.resolve({ kind: 'idempotency_conflict' });
    if (!creating && entry.metadata.revision !== request.expectedRevision)
      return Promise.resolve({
        kind: 'revision_conflict',
        currentRevision: entry.metadata.revision,
      });
    if (
      operation === 'put' &&
      (entry.pending || entry.uncertain || entry.revoked)
    )
      return Promise.resolve({
        kind: 'refused',
        reason: 'entry_closed',
      });
    const revision = creating ? 0 : entry.metadata.revision + 1;
    if (!Number.isSafeInteger(revision))
      throw new TypeError('Vault revision exhausted.');
    const candidate: Entry = {
      metadata: {
        ...entry.metadata,
        ref: { ...entry.metadata.ref },
        revision,
        state: 'available',
        updatedAt: now(),
        ...(input ? { label: input.label, expiresAt: input.expiresAt } : {}),
      },
      material: input ? new Uint8Array(input.material) : new Uint8Array(),
      deleted: operation === 'delete',
      pending: false,
      uncertain: false,
      revoked: operation === 'delete',
    };
    entry.metadata.state =
      operation === 'delete' ? 'delete_unconfirmed' : 'unconfirmed';
    entry.pending = true;
    if (operation === 'delete') {
      entry.revoked = true;
      if (entry.active) {
        entry.active.outcome = {
          kind: 'superseded',
          ref: { ...entry.metadata.ref },
        };
      }
    }
    entries.set(entry.metadata.ref.entryId, entry);
    const gate =
      held ?? Promise.resolve<VaultTestCommit>({ kind: 'committed' });
    held = undefined;
    const receipt: Receipt = {
      fingerprint,
      promise: finish(),
      entry,
      candidate,
    };
    entry.active = receipt;
    receipts.set(key, receipt);
    async function finish(): Promise<MutationOutcome> {
      const result = await gate;
      if (entry.active !== receipt) {
        const outcome: MutationOutcome = {
          kind: 'superseded',
          ref: { ...entry.metadata.ref },
        };
        receipt.outcome = outcome;
        return outcome;
      }
      entry.pending = false;
      receipt.applied =
        result.kind === 'committed' ||
        (result.kind === 'outcome_unknown' && result.applied);
      let outcome: MutationOutcome;
      if (result.kind === 'committed') {
        entries.set(candidate.metadata.ref.entryId, candidate);
        outcome =
          operation === 'put'
            ? { kind: 'committed', pin: pin(candidate) }
            : {
                kind: 'committed',
                ref: { ...candidate.metadata.ref },
                tombstoneRevision: revision,
              };
      } else {
        entry.uncertain = result.kind === 'outcome_unknown';
        outcome = { kind: result.kind, ref: { ...entry.metadata.ref } };
      }
      receipt.outcome = outcome;
      return outcome;
    }
    return receipt.promise.then((result) => structuredClone(result));
  }

  return {
    repository,
    writer(family): VaultFamilyWriter {
      VaultFamilySchema.parse(family);
      return Object.freeze({
        family,
        async put(request: VaultPutRequest): Promise<VaultPutOutcome> {
          const result = await start(family, request, 'put');
          if (result.kind === 'committed' && !('pin' in result))
            throw new Error('Invalid put receipt.');
          return result;
        },
        async delete(request: VaultDeleteRequest): Promise<VaultDeleteOutcome> {
          const result = await start(family, request, 'delete');
          if (
            result.kind === 'blocked' ||
            (result.kind === 'committed' && !('tombstoneRevision' in result))
          )
            throw new Error('Invalid delete receipt.');
          return result;
        },
      });
    },
    holdNextCommit(): ReturnType<VaultRepositoryTestSubject['holdNextCommit']> {
      if (held) throw new Error('A commit is already held.');
      let release: (outcome: VaultTestCommit) => void = () => {
        throw new Error('Commit hold was not initialized.');
      };
      held = new Promise<VaultTestCommit>((resolve) => {
        release = resolve;
      });
      return { release };
    },
    reconcile(ref): Promise<void> {
      return new Promise((resolve) => {
        for (const receipt of Array.from(receipts.values())) {
          const candidate = receipt.candidate;
          if (
            receipt.outcome?.kind !== 'outcome_unknown' ||
            !receipt.applied ||
            receipt.entry?.active !== receipt ||
            entries.get(ref.entryId) !== receipt.entry ||
            !candidate ||
            candidate.metadata.ref.entryId !== ref.entryId ||
            ref.vaultId !== vaultId
          )
            continue;
          entries.set(ref.entryId, candidate);
          receipt.outcome = candidate.deleted
            ? {
                kind: 'committed',
                ref: { ...ref },
                tombstoneRevision: candidate.metadata.revision,
              }
            : { kind: 'committed', pin: pin(candidate) };
        }
        resolve();
      });
    },
  };
}

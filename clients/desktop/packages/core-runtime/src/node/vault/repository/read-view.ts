import {
  VaultEntryMetadataSchema,
  VaultFamilySchema,
  VaultLabelSchema,
  VaultSecretRefSchema,
} from '@canopy/protocol/canopy-core';

import {
  readVaultSealedFields,
  type VaultSealedFields,
} from './authenticated-data';
import { isWellFormedText } from './canonical-encoding';
import { isSupersededCommit } from './reconciliation';
import type { VaultStore } from './store';
import type { VaultStoredEntry, VaultStoredIntent } from './store-records';

/*
 * The read and admission view, replayed from the store at open. Records that
 * only remove access (tombstones, delete intents) apply without the key. A
 * pending put intent leaves its entry `unconfirmed` and a pending delete
 * intent leaves it `delete_unconfirmed`, so admission stays closed across a
 * restart, unless a committed put moved the entry past the pending put. The
 * put and delete paths settle each intent's outcome from the same records
 * (unit E's restart reconciliation).
 */

export type VaultEntryClosure = 'open' | 'put_pending' | 'delete_pending';

export interface VaultViewEntry {
  readonly entryId: string;
  readonly family: string;
  readonly revision: number;
  readonly label: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The committed revision; null when only a pending intent names the entry. */
  readonly record: VaultStoredEntry | null;
  /** False when the wire cannot carry its family: readable by ref, never listed. */
  readonly listed: boolean;
  closure: VaultEntryClosure;
  /** The tag check, cached once the key is held; null until then. */
  verification: 'verified' | 'corrupt' | null;
}

export interface VaultReadView {
  readonly vaultId: string;
  readonly entries: Map<string, VaultViewEntry>;
  /** Entry IDs with a tombstone: they read `deleted`, then `absent` once it goes. */
  readonly deleted: Set<string>;
  /** Every stored intent at open, for the put path's keyed receipts. */
  readonly intents: readonly VaultStoredIntent[];
}

/** Shown when the store holds no valid label: a pending create, or a damaged row. */
export const VAULT_UNLABELED_ENTRY = 'Unlabeled entry';
const UNKNOWN_TIME = new Date(0).toISOString();
const EntryIdSchema = VaultSecretRefSchema.shape.entryId;
const TimestampSchema = VaultEntryMetadataSchema.shape.createdAt;
const ExpiresAtSchema = VaultEntryMetadataSchema.shape.expiresAt;

// No ref can name an entry ID the wire cannot carry, so such rows are skipped.
function isAddressable(entryId: string): boolean {
  return isWellFormedText(entryId) && EntryIdSchema.safeParse(entryId).success;
}

function isListable(family: string): boolean {
  return VaultFamilySchema.safeParse(family).success;
}

function timestamp(value: string): string {
  return TimestampSchema.safeParse(value).success ? value : UNKNOWN_TIME;
}

export function sealedFields(
  vaultId: string,
  record: VaultStoredEntry,
): VaultSealedFields {
  const { entryId, family, revision, expiresAt, label } = record;
  return { vaultId, entryId, family, revision, expiresAt, label };
}

export function committedEntry(
  vaultId: string,
  record: VaultStoredEntry,
): VaultViewEntry {
  const inBounds = readVaultSealedFields(sealedFields(vaultId, record));
  const label =
    isWellFormedText(record.label) &&
    VaultLabelSchema.safeParse(record.label).success
      ? record.label
      : VAULT_UNLABELED_ENTRY;
  return {
    entryId: record.entryId,
    family: record.family,
    revision: record.revision,
    label,
    expiresAt: ExpiresAtSchema.safeParse(record.expiresAt).success
      ? record.expiresAt
      : null,
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt),
    record,
    listed: isListable(record.family),
    closure: 'open',
    // Out-of-bounds fields can never verify: corrupt, once the key is held.
    verification: inBounds === null ? 'corrupt' : null,
  };
}

// Intents carry no label or expiry: the entry lists with placeholders.
function intentEntry(intent: VaultStoredIntent): VaultViewEntry {
  return {
    entryId: intent.entryId,
    family: intent.family,
    revision: intent.expectedRevision ?? 0,
    label: VAULT_UNLABELED_ENTRY,
    expiresAt: null,
    createdAt: timestamp(intent.recordedAt),
    updatedAt: timestamp(intent.recordedAt),
    record: null,
    listed: isListable(intent.family),
    closure: 'open',
    verification: null,
  };
}

// A committed delete also hides a row its tombstone no longer covers.
function removedEntryIds(
  deleted: ReadonlySet<string>,
  intents: readonly VaultStoredIntent[],
): Set<string> {
  const removed = new Set(deleted);
  for (const intent of intents)
    if (intent.kind === 'delete' && intent.state === 'committed')
      removed.add(intent.entryId);
  return removed;
}

/** The revisions an entry's committed put intents vouch for. */
interface VouchedRevisions {
  readonly revisions: Set<number>;
  highest: number;
  /** False once one vouches out of turn: not its expected successor, or twice. */
  consistent: boolean;
}

function committedPutRevisions(
  intents: readonly VaultStoredIntent[],
): Map<string, VouchedRevisions> {
  const vouched = new Map<string, VouchedRevisions>();
  for (const intent of intents) {
    const { outcomeRevision, expectedRevision } = intent;
    if (intent.kind !== 'put' || outcomeRevision === null) continue;
    const seen = vouched.get(intent.entryId) ?? {
      revisions: new Set<number>(),
      highest: outcomeRevision,
      consistent: true,
    };
    const successor = expectedRevision === null ? 0 : expectedRevision + 1;
    if (outcomeRevision !== successor || seen.revisions.has(outcomeRevision))
      seen.consistent = false;
    seen.revisions.add(outcomeRevision);
    seen.highest = Math.max(seen.highest, outcomeRevision);
    vouched.set(intent.entryId, seen);
  }
  return vouched;
}

// Each commit writes its row and settles its intent in one transaction, so a
// row behind a revision its intents vouch for, or a vouch out of turn, means
// an intent was edited, as clearing "unconfirmed" would. The entry stays
// closed (unit E's tamper rule).
function isBehindItsIntents(
  record: VaultStoredEntry,
  vouched: VouchedRevisions | undefined,
): boolean {
  return (
    vouched !== undefined &&
    (!vouched.consistent || record.revision < vouched.highest)
  );
}

// Only an unavailable put lets another put through. Once a committed put
// vouches for a stored row past the revision a pending put expected, that put
// can never commit, whichever intent came first; anything else stays closed.
function isSuperseded(
  intent: VaultStoredIntent,
  entry: VaultViewEntry | undefined,
  committed: VouchedRevisions | undefined,
): boolean {
  const revision = entry?.record?.revision;
  return (
    intent.kind === 'put' &&
    revision !== undefined &&
    committed?.revisions.has(revision) === true &&
    (intent.expectedRevision === null || revision > intent.expectedRevision)
  );
}

// A pending delete keeps the revision it was accepted against when the row
// moved past it only by a put it superseded, so its same-key retry
// re-attempts after a restart as it did before.
function withheldRevision(
  entry: VaultViewEntry,
  intent: VaultStoredIntent,
  intents: readonly VaultStoredIntent[],
): VaultViewEntry {
  const revision = entry.record?.revision;
  const { expectedRevision } = intent;
  if (
    intent.kind !== 'delete' ||
    expectedRevision === null ||
    revision === undefined ||
    revision <= expectedRevision
  )
    return entry;
  const superseded = intents.some(
    (put) =>
      put.entryId === intent.entryId &&
      put.outcomeRevision === revision &&
      isSupersededCommit(put, [intent]),
  );
  return superseded ? { ...entry, revision: expectedRevision } : entry;
}

function closeFor(entry: VaultViewEntry, intent: VaultStoredIntent): void {
  // A delete closes harder than a put, whatever their order.
  if (intent.kind === 'delete' || entry.closure === 'delete_pending')
    entry.closure = 'delete_pending';
  else entry.closure = 'put_pending';
}

/** Throws when a stored row is malformed; the caller fails closed. */
export function replayVaultStore(
  store: VaultStore,
  vaultId: string,
): VaultReadView {
  const intents = store.listIntents();
  const deleted = new Set(
    store.listTombstones().map((tombstone) => tombstone.entryId),
  );
  const removed = removedEntryIds(deleted, intents);
  const committedRevisions = committedPutRevisions(intents);
  const entries = new Map<string, VaultViewEntry>();
  for (const record of store.listEntries()) {
    if (removed.has(record.entryId) || !isAddressable(record.entryId)) continue;
    const entry = committedEntry(vaultId, record);
    if (isBehindItsIntents(record, committedRevisions.get(record.entryId)))
      entry.closure = 'put_pending';
    entries.set(record.entryId, entry);
  }
  // An intent's own family is not checked: a closure only removes access.
  for (const intent of intents) {
    if (intent.state !== 'pending' || removed.has(intent.entryId)) continue;
    if (!isAddressable(intent.entryId)) continue;
    const committed = entries.get(intent.entryId);
    if (isSuperseded(intent, committed, committedRevisions.get(intent.entryId)))
      continue;
    const entry = withheldRevision(
      committed ?? intentEntry(intent),
      intent,
      intents,
    );
    closeFor(entry, intent);
    entries.set(intent.entryId, entry);
  }
  return { vaultId, entries, deleted, intents };
}

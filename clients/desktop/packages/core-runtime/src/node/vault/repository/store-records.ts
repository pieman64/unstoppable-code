import type { SQLOutputValue } from 'node:sqlite';

import {
  VaultFamilySchema,
  VaultSecretRefSchema,
} from '@canopy/protocol/canopy-core';

import { readSealedBox } from './aes-gcm';
import {
  readVaultSealedFields,
  type VaultSealedFields,
} from './authenticated-data';
import { isWellFormedText } from './canonical-encoding';
import type { VaultSealedBox } from './record-format';

const EntryIdSchema = VaultSecretRefSchema.shape.entryId;
// Matches the bound `receipts.ts` puts on the key it binds.
const IDEMPOTENCY_KEY_MAX_LENGTH = 512;
const RECEIPT_BYTES = 32;

export interface VaultHeaderDraft {
  readonly vaultId: string;
  /** The data key wrapped under the slot KEK. */
  readonly wrappedDataKey: VaultSealedBox;
}

export interface VaultStoredHeader extends VaultHeaderDraft {
  readonly createdAt: string;
}

export interface VaultIntentDraft {
  readonly kind: 'put' | 'delete';
  readonly family: string;
  readonly idempotencyKey: string;
  readonly entryId: string;
  /** Null only for a put that creates its entry. */
  readonly expectedRevision: number | null;
  /** The put receipt MAC or the delete receipt hash; never the secret. */
  readonly receipt: Uint8Array;
}

export interface VaultStoredIntent extends VaultIntentDraft {
  readonly sequence: number;
  readonly state: 'pending' | 'committed';
  /** The committed pin or tombstone revision; null while pending. */
  readonly outcomeRevision: number | null;
  readonly recordedAt: string;
}

/** The authenticated fields of one revision, without the store's vault ID. */
export interface VaultEntryDraft extends Omit<VaultSealedFields, 'vaultId'> {
  readonly sealed: VaultSealedBox;
}

export interface VaultStoredEntry extends VaultEntryDraft {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VaultStoredTombstone {
  readonly entryId: string;
  readonly family: string;
  readonly revision: number;
  /** The delete intent that committed it. */
  readonly sequence: number;
  readonly committedAt: string;
}

export function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIdempotencyKey(value: unknown): value is string {
  return (
    isWellFormedText(value) &&
    value.length >= 1 &&
    value.length <= IDEMPOTENCY_KEY_MAX_LENGTH
  );
}

/** A plain snapshot of a valid intent; anything else is a TypeError. */
export function snapshotIntent(draft: VaultIntentDraft): VaultIntentDraft {
  const { kind, family, idempotencyKey, entryId, expectedRevision, receipt } =
    draft;
  const revisionValid =
    isRevision(expectedRevision) ||
    (kind === 'put' && expectedRevision === null);
  if (
    (kind !== 'put' && kind !== 'delete') ||
    !VaultFamilySchema.safeParse(family).success ||
    !isIdempotencyKey(idempotencyKey) ||
    !isWellFormedText(entryId) ||
    !EntryIdSchema.safeParse(entryId).success ||
    !revisionValid ||
    !(receipt instanceof Uint8Array) ||
    receipt.byteLength !== RECEIPT_BYTES
  )
    throw new TypeError('Invalid vault intent.');
  return {
    kind,
    family,
    idempotencyKey,
    entryId,
    expectedRevision,
    receipt: Uint8Array.from(receipt),
  };
}

/** A plain snapshot of a valid committed revision; anything else is a TypeError. */
export function snapshotEntry(
  draft: VaultEntryDraft,
  vaultId: string,
): VaultEntryDraft {
  const { entryId, family, revision, expiresAt, label, sealed } = draft;
  const fields = readVaultSealedFields({
    vaultId,
    entryId,
    family,
    revision,
    expiresAt,
    label,
  });
  const box = readSealedBox(sealed);
  if (fields === null || box === null || box.ciphertext.byteLength < 1)
    throw new TypeError('Invalid vault entry.');
  return {
    entryId: fields.entryId,
    family: fields.family,
    revision: fields.revision,
    expiresAt: fields.expiresAt,
    label: fields.label,
    sealed: {
      nonce: Uint8Array.from(box.nonce),
      ciphertext: Uint8Array.from(box.ciphertext),
      tag: Uint8Array.from(box.tag),
    },
  };
}

export type VaultStoreRow = Record<string, SQLOutputValue>;

// STRICT tables enforce these types, so a mismatch means the file changed
// outside SQLite: the read throws and fails closed.
function malformed(column: string): Error {
  return new Error(`The vault store column ${column} is malformed.`);
}

export function text(row: VaultStoreRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw malformed(column);
  return value;
}

function nullableText(row: VaultStoreRow, column: string): string | null {
  return row[column] === null ? null : text(row, column);
}

const utf8Encoder = new TextEncoder();
// `ignoreBOM` keeps a leading U+FEFF, which a default decoder strips.
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The bytes a BLOB text column stores; null for text UTF-8 cannot hold. */
export function utf8Bytes(value: string): Uint8Array | null {
  return isWellFormedText(value) ? utf8Encoder.encode(value) : null;
}

function utf8Text(row: VaultStoreRow, column: string): string {
  try {
    return utf8Decoder.decode(blob(row, column));
  } catch {
    throw malformed(column);
  }
}

export function integer(row: VaultStoreRow, column: string): number {
  const value = row[column];
  if (!isRevision(value)) throw malformed(column);
  return value;
}

function nullableInteger(row: VaultStoreRow, column: string): number | null {
  return row[column] === null ? null : integer(row, column);
}

export function blob(row: VaultStoreRow, column: string): Uint8Array {
  const value = row[column];
  if (!(value instanceof Uint8Array)) throw malformed(column);
  return value;
}

function intentKind(row: VaultStoreRow): VaultStoredIntent['kind'] {
  const kind = text(row, 'kind');
  if (kind !== 'put' && kind !== 'delete') throw malformed('kind');
  return kind;
}

function intentState(row: VaultStoreRow): VaultStoredIntent['state'] {
  const state = text(row, 'state');
  if (state !== 'pending' && state !== 'committed') throw malformed('state');
  return state;
}

export function decodeIntent(row: VaultStoreRow): VaultStoredIntent {
  return {
    sequence: integer(row, 'sequence'),
    kind: intentKind(row),
    family: text(row, 'family'),
    idempotencyKey: utf8Text(row, 'idempotency_key'),
    entryId: utf8Text(row, 'entry_id'),
    expectedRevision: nullableInteger(row, 'expected_revision'),
    receipt: blob(row, 'receipt'),
    state: intentState(row),
    outcomeRevision: nullableInteger(row, 'outcome_revision'),
    recordedAt: text(row, 'recorded_at'),
  };
}

/** Stored fields stay untrusted: the sealed-secret check decides `corrupt`. */
export function decodeEntry(row: VaultStoreRow): VaultStoredEntry {
  return {
    entryId: utf8Text(row, 'entry_id'),
    family: text(row, 'family'),
    revision: integer(row, 'revision'),
    expiresAt: nullableText(row, 'expires_at'),
    label: utf8Text(row, 'label'),
    sealed: {
      nonce: blob(row, 'nonce'),
      ciphertext: blob(row, 'ciphertext'),
      tag: blob(row, 'tag'),
    },
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

export function decodeTombstone(row: VaultStoreRow): VaultStoredTombstone {
  return {
    entryId: utf8Text(row, 'entry_id'),
    family: text(row, 'family'),
    revision: integer(row, 'revision'),
    sequence: integer(row, 'sequence'),
    committedAt: text(row, 'committed_at'),
  };
}

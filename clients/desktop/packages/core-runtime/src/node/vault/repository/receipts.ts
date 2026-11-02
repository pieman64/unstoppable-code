import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  VaultEntryMetadataSchema,
  VaultFamilySchema,
  VaultLabelSchema,
  VaultSecretRefSchema,
  type VaultSecretRef,
} from '@canopy/protocol/canopy-core';

import { encodeCanonical, isWellFormedText } from './canonical-encoding';
import { VAULT_RECORD_FORMAT, VAULT_SECRET_MAX_BYTES } from './record-format';
import {
  assertVaultSubkeysHeld,
  withVaultSubkey,
  type VaultSubkeys,
} from './vault-keys';
import { zeroBytes } from './zero-bytes';

/*
 * Receipts let a durable intent recognize a same-key retry without storing
 * the secret. A put receipt is keyed, because its input includes the secret;
 * a delete receipt carries nothing secret, so it needs no key and can be
 * honoured while the vault is locked.
 */

const { version, macHash, deleteReceiptHash, domains } = VAULT_RECORD_FORMAT;
const RECEIPT_BYTES = 32;
const IDEMPOTENCY_KEY_MAX_LENGTH = 512;
const ExpiresAtSchema = VaultEntryMetadataSchema.shape.expiresAt;
const EntryIdSchema = VaultSecretRefSchema.shape.entryId;

/** Canonical put input. The idempotency key is bound too, so receipts cannot move between intents. */
export interface VaultPutReceiptParams {
  readonly vaultId: string;
  /** The writer's family; for a replace, the entry's fixed family. */
  readonly family: string;
  /** Both null for a create; both set for a replace. */
  readonly entryId: string | null;
  readonly expectedRevision: number | null;
  readonly label: string;
  readonly expiresAt: string | null;
  readonly idempotencyKey: string;
  readonly material: Uint8Array;
}

export interface VaultDeleteReceiptParams {
  readonly ref: VaultSecretRef;
  readonly expectedRevision: number;
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isEntryId(value: unknown): value is string {
  return isWellFormedText(value) && EntryIdSchema.safeParse(value).success;
}

// Returns the validated material too, so the digest reads exactly what was checked.
function putReceiptInput(
  keys: VaultSubkeys,
  params: VaultPutReceiptParams,
): { readonly prefix: Uint8Array; readonly material: Uint8Array } {
  const {
    vaultId,
    family,
    entryId,
    expectedRevision,
    label,
    expiresAt,
    idempotencyKey,
    material,
  } = params;
  const create = entryId === null && expectedRevision === null;
  const replace = isEntryId(entryId) && isRevision(expectedRevision);
  if (
    vaultId !== keys.vaultId ||
    !VaultFamilySchema.safeParse(family).success ||
    !(create || replace) ||
    !isWellFormedText(label) ||
    !VaultLabelSchema.safeParse(label).success ||
    (expiresAt !== null && !ExpiresAtSchema.safeParse(expiresAt).success) ||
    !isWellFormedText(idempotencyKey) ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    !(material instanceof Uint8Array) ||
    material.byteLength < 1 ||
    material.byteLength > VAULT_SECRET_MAX_BYTES
  )
    throw new TypeError('Invalid vault put receipt params.');
  const prefix = encodeCanonical(domains.putReceipt, [
    ['uint', version],
    ['text', vaultId],
    ['text', family],
    ['nullableText', entryId],
    ['nullableUint', expectedRevision],
    ['text', label],
    ['nullableText', expiresAt],
    ['text', idempotencyKey],
    ['length', material.byteLength],
  ]);
  return { prefix, material };
}

/** `HMAC-SHA256(receipt subkey, canonical params)`, secret included. Invalid params are a TypeError. */
export function vaultPutReceipt(
  keys: VaultSubkeys,
  params: VaultPutReceiptParams,
): Uint8Array {
  assertVaultSubkeysHeld(keys);
  const { prefix, material } = putReceiptInput(keys, params);
  const digest = withVaultSubkey(keys, 'receipt', (key) =>
    createHmac(macHash, key).update(prefix).update(material).digest(),
  );
  const receipt = Uint8Array.from(digest);
  zeroBytes(digest);
  return receipt;
}

/** Constant-time; a stored receipt of the wrong shape never matches. */
export function vaultPutReceiptMatches(
  keys: VaultSubkeys,
  params: VaultPutReceiptParams,
  stored: Uint8Array,
): boolean {
  const expected = vaultPutReceipt(keys, params);
  const matches =
    stored instanceof Uint8Array &&
    stored.byteLength === RECEIPT_BYTES &&
    timingSafeEqual(expected, stored);
  zeroBytes(expected);
  return matches;
}

/** Keyless `SHA-256(canonical {ref, expectedRevision})`. Invalid params are a TypeError. */
export function vaultDeleteReceipt(
  params: VaultDeleteReceiptParams,
): Uint8Array {
  const { ref, expectedRevision } = params;
  const { vaultId, entryId } = ref;
  if (
    !isWellFormedText(vaultId) ||
    !isEntryId(entryId) ||
    !VaultSecretRefSchema.safeParse({ vaultId, entryId }).success ||
    !isRevision(expectedRevision)
  )
    throw new TypeError('Invalid vault delete receipt params.');
  const input = encodeCanonical(domains.deleteReceipt, [
    ['uint', version],
    ['text', vaultId],
    ['text', entryId],
    ['uint', expectedRevision],
  ]);
  return Uint8Array.from(createHash(deleteReceiptHash).update(input).digest());
}

export function vaultDeleteReceiptMatches(
  params: VaultDeleteReceiptParams,
  stored: Uint8Array,
): boolean {
  const expected = vaultDeleteReceipt(params);
  return (
    stored instanceof Uint8Array &&
    stored.byteLength === RECEIPT_BYTES &&
    timingSafeEqual(expected, stored)
  );
}

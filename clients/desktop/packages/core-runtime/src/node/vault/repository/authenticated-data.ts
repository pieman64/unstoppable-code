import {
  VaultEntryMetadataSchema,
  VaultFamilySchema,
  VaultLabelSchema,
  VaultSecretRefSchema,
} from '@canopy/protocol/canopy-core';

import {
  CanonicalReader,
  encodeCanonical,
  isWellFormedText,
} from './canonical-encoding';
import { VAULT_RECORD_FORMAT } from './record-format';
import { isVaultId } from './vault-keys';

const { version, domains } = VAULT_RECORD_FORMAT;
const ExpiresAtSchema = VaultEntryMetadataSchema.shape.expiresAt;
const EntryIdSchema = VaultSecretRefSchema.shape.entryId;

/**
 * Authenticated data for one sealed revision (Q5 O2′): the record format
 * version plus every field whose tampering could grant access (vault, entry,
 * family, revision, expiry), and the label. Timestamps stay cosmetic.
 */
export interface VaultSealedFields {
  readonly vaultId: string;
  readonly entryId: string;
  readonly family: string;
  readonly revision: number;
  readonly expiresAt: string | null;
  readonly label: string;
}

/**
 * A plain snapshot of in-bounds fields, else null. Reads each property once,
 * so callers check and encode exactly the same values.
 */
export function readVaultSealedFields(
  fields: unknown,
): VaultSealedFields | null {
  if (typeof fields !== 'object' || fields === null) return null;
  const vaultId: unknown = Reflect.get(fields, 'vaultId');
  const entryId: unknown = Reflect.get(fields, 'entryId');
  const family: unknown = Reflect.get(fields, 'family');
  const revision: unknown = Reflect.get(fields, 'revision');
  const expiresAt: unknown = Reflect.get(fields, 'expiresAt');
  const label: unknown = Reflect.get(fields, 'label');
  if (
    !isVaultId(vaultId) ||
    !isWellFormedText(entryId) ||
    !EntryIdSchema.safeParse(entryId).success ||
    typeof family !== 'string' ||
    !VaultFamilySchema.safeParse(family).success ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    (expiresAt !== null &&
      (typeof expiresAt !== 'string' ||
        !ExpiresAtSchema.safeParse(expiresAt).success)) ||
    !isWellFormedText(label) ||
    !VaultLabelSchema.safeParse(label).success
  )
    return null;
  return { vaultId, entryId, family, revision, expiresAt, label };
}

/** Null for fields outside their wire bounds. */
export function tryEncodeVaultAuthenticatedData(
  fields: VaultSealedFields,
): Uint8Array | null {
  const snapshot = readVaultSealedFields(fields);
  return snapshot === null ? null : encodeSnapshot(snapshot);
}

function encodeSnapshot({
  vaultId,
  entryId,
  family,
  revision,
  expiresAt,
  label,
}: VaultSealedFields): Uint8Array {
  return encodeCanonical(domains.sealedSecret, [
    ['uint', version],
    ['text', vaultId],
    ['text', entryId],
    ['text', family],
    ['uint', revision],
    ['nullableText', expiresAt],
    ['text', label],
  ]);
}

/** Rejects fields outside their wire bounds with a TypeError. */
export function encodeVaultAuthenticatedData(
  fields: VaultSealedFields,
): Uint8Array {
  const aad = tryEncodeVaultAuthenticatedData(fields);
  if (aad === null) throw new TypeError('Invalid sealed vault fields.');
  return aad;
}

/** Null for anything `encodeVaultAuthenticatedData` would not produce. */
export function decodeVaultAuthenticatedData(
  bytes: Uint8Array,
): VaultSealedFields | null {
  const reader = new CanonicalReader(bytes);
  if (reader.text() !== domains.sealedSecret || reader.uint() !== version)
    return null;
  const vaultId = reader.text();
  const entryId = reader.text();
  const family = reader.text();
  const revision = reader.uint();
  const expiresAt = reader.nullableText();
  const label = reader.text();
  if (
    vaultId === null ||
    entryId === null ||
    family === null ||
    revision === null ||
    expiresAt === undefined ||
    label === null ||
    !reader.end()
  )
    return null;
  return readVaultSealedFields({
    vaultId,
    entryId,
    family,
    revision,
    expiresAt,
    label,
  });
}

import { createHash } from 'node:crypto';
import {
  CATALOG_MATERIALIZATION_ID_PREFIX,
  catalogMaterializationFingerprintInput,
  catalogMaterializationIdInput,
  type CanopyWorkspaceScope,
  type CatalogMaterializationItemDescriptor,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';

const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** A deterministic non-negative revision for a JSON value: 52 safe bits (the web core's contentRevision, over stableStringify). */
export function catalogContentRevision(value: unknown): number {
  return Number.parseInt(sha256Hex(stableStringify(value)).slice(0, 13), 16);
}

/** "sha256:" plus the hex SHA-256 of stableStringify(value). */
export function catalogSha256(value: unknown): string {
  return `sha256:${sha256Hex(stableStringify(value))}`;
}

/** The fingerprint and id of a materialization (protocol inputs, hashed here). */
export function catalogMaterializationIdentity(
  items: readonly CatalogMaterializationItemDescriptor[],
  scope: CanopyWorkspaceScope,
): { fingerprint: string; materializationId: string } {
  const fingerprint = `sha256:${sha256Hex(catalogMaterializationFingerprintInput(items))}`;
  return {
    fingerprint,
    materializationId: `${CATALOG_MATERIALIZATION_ID_PREFIX}${sha256Hex(catalogMaterializationIdInput(fingerprint, scope))}`,
  };
}

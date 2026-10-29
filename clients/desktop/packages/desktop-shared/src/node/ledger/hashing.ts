import { createHash } from 'node:crypto';
import {
  toLedgerCanonicalJson,
  type LedgerCanonicalValue,
} from '@canopy/protocol/ledger-sync';

/** JSON data that can be serialized canonically. */
export type { LedgerCanonicalValue };

/**
 * Serializes JSON data with object keys sorted and `undefined` members
 * omitted, so equal data always produces the same text and hash. The mirror
 * checks outbox payload hashes against the same serialization, so it lives in
 * the sync contract.
 */
export function toCanonicalJson(value: LedgerCanonicalValue): string {
  return toLedgerCanonicalJson(value);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** SHA-256 over the canonical JSON of normalized request data. */
export function hashLedgerCanonicalValue(value: LedgerCanonicalValue): string {
  return sha256Hex(toCanonicalJson(value));
}

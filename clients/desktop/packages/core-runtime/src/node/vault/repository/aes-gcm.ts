import { createCipheriv, createDecipheriv, randomFillSync } from 'node:crypto';

import {
  vaultIntegrityFailure,
  type VaultIntegrityFailure,
} from './integrity-failure';
import { zeroBytes } from './zero-bytes';
import { VAULT_RECORD_FORMAT, type VaultSealedBox } from './record-format';

const { cipher, keyBytes, nonceBytes, tagBytes } = VAULT_RECORD_FORMAT;

// Node returns Buffers; copy into a plain array the caller owns and zero the
// temporaries, so no secret byte outlives the result.
function concatOwned(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
    zeroBytes(part);
  }
  return out;
}

export function isAesKey(key: unknown): key is Uint8Array {
  return key instanceof Uint8Array && key.byteLength === keyBytes;
}

/** Random 96-bit nonce per box. Inputs are trusted; callers validate them. */
export function sealBox(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): VaultSealedBox {
  const nonce = randomFillSync(new Uint8Array(nonceBytes));
  const sealer = createCipheriv(cipher, key, nonce, {
    authTagLength: tagBytes,
  });
  sealer.setAAD(aad);
  const ciphertext = concatOwned([sealer.update(plaintext), sealer.final()]);
  return { nonce, ciphertext, tag: concatOwned([sealer.getAuthTag()]) };
}

/** A stored box is untrusted: a plain snapshot of a well-formed one, else null. */
export function readSealedBox(box: unknown): VaultSealedBox | null {
  if (typeof box !== 'object' || box === null) return null;
  const nonce: unknown = Reflect.get(box, 'nonce');
  const ciphertext: unknown = Reflect.get(box, 'ciphertext');
  const tag: unknown = Reflect.get(box, 'tag');
  if (
    !(nonce instanceof Uint8Array) ||
    nonce.byteLength !== nonceBytes ||
    !(tag instanceof Uint8Array) ||
    tag.byteLength !== tagBytes ||
    !(ciphertext instanceof Uint8Array)
  )
    return null;
  return { nonce, ciphertext, tag };
}

export type VaultBoxOpen =
  /** A fresh copy the caller owns and zeroes after use. */
  | { readonly kind: 'opened'; readonly plaintext: Uint8Array }
  | VaultIntegrityFailure;

/** The key and box are untrusted: either one failing to check out is a failure. */
export function openBox(
  key: Uint8Array,
  stored: VaultSealedBox,
  aad: Uint8Array,
): VaultBoxOpen {
  if (!isAesKey(key)) return vaultIntegrityFailure('key');
  const box = readSealedBox(stored);
  if (box === null) return vaultIntegrityFailure('box');
  const opener = createDecipheriv(cipher, key, box.nonce, {
    authTagLength: tagBytes,
  });
  opener.setAAD(aad);
  opener.setAuthTag(box.tag);
  const head = opener.update(box.ciphertext);
  try {
    return { kind: 'opened', plaintext: concatOwned([head, opener.final()]) };
  } catch {
    zeroBytes(head);
    return vaultIntegrityFailure('tag');
  }
}

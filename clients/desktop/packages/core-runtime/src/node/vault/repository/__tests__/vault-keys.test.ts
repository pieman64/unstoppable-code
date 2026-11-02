import { inspect } from 'node:util';

import { sealBox } from '../aes-gcm';
import { encodeCanonical } from '../canonical-encoding';
import {
  vaultIntegrityFailure,
  type VaultIntegrityStep,
} from '../integrity-failure';
import { sealVaultSecret } from '../sealed-secret';
import { vaultPutReceipt } from '../receipts';
import { VAULT_RECORD_FORMAT, type VaultSealedBox } from '../record-format';
import {
  deriveVaultSubkeys,
  disposeVaultSubkeys,
  generateVaultKey,
  isVaultSubkeysHeld,
  unwrapDataKey,
  withVaultSubkey,
  wrapDataKey,
  type VaultSubkeys,
} from '../vault-keys';
import { zeroBytes } from '../zero-bytes';

const VAULT_ID = 'vault1';

function flip(bytes: Uint8Array, index = 0): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[index] ^= 0x01;
  return copy;
}

/** Calls with runtime values the types forbid. */
function callUnchecked(
  fn: (...args: never[]) => unknown,
  ...args: unknown[]
): unknown {
  return Reflect.apply(fn, undefined, args);
}

function subkey(keys: VaultSubkeys, purpose: 'seal' | 'receipt'): Uint8Array {
  return withVaultSubkey(keys, purpose, (key) => Uint8Array.from(key));
}

describe('generateVaultKey', () => {
  it('returns 32 fresh random bytes in a plain array', () => {
    const a = generateVaultKey();
    const b = generateVaultKey();
    expect(a).toHaveLength(32);
    expect(Buffer.isBuffer(a)).toBe(false);
    expect(a.buffer.byteLength).toBe(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('wrapDataKey / unwrapDataKey', () => {
  const kek = generateVaultKey();
  const dataKey = generateVaultKey();
  const wrapped = wrapDataKey(kek, dataKey, VAULT_ID);

  it('round-trips the data key and never stores it in the clear', () => {
    expect(wrapped.nonce).toHaveLength(12);
    expect(wrapped.tag).toHaveLength(16);
    expect(wrapped.ciphertext).toHaveLength(32);
    expect(Buffer.from(wrapped.ciphertext).equals(Buffer.from(dataKey))).toBe(
      false,
    );
    const result = unwrapDataKey(kek, wrapped, VAULT_ID);
    expect(result.kind).toBe('unwrapped');
    if (result.kind !== 'unwrapped') return;
    expect(Buffer.from(result.dataKey).equals(Buffer.from(dataKey))).toBe(true);
    expect(Buffer.isBuffer(result.dataKey)).toBe(false);
    expect(result.dataKey.buffer.byteLength).toBe(32);
  });

  it('uses a fresh nonce per wrap', () => {
    const again = wrapDataKey(kek, dataKey, VAULT_ID);
    expect(Buffer.from(again.nonce).equals(Buffer.from(wrapped.nonce))).toBe(
      false,
    );
  });

  it.each<[string, Uint8Array, VaultSealedBox, string, VaultIntegrityStep]>([
    ['a wrong KEK', generateVaultKey(), wrapped, VAULT_ID, 'tag'],
    ['a one-bit KEK change', flip(kek), wrapped, VAULT_ID, 'tag'],
    ['another vault ID', kek, wrapped, 'vault2', 'tag'],
    [
      'a tampered nonce',
      kek,
      { ...wrapped, nonce: flip(wrapped.nonce) },
      VAULT_ID,
      'tag',
    ],
    [
      'a tampered ciphertext',
      kek,
      { ...wrapped, ciphertext: flip(wrapped.ciphertext, 31) },
      VAULT_ID,
      'tag',
    ],
    [
      'a tampered tag',
      kek,
      { ...wrapped, tag: flip(wrapped.tag, 15) },
      VAULT_ID,
      'tag',
    ],
    [
      'a truncated tag',
      kek,
      { ...wrapped, tag: wrapped.tag.subarray(0, 12) },
      VAULT_ID,
      'box',
    ],
    [
      'an empty tag',
      kek,
      { ...wrapped, tag: new Uint8Array(0) },
      VAULT_ID,
      'box',
    ],
    [
      'a short nonce',
      kek,
      { ...wrapped, nonce: wrapped.nonce.subarray(0, 8) },
      VAULT_ID,
      'box',
    ],
    [
      'a truncated ciphertext',
      kek,
      { ...wrapped, ciphertext: wrapped.ciphertext.subarray(0, 16) },
      VAULT_ID,
      'tag',
    ],
    ['a 16-byte KEK', kek.subarray(0, 16), wrapped, VAULT_ID, 'key'],
    ['a 1024-byte slot', new Uint8Array(1024), wrapped, VAULT_ID, 'key'],
    ['an invalid vault ID', kek, wrapped, 'Vault 1', 'vault_id'],
  ])('fails with %s', (_, key, box, vaultId, step) => {
    expect(unwrapDataKey(key, box, vaultId)).toEqual(
      vaultIntegrityFailure(step),
    );
  });

  it.each([null, undefined, 7, 'header'])(
    'fails, not throws, for a stored header of %p',
    (header) => {
      expect(callUnchecked(unwrapDataKey, kek, header, VAULT_ID)).toEqual(
        vaultIntegrityFailure('box'),
      );
    },
  );

  it('fails when the wrapped key is not 32 bytes, even with a valid tag', () => {
    const aad = encodeCanonical(VAULT_RECORD_FORMAT.domains.dataKeyWrap, [
      ['uint', VAULT_RECORD_FORMAT.version],
      ['text', VAULT_ID],
    ]);
    const valid = sealBox(kek, Uint8Array.from(dataKey), aad);
    expect(unwrapDataKey(kek, valid, VAULT_ID).kind).toBe('unwrapped');
    const short = sealBox(kek, new Uint8Array(16).fill(7), aad);
    expect(unwrapDataKey(kek, short, VAULT_ID)).toEqual(
      vaultIntegrityFailure('length'),
    );
  });

  it('does not open a sealed secret as a data key', () => {
    const keys = deriveVaultSubkeys(kek, VAULT_ID);
    const sealed = sealVaultSecret(
      keys,
      {
        vaultId: VAULT_ID,
        entryId: 'e',
        family: 'x',
        revision: 0,
        expiresAt: null,
        label: 'l',
      },
      new Uint8Array(32),
    );
    expect(unwrapDataKey(kek, sealed, VAULT_ID)).toEqual(
      vaultIntegrityFailure('tag'),
    );
    disposeVaultSubkeys(keys);
  });

  it.each<[string, Uint8Array, Uint8Array, string]>([
    ['a short KEK', new Uint8Array(16), dataKey, VAULT_ID],
    ['a long data key', kek, new Uint8Array(33), VAULT_ID],
    ['an invalid vault ID', kek, dataKey, ''],
    ['a vault ID too long for the slot name', kek, dataKey, 'a'.repeat(59)],
  ])('wrap rejects %s', (_, key, toWrap, vaultId) => {
    expect(() => wrapDataKey(key, toWrap, vaultId)).toThrow(TypeError);
  });
});

describe('deriveVaultSubkeys', () => {
  const dataKey = generateVaultKey();

  it('derives distinct seal and receipt keys, deterministic per data key and vault', () => {
    const a = deriveVaultSubkeys(dataKey, VAULT_ID);
    const b = deriveVaultSubkeys(dataKey, VAULT_ID);
    const otherVault = deriveVaultSubkeys(dataKey, 'vault2');
    const otherKey = deriveVaultSubkeys(generateVaultKey(), VAULT_ID);
    const seal = Buffer.from(subkey(a, 'seal'));
    expect(seal).toHaveLength(32);
    expect(seal.equals(Buffer.from(subkey(a, 'receipt')))).toBe(false);
    expect(seal.equals(Buffer.from(subkey(b, 'seal')))).toBe(true);
    expect(seal.equals(Buffer.from(subkey(otherVault, 'seal')))).toBe(false);
    expect(seal.equals(Buffer.from(subkey(otherKey, 'seal')))).toBe(false);
    expect(seal.equals(Buffer.from(dataKey))).toBe(false);
    for (const keys of [a, b, otherVault, otherKey]) disposeVaultSubkeys(keys);
  });

  it('keeps no reference to the data key', () => {
    const copy = Uint8Array.from(dataKey);
    const keys = deriveVaultSubkeys(copy, VAULT_ID);
    const before = subkey(keys, 'seal');
    zeroBytes(copy);
    expect(Buffer.from(subkey(keys, 'seal')).equals(Buffer.from(before))).toBe(
      true,
    );
    disposeVaultSubkeys(keys);
  });

  it('exposes no key byte through the handle', () => {
    const keys = deriveVaultSubkeys(dataKey, VAULT_ID);
    expect(JSON.stringify(keys)).toBe(`{"vaultId":"${VAULT_ID}"}`);
    expect(inspect(keys, { showHidden: true, depth: 5 })).not.toMatch(
      /Uint8Array|Buffer/,
    );
    expect(Object.isFrozen(keys)).toBe(true);
    disposeVaultSubkeys(keys);
  });

  it('dispose zeroes both subkeys, and every later use throws', () => {
    const keys = deriveVaultSubkeys(dataKey, VAULT_ID);
    const lent: Uint8Array[] = [];
    withVaultSubkey(keys, 'seal', (key) => lent.push(key));
    withVaultSubkey(keys, 'receipt', (key) => lent.push(key));
    expect(lent.every((key) => key.some((byte) => byte !== 0))).toBe(true);
    disposeVaultSubkeys(keys);
    expect(lent.every((key) => key.every((byte) => byte === 0))).toBe(true);
    expect(isVaultSubkeysHeld(keys)).toBe(false);
    expect(() => withVaultSubkey(keys, 'seal', () => 0)).toThrow(/disposed/);
    expect(() =>
      vaultPutReceipt(keys, {
        vaultId: VAULT_ID,
        family: 'x',
        entryId: null,
        expectedRevision: null,
        label: 'l',
        expiresAt: null,
        idempotencyKey: 'k',
        material: new Uint8Array(1),
      }),
    ).toThrow(/disposed/);
    expect(() => disposeVaultSubkeys(keys)).not.toThrow();
  });

  it('refuses a forged handle', () => {
    const forged: VaultSubkeys = { vaultId: VAULT_ID };
    expect(isVaultSubkeysHeld(forged)).toBe(false);
    expect(() => withVaultSubkey(forged, 'seal', () => 0)).toThrow(/unknown/);
  });

  it.each<[string, unknown, string]>([
    ['a short data key', new Uint8Array(31), VAULT_ID],
    ['a non-array data key', [1, 2], VAULT_ID],
    ['an invalid vault ID', dataKey, 'UPPER'],
  ])('rejects %s', (_, key, vaultId) => {
    expect(() => callUnchecked(deriveVaultSubkeys, key, vaultId)).toThrow(
      TypeError,
    );
  });
});

describe('zeroBytes', () => {
  it('zeroes every buffer in place, including Buffer views', () => {
    const a = Uint8Array.of(1, 2, 3);
    const backing = Buffer.from([9, 9, 9, 9]);
    const view = backing.subarray(1, 3);
    zeroBytes(a, view);
    expect([...a]).toEqual([0, 0, 0]);
    expect([...backing]).toEqual([9, 0, 0, 9]);
  });
});

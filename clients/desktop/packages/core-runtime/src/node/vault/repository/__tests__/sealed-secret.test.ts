import {
  decodeVaultAuthenticatedData,
  encodeVaultAuthenticatedData,
  tryEncodeVaultAuthenticatedData,
  type VaultSealedFields,
} from '../authenticated-data';
import { isWellFormedText } from '../canonical-encoding';
import {
  vaultIntegrityFailure,
  type VaultIntegrityStep,
} from '../integrity-failure';
import type { VaultSealedBox } from '../record-format';
import {
  openVaultSecret,
  sealVaultSecret,
  verifyVaultSecret,
} from '../sealed-secret';
import { sealBox } from '../aes-gcm';
import {
  deriveVaultSubkeys,
  disposeVaultSubkeys,
  generateVaultKey,
  withVaultSubkey,
  type VaultSubkeys,
} from '../vault-keys';

const VAULT_ID = 'vault1';
const FIELDS: VaultSealedFields = {
  vaultId: VAULT_ID,
  entryId: 'entry-1',
  family: 'github.token',
  revision: 3,
  expiresAt: '2026-11-01T00:00:00Z',
  label: 'GitHub token',
};
const SECRET = new TextEncoder().encode('s3cr3t-value');

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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

let keys: VaultSubkeys;
let sealed: VaultSealedBox;

beforeEach(() => {
  keys = deriveVaultSubkeys(generateVaultKey(), VAULT_ID);
  sealed = sealVaultSecret(keys, FIELDS, SECRET);
});

afterEach(() => disposeVaultSubkeys(keys));

describe('authenticated-data codec', () => {
  it('round-trips every field', () => {
    expect(
      decodeVaultAuthenticatedData(encodeVaultAuthenticatedData(FIELDS)),
    ).toEqual(FIELDS);
    const noExpiry = { ...FIELDS, expiresAt: null };
    expect(
      decodeVaultAuthenticatedData(encodeVaultAuthenticatedData(noExpiry)),
    ).toEqual(noExpiry);
  });

  it('keeps field boundaries: shifted text never collides', () => {
    const a = encodeVaultAuthenticatedData({
      ...FIELDS,
      entryId: 'ab',
      family: 'c',
    });
    const b = encodeVaultAuthenticatedData({
      ...FIELDS,
      entryId: 'a',
      family: 'bc',
    });
    expect(bytesEqual(a, b)).toBe(false);
  });

  it('distinguishes every authenticated field', () => {
    const base = encodeVaultAuthenticatedData(FIELDS);
    const variants: VaultSealedFields[] = [
      { ...FIELDS, vaultId: 'vault2' },
      { ...FIELDS, entryId: 'entry-2' },
      { ...FIELDS, family: 'github.other' },
      { ...FIELDS, revision: 4 },
      { ...FIELDS, expiresAt: null },
      { ...FIELDS, expiresAt: '2026-11-01T00:00:00+00:00' },
      { ...FIELDS, label: 'GitHub token ' },
    ];
    for (const variant of variants)
      expect(bytesEqual(encodeVaultAuthenticatedData(variant), base)).toBe(
        false,
      );
  });

  it.each<[string, Partial<VaultSealedFields>]>([
    ['an uppercase vault ID', { vaultId: 'Vault1' }],
    ['an empty entry ID', { entryId: '' }],
    ['an entry ID over 512', { entryId: 'e'.repeat(513) }],
    ['a lone surrogate entry ID', { entryId: 'a\uD800' }],
    ['a bad family', { family: 'Not A Family' }],
    ['a negative revision', { revision: -1 }],
    ['a fractional revision', { revision: 1.5 }],
    ['an unsafe revision', { revision: Number.MAX_SAFE_INTEGER + 1 }],
    ['a non-ISO expiry', { expiresAt: 'tomorrow' }],
    ['an empty label', { label: '' }],
    ['a label over 256', { label: 'l'.repeat(257) }],
    ['a lone surrogate label', { label: '\uDC00x' }],
  ])('rejects %s', (_, change) => {
    const fields = { ...FIELDS, ...change };
    expect(() => encodeVaultAuthenticatedData(fields)).toThrow(TypeError);
    expect(tryEncodeVaultAuthenticatedData(fields)).toBeNull();
  });

  it('round-trips a leading byte order mark', () => {
    const fields = { ...FIELDS, entryId: '\uFEFFentry', label: '\uFEFFkey' };
    expect(
      decodeVaultAuthenticatedData(encodeVaultAuthenticatedData(fields)),
    ).toEqual(fields);
  });

  it('accepts astral characters, which are well-formed', () => {
    const fields = { ...FIELDS, label: 'key 🔑 🔑' };
    expect(
      decodeVaultAuthenticatedData(encodeVaultAuthenticatedData(fields)),
    ).toEqual(fields);
  });

  it.each([
    ['a trailing high surrogate', 'key\uD83D'],
    ['a reversed pair', '\uDD11\uD83D'],
    ['a doubled high surrogate', '\uD83D🔑'],
    ['a lone low surrogate mid-string', 'a\uDD11b'],
  ])('refuses %s, which would encode like U+FFFD', (_, label) => {
    expect(isWellFormedText(label)).toBe(false);
    expect(tryEncodeVaultAuthenticatedData({ ...FIELDS, label })).toBeNull();
    expect(isWellFormedText(label.replace(/[\uD800-\uDFFF]/g, '�'))).toBe(true);
  });

  it('decodes nothing it would not encode', () => {
    const bytes = encodeVaultAuthenticatedData(FIELDS);
    const withTrailer = new Uint8Array(bytes.byteLength + 1);
    withTrailer.set(bytes);
    expect(decodeVaultAuthenticatedData(withTrailer)).toBeNull();
    expect(
      decodeVaultAuthenticatedData(bytes.subarray(0, bytes.byteLength - 1)),
    ).toBeNull();
    expect(decodeVaultAuthenticatedData(new Uint8Array(0))).toBeNull();
    expect(decodeVaultAuthenticatedData(flip(bytes, 4))).toBeNull();
    // Every single-byte change either fails to decode or decodes differently.
    for (let i = 0; i < bytes.byteLength; i += 1) {
      const decoded = decodeVaultAuthenticatedData(flip(bytes, i));
      if (decoded !== null) expect(decoded).not.toEqual(FIELDS);
    }
  });
});

describe('sealVaultSecret / openVaultSecret', () => {
  it('round-trips into a fresh caller-owned copy', () => {
    const opened = openVaultSecret(keys, FIELDS, sealed);
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') return;
    expect(bytesEqual(opened.material, SECRET)).toBe(true);
    expect(Buffer.isBuffer(opened.material)).toBe(false);
    expect(opened.material.buffer.byteLength).toBe(SECRET.byteLength);
    expect(bytesEqual(sealed.ciphertext, SECRET)).toBe(false);
    expect(verifyVaultSecret(keys, FIELDS, sealed)).toEqual({
      kind: 'verified',
    });
  });

  it('does not modify the caller’s secret, and uses a fresh nonce per seal', () => {
    const secret = Uint8Array.from(SECRET);
    const again = sealVaultSecret(keys, FIELDS, secret);
    expect(bytesEqual(secret, SECRET)).toBe(true);
    expect(bytesEqual(again.nonce, sealed.nonce)).toBe(false);
    expect(bytesEqual(again.ciphertext, sealed.ciphertext)).toBe(false);
  });

  it('seals the largest and smallest secret', () => {
    for (const size of [1, 1_000_000]) {
      const secret = new Uint8Array(size).fill(0xab);
      const box = sealVaultSecret(keys, FIELDS, secret);
      const opened = openVaultSecret(keys, FIELDS, box);
      expect(
        opened.kind === 'opened' && bytesEqual(opened.material, secret),
      ).toBe(true);
    }
  });

  // Q5: each access-granting change, a cosmetic label change, and a swap.
  it.each<[string, Partial<VaultSealedFields>]>([
    ['a later revision', { revision: 4 }],
    ['an earlier revision', { revision: 2 }],
    ['a later expiry', { expiresAt: '2027-11-01T00:00:00Z' }],
    ['a removed expiry', { expiresAt: null }],
    ['an earlier expiry', { expiresAt: '2026-10-01T00:00:00Z' }],
    [
      'an equivalent expiry spelling',
      { expiresAt: '2026-11-01T00:00:00+00:00' },
    ],
    ['another family', { family: 'github.other' }],
    ['another entry', { entryId: 'entry-2' }],
    ['a relabel', { label: 'Renamed' }],
  ])('is corrupt after %s', (_, change) => {
    const tagFailure = vaultIntegrityFailure('tag');
    expect(openVaultSecret(keys, { ...FIELDS, ...change }, sealed)).toEqual(
      tagFailure,
    );
    expect(verifyVaultSecret(keys, { ...FIELDS, ...change }, sealed)).toEqual(
      tagFailure,
    );
  });

  it('is corrupt when ciphertext is swapped between entries', () => {
    const other: VaultSealedFields = { ...FIELDS, entryId: 'entry-2' };
    const otherSealed = sealVaultSecret(
      keys,
      other,
      new TextEncoder().encode('other'),
    );
    const tagFailure = vaultIntegrityFailure('tag');
    expect(openVaultSecret(keys, FIELDS, otherSealed)).toEqual(tagFailure);
    expect(openVaultSecret(keys, other, sealed)).toEqual(tagFailure);
    expect(
      openVaultSecret(keys, FIELDS, {
        ...sealed,
        ciphertext: otherSealed.ciphertext,
      }),
    ).toEqual(tagFailure);
  });

  it('is corrupt under another vault’s keys or a wrong data key', () => {
    const wrongKey = deriveVaultSubkeys(generateVaultKey(), VAULT_ID);
    expect(openVaultSecret(wrongKey, FIELDS, sealed)).toEqual(
      vaultIntegrityFailure('tag'),
    );
    disposeVaultSubkeys(wrongKey);
    const otherVault = deriveVaultSubkeys(generateVaultKey(), 'vault2');
    expect(openVaultSecret(otherVault, FIELDS, sealed)).toEqual(
      vaultIntegrityFailure('vault_id'),
    );
    expect(
      openVaultSecret(otherVault, { ...FIELDS, vaultId: 'vault2' }, sealed),
    ).toEqual(vaultIntegrityFailure('tag'));
    disposeVaultSubkeys(otherVault);
  });

  type Tamper = (box: VaultSealedBox) => VaultSealedBox;
  it.each<[string, Tamper, VaultIntegrityStep]>([
    [
      'a flipped nonce bit',
      (box): VaultSealedBox => ({ ...box, nonce: flip(box.nonce) }),
      'tag',
    ],
    [
      'a flipped ciphertext bit',
      (box): VaultSealedBox => ({
        ...box,
        ciphertext: flip(box.ciphertext, 5),
      }),
      'tag',
    ],
    [
      'a flipped tag bit',
      (box): VaultSealedBox => ({ ...box, tag: flip(box.tag, 15) }),
      'tag',
    ],
    [
      'a truncated tag',
      (box): VaultSealedBox => ({ ...box, tag: box.tag.subarray(0, 4) }),
      'box',
    ],
    [
      'a short nonce',
      (box): VaultSealedBox => ({ ...box, nonce: box.nonce.subarray(0, 11) }),
      'box',
    ],
    [
      'a truncated ciphertext',
      (box): VaultSealedBox => ({
        ...box,
        ciphertext: box.ciphertext.subarray(1),
      }),
      'tag',
    ],
    [
      'an empty ciphertext',
      (box): VaultSealedBox => ({ ...box, ciphertext: new Uint8Array(0) }),
      'length',
    ],
  ])('is corrupt with %s', (_, tamper, step) => {
    const failure = vaultIntegrityFailure(step);
    expect(openVaultSecret(keys, FIELDS, tamper(sealed))).toEqual(failure);
    expect(verifyVaultSecret(keys, FIELDS, tamper(sealed))).toEqual(failure);
  });

  it('reports a failure as its kind and step only, frozen', () => {
    const result = openVaultSecret(keys, FIELDS, {
      ...sealed,
      tag: flip(sealed.tag),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result)).toEqual(['kind', 'step']);
  });

  it('is corrupt with a non-binary tag', () => {
    expect(
      callUnchecked(openVaultSecret, keys, FIELDS, { ...sealed, tag: 'tag' }),
    ).toEqual(vaultIntegrityFailure('box'));
  });

  it('is corrupt, not a throw, for stored fields outside their bounds', () => {
    const fieldsFailure = vaultIntegrityFailure('fields');
    expect(openVaultSecret(keys, { ...FIELDS, label: '' }, sealed)).toEqual(
      fieldsFailure,
    );
    expect(openVaultSecret(keys, { ...FIELDS, revision: -1 }, sealed)).toEqual(
      fieldsFailure,
    );
  });

  it.each([null, undefined, 7, 'box'])(
    'is corrupt, not a throw, for a stored box or fields of %p',
    (stored) => {
      expect(callUnchecked(openVaultSecret, keys, FIELDS, stored)).toEqual(
        vaultIntegrityFailure('box'),
      );
      expect(callUnchecked(openVaultSecret, keys, stored, sealed)).toEqual(
        vaultIntegrityFailure('fields'),
      );
    },
  );

  // A getter that changes between reads must not split check from encoding.
  function shiftingVaultId(first: string, later: string): VaultSealedFields {
    let reads = 0;
    const fields: VaultSealedFields = { ...FIELDS };
    // defineProperty: a transpiled object spread would read a literal getter once.
    Object.defineProperty(fields, 'vaultId', {
      get: (): string => {
        reads += 1;
        return reads === 1 ? first : later;
      },
    });
    return fields;
  }

  it('seals the vault ID it checked', () => {
    const box = sealVaultSecret(
      keys,
      shiftingVaultId(VAULT_ID, 'vault2'),
      SECRET,
    );
    expect(openVaultSecret(keys, FIELDS, box).kind).toBe('opened');
  });

  it('opens only under the vault ID it checked', () => {
    const foreign = withVaultSubkey(keys, 'seal', (key) =>
      sealBox(
        key,
        SECRET,
        encodeVaultAuthenticatedData({ ...FIELDS, vaultId: 'vault2' }),
      ),
    );
    expect(
      openVaultSecret(keys, shiftingVaultId('vault2', VAULT_ID), foreign),
    ).toEqual(vaultIntegrityFailure('vault_id'));
  });

  it('throws, never reports corrupt, once the keys are disposed', () => {
    disposeVaultSubkeys(keys);
    expect(() => openVaultSecret(keys, FIELDS, sealed)).toThrow(/disposed/);
    expect(() => verifyVaultSecret(keys, FIELDS, sealed)).toThrow(/disposed/);
    expect(() => sealVaultSecret(keys, FIELDS, SECRET)).toThrow(/disposed/);
    expect(() =>
      openVaultSecret(keys, { ...FIELDS, label: '' }, sealed),
    ).toThrow(/disposed/);
  });

  it.each<[string, Partial<VaultSealedFields>, unknown]>([
    ['an empty secret', {}, new Uint8Array(0)],
    ['an oversized secret', {}, new Uint8Array(1_000_001)],
    ['a string secret', {}, 'x'],
    ['fields for another vault', { vaultId: 'vault2' }, SECRET],
    ['invalid fields', { family: '' }, SECRET],
  ])('seal rejects %s', (_, change, secret) => {
    expect(() =>
      callUnchecked(sealVaultSecret, keys, { ...FIELDS, ...change }, secret),
    ).toThrow(TypeError);
  });
});

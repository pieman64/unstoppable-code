import { createHash } from 'node:crypto';

import { encodeVaultAuthenticatedData } from '../authenticated-data';
import {
  vaultDeleteReceipt,
  vaultDeleteReceiptMatches,
  vaultPutReceipt,
  vaultPutReceiptMatches,
  type VaultDeleteReceiptParams,
  type VaultPutReceiptParams,
} from '../receipts';
import {
  deriveVaultSubkeys,
  disposeVaultSubkeys,
  generateVaultKey,
  type VaultSubkeys,
} from '../vault-keys';

const VAULT_ID = 'vault1';
const CREATE: VaultPutReceiptParams = {
  vaultId: VAULT_ID,
  family: 'github.token',
  entryId: null,
  expectedRevision: null,
  label: 'GitHub token',
  expiresAt: null,
  idempotencyKey: 'req-1',
  material: new TextEncoder().encode('s3cr3t'),
};
const REPLACE: VaultPutReceiptParams = {
  ...CREATE,
  entryId: 'entry-1',
  expectedRevision: 2,
};
const DELETE: VaultDeleteReceiptParams = {
  ref: { vaultId: VAULT_ID, entryId: 'entry-1' },
  expectedRevision: 2,
};

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

const dataKey = generateVaultKey();
let keys: VaultSubkeys;

beforeEach(() => {
  keys = deriveVaultSubkeys(dataKey, VAULT_ID);
});

afterEach(() => disposeVaultSubkeys(keys));

describe('vaultPutReceipt', () => {
  it('is a deterministic 32-byte MAC for the same params and data key', () => {
    const receipt = vaultPutReceipt(keys, CREATE);
    expect(receipt).toHaveLength(32);
    expect(Buffer.isBuffer(receipt)).toBe(false);
    const again = deriveVaultSubkeys(dataKey, VAULT_ID);
    expect(hex(vaultPutReceipt(again, CREATE))).toBe(hex(receipt));
    disposeVaultSubkeys(again);
  });

  it('changes with every param, including each secret byte', () => {
    const base = hex(vaultPutReceipt(keys, CREATE));
    const variants: VaultPutReceiptParams[] = [
      { ...CREATE, family: 'github.other' },
      REPLACE,
      { ...REPLACE, entryId: 'entry-2' },
      { ...REPLACE, expectedRevision: 3 },
      { ...CREATE, label: 'Other' },
      { ...CREATE, expiresAt: '2026-11-01T00:00:00Z' },
      { ...CREATE, idempotencyKey: 'req-2' },
      { ...CREATE, material: new TextEncoder().encode('s3cr3T') },
      { ...CREATE, material: new TextEncoder().encode('s3cr3t ') },
    ];
    const seen = new Set([base]);
    for (const variant of variants) {
      const receipt = hex(vaultPutReceipt(keys, variant));
      expect(seen).not.toContain(receipt);
      seen.add(receipt);
    }
  });

  it('keeps the secret length apart from the text before it', () => {
    const a = vaultPutReceipt(keys, { ...CREATE, idempotencyKey: 'k1' });
    const b = vaultPutReceipt(keys, { ...CREATE, idempotencyKey: 'k' });
    expect(hex(a)).not.toBe(hex(b));
  });

  it('needs the receipt key: another data key or vault gives another MAC', () => {
    const base = hex(vaultPutReceipt(keys, CREATE));
    const otherKey = deriveVaultSubkeys(generateVaultKey(), VAULT_ID);
    expect(hex(vaultPutReceipt(otherKey, CREATE))).not.toBe(base);
    disposeVaultSubkeys(otherKey);
    const otherVault = deriveVaultSubkeys(dataKey, 'vault2');
    expect(
      hex(vaultPutReceipt(otherVault, { ...CREATE, vaultId: 'vault2' })),
    ).not.toBe(base);
    disposeVaultSubkeys(otherVault);
  });

  it('does not contain or reveal the secret', () => {
    const receipt = Buffer.from(vaultPutReceipt(keys, CREATE));
    expect(receipt.includes(Buffer.from(CREATE.material))).toBe(false);
    expect(hex(receipt)).not.toBe(
      createHash('sha256').update(CREATE.material).digest('hex'),
    );
  });

  it('matches only its own params, in constant time over 32 bytes', () => {
    const receipt = vaultPutReceipt(keys, REPLACE);
    expect(vaultPutReceiptMatches(keys, REPLACE, receipt)).toBe(true);
    expect(
      vaultPutReceiptMatches(
        keys,
        { ...REPLACE, expectedRevision: 3 },
        receipt,
      ),
    ).toBe(false);
    const tampered = Uint8Array.from(receipt);
    tampered[31] ^= 1;
    expect(vaultPutReceiptMatches(keys, REPLACE, tampered)).toBe(false);
    expect(vaultPutReceiptMatches(keys, REPLACE, receipt.subarray(0, 16))).toBe(
      false,
    );
    expect(vaultPutReceiptMatches(keys, REPLACE, new Uint8Array(0))).toBe(
      false,
    );
    expect(
      Reflect.apply(vaultPutReceiptMatches, undefined, [keys, REPLACE, null]),
    ).toBe(false);
  });

  it.each<[string, Partial<VaultPutReceiptParams>]>([
    ['another vault', { vaultId: 'vault2' }],
    ['a bad family', { family: 'Bad Family' }],
    ['an entry ID without a revision', { entryId: 'entry-1' }],
    ['a revision without an entry ID', { expectedRevision: 1 }],
    ['an empty entry ID', { entryId: '', expectedRevision: 1 }],
    ['a negative revision', { entryId: 'e', expectedRevision: -1 }],
    ['an empty label', { label: '' }],
    ['a lone surrogate label', { label: '\uD800' }],
    ['a bad expiry', { expiresAt: 'soon' }],
    ['an empty idempotency key', { idempotencyKey: '' }],
    ['an idempotency key over 512', { idempotencyKey: 'k'.repeat(513) }],
    ['a lone surrogate idempotency key', { idempotencyKey: 'k\uDFFF' }],
    ['an empty secret', { material: new Uint8Array(0) }],
    ['an oversized secret', { material: new Uint8Array(1_000_001) }],
  ])('rejects %s', (_, change) => {
    expect(() => vaultPutReceipt(keys, { ...CREATE, ...change })).toThrow(
      TypeError,
    );
  });
});

describe('vaultDeleteReceipt', () => {
  it('is a deterministic keyless 32-byte hash', () => {
    const receipt = vaultDeleteReceipt(DELETE);
    expect(receipt).toHaveLength(32);
    expect(hex(vaultDeleteReceipt({ ...DELETE, ref: { ...DELETE.ref } }))).toBe(
      hex(receipt),
    );
    expect(vaultDeleteReceiptMatches(DELETE, receipt)).toBe(true);
  });

  it('changes with the ref and the expected revision', () => {
    const base = hex(vaultDeleteReceipt(DELETE));
    const variants: VaultDeleteReceiptParams[] = [
      { ...DELETE, expectedRevision: 3 },
      { ...DELETE, ref: { vaultId: VAULT_ID, entryId: 'entry-2' } },
      { ...DELETE, ref: { vaultId: 'vault2', entryId: 'entry-1' } },
      { ...DELETE, ref: { vaultId: 'vault1e', entryId: 'ntry-1' } },
    ];
    for (const variant of variants)
      expect(hex(vaultDeleteReceipt(variant))).not.toBe(base);
  });

  it('is domain-separated from the sealed record encoding', () => {
    const aad = encodeVaultAuthenticatedData({
      vaultId: VAULT_ID,
      entryId: 'entry-1',
      family: 'f',
      revision: 2,
      expiresAt: null,
      label: 'l',
    });
    expect(hex(vaultDeleteReceipt(DELETE))).not.toBe(
      createHash('sha256').update(aad).digest('hex'),
    );
  });

  it('matches only its own params', () => {
    const receipt = vaultDeleteReceipt(DELETE);
    expect(
      vaultDeleteReceiptMatches({ ...DELETE, expectedRevision: 1 }, receipt),
    ).toBe(false);
    expect(vaultDeleteReceiptMatches(DELETE, receipt.subarray(1))).toBe(false);
  });

  it.each<[string, VaultDeleteReceiptParams]>([
    [
      'an empty entry ID',
      { ...DELETE, ref: { vaultId: VAULT_ID, entryId: '' } },
    ],
    ['an empty vault ID', { ...DELETE, ref: { vaultId: '', entryId: 'e' } }],
    [
      'a lone surrogate vault ID',
      { ...DELETE, ref: { vaultId: '\uD800', entryId: 'e' } },
    ],
    ['a fractional revision', { ...DELETE, expectedRevision: 0.5 }],
  ])('rejects %s', (_, params) => {
    expect(() => vaultDeleteReceipt(params)).toThrow(TypeError);
  });
});

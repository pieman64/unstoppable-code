import {
  CAPABILITY_FILE_SHA256_PATTERN,
  base64UrlEncode,
  containsSecretMaterial,
  isPortableCapabilityPathSegment,
  isSafeCapabilityRelativePath,
  sha256Hex,
} from '../index';

describe('capability file primitives', () => {
  it('validates portable segments and relative paths with optional caps', () => {
    expect(isPortableCapabilityPathSegment('references')).toBe(true);
    expect(isPortableCapabilityPathSegment('CON')).toBe(false);
    expect(isSafeCapabilityRelativePath('references/guide.md')).toBe(true);
    expect(isSafeCapabilityRelativePath('C:/escape')).toBe(false);
    expect(
      isSafeCapabilityRelativePath('long/name', { maxPathLength: 4 }),
    ).toBe(false);
    expect(
      isSafeCapabilityRelativePath('long/name', { maxSegmentLength: 3 }),
    ).toBe(false);
  });

  it('provides stable digest and base64url helpers', async () => {
    const bytes = new TextEncoder().encode('abc');
    expect(await sha256Hex(bytes)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(base64UrlEncode(Uint8Array.from([251, 255]))).toBe('-_8');
    expect(CAPABILITY_FILE_SHA256_PATTERN.test('a'.repeat(64))).toBe(true);
  });

  it('detects secret material without treating ordinary text as secret', () => {
    expect(containsSecretMaterial('Authorization: Bearer hidden')).toBe(true);
    expect(containsSecretMaterial('password=hunter2')).toBe(true);
    expect(containsSecretMaterial('ordinary capability instructions')).toBe(
      false,
    );
  });
});

import { formatVersionLabel } from '../version-label';

describe('formatVersionLabel', () => {
  it('leaves internal release indicators unprefixed', () => {
    expect(formatVersionLabel('internal-123')).toBe('internal-123');
    expect(formatVersionLabel('INTERNAL-123')).toBe('INTERNAL-123');
  });

  it('prefixes stable versions with v', () => {
    expect(formatVersionLabel('1.2.3')).toBe('v1.2.3');
    expect(formatVersionLabel('1.2.3-beta.1')).toBe('v1.2.3-beta.1');
  });

  it('prefixes invalid internal-like values with v', () => {
    expect(formatVersionLabel('internal-0')).toBe('vinternal-0');
    expect(formatVersionLabel('internal-abc')).toBe('vinternal-abc');
    expect(formatVersionLabel('internal-')).toBe('vinternal-');
  });
});

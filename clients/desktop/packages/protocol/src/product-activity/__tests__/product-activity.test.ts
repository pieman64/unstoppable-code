import {
  MAX_PRODUCT_ACTIVITY_ORGANIZATION_ID_LENGTH,
  PRODUCT_ACTIVITY_TURN_KEY_PATTERN,
  PRODUCT_ACTIVITY_TURNS_PATH,
} from '../index';

describe('product activity turn contract', () => {
  it('exports the canonical endpoint and organization-id limit', () => {
    expect(PRODUCT_ACTIVITY_TURNS_PATH).toBe('/api/v1/product-activity/turns');
    expect(MAX_PRODUCT_ACTIVITY_ORGANIZATION_ID_LENGTH).toBe(128);
  });

  it('accepts exactly 64 lowercase hexadecimal characters', () => {
    expect(
      PRODUCT_ACTIVITY_TURN_KEY_PATTERN.test(
        '974cad2dd603827b06e9e6affa3de03db5af2c12c045db679a7b1bef42b41a1c',
      ),
    ).toBe(true);
    expect(PRODUCT_ACTIVITY_TURN_KEY_PATTERN.test('0'.repeat(64))).toBe(true);
  });

  it.each(['', '0'.repeat(63), '0'.repeat(65), 'A'.repeat(64)])(
    'rejects malformed turn key %p',
    (turnKey) => {
      expect(PRODUCT_ACTIVITY_TURN_KEY_PATTERN.test(turnKey)).toBe(false);
    },
  );
});

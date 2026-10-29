import { claudeContextEndTokens } from '../capture-fields';

describe('claudeContextEndTokens', () => {
  it('sums input and cache tokens reported by Claude', () => {
    expect(
      claudeContextEndTokens({
        input_tokens: 100,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 30,
      }),
    ).toBe(330);
  });

  it('treats missing token categories as zero when another category is present', () => {
    expect(claudeContextEndTokens({ input_tokens: 12 })).toBe(12);
    expect(claudeContextEndTokens({ cache_read_input_tokens: 12 })).toBe(12);
  });

  it('ignores malformed, negative, and unsafe totals', () => {
    expect(claudeContextEndTokens(null)).toBeUndefined();
    expect(claudeContextEndTokens({ input_tokens: -1 })).toBeUndefined();
    expect(
      claudeContextEndTokens({
        input_tokens: Number.MAX_SAFE_INTEGER,
        cache_read_input_tokens: 1,
      }),
    ).toBeUndefined();
  });
});

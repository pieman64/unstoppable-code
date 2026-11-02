import { defaultChatPlaceholder } from '../composer-placeholder';

describe('defaultChatPlaceholder', () => {
  it.each([
    [true, true, '@ to mention, / skills and commands'],
    [true, false, 'Send a message, / skills and commands'],
    [false, true, 'Send a message, @ to mention'],
    [false, false, 'Send a message'],
  ])(
    'names the wide affordances (slash %s, mentions %s)',
    (slash, mentions, expected) => {
      expect(defaultChatPlaceholder(slash, mentions, false)).toBe(expected);
      // Omitting the phone flag is the wide form.
      expect(defaultChatPlaceholder(slash, mentions)).toBe(expected);
    },
  );

  it.each([
    [true, true, 'Ask anything, / for skills'],
    [true, false, 'Ask anything, / for skills'],
    [false, true, 'Ask anything'],
    [false, false, 'Send a message'],
  ])(
    'keeps the phone form short (slash %s, mentions %s)',
    (slash, mentions, expected) => {
      expect(defaultChatPlaceholder(slash, mentions, true)).toBe(expected);
    },
  );

  it('never makes the phone form longer than the wide one', () => {
    for (const slash of [true, false]) {
      for (const mentions of [true, false]) {
        expect(
          defaultChatPlaceholder(slash, mentions, true).length,
        ).toBeLessThanOrEqual(defaultChatPlaceholder(slash, mentions).length);
      }
    }
  });

  it('ends the bare fallback without an ellipsis', () => {
    expect(defaultChatPlaceholder(false, false)).not.toMatch(/…|\.\.\.$/);
  });
});

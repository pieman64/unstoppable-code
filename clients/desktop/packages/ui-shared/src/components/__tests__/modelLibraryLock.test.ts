import {
  modelLibraryUnlockHint,
  modelLibraryUnlockLabel,
} from '../modelLibraryLock';

describe('modelLibraryUnlockLabel', () => {
  it.each([
    ['needs_sign_in', 'Sign in'],
    ['needs_sign_in_then_purchase', 'Sign in'],
    ['needs_purchase', undefined],
    ['unlocked', undefined],
    [undefined, undefined],
  ] as const)('labels %s rows as %s', (access, label) => {
    expect(modelLibraryUnlockLabel(access)).toBe(label);
  });

  it('keeps the purchase step in the sign-in-then-purchase hint', () => {
    expect(modelLibraryUnlockHint('needs_sign_in_then_purchase')).toBe(
      'Unlock with sign-in and AI Credit purchase',
    );
  });
});

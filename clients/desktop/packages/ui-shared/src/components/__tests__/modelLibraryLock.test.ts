import { BILLING_TOP_UP_MIN_USD } from '@canopy/protocol/billing';
import {
  MODEL_LIBRARY_UNLOCK_COPY,
  modelLibraryUnlockHint,
  modelLibraryUnlockLabel,
  modelLibraryUnlockTitle,
} from '../modelLibraryLock';

describe('modelLibraryUnlockLabel', () => {
  it.each([
    ['needs_sign_in', 'Sign in'],
    // CAN-5213: a guest sees both steps before opening the row.
    ['needs_sign_in_then_purchase', 'Sign in and buy'],
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

describe('modelLibraryUnlockTitle', () => {
  it.each([
    ['Sonnet 4.6', 'Unlock Sonnet 4.6'],
    ['  GPT-5.5 (high)  ', 'Unlock GPT-5.5 (high)'],
    [undefined, 'Unlock advanced models'],
    ['', 'Unlock advanced models'],
    ['   ', 'Unlock advanced models'],
  ] as const)('titles %j as %s', (label, title) => {
    expect(modelLibraryUnlockTitle(label)).toBe(title);
  });
});

describe('MODEL_LIBRARY_UNLOCK_COPY.purchaseBody', () => {
  it('explains free credits, the checkout minimum, scope, and selection', () => {
    expect(MODEL_LIBRARY_UNLOCK_COPY.purchaseBody).toBe(
      `Free daily credits don't unlock advanced models. Purchase some AI Credits (minimum $${BILLING_TOP_UP_MIN_USD}) to unlock Sonnet, Opus, Fable and more. We'll switch to your selected model once the purchase is complete.`,
    );
  });

  it('keeps the purchase action and picker hint', () => {
    expect(MODEL_LIBRARY_UNLOCK_COPY.purchaseAction).toBe('Get AI Credits');
    expect(modelLibraryUnlockHint('needs_purchase')).toBe(
      'Unlock with AI Credit purchase',
    );
  });
});

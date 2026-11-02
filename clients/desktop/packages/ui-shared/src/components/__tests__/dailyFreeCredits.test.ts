import {
  dailyFreeCreditsActionHint,
  dailyFreeCreditsAmountSentence,
  dailyFreeCreditsStartTomorrow,
  dailyFreeCreditsTerms,
  dailyFreeCreditsTitle,
  dailyFreeCreditsToggleLabel,
  dailyFreeCreditsTurnOnAction,
  displayableDailyFreeCreditsCap,
} from '../dailyFreeCredits';

describe('dailyFreeCredits copy', () => {
  it.each([
    [
      'AI Credits' as const,
      'Free daily AI Credits',
      'Turn on free daily AI Credits',
    ],
    [
      'AI credits' as const,
      'Free daily AI credits',
      'Turn on free daily AI credits',
    ],
  ])('keeps %s casing in the title and action', (term, title, action) => {
    expect(dailyFreeCreditsTitle(term)).toBe(title);
    expect(dailyFreeCreditsTurnOnAction(term)).toBe(action);
  });

  it('gives the switch an accessible name matching its label', () => {
    expect(dailyFreeCreditsToggleLabel('AI credits')).toBe(
      'Toggle free daily AI credits',
    );
  });

  it('names the amount only when one is known', () => {
    expect(dailyFreeCreditsAmountSentence('AI Credits', '1,250')).toBe(
      'Get 1,250 free AI Credits every day.',
    );
    expect(dailyFreeCreditsAmountSentence('AI Credits', null)).toBe(
      'Get free AI Credits every day.',
    );
  });

  it.each([
    [25, 25],
    [2.5, 2.5],
    [0, null],
    [-5, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [null, null],
    [undefined, null],
  ])('displays a cap of %s as %s', (cap, expected) => {
    expect(displayableDailyFreeCreditsCap(cap)).toBe(expected);
  });

  it('tells a guest no account is needed, and an account only no card', () => {
    expect(dailyFreeCreditsTerms({ isGuest: true })).toBe(
      'No card or account needed. Turn it off any time in Settings.',
    );
    expect(dailyFreeCreditsTerms({ isGuest: false })).toBe(
      'No card needed. Turn it off any time in Settings.',
    );
  });

  it('states the amount and cost after the out-of-credits line', () => {
    expect(
      dailyFreeCreditsActionHint('AI Credits', '25', { isGuest: false }),
    ).toBe('Get 25 free every day, no card needed.');
    expect(
      dailyFreeCreditsActionHint('AI Credits', null, { isGuest: true }),
    ).toBe('Get free AI Credits every day, no card or account needed.');
  });

  it('adds the purchase suffix only when buying is possible', () => {
    expect(dailyFreeCreditsStartTomorrow('AI credits', { canBuy: true })).toBe(
      'Your free daily AI credits start tomorrow. You can also buy credits now.',
    );
    expect(dailyFreeCreditsStartTomorrow('AI Credits', { canBuy: false })).toBe(
      'Your free daily AI Credits start tomorrow.',
    );
  });
});

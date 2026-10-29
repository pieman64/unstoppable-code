import {
  fitTextAtWordBoundary,
  wordLimitEnd,
} from '../fit-text-at-word-boundary';

// 10px per character.
const measure = (end: number): number => end * 10;

describe('fitTextAtWordBoundary', () => {
  it('reports the last boundary when the whole text is under budget', () => {
    expect(fitTextAtWordBoundary('one two three', 1000, measure)).toBe(7);
  });

  it('cuts after the last whole word instead of mid-word', () => {
    const text = "Aug 10. Can't reach the server after midnight";
    // "Aug 10. Can't r" is 15 characters.
    expect(fitTextAtWordBoundary(text, 150, measure)).toBe(
      text.indexOf(" Can't") + " Can't".length,
    );
  });

  it('finds the largest fitting boundary in a long title', () => {
    const words = Array.from({ length: 20 }, (_, index) => `word${index}`);
    const text = words.join(' ');
    const calls: number[] = [];
    const end = fitTextAtWordBoundary(text, 333, (candidate) => {
      calls.push(candidate);
      return measure(candidate);
    });
    expect(end).toBe(text.lastIndexOf(' ', 33));
    expect(end).not.toBeNull();
    expect(text.charAt(end ?? 0)).toBe(' ');
    expect(calls.length).toBeLessThan(words.length - 1);
  });

  it('places one boundary per space run and none at the start', () => {
    const everyEnd = (text: string): number[] => {
      const ends: number[] = [];
      for (let budget = 10; budget <= text.length * 10; budget += 10) {
        const end = fitTextAtWordBoundary(text, budget, measure);
        if (end !== null && !ends.includes(end)) ends.push(end);
      }
      return ends;
    };
    expect(everyEnd('  lead  run   trail  ')).toEqual([6, 11, 19]);
  });

  it('breaks at tabs, newlines, and ideographic spaces but not no-break spaces', () => {
    expect(fitTextAtWordBoundary('ab\tcd', 1000, measure)).toBe(2);
    expect(fitTextAtWordBoundary('ab\ncd', 1000, measure)).toBe(2);
    expect(fitTextAtWordBoundary('ab　cd', 1000, measure)).toBe(2);
    expect(fitTextAtWordBoundary('ab cd', 1000, measure)).toBeNull();
  });

  it('breaks at typographic spaces but not narrow or figure no-break spaces', () => {
    expect(fitTextAtWordBoundary('ab\u2002cd', 1000, measure)).toBe(2);
    expect(fitTextAtWordBoundary('ab\u2003cd', 1000, measure)).toBe(2);
    expect(fitTextAtWordBoundary('ab\u2009cd', 1000, measure)).toBe(2);
    expect(fitTextAtWordBoundary('ab\u2007cd', 1000, measure)).toBeNull();
    expect(fitTextAtWordBoundary('ab\u202Fcd', 1000, measure)).toBeNull();
  });

  it('returns null for text without spaces', () => {
    expect(fitTextAtWordBoundary('日本語のタイトル', 50, measure)).toBeNull();
  });

  it('returns null for an unusable budget', () => {
    expect(fitTextAtWordBoundary('one two', 0, measure)).toBeNull();
    expect(fitTextAtWordBoundary('one two', -5, measure)).toBeNull();
    expect(fitTextAtWordBoundary('one two', Number.NaN, measure)).toBeNull();
  });

  it('returns null when the first word does not fit', () => {
    expect(fitTextAtWordBoundary('unbreakable two', 50, measure)).toBeNull();
  });
});

describe('wordLimitEnd', () => {
  it('ends after the last allowed word, keeping its punctuation', () => {
    const text = "Aug 10. Can't reach the server";
    expect(text.slice(0, wordLimitEnd(text, 2) ?? 0)).toBe('Aug 10.');
    expect(text.slice(0, wordLimitEnd(text, 3) ?? 0)).toBe("Aug 10. Can't");
    expect(wordLimitEnd('fix: (wip) parse, then render', 2)).toBe(10);
  });

  it('counts a run of spaces as one break', () => {
    expect(wordLimitEnd('one   two   three', 2)).toBe(9);
    expect(wordLimitEnd('one \t\n two three', 1)).toBe(3);
  });

  it('ignores leading and trailing whitespace', () => {
    expect(wordLimitEnd('  one two  ', 1)).toBe(5);
    expect(wordLimitEnd('  one two  ', 2)).toBeNull();
    expect(wordLimitEnd('   ', 1)).toBeNull();
  });

  it('returns null when the text has no more words than the limit', () => {
    expect(wordLimitEnd('one two three', 3)).toBeNull();
    expect(wordLimitEnd('one two three', 4)).toBeNull();
    expect(wordLimitEnd('single', 1)).toBeNull();
    expect(wordLimitEnd('', 1)).toBeNull();
  });

  it('breaks words where fitTextAtWordBoundary does', () => {
    expect(wordLimitEnd('ab\u00A0cd ef', 1)).toBe(5);
    expect(wordLimitEnd('ab\u3000cd ef', 1)).toBe(2);
    const text = '  lead  run   trail  tail';
    const end = wordLimitEnd(text, 2);
    expect(end).toBe(11);
    expect(fitTextAtWordBoundary(text, (end ?? 0) * 10, (at) => at * 10)).toBe(
      end,
    );
  });

  it('applies no limit for a limit below one or not a whole number', () => {
    expect(wordLimitEnd('one two', 0)).toBeNull();
    expect(wordLimitEnd('one two', -1)).toBeNull();
    expect(wordLimitEnd('one two', 1.5)).toBeNull();
    expect(wordLimitEnd('one two', Number.NaN)).toBeNull();
    expect(wordLimitEnd('one two', Number.POSITIVE_INFINITY)).toBeNull();
  });
});

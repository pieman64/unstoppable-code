import {
  isGenuinePlanModeUse,
  PLAN_MODE_SUGGESTION_LIST_WORDS,
  PLAN_MODE_SUGGESTION_LONG_WORDS,
  countPlanModeSuggestionSignals,
  isLongMultiStepPrompt,
} from '../plan-mode-suggestion';

function words(count: number, word = 'alpha'): string {
  return Array.from({ length: count }, () => word).join(' ');
}

describe('countPlanModeSuggestionSignals', () => {
  it('counts nothing in empty or whitespace text', () => {
    expect(countPlanModeSuggestionSignals('')).toEqual({
      words: 0,
      listItems: 0,
      stepSignals: 0,
    });
    expect(countPlanModeSuggestionSignals('  \n\t ')).toEqual({
      words: 0,
      listItems: 0,
      stepSignals: 0,
    });
  });

  it('counts numbered and bulleted list items once each', () => {
    const text = [
      '1. one',
      '2) two',
      '  - three',
      '* four',
      '• five',
      '-',
      '-nospace',
      '**bold**',
    ].join('\n');
    expect(countPlanModeSuggestionSignals(text).listItems).toBe(5);
  });

  it('counts sequencing phrases at boundaries, case-insensitively and longest first', () => {
    const text =
      'First open the file. then edit it; And then save. After that, test! Finally ship';
    expect(countPlanModeSuggestionSignals(text).stepSignals).toBe(5);
  });

  it('ignores phrases inside sentences and partial words', () => {
    const text =
      'Open it and then wait. Nextjs is fine. Thence we go. Seconds pass';
    expect(countPlanModeSuggestionSignals(text).stepSignals).toBe(0);
  });

  it('counts phrases after a newline', () => {
    expect(
      countPlanModeSuggestionSignals('do this\nthen that\nnext the other')
        .stepSignals,
    ).toBe(2);
  });

  it('does not count a phrase leading an already-counted list item', () => {
    const text = '1. First do this. Then that\n2. Second step\n- next one';
    expect(countPlanModeSuggestionSignals(text)).toMatchObject({
      listItems: 3,
      stepSignals: 4,
    });
  });

  it('adds one signal, not one per sentence, beyond four sentences', () => {
    expect(countPlanModeSuggestionSignals('A. B. C. D.').stepSignals).toBe(0);
    expect(countPlanModeSuggestionSignals('A. B. C. D. E').stepSignals).toBe(1);
    expect(
      countPlanModeSuggestionSignals('A... B?! C. D. E. F. G. H.').stepSignals,
    ).toBe(1);
    expect(countPlanModeSuggestionSignals('A. . . . .').stepSignals).toBe(0);
  });

  it('removes backtick and tilde fenced code', () => {
    const text = [
      'first intro',
      '```ts',
      'then inside code',
      '- not a list item',
      '```',
      '~~~~',
      'next inside tilde',
      '~~~',
      'still inside',
      '~~~~',
      'then outside',
    ].join('\n');
    expect(countPlanModeSuggestionSignals(text)).toEqual({
      words: 4,
      listItems: 0,
      stepSignals: 2,
    });
  });

  it('excludes the rest of the text after an unclosed fence', () => {
    const text = `first\n\`\`\`\n${words(200)}\nthen\n- a\n- b\n- c`;
    expect(countPlanModeSuggestionSignals(text)).toEqual({
      words: 1,
      listItems: 0,
      stepSignals: 1,
    });
  });
});

describe('isLongMultiStepPrompt', () => {
  const steps = 'First do it. Then check it. Finally ship it.';
  const stepWords = 9;

  it('rejects short prompts', () => {
    expect(isLongMultiStepPrompt('')).toBe(false);
    expect(isLongMultiStepPrompt(steps)).toBe(false);
  });

  it('qualifies at exactly the long-prompt word and signal thresholds', () => {
    const filler = words(PLAN_MODE_SUGGESTION_LONG_WORDS - stepWords);
    expect(isLongMultiStepPrompt(`${steps} ${filler}`)).toBe(true);
    expect(
      isLongMultiStepPrompt(
        `${steps} ${words(PLAN_MODE_SUGGESTION_LONG_WORDS - stepWords - 1)}`,
      ),
    ).toBe(false);
    expect(
      isLongMultiStepPrompt(`First do it. Then check it. ${filler} alpha`),
    ).toBe(false);
  });

  it('rejects long ordinary prose', () => {
    const prose = Array.from(
      { length: 4 },
      () => `${words(40, 'word')} and then more words.`,
    ).join(' ');
    expect(isLongMultiStepPrompt(prose)).toBe(false);
  });

  it('qualifies at exactly the list word and item thresholds', () => {
    const list = '- one\n- two\n- three';
    const filler = words(PLAN_MODE_SUGGESTION_LIST_WORDS - 6);
    expect(isLongMultiStepPrompt(`${list}\n${filler}`)).toBe(true);
    expect(isLongMultiStepPrompt(`${list}\n${filler.slice(6)}`)).toBe(false);
    expect(isLongMultiStepPrompt(`- one\n- two\n${filler} three`)).toBe(false);
  });

  it('does not count fenced code toward the word threshold', () => {
    const code = `\`\`\`\n${words(200)}\n\`\`\``;
    expect(isLongMultiStepPrompt(`${steps}\n${code}`)).toBe(false);
  });

  it('handles large pasted input in linear time', () => {
    const large = `${steps}\n${'Log line. '.repeat(100_000)}`;
    const started = Date.now();
    expect(isLongMultiStepPrompt(large)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

it('does not retire from an accepted send when the target cannot actually plan', () => {
  expect(
    isGenuinePlanModeUse({
      planMode: true,
      planAvailable: false,
      planReadOnly: false,
      pipelineMode: false,
    }),
  ).toBe(false);
});

it('combines list and sequencing signals for a long mixed-step prompt', () => {
  const text = [
    '- ' + words(30),
    '- ' + words(30),
    'Finally ' + words(18),
  ].join('\n');
  expect(countPlanModeSuggestionSignals(text).words).toBe(81);
  expect(countPlanModeSuggestionSignals(text).stepSignals).toBe(3);
  expect(isLongMultiStepPrompt(text)).toBe(true);
});

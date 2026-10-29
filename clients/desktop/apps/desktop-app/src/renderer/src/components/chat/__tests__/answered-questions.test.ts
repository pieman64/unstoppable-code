import {
  appendSentAsMessageFallbackMarker,
  formatAskUserAnswers,
} from '@canopy/desktop-shared/lib/ask-user-answers';
import { parseAnsweredQuestions } from '../answered-questions';

function input(questions: Array<{ question: string }>): string {
  return JSON.stringify({ questions });
}

describe('parseAnsweredQuestions', () => {
  it('parses a single question with a selected option', () => {
    const result = parseAnsweredQuestions(
      input([{ question: 'Pick a color' }]),
      'Q: Pick a color\nA: Blue',
    );
    expect(result).toEqual([{ question: 'Pick a color', answer: 'Blue' }]);
  });

  it('ignores the sent-as-message fallback marker', () => {
    const result = parseAnsweredQuestions(
      input([{ question: 'Pick a color' }]),
      appendSentAsMessageFallbackMarker(
        formatAskUserAnswers([
          { question: 'Pick a color', selectedOptions: ['Blue'] },
        ]),
      ),
    );
    expect(result).toEqual([{ question: 'Pick a color', answer: 'Blue' }]);
  });

  it('parses multiple selected options', () => {
    const result = parseAnsweredQuestions(
      input([{ question: 'Pick colors' }]),
      'Q: Pick colors\nA: Blue, Green',
    );
    expect(result).toEqual([
      { question: 'Pick colors', answer: 'Blue, Green' },
    ]);
  });

  it('captures free-form Additional text', () => {
    const result = parseAnsweredQuestions(
      input([{ question: 'Pick a color' }]),
      'Q: Pick a color\nA: Other\nAdditional: Magenta please',
    );
    expect(result).toEqual([
      {
        question: 'Pick a color',
        answer: 'Other',
        additional: 'Magenta please',
      },
    ]);
  });

  it('handles an empty selection with only free-form text', () => {
    const result = parseAnsweredQuestions(
      input([{ question: 'Anything else?' }]),
      'Q: Anything else?\nA: \nAdditional: Just this',
    );
    expect(result).toEqual([
      { question: 'Anything else?', answer: '', additional: 'Just this' },
    ]);
  });

  it('parses several questions in order', () => {
    const result = parseAnsweredQuestions(
      input([
        { question: 'Q one' },
        { question: 'Q two' },
        { question: 'Q three' },
      ]),
      'Q: Q one\nA: A1\n\nQ: Q two\nA: A2\nAdditional: note\n\nQ: Q three\nA: A3',
    );
    expect(result).toEqual([
      { question: 'Q one', answer: 'A1' },
      { question: 'Q two', answer: 'A2', additional: 'note' },
      { question: 'Q three', answer: 'A3' },
    ]);
  });

  it('handles multi-line question text via exact-string anchoring', () => {
    const question = 'Line one\n\nLine two';
    const result = parseAnsweredQuestions(
      input([{ question }, { question: 'Second' }]),
      `Q: ${question}\nA: Yes\n\nQ: Second\nA: No`,
    );
    expect(result).toEqual([
      { question, answer: 'Yes' },
      { question: 'Second', answer: 'No' },
    ]);
  });

  it('preserves multi-line free-form Additional text', () => {
    const result = parseAnsweredQuestions(
      input([{ question: 'Notes?' }]),
      'Q: Notes?\nA: Other\nAdditional: First paragraph\n\nSecond paragraph',
    );
    expect(result).toEqual([
      {
        question: 'Notes?',
        answer: 'Other',
        additional: 'First paragraph\n\nSecond paragraph',
      },
    ]);
  });

  it('returns null when the tool input is not valid JSON', () => {
    expect(parseAnsweredQuestions('not json', 'Q: x\nA: y')).toBeNull();
  });

  it('returns null when there are no questions', () => {
    expect(parseAnsweredQuestions(input([]), '')).toBeNull();
  });

  it('returns null when the output does not match the questions', () => {
    expect(
      parseAnsweredQuestions(
        input([{ question: 'Pick a color' }]),
        'Some unrelated tool output',
      ),
    ).toBeNull();
  });
});

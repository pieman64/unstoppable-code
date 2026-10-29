import { validateQuestionControlAnswers } from '../portal';
import type { PortalAskUserQuestion } from '../portal';

describe('interactive question validation', () => {
  it.each<[PortalAskUserQuestion, string[], string | undefined]>([
    [
      { question: 'Required', options: [], control: 'text', required: true },
      [],
      '  ',
    ],
    [{ question: 'Count', options: [], control: 'number' }, [], 'Infinity'],
    [{ question: 'Count', options: [], control: 'number' }, [], '0xff'],
    [{ question: 'Day', options: [], control: 'date' }, [], '2026-02-30'],
    [
      { question: 'Choice', options: ['A'], control: 'select' },
      ['B'],
      undefined,
    ],
    [
      { question: 'Choice', options: ['A', 'B'], control: 'buttons' },
      ['A', 'B'],
      undefined,
    ],
    [
      {
        question: 'Choice',
        options: ['A'],
        control: 'select',
        allowOther: false,
      },
      [],
      'Typed',
    ],
    [
      { question: 'Name', options: [], control: 'text' },
      ['Unexpected'],
      undefined,
    ],
  ])(
    'rejects invalid values for %j',
    (question, selectedOptions, freeformText) => {
      expect(
        validateQuestionControlAnswers(
          [question],
          [{ question: question.question, selectedOptions, freeformText }],
        ),
      ).toBeDefined();
    },
  );

  it.each<[PortalAskUserQuestion, string[], string | undefined]>([
    [{ question: 'Optional', options: [], control: 'text' }, [], undefined],
    [{ question: 'Count', options: [], control: 'number' }, [], '-3.5e2'],
    [{ question: 'Day', options: [], control: 'date' }, [], '2028-02-29'],
    [
      {
        question: 'Choice',
        options: ['A', 'B'],
        control: 'buttons',
        multiSelect: true,
      },
      ['A', 'B'],
      undefined,
    ],
    // A typed answer stands beside the options, alone or with picks.
    [{ question: 'Choice', options: ['A'], control: 'select' }, [], 'My own'],
    [
      {
        question: 'Choice',
        options: ['A', 'B'],
        control: 'buttons',
        multiSelect: true,
      },
      ['A'],
      'And this',
    ],
  ])(
    'accepts valid values for %j',
    (question, selectedOptions, freeformText) => {
      expect(
        validateQuestionControlAnswers(
          [question],
          [{ question: question.question, selectedOptions, freeformText }],
        ),
      ).toBeUndefined();
    },
  );
});

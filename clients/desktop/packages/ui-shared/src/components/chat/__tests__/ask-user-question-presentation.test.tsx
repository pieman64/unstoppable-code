import { renderToStaticMarkup } from 'react-dom/server';
import type { PortalAskUserQuestionState } from '@canopy/protocol/portal';
import {
  askUserQuestionResultEvidence,
  matchAskUserQuestionRecord,
  portalAskUserQuestionRecordState,
  resolveAskUserQuestionPresentation,
  type AskUserQuestionRecordIdentity,
  type AskUserQuestionRecordState,
} from '../ask-user-question-presentation';
import {
  askUserQuestionAnswerSummary,
  askUserQuestionCount,
  askUserQuestionRowLabel,
} from '../tool-display';
import type { AnsweredQuestionDisplay } from '../AskUserQuestionCard';

interface TestRecord {
  id: string;
  toolUseId?: string;
  texts: string[];
}

const identify = (record: TestRecord): AskUserQuestionRecordIdentity => ({
  toolUseId: record.toolUseId,
  questionTexts: record.texts,
});

const RECORD_ANSWERS: AnsweredQuestionDisplay[] = [
  { question: 'Rounding?', answer: "Half-even (banker's rounding)" },
];
const RESULT_ANSWERS: AnsweredQuestionDisplay[] = [
  { question: 'Rounding?', answer: 'Half-up' },
];

const NONE: AskUserQuestionRecordState<TestRecord> = { kind: 'none' };
const ANSWERED: AskUserQuestionRecordState<TestRecord> = {
  kind: 'answered',
  answers: RECORD_ANSWERS,
};
const ANSWERED_EMPTY: AskUserQuestionRecordState<TestRecord> = {
  kind: 'answered',
  answers: [],
};
const DISMISSED: AskUserQuestionRecordState<TestRecord> = {
  kind: 'dismissed',
};
const UNANSWERED_RECORD: TestRecord = { id: 'live', texts: ['Rounding?'] };
const UNANSWERED: AskUserQuestionRecordState<TestRecord> = {
  kind: 'unanswered',
  record: UNANSWERED_RECORD,
};

function labelText(
  count: number,
  answers?: readonly AnsweredQuestionDisplay[],
): string {
  return renderToStaticMarkup(
    <>{askUserQuestionRowLabel({ count, answers })}</>,
  ).replace(/<[^>]+>/g, '');
}

describe('matchAskUserQuestionRecord', () => {
  it('prefers an exact tool-use id', () => {
    const byText: TestRecord = { id: 'text', texts: ['Pick'] };
    const exact: TestRecord = { id: 'exact', toolUseId: 'toolu_1', texts: [] };
    expect(
      matchAskUserQuestionRecord([byText, exact], identify, {
        toolUseId: 'toolu_1',
        questionTexts: ['Pick'],
        requireExactToolUseId: false,
      }),
    ).toBe(exact);
  });

  it('never falls back for Codex rows', () => {
    const idless: TestRecord = { id: 'idless', texts: ['Pick'] };
    expect(
      matchAskUserQuestionRecord([idless], identify, {
        toolUseId: 'codex-call-missing',
        questionTexts: ['Pick'],
        requireExactToolUseId: true,
      }),
    ).toBeUndefined();
  });

  it('falls back to identical ordered text only for records without an id', () => {
    const otherId: TestRecord = {
      id: 'other',
      toolUseId: 'toolu_other',
      texts: ['Pick', 'Then'],
    };
    const idless: TestRecord = { id: 'idless', texts: ['Pick', 'Then'] };
    expect(
      matchAskUserQuestionRecord([otherId, idless], identify, {
        toolUseId: 'toolu_mine',
        questionTexts: ['Pick', 'Then'],
        requireExactToolUseId: false,
      }),
    ).toBe(idless);
    expect(
      matchAskUserQuestionRecord([otherId], identify, {
        toolUseId: 'toolu_mine',
        questionTexts: ['Pick', 'Then'],
        requireExactToolUseId: false,
      }),
    ).toBeUndefined();
  });

  it('rejects a different or reordered question text', () => {
    const idless: TestRecord = { id: 'idless', texts: ['Pick', 'Then'] };
    for (const questionTexts of [['Then', 'Pick'], ['Pick'], ['Other']]) {
      expect(
        matchAskUserQuestionRecord([idless], identify, {
          questionTexts,
          requireExactToolUseId: false,
        }),
      ).toBeUndefined();
    }
  });

  it('attaches nothing when the input has no parseable questions', () => {
    const idless: TestRecord = { id: 'idless', texts: ['Pick'] };
    expect(
      matchAskUserQuestionRecord([idless], identify, {
        toolUseId: 'toolu_1',
        requireExactToolUseId: false,
      }),
    ).toBeUndefined();
  });

  it('attaches nothing when repeated identical questions are ambiguous', () => {
    const first: TestRecord = { id: 'first', texts: ['Pick'] };
    const second: TestRecord = { id: 'second', texts: ['Pick'] };
    expect(
      matchAskUserQuestionRecord([first, second], identify, {
        toolUseId: 'toolu_1',
        questionTexts: ['Pick'],
        requireExactToolUseId: false,
      }),
    ).toBeUndefined();
  });

  it('attaches nothing when two records share one tool-use id', () => {
    const first: TestRecord = { id: 'a', toolUseId: 'codex-1', texts: [] };
    const second: TestRecord = { id: 'b', toolUseId: 'codex-1', texts: [] };
    expect(
      matchAskUserQuestionRecord([first, second], identify, {
        toolUseId: 'codex-1',
        requireExactToolUseId: true,
      }),
    ).toBeUndefined();
  });
});

describe('resolveAskUserQuestionPresentation', () => {
  it('settles an answered record with no result, without a spinner', () => {
    expect(
      resolveAskUserQuestionPresentation({ kind: 'none' }, ANSWERED),
    ).toEqual({ kind: 'answered', answers: RECORD_ANSWERS, status: 'success' });
  });

  it('settles an answered record over a synthetic Cancelled result', () => {
    expect(
      resolveAskUserQuestionPresentation({ kind: 'other' }, ANSWERED),
    ).toEqual({ kind: 'answered', answers: RECORD_ANSWERS });
  });

  it('prefers answers parsed from the result over the record', () => {
    expect(
      resolveAskUserQuestionPresentation(
        { kind: 'answers', answers: RESULT_ANSWERS },
        ANSWERED,
      ),
    ).toEqual({ kind: 'answered', answers: RESULT_ANSWERS });
  });

  it('keeps an explicit error visible even with an answered record', () => {
    expect(
      resolveAskUserQuestionPresentation({ kind: 'error' }, ANSWERED),
    ).toEqual({ kind: 'result' });
  });

  it('never hides a terminal result behind a stale unanswered record', () => {
    expect(
      resolveAskUserQuestionPresentation({ kind: 'other' }, UNANSWERED),
    ).toEqual({ kind: 'result' });
    expect(
      resolveAskUserQuestionPresentation({ kind: 'error' }, UNANSWERED),
    ).toEqual({ kind: 'result' });
    expect(
      resolveAskUserQuestionPresentation(
        { kind: 'answers', answers: RESULT_ANSWERS },
        UNANSWERED,
      ),
    ).toEqual({ kind: 'answered', answers: RESULT_ANSWERS });
  });

  it('settles dismissed and empty answered records without inventing answers', () => {
    expect(
      resolveAskUserQuestionPresentation({ kind: 'none' }, DISMISSED),
    ).toEqual({ kind: 'settled', status: 'success' });
    expect(
      resolveAskUserQuestionPresentation({ kind: 'none' }, ANSWERED_EMPTY),
    ).toEqual({ kind: 'settled', status: 'success' });
    expect(
      resolveAskUserQuestionPresentation({ kind: 'other' }, ANSWERED_EMPTY),
    ).toEqual({ kind: 'settled' });
  });

  it('settles a record whose display rows contain no answer text', () => {
    expect(
      resolveAskUserQuestionPresentation(
        { kind: 'none' },
        {
          kind: 'answered',
          answers: [{ question: 'Pick?', answer: '  ', additional: '' }],
        },
      ),
    ).toEqual({ kind: 'settled', status: 'success' });
  });

  it('hands an unanswered record without a result to its prompt', () => {
    expect(
      resolveAskUserQuestionPresentation({ kind: 'none' }, UNANSWERED),
    ).toEqual({ kind: 'awaiting', record: UNANSWERED_RECORD });
  });

  it('keeps generic results and the preparing fallback without a record', () => {
    expect(resolveAskUserQuestionPresentation({ kind: 'other' }, NONE)).toEqual(
      { kind: 'result' },
    );
    expect(resolveAskUserQuestionPresentation({ kind: 'error' }, NONE)).toEqual(
      { kind: 'result' },
    );
    expect(resolveAskUserQuestionPresentation({ kind: 'none' }, NONE)).toEqual({
      kind: 'preparing',
    });
    expect(
      resolveAskUserQuestionPresentation(
        { kind: 'answers', answers: [] },
        NONE,
      ),
    ).toEqual({ kind: 'result' });
  });
});

describe('askUserQuestionResultEvidence', () => {
  it('parses result answers before consulting stored projections', () => {
    expect(
      askUserQuestionResultEvidence(
        { kind: 'text', content: 'Q: Rounding?\nA: Half-up' },
        JSON.stringify({ questions: [{ question: 'Rounding?' }] }),
      ),
    ).toEqual({ kind: 'answers', answers: RESULT_ANSWERS });
  });

  it('redacts secret freeform in parsed results before display', () => {
    expect(
      askUserQuestionResultEvidence(
        { kind: 'text', content: 'Q: Token?\nA: \nAdditional: sk-live' },
        JSON.stringify({ questions: [{ question: 'Token?', secret: true }] }),
      ),
    ).toEqual({
      kind: 'answers',
      answers: [
        {
          question: 'Token?',
          answer: '',
          additional: '[hidden]',
          secret: true,
        },
      ],
    });
  });

  it('normalizes shared tool results', () => {
    expect(askUserQuestionResultEvidence(null)).toEqual({ kind: 'none' });
    expect(
      askUserQuestionResultEvidence({ kind: 'text', content: 'Cancelled' }),
    ).toEqual({ kind: 'other' });
    expect(
      askUserQuestionResultEvidence({ kind: 'error', content: 'Dismissed' }),
    ).toEqual({ kind: 'error' });
  });
});

describe('portalAskUserQuestionRecordState', () => {
  const answered: PortalAskUserQuestionState = {
    requestId: 'answered',
    questions: [
      { question: 'Token?', options: [], secret: true, allowOther: true },
    ],
    answered: true,
    answers: [
      { question: 'Token?', selectedOptions: [], freeformText: 'sk-live' },
    ],
  };
  const unanswered: PortalAskUserQuestionState = {
    requestId: 'live',
    questions: [{ question: 'Next?', options: ['Yes'] }],
    answered: false,
  };

  it('settles malformed stored answers without throwing or inventing text', () => {
    const malformed: PortalAskUserQuestionState = { ...answered };
    Object.defineProperty(malformed, 'answers', {
      value: [{ question: 'Token?', selectedOptions: null }],
    });
    expect(
      portalAskUserQuestionRecordState([malformed], {
        toolUseId: 'toolu_1',
        questionTexts: ['Token?'],
      }),
    ).toEqual({ kind: 'answered', answers: [] });
  });

  it('maps answered projections to display-safe answers', () => {
    const state = portalAskUserQuestionRecordState([answered, unanswered], {
      toolUseId: 'toolu_1',
      questionTexts: ['Token?'],
    });
    expect(state).toEqual({
      kind: 'answered',
      answers: [
        {
          question: 'Token?',
          answer: '',
          additional: 'sk-live',
          secret: true,
        },
      ],
    });
  });

  it.each(['canopy_ask_user_question', 'request_user_input'])(
    'requires exact identity for %s even without a Codex-prefixed id',
    (toolName) => {
      expect(
        portalAskUserQuestionRecordState([unanswered], {
          toolName,
          toolUseId: 'call_123',
          questionTexts: ['Next?'],
        }),
      ).toEqual({ kind: 'none' });
    },
  );

  it('maps unanswered projections and requires exact Codex ids', () => {
    expect(
      portalAskUserQuestionRecordState([answered, unanswered], {
        toolUseId: 'toolu_2',
        questionTexts: ['Next?'],
      }),
    ).toEqual({ kind: 'unanswered', record: unanswered });
    expect(
      portalAskUserQuestionRecordState([unanswered], {
        toolUseId: 'codex-missing',
        questionTexts: ['Next?'],
      }),
    ).toEqual({ kind: 'none' });
  });
});

describe('askUserQuestionRowLabel', () => {
  it('counts questions in the base label', () => {
    expect(labelText(1)).toBe('Asked you 1 question');
    expect(labelText(3)).toBe('Asked you 3 questions');
    expect(labelText(0)).toBe('Asked you 0 questions');
  });

  it('appends the answer summary', () => {
    expect(labelText(1, RECORD_ANSWERS)).toBe(
      'Asked you 1 question · Half-even (banker&#x27;s rounding)',
    );
  });

  it('joins multiple answers and selections in question order', () => {
    expect(
      labelText(2, [
        { question: 'A?', answer: 'Red, Blue' },
        { question: 'B?', answer: 'Large' },
      ]),
    ).toBe('Asked you 2 questions · Red, Blue, Large');
  });

  it('omits the separator when no answer summary exists', () => {
    expect(labelText(1, [{ question: 'A?', answer: '  ' }])).toBe(
      'Asked you 1 question',
    );
    expect(labelText(1, [])).toBe('Asked you 1 question');
  });

  it('truncates only the combined answer suffix', () => {
    const long = 'x'.repeat(80);
    expect(labelText(1, [{ question: 'A?', answer: long }])).toBe(
      `Asked you 1 question · ${'x'.repeat(60)}…`,
    );
  });

  it('keeps secret freeform hidden and renders answers literally', () => {
    expect(
      labelText(1, [
        { question: 'Token?', answer: '', additional: 'sk-live', secret: true },
      ]),
    ).toBe('Asked you 1 question · [hidden]');
    expect(
      renderToStaticMarkup(
        <>
          {askUserQuestionRowLabel({
            count: 1,
            answers: [{ question: 'A?', answer: '<b>bold</b>' }],
          })}
        </>,
      ),
    ).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('uses freeform text when no option was selected', () => {
    expect(
      askUserQuestionAnswerSummary([
        { question: 'A?', answer: '', additional: 'Custom' },
        { question: 'B?', answer: 'Yes', additional: 'ignored' },
      ]),
    ).toBe('Custom, Yes');
  });
});

describe('askUserQuestionCount', () => {
  it('counts serialized questions and does not fabricate a count', () => {
    expect(askUserQuestionCount(JSON.stringify({ questions: [{}, {}] }))).toBe(
      2,
    );
    expect(askUserQuestionCount('{not json')).toBe(0);
    expect(askUserQuestionCount(JSON.stringify({ questions: 'x' }))).toBe(0);
    expect(askUserQuestionCount(undefined)).toBe(0);
  });
});

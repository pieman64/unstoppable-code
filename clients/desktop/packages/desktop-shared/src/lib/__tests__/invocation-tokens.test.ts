import {
  extractInvocationTokens,
  extractPipelineReferenceTokens,
  isPathShapedInvocationToken,
} from '../invocation-tokens';

describe('pipeline invocation tokens', () => {
  it.each([
    ['/collect.py', true],
    ['/quality-control-structural-v2.json', true],
    ['/quality-control-structural-report.md', true],
    ['/usr/bin/env', true],
    ['OUT=/tmp/x', true],
    ['./scripts/run', true],
    ['~/bin/run', true],
    ['$HOME/bin', true],
    ['`/review-tests`', false],
    ['"/review-tests"', false],
    ['/foo.v2', true],
  ])('classifies %s after extraction', (value, pathShaped) => {
    const tokens = extractInvocationTokens(value);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every(isPathShapedInvocationToken)).toBe(pathShaped);
  });

  it('strips sentence punctuation and ignores URL path fragments', () => {
    expect(extractInvocationTokens('See /notes.md.')).toEqual([
      expect.objectContaining({ value: '/notes.md' }),
    ]);
    expect(extractInvocationTokens('See https://example.test/path.')).toEqual(
      [],
    );
  });

  it('extracts every segment of a deeply nested command', () => {
    expect(extractInvocationTokens('Run /a:b:c now.')).toEqual([
      expect.objectContaining({ value: '/a:b:c' }),
    ]);
  });

  it('records the offset of each token', () => {
    const text = 'Run /a then $b.';
    expect(extractInvocationTokens(text)).toEqual([
      expect.objectContaining({ value: '/a', start: 4 }),
      expect.objectContaining({ value: '$b', start: 12 }),
    ]);
  });
});

const PIPELINE_ID = '3f2b8c1e-9d4a-4e6b-8f1c-2a7d5e9b0c13';

describe('pipeline reference tokens', () => {
  it.each([
    ['at the start', `${PIPELINE_ID} runs first`, 0],
    ['at the end', `Run ${PIPELINE_ID}`, 4],
    ['next to punctuation', `Run (${PIPELINE_ID}).`, 5],
    ['inside quotes', `pipeline: "${PIPELINE_ID}"`, 11],
    ['after a colon', `id:${PIPELINE_ID},`, 3],
  ])('finds a UUID %s', (_label, text, start) => {
    expect(extractPipelineReferenceTokens(text, [])).toEqual([
      { kind: 'uuid', text: PIPELINE_ID, start },
    ]);
  });

  it('matches an upper-case UUID and keeps the exact slice', () => {
    const upper = PIPELINE_ID.toUpperCase();
    expect(extractPipelineReferenceTokens(`Run ${upper} now`, [])).toEqual([
      { kind: 'uuid', text: upper, start: 4 },
    ]);
  });

  it('ignores UUID-shaped runs glued to a longer identifier', () => {
    expect(
      extractPipelineReferenceTokens(
        `x${PIPELINE_ID} ${PIPELINE_ID}0 run-${PIPELINE_ID} ${PIPELINE_ID}_v2`,
        [],
      ),
    ).toEqual([]);
  });

  it('reports offsets in UTF-16 code units after an emoji', () => {
    const text = `\u{1F680} Launch ${PIPELINE_ID} and Nightly build`;
    const tokens = extractPipelineReferenceTokens(text, ['Nightly build']);
    expect(tokens).toEqual([
      { kind: 'uuid', text: PIPELINE_ID, start: 10 },
      { kind: 'name', text: 'Nightly build', start: 51 },
    ]);
    for (const token of tokens) {
      expect(text.slice(token.start, token.start + token.text.length)).toBe(
        token.text,
      );
    }
  });

  it('matches exact names case-sensitively as whole words', () => {
    expect(
      extractPipelineReferenceTokens(
        'Deploy, then Deployment, then deploy, then Deploy',
        ['Deploy'],
      ),
    ).toEqual([
      { kind: 'name', text: 'Deploy', start: 0 },
      { kind: 'name', text: 'Deploy', start: 43 },
    ]);
  });

  it('escapes regular expression metacharacters in names', () => {
    const name = 'Build (prod) [v1.2]+*?';
    expect(
      extractPipelineReferenceTokens(`Run ${name} and Build (prod) [v1x2]`, [
        name,
      ]),
    ).toEqual([{ kind: 'name', text: name, start: 4 }]);
  });

  it('does not match a name inside a longer word', () => {
    expect(
      extractPipelineReferenceTokens('Run Nightlyish and preNightly', [
        'Nightly',
      ]),
    ).toEqual([]);
  });

  it('returns only UUIDs when no names are given', () => {
    expect(
      extractPipelineReferenceTokens(`Nightly ${PIPELINE_ID}`, []),
    ).toEqual([{ kind: 'uuid', text: PIPELINE_ID, start: 8 }]);
  });

  it('skips blank names', () => {
    expect(extractPipelineReferenceTokens('a b', ['', '  '])).toEqual([]);
  });
});

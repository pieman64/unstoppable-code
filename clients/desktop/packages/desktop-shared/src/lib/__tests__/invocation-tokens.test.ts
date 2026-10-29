import {
  extractInvocationTokens,
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
});

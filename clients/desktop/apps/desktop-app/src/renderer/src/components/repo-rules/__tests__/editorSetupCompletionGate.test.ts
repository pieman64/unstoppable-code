import {
  activeOfferMemberIds,
  evaluateEditorSetupGate,
  mergeRepoRulesOffer,
  withRepoRulesDecision,
} from '../editorSetupCompletionGate';

const ELIGIBLE = new Set(['a', 'b', 'c']);

describe('evaluateEditorSetupGate', () => {
  it('stays pending until every remaining member has a decision', () => {
    const offer = mergeRepoRulesOffer(null, ['a', 'b']);
    expect(evaluateEditorSetupGate(offer, ELIGIBLE)).toBe('pending');
    const partial = withRepoRulesDecision(offer, 'a', 'on');
    expect(evaluateEditorSetupGate(partial, ELIGIBLE)).toBe('pending');
    const resolved = withRepoRulesDecision(partial, 'b', 'skipped');
    expect(evaluateEditorSetupGate(resolved, ELIGIBLE)).toBe('resolved');
  });

  it('resolves an offer that was entirely skipped or turned off', () => {
    let offer = mergeRepoRulesOffer(null, ['a', 'b']);
    offer = withRepoRulesDecision(offer, 'a', 'skipped');
    offer = withRepoRulesDecision(offer, 'b', 'off');
    expect(evaluateEditorSetupGate(offer, ELIGIBLE)).toBe('resolved');
  });

  it('abandons rather than resolves an empty or fully removed offer', () => {
    expect(
      evaluateEditorSetupGate(mergeRepoRulesOffer(null, []), ELIGIBLE),
    ).toBe('abandoned');
    const decided = withRepoRulesDecision(
      mergeRepoRulesOffer(null, ['gone']),
      'gone',
      'on',
    );
    expect(evaluateEditorSetupGate(decided, ELIGIBLE)).toBe('abandoned');
  });

  it('lets removed members stop blocking but never counts their decisions', () => {
    const offer = withRepoRulesDecision(
      mergeRepoRulesOffer(null, ['a', 'gone']),
      'gone',
      'on',
    );
    expect(evaluateEditorSetupGate(offer, ELIGIBLE)).toBe('pending');
    expect(activeOfferMemberIds(offer, ELIGIBLE)).toEqual(['a']);
    const resolved = withRepoRulesDecision(offer, 'a', 'off');
    expect(evaluateEditorSetupGate(resolved, ELIGIBLE)).toBe('resolved');
  });

  it('ignores decisions for unrelated projects', () => {
    const offer = mergeRepoRulesOffer(null, ['a']);
    const unrelated = withRepoRulesDecision(offer, 'c', 'on');
    expect(unrelated).toBe(offer);
    expect(evaluateEditorSetupGate(unrelated, ELIGIBLE)).toBe('pending');
  });
});

describe('mergeRepoRulesOffer', () => {
  it('deduplicates members and keeps earlier decisions through a merge', () => {
    const first = withRepoRulesDecision(
      mergeRepoRulesOffer(null, ['a', 'a', 'b']),
      'a',
      'skipped',
    );
    expect(first.memberIds).toEqual(['a', 'b']);
    const merged = mergeRepoRulesOffer(first, ['b', 'c']);
    expect(merged.memberIds).toEqual(['a', 'b', 'c']);
    expect(merged.decisions).toEqual({ a: 'skipped' });
  });
});

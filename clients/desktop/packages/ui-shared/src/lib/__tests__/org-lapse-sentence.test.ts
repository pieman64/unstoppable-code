// Copy helpers for the `teams` lapse surfaces (CAN-2311).
//
// These are pure string builders, but they are the shared source of truth for
// wording that appears on several surfaces at once (the composer's lapse
// banner, the Remote Control upgrade CTA, the share-run refusal), so the
// singular/plural boundaries are pinned here rather than left to each caller.

import {
  formatOrgNameList,
  orgsWithoutActivePlanClause,
  orgsWithoutActivePlanSentence,
} from '../org-lapse-sentence';

describe('formatOrgNameList', () => {
  it.each([
    [[], ''],
    [['Acme'], 'Acme'],
    [['Acme', 'Initech'], 'Acme and Initech'],
    [['Acme', 'Initech', 'Globex'], 'Acme, Initech and Globex'],
    [['Acme', 'Initech', 'Globex', 'Hooli'], 'Acme, Initech, Globex and Hooli'],
  ])('formats %j as %j', (names, expected) => {
    expect(formatOrgNameList(names)).toBe(expected);
  });

  it('never emits a trailing bare comma before the last name', () => {
    // The regression this guards: a plain `join(', ')`, which is what every
    // caller reached for before this helper existed.
    expect(formatOrgNameList(['Acme', 'Initech'])).not.toBe('Acme, Initech');
  });
});

describe('orgsWithoutActivePlanClause', () => {
  it('returns an empty string for no orgs, so callers render nothing', () => {
    expect(orgsWithoutActivePlanClause([])).toBe('');
  });

  it('agrees in the singular for one org', () => {
    expect(orgsWithoutActivePlanClause(['Acme'])).toBe(
      'Acme has no active plan',
    );
  });

  it.each([
    [['Acme', 'Initech'], 'Acme and Initech have no active plan'],
    [
      ['Acme', 'Initech', 'Globex'],
      'Acme, Initech and Globex have no active plan',
    ],
  ])('agrees in the plural for %j', (names, expected) => {
    expect(orgsWithoutActivePlanClause(names)).toBe(expected);
  });

  it('carries no terminal punctuation, so callers can embed it mid-sentence', () => {
    // The Remote Control paywall renders it as a subordinate clause:
    // "This feature requires Pro, and Acme has no active plan to cover it."
    // A trailing period baked in here would split that into two sentences.
    expect(orgsWithoutActivePlanClause(['Acme'])).not.toMatch(/[.,]$/);
    expect(orgsWithoutActivePlanClause(['Acme', 'Initech'])).not.toMatch(
      /[.,]$/,
    );
  });

  it('states only that the org has no plan, never that it took something away', () => {
    // CAN-2311: the renderer cannot tell whether the lapsed org was ever the
    // source of THIS user's coverage, so the shared phrasing must stay a
    // present-tense fact about the org.
    const clause = orgsWithoutActivePlanClause(['Acme', 'Initech']);
    expect(clause).not.toMatch(/on hold/i);
    expect(clause).not.toMatch(/paused/i);
    expect(clause).not.toMatch(/restore/i);
    expect(clause).not.toMatch(/lost|no longer/i);
  });

  it('shares its list formatting with formatOrgNameList', () => {
    // Pins the extraction: if the two ever diverge, one surface starts
    // punctuating org lists differently from the other.
    const names = ['Acme', 'Initech', 'Globex'];
    expect(orgsWithoutActivePlanClause(names)).toBe(
      `${formatOrgNameList(names)} have no active plan`,
    );
  });
});

describe('orgsWithoutActivePlanSentence', () => {
  it('returns an empty string for no orgs, so callers render nothing', () => {
    // Not '.', which is what naive `${clause}.` would emit for an empty list.
    expect(orgsWithoutActivePlanSentence([])).toBe('');
  });

  it.each([
    [['Acme'], 'Acme has no active plan.'],
    [['Acme', 'Initech'], 'Acme and Initech have no active plan.'],
    [
      ['Acme', 'Initech', 'Globex'],
      'Acme, Initech and Globex have no active plan.',
    ],
  ])('terminates the clause for %j', (names, expected) => {
    expect(orgsWithoutActivePlanSentence(names)).toBe(expected);
  });

  it('is the clause plus a period, so the two can never drift', () => {
    const names = ['Acme', 'Initech'];
    expect(orgsWithoutActivePlanSentence(names)).toBe(
      `${orgsWithoutActivePlanClause(names)}.`,
    );
  });
});

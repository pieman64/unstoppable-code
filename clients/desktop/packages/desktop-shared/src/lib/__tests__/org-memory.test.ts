import {
  normalizeMemoryByMessageId,
  normalizeMemorySearchOrganizationExternalIds,
  normalizeOrganizationExternalId,
  normalizeOrgMemoryFacts,
  normalizeOrgMemoryTurn,
} from '../org-memory';

const FACT_ID = '22222222-2222-4222-8222-222222222222';

describe('normalizeOrgMemoryFacts', () => {
  it('preserves factId through normalization so feedback controls can render', () => {
    const facts = normalizeOrgMemoryFacts([
      {
        factId: FACT_ID,
        factText: 'The database proxy uses port 4031.',
        validAt: '2026-07-10',
        sourceTurnIds: ['12'],
      },
    ]);
    expect(facts).toEqual([
      {
        factId: FACT_ID,
        factText: 'The database proxy uses port 4031.',
        validAt: '2026-07-10',
        sourceTurnIds: ['12'],
      },
    ]);
  });

  it('omits factId for legacy facts and rejects non-string/blank ids', () => {
    const facts = normalizeOrgMemoryFacts([
      { factText: 'Legacy fact.', validAt: null, sourceTurnIds: [] },
      { factId: 7, factText: 'Numeric id.', validAt: null, sourceTurnIds: [] },
      { factId: '  ', factText: 'Blank id.', validAt: null, sourceTurnIds: [] },
    ]);
    expect(facts).toHaveLength(3);
    for (const fact of facts) {
      expect(fact).not.toHaveProperty('factId');
    }
  });

  it('caps oversized fact ids', () => {
    const facts = normalizeOrgMemoryFacts([
      {
        factId: 'a'.repeat(200),
        factText: 'Oversized id.',
        validAt: null,
        sourceTurnIds: [],
      },
    ]);
    expect(facts[0]?.factId).toHaveLength(64);
  });

  it('retains searchId and factId across the persistence hydration path', () => {
    const hydrated = normalizeMemoryByMessageId(
      {
        'message-1': {
          searchId: '11111111-1111-4111-8111-111111111111',
          facts: [
            {
              factId: FACT_ID,
              factText: 'Persisted fact.',
              validAt: null,
              sourceTurnIds: ['turn-1'],
            },
          ],
        },
      },
      new Set(['message-1']),
    );
    expect(hydrated?.['message-1']?.facts[0]?.factId).toBe(FACT_ID);
    expect(hydrated?.['message-1']?.searchId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('retains factId through the live event turn path', () => {
    const turn = normalizeOrgMemoryTurn({
      searchId: '11111111-1111-4111-8111-111111111111',
      facts: [
        {
          factId: FACT_ID,
          factText: 'Live fact.',
          validAt: null,
          sourceTurnIds: [],
        },
      ],
    });
    expect(turn?.facts[0]?.factId).toBe(FACT_ID);
    expect(turn?.searchId).toBe('11111111-1111-4111-8111-111111111111');
  });
});

describe('normalizeOrgMemoryTurn searchId', () => {
  const fact = { factText: 'Fact.', validAt: null, sourceTurnIds: [] };

  it('retains a bounded string searchId on the turn', () => {
    const turn = normalizeOrgMemoryTurn({
      facts: [fact],
      searchId: 'a'.repeat(200),
    });
    expect(turn?.searchId).toHaveLength(64);
  });

  it('trims surrounding whitespace before persisting searchId', () => {
    const turn = normalizeOrgMemoryTurn({
      facts: [fact],
      searchId: '  search-1  ',
    });
    expect(turn?.searchId).toBe('search-1');
  });

  it('omits non-string or blank search ids', () => {
    for (const searchId of [7, '  ', null, undefined]) {
      const turn = normalizeOrgMemoryTurn({ facts: [fact], searchId });
      expect(turn).not.toBeNull();
      expect(turn).not.toHaveProperty('searchId');
    }
  });

  it('retains searchId across the persistence hydration path', () => {
    const hydrated = normalizeMemoryByMessageId(
      { 'message-1': { facts: [fact], searchId: 'search-1' } },
      new Set(['message-1']),
    );
    expect(hydrated?.['message-1']?.searchId).toBe('search-1');
  });
});

// CAN-3457: org memory searches only the org that owns the work, so the
// searched org rides on every persisted turn and the account list is strict.
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const legacyFact = { factText: 'fact', validAt: null, sourceTurnIds: [] };

describe('normalizeOrgMemoryTurn organizationExternalId', () => {
  it('keeps the searched org, lowercased', () => {
    expect(
      normalizeOrgMemoryTurn({
        organizationExternalId: ORG_A.toUpperCase(),
        searchId: 'search-1',
        facts: [legacyFact],
      }),
    ).toEqual({
      organizationExternalId: ORG_A,
      searchId: 'search-1',
      facts: [legacyFact],
    });
  });

  it.each([['org-1'], [42], ['']])(
    'drops a malformed org %p but keeps the facts',
    (organizationExternalId) => {
      const turn = normalizeOrgMemoryTurn({
        organizationExternalId,
        facts: [legacyFact],
      });
      expect(turn).not.toHaveProperty('organizationExternalId');
      expect(turn?.facts).toEqual([legacyFact]);
    },
  );

  it('keeps legacy turns without an org', () => {
    expect(normalizeOrgMemoryTurn({ facts: [legacyFact] })).toEqual({
      facts: [legacyFact],
    });
  });

  it('retains the org across the persistence hydration path', () => {
    expect(
      normalizeMemoryByMessageId({
        'message-1': { organizationExternalId: ORG_B, facts: [legacyFact] },
      }),
    ).toEqual({
      'message-1': { organizationExternalId: ORG_B, facts: [legacyFact] },
    });
  });
});

describe('normalizeOrganizationExternalId', () => {
  it('accepts UUIDs and lowercases them', () => {
    expect(normalizeOrganizationExternalId(` ${ORG_A.toUpperCase()} `)).toBe(
      ORG_A,
    );
  });

  it.each([['org-1'], [undefined], [null], [7], ['']])(
    'rejects %p',
    (value) => {
      expect(normalizeOrganizationExternalId(value)).toBeNull();
    },
  );
});

describe('normalizeMemorySearchOrganizationExternalIds', () => {
  it('normalizes the list, dropping malformed values and duplicates', () => {
    expect(
      normalizeMemorySearchOrganizationExternalIds(
        [ORG_A.toUpperCase(), 'org-1', 7, ORG_B, ORG_A],
        ORG_A,
      ),
    ).toEqual([ORG_A, ORG_B]);
  });

  it('prefers the list over the deprecated single org', () => {
    expect(
      normalizeMemorySearchOrganizationExternalIds([ORG_B], ORG_A),
    ).toEqual([ORG_B]);
    expect(normalizeMemorySearchOrganizationExternalIds([], ORG_A)).toEqual([]);
  });

  it('reads an older server’s single org as a one-entry list', () => {
    expect(
      normalizeMemorySearchOrganizationExternalIds(undefined, ORG_A),
    ).toEqual([ORG_A]);
  });

  it('is empty when neither field is usable', () => {
    expect(
      normalizeMemorySearchOrganizationExternalIds(undefined, undefined),
    ).toEqual([]);
    expect(
      normalizeMemorySearchOrganizationExternalIds('nope', 'org-1'),
    ).toEqual([]);
  });
});

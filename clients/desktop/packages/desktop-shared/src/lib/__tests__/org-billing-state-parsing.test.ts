import {
  cloneOrgBillingStates,
  isOrgTeamsLapsed,
  lapsedOrgNames,
  normalizeOrgBillingState,
  normalizeOrgBillingStates,
} from '../org-billing-state-parsing';

describe('normalizeOrgBillingState', () => {
  it('normalizes a well-formed entry', () => {
    expect(
      normalizeOrgBillingState({
        organizationId: 'org-1',
        organizationName: 'Acme',
        teamsEntitled: true,
        trialEndedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({
      organizationId: 'org-1',
      organizationName: 'Acme',
      teamsEntitled: true,
      trialEndedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('omits trialEndedAt when absent, blank, or not a string', () => {
    for (const trialEndedAt of [undefined, null, '   ', 1735689600000]) {
      const normalized = normalizeOrgBillingState({
        organizationId: 'org-1',
        organizationName: 'Acme',
        teamsEntitled: false,
        trialEndedAt,
      });
      expect(normalized).toEqual({
        organizationId: 'org-1',
        organizationName: 'Acme',
        teamsEntitled: false,
      });
      expect(normalized && 'trialEndedAt' in normalized).toBe(false);
    }
  });

  // This case used to coerce with `=== true`, which turned every malformed
  // payload into an explicit `teamsEntitled: false`. Because `isOrgTeamsLapsed`
  // treats a PRESENT entry as authoritative, that read as a real lapse and
  // locally locked a PAYING org out of telemetry, memory, sharing, and org
  // credit routing on nothing more than a truncated response or a wire-shape
  // rename. Dropping the entry is what makes "unknown ⇒ not lapsed" — this
  // module's stated contract — actually hold.
  it('drops the entry when teamsEntitled is not a literal boolean', () => {
    for (const teamsEntitled of [undefined, null, 'true', 'false', 1, 0, {}]) {
      expect(
        normalizeOrgBillingState({
          organizationId: 'org-1',
          organizationName: 'Acme',
          teamsEntitled,
        }),
      ).toBeNull();
    }
  });

  it('keeps both literal booleans, so only a well-formed false gates an org', () => {
    for (const teamsEntitled of [true, false]) {
      expect(
        normalizeOrgBillingState({
          organizationId: 'org-1',
          organizationName: 'Acme',
          teamsEntitled,
        }),
      ).toEqual({
        organizationId: 'org-1',
        organizationName: 'Acme',
        teamsEntitled,
      });
    }
  });

  it('returns null for non-records and entries missing the org id/name', () => {
    expect(normalizeOrgBillingState(null)).toBeNull();
    expect(normalizeOrgBillingState('org-1')).toBeNull();
    expect(normalizeOrgBillingState([])).toBeNull();
    expect(
      normalizeOrgBillingState({
        organizationName: 'Acme',
        teamsEntitled: true,
      }),
    ).toBeNull();
    expect(
      normalizeOrgBillingState({
        organizationId: 'org-1',
        teamsEntitled: true,
      }),
    ).toBeNull();
  });
});

describe('normalizeOrgBillingStates', () => {
  it('returns an empty list for a missing or non-array value', () => {
    expect(normalizeOrgBillingStates(undefined)).toEqual([]);
    expect(normalizeOrgBillingStates(null)).toEqual([]);
    expect(normalizeOrgBillingStates({ organizationId: 'org-1' })).toEqual([]);
    expect(normalizeOrgBillingStates('nope')).toEqual([]);
  });

  it('drops malformed entries but keeps the valid ones', () => {
    expect(
      normalizeOrgBillingStates([
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          teamsEntitled: true,
        },
        null,
        { organizationName: 'No id', teamsEntitled: false },
        {
          organizationId: 'org-2',
          organizationName: 'Lapsed Co',
          teamsEntitled: false,
          trialEndedAt: '2026-02-02T00:00:00.000Z',
        },
      ]),
    ).toEqual([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        teamsEntitled: true,
      },
      {
        organizationId: 'org-2',
        organizationName: 'Lapsed Co',
        teamsEntitled: false,
        trialEndedAt: '2026-02-02T00:00:00.000Z',
      },
    ]);
  });
});

describe('cloneOrgBillingStates', () => {
  it('deep-copies entries so a handed-out reference cannot mutate the source', () => {
    const source = [
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        teamsEntitled: true,
      },
    ];
    const cloned = cloneOrgBillingStates(source);
    cloned[0].teamsEntitled = false;
    expect(source[0].teamsEntitled).toBe(true);
    expect(cloneOrgBillingStates(undefined)).toEqual([]);
  });
});

describe('isOrgTeamsLapsed', () => {
  const states = [
    {
      organizationId: 'lapsed',
      organizationName: 'Lapsed Co',
      teamsEntitled: false,
    },
    {
      organizationId: 'healthy',
      organizationName: 'Healthy Co',
      teamsEntitled: true,
    },
  ];

  it('is true only for an explicit teamsEntitled: false entry', () => {
    expect(isOrgTeamsLapsed(states, 'lapsed')).toBe(true);
    expect(isOrgTeamsLapsed(states, 'healthy')).toBe(false);
  });

  it('fails open for unknown orgs and a missing list', () => {
    expect(isOrgTeamsLapsed(states, 'never-heard-of-it')).toBe(false);
    expect(isOrgTeamsLapsed(undefined, 'lapsed')).toBe(false);
    expect(isOrgTeamsLapsed([], 'lapsed')).toBe(false);
  });

  it('keeps a mixed lapsed + healthy membership per-org, not global', () => {
    // The load-bearing invariant: one lapsed org must never gate the other.
    expect(isOrgTeamsLapsed(states, 'healthy')).toBe(false);
    expect(isOrgTeamsLapsed(states, 'lapsed')).toBe(true);
  });
});

describe('lapsedOrgNames', () => {
  const states = [
    {
      organizationId: 'lapsed',
      organizationName: 'Lapsed Co',
      teamsEntitled: false,
    },
    {
      organizationId: 'healthy',
      organizationName: 'Healthy Co',
      teamsEntitled: true,
    },
    {
      organizationId: 'lapsed-2',
      organizationName: 'Lapsed Co',
      teamsEntitled: false,
    },
  ];

  it('names only the lapsed orgs, in the order given, deduplicated', () => {
    expect(lapsedOrgNames(states, ['healthy', 'lapsed', 'lapsed-2'])).toEqual([
      'Lapsed Co',
    ]);
  });

  it('is empty when nothing queried is lapsed', () => {
    expect(lapsedOrgNames(states, ['healthy'])).toEqual([]);
    expect(lapsedOrgNames(states, ['unknown'])).toEqual([]);
    expect(lapsedOrgNames(undefined, ['lapsed'])).toEqual([]);
  });
});

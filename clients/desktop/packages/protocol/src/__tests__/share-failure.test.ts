import {
  buildShareOrganizationAccess,
  isShareOperationResult,
  parseShareFailure,
  parseShareOrganizationAccessList,
  SHARE_FAILURE_MESSAGE_MAX_LENGTH,
} from '../sharing';

const VALID = {
  version: 1,
  kind: 'organization-plan',
  stage: 'publish',
  message: 'Acme has no active plan.',
  commitState: 'not-committed',
  retryable: false,
  httpStatus: 403,
  serverCode: 'telemetry_scope_prohibited',
  organizationId: 'org_1',
};

describe('parseShareFailure', () => {
  it('accepts a well-formed failure', () => {
    expect(parseShareFailure(VALID)).toEqual(VALID);
  });

  it('rejects unknown kinds and stages so older clients stay generic', () => {
    expect(parseShareFailure({ ...VALID, kind: 'quota' })).toBeUndefined();
    expect(parseShareFailure({ ...VALID, stage: 'verify' })).toBeUndefined();
    expect(
      parseShareFailure({ ...VALID, commitState: 'maybe' }),
    ).toBeUndefined();
    expect(parseShareFailure({ ...VALID, version: 2 })).toBeUndefined();
    expect(parseShareFailure('failed')).toBeUndefined();
    expect(parseShareFailure(null)).toBeUndefined();
  });

  it('truncates long messages instead of rejecting them', () => {
    const parsed = parseShareFailure({ ...VALID, message: 'x'.repeat(1000) });
    expect(parsed?.message).toHaveLength(SHARE_FAILURE_MESSAGE_MAX_LENGTH);
  });

  it('drops malformed optional fields', () => {
    const parsed = parseShareFailure({
      ...VALID,
      httpStatus: 'forbidden',
      serverCode: '',
      retryAfterMs: -5,
      requestId: 42,
    });
    expect(parsed).toEqual({
      version: 1,
      kind: 'organization-plan',
      stage: 'publish',
      message: 'Acme has no active plan.',
      commitState: 'not-committed',
      retryable: false,
      organizationId: 'org_1',
    });
  });

  it('keeps a known server reason and drops an unknown one', () => {
    expect(
      parseShareFailure({
        ...VALID,
        kind: 'permission',
        reason: 'publisher_role_required',
      })?.reason,
    ).toBe('publisher_role_required');
    const unknownReason = parseShareFailure({ ...VALID, reason: 'quota' });
    expect(unknownReason).toBeDefined();
    expect(unknownReason).not.toHaveProperty('reason');
  });
});

describe('isShareOperationResult', () => {
  it('recognizes success and parsed failure envelopes', () => {
    expect(isShareOperationResult({ ok: true, value: { id: 's1' } })).toBe(
      true,
    );
    expect(isShareOperationResult({ ok: false, failure: VALID })).toBe(true);
  });

  it('rejects raw details and malformed failures', () => {
    expect(isShareOperationResult({ id: 's1' })).toBe(false);
    expect(isShareOperationResult({ ok: true })).toBe(false);
    expect(
      isShareOperationResult({ ok: false, failure: { kind: 'unknown' } }),
    ).toBe(false);
  });
});

describe('parseShareOrganizationAccessList', () => {
  it('keeps valid entries and drops malformed ones', () => {
    expect(
      parseShareOrganizationAccessList([
        {
          organizationId: 'org_1',
          organizationName: 'Acme',
          teamsEntitled: false,
          canChoosePlan: true,
        },
        { organizationId: 'org_2', teamsEntitled: 'yes' },
        { organizationName: 'No id' },
        'bad',
      ]),
    ).toEqual([
      {
        organizationId: 'org_1',
        organizationName: 'Acme',
        teamsEntitled: false,
        canChoosePlan: true,
      },
      { organizationId: 'org_2' },
    ]);
    expect(parseShareOrganizationAccessList(undefined)).toBeUndefined();
  });
});

describe('buildShareOrganizationAccess', () => {
  it('reads entitlement from billing states and leaves missing ones unknown', () => {
    expect(
      buildShareOrganizationAccess(
        [
          { id: 'org_1', name: 'Acme', role: 'OWNER' },
          { id: 'org_2', name: 'Beta', role: 'ADMIN' },
          { id: 'org_3', name: 'Gamma' },
        ],
        [
          {
            organizationId: 'org_1',
            organizationName: 'Acme',
            teamsEntitled: false,
          },
          {
            organizationId: 'org_2',
            organizationName: 'Beta',
            teamsEntitled: true,
          },
        ],
      ),
    ).toEqual([
      {
        organizationId: 'org_1',
        organizationName: 'Acme',
        teamsEntitled: false,
        canChoosePlan: true,
      },
      {
        organizationId: 'org_2',
        organizationName: 'Beta',
        teamsEntitled: true,
        canChoosePlan: false,
      },
      { organizationId: 'org_3', organizationName: 'Gamma' },
    ]);
  });

  it('keeps a billing state for an organization the list omits', () => {
    expect(
      buildShareOrganizationAccess(
        [],
        [
          {
            organizationId: 'org_9',
            organizationName: 'Zeta',
            teamsEntitled: false,
          },
        ],
      ),
    ).toEqual([
      {
        organizationId: 'org_9',
        organizationName: 'Zeta',
        teamsEntitled: false,
      },
    ]);
  });
});

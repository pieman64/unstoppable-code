import type {
  CanopyCloudAccountPublicState,
  CanopyOrganizationSummary,
  CanopyTeamSummary,
} from '@canopy/desktop-shared/types';
import {
  TELEMETRY_BULK_LABELS,
  TELEMETRY_SCOPE_LABELS,
  TELEMETRY_SCOPE_DESCRIPTIONS,
  TELEMETRY_SCOPE_ORDER,
  resolveAvailableTelemetryScopes,
  resolveTelemetryScopeDescriptions,
} from '../telemetry-sharing';

const ORG: CanopyOrganizationSummary = {
  id: 'org-1',
  name: 'Acme',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const TEAM: CanopyTeamSummary = {
  id: 'team-1',
  name: 'Platform',
  organization: ORG,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function makeAccount(
  overrides: Partial<CanopyCloudAccountPublicState>,
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: null,
    credentialSource: null,
    capabilities: [],
    storageAvailable: true,
    ...overrides,
  };
}

describe('resolveAvailableTelemetryScopes', () => {
  it('offers only off / private when unlinked', () => {
    expect(resolveAvailableTelemetryScopes(null)).toEqual(['off', 'private']);
  });

  it('adds organization only when the account belongs to one', () => {
    expect(
      resolveAvailableTelemetryScopes(makeAccount({ organizations: [ORG] })),
    ).toEqual(['off', 'private', 'organization']);
  });

  it('never offers team, even when the account has team memberships', () => {
    const scopes = resolveAvailableTelemetryScopes(
      makeAccount({ teams: [TEAM], organizations: [ORG] }),
    );
    expect(scopes).not.toContain('team');
    expect(scopes).toEqual(['off', 'private', 'organization']);
  });

  it('does not surface organization from a team-only membership', () => {
    // A team carries a parent org, but team-only accounts must not unlock the
    // organization scope — only an explicit organization membership does.
    expect(
      resolveAvailableTelemetryScopes(makeAccount({ teams: [TEAM] })),
    ).toEqual(['off', 'private']);
  });
});

describe('telemetry scope labels', () => {
  it('labels private as "Just me"', () => {
    expect(TELEMETRY_SCOPE_LABELS.private).toBe('Just me');
    expect(TELEMETRY_BULK_LABELS.private).toBe('Just me');
  });

  it('retains team in the canonical order as a read-only fallback', () => {
    // team plumbing is kept: a value persisted before the UI simplification
    // must still render in its canonical slot even though it is never offered.
    expect(TELEMETRY_SCOPE_ORDER).toContain('team');
  });
});

describe('resolveTelemetryScopeDescriptions', () => {
  const ACME_ID = '5a5a5a5a-2222-4222-8222-5a5a5a5a5a5a';
  const ORGANIZATIONS = [
    { id: ACME_ID, name: 'Acme', role: 'MEMBER' as const },
  ];

  // CAN-3561: Off stops this data being shared, but basic usage (chat turns
  // sent) is still counted, so the tooltip must not claim nothing uploads.
  it('describes Off as not shared, in Personal and in an organization', () => {
    const expected = 'Not shared. This data stays on your machine.';
    expect(TELEMETRY_SCOPE_DESCRIPTIONS.off).toBe(expected);
    expect(
      resolveTelemetryScopeDescriptions({ kind: 'personal' }, ORGANIZATIONS)
        .off,
    ).toBe(expected);
    expect(
      resolveTelemetryScopeDescriptions(
        { kind: 'organization', organizationId: ACME_ID },
        ORGANIZATIONS,
      ).off,
    ).toBe(expected);
  });

  it('names the selected org on the Organization choice', () => {
    const descriptions = resolveTelemetryScopeDescriptions(
      { kind: 'organization', organizationId: ACME_ID },
      ORGANIZATIONS,
    );
    expect(descriptions.organization).toBe(
      'Uploaded and visible to everyone in Acme.',
    );
    expect(descriptions.private).toBe(TELEMETRY_SCOPE_DESCRIPTIONS.private);
  });

  it('says Personal work stays private in Personal', () => {
    expect(
      resolveTelemetryScopeDescriptions({ kind: 'personal' }, ORGANIZATIONS)
        .organization,
    ).toBe(
      'Applies when you work in an organization. Personal work stays private.',
    );
  });

  it('falls back to the generic copy when the selected org is not listed yet', () => {
    expect(
      resolveTelemetryScopeDescriptions(
        { kind: 'organization', organizationId: ACME_ID },
        [],
      ).organization,
    ).toBe(TELEMETRY_SCOPE_DESCRIPTIONS.organization);
  });
});

import type {
  CanopyCloudAccountPublicState,
  TelemetrySharingPreferences,
} from '@canopy/desktop-shared/types';
import type { TelemetryEnforcedScopeMap } from '@canopy/protocol';
import {
  dataSharingOptInDisclosureKey,
  resolveDataSharingOptIn,
  resolveOrgMemoryOptInOrganization,
  scopeReachesOrganization,
  type ResolveDataSharingOptInInput,
} from '../dataSharingOptIn';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const PRIVATE: TelemetrySharingPreferences = {
  metadata: 'private',
  plans: 'private',
  summaries: 'private',
  transcripts: 'private',
};

function account(
  overrides: Partial<CanopyCloudAccountPublicState> = {},
): CanopyCloudAccountPublicState {
  return {
    read: 'ok',
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: null,
    capabilities: [],
    account: {
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.test',
      role: 'DEVELOPER',
    },
    organizations: [
      { id: ORG, name: 'Acme' },
      { id: OTHER, name: 'Other' },
    ],
    enforcedSettings: [],
    ...overrides,
  };
}

function policy(
  organizationId: string,
  scopes: Partial<TelemetryEnforcedScopeMap>,
  prohibitedScopes: Partial<TelemetryEnforcedScopeMap> = {},
): NonNullable<CanopyCloudAccountPublicState['enforcedSettings']>[number] {
  return {
    organizationId,
    organizationName: organizationId === ORG ? 'Acme' : 'Other',
    policies: [{ kind: 'telemetry-sync', scopes, prohibitedScopes }],
  };
}

function resolve(
  overrides: Partial<ResolveDataSharingOptInInput> & {
    sharing?: TelemetrySharingPreferences;
    dismissed?: boolean;
  } = {},
): ReturnType<typeof resolveDataSharingOptIn> {
  const { sharing = PRIVATE, dismissed = false, ...rest } = overrides;
  return resolveDataSharingOptIn({
    feature: 'leaderboards',
    organizationId: ORG,
    passive: true,
    account: { status: 'ready', value: account() },
    preferences: {
      status: 'ready',
      value: {
        telemetrySharing: sharing,
        ...(dismissed
          ? {
              dataSharingOptInHints: {
                leaderboards: { dismissedAt: '2026-10-01T00:00:00.000Z' },
              },
            }
          : {}),
      },
    },
    ...rest,
  });
}

describe('resolveDataSharingOptIn', () => {
  it('keeps loading distinct from unavailable', () => {
    expect(resolve({ account: { status: 'loading' } }).kind).toBe('loading');
    expect(resolve({ preferences: { status: 'loading' } }).kind).toBe(
      'loading',
    );
    expect(resolve({ account: { status: 'error' } }).kind).toBe('unavailable');
    expect(resolve({ preferences: { status: 'error' } }).kind).toBe(
      'unavailable',
    );
  });

  it.each([
    ['an inconclusive account read', account({ read: 'error' })],
    ['a signed-out account', account({ hasApiKey: false })],
    ['a missing account identity', account({ account: undefined })],
    ['a missing policy snapshot', account({ enforcedSettings: undefined })],
    [
      'an unusable policy snapshot',
      account({ telemetryEnforcementUnavailable: true }),
    ],
    ['a non-member organization', account({ organizations: [] })],
  ])('is unavailable for %s', (_label, value) => {
    expect(resolve({ account: { status: 'ready', value } }).kind).toBe(
      'unavailable',
    );
  });

  it('is unavailable without an organization', () => {
    expect(resolve({ organizationId: null }).kind).toBe('unavailable');
    expect(resolve({ organizationId: 'not-a-uuid' }).kind).toBe('unavailable');
  });

  it('offers the feature scopes with the organization name', () => {
    expect(resolve()).toEqual({
      kind: 'needs-opt-in',
      audience: 'organization',
      organizationId: ORG,
      organizationName: 'Acme',
      allowedScopes: ['metadata', 'plans'],
      skippedScopes: [],
      additionalScopes: [],
    });
  });

  it('normalizes the organization id it is given', () => {
    const result = resolve({ organizationId: ORG.toUpperCase() });
    expect(result.kind === 'needs-opt-in' && result.organizationId).toBe(ORG);
  });

  it('shows managed when the organization prohibits work stats', () => {
    const value = account({
      enforcedSettings: [policy(ORG, {}, { metadata: true })],
    });
    expect(resolve({ account: { status: 'ready', value } })).toEqual({
      kind: 'managed',
      organizationId: ORG,
      organizationName: 'Acme',
    });
  });

  it('skips a prohibited scope and offers the rest', () => {
    const value = account({
      enforcedSettings: [policy(ORG, {}, { plans: true })],
    });
    const result = resolve({ account: { status: 'ready', value } });
    expect(result).toMatchObject({
      kind: 'needs-opt-in',
      allowedScopes: ['metadata'],
      skippedScopes: ['plans'],
    });
  });

  it('explains, rather than offers, a gap that only policy causes', () => {
    const value = account({
      enforcedSettings: [policy(ORG, {}, { plans: true })],
    });
    const result = resolve({
      account: { status: 'ready', value },
      sharing: { ...PRIVATE, metadata: 'organization' },
    });
    expect(result.kind).toBe('managed');
  });

  it('counts team sharing and enforced requirements as already shared', () => {
    expect(
      resolve({ sharing: { ...PRIVATE, metadata: 'team', plans: 'team' } })
        .kind,
    ).toBe('shared');
    const value = account({
      enforcedSettings: [policy(ORG, { metadata: true, plans: true })],
    });
    expect(resolve({ account: { status: 'ready', value } }).kind).toBe(
      'shared',
    );
  });

  it('honors a saved dismissal only for passive hints', () => {
    expect(resolve({ dismissed: true }).kind).toBe('dismissed');
    expect(resolve({ dismissed: true, passive: false }).kind).toBe(
      'needs-opt-in',
    );
  });

  it('discloses unchanged settings that start sharing with work stats', () => {
    const result = resolve({
      sharing: { ...PRIVATE, summaries: 'organization', transcripts: 'team' },
    });
    // Recaps already chose the organization and ride once stats do; chats
    // chose a different audience, so they stay where they were.
    expect(result).toMatchObject({
      kind: 'needs-opt-in',
      additionalScopes: ['summaries'],
    });
  });

  it('changes the disclosure key when what is shown changes', () => {
    const before = dataSharingOptInDisclosureKey(resolve());
    const value = account({
      enforcedSettings: [policy(ORG, {}, { plans: true })],
    });
    expect(
      dataSharingOptInDisclosureKey(
        resolve({ account: { status: 'ready', value } }),
      ),
    ).not.toBe(before);
    expect(dataSharingOptInDisclosureKey(resolve())).toBe(before);
  });
});

describe('resolveDataSharingOptIn for personal work', () => {
  const OFF: TelemetrySharingPreferences = {
    metadata: 'off',
    plans: 'off',
    summaries: 'off',
    transcripts: 'off',
  };
  function personal(
    overrides: Parameters<typeof resolve>[0] = {},
  ): ReturnType<typeof resolveDataSharingOptIn> {
    return resolve({
      feature: 'shared-projects',
      organizationId: null,
      passive: false,
      ...overrides,
    });
  }

  it('offers Just me for shared projects when work stats are Off', () => {
    expect(personal({ sharing: OFF })).toEqual({
      kind: 'needs-opt-in',
      audience: 'personal',
      organizationId: null,
      allowedScopes: ['metadata'],
    });
  });

  it.each(['private', 'team', 'organization'] as const)(
    'reports shared once work stats are %s',
    (metadata) => {
      expect(personal({ sharing: { ...OFF, metadata } })).toEqual({
        kind: 'shared',
        audience: 'personal',
        organizationId: null,
      });
    },
  );

  it('needs no organization policy, only a usable account', () => {
    const value = account({ organizations: [], enforcedSettings: undefined });
    expect(
      personal({ sharing: OFF, account: { status: 'ready', value } }).kind,
    ).toBe('needs-opt-in');
  });

  it.each([
    ['an inconclusive account read', account({ read: 'error' })],
    ['a key-less account', account({ hasApiKey: false })],
    ['a missing account identity', account({ account: undefined })],
  ])('is unavailable for %s', (_label, value) => {
    expect(
      personal({ sharing: OFF, account: { status: 'ready', value } }).kind,
    ).toBe('unavailable');
  });

  it('keeps loading and read errors distinct', () => {
    expect(personal({ account: { status: 'loading' } }).kind).toBe('loading');
    expect(personal({ preferences: { status: 'error' } }).kind).toBe(
      'unavailable',
    );
  });

  it('is unavailable for any other feature', () => {
    expect(personal({ feature: 'feed-activity', sharing: OFF }).kind).toBe(
      'unavailable',
    );
  });

  it('gives the personal disclosure its own key', () => {
    const key = dataSharingOptInDisclosureKey(personal({ sharing: OFF }));
    expect(key).toBe('personal|metadata');
    expect(key).not.toBe(
      dataSharingOptInDisclosureKey(
        resolve({ feature: 'shared-projects', sharing: OFF }),
      ),
    );
  });
});

describe('scopeReachesOrganization', () => {
  it('follows the delivery rules for each kind of work', () => {
    const sharing: TelemetrySharingPreferences = {
      metadata: 'organization',
      plans: 'private',
      summaries: 'organization',
      transcripts: 'team',
    };
    expect(scopeReachesOrganization(sharing, 'metadata')).toBe(true);
    expect(scopeReachesOrganization(sharing, 'plans')).toBe(false);
    expect(scopeReachesOrganization(sharing, 'summaries')).toBe(true);
    expect(scopeReachesOrganization(sharing, 'transcripts')).toBe(false);
    expect(
      scopeReachesOrganization(
        { ...sharing, metadata: 'private', plans: 'team' },
        'plans',
      ),
    ).toBe(true);
  });
});

describe('resolveOrgMemoryOptInOrganization', () => {
  it('prefers an eligible selected organization', () => {
    expect(
      resolveOrgMemoryOptInOrganization([OTHER, ORG], {
        kind: 'organization',
        organizationId: ORG,
      }),
    ).toBe(ORG);
  });

  it('falls back to the only eligible organization', () => {
    expect(resolveOrgMemoryOptInOrganization([ORG], { kind: 'personal' })).toBe(
      ORG,
    );
  });

  it('never picks one of several eligible organizations by order', () => {
    expect(
      resolveOrgMemoryOptInOrganization([ORG, OTHER], { kind: 'personal' }),
    ).toBeNull();
    expect(
      resolveOrgMemoryOptInOrganization([ORG, OTHER], {
        kind: 'organization',
        organizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    ).toBeNull();
  });
});

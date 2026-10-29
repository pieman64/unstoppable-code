import type {
  CanopyCloudAccountPublicState,
  TelemetrySharingPreferences,
} from '../types';
import {
  applyTelemetryEnforcement,
  enforcedValueForScope,
  enforcementForOrganization,
  isEmptyEnforcedScopes,
  resolveAccountWideTelemetryEnforcement,
  resolveActivityRepairSharing,
  resolveEffectiveTelemetrySharing,
  resolveTelemetryEnforcementByOrganization,
} from '../lib/telemetry-enforcement';

function accountWith(
  enforcedSettings?: CanopyCloudAccountPublicState['enforcedSettings'],
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: [],
    organizations: [],
    teams: [],
    storageAvailable: true,
    ...(enforcedSettings ? { enforcedSettings } : {}),
  };
}

const NONE = {
  transcripts: false,
  plans: false,
  metadata: false,
  summaries: false,
};

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('resolveTelemetryEnforcementByOrganization', () => {
  it('keeps separate organizations separate', () => {
    const byOrg = resolveTelemetryEnforcementByOrganization(
      accountWith([
        {
          organizationId: ORG_A,
          organizationName: 'Acme',
          policies: [
            {
              kind: 'telemetry-sync',
              scopes: { ...NONE, transcripts: true },
            },
          ],
        },
        {
          organizationId: ORG_B,
          organizationName: 'Globex',
          policies: [
            {
              kind: 'telemetry-sync',
              scopes: { ...NONE, plans: true },
            },
          ],
        },
      ]),
    );

    expect(enforcementForOrganization(byOrg, ORG_A).required).toEqual({
      ...NONE,
      transcripts: true,
    });
    expect(enforcementForOrganization(byOrg, ORG_B).required).toEqual({
      ...NONE,
      plans: true,
    });
  });

  it('lets prohibition beat requirement within one organization', () => {
    const byOrg = resolveTelemetryEnforcementByOrganization(
      accountWith([
        {
          organizationId: ORG_A,
          organizationName: 'Acme',
          policies: [
            {
              kind: 'telemetry-sync',
              scopes: { ...NONE, transcripts: true },
              prohibitedScopes: { ...NONE, transcripts: true },
            },
          ],
        },
      ]),
    );

    expect(enforcementForOrganization(byOrg, ORG_A)).toEqual({
      required: NONE,
      prohibited: { ...NONE, transcripts: true },
    });
  });

  it('normalizes ids for keys and lookups and skips invalid ids', () => {
    const byOrg = resolveTelemetryEnforcementByOrganization(
      accountWith([
        {
          organizationId: ORG_A.toUpperCase(),
          organizationName: 'Acme',
          policies: [
            {
              kind: 'telemetry-sync',
              scopes: { ...NONE, metadata: true },
            },
          ],
        },
        {
          organizationId: 'not-a-uuid',
          organizationName: 'Invalid',
          policies: [
            {
              kind: 'telemetry-sync',
              scopes: { ...NONE, plans: true },
            },
          ],
        },
      ]),
    );

    expect([...byOrg.keys()]).toEqual([ORG_A]);
    expect(enforcementForOrganization(byOrg, ORG_A).required.metadata).toBe(
      true,
    );
  });

  it('returns empty enforcement for null and unknown organizations', () => {
    const byOrg = resolveTelemetryEnforcementByOrganization(accountWith());
    expect(enforcementForOrganization(byOrg, null)).toEqual({
      required: NONE,
      prohibited: NONE,
    });
    expect(enforcementForOrganization(byOrg, ORG_B)).toEqual({
      required: NONE,
      prohibited: NONE,
    });
  });
});

// The requirement half of the legacy account-wide resolution. This union is
// retained only for recognizing values written by the old preference applier.
describe('resolveAccountWideTelemetryEnforcement — requirements', () => {
  it('returns all false for a null account', () => {
    expect(resolveAccountWideTelemetryEnforcement(null).required).toEqual(NONE);
  });

  it('returns all false when no enforced settings are present', () => {
    expect(
      resolveAccountWideTelemetryEnforcement(accountWith()).required,
    ).toEqual(NONE);
  });

  it('maps a single org telemetry-sync policy', () => {
    const account = accountWith([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: {
              transcripts: true,
              plans: false,
              metadata: true,
              summaries: false,
            },
          },
        ],
      },
    ]);

    expect(resolveAccountWideTelemetryEnforcement(account).required).toEqual({
      transcripts: true,
      plans: false,
      metadata: true,
      summaries: false,
    });
  });

  it('reads the new summaries scope', () => {
    const account = accountWith([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: {
              transcripts: false,
              plans: false,
              metadata: true,
              summaries: true,
            },
          },
        ],
      },
    ]);

    expect(
      resolveAccountWideTelemetryEnforcement(account).required.summaries,
    ).toBe(true);
  });

  it('treats an absent summaries key (older server) as unset, not prohibited', () => {
    const account = accountWith([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: { transcripts: true, plans: false, metadata: true },
          },
        ],
      },
    ]);

    const enforcement = resolveAccountWideTelemetryEnforcement(account);
    expect(enforcement.required.summaries).toBe(false);
    expect(enforcement.prohibited.summaries).toBe(false);
  });

  it('unions scopes across multiple orgs (most-sharing-wins)', () => {
    const account = accountWith([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: {
              transcripts: true,
              plans: false,
              metadata: false,
              summaries: false,
            },
          },
        ],
      },
      {
        organizationId: 'org-2',
        organizationName: 'Globex',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: {
              transcripts: false,
              plans: true,
              metadata: false,
              summaries: false,
            },
          },
        ],
      },
    ]);

    expect(resolveAccountWideTelemetryEnforcement(account).required).toEqual({
      transcripts: true,
      plans: true,
      metadata: false,
      summaries: false,
    });
  });
});

describe('resolveAccountWideTelemetryEnforcement — prohibitions', () => {
  it('returns empty maps for a null account', () => {
    const enforcement = resolveAccountWideTelemetryEnforcement(null);
    expect(enforcement.required).toEqual(NONE);
    expect(enforcement.prohibited).toEqual(NONE);
    expect(isEmptyEnforcedScopes(enforcement.required)).toBe(true);
    expect(isEmptyEnforcedScopes(enforcement.prohibited)).toBe(true);
  });

  it('ORs prohibitions across orgs', () => {
    const account = accountWith([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: {
              transcripts: false,
              plans: false,
              metadata: false,
              summaries: false,
            },
            prohibitedScopes: {
              transcripts: true,
              plans: false,
              metadata: false,
              summaries: false,
            },
          },
        ],
      },
      {
        organizationId: 'org-2',
        organizationName: 'Globex',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: {
              transcripts: false,
              plans: false,
              metadata: false,
              summaries: false,
            },
            prohibitedScopes: {
              transcripts: false,
              plans: false,
              metadata: false,
              summaries: true,
            },
          },
        ],
      },
    ]);

    expect(resolveAccountWideTelemetryEnforcement(account).prohibited).toEqual({
      transcripts: true,
      plans: false,
      metadata: false,
      summaries: true,
    });
  });

  it('lets a prohibition beat another org’s requirement', () => {
    const account = accountWith([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: {
              transcripts: true,
              plans: true,
              metadata: true,
              summaries: true,
            },
          },
        ],
      },
      {
        organizationId: 'org-2',
        organizationName: 'Globex',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: {
              transcripts: false,
              plans: false,
              metadata: false,
              summaries: false,
            },
            prohibitedScopes: {
              transcripts: true,
              plans: false,
              metadata: false,
              summaries: false,
            },
          },
        ],
      },
    ]);

    const enforcement = resolveAccountWideTelemetryEnforcement(account);
    // Disjoint: transcripts is prohibited, so it is NOT also required.
    expect(enforcement.prohibited.transcripts).toBe(true);
    expect(enforcement.required.transcripts).toBe(false);
    expect(enforcement.required.plans).toBe(true);
    expect(enforcement.required.metadata).toBe(true);
    expect(enforcement.required.summaries).toBe(true);
  });

  it('treats a single org that both requires and prohibits a scope as prohibited', () => {
    const account = accountWith([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: {
              transcripts: true,
              plans: false,
              metadata: false,
              summaries: false,
            },
            prohibitedScopes: {
              transcripts: true,
              plans: false,
              metadata: false,
              summaries: false,
            },
          },
        ],
      },
    ]);

    expect(
      resolveAccountWideTelemetryEnforcement(account).required.transcripts,
    ).toBe(false);
    expect(
      resolveAccountWideTelemetryEnforcement(account).prohibited.transcripts,
    ).toBe(true);
  });
});

describe('enforcedValueForScope', () => {
  it('pins required to organization, prohibited to off, and unset to null', () => {
    const enforcement = {
      required: { ...NONE, plans: true },
      prohibited: { ...NONE, transcripts: true },
    };
    expect(enforcedValueForScope(enforcement, 'plans')).toBe('organization');
    expect(enforcedValueForScope(enforcement, 'transcripts')).toBe('off');
    expect(enforcedValueForScope(enforcement, 'metadata')).toBeNull();
    expect(enforcedValueForScope(enforcement, 'summaries')).toBeNull();
  });
});

describe('applyTelemetryEnforcement', () => {
  const sharing: TelemetrySharingPreferences = {
    transcripts: 'organization',
    plans: 'private',
    metadata: 'organization',
    summaries: 'organization',
  };

  it('returns the same reference when nothing is enforced', () => {
    const enforcement = resolveAccountWideTelemetryEnforcement(null);
    expect(applyTelemetryEnforcement(sharing, enforcement)).toBe(sharing);
  });

  it('raises required scopes and lowers prohibited scopes', () => {
    const enforcement = {
      required: { ...NONE, plans: true },
      prohibited: { ...NONE, transcripts: true, summaries: true },
    };
    expect(applyTelemetryEnforcement(sharing, enforcement)).toEqual({
      transcripts: 'off',
      plans: 'organization',
      metadata: 'organization',
      summaries: 'off',
    });
  });

  it('leaves scopes no org has an opinion on untouched', () => {
    const enforcement = {
      required: { ...NONE },
      prohibited: { ...NONE, transcripts: true },
    };
    const result = applyTelemetryEnforcement(sharing, enforcement);
    expect(result.plans).toBe('private');
    expect(result.metadata).toBe('organization');
    expect(result.summaries).toBe('organization');
  });
});

describe('resolveEffectiveTelemetrySharing', () => {
  const sharing: TelemetrySharingPreferences = {
    metadata: 'private',
    transcripts: 'private',
    plans: 'off',
    summaries: 'private',
  };

  it('keeps the member choices when the organization enforces nothing', () => {
    expect(
      resolveEffectiveTelemetrySharing(sharing, {
        required: NONE,
        prohibited: NONE,
      }),
    ).toEqual(sharing);
  });

  it('raises metadata with a required body kind, unless metadata is prohibited', () => {
    expect(
      resolveEffectiveTelemetrySharing(sharing, {
        required: { ...NONE, transcripts: true },
        prohibited: NONE,
      }),
    ).toEqual({
      ...sharing,
      transcripts: 'organization',
      metadata: 'organization',
    });
    expect(
      resolveEffectiveTelemetrySharing(sharing, {
        required: { ...NONE, transcripts: true },
        prohibited: { ...NONE, metadata: true },
      }).metadata,
    ).toBe('off');
  });
});

describe('resolveActivityRepairSharing (CAN-3517)', () => {
  const all = (
    value: TelemetrySharingPreferences['metadata'],
  ): TelemetrySharingPreferences => ({
    metadata: value,
    transcripts: value,
    plans: value,
    summaries: value,
  });

  it('keeps activity private when the member chose Just me or Off', () => {
    expect(resolveActivityRepairSharing(all('private'))).toEqual({
      share: false,
    });
    expect(resolveActivityRepairSharing(all('off'))).toEqual({ share: false });
    // A legacy team choice never widens to the whole organization.
    expect(resolveActivityRepairSharing(all('team'))).toEqual({
      share: false,
    });
  });

  it('shares with the organization and withholds every kind not shared with it', () => {
    expect(resolveActivityRepairSharing(all('organization'))).toEqual({
      share: true,
      withheldKinds: [],
    });
    expect(
      resolveActivityRepairSharing({
        metadata: 'organization',
        transcripts: 'private',
        plans: 'organization',
        summaries: 'off',
      }),
    ).toEqual({ share: true, withheldKinds: ['transcripts', 'summaries'] });
  });
});

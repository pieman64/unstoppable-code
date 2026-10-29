import type {
  CanopyOrgEnforcedSettings,
  TelemetryEnforcedScopeMap,
} from '@canopy/protocol';
import { describeEnforcedPolicies } from '../org-enforced-consent';

function telemetryOrg(
  name: string,
  scopes: Partial<TelemetryEnforcedScopeMap>,
  prohibitedScopes?: Partial<TelemetryEnforcedScopeMap>,
): CanopyOrgEnforcedSettings {
  const required: TelemetryEnforcedScopeMap = {
    transcripts: scopes.transcripts === true,
    plans: scopes.plans === true,
    metadata: scopes.metadata === true,
    summaries: scopes.summaries === true,
  };
  return {
    organizationId: `org-${name}`,
    organizationName: name,
    policies: [
      prohibitedScopes
        ? {
            kind: 'telemetry-sync',
            scopes: required,
            prohibitedScopes: {
              transcripts: prohibitedScopes.transcripts === true,
              plans: prohibitedScopes.plans === true,
              metadata: prohibitedScopes.metadata === true,
              summaries: prohibitedScopes.summaries === true,
            },
          }
        : { kind: 'telemetry-sync', scopes: required },
    ],
  };
}

describe('describeEnforcedPolicies', () => {
  it('returns no items for null / empty / nothing-enforced input', () => {
    expect(describeEnforcedPolicies(null)).toEqual([]);
    expect(describeEnforcedPolicies(undefined)).toEqual([]);
    expect(describeEnforcedPolicies([])).toEqual([]);
    expect(describeEnforcedPolicies([telemetryOrg('Acme', {})])).toEqual([]);
  });

  it('maps required scopes to a single titled consent item with labelled details', () => {
    const items = describeEnforcedPolicies([
      telemetryOrg('Acme', { transcripts: true, metadata: true }),
    ]);
    expect(items).toEqual([
      {
        policyKind: 'telemetry-sync',
        title: 'Telemetry sync',
        // Canonical least-invasive → most-invasive order, matching every other
        // data-sharing surface rather than the order the flags happen to be read.
        details: ['Usage metadata', 'Transcripts'],
        disposition: 'required',
      },
    ]);
  });

  it('unions required scopes across multiple orgs into one item', () => {
    const items = describeEnforcedPolicies([
      telemetryOrg('Acme', { transcripts: true }),
      telemetryOrg('Globex', { plans: true }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].details).toEqual(['Plans', 'Transcripts']);
  });

  it('describes a prohibition as its own blocked item', () => {
    const items = describeEnforcedPolicies([
      telemetryOrg('Acme', { metadata: true }, { transcripts: true }),
    ]);
    expect(items).toEqual([
      {
        policyKind: 'telemetry-sync',
        title: 'Telemetry sync',
        details: ['Usage metadata'],
        disposition: 'required',
      },
      {
        policyKind: 'telemetry-sync',
        title: 'Blocked from sharing',
        details: ['Transcripts'],
        disposition: 'blocked',
      },
    ]);
  });

  it('unions prohibitions across orgs and lets prohibition beat requirement', () => {
    // Acme requires transcripts, Globex prohibits them. Resolution is
    // prohibit-wins-globally, so the consent screen must NOT list transcripts
    // under both headings and contradict itself.
    const items = describeEnforcedPolicies([
      telemetryOrg('Acme', { transcripts: true, plans: true }),
      telemetryOrg('Globex', {}, { transcripts: true, summaries: true }),
    ]);
    expect(items).toEqual([
      {
        policyKind: 'telemetry-sync',
        title: 'Telemetry sync',
        details: ['Plans'],
        disposition: 'required',
      },
      {
        policyKind: 'telemetry-sync',
        title: 'Blocked from sharing',
        details: ['Session summaries', 'Transcripts'],
        disposition: 'blocked',
      },
    ]);
  });

  it('treats an absent prohibitedScopes field as unset rather than all-prohibited', () => {
    // A policy minted by a server that predates prohibitions carries no
    // `prohibitedScopes`. Reading that as "everything is prohibited" would tell
    // a prospective member that joining blocks all their sharing, which is the
    // exact inversion the strict `=== true` reads exist to prevent.
    const items = describeEnforcedPolicies([
      telemetryOrg('Acme', { metadata: true }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].disposition).toBe('required');
  });
});

function gatewayOrg(
  name: string,
  baseUrl: string,
  enforced: boolean,
): CanopyOrgEnforcedSettings {
  return {
    organizationId: `org-${name}`,
    organizationName: name,
    policies: [
      {
        kind: 'model-gateway',
        baseUrl,
        models: [],
        enforced,
        promptCachePassthrough: true,
      },
    ],
  };
}

describe('describeEnforcedPolicies — model gateway', () => {
  it('names the endpoint a member’s traffic would be routed to', () => {
    const items = describeEnforcedPolicies([
      gatewayOrg('Acme', 'https://gateway.acme.test', false),
    ]);
    expect(items).toEqual([
      {
        policyKind: 'model-gateway',
        title: 'Model gateway',
        details: [
          'https://gateway.acme.test',
          'You can still use your other models alongside it.',
        ],
        disposition: 'required',
      },
    ]);
  });

  it('says the gateway is the only route when it is enforced', () => {
    const [item] = describeEnforcedPolicies([
      gatewayOrg('Acme', 'https://gateway.acme.test', true),
    ]);
    expect(item?.details).toContain(
      'Your agents run only through this gateway.',
    );
  });

  it('shows only the first enforced endpoint once any org enforces', () => {
    const items = describeEnforcedPolicies([
      gatewayOrg('Acme', 'https://gateway.additive.test', false),
      gatewayOrg('Beta', 'https://gateway.enforced.test', true),
      gatewayOrg('Gamma', 'https://gateway.secondary.test', true),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.details).toEqual([
      'https://gateway.enforced.test',
      'Your agents run only through this gateway.',
    ]);
  });

  it('renders alongside telemetry consent rather than replacing it', () => {
    const items = describeEnforcedPolicies([
      telemetryOrg('Acme', { transcripts: true }),
      gatewayOrg('Acme', 'https://gateway.acme.test', true),
    ]);
    expect(items.map((item) => item.policyKind)).toEqual([
      'telemetry-sync',
      'model-gateway',
    ]);
  });

  it('stays silent for a policy with no endpoint', () => {
    expect(describeEnforcedPolicies([gatewayOrg('Acme', '  ', true)])).toEqual(
      [],
    );
  });
});

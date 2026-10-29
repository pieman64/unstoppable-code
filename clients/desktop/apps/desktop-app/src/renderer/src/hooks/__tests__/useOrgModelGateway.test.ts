import type { CanopyOrgEnforcedSettings } from '@canopy/protocol/canopy-server';
import {
  orderGatewaysForContext,
  resolveOrgModelGateways,
  selectGatewayForOwner,
} from '../useOrgModelGateway';

function gatewayOrg(
  name: string,
  baseUrl: string,
  enforced: boolean,
  modelIds: string[] = [],
): CanopyOrgEnforcedSettings {
  return {
    organizationId: `org-${name}`,
    organizationName: name,
    policies: [
      {
        kind: 'model-gateway',
        baseUrl,
        enforced,
        promptCachePassthrough: true,
        models: modelIds.map((id) => ({
          id,
          gatewayId: `vertex/${id}`,
          label: id,
          harness: 'codex',
          contextWindow: 200000,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        })),
      },
    ],
  };
}

function telemetryOrg(name: string): CanopyOrgEnforcedSettings {
  return {
    organizationId: `org-${name}`,
    organizationName: name,
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
  };
}

describe('resolveOrgModelGateways', () => {
  it('returns no gateways when the account carries no gateway policy', () => {
    expect(resolveOrgModelGateways(null)).toEqual([]);
    expect(resolveOrgModelGateways(undefined)).toEqual([]);
    expect(resolveOrgModelGateways([telemetryOrg('Acme')])).toEqual([]);
  });

  it('flattens the org identity onto the policy so surfaces can name it', () => {
    expect(
      resolveOrgModelGateways([
        gatewayOrg('Acme', 'https://gw.acme.test', false, ['acme-qwen']),
      ]),
    ).toEqual([
      {
        organizationId: 'org-Acme',
        organizationName: 'Acme',
        baseUrl: 'https://gw.acme.test',
        enforced: false,
        modelIds: ['acme-qwen'],
      },
    ]);
  });

  it('keeps every org gateway instead of picking one for the account', () => {
    const resolved = resolveOrgModelGateways([
      gatewayOrg('Additive', 'https://gw.additive.test', false),
      gatewayOrg('Strict', 'https://gw.strict.test', true),
    ]);
    expect(resolved.map((gateway) => gateway.baseUrl)).toEqual([
      'https://gw.additive.test',
      'https://gw.strict.test',
    ]);
  });
});

describe('selectGatewayForOwner', () => {
  const gateways = resolveOrgModelGateways([
    gatewayOrg('Additive', 'https://gw.additive.test', false),
    gatewayOrg('Strict', 'https://gw.strict.test', true),
  ]);

  it('gives Personal work no org gateway', () => {
    expect(selectGatewayForOwner(gateways, { kind: 'personal' })).toBeNull();
  });

  it("gives org work only that org's gateway, enforced or not", () => {
    expect(
      selectGatewayForOwner(gateways, {
        kind: 'organization',
        organizationId: 'org-Additive',
      })?.baseUrl,
    ).toBe('https://gw.additive.test');
    expect(
      selectGatewayForOwner(gateways, {
        kind: 'organization',
        organizationId: 'org-Unknown',
      }),
    ).toBeNull();
  });

  it('gives an unknown owner the first enforcing gateway, never an additive one', () => {
    expect(selectGatewayForOwner(gateways, undefined)?.baseUrl).toBe(
      'https://gw.strict.test',
    );
    expect(selectGatewayForOwner(gateways.slice(0, 1), undefined)).toBeNull();
  });
});

describe('orderGatewaysForContext', () => {
  const gateways = resolveOrgModelGateways([
    gatewayOrg('Zeta', 'https://gw.zeta.test', false),
    gatewayOrg('Beta', 'https://gw.beta.test', true),
    gatewayOrg('Alpha', 'https://gw.alpha.test', false),
  ]);

  it('lists the selected context org first, then the rest by name', () => {
    expect(
      orderGatewaysForContext(gateways, 'org-Zeta').map(
        (gateway) => gateway.organizationName,
      ),
    ).toEqual(['Zeta', 'Alpha', 'Beta']);
  });

  it('orders by name alone without a selected org', () => {
    expect(
      orderGatewaysForContext(gateways, undefined).map(
        (gateway) => gateway.organizationName,
      ),
    ).toEqual(['Alpha', 'Beta', 'Zeta']);
  });
});

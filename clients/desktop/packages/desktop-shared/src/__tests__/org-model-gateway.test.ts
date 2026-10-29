import type { CanopyCloudAccountPublicState } from '../types';
import {
  gatewayRequirementForOwner,
  resolveModelGatewayIndex,
  soleEnforcingOrganizationId,
} from '../lib/org-model-gateway';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function account(
  settings: NonNullable<CanopyCloudAccountPublicState['enforcedSettings']>,
  accountUnavailable = false,
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: [],
    organizations: [],
    teams: [],
    storageAvailable: true,
    enforcedSettings: settings,
    modelGatewayEnforcementUnavailable: accountUnavailable,
  };
}

function org(
  organizationId: string,
  options: { enforced?: boolean; unavailable?: boolean } = {},
): NonNullable<CanopyCloudAccountPublicState['enforcedSettings']>[number] {
  return {
    organizationId,
    organizationName: organizationId === ORG_A ? 'Acme' : 'Globex',
    ...(options.unavailable
      ? { modelGatewayEnforcementUnavailable: true as const }
      : {}),
    policies: [
      {
        kind: 'model-gateway',
        baseUrl: `https://${organizationId}.example.test`,
        models: [],
        enforced: options.enforced ?? false,
        promptCachePassthrough: true,
      },
    ],
  };
}

describe('organization model gateway', () => {
  it('names an enforcing organization only when exactly one is required', () => {
    expect(
      soleEnforcingOrganizationId({
        kind: 'enforced',
        organizationIds: [ORG_A],
      }),
    ).toBe(ORG_A);
    expect(
      soleEnforcingOrganizationId({
        kind: 'enforced',
        organizationIds: [ORG_A, ORG_B],
      }),
    ).toBeUndefined();
    expect(
      soleEnforcingOrganizationId({ kind: 'unrestricted' }),
    ).toBeUndefined();
  });

  it('resolves every owner branch independently', () => {
    const index = resolveModelGatewayIndex(
      account([org(ORG_A, { enforced: true }), org(ORG_B)]),
    );
    expect(gatewayRequirementForOwner(index, { kind: 'personal' })).toEqual({
      kind: 'unrestricted',
    });
    expect(
      gatewayRequirementForOwner(index, {
        kind: 'organization',
        organizationId: ORG_A,
      }),
    ).toEqual({ kind: 'enforced', organizationIds: [ORG_A] });
    expect(
      gatewayRequirementForOwner(index, {
        kind: 'organization',
        organizationId: ORG_B,
      }),
    ).toEqual({ kind: 'unrestricted' });
    expect(gatewayRequirementForOwner(index)).toEqual({
      kind: 'enforced',
      organizationIds: [ORG_A],
    });
  });

  it('lets unavailable state win only for affected known owners and globally for unknown owners', () => {
    const index = resolveModelGatewayIndex(
      account([
        org(ORG_A, { enforced: true }),
        org(ORG_B, { unavailable: true }),
      ]),
    );
    expect(
      gatewayRequirementForOwner(index, {
        kind: 'organization',
        organizationId: ORG_A,
      }),
    ).toEqual({ kind: 'enforced', organizationIds: [ORG_A] });
    expect(
      gatewayRequirementForOwner(index, {
        kind: 'organization',
        organizationId: ORG_B,
      }),
    ).toEqual({ kind: 'blocked', reason: 'organization-unavailable' });
    expect(gatewayRequirementForOwner(index)).toEqual({
      kind: 'blocked',
      reason: 'organization-unavailable',
    });
  });

  it('blocks every organization owner on account-level unavailability but not Personal', () => {
    const index = resolveModelGatewayIndex(account([org(ORG_A)], true));
    expect(
      gatewayRequirementForOwner(index, {
        kind: 'organization',
        organizationId: ORG_A,
      }),
    ).toEqual({ kind: 'blocked', reason: 'account-unavailable' });
    expect(gatewayRequirementForOwner(index)).toEqual({
      kind: 'blocked',
      reason: 'account-unavailable',
    });
    expect(gatewayRequirementForOwner(index, { kind: 'personal' })).toEqual({
      kind: 'unrestricted',
    });
  });

  it('keeps an unknown owner unrestricted when no org enforces or is unavailable', () => {
    expect(
      gatewayRequirementForOwner(
        resolveModelGatewayIndex(account([org(ORG_A), org(ORG_B)])),
      ),
    ).toEqual({ kind: 'unrestricted' });
  });
});

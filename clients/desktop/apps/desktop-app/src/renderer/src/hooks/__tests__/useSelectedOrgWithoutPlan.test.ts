import type { CanopyOrgBillingState } from '@canopy/protocol/canopy-server';
import { resolveSelectedOrgWithoutPlan } from '../useSelectedOrgWithoutPlan';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function state(
  organizationId: string,
  teamsEntitled: boolean,
): CanopyOrgBillingState {
  return { organizationId, organizationName: 'Org', teamsEntitled };
}

describe('resolveSelectedOrgWithoutPlan', () => {
  const organizations = [
    { id: ORG, name: 'Acme', role: 'OWNER' as const },
    { id: OTHER, name: 'Initech', role: 'MEMBER' as const },
  ];

  it('is null in Personal or while unscoped', () => {
    expect(
      resolveSelectedOrgWithoutPlan({ kind: 'personal' }, organizations, [
        state(ORG, false),
      ]),
    ).toBeNull();
    expect(
      resolveSelectedOrgWithoutPlan(undefined, organizations, [
        state(ORG, false),
      ]),
    ).toBeNull();
  });

  it('is null for a selected organization with an active plan or no billing state', () => {
    const context = { kind: 'organization' as const, organizationId: ORG };
    expect(
      resolveSelectedOrgWithoutPlan(context, organizations, [state(ORG, true)]),
    ).toBeNull();
    expect(
      resolveSelectedOrgWithoutPlan(context, organizations, []),
    ).toBeNull();
  });

  it('lets an owner choose a plan', () => {
    expect(
      resolveSelectedOrgWithoutPlan(
        { kind: 'organization', organizationId: ORG },
        organizations,
        [state(ORG, false)],
      ),
    ).toEqual({
      organizationId: ORG,
      organizationName: 'Acme',
      canChoosePlan: true,
    });
  });

  it('sends admins and members to an owner', () => {
    for (const role of ['ADMIN', 'MEMBER'] as const) {
      expect(
        resolveSelectedOrgWithoutPlan(
          { kind: 'organization', organizationId: OTHER },
          [{ id: OTHER, name: 'Initech', role }],
          [state(OTHER, false)],
        ),
      ).toEqual({
        organizationId: OTHER,
        organizationName: 'Initech',
        canChoosePlan: false,
      });
    }
  });
});

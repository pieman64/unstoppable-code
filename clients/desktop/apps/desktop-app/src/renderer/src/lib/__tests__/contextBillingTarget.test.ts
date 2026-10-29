import { organizationBillingPath } from '@canopy/protocol/billing';
import type { WorkspaceContextOrganization } from '@canopy/protocol/workspace-context';
import {
  nameOrganizationBillingLabel,
  resolveContextBillingAction,
  resolveCreditsBillingPath,
  selectedContextOrganization,
} from '../contextBillingTarget';

const ACME = '33333333-3333-4333-8333-333333333333';
const BETA = '44444444-4444-4444-8444-444444444444';

function org(
  id: string,
  name: string,
  role: WorkspaceContextOrganization['role'],
): WorkspaceContextOrganization {
  return { id, name, role };
}

describe('contextBillingTarget (CAN-3463)', () => {
  const organizations = [
    org(ACME, 'Acme', 'OWNER'),
    org(BETA, 'Beta', 'ADMIN'),
  ];

  it('targets nothing in the Personal context', () => {
    expect(
      resolveContextBillingAction({ kind: 'personal' }, organizations),
    ).toBeNull();
    expect(resolveCreditsBillingPath({ kind: 'personal' }, organizations)).toBe(
      '/account/billing',
    );
  });

  it('gives an OWNER "Manage plan" on the selected org', () => {
    expect(
      resolveContextBillingAction(
        { kind: 'organization', organizationId: ACME },
        organizations,
      ),
    ).toEqual({
      label: 'Manage plan',
      path: organizationBillingPath(ACME),
      organization: { id: ACME, name: 'Acme' },
    });
  });

  it('gives an ADMIN "View organization billing" on the selected org', () => {
    expect(
      resolveContextBillingAction(
        { kind: 'organization', organizationId: BETA },
        organizations,
      )?.label,
    ).toBe('View organization billing');
  });

  it('defers to the server for a MEMBER or an unknown org', () => {
    expect(
      resolveContextBillingAction(
        { kind: 'organization', organizationId: ACME },
        [org(ACME, 'Acme', 'MEMBER')],
      ),
    ).toBeNull();
    expect(
      selectedContextOrganization(
        { kind: 'organization', organizationId: ACME },
        [],
      ),
    ).toBeNull();
  });

  it('sends only an OWNER to the org billing page to buy credits', () => {
    expect(
      resolveCreditsBillingPath(
        { kind: 'organization', organizationId: ACME },
        organizations,
      ),
    ).toBe(organizationBillingPath(ACME));
    expect(
      resolveCreditsBillingPath(
        { kind: 'organization', organizationId: BETA },
        organizations,
      ),
    ).toBe('/account/billing');
  });

  it('names the org on a server-picked label', () => {
    expect(nameOrganizationBillingLabel('Manage plan', 'Acme')).toBe(
      "Manage Acme's plan",
    );
    expect(
      nameOrganizationBillingLabel('View organization billing', 'Acme'),
    ).toBe("View Acme's billing");
    expect(nameOrganizationBillingLabel('Subscribe to Pro', 'Acme')).toBe(
      'Subscribe to Pro',
    );
  });
});

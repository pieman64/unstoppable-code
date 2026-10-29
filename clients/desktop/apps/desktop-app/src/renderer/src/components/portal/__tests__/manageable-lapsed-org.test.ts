import type { WorkspaceContextOrganization } from '@canopy/protocol/workspace-context';
import {
  resolveBillingManageableOrgs,
  resolveManageableLapsedOrg,
} from '../manageable-lapsed-org';

const LAPSED = {
  organizationId: 'org-lapsed',
  organizationName: 'Unstoppable Domains',
  teamsEntitled: false,
};
const SECOND_LAPSED = {
  organizationId: 'org-lapsed-2',
  organizationName: 'Acme',
  teamsEntitled: false,
};
const HEALTHY = {
  organizationId: 'org-healthy',
  organizationName: 'Globex',
  teamsEntitled: true,
};

const MANAGES_LAPSED = { id: 'org-lapsed', name: 'Unstoppable Domains' };
const MANAGES_SECOND_LAPSED = { id: 'org-lapsed-2', name: 'Acme' };
const MANAGES_HEALTHY = { id: 'org-healthy', name: 'Globex' };

function contextOrganization(
  id: string,
  name: string,
  role: WorkspaceContextOrganization['role'],
): WorkspaceContextOrganization {
  return { id, name, role };
}

describe('resolveManageableLapsedOrg (CAN-2590)', () => {
  it('matches when the org this user manages billing for is the lapsed one', () => {
    expect(
      resolveManageableLapsedOrg([LAPSED, HEALTHY], [MANAGES_LAPSED], null),
    ).toEqual({ id: 'org-lapsed', name: 'Unstoppable Domains' });
  });

  it('does not match when the org this user manages is healthy', () => {
    // An admin of a healthy org who merely belongs to a lapsed one cannot fix
    // the lapse being named, so they take the member branch.
    expect(
      resolveManageableLapsedOrg([LAPSED, HEALTHY], [MANAGES_HEALTHY], null),
    ).toBeNull();
  });

  it('matches when one of several lapsed orgs is the manageable one', () => {
    // Administers one lapsed org, merely belongs to another: one of the named
    // orgs is theirs to fix, so the owner/admin branch is right.
    expect(
      resolveManageableLapsedOrg(
        [LAPSED, SECOND_LAPSED],
        [MANAGES_SECOND_LAPSED],
        null,
      ),
    ).toEqual({ id: 'org-lapsed-2', name: 'Acme' });
  });

  it('finds the lapsed org among several the user manages (CAN-3465)', () => {
    // The owner of a healthy Globex and a lapsed Unstoppable Domains used to
    // depend on a server tiebreak picking the lapsed one. Every managed org is
    // checked now, so the one that needs fixing is found without a guess.
    expect(
      resolveManageableLapsedOrg(
        [LAPSED, HEALTHY],
        [MANAGES_HEALTHY, MANAGES_LAPSED],
        null,
      ),
    ).toEqual({ id: 'org-lapsed', name: 'Unstoppable Domains' });
  });

  it('uses the selected organization when several managed orgs have lapsed (CAN-3465)', () => {
    expect(
      resolveManageableLapsedOrg(
        [LAPSED, SECOND_LAPSED],
        [MANAGES_LAPSED, MANAGES_SECOND_LAPSED],
        'org-lapsed-2',
      ),
    ).toEqual({ id: 'org-lapsed-2', name: 'Acme' });
  });

  it('matches the selected organization id without regard to case', () => {
    expect(
      resolveManageableLapsedOrg(
        [LAPSED, SECOND_LAPSED],
        [MANAGES_LAPSED, MANAGES_SECOND_LAPSED],
        'ORG-LAPSED-2',
      ),
    ).toEqual({ id: 'org-lapsed-2', name: 'Acme' });
  });

  it('never picks among several lapsed managed orgs without a selection (CAN-3465)', () => {
    // Personal context, or a selected org that is not one of the lapsed ones:
    // nothing says which org the reader means, so no org is named.
    expect(
      resolveManageableLapsedOrg(
        [LAPSED, SECOND_LAPSED],
        [MANAGES_LAPSED, MANAGES_SECOND_LAPSED],
        null,
      ),
    ).toBeNull();
    expect(
      resolveManageableLapsedOrg(
        [LAPSED, SECOND_LAPSED, HEALTHY],
        [MANAGES_LAPSED, MANAGES_SECOND_LAPSED, MANAGES_HEALTHY],
        'org-healthy',
      ),
    ).toBeNull();
  });

  it('defaults to the member branch when nothing says the user manages an org', () => {
    // `billingManageableOrg` is optional on the wire: a server that cannot say
    // "you are an admin" must not produce a button that assumes it.
    expect(resolveManageableLapsedOrg([LAPSED], [], null)).toBeNull();
    expect(resolveManageableLapsedOrg([LAPSED], [], 'org-lapsed')).toBeNull();
  });

  it('fails open when there are no billing states at all', () => {
    // Mirrors `isOrgTeamsLapsed`: an org with no entry is NOT lapsed.
    expect(
      resolveManageableLapsedOrg(undefined, [MANAGES_LAPSED], null),
    ).toBeNull();
    expect(resolveManageableLapsedOrg([], [MANAGES_LAPSED], null)).toBeNull();
  });
});

describe('resolveBillingManageableOrgs (CAN-3465)', () => {
  it('lists every organization the user owns or administers', () => {
    expect(
      resolveBillingManageableOrgs(
        [
          contextOrganization('org-a', 'Alpha', 'OWNER'),
          contextOrganization('org-b', 'Bravo', 'MEMBER'),
          contextOrganization('org-c', 'Charlie', 'ADMIN'),
        ],
        null,
      ),
    ).toEqual([
      { id: 'org-a', name: 'Alpha' },
      { id: 'org-c', name: 'Charlie' },
    ]);
  });

  it('prefers the membership list over the server field', () => {
    // The server field is null whenever the user manages several orgs, and
    // names only one otherwise. The membership list is the fuller account fact.
    expect(
      resolveBillingManageableOrgs(
        [
          contextOrganization('org-a', 'Alpha', 'OWNER'),
          contextOrganization('org-c', 'Charlie', 'ADMIN'),
        ],
        { id: 'org-a', name: 'Alpha' },
      ),
    ).toEqual([
      { id: 'org-a', name: 'Alpha' },
      { id: 'org-c', name: 'Charlie' },
    ]);
  });

  it('falls back to the server field when no managed membership is known', () => {
    // Memberships not loaded yet (or organization contexts off): the server's
    // sole-manageable-org answer still stands.
    expect(
      resolveBillingManageableOrgs([], { id: 'org-a', name: 'Alpha' }),
    ).toEqual([{ id: 'org-a', name: 'Alpha' }]);
    expect(
      resolveBillingManageableOrgs(
        [contextOrganization('org-b', 'Bravo', 'MEMBER')],
        { id: 'org-a', name: 'Alpha' },
      ),
    ).toEqual([{ id: 'org-a', name: 'Alpha' }]);
  });

  it('is empty when neither source says the user manages an org', () => {
    expect(resolveBillingManageableOrgs([], null)).toEqual([]);
    expect(resolveBillingManageableOrgs([], undefined)).toEqual([]);
    expect(
      resolveBillingManageableOrgs(
        [contextOrganization('org-b', 'Bravo', 'MEMBER')],
        null,
      ),
    ).toEqual([]);
  });
});

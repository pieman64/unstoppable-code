import { resolveJoinedOrganization } from '../resolve-joined-organization';

const ACME = { id: 'org-acme', name: 'Acme' };
const ACME_TWIN = { id: 'org-acme-2', name: 'acme ' };
const ZEN = { id: 'org-zen', name: 'Zen' };

describe('resolveJoinedOrganization', () => {
  it('selects the supplied id over a same-named new membership', () => {
    expect(
      resolveJoinedOrganization({
        invite: { organizationId: 'ORG-ACME-2', organizationName: 'Acme' },
        before: [],
        after: [ACME, ACME_TWIN],
      }),
    ).toBe(ACME_TWIN);
  });

  it('stays unresolved while a supplied id is not listed yet', () => {
    expect(
      resolveJoinedOrganization({
        invite: { organizationId: ACME.id, organizationName: 'Acme' },
        before: [],
        after: [ZEN],
      }),
    ).toBeNull();
  });

  it('resolves a supplied id that was already listed', () => {
    expect(
      resolveJoinedOrganization({
        invite: { organizationId: ACME.id, organizationName: 'Acme' },
        before: [ACME],
        after: [ACME, ZEN],
      }),
    ).toBe(ACME);
  });

  it('resolves an older payload to the unique added same-named membership', () => {
    expect(
      resolveJoinedOrganization({
        invite: { organizationName: 'acme' },
        before: [ZEN],
        after: [ZEN, ACME],
      }),
    ).toBe(ACME);
  });

  it('ignores an unrelated concurrent addition for an older payload', () => {
    expect(
      resolveJoinedOrganization({
        invite: { organizationName: 'Acme' },
        before: [],
        after: [ZEN],
      }),
    ).toBeNull();
  });

  it('leaves duplicate added names unresolved for an older payload', () => {
    expect(
      resolveJoinedOrganization({
        invite: { organizationName: 'Acme' },
        before: [],
        after: [ACME, ACME_TWIN],
      }),
    ).toBeNull();
  });

  it('leaves unchanged memberships unresolved for an older payload', () => {
    expect(
      resolveJoinedOrganization({
        invite: { organizationName: 'Acme' },
        before: [ACME],
        after: [ACME],
      }),
    ).toBeNull();
  });

  it('resolves once a delayed update lists the membership', () => {
    const invite = { organizationName: 'Acme' };
    expect(
      resolveJoinedOrganization({ invite, before: [ZEN], after: [ZEN] }),
    ).toBeNull();
    expect(
      resolveJoinedOrganization({ invite, before: [ZEN], after: [ZEN, ACME] }),
    ).toBe(ACME);
  });
});

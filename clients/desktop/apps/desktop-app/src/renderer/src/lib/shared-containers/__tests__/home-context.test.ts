import { sharedContainerHomeContext } from '../home-context';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIPS = [{ id: ORG_A }, { id: ORG_B }];
const PERSONAL = { kind: 'personal' };

describe('sharedContainerHomeContext', () => {
  describe('an accepted share follows its acceptance record', () => {
    it('stays in the recorded organization when the listing classifies it as direct', () => {
      expect(
        sharedContainerHomeContext(
          { access: 'direct', organizationId: ORG_A },
          { organizationId: ORG_A },
          MEMBERSHIPS,
        ),
      ).toEqual({ kind: 'organization', organizationId: ORG_A });
    });

    it('stays in the recorded organization when the listing names another one', () => {
      expect(
        sharedContainerHomeContext(
          { organizationId: ORG_B },
          { organizationId: ORG_A, access: 'organization' },
          MEMBERSHIPS,
        ),
      ).toEqual({ kind: 'organization', organizationId: ORG_A });
    });

    it('stays in Personal for a direct record when the listing classifies it as an organization share', () => {
      expect(
        sharedContainerHomeContext(
          { organizationId: ORG_A },
          { access: 'direct' },
          MEMBERSHIPS,
        ),
      ).toEqual(PERSONAL);
    });

    it('treats a direct record that also names an organization as Personal', () => {
      expect(
        sharedContainerHomeContext(
          { organizationId: ORG_A },
          { access: 'direct', organizationId: ORG_A },
          MEMBERSHIPS,
        ),
      ).toEqual(PERSONAL);
    });

    it('treats a record with no organization as Personal', () => {
      expect(
        sharedContainerHomeContext({ organizationId: ORG_A }, {}, MEMBERSHIPS),
      ).toEqual(PERSONAL);
    });

    it('matches the recorded organization to a membership regardless of case', () => {
      expect(
        sharedContainerHomeContext(
          { access: 'direct' },
          { organizationId: ORG_A.toUpperCase() },
          MEMBERSHIPS,
        ),
      ).toEqual({ kind: 'organization', organizationId: ORG_A });
      expect(
        sharedContainerHomeContext(
          { access: 'direct' },
          { organizationId: ORG_A },
          [{ id: ORG_A.toUpperCase() }],
        ),
      ).toEqual({ kind: 'organization', organizationId: ORG_A.toUpperCase() });
    });
  });

  describe('memberships', () => {
    it('trusts the record while memberships have not loaded', () => {
      expect(
        sharedContainerHomeContext(
          { access: 'direct', organizationId: ORG_A },
          { organizationId: ORG_A },
          undefined,
        ),
      ).toEqual({ kind: 'organization', organizationId: ORG_A });
    });

    it('follows the listing once memberships loaded and are empty', () => {
      expect(
        sharedContainerHomeContext(
          { access: 'direct', organizationId: ORG_A },
          { organizationId: ORG_A },
          [],
        ),
      ).toEqual(PERSONAL);
    });

    it('follows the listing when the record names an organization the account has left', () => {
      expect(
        sharedContainerHomeContext(
          { access: 'direct', organizationId: ORG_A },
          { organizationId: ORG_A },
          [{ id: ORG_B }],
        ),
      ).toEqual(PERSONAL);
      expect(
        sharedContainerHomeContext(
          { organizationId: ORG_B },
          { organizationId: ORG_A },
          [{ id: ORG_B }],
        ),
      ).toEqual({ kind: 'organization', organizationId: ORG_B });
    });
  });

  describe('without a record the listing decides', () => {
    it('lists a direct share under Personal', () => {
      expect(
        sharedContainerHomeContext(
          { access: 'direct', organizationId: ORG_A },
          undefined,
          MEMBERSHIPS,
        ),
      ).toEqual(PERSONAL);
    });

    it('lists an organization share under its organization', () => {
      expect(
        sharedContainerHomeContext(
          { organizationId: ORG_A },
          undefined,
          MEMBERSHIPS,
        ),
      ).toEqual({ kind: 'organization', organizationId: ORG_A });
      expect(
        sharedContainerHomeContext(
          { access: 'organization', organizationId: ORG_B },
          undefined,
          undefined,
        ),
      ).toEqual({ kind: 'organization', organizationId: ORG_B });
    });

    it('has no home for a non-direct share with no organization', () => {
      expect(sharedContainerHomeContext({}, undefined, MEMBERSHIPS)).toBeNull();
      expect(
        sharedContainerHomeContext(
          { access: 'organization' },
          undefined,
          undefined,
        ),
      ).toBeNull();
    });

    it('has no home when a departed-organization record falls back to such a listing', () => {
      expect(
        sharedContainerHomeContext({}, { organizationId: ORG_A }, [
          { id: ORG_B },
        ]),
      ).toBeNull();
    });
  });
});

import type { SharedContainerListEntry } from '@/stores/sharedContainerReplicasStore';
import { pendingInvitationsByContext } from '../pending-invitations-by-context';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEMBERSHIPS = [{ id: ORG_A }, { id: ORG_B }];

function entry(
  id: string,
  listed: Pick<SharedContainerListEntry, 'organizationId' | 'access'>,
  capabilities: SharedContainerListEntry['container']['capabilities'] = [
    'VIEW',
  ],
): SharedContainerListEntry {
  return {
    ...listed,
    container: {
      id,
      ownerUserId: 'owner',
      owner: { userId: 'owner', name: 'Owner' },
      access: listed.access ?? 'organization',
      containerType: 'CODE_WORKTREE',
      title: id,
      revision: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      capabilities,
    },
  };
}

function counts(
  entries: SharedContainerListEntry[],
  options: {
    acceptedIds?: string[];
    acceptedRecords?: Parameters<typeof pendingInvitationsByContext>[2];
    organizations?: readonly { readonly id: string }[] | undefined;
  } = {},
): Record<string, number> {
  return Object.fromEntries(
    pendingInvitationsByContext(
      entries,
      options.acceptedIds ?? [],
      options.acceptedRecords ?? {},
      'organizations' in options ? options.organizations : MEMBERSHIPS,
    ),
  );
}

describe('pendingInvitationsByContext', () => {
  it('is empty for an empty listing', () => {
    expect(counts([])).toEqual({});
  });

  it('counts invitations in one organization', () => {
    expect(counts([entry('one', { organizationId: ORG_A })])).toEqual({
      [ORG_A]: 1,
    });
    expect(
      counts([
        entry('one', { organizationId: ORG_A }),
        entry('two', { organizationId: ORG_A }),
      ]),
    ).toEqual({ [ORG_A]: 2 });
  });

  it('counts each organization separately', () => {
    expect(
      counts([
        entry('one', { organizationId: ORG_A }),
        entry('two', { organizationId: ORG_B }),
        entry('three', { organizationId: ORG_B }),
      ]),
    ).toEqual({ [ORG_A]: 1, [ORG_B]: 2 });
  });

  it('homes a direct invitation in Personal', () => {
    expect(
      counts([entry('one', { access: 'direct', organizationId: ORG_A })]),
    ).toEqual({ personal: 1 });
  });

  it('skips accepted shares still present in the listing', () => {
    expect(
      counts(
        [
          entry('one', { organizationId: ORG_A }),
          entry('two', { organizationId: ORG_A }),
        ],
        { acceptedIds: ['one'] },
      ),
    ).toEqual({ [ORG_A]: 1 });
  });

  it('skips entries without VIEW and entries no context lists', () => {
    expect(
      counts([
        entry('no-view', { organizationId: ORG_A }, ['PROMPT']),
        entry('homeless', {}),
      ]),
    ).toEqual({});
  });

  it('follows an acceptance record hint the way the sidebar homes it', () => {
    // A record without an accepted id is only a homing hint: the share is
    // still pending, in the recorded organization.
    expect(
      counts([entry('one', { access: 'direct', organizationId: ORG_B })], {
        acceptedRecords: { one: { organizationId: ORG_A } },
      }),
    ).toEqual({ [ORG_A]: 1 });
  });

  it('keeps a record’s organization while memberships have not loaded', () => {
    expect(
      counts([entry('one', { organizationId: ORG_B })], {
        acceptedRecords: { one: { organizationId: ORG_A } },
        organizations: undefined,
      }),
    ).toEqual({ [ORG_A]: 1 });
  });

  it('keys a listed organization by the membership the sidebar matches', () => {
    // The section lists the invitation under ORG_A (ids compare without
    // case), so the switcher's dot must use the membership's id too.
    expect(
      counts([entry('one', { organizationId: ORG_A.toUpperCase() })]),
    ).toEqual({ [ORG_A]: 1 });
  });

  it('keeps unknown organization homes as data keys', () => {
    const unknown = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    expect(counts([entry('one', { organizationId: unknown })])).toEqual({
      [unknown]: 1,
    });
  });
});

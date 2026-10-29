import {
  preserveOrganizationPublicLink,
  toPortalExistingShare,
} from '../lib/resource-share-context';
import { resourceContextEnabled } from '../lib/resource-context';
import { loadCanopyCloudAccountPublicState } from '../lib/canopy-cloud-account-store';

jest.mock('../lib/resource-context', () => ({
  resourceContextEnabled: jest.fn(() => true),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccountPublicState: jest.fn(),
}));

describe('preserveOrganizationPublicLink', () => {
  beforeEach(() => {
    jest.mocked(resourceContextEnabled).mockReturnValue(true);
    jest.mocked(loadCanopyCloudAccountPublicState).mockResolvedValue({
      status: 'ok',
      hasApiKey: true,
      capabilities: [],
      personalOrganizationId: 'personal-org',
    });
  });

  it.each([
    [{ type: 'organization', id: 'org' }, true],
    [{ type: 'team', id: 'team', organization: { id: 'org' } }, true],
    [{ type: 'organization', id: 'personal-org' }, false],
    [{ type: 'team', id: 'team', organization: { id: 'personal-org' } }, false],
    [{ type: 'team', id: 'personal-org' }, true],
    [{ type: 'user', id: 'user' }, false],
    [undefined, false],
  ] satisfies readonly (readonly [
    Parameters<typeof preserveOrganizationPublicLink>[0],
    boolean,
  ])[])('preserves only locked owners (%j)', async (owner, expected) => {
    await expect(preserveOrganizationPublicLink(owner)).resolves.toBe(expected);
  });

  it('keeps flag-off behavior and cannot infer a Personal exception without its ID', async () => {
    const owner = { type: 'organization', id: 'org' } as const;
    jest.mocked(resourceContextEnabled).mockReturnValue(false);
    await expect(preserveOrganizationPublicLink(owner)).resolves.toBe(false);
    jest.mocked(resourceContextEnabled).mockReturnValue(true);
    jest
      .mocked(loadCanopyCloudAccountPublicState)
      .mockResolvedValue({ status: 'ok', hasApiKey: true, capabilities: [] });
    await expect(preserveOrganizationPublicLink(owner)).resolves.toBe(true);
  });
});

describe('toPortalExistingShare', () => {
  it('preserves organization ownership separately from a legacy public audience', () => {
    expect(
      toPortalExistingShare({
        shareScope: 'organization',
        owner: { type: 'organization', id: 'org-id', name: 'Organization' },
        publicShare: { upToDate: false },
      }),
    ).toEqual({
      audience: 'public',
      targetAudience: 'organization',
      target: { id: 'org-id', name: 'Organization' },
      publicLinkStale: true,
    });
  });

  it('preserves team kind and its parent organization even without a parent name', () => {
    expect(
      toPortalExistingShare({
        shareScope: 'team',
        owner: {
          type: 'team',
          id: 'team-id',
          name: 'Team',
          organization: { id: 'org-id' },
        },
      }),
    ).toEqual({
      audience: 'team',
      targetAudience: 'team',
      target: { id: 'team-id', name: 'Team', organizationId: 'org-id' },
    });
  });

  it('retains the team parent label and owner when a public link exists', () => {
    expect(
      toPortalExistingShare({
        shareScope: 'private',
        owner: {
          type: 'team',
          id: 'team-id',
          name: null,
          organization: { id: 'personal-org-id', name: 'Personal' },
        },
        publicShare: { upToDate: true },
      }),
    ).toEqual({
      audience: 'public',
      targetAudience: 'team',
      target: {
        id: 'team-id',
        name: 'Shared team',
        organizationId: 'personal-org-id',
        secondaryLabel: 'Personal',
      },
    });
  });

  it.each([undefined, null])(
    'does not substitute a team id for its missing parent (%s)',
    (organization) => {
      expect(
        toPortalExistingShare({
          shareScope: 'team',
          owner: { type: 'team', id: 'personal-org-id', organization },
        }),
      ).toEqual({
        audience: 'team',
        targetAudience: 'team',
        target: { id: 'personal-org-id', name: 'Shared team' },
      });
    },
  );

  it('preserves raw Personal-organization identity without presentation renaming', () => {
    expect(
      toPortalExistingShare({
        shareScope: 'organization',
        owner: { type: 'organization', id: 'personal-org-id', name: null },
      }),
    ).toEqual({
      audience: 'organization',
      targetAudience: 'organization',
      target: { id: 'personal-org-id', name: 'Shared organization' },
    });
  });

  const unscopedOwners: Parameters<typeof toPortalExistingShare>[0]['owner'][] =
    [
      undefined,
      null,
      { type: 'system' },
      { type: 'user', id: 'user-id', name: 'User' },
    ];

  it.each(unscopedOwners)(
    'keeps a personal or absent owner without an invented target (%j)',
    (owner) => {
      expect(toPortalExistingShare({ owner })).toEqual({ audience: 'private' });
      expect(toPortalExistingShare({ owner, publicShare: {} })).toEqual({
        audience: 'public',
      });
    },
  );
});

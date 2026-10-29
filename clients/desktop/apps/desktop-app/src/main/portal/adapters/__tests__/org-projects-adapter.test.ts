import type { OrgRepositoryOwnerLookup } from '@canopy/protocol/org-projects';
import type { PortalCommandEnvelope } from '@canopy/protocol/portal';
import type { OrgRepositoryOwnerRequest } from '@canopy/desktop-shared/types';
import type { PortalAdapterContext } from '../types';

const mockFind = jest.fn<
  Promise<OrgRepositoryOwnerLookup>,
  [OrgRepositoryOwnerRequest]
>();
const mockGetLookup = jest.fn(() => ({ find: mockFind }));
jest.mock('../../../lib/org-repository-owner', () => ({
  getOrgRepositoryOwnerLookup: (): ReturnType<typeof mockGetLookup> =>
    mockGetLookup(),
}));

import { handlePortalOrgProjectsFindRepositoryOwner } from '../org-projects-adapter';

function command(payload: unknown): PortalCommandEnvelope<unknown> {
  return {
    id: 'command-1',
    sequence: 1,
    type: 'portal.org_projects.find_repository_owner',
    payload,
    createdAt: '2026-10-08T00:00:00.000Z',
    expiresAt: null,
  };
}

describe('Portal repository owner adapter', () => {
  const complete = jest.fn();
  const fail = jest.fn();
  const context: PortalAdapterContext = {
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete,
    fail,
  };
  const match: OrgRepositoryOwnerLookup = {
    kind: 'organization',
    organizationId: 'org',
    organizationName: 'Acme',
    projectId: 'project',
    projectName: 'Catalog',
    repositoryName: 'acme/catalog',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLookup.mockImplementation(() => ({ find: mockFind }));
    mockFind.mockResolvedValue({ kind: 'none' });
  });

  it.each([
    'https://github.com/acme/catalog.git',
    'git@github.com:acme/catalog.git',
    '  https://github.com/acme/catalog.git  ',
    'a'.repeat(2048),
  ])('delegates %s unchanged and completes once', async (remoteUrl) => {
    const envelope = command({ remoteUrl });
    await handlePortalOrgProjectsFindRepositoryOwner(envelope, context);
    expect(mockGetLookup).toHaveBeenCalledTimes(1);
    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(mockFind).toHaveBeenCalledWith({ remoteUrl });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(envelope, { kind: 'none' });
    expect(fail).not.toHaveBeenCalled();
  });

  it('returns the existing lookup match', async () => {
    mockFind.mockResolvedValue(match);
    const envelope = command({ remoteUrl: 'https://github.com/acme/catalog' });
    await handlePortalOrgProjectsFindRepositoryOwner(envelope, context);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(envelope, match);
    expect(fail).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    {},
    { remoteUrl: null },
    { remoteUrl: 42 },
    { remoteUrl: false },
    { remoteUrl: {} },
    { remoteUrl: [] },
    { remoteUrl: '' },
    { remoteUrl: ' \t\n' },
    { remoteUrl: 'a'.repeat(2049) },
    { remoteUrl: ` ${'a'.repeat(2047)} ` },
  ])('rejects invalid payload %p without lookup', async (payload) => {
    const envelope = command(payload);
    await handlePortalOrgProjectsFindRepositoryOwner(envelope, context);
    expect(mockGetLookup).not.toHaveBeenCalled();
    expect(mockFind).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith(
      envelope,
      'invalid_payload',
      expect.any(String),
    );
  });

  it.each(['get', 'throw', 'reject'])(
    'fails open when lookup fails: %s',
    async (failure) => {
      if (failure === 'get')
        mockGetLookup.mockImplementation(() => {
          throw new Error('lookup unavailable');
        });
      if (failure === 'throw')
        mockFind.mockImplementation(() => {
          throw new Error('lookup unavailable');
        });
      if (failure === 'reject')
        mockFind.mockRejectedValue(new Error('lookup unavailable'));
      const envelope = command({
        remoteUrl: 'https://github.com/acme/catalog',
      });
      await handlePortalOrgProjectsFindRepositoryOwner(envelope, context);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledWith(envelope, { kind: 'none' });
      expect(fail).not.toHaveBeenCalled();
    },
  );
});

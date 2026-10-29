const assertCapabilityMock = jest.fn<Promise<void>, unknown[]>();
const requestJsonMock = jest.fn<Promise<unknown>, unknown[]>();

jest.mock('../canopy-cloud/client', () => {
  class CanopyCloudClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    CanopyCloudClientError,
    assertCanopyCloudCapability: (...args: unknown[]): Promise<void> =>
      assertCapabilityMock(...args),
    requestCanopyCloudJson: (...args: unknown[]): Promise<unknown> =>
      requestJsonMock(...args),
    requestCanopyCloudNoContent: jest.fn(),
    resolveCanopyCloudCredentialContext: jest.fn(),
  };
});

import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  listDismissedSharedContainers,
  restoreSharedContainer,
} from '../shared-containers/canopy-server-client';

describe('shared-container dismissals client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertCapabilityMock.mockResolvedValue(undefined);
  });

  it('lists removed shares through the unbranded route', async () => {
    const page = { containers: [], nextCursor: null };
    requestJsonMock.mockResolvedValue(page);

    await expect(
      listDismissedSharedContainers({
        organizationId: 'org-1',
        cursor: 'abc',
        limit: 50,
      }),
    ).resolves.toBe(page);

    expect(assertCapabilityMock).toHaveBeenCalledWith(
      'shared-container-dismissals-v1',
    );
    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/v1/shared-containers/dismissed?organizationId=org-1&cursor=abc&limit=50',
    );
  });

  it('omits the organization for removed direct shares', async () => {
    requestJsonMock.mockResolvedValue({ containers: [], nextCursor: null });

    await listDismissedSharedContainers({});

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/api/v1/shared-containers/dismissed',
    );
  });

  it('restores with a POST and the optional ownership hint', async () => {
    const response = { container: { id: 'container 1' } };
    requestJsonMock.mockResolvedValue(response);

    await expect(restoreSharedContainer('container 1', 'org-1')).resolves.toBe(
      response,
    );
    await restoreSharedContainer('container-2', undefined);

    expect(requestJsonMock.mock.calls).toEqual([
      [
        '/api/v1/shared-containers/container%201/restore?organizationId=org-1',
        { method: 'POST' },
      ],
      ['/api/v1/shared-containers/container-2/restore', { method: 'POST' }],
    ]);
  });

  it('sends no request to a server that does not advertise the capability', async () => {
    // The base `shared-containers-v1` capability is not enough: that server
    // hard-deletes on dismiss and has neither route.
    assertCapabilityMock.mockImplementation((capability) =>
      capability === 'shared-container-dismissals-v1'
        ? Promise.reject(
            new CanopyCloudClientError('unsupported-capability', 'unsupported'),
          )
        : Promise.resolve(),
    );

    await expect(listDismissedSharedContainers({})).rejects.toMatchObject({
      code: 'unsupported-capability',
    });
    await expect(
      restoreSharedContainer('container-1', undefined),
    ).rejects.toMatchObject({ code: 'unsupported-capability' });

    expect(requestJsonMock).not.toHaveBeenCalled();
  });
});

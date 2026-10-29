import type * as CloudClient from '../canopy-cloud/client';
import { CanopyCloudClientError } from '../canopy-cloud/client';
const mockRequest = jest.fn<Promise<unknown>, [string, unknown]>();
jest.mock('../canopy-cloud/client', () => ({
  ...jest.requireActual<typeof CloudClient>('../canopy-cloud/client'),
  requestCanopyCloudJson: (...args: [string, unknown]): Promise<unknown> =>
    mockRequest(...args),
}));
import {
  promotePersonalOrganization,
  inviteToOrganization,
  shareMemberProject,
} from '../canopy-cloud/personal-organization-upgrade';
const organizationId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const credentials = {
  baseUrl: 'https://example.com',
  apiKey: 'initiating-account',
};
beforeEach((): void => {
  mockRequest.mockReset();
});
it('pins credentials and validates the nested committed result', async (): Promise<void> => {
  const result = {
    organizationId,
    operationId,
    name: 'Team',
    personalOrganizationId: operationId,
    alreadyUpgraded: false,
    warnings: ['policy-refresh-pending'],
  };
  mockRequest.mockResolvedValue(result);
  const request = { organizationId, operationId, name: 'Team' };
  await expect(
    promotePersonalOrganization(request, credentials),
  ).resolves.toEqual(result);
  expect(mockRequest).toHaveBeenCalledWith(
    `/api/v1/organizations/${organizationId}/upgrade`,
    {
      method: 'POST',
      body: JSON.stringify(request),
      credentialContext: credentials,
    },
  );
});
it('preserves a typed refusal and never retries an ambiguous POST', async (): Promise<void> => {
  const error = new CanopyCloudClientError(
    'http-error',
    'Changed',
    409,
    'operation_conflict',
  );
  mockRequest.mockRejectedValue(error);
  await expect(
    promotePersonalOrganization(
      { organizationId, operationId, name: 'Team' },
      credentials,
    ),
  ).rejects.toBe(error);
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
it('rejects malformed invitation and sharing results', async (): Promise<void> => {
  mockRequest.mockResolvedValue({ status: 'sent', inviteId: 'bad' });
  await expect(
    inviteToOrganization(
      organizationId,
      { email: 'a@example.com' },
      credentials,
    ),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  mockRequest.mockResolvedValue({
    projectId: operationId,
    visibility: 'private',
    authorizationVersion: 1,
  });
  await expect(
    shareMemberProject(
      { projectId: operationId, authorizationVersion: 1 },
      credentials,
    ),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});
it('rejects a promotion response belonging to a different operation', async (): Promise<void> => {
  mockRequest.mockResolvedValue({
    organizationId,
    operationId: organizationId,
    name: 'Team',
    personalOrganizationId: operationId,
    alreadyUpgraded: false,
    warnings: [],
  });
  await expect(
    promotePersonalOrganization(
      { organizationId, operationId, name: 'Team' },
      credentials,
    ),
  ).rejects.toMatchObject({ code: 'invalid-response' });
});

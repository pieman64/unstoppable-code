jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({ recordAppDiagnostic: jest.fn() }),
}));
import { loadStoredTelemetryEnforcementByOrganization } from '../lib/telemetry-enforcement-state';
const mockAccountRead = jest.fn();
jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (...args: unknown[]): unknown =>
    mockAccountRead(...args),
  toPublicCanopyCloudAccountState: (entry: unknown): unknown => entry,
}));
import {
  requireDataSharingOptInAuthority,
  requireDataSharingPersonalOptInAuthority,
} from '../lib/data-sharing-opt-in-authority';
const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const entry = {
  apiKey: 'key',
  account: { id: 'user' },
  organizations: [{ id: organizationId }],
  enforcedSettings: [],
};
beforeEach(() => {
  jest.resetAllMocks();
  mockAccountRead.mockResolvedValue({ status: 'ok', entry });
});
it.each(['unavailable', 'error'])(
  'fails closed on %s account reads',
  async (status) => {
    mockAccountRead.mockResolvedValue({ status });
    await expect(
      requireDataSharingOptInAuthority(organizationId),
    ).rejects.toMatchObject({ reason: 'account-unavailable' });
  },
);
it('requires a membership and distinguishes missing enforcement from an empty snapshot', async () => {
  mockAccountRead.mockResolvedValue({
    status: 'ok',
    entry: { ...entry, organizations: [] },
  });
  await expect(
    requireDataSharingOptInAuthority(organizationId),
  ).rejects.toMatchObject({ reason: 'not-member' });
  mockAccountRead.mockResolvedValue({
    status: 'ok',
    entry: { ...entry, enforcedSettings: undefined },
  });
  await expect(
    requireDataSharingOptInAuthority(organizationId),
  ).rejects.toMatchObject({ reason: 'enforcement-unavailable' });
});
it('resolves the named organization independently and reads without the cache', async () => {
  mockAccountRead.mockResolvedValue({
    status: 'ok',
    entry: {
      ...entry,
      enforcedSettings: [
        {
          organizationId,
          organizationName: 'A',
          policies: [
            {
              kind: 'telemetry-sync',
              scopes: { plans: true },
              prohibitedScopes: { transcripts: true },
            },
          ],
        },
        {
          organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          organizationName: 'B',
          policies: [
            {
              kind: 'telemetry-sync',
              scopes: {},
              prohibitedScopes: { metadata: true },
            },
          ],
        },
      ],
    },
  });
  expect(await requireDataSharingOptInAuthority(organizationId)).toMatchObject({
    required: { plans: true },
    prohibited: { metadata: false, transcripts: true },
  });
  expect(mockAccountRead).toHaveBeenCalledWith({ cache: false });
});

it('rejects an unavailable policy snapshot even after it was normalized to an empty list', async () => {
  mockAccountRead.mockResolvedValue({
    status: 'ok',
    entry: { ...entry, telemetryEnforcementUnavailable: true },
  });
  await expect(
    requireDataSharingOptInAuthority(organizationId),
  ).rejects.toMatchObject({ reason: 'enforcement-unavailable' });
});

it('also fails closed at delivery when the account refresh loses its policy snapshot', async () => {
  mockAccountRead.mockResolvedValue({
    status: 'ok',
    entry: { ...entry, telemetryEnforcementUnavailable: true },
  });
  await expect(
    loadStoredTelemetryEnforcementByOrganization(),
  ).rejects.toThrow();
});

describe('personal opt-in authority', () => {
  it('accepts a conclusive account with an API key and no organization', async () => {
    mockAccountRead.mockResolvedValue({
      status: 'ok',
      entry: { ...entry, organizations: [], enforcedSettings: undefined },
    });
    await expect(
      requireDataSharingPersonalOptInAuthority(),
    ).resolves.toBeUndefined();
    expect(mockAccountRead).toHaveBeenCalledWith({ cache: false });
  });
  it.each(['unavailable', 'error'])(
    'fails closed on %s account reads',
    async (status) => {
      mockAccountRead.mockResolvedValue({ status });
      await expect(
        requireDataSharingPersonalOptInAuthority(),
      ).rejects.toMatchObject({ reason: 'account-unavailable' });
    },
  );
  it('refuses without an account or with an empty API key', async () => {
    mockAccountRead.mockResolvedValue({ status: 'ok', entry: null });
    await expect(
      requireDataSharingPersonalOptInAuthority(),
    ).rejects.toMatchObject({ reason: 'account-unavailable' });
    mockAccountRead.mockResolvedValue({
      status: 'ok',
      entry: { ...entry, account: undefined },
    });
    await expect(
      requireDataSharingPersonalOptInAuthority(),
    ).rejects.toMatchObject({ reason: 'account-unavailable' });
    mockAccountRead.mockResolvedValue({
      status: 'ok',
      entry: { ...entry, apiKey: '  ' },
    });
    await expect(
      requireDataSharingPersonalOptInAuthority(),
    ).rejects.toMatchObject({ reason: 'account-unavailable' });
  });
});

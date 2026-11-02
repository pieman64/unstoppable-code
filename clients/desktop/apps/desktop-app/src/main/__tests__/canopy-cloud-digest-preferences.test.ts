import { BRAND } from '@canopy/brand/current';

const requestCanopyCloudJsonMock = jest.fn();

class MockCanopyCloudClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(status === undefined ? message : `HTTP ${status}: ${message}`);
    this.name = 'CanopyCloudClientError';
  }
}

jest.mock('../canopy-cloud/client', () => ({
  requestCanopyCloudJson: (...args: unknown[]): unknown =>
    requestCanopyCloudJsonMock(...args),
  get CanopyCloudClientError(): typeof MockCanopyCloudClientError {
    return MockCanopyCloudClientError;
  },
}));

import {
  loadCloudDigestPreferences,
  saveCloudDigestPreferences,
} from '../canopy-cloud/digest-preferences';

const PATH = `/api/v1/${BRAND.web.apiNamespace}/account/digest-preferences`;
const WEEKLY_ONLY = {
  daily: false,
  weekly: true,
  monthly: false,
  weeklyAnchorDay: 1,
  monthlyAnchorDay: 1,
};

describe('cloud digest preferences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads a complete server preference projection', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue({
      daily: true,
      weekly: false,
      monthly: true,
      weeklyAnchorDay: 4,
      monthlyAnchorDay: 12,
    });

    await expect(loadCloudDigestPreferences()).resolves.toEqual({
      available: true,
      resolved: true,
      preferences: {
        daily: true,
        weekly: false,
        monthly: true,
        weeklyAnchorDay: 4,
        monthlyAnchorDay: 12,
      },
    });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledWith(PATH);
  });

  it.each([
    null,
    [],
    {},
    { daily: false, weekly: true },
    { daily: false, weekly: true, monthly: 'false' },
    // Anchors are optional-with-default, but an out-of-range one is malformed.
    { daily: false, weekly: true, monthly: false, weeklyAnchorDay: 0 },
    { daily: false, weekly: true, monthly: false, monthlyAnchorDay: 32 },
  ])('keeps malformed load payloads unresolved (%p)', async (payload) => {
    requestCanopyCloudJsonMock.mockResolvedValue(payload);

    await expect(loadCloudDigestPreferences()).resolves.toEqual({
      available: true,
      resolved: false,
      preferences: WEEKLY_ONLY,
    });
  });

  it.each([
    new MockCanopyCloudClientError('cloud-not-configured', 'not configured'),
    new MockCanopyCloudClientError('missing-api-key', 'not connected'),
    new MockCanopyCloudClientError('http-error', 'not found', 404),
    new MockCanopyCloudClientError('http-error', 'unauthorized', 401),
    new MockCanopyCloudClientError('http-error', 'forbidden', 403),
  ])('hides the surface when the cloud route is unavailable', async (error) => {
    requestCanopyCloudJsonMock.mockRejectedValue(error);

    await expect(loadCloudDigestPreferences()).resolves.toEqual({
      available: false,
      resolved: true,
      preferences: WEEKLY_ONLY,
    });
  });

  it.each([
    new MockCanopyCloudClientError('http-error', 'server error', 503),
    new Error('offline'),
  ])('keeps transient failures unresolved', async (error) => {
    requestCanopyCloudJsonMock.mockRejectedValue(error);

    await expect(loadCloudDigestPreferences()).resolves.toEqual({
      available: true,
      resolved: false,
      preferences: WEEKLY_ONLY,
    });
  });

  it('writes all cadences and adopts the server projection', async () => {
    const requested = {
      daily: true,
      weekly: true,
      monthly: false,
      weeklyAnchorDay: 5,
      monthlyAnchorDay: 15,
    };
    const returned = {
      daily: false,
      weekly: true,
      monthly: true,
      weeklyAnchorDay: 5,
      monthlyAnchorDay: 15,
    };
    requestCanopyCloudJsonMock.mockResolvedValue(returned);

    await expect(saveCloudDigestPreferences(requested)).resolves.toEqual({
      available: true,
      resolved: true,
      preferences: returned,
    });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledWith(PATH, {
      method: 'PATCH',
      body: JSON.stringify(requested),
    });
  });

  it('does not treat a malformed save response as all cadences off', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue({ daily: false });

    await expect(
      saveCloudDigestPreferences({
        daily: false,
        weekly: false,
        monthly: false,
        weeklyAnchorDay: 1,
        monthlyAnchorDay: 1,
      }),
    ).resolves.toEqual({
      available: true,
      resolved: false,
      preferences: WEEKLY_ONLY,
    });
  });
});

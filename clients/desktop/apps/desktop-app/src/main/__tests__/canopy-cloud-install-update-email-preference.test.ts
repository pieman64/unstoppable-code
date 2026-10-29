/**
 * CAN-2334 "Updates to things I've installed" account preference.
 *
 * The desktop reads and writes the single account-level toggle through
 * `/api/v1/account/notification-preferences`. A malformed answer must surface
 * as an error, never as a default, because the settings row would otherwise
 * show (and later persist) a value the user never chose.
 */

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
  CanopyCloudClientError: MockCanopyCloudClientError,
}));

import {
  InstallUpdateEmailPreferenceError,
  loadInstallUpdateEmailPreference,
  saveInstallUpdateEmailPreference,
} from '../canopy-cloud/install-update-email-preference';

const PATH = '/api/v1/account/notification-preferences';

describe('install update email preference', () => {
  beforeEach(() => {
    requestCanopyCloudJsonMock.mockReset();
  });

  it.each([true, false])(
    'loads enabled=%p from the account preferences',
    async (enabled) => {
      requestCanopyCloudJsonMock.mockResolvedValue({
        pushEnabled: true,
        installUpdateEmailsEnabled: enabled,
      });

      await expect(loadInstallUpdateEmailPreference()).resolves.toEqual({
        enabled,
      });
      expect(requestCanopyCloudJsonMock).toHaveBeenCalledWith(PATH);
    },
  );

  it('saves with a partial PATCH and adopts the server answer', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue({
      pushEnabled: false,
      installUpdateEmailsEnabled: true,
    });

    await expect(
      saveInstallUpdateEmailPreference({ enabled: false }),
    ).resolves.toEqual({ enabled: true });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledWith(PATH, {
      method: 'PATCH',
      body: JSON.stringify({ installUpdateEmailsEnabled: false }),
    });
  });

  it.each([
    null,
    [],
    {},
    { installUpdateEmailsEnabled: true },
    { pushEnabled: true, installUpdateEmailsEnabled: 'true' },
    { pushEnabled: true, installUpdateEmailsEnabled: true, extra: 1 },
  ])('rejects a malformed load response (%p)', async (payload) => {
    requestCanopyCloudJsonMock.mockResolvedValue(payload);

    await expect(loadInstallUpdateEmailPreference()).rejects.toMatchObject({
      name: 'InstallUpdateEmailPreferenceError',
      reason: 'unresolved',
    });
  });

  it('rejects a malformed save response', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue({ enabled: true });

    await expect(
      saveInstallUpdateEmailPreference({ enabled: true }),
    ).rejects.toMatchObject({ reason: 'unresolved' });
  });

  it.each([
    new MockCanopyCloudClientError('cloud-not-configured', 'no cloud'),
    new MockCanopyCloudClientError('missing-api-key', 'signed out'),
    new MockCanopyCloudClientError('http-error', 'missing', 404),
    new MockCanopyCloudClientError('http-error', 'unauthorized', 401),
    new MockCanopyCloudClientError('http-error', 'guest', 403),
  ])('maps %p to unavailable', async (error) => {
    requestCanopyCloudJsonMock.mockRejectedValue(error);

    await expect(loadInstallUpdateEmailPreference()).rejects.toMatchObject({
      reason: 'unavailable',
    });
    await expect(
      saveInstallUpdateEmailPreference({ enabled: true }),
    ).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it.each([
    new MockCanopyCloudClientError('network-error', 'offline'),
    new MockCanopyCloudClientError('http-error', 'server', 500),
    new MockCanopyCloudClientError('http-error', 'slow down', 429),
    new Error('unexpected'),
  ])('maps %p to unresolved', async (error) => {
    requestCanopyCloudJsonMock.mockRejectedValue(error);

    const failure: unknown = await loadInstallUpdateEmailPreference().catch(
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(InstallUpdateEmailPreferenceError);
    expect(failure).toMatchObject({ reason: 'unresolved' });
  });
});

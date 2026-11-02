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

import { DEFAULT_DAILY_DRIP_CAP_CREDITS } from '@canopy/protocol/billing';
import {
  DAILY_CREDIT_DRIP_PATH,
  DailyCreditDripSaveError,
  loadDailyCreditDrip,
  saveDailyCreditDrip,
} from '../canopy-cloud/daily-credit-drip';

const PLACEHOLDER = {
  enabled: false,
  decidedAt: null,
  capCredits: DEFAULT_DAILY_DRIP_CAP_CREDITS,
};
const PREFERENCE = {
  enabled: true,
  decidedAt: '2026-10-06T19:00:00.000Z',
  capCredits: 25,
};
const SAVED = { ...PREFERENCE, balanceCredits: 25, granted: 25 };

describe('cloud daily credit drip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads the un-namespaced ai-credits route', () => {
    expect(DAILY_CREDIT_DRIP_PATH).toBe('/api/v1/ai-credits/daily-drip');
  });

  it('loads a valid preference', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue(PREFERENCE);

    await expect(loadDailyCreditDrip()).resolves.toEqual({
      available: true,
      resolved: true,
      preference: PREFERENCE,
    });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledWith(
      DAILY_CREDIT_DRIP_PATH,
    );
  });

  it('reports unresolved, never a fabricated preference, for a malformed body', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue({ enabled: 'true' });

    await expect(loadDailyCreditDrip()).resolves.toEqual({
      available: true,
      resolved: false,
      preference: PLACEHOLDER,
    });
  });

  it.each([
    [
      'no cloud account',
      new MockCanopyCloudClientError('cloud-not-configured', 'x'),
    ],
    ['no api key', new MockCanopyCloudClientError('missing-api-key', 'x')],
    [
      'older web deploy (404)',
      new MockCanopyCloudClientError('http-error', 'x', 404),
    ],
    [
      'rejected credential (401)',
      new MockCanopyCloudClientError('http-error', 'x', 401),
    ],
    ['forbidden (403)', new MockCanopyCloudClientError('http-error', 'x', 403)],
  ])('reports unavailable for %s', async (_label, error) => {
    requestCanopyCloudJsonMock.mockRejectedValue(error);

    await expect(loadDailyCreditDrip()).resolves.toEqual({
      available: false,
      resolved: true,
      preference: PLACEHOLDER,
    });
  });

  it.each([
    ['a 5xx', new MockCanopyCloudClientError('http-error', 'x', 503)],
    ['a network failure', new Error('offline')],
  ])('reports unresolved for %s', async (_label, error) => {
    requestCanopyCloudJsonMock.mockRejectedValue(error);

    await expect(loadDailyCreditDrip()).resolves.toEqual({
      available: true,
      resolved: false,
      preference: PLACEHOLDER,
    });
  });

  it('returns frozen failure singletons', async () => {
    requestCanopyCloudJsonMock.mockRejectedValue(new Error('offline'));

    const state = await loadDailyCreditDrip();

    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.preference)).toBe(true);
  });

  it('PUTs only { enabled } and returns the parsed save result', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue(SAVED);

    await expect(saveDailyCreditDrip({ enabled: true })).resolves.toEqual(
      SAVED,
    );
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledWith(
      DAILY_CREDIT_DRIP_PATH,
      { method: 'PUT', body: JSON.stringify({ enabled: true }) },
    );
  });

  it('accepts a save whose post-save balance read failed', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue({
      ...SAVED,
      balanceCredits: null,
    });

    await expect(saveDailyCreditDrip({ enabled: true })).resolves.toEqual({
      ...SAVED,
      balanceCredits: null,
    });
  });

  it.each(['network_limit', 'network_unidentified'])(
    'carries an optional %s block reason through a save',
    async (blockedReason) => {
      const blocked = { ...SAVED, granted: 0, blockedReason };
      requestCanopyCloudJsonMock.mockResolvedValue(blocked);

      await expect(saveDailyCreditDrip({ enabled: true })).resolves.toEqual(
        blocked,
      );
    },
  );

  it('rejects a save response with an unknown block reason', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue({
      ...SAVED,
      granted: 0,
      blockedReason: 'unknown',
    });

    await expect(saveDailyCreditDrip({ enabled: true })).rejects.toEqual(
      expect.objectContaining({
        name: 'DailyCreditDripSaveError',
        unavailable: false,
      }),
    );
  });

  it('rejects a malformed save response', async () => {
    requestCanopyCloudJsonMock.mockResolvedValue(PREFERENCE);

    await expect(saveDailyCreditDrip({ enabled: true })).rejects.toEqual(
      expect.objectContaining({
        name: 'DailyCreditDripSaveError',
        unavailable: false,
      }),
    );
  });

  it('rejects as unavailable when the route is missing', async () => {
    requestCanopyCloudJsonMock.mockRejectedValue(
      new MockCanopyCloudClientError('http-error', 'x', 404),
    );

    const error = await saveDailyCreditDrip({ enabled: false }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DailyCreditDripSaveError);
    expect(error).toEqual(expect.objectContaining({ unavailable: true }));
  });

  it('rejects as a failure on a transient error', async () => {
    requestCanopyCloudJsonMock.mockRejectedValue(
      new MockCanopyCloudClientError('http-error', 'boom', 500),
    );

    await expect(saveDailyCreditDrip({ enabled: true })).rejects.toEqual(
      expect.objectContaining({ unavailable: false }),
    );
  });
});

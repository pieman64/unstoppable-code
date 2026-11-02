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
  invalidateMobileActivationCache,
  probeMobileActivation,
} from '../canopy-cloud/mobile-activation';

describe('probeMobileActivation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    invalidateMobileActivationCache();
  });

  it.each([true, false])(
    'returns the definitive activation answer %s',
    async (hasMobileActivation) => {
      requestCanopyCloudJsonMock.mockResolvedValue({ hasMobileActivation });

      await expect(probeMobileActivation()).resolves.toEqual({
        resolved: true,
        hasMobileActivation,
      });
      expect(requestCanopyCloudJsonMock).toHaveBeenCalledWith(
        '/api/v1/mobile-activation',
      );
    },
  );

  it('treats a 404 as a definitive non-activation', async () => {
    requestCanopyCloudJsonMock.mockRejectedValue(
      new MockCanopyCloudClientError('http-error', 'not found', 404),
    );

    await expect(probeMobileActivation()).resolves.toEqual({
      resolved: true,
      hasMobileActivation: false,
    });
  });

  it('returns unresolved on transient and offline failures', async () => {
    // Stepping the clock past the failure floor between the two probes so both
    // failure paths are actually exercised. Without it the second call
    // short-circuits on the floor and returns the same value without ever
    // reaching the mock, and the assertion would pass while testing nothing.
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    requestCanopyCloudJsonMock.mockRejectedValueOnce(
      new MockCanopyCloudClientError('http-error', 'server error', 503),
    );
    await expect(probeMobileActivation()).resolves.toEqual({
      resolved: false,
    });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(40_000);
    requestCanopyCloudJsonMock.mockRejectedValueOnce(new Error('offline'));
    await expect(probeMobileActivation()).resolves.toEqual({
      resolved: false,
    });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('holds failed re-probes to the same floor as successful ones', async () => {
    // A failure caches nothing, on purpose, so it can never overwrite a
    // definitive answer. That left the failure path with no floor at all:
    // against an endpoint that is down, offline, or answering 401 for a revoked
    // key, the renderer's focus/visibilitychange handlers issued one
    // authenticated request per foreground event for the life of the process.
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    requestCanopyCloudJsonMock.mockRejectedValue(
      new MockCanopyCloudClientError('http-error', 'server error', 503),
    );

    await expect(probeMobileActivation()).resolves.toEqual({ resolved: false });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    // Alt-tabbing repeatedly against a down endpoint: still fail-soft, still
    // `{ resolved: false }` so consumers keep last-known-good, but no traffic.
    now.mockReturnValue(20_000);
    await expect(
      probeMobileActivation({ forceRefresh: true }),
    ).resolves.toEqual({ resolved: false });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    // Past the floor, it genuinely retries — a recovered endpoint is found.
    now.mockReturnValue(32_000);
    requestCanopyCloudJsonMock.mockResolvedValueOnce({
      hasMobileActivation: true,
    });
    await expect(
      probeMobileActivation({ forceRefresh: true }),
    ).resolves.toEqual({ resolved: true, hasMobileActivation: true });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('clears the failure floor when the account changes', async () => {
    // A revoked or swapped key is the common reason for a failing probe, so an
    // account change must not have to wait out a floor set by the old one.
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    requestCanopyCloudJsonMock.mockRejectedValueOnce(
      new MockCanopyCloudClientError('http-error', 'unauthorized', 401),
    );
    await expect(probeMobileActivation()).resolves.toEqual({ resolved: false });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    invalidateMobileActivationCache();

    now.mockReturnValue(5_000);
    requestCanopyCloudJsonMock.mockResolvedValueOnce({
      hasMobileActivation: true,
    });
    await expect(probeMobileActivation()).resolves.toEqual({
      resolved: true,
      hasMobileActivation: true,
    });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('caches a definitive answer for about one minute', async () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    requestCanopyCloudJsonMock
      .mockResolvedValueOnce({ hasMobileActivation: false })
      .mockResolvedValueOnce({ hasMobileActivation: true });

    await expect(probeMobileActivation()).resolves.toMatchObject({
      hasMobileActivation: false,
    });
    now.mockReturnValue(60_999);
    await expect(probeMobileActivation()).resolves.toMatchObject({
      hasMobileActivation: false,
    });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(61_001);
    await expect(probeMobileActivation()).resolves.toMatchObject({
      hasMobileActivation: true,
    });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('holds a forced refresh to a floor, then bypasses the remaining TTL', async () => {
    // `forceRefresh` shortens the cache rather than discarding it. The renderer
    // forces a refresh on every focus/visibilitychange and nothing throttles
    // those for a signed-in, not-yet-activated account, so an unbounded bypass
    // is one authenticated round trip per alt-tab for the life of the process.
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    requestCanopyCloudJsonMock
      .mockResolvedValueOnce({ hasMobileActivation: false })
      .mockResolvedValueOnce({ hasMobileActivation: true });

    await expect(probeMobileActivation()).resolves.toMatchObject({
      hasMobileActivation: false,
    });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    // Inside the floor: alt-tabbing repeatedly must not generate traffic.
    now.mockReturnValue(20_000);
    await expect(
      probeMobileActivation({ forceRefresh: true }),
    ).resolves.toMatchObject({ hasMobileActivation: false });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    // Past the floor but still inside the ordinary TTL: this is what
    // `forceRefresh` is for — the user installed on their phone and came back.
    now.mockReturnValue(32_000);
    await expect(
      probeMobileActivation({ forceRefresh: true }),
    ).resolves.toMatchObject({ hasMobileActivation: true });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('coalesces concurrent forced foreground refreshes onto one request', async () => {
    let resolveRequest!: (value: { hasMobileActivation: boolean }) => void;
    requestCanopyCloudJsonMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const first = probeMobileActivation({ forceRefresh: true });
    const second = probeMobileActivation({ forceRefresh: true });
    expect(requestCanopyCloudJsonMock).toHaveBeenCalledTimes(1);

    resolveRequest({ hasMobileActivation: true });
    await expect(first).resolves.toMatchObject({ hasMobileActivation: true });
    await expect(second).resolves.toMatchObject({ hasMobileActivation: true });
  });
});

import type * as CanopyCloudClientModule from '../canopy-cloud/client';

interface SentRequestInit {
  method: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  credentialContext?: CanopyCloudClientModule.CanopyCloudCredentialContext;
}

const requestJsonMock = jest.fn<Promise<unknown>, [string, SentRequestInit]>();
const resolveCredentialsMock = jest.fn<
  Promise<CanopyCloudClientModule.CanopyCloudCredentialContext>,
  []
>();
const getVersionMock = jest.fn<string, []>();

jest.mock('electron', () => ({
  app: {
    get getVersion(): typeof getVersionMock {
      return getVersionMock;
    },
  },
}));

jest.mock('../canopy-cloud/client', () => {
  const actual = jest.requireActual<typeof CanopyCloudClientModule>(
    '../canopy-cloud/client',
  );
  return {
    CanopyCloudClientError: actual.CanopyCloudClientError,
    get requestCanopyCloudJson(): typeof requestJsonMock {
      return requestJsonMock;
    },
    get resolveCanopyCloudCredentialContext(): typeof resolveCredentialsMock {
      return resolveCredentialsMock;
    },
  };
});

import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  clearProductActivityRetryTimers,
  reportDesktopChatTurnActivity,
} from '../canopy-cloud/product-activity-events';

// sha256('turn-1'), the vector shared with the protocol and web tests.
const TURN_KEY =
  '974cad2dd603827b06e9e6affa3de03db5af2c12c045db679a7b1bef42b41a1c';
const ORGANIZATION_ID = 'e2e1a0c4-7d3b-4c2a-9f10-0000000c3561';
const ACCOUNT_A_CREDENTIALS = {
  baseUrl: 'https://account-a.example.test',
  apiKey: 'account-a-key',
};
const ACCOUNT_B_CREDENTIALS = {
  baseUrl: 'https://account-b.example.test',
  apiKey: 'account-b-key',
};
// Base delay plus the full jitter window.
const MAX_RETRY_DELAY_MS = 35_000;

function httpError(status: number): CanopyCloudClientError {
  return new CanopyCloudClientError('http-error', `HTTP ${status}`, status);
}

describe('reportDesktopChatTurnActivity', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    getVersionMock.mockReturnValue('0.26.8');
    resolveCredentialsMock.mockResolvedValue(ACCOUNT_A_CREDENTIALS);
  });

  afterEach(() => {
    clearProductActivityRetryTimers();
    jest.useRealTimers();
  });

  it('posts the turn key to the product-activity path as the desktop surface', async () => {
    requestJsonMock.mockResolvedValue({ accepted: true });

    await reportDesktopChatTurnActivity({
      turnKey: TURN_KEY,
      organizationExternalId: ORGANIZATION_ID,
    });

    expect(requestJsonMock).toHaveBeenCalledTimes(1);
    const [pathname, init] = requestJsonMock.mock.calls[0];
    expect(pathname).toBe('/api/v1/product-activity/turns');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(
      JSON.stringify({
        turnKey: TURN_KEY,
        organizationExternalId: ORGANIZATION_ID,
      }),
    );
    expect(init.headers).toEqual({
      'x-canopy-client': 'desktop',
      'x-canopy-client-version': '0.26.8',
    });
    expect(init.timeoutMs).toBeGreaterThan(0);
    expect(init.timeoutMs).toBeLessThanOrEqual(15_000);
  });

  it('omits the organization instead of serializing it as undefined', async () => {
    requestJsonMock.mockResolvedValue({ accepted: true });

    await reportDesktopChatTurnActivity({
      turnKey: TURN_KEY,
      organizationExternalId: undefined,
    });

    const [, init] = requestJsonMock.mock.calls[0];
    expect(init.body).toBe(`{"turnKey":"${TURN_KEY}"}`);
  });

  // The server answers 400 for these, which would drop the whole count.
  // Ownership must never block the signal, so the turn is sent without it.
  it.each(['', '   ', 'o'.repeat(129)])(
    'omits an organization the server contract rejects (%p)',
    async (organizationExternalId) => {
      requestJsonMock.mockResolvedValue({ accepted: true });

      await reportDesktopChatTurnActivity({
        turnKey: TURN_KEY,
        organizationExternalId,
      });

      const [, init] = requestJsonMock.mock.calls[0];
      expect(init.body).toBe(`{"turnKey":"${TURN_KEY}"}`);
    },
  );

  it('sends an organization at the contract length limit unchanged', async () => {
    requestJsonMock.mockResolvedValue({ accepted: true });
    const organizationExternalId = 'o'.repeat(128);

    await reportDesktopChatTurnActivity({
      turnKey: TURN_KEY,
      organizationExternalId,
    });

    const [, init] = requestJsonMock.mock.calls[0];
    expect(init.body).toBe(
      JSON.stringify({ turnKey: TURN_KEY, organizationExternalId }),
    );
  });

  it.each(['', '0.26.8 beta', 'v'.repeat(33), '1.0,2.0'])(
    'omits a version the shared parser rejects (%p)',
    async (version) => {
      getVersionMock.mockReturnValue(version);
      requestJsonMock.mockResolvedValue({ accepted: true });

      await reportDesktopChatTurnActivity({
        turnKey: TURN_KEY,
        organizationExternalId: undefined,
      });

      const [, init] = requestJsonMock.mock.calls[0];
      expect(init.headers).toEqual({ 'x-canopy-client': 'desktop' });
    },
  );

  it.each([
    [
      'missing credentials',
      new CanopyCloudClientError('missing-api-key', 'no key'),
    ],
    [
      'cloud not configured',
      new CanopyCloudClientError('cloud-not-configured', 'no cloud'),
    ],
    ['a 400 rejection', httpError(400)],
    ['an older server answering 404', httpError(404)],
    ['a 429 rate limit', httpError(429)],
  ])('drops the signal without retrying on %s', async (_label, error) => {
    requestJsonMock.mockRejectedValue(error);

    await expect(
      reportDesktopChatTurnActivity({
        turnKey: TURN_KEY,
        organizationExternalId: undefined,
      }),
    ).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(MAX_RETRY_DELAY_MS * 3);

    expect(requestJsonMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    [
      'a network failure or timeout',
      new CanopyCloudClientError('network-error', 'offline'),
    ],
    ['a 500', httpError(500)],
    ['a 503', httpError(503)],
  ])(
    'retries exactly once after about 30 seconds on %s',
    async (_label, error) => {
      requestJsonMock.mockRejectedValue(error);

      await reportDesktopChatTurnActivity({
        turnKey: TURN_KEY,
        organizationExternalId: ORGANIZATION_ID,
      });
      expect(requestJsonMock).toHaveBeenCalledTimes(1);

      // Nothing fires before the base delay elapses.
      await jest.advanceTimersByTimeAsync(29_999);
      expect(requestJsonMock).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(MAX_RETRY_DELAY_MS);
      expect(requestJsonMock).toHaveBeenCalledTimes(2);
      // The retry is the same request, and it does not schedule another.
      expect(requestJsonMock.mock.calls[1]).toEqual(
        requestJsonMock.mock.calls[0],
      );
      await jest.advanceTimersByTimeAsync(MAX_RETRY_DELAY_MS * 3);
      expect(requestJsonMock).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('keeps the original account when the signed-in account changes before retry', async () => {
    let currentCredentials = ACCOUNT_A_CREDENTIALS;
    resolveCredentialsMock.mockImplementation(() =>
      Promise.resolve(currentCredentials),
    );
    requestJsonMock
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({ accepted: true });

    await reportDesktopChatTurnActivity({
      turnKey: TURN_KEY,
      organizationExternalId: ORGANIZATION_ID,
    });
    currentCredentials = ACCOUNT_B_CREDENTIALS;
    await jest.advanceTimersByTimeAsync(MAX_RETRY_DELAY_MS);

    expect(resolveCredentialsMock).toHaveBeenCalledTimes(1);
    expect(requestJsonMock).toHaveBeenCalledTimes(2);
    expect(requestJsonMock.mock.calls[0]?.[1].credentialContext).toBe(
      ACCOUNT_A_CREDENTIALS,
    );
    expect(requestJsonMock.mock.calls[1]?.[1].credentialContext).toBe(
      ACCOUNT_A_CREDENTIALS,
    );
  });

  it('does not keep the process alive for a pending retry', async () => {
    // Real timers: the fake clock's handles do not share Node's prototype.
    jest.useRealTimers();
    const probe = setTimeout(() => undefined, 0);
    clearTimeout(probe);
    const unrefSpy = jest.spyOn(Object.getPrototypeOf(probe), 'unref');
    requestJsonMock.mockRejectedValue(httpError(503));

    try {
      await reportDesktopChatTurnActivity({
        turnKey: TURN_KEY,
        organizationExternalId: undefined,
      });
      expect(unrefSpy).toHaveBeenCalledTimes(1);
    } finally {
      // Cancels the real 30 second timer the retry scheduled.
      clearProductActivityRetryTimers();
      unrefSpy.mockRestore();
    }
  });

  it('cancels a pending retry when the timers are cleared', async () => {
    requestJsonMock.mockRejectedValue(httpError(503));

    await reportDesktopChatTurnActivity({
      turnKey: TURN_KEY,
      organizationExternalId: undefined,
    });
    expect(jest.getTimerCount()).toBe(1);

    clearProductActivityRetryTimers();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(MAX_RETRY_DELAY_MS * 3);
    expect(requestJsonMock).toHaveBeenCalledTimes(1);
  });

  it('schedules no retry for a request that fails after the timers are cleared', async () => {
    let fail: (error: Error) => void = () => undefined;
    requestJsonMock.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const pending = reportDesktopChatTurnActivity({
      turnKey: TURN_KEY,
      organizationExternalId: undefined,
    });

    // Disposal happens while the first attempt is still in flight.
    clearProductActivityRetryTimers();
    fail(httpError(503));
    await pending;

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(MAX_RETRY_DELAY_MS * 3);
    expect(requestJsonMock).toHaveBeenCalledTimes(1);
  });

  it('never rejects, even on an unexpected failure', async () => {
    requestJsonMock.mockRejectedValue(new Error('unexpected'));
    await expect(
      reportDesktopChatTurnActivity({
        turnKey: TURN_KEY,
        organizationExternalId: undefined,
      }),
    ).resolves.toBeUndefined();

    getVersionMock.mockImplementation(() => {
      throw new Error('app not ready');
    });
    await expect(
      reportDesktopChatTurnActivity({
        turnKey: TURN_KEY,
        organizationExternalId: undefined,
      }),
    ).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });
});

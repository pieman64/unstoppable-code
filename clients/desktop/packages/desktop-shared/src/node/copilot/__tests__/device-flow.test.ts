import {
  DeviceFlowRefreshRejectedError,
  pollDeviceFlow,
  refreshDeviceGrant,
  startDeviceFlow,
  type DeviceFlowOptions,
  type DeviceFlowStart,
} from '../device-flow';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GitHub device flow', () => {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const sleeps: number[] = [];
  let answers: Array<() => Response>;
  let now = 1_000_000;
  const options: DeviceFlowOptions = {
    clientId: 'Iv23test',
    fetch: (input, init): Promise<Response> => {
      calls.push({
        url:
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        body: new URLSearchParams(
          typeof init?.body === 'string' ? init.body : '',
        ),
      });
      const next = answers.shift();
      if (!next) throw new Error('unexpected fetch');
      return Promise.resolve(next());
    },
    now: (): number => now,
    sleep: (ms, signal): Promise<void> => {
      sleeps.push(ms);
      signal.throwIfAborted();
      return Promise.resolve();
    },
  };
  const start = (): DeviceFlowStart => ({
    deviceCode: 'dc',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    expiresAt: new Date(now + 900_000).toISOString(),
    intervalMs: 5000,
  });
  beforeEach(() => {
    calls.length = 0;
    sleeps.length = 0;
    now = 1_000_000;
    answers = [];
  });

  it('starts a flow with the client id only and computes the expiry', async () => {
    answers = [
      (): Response =>
        response({
          device_code: 'dc',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
    ];
    const started = await startDeviceFlow(
      options,
      new AbortController().signal,
    );
    expect(calls[0].url).toBe('https://github.com/login/device/code');
    expect(calls[0].body.get('client_id')).toBe('Iv23test');
    expect(calls[0].body.has('client_secret')).toBe(false);
    expect(started).toEqual({
      deviceCode: 'dc',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresAt: new Date(1_000_000 + 900_000).toISOString(),
      intervalMs: 5000,
    });
  });

  it('polls until granted, backing off on slow_down', async () => {
    answers = [
      (): Response => response({ error: 'authorization_pending' }),
      (): Response => response({ error: 'slow_down', interval: 10 }),
      (): Response =>
        response({
          access_token: 'ghu_x',
          token_type: 'bearer',
          expires_in: 28_800,
          refresh_token: 'ghr_x',
          refresh_token_expires_in: 15_724_800,
        }),
    ];
    const outcome = await pollDeviceFlow(
      options,
      start(),
      new AbortController().signal,
    );
    expect(sleeps).toEqual([5000, 5000, 10_000]);
    expect(calls[0].body.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
    expect(outcome).toEqual({
      status: 'granted',
      grant: {
        accessToken: 'ghu_x',
        accessTokenExpiresAt: new Date(now + 28_800_000).toISOString(),
        refreshToken: 'ghr_x',
        refreshTokenExpiresAt: new Date(now + 15_724_800_000).toISOString(),
      },
    });
  });

  it('reports declined and expired without throwing', async () => {
    answers = [(): Response => response({ error: 'access_denied' })];
    await expect(
      pollDeviceFlow(options, start(), new AbortController().signal),
    ).resolves.toEqual({ status: 'declined' });
    answers = [(): Response => response({ error: 'expired_token' })];
    await expect(
      pollDeviceFlow(options, start(), new AbortController().signal),
    ).resolves.toEqual({ status: 'expired' });
  });

  it('treats a passed expiry as expired without another request', async () => {
    await expect(
      pollDeviceFlow(
        options,
        { ...start(), expiresAt: new Date(now - 1).toISOString() },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: 'expired' });
    expect(calls).toHaveLength(0);
  });

  it('stops polling when cancelled', async () => {
    const controller = new AbortController();
    answers = [
      (): Response => {
        controller.abort();
        return response({ error: 'authorization_pending' });
      },
    ];
    await expect(
      pollDeviceFlow(options, start(), controller.signal),
    ).rejects.toThrow(/abort/i);
    expect(calls).toHaveLength(1);
  });

  it('refreshes and distinguishes a rejected grant from a network failure', async () => {
    answers = [
      (): Response =>
        response({
          access_token: 'ghu_y',
          expires_in: 28_800,
          refresh_token: 'ghr_y',
          refresh_token_expires_in: 100,
        }),
    ];
    await expect(
      refreshDeviceGrant(options, 'ghr_x', new AbortController().signal),
    ).resolves.toMatchObject({ accessToken: 'ghu_y', refreshToken: 'ghr_y' });
    expect(calls[0].body.get('grant_type')).toBe('refresh_token');
    answers = [(): Response => response({ error: 'bad_refresh_token' })];
    await expect(
      refreshDeviceGrant(options, 'ghr_x', new AbortController().signal),
    ).rejects.toBeInstanceOf(DeviceFlowRefreshRejectedError);
    answers = [(): Response => response({ message: 'down' }, 503)];
    await expect(
      refreshDeviceGrant(options, 'ghr_x', new AbortController().signal),
    ).rejects.not.toBeInstanceOf(DeviceFlowRefreshRejectedError);
  });

  it('treats a 400 or 401 refresh response as a rejected grant', async () => {
    for (const status of [400, 401]) {
      answers = [(): Response => response({ error: 'invalid_client' }, status)];
      await expect(
        refreshDeviceGrant(options, 'ghr_x', new AbortController().signal),
      ).rejects.toBeInstanceOf(DeviceFlowRefreshRejectedError);
    }
  });

  it('keeps the grant when the refresh is throttled or challenged by a proxy', async () => {
    for (const status of [403, 407, 408, 429]) {
      answers = [(): Response => response({ message: 'later' }, status)];
      await expect(
        refreshDeviceGrant(options, 'ghr_x', new AbortController().signal),
      ).rejects.not.toBeInstanceOf(DeviceFlowRefreshRejectedError);
    }
  });

  it('rides out a few transient failures while polling', async () => {
    answers = [
      (): Response => {
        throw new TypeError('fetch failed');
      },
      (): Response => response({ message: 'down' }, 503),
      (): Response => response({ error: 'authorization_pending' }),
      (): Response =>
        response({
          access_token: 'ghu_z',
          expires_in: 28_800,
          refresh_token: 'ghr_z',
          refresh_token_expires_in: 100,
        }),
    ];
    await expect(
      pollDeviceFlow(options, start(), new AbortController().signal),
    ).resolves.toMatchObject({ status: 'granted' });
    expect(calls).toHaveLength(4);
  });

  it('gives up polling after repeated transient failures', async () => {
    answers = Array.from(
      { length: 4 },
      () => (): Response => response({ message: 'down' }, 503),
    );
    await expect(
      pollDeviceFlow(options, start(), new AbortController().signal),
    ).rejects.toThrow('503');
  });

  it('uses the override base URL for every endpoint', async () => {
    answers = [
      (): Response =>
        response({
          device_code: 'dc',
          user_code: 'X',
          verification_uri: 'http://127.0.0.1:4011/login/device',
          expires_in: 10,
          interval: 1,
        }),
    ];
    await startDeviceFlow(
      { ...options, baseUrl: 'http://127.0.0.1:4011' },
      new AbortController().signal,
    );
    expect(calls[0].url).toBe('http://127.0.0.1:4011/login/device/code');
  });
});

/**
 * Transport-level error decoding for the Canopy Cloud client.
 *
 * The load-bearing case is the org data-sharing rejection: the web ingest route
 * answers a prohibited scope with a 403 whose JSON body carries BOTH a
 * human-readable `error` string and a machine-readable
 * `code: 'telemetry_scope_prohibited'`. The telemetry sync service branches on
 * that code to poison the batch and re-probe enforcement instead of retrying
 * forever.
 *
 * Before this coverage existed the transport dropped the body's `code` on the
 * floor and the sync service substring-matched the message instead — which
 * never fires, because the server's `error` prose does not contain the code.
 * These tests pin the code all the way through the transport so that regression
 * cannot come back silently.
 */

import type * as CanopyCloudConfigModule from '../canopy-cloud/config';

const getCanopyCloudCredentialsMock = jest.fn();
const mergeCanopyCloudAccountCapabilitiesMock = jest.fn();
jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: getCanopyCloudCredentialsMock,
  mergeCanopyCloudAccountCapabilities: mergeCanopyCloudAccountCapabilitiesMock,
}));
jest.mock('../canopy-cloud/config', () => ({
  ...jest.requireActual<typeof CanopyCloudConfigModule>(
    '../canopy-cloud/config',
  ),
  getCanopyCloudBaseUrl: (): string => 'https://cloud.example.test',
}));

import {
  assertCanopyCloudCapability,
  CanopyCloudClientError,
  createMemberOrgProject,
  requestCanopyCloudJson,
  requestCanopyCloudJsonConditional,
  requestCanopyCloudNoContent,
  requestCanopyCloudPublicBinary,
  requestCanopyCloudPublicJson,
} from '../canopy-cloud/client';
import { trackCloudWrites } from '../canopy-cloud/cloud-write-tracking';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('canopy cloud client error decoding', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mergeCanopyCloudAccountCapabilitiesMock.mockResolvedValue(null);
    getCanopyCloudCredentialsMock.mockResolvedValue({
      baseUrl: 'https://cloud.example.test',
      apiKey: 'test-key',
      capabilities: [],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  function stubFetch(response: Response): void {
    global.fetch = jest.fn().mockResolvedValue(response);
  }

  it('marks a failed read, and only a read, as unable to change the server', async () => {
    stubFetch(jsonResponse(403, { error: 'Forbidden' }));
    const readError: unknown = await requestCanopyCloudJson('/api/teams').catch(
      (error: unknown) => error,
    );
    expect(readError).toBeInstanceOf(CanopyCloudClientError);
    expect(
      readError instanceof CanopyCloudClientError && readError.failedRead,
    ).toBe(true);

    stubFetch(jsonResponse(403, { error: 'Forbidden' }));
    const writeError: unknown = await requestCanopyCloudJson('/api/skills', {
      method: 'POST',
      body: '{}',
    }).catch((error: unknown) => error);
    expect(
      writeError instanceof CanopyCloudClientError && writeError.failedRead,
    ).toBe(false);
  });

  it('records a sent write, and only a write, on the tracked operation', async () => {
    stubFetch(jsonResponse(200, { ok: true }));
    const read = trackCloudWrites(() => requestCanopyCloudJson('/api/teams'));
    await read.result;
    expect(read.writeSent()).toBe(false);

    stubFetch(jsonResponse(403, { error: 'Forbidden' }));
    const write = trackCloudWrites(() =>
      requestCanopyCloudJson('/api/skills', { method: 'POST', body: '{}' }),
    );
    await write.result.catch(() => undefined);
    // A refused write still reached the server, so the operation counts it.
    expect(write.writeSent()).toBe(true);
  });

  it('marks a read cancelled during its retry wait as a failed read', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(503, { error: 'Unavailable' }));

    const request = requestCanopyCloudJson('/api/teams', {
      signal: controller.signal,
    }).catch((error: unknown): unknown => error);
    await jest.advanceTimersByTimeAsync(0);
    controller.abort();
    const error = await request;

    expect(error).toBeInstanceOf(CanopyCloudClientError);
    expect(error instanceof CanopyCloudClientError && error.failedRead).toBe(
      true,
    );
  });

  it('maps the member-project cap and does not retry the POST', async () => {
    stubFetch(
      jsonResponse(409, {
        error: 'Member project limit reached',
        code: 'member_project_limit',
      }),
    );

    await expect(
      createMemberOrgProject({
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        kind: 'COWORK',
        name: 'Notes',
      }),
    ).resolves.toEqual({ ok: false, code: 'limit-reached' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['repository_project_exists', 'repository-project-exists'],
    ['member_project_exists', 'member-project-exists'],
  ] as const)(
    'maps the member Code project conflict %s',
    async (serverCode, code) => {
      stubFetch(jsonResponse(409, { error: 'Conflict', code: serverCode }));

      await expect(
        createMemberOrgProject({
          organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          kind: 'CODE',
          name: 'Payments',
          repository: {
            host: 'github.com',
            owner: 'acme',
            name: 'payments',
          },
        }),
      ).resolves.toEqual({ ok: false, code });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('uses one supplied credential context for a no-content request', async () => {
    stubFetch(new Response(null, { status: 204 }));
    const credentialContext = {
      baseUrl: 'https://initiating-account.example.test',
      apiKey: 'initiating-account-key',
      capabilities: ['shared-containers-v1'],
    };

    await requestCanopyCloudNoContent('/api/v1/shared-containers/one/dismiss', {
      method: 'DELETE',
      credentialContext,
    });

    expect(getCanopyCloudCredentialsMock).not.toHaveBeenCalled();
    const [url, requestInit] = jest.mocked(global.fetch).mock.calls[0] ?? [];
    expect(url).toBe(
      'https://initiating-account.example.test/api/v1/shared-containers/one/dismiss',
    );
    expect(requestInit?.method).toBe('DELETE');
    expect(new Headers(requestInit?.headers).get('Authorization')).toBe(
      'Bearer initiating-account-key',
    );
  });

  it("lifts the body's machine-readable `code` onto `serverCode`", async () => {
    stubFetch(
      jsonResponse(403, {
        error: 'Your organization prohibits sharing transcripts',
        code: 'telemetry_scope_prohibited',
        scope: 'transcripts',
      }),
    );

    const error: unknown = await requestCanopyCloudJson(
      '/api/v1/x/telemetry/ingest',
      {
        method: 'POST',
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CanopyCloudClientError);
    const clientError = error as CanopyCloudClientError;
    expect(clientError.status).toBe(403);
    expect(clientError.serverCode).toBe('telemetry_scope_prohibited');
    expect(clientError.isValidatedServerError).toBe(true);
    // `code` stays the TRANSPORT classification, distinct from `serverCode`.
    expect(clientError.code).toBe('http-error');
    // The human-readable message deliberately does NOT carry the code. This is
    // the assertion that makes a substring match a provably broken strategy.
    expect(clientError.message).not.toContain('telemetry_scope_prohibited');
    expect(clientError.message).toContain(
      'Your organization prohibits sharing transcripts',
    );
  });

  // The body is single-use. Decoding it with `response.json()` first and then
  // falling back to `response.text()` drains the stream, so a structured body
  // that carries ONLY the code (no `error` prose) used to lose the code on the
  // way out — the exact signal the sync service branches on.
  it('lifts `code` from a body with no `error` string', async () => {
    stubFetch(
      jsonResponse(403, {
        code: 'telemetry_scope_prohibited',
        scope: 'transcripts',
      }),
    );

    const error: unknown = await requestCanopyCloudJson(
      '/api/v1/x/telemetry/ingest',
      { method: 'POST' },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CanopyCloudClientError);
    const clientError = error as CanopyCloudClientError;
    expect(clientError.serverCode).toBe('telemetry_scope_prohibited');
    expect(clientError.status).toBe(403);
    // With no prose to show, the message degrades to the status line rather
    // than dumping the raw JSON body at the user.
    expect(clientError.message).toContain('403');
  });

  it('lifts a refused header name onto `serverHeader`', async () => {
    stubFetch(
      jsonResponse(400, {
        error: 'invalid_request',
        code: 'invalid_headers',
        header: 'Cookie',
      }),
    );
    await expect(
      requestCanopyCloudJson('/api/v1/mcp-connections', { method: 'POST' }),
    ).rejects.toMatchObject({
      serverCode: 'invalid_headers',
      serverHeader: 'Cookie',
    });
    stubFetch(
      jsonResponse(400, {
        error: 'invalid_request',
        code: 'invalid_headers',
        header: 'x'.repeat(257),
      }),
    );
    const unnamed: unknown = await requestCanopyCloudJson(
      '/api/v1/mcp-connections',
      { method: 'POST' },
    ).catch((caught: unknown) => caught);
    expect(unnamed).toHaveProperty('serverHeader', undefined);
  });

  it('lifts the OAuth app setup a refused MCP connection start carries', async () => {
    const clientSetup = {
      redirectUri:
        'https://app.example.test/api/mcp-connections/callback/issuer-key',
      issuer: 'https://accounts.example.test',
      clientSecretRequired: true,
      clientSecretAccepted: false,
    };
    stubFetch(
      jsonResponse(400, {
        error: 'client_credentials_required',
        code: 'client_credentials_required',
        clientSetup,
      }),
    );
    await expect(
      requestCanopyCloudJson('/api/v1/mcp-connections', { method: 'POST' }),
    ).rejects.toMatchObject({
      serverCode: 'client_credentials_required',
      serverClientSetup: clientSetup,
    });
    stubFetch(
      jsonResponse(400, {
        error: 'client_credentials_required',
        code: 'client_credentials_required',
        clientSetup: { ...clientSetup, redirectUri: 'javascript:alert(1)' },
      }),
    );
    const malformed: unknown = await requestCanopyCloudJson(
      '/api/v1/mcp-connections',
      { method: 'POST' },
    ).catch((caught: unknown) => caught);
    expect(malformed).toHaveProperty('serverClientSetup', undefined);
  });

  it.each([true, false])(
    'lifts desktopSignIn %p a refused MCP connection start carries',
    async (desktopSignIn) => {
      stubFetch(
        jsonResponse(400, {
          error: 'sign_in_unavailable',
          code: 'sign_in_unavailable',
          desktopSignIn,
        }),
      );
      await expect(
        requestCanopyCloudJson('/api/v1/mcp-connections', { method: 'POST' }),
      ).rejects.toMatchObject({
        serverCode: 'sign_in_unavailable',
        serverDesktopSignIn: desktopSignIn,
      });
    },
  );

  it('ignores a desktopSignIn that is not a boolean', async () => {
    stubFetch(
      jsonResponse(400, {
        error: 'sign_in_unavailable',
        code: 'sign_in_unavailable',
        desktopSignIn: 'yes',
      }),
    );
    const refused: unknown = await requestCanopyCloudJson(
      '/api/v1/mcp-connections',
      { method: 'POST' },
    ).catch((caught: unknown) => caught);
    expect(refused).toHaveProperty('serverDesktopSignIn', undefined);
  });

  it('reads the standard nested error envelope', async () => {
    stubFetch(
      jsonResponse(503, {
        error: {
          code: 'database_unavailable',
          message: 'Service temporarily unavailable. Try again shortly.',
        },
      }),
    );

    const error: unknown = await requestCanopyCloudJson('/api/v1/x/thing', {
      method: 'POST',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CanopyCloudClientError);
    expect(error).toMatchObject({
      status: 503,
      serverCode: 'database_unavailable',
      isValidatedServerError: true,
    });
    expect((error as Error).message).toContain(
      'Service temporarily unavailable. Try again shortly.',
    );
  });

  // A JSON content-type on a body that is not actually JSON must not swallow
  // the body: the raw text is the only diagnostic left.
  it('falls back to the raw text when a JSON content-type body will not parse', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const error: unknown = await requestCanopyCloudJson('/api/v1/x/thing', {
      method: 'POST',
    }).catch((caught: unknown) => caught);

    const clientError = error as CanopyCloudClientError;
    expect(clientError.serverCode).toBeUndefined();
    expect(clientError.isValidatedServerError).toBe(false);
    expect(clientError.message).toContain('502 Bad Gateway');
  });

  it('leaves `serverCode` undefined when the body carries no code', async () => {
    stubFetch(jsonResponse(403, { error: 'Forbidden' }));

    const error: unknown = await requestCanopyCloudJson('/api/v1/x/thing', {
      method: 'POST',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CanopyCloudClientError);
    const clientError = error as CanopyCloudClientError;
    expect(clientError.serverCode).toBeUndefined();
    expect(clientError.isValidatedServerError).toBe(true);
  });

  it('lifts a lapse `reason`, its organization and the request id', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          error: 'Subscribe to Business.',
          code: 'telemetry_scope_prohibited',
          reason: 'org_teams_lapsed',
          organizationId: 'org-ext-10',
        }),
        {
          status: 403,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req_123',
          },
        },
      ),
    );

    const error: unknown = await requestCanopyCloudJson('/api/v1/x/thing', {
      method: 'POST',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CanopyCloudClientError);
    expect(error).toMatchObject({
      serverCode: 'telemetry_scope_prohibited',
      serverReason: 'org_teams_lapsed',
      serverOrganizationId: 'org-ext-10',
      requestId: 'req_123',
    });
  });

  it('drops a `reason` that is not an identifier', async () => {
    stubFetch(
      jsonResponse(403, { error: 'Forbidden', reason: '<b>lapsed</b>' }),
    );

    const error: unknown = await requestCanopyCloudJson('/api/v1/x/thing', {
      method: 'POST',
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      serverReason: undefined,
      requestId: undefined,
    });
  });

  it('leaves `serverCode` undefined for a non-JSON error body', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('upstream exploded', {
        status: 502,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const error: unknown = await requestCanopyCloudJson('/api/v1/x/thing', {
      method: 'POST',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CanopyCloudClientError);
    const clientError = error as CanopyCloudClientError;
    expect(clientError.serverCode).toBeUndefined();
    expect(clientError.isValidatedServerError).toBe(false);
    expect(clientError.message).toContain('upstream exploded');
  });

  it('ignores a non-string `code` rather than coercing it', async () => {
    stubFetch(jsonResponse(400, { error: 'Bad request', code: 42 }));

    const error: unknown = await requestCanopyCloudJson(
      '/api/v1/x/thing',
    ).catch((caught: unknown) => caught);

    expect((error as CanopyCloudClientError).serverCode).toBeUndefined();
  });

  it('keeps the request timeout active until the JSON body is consumed', async () => {
    jest.useFakeTimers();
    let requestSignal: AbortSignal | null = null;
    let releaseBody!: () => void;
    const body = new Promise<unknown>((resolve) => {
      releaseBody = (): void => resolve({ ok: true });
    });
    const response = jsonResponse(200, { ok: true });
    jest.spyOn(response, 'json').mockImplementation(() => body);
    global.fetch = jest.fn((_input, init): Promise<Response> => {
      requestSignal = init?.signal ?? null;
      return Promise.resolve(response);
    });

    const request = requestCanopyCloudJson('/api/v1/x/slow-body', {
      timeoutMs: 25,
    });
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(25);

    expect(requestSignal?.aborted).toBe(true);
    releaseBody();
    await request;
  });

  it('merges a discovered capability only into the account that made the request', async () => {
    stubFetch(jsonResponse(200, { capabilities: ['shared-containers-v1'] }));

    await assertCanopyCloudCapability('shared-containers-v1');

    expect(mergeCanopyCloudAccountCapabilitiesMock).toHaveBeenCalledWith(
      ['shared-containers-v1'],
      'test-key',
    );
  });

  it('does not block capability assertion on the best-effort account merge', async () => {
    jest.useFakeTimers();
    stubFetch(jsonResponse(200, { capabilities: ['shared-containers-v1'] }));
    let markMergeStarted!: () => void;
    const mergeStarted = new Promise<void>((resolve) => {
      markMergeStarted = resolve;
    });
    let releaseMerge!: () => void;
    mergeCanopyCloudAccountCapabilitiesMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          markMergeStarted();
          releaseMerge = resolve;
        }),
    );

    const assertion = assertCanopyCloudCapability('shared-containers-v1');
    const outcome = Promise.race([
      assertion.then(() => 'resolved'),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), 1_000);
      }),
    ]);
    await mergeStarted;
    await jest.advanceTimersByTimeAsync(1_000);
    const settledOutcome = await outcome;
    releaseMerge();
    await assertion;

    expect(settledOutcome).toBe('resolved');
  });

  describe('bounded GET retry', () => {
    it.each(['transport', '503'])(
      'retries a conditional GET after a %s failure',
      async (failure): Promise<void> => {
        jest.useFakeTimers();
        const fetch = jest.fn<
          Promise<Response>,
          [string | URL | Request, RequestInit?]
        >();
        if (failure === 'transport') {
          fetch.mockRejectedValueOnce(new TypeError('offline'));
        } else {
          fetch.mockResolvedValueOnce(
            jsonResponse(503, { error: 'Unavailable' }),
          );
        }
        fetch.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
        global.fetch = fetch;

        const request = requestCanopyCloudJsonConditional('/api/v1/read', {
          etag: '"cached"',
        }).catch((error: unknown): unknown => error);
        await jest.advanceTimersByTimeAsync(400);

        await expect(request).resolves.toEqual({
          status: 'fresh',
          body: { ok: true },
          etag: null,
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        for (const [, init] of fetch.mock.calls) {
          expect(new Headers(init?.headers).get('If-None-Match')).toBe(
            '"cached"',
          );
        }
      },
    );

    it('bounds conditional GET failures to three attempts', async (): Promise<void> => {
      jest.useFakeTimers();
      global.fetch = jest
        .fn()
        .mockImplementation(
          (): Promise<Response> =>
            Promise.resolve(jsonResponse(503, { error: 'Unavailable' })),
        );
      const request = requestCanopyCloudJsonConditional('/api/v1/read', {
        etag: null,
      }).catch((error: unknown): unknown => error);
      await jest.advanceTimersByTimeAsync(1_900);

      await expect(request).resolves.toMatchObject({ status: 503 });
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('returns not-modified without retrying a conditional GET', async (): Promise<void> => {
      stubFetch(new Response(null, { status: 304 }));
      await expect(
        requestCanopyCloudJsonConditional('/api/v1/read', {
          etag: '"cached"',
        }),
      ).resolves.toEqual({ status: 'not-modified' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('retries a GET after the helper timeout expires', async () => {
      jest.useFakeTimers();
      global.fetch = jest
        .fn()
        .mockImplementationOnce(
          (_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => {
                  const error = new Error('timed out');
                  error.name = 'AbortError';
                  reject(error);
                },
                { once: true },
              );
            }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

      const request = requestCanopyCloudJson<{ ok: boolean }>('/api/v1/read', {
        timeoutMs: 25,
      }).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(25);
      await jest.advanceTimersByTimeAsync(400);

      await expect(request).resolves.toEqual({ ok: true });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('honors Retry-After for a 503 and then succeeds', async () => {
      jest.useFakeTimers();
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: 'Service temporarily unavailable. Try again shortly.',
              code: 'database_unavailable',
            }),
            {
              status: 503,
              headers: {
                'content-type': 'application/json',
                'retry-after': '1',
              },
            },
          ),
        )
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

      const request = requestCanopyCloudJson<{ ok: boolean }>('/api/v1/read');
      await jest.advanceTimersByTimeAsync(999);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);

      await expect(request).resolves.toEqual({ ok: true });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('retries a network failure on a GET', async () => {
      jest.useFakeTimers();
      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

      const request = requestCanopyCloudJson<{ ok: boolean }>('/api/v1/read');
      await jest.advanceTimersByTimeAsync(400);

      await expect(request).resolves.toEqual({ ok: true });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('retries a transient response for a public JSON GET', async () => {
      jest.useFakeTimers();
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, { error: 'Unavailable' }))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

      const request = requestCanopyCloudPublicJson<{ ok: boolean }>(
        '/api/v1/public/read',
      ).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(400);

      await expect(request).resolves.toEqual({ ok: true });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('retries a network failure for a public binary GET', async () => {
      jest.useFakeTimers();
      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));

      const request = requestCanopyCloudPublicBinary(
        '/api/v1/public/archive',
      ).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(400);

      await expect(request).resolves.toEqual(Buffer.from([1, 2, 3]));
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry an HTTP 500', async () => {
      stubFetch(jsonResponse(500, { error: 'Internal server error' }));

      await expect(
        requestCanopyCloudJson('/api/v1/read'),
      ).rejects.toMatchObject({ status: 500 });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry a POST that receives a 503', async () => {
      stubFetch(jsonResponse(503, { error: 'Unavailable' }));

      await expect(
        requestCanopyCloudJson('/api/v1/write', {
          method: 'POST',
          body: JSON.stringify({ value: 1 }),
        }),
      ).rejects.toMatchObject({ status: 503 });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry a validated 4xx response', async () => {
      stubFetch(jsonResponse(403, { error: 'Forbidden' }));

      await expect(
        requestCanopyCloudJson('/api/v1/read'),
      ).rejects.toMatchObject({ status: 403, isValidatedServerError: true });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry after the caller aborts', async () => {
      const controller = new AbortController();
      controller.abort();
      const abortError = new Error('cancelled');
      abortError.name = 'AbortError';
      global.fetch = jest.fn().mockRejectedValue(abortError);

      await expect(
        requestCanopyCloudJson('/api/v1/read', {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: 'network-error' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('stops after two retries and propagates the last failure', async () => {
      jest.useFakeTimers();
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, { error: 'first' }))
        .mockResolvedValueOnce(jsonResponse(503, { error: 'second' }))
        .mockResolvedValueOnce(jsonResponse(504, { error: 'last' }));

      const request = requestCanopyCloudJson('/api/v1/read').catch(
        (error: unknown) => error,
      );
      await jest.advanceTimersByTimeAsync(400);
      await jest.advanceTimersByTimeAsync(1_500);

      await expect(request).resolves.toMatchObject({ status: 504 });
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });
});

it('carries the current model-library protocol claim alongside authenticated owner headers', async () => {
  getCanopyCloudCredentialsMock.mockReturnValue({
    baseUrl: 'https://cloud.example.test',
    apiKey: 'csk_fixture',
  });
  const fetchMock = jest
    .fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>()
    .mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const previousFetch = global.fetch;
  global.fetch = fetchMock;
  try {
    await requestCanopyCloudJson('/api/v1/fixture', {
      headers: { 'x-canopy-work-owner': 'personal' },
    });
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-canopy-model-library-protocol')).toBe('1');
    expect(headers.get('x-canopy-work-owner')).toBe('personal');
    expect(headers.get('authorization')).toBe('Bearer csk_fixture');
  } finally {
    global.fetch = previousFetch;
  }
});

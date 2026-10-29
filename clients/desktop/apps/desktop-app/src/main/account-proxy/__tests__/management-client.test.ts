import {
  AccountProxyManagementError,
  requestAccountProxyManagement,
} from '../management-client';

function response(
  status: number,
  body: string,
  headers: Record<string, string> = { 'x-cpa-version': '8.0.27' },
): Response {
  return new Response(body, { status, headers });
}

const REQUEST = {
  baseUrl: 'https://proxy.example.com',
  managementKey: 'mk-test',
  method: 'GET',
  path: '/credentials',
} as const;

describe('requestAccountProxyManagement', () => {
  const fetchMock = jest.fn<Promise<Response>, Parameters<typeof fetch>>();

  beforeEach(() => {
    fetchMock.mockReset();
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function codeFor(next: Response | Error): Promise<string> {
    if (next instanceof Error) fetchMock.mockRejectedValueOnce(next);
    else fetchMock.mockResolvedValueOnce(next);
    try {
      await requestAccountProxyManagement(REQUEST);
      return 'ok';
    } catch (error) {
      return error instanceof AccountProxyManagementError
        ? error.code
        : 'other';
    }
  }

  it('sends the key as a bearer token to the v8 path and parses JSON', async () => {
    fetchMock.mockResolvedValueOnce(response(200, '{"files":[]}'));
    await expect(requestAccountProxyManagement(REQUEST)).resolves.toEqual({
      version: '8.0.27',
      body: { files: [] },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://proxy.example.com/v8/management/credentials');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer mk-test',
    );
    expect(init?.redirect).toBe('error');
  });

  it('keeps nested provider refusals separate from management HTTP status', async () => {
    for (const statusCode of [401, 429]) {
      const body = { status_code: statusCode, header: {}, body: '{}' };
      fetchMock.mockResolvedValueOnce(response(200, JSON.stringify(body)));
      await expect(
        requestAccountProxyManagement({
          ...REQUEST,
          method: 'POST',
          path: '/requests/api-call',
          body: { auth_index: 'account-1', method: 'GET' },
        }),
      ).resolves.toEqual({ version: '8.0.27', body });
    }
    expect(await codeFor(response(401, '{"status_code":200}'))).toBe(
      'unauthorized',
    );
  });

  it('treats a rejection as a rejection when its body cannot be read', async () => {
    function brokenBody(status: number): Response {
      const body = new ReadableStream<Uint8Array>({
        pull(controller): void {
          controller.error(new TypeError('terminated'));
        },
      });
      return new Response(body, {
        status,
        headers: { 'x-cpa-version': '8.0.27' },
      });
    }
    expect(await codeFor(brokenBody(401))).toBe('unauthorized');
    expect(await codeFor(brokenBody(403))).toBe('unauthorized');
    // Other answers whose body is cut off read as a dropped connection.
    expect(await codeFor(brokenBody(200))).toBe('unreachable');
  });

  it('sends nothing for a caller that was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestAccountProxyManagement({ ...REQUEST, signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps the proxy answers to error codes', async () => {
    expect(
      await codeFor(response(401, '{"error":"invalid management key"}')),
    ).toBe('unauthorized');
    expect(
      await codeFor(
        response(
          403,
          '{"error":"IP banned due to too many failed attempts. Try again in 30m0s"}',
        ),
      ),
    ).toBe('blocked');
    expect(
      await codeFor(response(403, '{"error":"remote management disabled"}')),
    ).toBe('remote-management-disabled');
    expect(await codeFor(response(404, '404 page not found'))).toBe(
      'management-disabled',
    );
    expect(await codeFor(response(500, 'oops'))).toBe('unexpected');
  });

  it('tells another server and an old proxy apart from a wrong key', async () => {
    expect(await codeFor(response(401, 'no', {}))).toBe('not-proxy');
    expect(
      await codeFor(response(200, '{}', { 'x-cpa-version': '6.9.4' })),
    ).toBe('too-old');
  });

  it('stops reading a response that grows past the size limit', async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const body = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulled += 1;
        if (pulled > 64) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel(): void {
        cancelled = true;
      },
    });
    expect(
      await codeFor(
        new Response(body, {
          status: 200,
          headers: { 'x-cpa-version': '8.0.27' },
        }),
      ),
    ).toBe('unexpected');
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(16);
  });

  it('does not read the body of a server that is not a proxy', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller): void {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    expect(await codeFor(new Response(body, { status: 200 }))).toBe(
      'not-proxy',
    );
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('reports network failures as unreachable', async () => {
    expect(await codeFor(new TypeError('fetch failed'))).toBe('unreachable');
  });
});

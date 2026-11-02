import { MCP_MAX_RESPONSE_BYTES } from '@canopy/mcp-oauth-core';
import { probeMcpHttpOAuthRequirement } from '../mcp/oauth-probe';

const fetchMock = jest.fn<
  Promise<Response>,
  [RequestInfo | URL, RequestInit?]
>();

function initializeResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'test-server', version: '1.0.0' },
      },
    }),
    { status: 200 },
  );
}

function initializePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'test-server', version: '1.0.0' },
    },
    ...overrides,
  };
}

function cancellableResponse(
  status: number,
  options: {
    headers?: Record<string, string>;
    redirected?: boolean;
  } = {},
): { cancel: jest.Mock; response: Response } {
  const cancel = jest.fn();
  const response = new Response(
    new ReadableStream({
      cancel(): void {
        cancel();
      },
    }),
    {
      status,
      headers: options.headers,
    },
  );
  if (options.redirected) {
    Object.defineProperty(response, 'redirected', { value: true });
  }
  return { cancel, response };
}

describe('mcp oauth probe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.fetch = fetchMock;
  });

  it('reads cached auth requirements without probing a cache miss or another header context', async () => {
    const url = 'https://passive-cache.example.test/mcp';
    await expect(
      probeMcpHttpOAuthRequirement(url, {}, undefined, { cacheOnly: true }),
    ).resolves.toMatchObject({ requirement: 'unknown' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(
      new Response('', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer' },
      }),
    );
    await probeMcpHttpOAuthRequirement(url, { 'X-Workspace': 'one' });
    await expect(
      probeMcpHttpOAuthRequirement(url, { 'X-Workspace': 'one' }, undefined, {
        cacheOnly: true,
      }),
    ).resolves.toMatchObject({ requirement: 'oauth' });
    await expect(
      probeMcpHttpOAuthRequirement(url, { 'X-Workspace': 'two' }, undefined, {
        cacheOnly: true,
      }),
    ).resolves.toMatchObject({ requirement: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keys cached probe results by URL and non-sensitive request headers', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate': 'Bearer scope="read"',
          },
        }),
      )
      .mockResolvedValueOnce(initializeResponse());

    await expect(
      probeMcpHttpOAuthRequirement(
        'https://mcp.example.test/mcp',
        { 'X-Workspace': 'first' },
        50,
      ),
    ).resolves.toMatchObject({
      requirement: 'oauth',
      requiresOAuth: true,
    });
    await expect(
      probeMcpHttpOAuthRequirement(
        'https://mcp.example.test/mcp',
        { 'X-Workspace': 'second' },
        50,
      ),
    ).resolves.toMatchObject({
      requirement: 'none',
      requiresOAuth: false,
    });
    await expect(
      probeMcpHttpOAuthRequirement(
        'https://mcp.example.test/mcp',
        { 'x-workspace': 'first' },
        50,
      ),
    ).resolves.toMatchObject({
      requirement: 'oauth',
      requiresOAuth: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('redacts sensitive header values from cache keys', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Bearer scope="read"',
        },
      }),
    );

    await expect(
      probeMcpHttpOAuthRequirement(
        'https://mcp.example.test/redacted-auth',
        { Authorization: 'Bearer first' },
        50,
      ),
    ).resolves.toMatchObject({
      requirement: 'oauth',
      requiresOAuth: true,
    });
    await expect(
      probeMcpHttpOAuthRequirement(
        'https://mcp.example.test/redacted-auth',
        { Authorization: 'Bearer second' },
        50,
      ),
    ).resolves.toMatchObject({
      requirement: 'oauth',
      requiresOAuth: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache transient probe failures', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(
        new Response('', {
          status: 401,
          headers: {
            'WWW-Authenticate': 'Bearer scope="read"',
          },
        }),
      );

    await expect(
      probeMcpHttpOAuthRequirement('https://mcp.example.test/retry', {}, 50),
    ).resolves.toMatchObject({
      requirement: 'unknown',
      requiresOAuth: false,
    });
    await expect(
      probeMcpHttpOAuthRequirement('https://mcp.example.test/retry', {}, 50),
    ).resolves.toMatchObject({
      requirement: 'oauth',
      requiresOAuth: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 429, 500])(
    'fails closed for an inconclusive HTTP %i response',
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response('', { status }));

      await expect(
        probeMcpHttpOAuthRequirement(
          `https://mcp.example.test/status-${String(status)}`,
          {},
          50,
        ),
      ).resolves.toMatchObject({
        requirement: 'unknown',
        requiresOAuth: false,
      });
    },
  );

  it('cancels response bodies that are not passed to the response reader', async () => {
    const bearerChallenge = cancellableResponse(401, {
      headers: { 'WWW-Authenticate': 'Bearer scope="read"' },
    });
    const inconclusiveFailure = cancellableResponse(503);
    const redirectedSuccess = cancellableResponse(200, { redirected: true });
    fetchMock
      .mockResolvedValueOnce(bearerChallenge.response)
      .mockResolvedValueOnce(inconclusiveFailure.response)
      .mockResolvedValueOnce(redirectedSuccess.response);

    await probeMcpHttpOAuthRequirement(
      'https://mcp.example.test/cancel-bearer',
      {},
      50,
    );
    await probeMcpHttpOAuthRequirement(
      'https://mcp.example.test/cancel-failure',
      {},
      50,
    );
    await probeMcpHttpOAuthRequirement(
      'https://mcp.example.test/cancel-redirect',
      {},
      50,
    );

    expect(bearerChallenge.cancel).toHaveBeenCalledTimes(1);
    expect(inconclusiveFailure.cancel).toHaveBeenCalledTimes(1);
    expect(redirectedSuccess.cancel).toHaveBeenCalledTimes(1);
  });

  it('fails closed for a malformed successful response and does not cache it', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(initializeResponse());

    await expect(
      probeMcpHttpOAuthRequirement(
        'https://mcp.example.test/malformed',
        {},
        50,
      ),
    ).resolves.toMatchObject({
      requirement: 'unknown',
      requiresOAuth: false,
    });
    await expect(
      probeMcpHttpOAuthRequirement(
        'https://mcp.example.test/malformed',
        {},
        50,
      ),
    ).resolves.toMatchObject({
      requirement: 'none',
      requiresOAuth: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('accepts a valid SSE initialize response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        `event: message\ndata: ${JSON.stringify(initializePayload())}\n\n`,
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    );

    await expect(
      probeMcpHttpOAuthRequirement(
        'https://mcp.example.test/sse-initialize',
        {},
        50,
      ),
    ).resolves.toMatchObject({
      requirement: 'none',
      requiresOAuth: false,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: 'application/json, text/event-stream',
    });
  });

  it.each([
    ['missing id', { id: undefined }],
    ['unrelated id', { id: 2 }],
    ['conflicting error', { error: { code: -32603, message: 'failed' } }],
  ])(
    'fails closed for an initialize response with %s',
    async (_label, overrides) => {
      const responseId = 'id' in overrides ? overrides.id : undefined;
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(initializePayload(overrides)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await expect(
        probeMcpHttpOAuthRequirement(
          `https://mcp.example.test/malformed-${String(responseId ?? 'error')}`,
          {},
          50,
        ),
      ).resolves.toMatchObject({
        requirement: 'unknown',
        requiresOAuth: false,
      });
    },
  );

  it('fails closed before reading an oversized initialize response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(initializePayload()), {
        status: 200,
        headers: {
          'content-length': String(MCP_MAX_RESPONSE_BYTES + 1),
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      probeMcpHttpOAuthRequirement(
        'https://mcp.example.test/oversized-initialize',
        {},
        50,
      ),
    ).resolves.toMatchObject({
      requirement: 'unknown',
      requiresOAuth: false,
    });
  });

  it('fails closed while streaming an oversized initialize response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(MCP_MAX_RESPONSE_BYTES + 1), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      probeMcpHttpOAuthRequirement(
        'https://mcp.example.test/oversized-stream',
        {},
        50,
      ),
    ).resolves.toMatchObject({
      requirement: 'unknown',
      requiresOAuth: false,
    });
  });
});

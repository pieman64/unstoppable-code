import { EventEmitter } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  AI_CREDITS_CORRELATION_HEADER,
  AI_CREDITS_GATEWAY_DELIVERY,
} from '@canopy/protocol';
import {
  clearSessionProxyFailure,
  consumeSessionProxyFailure,
} from '../agents/ai-credits-quota-state';
import {
  CODEX_GATEWAY_MAX_RETRY_AFTER_MS,
  CODEX_GATEWAY_RETRY_BUDGET_MS,
  CODEX_GATEWAY_RETRY_DELAYS_MS,
  CodexGatewayProxyService,
  type CodexGatewayProxyDiagnosticRecord,
  deriveProxyDiagnosticIdentity,
  setCodexGatewayProxyDiagnosticSink,
  waitForResponseDrain,
} from '../agents/codex-gateway-proxy-service';

describe('CodexGatewayProxyService', () => {
  let service: CodexGatewayProxyService;
  let upstream: Server;
  let upstreamUrl: string;
  let upstreamFailuresRemaining: number;
  let upstreamFailureStatus: number;
  let upstreamFailureBody: string;
  let upstreamFailureHeaders: Record<string, string>;
  let upstreamSuccessHeaders: Record<string, string>;
  const receivedHeaders: Array<Record<string, string | string[] | undefined>> =
    [];
  const received: Array<{
    anthropicVersion?: string;
    authorization?: string;
    body: string;
    responsesLite?: string;
    unrelatedInternal?: string;
    url: string;
  }> = [];

  beforeEach(async () => {
    received.length = 0;
    receivedHeaders.length = 0;
    upstreamSuccessHeaders = {};
    upstreamFailuresRemaining = 0;
    upstreamFailureStatus = 503;
    upstreamFailureBody = '{"upstream":"temporarily unavailable"}';
    upstreamFailureHeaders = {};
    setCodexGatewayProxyDiagnosticSink(undefined);
    service = new CodexGatewayProxyService({ retryDelaysMs: [0, 0, 0] });
    upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        receivedHeaders.push({ ...request.headers });
        received.push({
          ...(typeof request.headers['anthropic-version'] === 'string'
            ? { anthropicVersion: request.headers['anthropic-version'] }
            : {}),
          ...(typeof request.headers.authorization === 'string'
            ? { authorization: request.headers.authorization }
            : {}),
          body: Buffer.concat(chunks).toString('utf8'),
          ...(typeof request.headers[
            'x-openai-internal-codex-responses-lite'
          ] === 'string'
            ? {
                responsesLite:
                  request.headers['x-openai-internal-codex-responses-lite'],
              }
            : {}),
          ...(typeof request.headers['x-openai-internal-unrelated'] === 'string'
            ? {
                unrelatedInternal:
                  request.headers['x-openai-internal-unrelated'],
              }
            : {}),
          url: request.url ?? '',
        });
        if (upstreamFailuresRemaining > 0) {
          upstreamFailuresRemaining -= 1;
          response.writeHead(upstreamFailureStatus, {
            'content-type': 'application/json',
            ...upstreamFailureHeaders,
          });
          response.end(upstreamFailureBody);
          return;
        }
        response.writeHead(200, {
          'content-type': 'application/json',
          ...upstreamSuccessHeaders,
        });
        response.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('test upstream did not bind');
    }
    upstreamUrl = `http://127.0.0.1:${String(address.port)}/responses`;
  });

  afterEach(async () => {
    setCodexGatewayProxyDiagnosticSink(undefined);
    await service.shutdown();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('waits for proxy quota before relaying headers and retries only the rejected request', async () => {
    upstreamFailuresRemaining = 1;
    upstreamFailureStatus = 429;
    const waitForQuotaRecovery = jest.fn(() => Promise.resolve());
    const options = {
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: (): Promise<string> => Promise.resolve('token'),
      waitForQuotaRecovery,
    };
    const lease = await service.registerRoute(options);
    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"input":"continue"}',
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(waitForQuotaRecovery).toHaveBeenCalledTimes(1);
    expect(received.map((request) => request.body)).toEqual([
      '{"input":"continue"}',
      '{"input":"continue"}',
    ]);
  });

  it('relays the requested service tier unchanged when a request moves to another proxy account', async () => {
    upstreamFailuresRemaining = 1;
    upstreamFailureStatus = 429;
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: (): Promise<string> => Promise.resolve('token'),
      forwardCanopyHeaders: false,
      extraHeaders: { 'x-session-id': 'canopy-session' },
      waitForQuotaRecovery: () => Promise.resolve(),
    });
    const body = JSON.stringify({
      model: 'gpt-6-astra',
      service_tier: 'ultrafast',
      input: 'continue',
    });
    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(received.map((request) => request.body)).toEqual([body, body]);
  });

  it('keeps an ephemeral route alive until every concurrent quota wait ends', async () => {
    upstreamFailuresRemaining = 2;
    upstreamFailureStatus = 429;
    const timerSpy = jest.spyOn(global, 'setTimeout');
    const releases: Array<() => void> = [];
    let bothWaiting: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      bothWaiting = resolve;
    });
    const lease = await service.registerRoute({
      sessionId: 'ephemeral:concurrent',
      upstreamUrl,
      resolveToken: () => Promise.resolve('token'),
      waitForQuotaRecovery: () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
          if (releases.length === 2) bothWaiting();
        }),
    });
    const requests = [1, 2].map(() =>
      fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).then((response) => response.text()),
    );
    try {
      await entered;
      releases[0]();
      await Promise.race(requests);
      expect(
        timerSpy.mock.calls.filter((call) => call[1] === 30 * 60_000),
      ).toHaveLength(1);
    } finally {
      releases.forEach((release) => release());
      await Promise.all(requests);
      timerSpy.mockRestore();
    }
  });

  it('retains a helper route beyond its TTL and expires it only after all holds release', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    let lease;
    let releaseFirst: () => void = () => undefined;
    let releaseSecond: () => void = () => undefined;
    try {
      lease = await service.registerRoute({
        sessionId: 'ephemeral:helper:retained',
        upstreamUrl,
        resolveToken: () => Promise.resolve('token'),
      });
      releaseFirst = service.retainRoutesForSession(
        'ephemeral:helper:retained',
      );
      releaseSecond = service.retainRoutesForSession(
        'ephemeral:helper:retained',
      );
      jest.advanceTimersByTime(31 * 60_000);
      releaseFirst();
      releaseFirst();
      jest.advanceTimersByTime(31 * 60_000);
    } finally {
      jest.useRealTimers();
    }
    try {
      expect(
        (
          await fetch(lease.baseUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(200);
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      releaseSecond();
      jest.advanceTimersByTime(31 * 60_000);
      jest.useRealTimers();
      expect(
        (
          await fetch(lease.baseUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(404);
    } finally {
      releaseFirst();
      releaseSecond();
      jest.useRealTimers();
    }
  });

  it('keeps the bearer in the parent and resolves rotations per request', async () => {
    let token = 'sentinel-one';
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve(token),
    });

    const first = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"input":"first"}',
    });
    token = 'sentinel-two';
    const second = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"input":"second"}',
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(received).toEqual([
      {
        authorization: 'Bearer sentinel-one',
        body: '{"input":"first"}',
        url: '/responses',
      },
      {
        authorization: 'Bearer sentinel-two',
        body: '{"input":"second"}',
        url: '/responses',
      },
    ]);
    expect(lease.baseUrl).not.toContain('sentinel');
  });

  it('preserves the Codex API path and query when forwarding upstream', async () => {
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
      allowedPaths: ['/responses'],
      allowedQueries: ['stream=true'],
    });

    const response = await fetch(`${lease.baseUrl}/responses?stream=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(received).toEqual([
      {
        authorization: 'Bearer sentinel',
        body: '{}',
        url: '/responses/responses?stream=true',
      },
    ]);
  });

  it('forwards the Responses Lite marker without broadening the header allow-list', async () => {
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openai-internal-codex-responses-lite': 'true',
        'x-openai-internal-unrelated': 'must-not-pass',
      },
      body: '{"stream":true}',
    });

    expect(response.status).toBe(200);
    expect(received).toEqual([
      {
        authorization: 'Bearer sentinel',
        body: '{"stream":true}',
        responsesLite: 'true',
        url: '/responses',
      },
    ]);
  });

  it('forwards only explicitly brokered Claude headers', async () => {
    const lease = await service.registerRoute({
      sessionId: 'pipeline-worker',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
      allowedPaths: ['/v1/messages'],
      forwardHeaders: ['anthropic-version'],
    });

    const response = await fetch(`${lease.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-openai-internal-unrelated': 'must-not-pass',
      },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(received).toEqual([
      {
        anthropicVersion: '2023-06-01',
        authorization: 'Bearer sentinel',
        body: '{}',
        url: '/responses/v1/messages',
      },
    ]);
  });

  it('keeps this app headers from a third-party upstream and adds route headers', async () => {
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve('client-key'),
      allowedPaths: ['/v1/messages'],
      forwardHeaders: ['x-claude-code-session-id'],
      forwardCanopyHeaders: false,
      extraHeaders: { 'x-session-id': 'canopy-chat-1' },
    });

    const response = await fetch(`${lease.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-canopy-workspace-name': 'secret-project',
        'x-claude-code-session-id': 'claude-session-1',
      },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(receivedHeaders[0]?.['x-canopy-workspace-name']).toBeUndefined();
    expect(receivedHeaders[0]?.['x-claude-code-session-id']).toBe(
      'claude-session-1',
    );
    expect(receivedHeaders[0]?.['x-session-id']).toBe('canopy-chat-1');
    expect(receivedHeaders[0]?.authorization).toBe('Bearer client-key');
  });

  it('still forwards this app headers by default', async () => {
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });
    await fetch(lease.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-canopy-workspace-name': 'project',
      },
      body: '{}',
    });
    expect(receivedHeaders[0]?.['x-canopy-workspace-name']).toBe('project');
  });

  it('reports each upstream response to the route observer', async () => {
    upstreamSuccessHeaders = {
      'x-cpa-trace-id': '20261012195407-f56be060e32f388f-req-1',
    };
    const observed: Array<{ status: number; trace: string | null }> = [];
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
      onUpstreamResponse: ({ status, headers }) => {
        observed.push({ status, trace: headers.get('x-cpa-trace-id') });
      },
    });
    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(observed).toEqual([
      { status: 200, trace: '20261012195407-f56be060e32f388f-req-1' },
    ]);
  });

  it('names the API path each reported response answered', async () => {
    const observed: string[] = [];
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      allowedPaths: ['/v1/messages', '/v1/messages/count_tokens'],
      resolveToken: () => Promise.resolve('sentinel'),
      onUpstreamResponse: ({ path }) => {
        observed.push(path);
      },
    });
    for (const path of ['/v1/messages/count_tokens', '/v1/messages']) {
      const response = await fetch(`${lease.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(200);
    }
    expect(observed).toEqual(['/v1/messages/count_tokens', '/v1/messages']);
  });

  it('reports retried upstream responses to the route observer too', async () => {
    // The first account the proxy picked was overloaded; the retry landed on
    // another one. Both served a request for this chat.
    upstreamFailuresRemaining = 1;
    upstreamFailureHeaders = {
      'x-cpa-trace-id': '20261012195407-aaaaaaaaaaaaaaaa-req-1',
    };
    upstreamSuccessHeaders = {
      'x-cpa-trace-id': '20261012195408-bbbbbbbbbbbbbbbb-req-2',
    };
    const observed: Array<{ status: number; trace: string | null }> = [];
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
      onUpstreamResponse: ({ status, headers }) => {
        observed.push({ status, trace: headers.get('x-cpa-trace-id') });
      },
    });
    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(observed).toEqual([
      { status: 503, trace: '20261012195407-aaaaaaaaaaaaaaaa-req-1' },
      { status: 200, trace: '20261012195408-bbbbbbbbbbbbbbbb-req-2' },
    ]);
  });

  it('relays the response when the observer throws', async () => {
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
      onUpstreamResponse: () => {
        throw new Error('observer bug');
      },
    });
    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
  });

  it('recursively strips cache_control when the route disables cache passthrough', async () => {
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
      stripCacheControl: true,
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: [
          {
            cache_control: { type: 'ephemeral' },
            content: [
              {
                type: 'text',
                text: 'hello',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(received[0]?.body ?? '{}')).toEqual({
      input: [
        {
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    });
  });

  it.each([401, 403])(
    'reports an upstream HTTP %s as a credential rejection',
    async (status) => {
      upstreamFailuresRemaining = 1;
      upstreamFailureStatus = status;
      const onCredentialRejected = jest.fn(() => Promise.resolve());
      const lease = await service.registerRoute({
        sessionId: 'org-gateway-chat',
        upstreamUrl,
        resolveToken: () =>
          Promise.resolve({
            token: 'sentinel',
            credentialVersion: 'credential-v1',
          }),
        onCredentialRejected,
      });

      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(response.status).toBe(status);
      expect(onCredentialRejected).toHaveBeenCalledWith(
        status,
        'credential-v1',
      );
    },
  );

  it.each(['/../admin', '/%2e%2e/admin'])(
    'rejects dot segments before forwarding the bearer: %s',
    async (path) => {
      const lease = await service.registerRoute({
        sessionId: 'chat-1',
        upstreamUrl,
        resolveToken: () => Promise.resolve('sentinel'),
      });
      const target = new URL(lease.baseUrl);

      const statusCode = await new Promise<number | undefined>(
        (resolve, reject) => {
          const request = httpRequest(
            {
              hostname: target.hostname,
              port: target.port,
              method: 'POST',
              path: `${target.pathname}${path}`,
              headers: { 'content-type': 'application/json' },
            },
            (response) => {
              response.resume();
              response.once('end', () => resolve(response.statusCode));
            },
          );
          request.once('error', reject);
          request.end('{}');
        },
      );

      expect(statusCode).toBe(400);
      expect(received).toEqual([]);
    },
  );
  it.each(['/admin', '/v1/messages?debug=1'])(
    'rejects an unapproved route target before resolving credentials: %s',
    async (path) => {
      const resolveToken = jest.fn(() => Promise.resolve('sentinel'));
      const lease = await service.registerRoute({
        sessionId: 'org-gateway-chat',
        upstreamUrl,
        resolveToken,
        allowedPaths: ['/v1/messages'],
      });

      const response = await fetch(`${lease.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(response.status).toBe(404);
      expect(resolveToken).not.toHaveBeenCalled();
      expect(received).toEqual([]);
    },
  );

  it('fails closed after the owning session is revoked', async () => {
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });
    service.unregisterRoutesForSession('chat-1');

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(404);
    const payload: unknown = await response.json();
    const correlationId = response.headers.get(AI_CREDITS_CORRELATION_HEADER);
    expect(correlationId).toMatch(/\S+/);
    expect(payload).toEqual({
      error: {
        canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
        code: 'invalid_request',
        correlation_id: correlationId,
        message: 'AI Credits proxy route is no longer available.',
      },
    });
    expect(received).toEqual([]);
  });

  it('streams upstream SSE chunks without waiting for completion', async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      void secondChunkGate.then(() => {
        response.end('data: second\n\n');
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('test upstream did not bind');
    }
    upstreamUrl = `http://127.0.0.1:${String(address.port)}/responses`;
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const proxied = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const reader = proxied.body?.getReader();
    if (!reader) throw new Error('expected a streaming response body');
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
    releaseSecondChunk();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('data: second\n\n');
  });

  it('removes the paired error listener after backpressure drains', async () => {
    const response = new EventEmitter() as ServerResponse;
    const drained = waitForResponseDrain(response);

    expect(response.listenerCount('drain')).toBe(1);
    expect(response.listenerCount('error')).toBe(1);
    response.emit('drain');

    await drained;
    expect(response.listenerCount('drain')).toBe(0);
    expect(response.listenerCount('error')).toBe(0);
  });

  it('aborts the upstream response when the downstream client disconnects', async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    let resolveUpstreamClosed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      resolveUpstreamClosed = resolve;
    });
    upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      response.once('close', resolveUpstreamClosed);
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('test upstream did not bind');
    }
    upstreamUrl = `http://127.0.0.1:${String(address.port)}/responses`;
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });
    const controller = new AbortController();
    const proxied = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    const reader = proxied.body?.getReader();
    if (!reader) throw new Error('expected a streaming response body');
    await reader.read();

    controller.abort();

    await expect(upstreamClosed).resolves.toBeUndefined();
  });

  it('rejects non-JSON and non-POST requests without contacting upstream', async () => {
    const lease = await service.registerRoute({
      sessionId: 'chat-1',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const wrongMethod = await fetch(lease.baseUrl);
    const wrongType = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });

    expect(wrongMethod.status).toBe(405);
    expect(wrongType.status).toBe(415);
    expect(received).toEqual([]);
  });

  it('pins the shipped retry schedule', () => {
    expect(CODEX_GATEWAY_RETRY_DELAYS_MS).toEqual([250, 750, 1_500]);
    expect(CODEX_GATEWAY_RETRY_BUDGET_MS).toBe(8_000);
    expect(CODEX_GATEWAY_MAX_RETRY_AFTER_MS).toBe(2_000);
  });

  it('retries transient upstream failures with the identical request body', async () => {
    upstreamFailuresRemaining = 2;
    const resolveToken = jest.fn(() => Promise.resolve('sentinel'));
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl,
      resolveToken,
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"input":"same-on-every-attempt"}',
    });

    expect(response.status).toBe(200);
    expect(received).toHaveLength(3);
    expect(received.map((entry) => entry.body)).toEqual([
      '{"input":"same-on-every-attempt"}',
      '{"input":"same-on-every-attempt"}',
      '{"input":"same-on-every-attempt"}',
    ]);
    expect(resolveToken).toHaveBeenCalledTimes(1);
  });

  it('passes through the real upstream 5xx after retries are exhausted', async () => {
    upstreamFailuresRemaining = 4;
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      upstream: 'temporarily unavailable',
    });
    expect(received).toHaveLength(4);
  });

  it('does not retry the concurrency guard and preserves its headers', async () => {
    upstreamFailuresRemaining = 1;
    upstreamFailureHeaders = {
      'retry-after': '1',
      'x-canopy-ai-credits-guard': 'concurrent-request-in-progress',
      'x-canopy-request-id': 'request-guard-1',
    };
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(response.headers.get('x-canopy-ai-credits-guard')).toBe(
      'concurrent-request-in-progress',
    );
    expect(response.headers.get('x-canopy-request-id')).toBe('request-guard-1');
    expect(received).toHaveLength(1);
  });

  // The proxy is the LAST point that still sees the marked hosted body: Codex
  // 0.148.0 parses it and renders only `error.message`, so by the time the turn
  // failure reaches Canopy the marker and code are gone. These cover the
  // classification happening here, and that observing the body never changes
  // what the client receives.
  describe('no-billing-source classification', () => {
    const markedNoBillingSourceBody = JSON.stringify({
      error: {
        canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
        code: 'no_billing_source',
        correlation_id: 'request-402',
        message: 'AI Credits are unavailable for this request.',
      },
    });

    afterEach(() => {
      clearSessionProxyFailure('project/worktree/chat');
    });

    it('records the verdict against the route session and relays the body intact', async () => {
      upstreamFailuresRemaining = 1;
      upstreamFailureStatus = 402;
      upstreamFailureBody = markedNoBillingSourceBody;
      const lease = await service.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl,
        resolveToken: () => Promise.resolve('sentinel'),
      });

      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(response.status).toBe(402);
      expect(await response.text()).toBe(markedNoBillingSourceBody);
      expect(consumeSessionProxyFailure('project/worktree/chat')).toEqual({
        code: 'no_billing_source',
        message: 'AI Credits are unavailable for this request.',
        correlationId: 'request-402',
      });
    });

    it('leaves other marked proxy codes on the same status unrecorded', async () => {
      upstreamFailuresRemaining = 1;
      upstreamFailureStatus = 402;
      upstreamFailureBody = JSON.stringify({
        error: {
          canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
          code: 'invalid_request',
          correlation_id: 'request-402',
        },
      });
      const lease = await service.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl,
        resolveToken: () => Promise.resolve('sentinel'),
      });

      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(response.status).toBe(402);
      expect(
        consumeSessionProxyFailure('project/worktree/chat'),
      ).toBeUndefined();
    });

    it('does not record an unmarked 402 from somewhere other than the hosted proxy', async () => {
      upstreamFailuresRemaining = 1;
      upstreamFailureStatus = 402;
      upstreamFailureBody = '{"error":{"message":"Payment required"}}';
      const lease = await service.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl,
        resolveToken: () => Promise.resolve('sentinel'),
      });

      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(response.status).toBe(402);
      expect(
        consumeSessionProxyFailure('project/worktree/chat'),
      ).toBeUndefined();
    });

    // Both outcomes are indistinguishable from the outside (the user sees a raw
    // error either way), so the diagnostic has to record which one happened and
    // under which session key the verdict was filed.
    it('records a diagnostic naming the route session for both outcomes', async () => {
      const records: CodexGatewayProxyDiagnosticRecord[] = [];
      setCodexGatewayProxyDiagnosticSink((record) => records.push(record));
      upstreamFailuresRemaining = 1;
      upstreamFailureStatus = 402;
      upstreamFailureBody = markedNoBillingSourceBody;
      const lease = await service.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl,
        resolveToken: () => Promise.resolve('sentinel'),
      });

      await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(
        records.find(
          (record) => record.kind === 'codex_gateway_no_billing_source',
        ),
      ).toMatchObject({
        kind: 'codex_gateway_no_billing_source',
        sessionKey: 'project/worktree/chat',
        chatId: 'chat',
        codexGatewayUpstreamStatus: 402,
        codexGatewayNoBillingSourceClassified: true,
      });
    });

    it('records the unclassified outcome for an unmarked 402', async () => {
      const records: CodexGatewayProxyDiagnosticRecord[] = [];
      setCodexGatewayProxyDiagnosticSink((record) => records.push(record));
      upstreamFailuresRemaining = 1;
      upstreamFailureStatus = 402;
      upstreamFailureBody = '{"error":{"message":"Payment required"}}';
      const lease = await service.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl,
        resolveToken: () => Promise.resolve('sentinel'),
      });

      await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(
        records.find(
          (record) => record.kind === 'codex_gateway_no_billing_source',
        ),
      ).toMatchObject({
        codexGatewayNoBillingSourceClassified: false,
      });
    });

    it.each([
      ['work_owner_not_member', 'request-403'],
      ['guest_model_not_allowed', 'request-guest'],
    ])(
      'records a marked 403 %s and relays the body intact (CAN-3462)',
      async (code, correlationId) => {
        const records: CodexGatewayProxyDiagnosticRecord[] = [];
        setCodexGatewayProxyDiagnosticSink((record) => records.push(record));
        const body = JSON.stringify({
          error: {
            canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
            code,
            correlation_id: correlationId,
            message: 'Refused.',
          },
        });
        upstreamFailuresRemaining = 1;
        upstreamFailureStatus = 403;
        upstreamFailureBody = body;
        const lease = await service.registerRoute({
          sessionId: 'project/worktree/chat',
          upstreamUrl,
          resolveToken: () => Promise.resolve('sentinel'),
        });

        const response = await fetch(lease.baseUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });

        expect(response.status).toBe(403);
        expect(await response.text()).toBe(body);
        expect(consumeSessionProxyFailure('project/worktree/chat')).toEqual({
          code,
          message: 'Refused.',
          correlationId,
        });
        // The no-billing-source diagnostic stays scoped to its 402.
        expect(
          records.some(
            (record) => record.kind === 'codex_gateway_no_billing_source',
          ),
        ).toBe(false);
      },
    );

    it('does not record an unmarked 403 from the provider', async () => {
      upstreamFailuresRemaining = 1;
      upstreamFailureStatus = 403;
      upstreamFailureBody = '{"error":{"message":"Forbidden"}}';
      const lease = await service.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl,
        resolveToken: () => Promise.resolve('sentinel'),
      });

      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(response.status).toBe(403);
      expect(await response.text()).toBe('{"error":{"message":"Forbidden"}}');
      expect(
        consumeSessionProxyFailure('project/worktree/chat'),
      ).toBeUndefined();
    });

    it('relays a successful streamed body untouched', async () => {
      const lease = await service.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl,
        resolveToken: () => Promise.resolve('sentinel'),
      });

      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"ok":true}');
      expect(
        consumeSessionProxyFailure('project/worktree/chat'),
      ).toBeUndefined();
    });
  });

  it('does not retry non-transient upstream responses', async () => {
    upstreamFailuresRemaining = 1;
    upstreamFailureStatus = 401;
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(received).toHaveLength(1);
  });

  it('forwards nothing once the route upstream is withdrawn while the token is read', async () => {
    const withdrawn = new AbortController();
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl,
      upstreamSignal: () => withdrawn.signal,
      resolveToken: () => {
        withdrawn.abort();
        return Promise.resolve('sentinel');
      },
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(received).toHaveLength(0);
  });

  it('stops retrying once the route upstream is withdrawn', async () => {
    upstreamFailuresRemaining = 3;
    const withdrawn = new AbortController();
    const retrying = new CodexGatewayProxyService({
      retryDelaysMs: [200, 200, 200],
    });
    try {
      const lease = await retrying.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl,
        upstreamSignal: () => withdrawn.signal,
        resolveToken: () => Promise.resolve('sentinel'),
        onUpstreamResponse: () => {
          withdrawn.abort();
        },
      });

      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await response.body?.cancel();

      expect(received).toHaveLength(1);
    } finally {
      await retrying.shutdown();
    }
  });

  it('maps unavailable credentials to a structured 401 without forwarding', async () => {
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl,
      resolveToken: () => Promise.resolve(null),
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
        code: 'credentials_unavailable',
      },
    });
    expect(received).toEqual([]);
  });

  it('maps invalid hosts and oversized bodies to client errors', async () => {
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });
    const target = new URL(lease.baseUrl);
    const invalidHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            hostname: target.hostname,
            port: target.port,
            method: 'POST',
            path: target.pathname,
            headers: {
              host: 'attacker.example',
              'content-type': 'application/json',
            },
          },
          (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
          },
        );
        request.once('error', reject);
        request.end('{}');
      },
    );
    const oversized = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(8 * 1024 * 1024 + 1, 0x20),
    });

    expect(invalidHostStatus).toBe(400);
    expect(oversized.status).toBe(413);
    expect(received).toEqual([]);
  });

  it('returns a structured 502 after retryable network failures exhaust', async () => {
    const unavailable = createServer();
    await new Promise<void>((resolve) =>
      unavailable.listen(0, '127.0.0.1', resolve),
    );
    const address = unavailable.address();
    if (!address || typeof address === 'string') {
      throw new Error('unavailable upstream did not bind');
    }
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));
    const records: unknown[] = [];
    setCodexGatewayProxyDiagnosticSink((record) => records.push(record));
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl: `http://127.0.0.1:${String(address.port)}/responses`,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const payload: unknown = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      error: {
        canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
        code: 'upstream_unavailable',
        attempts: 4,
      },
    });
    expect(records).toEqual([
      expect.objectContaining({ kind: 'codex_gateway_proxy_retry' }),
      expect.objectContaining({
        kind: 'codex_gateway_proxy_failed',
        codexGatewayFailureCode: 'upstream_unavailable',
      }),
    ]);
  });

  it('does not retry after upstream response headers begin streaming', async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    let hits = 0;
    upstream = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      setImmediate(() => response.destroy());
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('streaming upstream did not bind');
    }
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl: `http://127.0.0.1:${String(address.port)}/responses`,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await expect(response.text()).rejects.toThrow();
    expect(hits).toBe(1);
  });

  it('does not abort a streaming response that outlives the retry budget', async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    upstream = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        let index = 0;
        const timer = setInterval(() => {
          index += 1;
          response.write(`data: chunk-${String(index)}\n\n`);
          if (index === 5) {
            clearInterval(timer);
            response.end('data: [DONE]\n\n');
          }
        }, 60);
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('streaming upstream did not bind');
    }
    // The retry budget bounds the pre-header retry phase only. A healthy
    // response that streams for longer than the budget must not be aborted.
    const streamingService = new CodexGatewayProxyService({
      retryDelaysMs: [0, 0, 0],
      retryBudgetMs: 100,
    });
    try {
      const lease = await streamingService.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl: `http://127.0.0.1:${String(address.port)}/responses`,
        resolveToken: () => Promise.resolve('sentinel'),
      });

      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('data: chunk-1');
      expect(body).toContain('data: chunk-5');
      expect(body).toContain('data: [DONE]');
    } finally {
      await streamingService.shutdown();
    }
  });

  // The budget bounds the RETRY phase, not the lifetime of a single healthy
  // attempt. A slow time-to-first-byte (reasoning models, cold gateway, the
  // hosted proxy buffering the body and doing a model-policy read) must not be
  // converted into a fabricated 502 — which the CAN-1662 classifier would then
  // re-dispatch straight back into the same wall.
  it('does not abort a healthy request whose headers arrive after the retry budget', async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    let hits = 0;
    upstream = createServer((request, response) => {
      hits += 1;
      request.resume();
      request.on('end', () => {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end('data: slow-ttfb\n\n');
        }, 400);
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('slow upstream did not bind');
    }
    const slowService = new CodexGatewayProxyService({
      retryDelaysMs: [0, 0, 0],
      retryBudgetMs: 150,
    });
    try {
      const lease = await slowService.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl: `http://127.0.0.1:${String(address.port)}/responses`,
        resolveToken: () => Promise.resolve('sentinel'),
      });

      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('data: slow-ttfb');
      expect(hits).toBe(1);
    } finally {
      await slowService.shutdown();
    }
  });

  // The retry budget must bound how many billed attempts a single request can
  // make, independently of the configured attempt count. Note this pins the
  // budget's attempt-bounding behavior; the additional pre-attempt deadline
  // re-check guards a backoff *overshoot* (event-loop stall, machine sleep),
  // which is defensive and not deterministically reproducible here.
  it('stops retrying once the retry budget is spent instead of using every attempt', async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    let hits = 0;
    upstream = createServer((request, response) => {
      hits += 1;
      request.resume();
      request.on('end', () => {
        // Every attempt is a retryable 503, and each one burns 120ms — so the
        // 150ms budget is already spent by the time attempt 2 would start.
        setTimeout(() => {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end('{"upstream":"temporarily unavailable"}');
        }, 120);
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('slow failing upstream did not bind');
    }
    const retryDelayCount = 3;
    const budgetedService = new CodexGatewayProxyService({
      retryDelaysMs: Array.from({ length: retryDelayCount }, () => 0),
      retryBudgetMs: 150,
    });
    try {
      const lease = await budgetedService.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl: `http://127.0.0.1:${String(address.port)}/responses`,
        resolveToken: () => Promise.resolve('sentinel'),
      });

      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await response.text();

      // The real 503 is passed through once the budget is spent, rather than
      // burning all four configured attempts on a billed endpoint.
      expect(response.status).toBe(503);
      expect(hits).toBeLessThan(retryDelayCount + 1);
      expect(hits).toBeGreaterThanOrEqual(1);
    } finally {
      await budgetedService.shutdown();
    }
  });

  // The pre-attempt deadline guard only fires when a backoff sleep OVERSHOOTS
  // the deadline (event-loop stall, machine sleep, long GC). Real timers cannot
  // reproduce that deterministically, so the clock seam simulates the overshoot:
  // the deadline passes between the predictive pre-sleep check and the moment
  // the next attempt would start. Without the guard a second billed POST fires.
  it('does not replay a billed POST when the backoff overshoots the deadline', async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    let hits = 0;
    upstream = createServer((request, response) => {
      hits += 1;
      request.resume();
      request.on('end', () => {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{"upstream":"temporarily unavailable"}');
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('failing upstream did not bind');
    }

    // Read 1 is `startedAt`; read 2 is attempt 1's elapsed check, which must
    // stay inside the budget so the retry is actually scheduled. Read 3 is the
    // pre-attempt guard for attempt 2 — it reports past the deadline, which is
    // exactly the state a sleep overshoot leaves behind.
    const RETRY_BUDGET_MS = 1_000;
    let reads = 0;
    const now = (): number => {
      reads += 1;
      return reads <= 2 ? 0 : RETRY_BUDGET_MS * 5;
    };
    const overshootService = new CodexGatewayProxyService({
      retryDelaysMs: [0, 0, 0],
      retryBudgetMs: RETRY_BUDGET_MS,
      now,
    });
    try {
      const lease = await overshootService.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl: `http://127.0.0.1:${String(address.port)}/responses`,
        resolveToken: () => Promise.resolve('sentinel'),
      });

      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      await response.text();

      // Exactly one upstream POST: the deadline had passed, so no replay.
      expect(hits).toBe(1);
      expect(response.status).toBe(502);
    } finally {
      await overshootService.shutdown();
    }
  });

  // The upstream POST is billed and non-idempotent: once the gateway accepts a
  // request it starts (and charges for) a turn. A connection dropped *after*
  // transmission must therefore not be retried, or the user pays twice.
  it('does not retry a connection dropped after the request was transmitted', async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    let hits = 0;
    upstream = createServer((request, response) => {
      hits += 1;
      request.resume();
      request.on('end', () => {
        // Kill the socket after the request landed but before any response —
        // the shape that used to surface as a retryable ECONNRESET.
        response.socket?.destroy();
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('resetting upstream did not bind');
    }
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl: `http://127.0.0.1:${String(address.port)}/responses`,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const payload: unknown = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      error: { code: 'upstream_unavailable', attempts: 1 },
    });
    expect(hits).toBe(1);
  });

  // The test above proves this proxy will not replay a mid-flight drop on ITS
  // OWN socket. That allowlist is bypassed by the extra hop: when `apps/web`'s
  // fetch to the gateway rejects, the desktop sees a well-formed HTTP 502, not a
  // connection error, and would replay it on status alone. The hosted side
  // therefore stamps delivery provenance and this proxy has to honor it,
  // otherwise the same post-transmission reset double-charges through the hop
  // the local allowlist was written to prevent.
  it('does not retry a hosted failure whose delivery is ambiguous', async () => {
    upstreamFailuresRemaining = 1;
    upstreamFailureStatus = 502;
    upstreamFailureBody = '{"error":{"type":"upstream_unavailable"}}';
    upstreamFailureHeaders = {
      [AI_CREDITS_GATEWAY_DELIVERY.header]:
        AI_CREDITS_GATEWAY_DELIVERY.ambiguous,
    };
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    // Passed straight through, and — the whole point — exactly one billed POST.
    expect(response.status).toBe(502);
    expect(received).toHaveLength(1);
  });

  // The inverse: a rejection the hosted side proved never reached the gateway
  // started no turn, so replaying it cannot double-charge and the retry this PR
  // exists to provide must still happen.
  it('still retries a hosted failure the gateway provably never received', async () => {
    upstreamFailuresRemaining = 1;
    upstreamFailureStatus = 502;
    upstreamFailureBody = '{"error":{"type":"upstream_unavailable"}}';
    upstreamFailureHeaders = {
      [AI_CREDITS_GATEWAY_DELIVERY.header]: AI_CREDITS_GATEWAY_DELIVERY.notSent,
    };
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(received).toHaveLength(2);
  });

  // The cap has to bound abuse WITHOUT permanently silencing the support
  // contract: the expired-route 404 is reachable in normal operation on the
  // 30-minute TTL, and its copy tells the user to report the error id. A
  // process-lifetime cap meant a long session eventually handed support ids that
  // joined to nothing.
  it('resumes pre-route diagnostics in a new window after the cap is hit', async () => {
    const records: Array<Record<string, unknown>> = [];
    setCodexGatewayProxyDiagnosticSink((record) =>
      records.push(record as unknown as Record<string, unknown>),
    );
    let clock = 1_000;
    const windowed = new CodexGatewayProxyService({
      retryDelaysMs: [0, 0, 0],
      now: (): number => clock,
    });
    try {
      const lease = await windowed.registerRoute({
        sessionId: 'project/worktree/chat',
        upstreamUrl,
        resolveToken: () => Promise.resolve('sentinel'),
      });
      // A malformed content type is a pre-route rejection, so each call emits.
      const poke = async (): Promise<void> => {
        const response = await fetch(lease.baseUrl, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: 'not json',
        });
        await response.text();
      };

      for (let i = 0; i < 55; i += 1) await poke();
      expect(records).toHaveLength(50);

      // Still inside the window: the cap continues to hold.
      await poke();
      expect(records).toHaveLength(50);

      // A new window reopens the budget so real failures reach support again.
      clock += 60 * 60_000;
      await poke();
      expect(records).toHaveLength(51);
    } finally {
      await windowed.shutdown();
    }
  });

  // The notice copy for these codes tells the user to report the error id, so
  // the id has to reach a diagnostic record or support gets an id that joins to
  // nothing on either side of the wire.
  it('records a diagnostic for pre-route failures that surface an error id', async () => {
    const records: Array<Record<string, unknown>> = [];
    setCodexGatewayProxyDiagnosticSink((record) =>
      records.push(record as unknown as Record<string, unknown>),
    );
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not json',
    });
    const payload: unknown = await response.json();

    expect(response.status).toBe(415);
    expect(payload).toMatchObject({
      error: { code: 'invalid_request' },
    });
    const correlationId = records[0]?.codexGatewayCorrelationId;
    expect(typeof correlationId).toBe('string');
    // The id rendered to the user is the id we recorded.
    expect(payload).toMatchObject({
      error: { correlation_id: correlationId },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'codex_gateway_proxy_failed',
      codexGatewayFailureCode: 'invalid_request',
    });
    // No route was resolved, so attribution is omitted rather than faked.
    expect(records[0]?.codexGatewayRouteRef).toBeUndefined();
    expect(JSON.stringify(records)).not.toContain(lease.routeId);
  });

  // Pre-route paths run before any credential or route-id check, so any local
  // caller that finds the loopback port can reach them. Cap the records so a
  // chatty caller cannot grow the session-events day file without bound.
  it('caps pre-route diagnostics so an unauthenticated caller cannot flood them', async () => {
    const records: unknown[] = [];
    setCodexGatewayProxyDiagnosticSink((record) => records.push(record));
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    for (let index = 0; index < 60; index += 1) {
      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'not json',
      });
      await response.text();
      expect(response.status).toBe(415);
    }

    // Every caller still gets a correct structured 415; only the recording stops.
    expect(records.length).toBeLessThanOrEqual(50);
    expect(records.length).toBeGreaterThan(0);
  });

  it('ignores a malformed Retry-After instead of collapsing the backoff', async () => {
    upstreamFailuresRemaining = 1;
    upstreamFailureHeaders = { 'retry-after': 'not-a-date' };
    // A NONZERO configured delay is what makes this test discriminating. With
    // the shared zero-delay service both the broken and fixed paths retry
    // immediately and every assertion passes either way: the old code computed
    // `Math.max(0, NaN)` = NaN, and Node coerces a NaN setTimeout delay to 1ms.
    // Here the malformed header must fall back to 0 so `Math.max(delay, 0)`
    // preserves the configured backoff.
    const RETRY_DELAY_MS = 150;
    const backoffService = new CodexGatewayProxyService({
      retryDelaysMs: [RETRY_DELAY_MS],
    });
    try {
      const lease = await backoffService.registerRoute({
        sessionId: 'chat-1',
        upstreamUrl,
        resolveToken: () => Promise.resolve('sentinel'),
      });

      const startedAt = Date.now();
      const response = await fetch(lease.baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const body = await response.text();
      const elapsedMs = Date.now() - startedAt;

      expect(response.status).toBe(200);
      expect(body).toBe('{"ok":true}');
      expect(received).toHaveLength(2);
      // NaN would have collapsed this to ~1ms.
      expect(elapsedMs).toBeGreaterThanOrEqual(RETRY_DELAY_MS);
    } finally {
      await backoffService.shutdown();
    }
  });

  it('records allow-listed retry diagnostics without leaking the route id', async () => {
    upstreamFailuresRemaining = 1;
    const records: unknown[] = [];
    setCodexGatewayProxyDiagnosticSink((record) => records.push(record));
    const lease = await service.registerRoute({
      sessionId: 'project/worktree/chat',
      upstreamUrl,
      resolveToken: () => Promise.resolve('sentinel'),
    });

    const response = await fetch(lease.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await response.text();

    expect(records).toEqual([
      expect.objectContaining({
        kind: 'codex_gateway_proxy_retry',
        codexGatewayAttemptCount: 2,
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain(lease.routeId);
  });

  it.each([
    [
      'project/worktree/chat',
      { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' },
    ],
    [
      'pipeline:execution-1:job-1:step-1:1',
      { projectId: '', worktreeId: '', chatId: 'pipeline:execution-1' },
    ],
    ['ephemeral:uuid-1', { projectId: '', worktreeId: '', chatId: '' }],
    ['malformed', { projectId: '', worktreeId: '', chatId: '' }],
  ])('derives a total diagnostic identity for %s', (sessionId, expected) => {
    expect(deriveProxyDiagnosticIdentity(sessionId)).toMatchObject(expected);
  });
});

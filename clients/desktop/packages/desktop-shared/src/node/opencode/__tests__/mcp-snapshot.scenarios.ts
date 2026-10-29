import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createGzip, constants as zlibConstants } from 'node:zlib';
import { test } from 'node:test';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { validate } from './schema-validation.fixture';
import { resolveOpenCodeMcpSnapshotTool } from '../mcp-tool-identity';
import { createOpenCodeDiscoveryFetch } from '../discovery-fetch';
import type { OpenCodeCapabilitySnapshot } from '../capability-snapshot';
import {
  readOpenCodeMcpSnapshot,
  openCodeMcpCallMatchesSnapshot,
} from '../mcp-snapshot';

const matches = (
  snapshot: OpenCodeCapabilitySnapshot['mcp'],
  server: string,
  tool: string,
  input: unknown,
): Promise<boolean> =>
  openCodeMcpCallMatchesSnapshot(snapshot, server, tool, input, {
    validate,
    signal: new AbortController().signal,
  });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

void test('MCP permissions honor declared JSON Schema 2020-12 tuple constraints', async () => {
  const snapshot: OpenCodeCapabilitySnapshot['mcp'] = [
    {
      name: 'fixture',
      identity: { binding: 'stable-selection' },
      tools: [
        {
          name: 'echo',
          inputSchema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
              pair: {
                type: 'array',
                prefixItems: [{ type: 'string' }, { type: 'integer' }],
                items: false,
                minItems: 2,
              },
            },
            required: ['pair'],
            additionalProperties: false,
          },
        },
      ],
    },
  ];
  assert.equal(
    await matches(snapshot, 'fixture', 'echo', {
      pair: ['hello', 42],
    }),
    true,
  );
  for (const pair of [[42, 'hello'], ['hello', 42, 'extra'], ['hello']]) {
    assert.equal(await matches(snapshot, 'fixture', 'echo', { pair }), false);
  }
});

for (const mode of [
  'valid',
  'large-output',
  'unsupported-output',
  'malformed-tool',
  'duplicate',
  'unavailable',
  'cancelled',
] as const)
  void test(`MCP snapshot ${mode}: complete schemas are required before tool use`, async (context) => {
    const outputSchema =
      mode === 'large-output'
        ? {
            type: 'object' as const,
            properties: Object.fromEntries(
              Array.from({ length: 1000 }, (_, i) => [
                `field${i}`,
                { type: 'string' },
              ]),
            ),
          }
        : mode === 'unsupported-output'
          ? {
              type: 'object' as const,
              $ref: 'https://untrusted.invalid/output-schema',
            }
          : undefined;
    const compile = context.mock.method(
      AjvJsonSchemaValidator.prototype,
      'getValidator',
    );
    let toolCalls = 0;
    let authorized = 0;
    const abort = new AbortController();
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const data: unknown = chunk;
        if (!(data instanceof Uint8Array)) throw new Error('Expected bytes');
        chunks.push(Buffer.from(data));
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record(input)) throw new Error('Expected JSON-RPC object');
      const params = record(input.params) ? input.params : {};
      if (request.headers.authorization === 'Bearer private-credential')
        authorized++;
      if (!('id' in input)) {
        response.writeHead(202).end();
        return;
      }
      if (mode === 'unavailable') {
        response.writeHead(503).end();
        return;
      }
      if (input.method === 'tools/call') toolCalls++;
      if (input.method === 'tools/list' && mode === 'cancelled') {
        abort.abort();
        return;
      }
      const result =
        input.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : {
              tools: [
                {
                  name:
                    params.cursor && mode !== 'duplicate' ? 'second' : 'echo',
                  ...(outputSchema ? { outputSchema } : {}),
                  inputSchema: {
                    type: mode === 'malformed-tool' ? 'array' : 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                    additionalProperties: false,
                  },
                },
              ],
              ...(params.cursor ? {} : { nextCursor: 'page2' }),
            };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP server');
    try {
      const result = readOpenCodeMcpSnapshot(
        [
          {
            type: 'http',
            name: 'fixture',
            url: `http://127.0.0.1:${address.port}/mcp`,
            headers: [
              { name: 'Authorization', value: 'Bearer private-credential' },
            ],
          },
        ],
        { fixture: { binding: 'stable-selection' } },
        abort.signal,
        () => {
          throw new Error('Unexpected stdio');
        },
      );
      if (!['valid', 'large-output', 'unsupported-output'].includes(mode))
        await assert.rejects(result);
      else {
        const snapshot = await result;
        assert.deepEqual(
          snapshot[0].tools.map((tool) => tool.name),
          ['echo', 'second'],
        );
        assert.equal(
          compile.mock.callCount(),
          0,
          'Discovery must not compile untrusted schemas on the host',
        );
        assert.deepEqual(snapshot[0].tools[0].outputSchema, outputSchema);
        assert.equal(
          await matches(snapshot, 'fixture', 'echo', {
            text: 'hello',
          }),
          true,
        );
        assert.equal(
          await matches(snapshot, 'fixture', 'echo', {
            text: 42,
          }),
          false,
        );
        assert.equal(await matches(snapshot, 'fixture', 'new-tool', {}), false);
        assert.doesNotMatch(JSON.stringify(snapshot), /private-credential/);
        assert.ok(authorized > 0);
      }
      assert.equal(toolCalls, 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

for (const transport of [
  'http-json',
  'http-gzip',
  'http-sse',
  'sse',
] as const) {
  for (const oversized of [false, true]) {
    void test(`MCP ${transport} bounds decoded response bytes before parsing (${oversized ? 'oversized' : 'control'})`, async () => {
      let events: ServerResponse | undefined;
      let sent = 0;
      const padding = oversized
        ? 'x'.repeat(10 * 1024 * 1024)
        : 'ordinary metadata';
      const server = createServer(async (request, response) => {
        if (request.method === 'GET') {
          if (transport !== 'sse') return void response.writeHead(405).end();
          events = response;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('event: endpoint\ndata: /messages\n\n');
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          if (!Buffer.isBuffer(chunk)) throw new Error('Expected bytes');
          chunks.push(chunk);
        }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (!record(input)) throw new Error('Expected request');
        if (!('id' in input)) return void response.writeHead(202).end();
        const listing = input.method === 'tools/list';
        const result = listing
          ? {
              tools: [
                {
                  name: 'echo',
                  description: padding,
                  inputSchema: { type: 'object' },
                },
              ],
            }
          : {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'bounded', version: '1' },
            };
        const json = JSON.stringify({ jsonrpc: '2.0', id: input.id, result });
        let target = response;
        if (transport === 'sse') {
          response.writeHead(202).end();
          if (!events) throw new Error('Expected event stream');
          target = events;
        } else {
          response.writeHead(200, {
            'content-type':
              transport === 'http-json' || transport === 'http-gzip'
                ? 'application/json'
                : 'text/event-stream',
            ...(transport === 'http-gzip'
              ? { 'content-encoding': 'gzip' }
              : {}),
          });
        }
        const gzip =
          transport === 'http-gzip'
            ? createGzip({ flush: zlibConstants.Z_SYNC_FLUSH })
            : undefined;
        if (gzip) {
          gzip.pipe(response);
          response.once('close', () => gzip.destroy());
        }
        const payload =
          transport === 'http-json' || transport === 'http-gzip'
            ? json
            : `event: message\ndata: ${json}\n\n`;
        for (
          let offset = 0;
          offset < payload.length && !target.destroyed;
          offset += 64 * 1024
        ) {
          const chunk = payload.slice(offset, offset + 64 * 1024);
          (gzip ?? target).write(chunk);
          if (listing) sent += Buffer.byteLength(chunk);
          await delay(1);
          // Hold the final MiB until the client rejects. Sender buffering and
          // gzip compression can otherwise finish before client cancellation.
          if (oversized && listing && sent >= 9 * 1024 * 1024) {
            if (!target.destroyed) await once(target, 'close');
            break;
          }
        }
        if (transport !== 'sse' && !target.destroyed) (gzip ?? target).end();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Expected TCP server');
      try {
        const result = readOpenCodeMcpSnapshot(
          [
            {
              name: 'bounded',
              type: transport === 'sse' ? 'sse' : 'http',
              url: `http://127.0.0.1:${address.port}/mcp`,
              headers: [],
            },
          ],
          {},
          AbortSignal.timeout(5000),
          () => {
            throw new Error('Unexpected stdio');
          },
        );
        if (oversized) {
          const watchdog = new AbortController();
          try {
            const outcome = await Promise.race([
              result.then(
                () => 'resolved',
                () => 'rejected',
              ),
              delay(4000, 'pending', { signal: watchdog.signal }),
            ]);
            assert.equal(
              outcome,
              'rejected',
              'The decoded-byte bound must reject while the response tail is still withheld',
            );
          } finally {
            watchdog.abort();
          }
          assert.ok(
            sent < 10 * 1024 * 1024,
            `Must close before buffering the whole oversized response; sent ${sent}`,
          );
        } else {
          const snapshot = await result;
          assert.equal(snapshot[0].tools[0].description, padding);
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
}

void test('MCP catalog bytes are bounded before retaining another page', async () => {
  let pages = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') return void response.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Expected bytes');
      chunks.push(chunk);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!record(input)) throw new Error('Expected request');
    if (!('id' in input)) return void response.writeHead(202).end();
    const listing = input.method === 'tools/list';
    if (listing) pages++;
    const result = listing
      ? {
          tools: [
            {
              name: `tool${pages}`,
              description: 'x'.repeat(1024 * 1024),
              inputSchema: { type: 'object' },
            },
          ],
          ...(pages < 10 ? { nextCursor: String(pages) } : {}),
        }
      : {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'pages', version: '1' },
        };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP server');
  try {
    await assert.rejects(
      readOpenCodeMcpSnapshot(
        [
          {
            name: 'pages',
            type: 'http',
            url: `http://127.0.0.1:${address.port}/mcp`,
            headers: [],
          },
        ],
        {},
        AbortSignal.timeout(5000),
        () => {
          throw new Error('Unexpected stdio');
        },
      ),
    );
    assert.ok(
      pages <= 8,
      `Must stop before fetching more than the retained catalog limit; fetched ${pages}`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

void test('discovery counts cumulative decoded bytes across separate responses', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('x'.repeat(6 * 1024 * 1024));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP server');
  const abort = new AbortController();
  const boundedFetch = createOpenCodeDiscoveryFetch(
    AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    (error) => abort.abort(error),
  );
  try {
    const url = `http://127.0.0.1:${address.port}/events`;
    for (let i = 0; i < 2; i++) {
      const response = await boundedFetch(url);
      assert.equal((await response.arrayBuffer()).byteLength, 6 * 1024 * 1024);
    }
    const response = await boundedFetch(url);
    await assert.rejects(response.arrayBuffer());
    assert.ok(abort.signal.aborted);
    await assert.rejects(boundedFetch(url));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

void test('discovery preserves redirects and auth headers and cancels an active reader', async () => {
  let authorized = 0;
  let closed: Promise<unknown> = Promise.resolve();
  const server = createServer((request, response) => {
    if (request.headers.authorization === 'Bearer selected-credential')
      authorized++;
    if (request.url === '/redirect')
      return void response.writeHead(302, { location: '/events' }).end();
    closed = once(response, 'close');
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-fixture': 'preserved',
    });
    response.write('data: first\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP server');
  const abort = new AbortController();
  const boundedFetch = createOpenCodeDiscoveryFetch(
    AbortSignal.timeout(5000),
    (error) => {
      throw error;
    },
  );
  try {
    const url = `http://127.0.0.1:${address.port}`;
    const response = await boundedFetch(url + '/redirect', {
      signal: abort.signal,
      headers: { authorization: 'Bearer selected-credential' },
    });
    assert.equal(response.url, url + '/events');
    assert.equal(response.redirected, true);
    assert.equal(response.headers.get('x-fixture'), 'preserved');
    assert.equal(authorized, 2);
    const reader = response.body?.getReader();
    assert.ok(reader);
    assert.equal((await reader.read()).done, false);
    const pending = reader.read();
    const rejected = assert.rejects(pending);
    abort.abort();
    await rejected;
    await closed;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

void test('discovery bounds an oversized HTTP error body before SDK error parsing', async () => {
  let sent = 0;
  const server = createServer(async (_request, response) => {
    response.writeHead(500, { 'content-type': 'text/plain' });
    for (let i = 0; i < 160 && !response.destroyed; i++) {
      response.write('x'.repeat(64 * 1024));
      sent += 64 * 1024;
      await delay(1);
    }
    if (!response.destroyed) response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP server');
  const abort = new AbortController();
  const boundedFetch = createOpenCodeDiscoveryFetch(
    AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    (error) => abort.abort(error),
  );
  try {
    const response = await boundedFetch(`http://127.0.0.1:${address.port}/mcp`);
    assert.equal(response.status, 500);
    await assert.rejects(response.text());
    assert.ok(abort.signal.aborted);
    assert.ok(sent < 10 * 1024 * 1024);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const mode of ['cancelled', 'deadline'] as const) {
  void test('silent SSE handshake settles after ' + mode, async () => {
    const abort = new AbortController();
    const reason = new Error('Caller cancelled silent discovery');
    let closed = false;
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      response.once('close', () => {
        closed = true;
      });
      // No endpoint event: the SDK's transport.start() remains pending.
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP server');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const opened = once(server, 'request');
      let failure: unknown;
      const outcome = readOpenCodeMcpSnapshot(
        [
          {
            name: 'silent',
            type: 'sse',
            url: 'http://127.0.0.1:' + address.port + '/events',
            headers: [],
          },
        ],
        {},
        abort.signal,
        () => {
          throw new Error('Unexpected stdio');
        },
      ).then(
        () => 'resolved',
        (error: unknown) => {
          failure = error;
          return 'rejected';
        },
      );
      await opened;
      if (mode === 'cancelled') abort.abort(reason);
      const observed = await Promise.race([
        outcome,
        new Promise<string>((resolve) => {
          timer = setTimeout(
            () => resolve('pending'),
            mode === 'deadline' ? 18000 : 1000,
          );
        }),
      ]);
      assert.equal(observed, 'rejected', 'Discovery must settle after ' + mode);
      if (mode === 'cancelled') assert.equal(failure, reason);
      else {
        assert.ok(failure instanceof Error);
        assert.match(failure.message, /could not check the tools/);
        assert.equal(
          abort.signal.aborted,
          false,
          'The per-server deadline must work without caller cancellation',
        );
      }
      // Transport closure may reach the server in the next I/O turn.
      for (let i = 0; i < 50 && !closed; i++) await delay(10);
      assert.equal(closed, true, 'Discovery must close its network stream');
      assert.equal(requests, 1, 'Cancellation must not reconnect the stream');
    } finally {
      clearTimeout(timer);
      abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

void test('MCP snapshot denies a raw tool when another catalog entry aliases its native key', async () => {
  const snapshot: OpenCodeCapabilitySnapshot['mcp'] = [
    {
      name: 'fixture',
      identity: {},
      tools: ['files.read', 'files_read'].map((name) => ({
        name,
        inputSchema: { type: 'object' },
      })),
    },
  ];
  assert.equal(await matches(snapshot, 'fixture', 'files_read', {}), false);
  assert.equal(await matches(snapshot, 'fixture', 'files.read', {}), false);
});

void test('MCP snapshot still validates unique raw identities and rejects unlisted lookalikes', async () => {
  const snapshot: OpenCodeCapabilitySnapshot['mcp'] = [
    {
      name: 'fixture',
      identity: {},
      tools: [
        {
          name: 'files.read',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      ],
    },
  ];
  assert.equal(
    await matches(snapshot, 'fixture', 'files.read', { value: 'ok' }),
    true,
  );
  assert.equal(
    await matches(snapshot, 'fixture', 'files.read', { value: 42 }),
    false,
  );
  assert.equal(
    await matches(snapshot, 'fixture', 'files/read', { value: 'ok' }),
    false,
  );
});

void test('native keys reject cross-server, normalized-server and duplicate catalog collisions', async () => {
  for (const entries of [
    [
      ['a_b', 'read'],
      ['a', 'b_read'],
    ],
    [
      ['a.b', 'read'],
      ['a_b', 'read'],
    ],
    [
      ['selected', 'read'],
      ['selected', 'read'],
    ],
  ]) {
    const snapshot: OpenCodeCapabilitySnapshot['mcp'] = entries.map(
      ([name, tool]) => ({
        name,
        identity: {},
        tools: [{ name: tool, inputSchema: { type: 'object' } }],
      }),
    );
    for (const [server, tool] of entries)
      assert.equal(await matches(snapshot, server, tool, {}), false);
    assert.equal(
      resolveOpenCodeMcpSnapshotTool(snapshot, 'unknown_tool'),
      undefined,
    );
  }
});

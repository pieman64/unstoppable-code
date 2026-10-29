import { createServer, type Server } from 'node:http';
import { fetchPinnedHttpResponse } from '../mcp/pinned-http-fetch';

describe('fetchPinnedHttpResponse', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test HTTP server did not bind to a TCP port');
    }
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('falls back to another validated address when the first cannot connect', async () => {
    const response = await fetchPinnedHttpResponse(
      new URL(`http://mcp.example.test:${String(port)}`),
      [
        { address: '127.0.0.2', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      { 'content-type': 'application/json' },
      '{}',
      new AbortController().signal,
    );

    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

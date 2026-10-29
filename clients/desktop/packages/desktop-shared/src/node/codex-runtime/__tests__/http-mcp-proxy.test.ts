import { createServer, type Server } from 'node:http';
import { CodexHttpMcpProxyService } from '../http-mcp-proxy';

describe('CodexHttpMcpProxyService', () => {
  let proxy: CodexHttpMcpProxyService;
  let upstream: Server;
  let upstreamUrl: string;

  beforeEach(async () => {
    proxy = new CodexHttpMcpProxyService();
    upstream = createServer((request, response) => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-seen-authorization': request.headers.authorization ?? '',
      });
      response.write('data: first\n\n');
      setImmediate(() => response.end('data: second\n\n'));
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === 'string') {
      throw new Error('test upstream did not bind');
    }
    upstreamUrl = `http://127.0.0.1:${String(address.port)}/mcp`;
  });

  afterEach(async () => {
    await proxy.shutdown();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('projects an opaque route while keeping credentials in the parent', async () => {
    const lease = await proxy.registerRoute({
      ownerId: 'pipeline-1',
      upstreamUrl,
      headers: { Authorization: 'Bearer sentinel-secret' },
    });

    expect(lease.url).not.toContain('sentinel-secret');
    const response = await fetch(lease.url, {
      method: 'POST',
      body: '{}',
    });
    expect(response.headers.get('x-seen-authorization')).toBe(
      'Bearer sentinel-secret',
    );
    await expect(response.text()).resolves.toBe(
      'data: first\n\ndata: second\n\n',
    );
  });

  it('revokes routes by owner', async () => {
    const lease = await proxy.registerRoute({
      ownerId: 'pipeline-1',
      upstreamUrl,
    });
    proxy.revokeOwner('pipeline-1');

    const response = await fetch(lease.url, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });
});

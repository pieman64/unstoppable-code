import { createServer } from 'node:http';
import path from 'node:path';
import { writeJson } from './seeders/fsHelpers.mjs';

const NOW = '2026-09-03T12:00:00.000Z';

export async function getAvailablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Expected an IPv4 test listener.');
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export async function startOAuthFixtureServer({
  failFirstTokenRequest = false,
} = {}) {
  let tokenRequestCount = 0;
  const tokenRequests = [];
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && requestUrl.pathname === '/authorize') {
      const redirect = new URL(requestUrl.searchParams.get('redirect_uri'));
      redirect.searchParams.set('state', requestUrl.searchParams.get('state'));
      redirect.searchParams.set('code', 'fixture-consent');
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        `<!doctype html><html><head><title>Connect fixture account</title></head><body><h1>Connect your account</h1><p>Share this connection with your configured harnesses.</p><a id="authorize" href="${redirect.toString().replaceAll('&', '&amp;')}">Authorize connection</a></body></html>`,
      );
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/token') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        tokenRequests.push(Object.fromEntries(new URLSearchParams(body)));
      });
      tokenRequestCount += 1;
      if (failFirstTokenRequest && tokenRequestCount === 1) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'temporarily_unavailable' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          access_token: 'e2e-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      return;
    }
    if (requestUrl.pathname !== '/__e2e/mcp-oauth') {
      response.writeHead(404).end();
      return;
    }

    const target = new URL(
      requestUrl.searchParams.get('target') ?? 'https://invalid.test/',
    );
    if (request.method === 'POST' && target.pathname === '/mcp') {
      response.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate':
          'Bearer resource_metadata="https://mcp.vendor.test/.well-known/oauth-protected-resource"',
      });
      response.end(JSON.stringify({ error: 'authentication required' }));
      return;
    }
    if (
      request.method === 'GET' &&
      target.pathname === '/.well-known/oauth-protected-resource'
    ) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          resource: 'https://mcp.vendor.test/mcp',
          authorization_servers: ['https://mcp.vendor.test'],
        }),
      );
      return;
    }
    if (
      request.method === 'GET' &&
      target.pathname === '/.well-known/oauth-authorization-server'
    ) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          issuer: 'https://mcp.vendor.test',
          authorization_endpoint: 'https://mcp.vendor.test/authorize',
          token_endpoint: 'https://mcp.vendor.test/token',
          code_challenge_methods_supported: ['S256'],
        }),
      );
      return;
    }
    if (request.method === 'POST' && target.pathname === '/token') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          access_token: 'e2e-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'unregistered OAuth fixture URL' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('OAuth fixture did not bind a TCP port.');
  }
  return {
    server,
    tokenRequests,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
  };
}

export function seedVendorOAuthCatalog(
  userDataDir,
  callbackPort,
  fixtureBaseUrl,
) {
  writeJson(path.join(userDataDir, 'mcp-servers', 'curated-catalog.json'), {
    version: 1,
    // Keep the cache fresh so startup does not replace this deterministic
    // fixture with the unauthenticated mock catalog.
    fetchedAt: new Date().toISOString(),
    servers: [
      {
        key: 'vendor-oauth-callback',
        name: 'Vendor OAuth Callback',
        shortDescription: 'Fixed-port OAuth callback fixture',
        longDescription: 'Exercises a vendor-registered redirect URI.',
        url: 'https://mcp.vendor.test/mcp',
        transport: 'http',
        categories: ['development'],
        popular: true,
        sortOrder: 0,
        updatedAt: NOW,
        oauthHints: {
          clientId: 'vendor-client',
          callbackPort,
          // Discovery traffic has a dedicated E2E redirect, while token
          // exchange deliberately follows the normal client path. Explicit
          // local overrides keep the latter deterministic without teaching
          // production token requests about the fixture redirect.
          authorizationUrl: `${fixtureBaseUrl}/authorize`,
          tokenUrl: `${fixtureBaseUrl}/token`,
          usePkce: true,
        },
      },
    ],
  });
}

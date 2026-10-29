import { createServer } from 'node:http';
import { connect } from 'node:net';
import { DEFAULT_MOCK_BASE_URL } from './seeders/index.mjs';
import { startDesktopOAuthProviderStub } from './portal/desktopOAuthProviderStub.mjs';

// Only the external authorization provider is replaced. The desktop uses its
// real IPC, PKCE callback listener, credential store and policy application.
export async function startCloudOAuthLoopbackFixture() {
  const provider = await startDesktopOAuthProviderStub();
  let oauthExchanged = false;
  let guestLinkRequests = 0;
  let releaseGuestLink;
  const guestLinkBarrier = new Promise((resolve) => {
    releaseGuestLink = resolve;
  });
  let releaseAccount;
  const accountBarrier = new Promise((resolve) => {
    releaseAccount = resolve;
  });
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if (pathname.endsWith('/desktop-auth/guest-link-ticket')) {
        guestLinkRequests += 1;
        await guestLinkBarrier;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ticket: 'loopback-guest-link' }));
        return;
      }
      if (pathname.endsWith('/desktop-auth/token')) {
        oauthExchanged = true;
        for await (const _chunk of request) {
          /* drain the token request */
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            token: 'csk_loopback_test',
            userApiKey: { id: 'loopback-key' },
            account: {
              id: 'loopback-user',
              name: 'Loopback User',
              email: 'loopback@example.test',
              role: 'DEVELOPER',
            },
            capabilities: [
              'pipelines-crud-v1',
              'account-v1',
              'organizations-v1',
              'teams-v1',
              'memorySearch',
            ],
            organizations: [],
            teams: [],
            enforcedSettings: [],
            orgBillingStates: [],
          }),
        );
        return;
      }
      if (oauthExchanged && pathname.endsWith('/account')) {
        await accountBarrier;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(
        new URL(request.url, DEFAULT_MOCK_BASE_URL),
        {
          method: request.method,
          headers: {
            Authorization:
              request.headers.authorization ?? 'Bearer csk_loopback_test',
            'Content-Type': 'application/json',
          },
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        },
      );
      response.writeHead(upstream.status, {
        'Content-Type': 'application/json',
      });
      response.end(await upstream.text());
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    env: {
      CANOPY_E2E_CLOUD_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: provider.externalOpenCaptureUrl,
      CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
        'canopy-billing-enabled': true,
      }),
    },
    nextExternalUrl: () => provider.nextExternalUrl(),
    releaseAccount: () => releaseAccount(),
    guestLinkRequests: () => guestLinkRequests,
    releaseGuestLink: () => releaseGuestLink(),
    async stop() {
      releaseAccount();
      releaseGuestLink();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await provider.stop();
    },
  };
}

export async function openUnfinishedCallbackRequest(callback) {
  const socket = connect(Number(callback.port), '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write('GET / HTTP/1.1\r\n');
  // Ensure the listener has consumed the incomplete headers before settling.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return socket;
}

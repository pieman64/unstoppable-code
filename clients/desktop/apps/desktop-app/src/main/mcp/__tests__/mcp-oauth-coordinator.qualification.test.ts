import { mkdtempSync, rmSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  McpServerConfigData,
  McpServerDefinitionData,
} from '@canopy/execution-engine/types/mcp-servers';
import type * as CanopyCloudClientModule from '../../canopy-cloud/client';
import type * as PathsModule from '../../lib/paths';
import type { SecretStoragePolicy } from '../../lib/secure-storage-policy';
import type * as OAuthClientModule from '../oauth-client';

let dataDir = '';
const launches: string[] = [];
jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../../lib/paths'),
  getMcpOAuthTokenStorePath: (): string =>
    join(dataDir, 'secure', 'mcp-oauth-tokens.json'),
  getLegacyMcpOAuthTokenStorePath: (): string =>
    join(dataDir, 'legacy-mcp-oauth-tokens.json'),
  getInternalLegacySharedMcpOAuthTokenStorePath: (): string =>
    join(dataDir, 'shared-mcp-oauth-tokens.json'),
  getMcpServerFilePath: (serverId: string): string =>
    join(dataDir, 'mcp-servers', `server-${serverId}.json`),
}));
jest.mock('../../lib/secure-storage-policy', () => ({
  getSecureStorageFailure: (): null => null,
  getSecretStoragePolicy: (): Omit<SecretStoragePolicy, 'getStatus'> => ({
    isWriteAvailable: (): boolean => true,
    nativeEncryptionAvailable: (): boolean => true,
    assertCanRead: (): void => undefined,
    assertCanWrite: (): void => undefined,
    encrypt: (text: string): Buffer =>
      Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
    decrypt: (ciphertext: Buffer): string =>
      Buffer.from(
        ciphertext.toString().replace(/^enc:/, ''),
        'base64',
      ).toString(),
  }),
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));
jest.mock('../oauth-e2e-fixture', () => ({
  resolveE2eMcpOAuthFixtureUrl: (): null => null,
  resolveE2eMcpOAuthPublicAddresses: (): null => null,
  recordE2eMcpOAuthAuthorizationLaunch: (url: string): boolean => {
    launches.push(url);
    return true;
  },
}));

import {
  setMcpOAuthSettledListener,
  type McpOAuthSettledEvent,
} from '../oauth-client';
import {
  EMBEDDED_SIGN_IN_NEEDS_LEASE_MESSAGE,
  createMcpOAuthCoordinator,
  type McpSignInPresenterLeases,
} from '../oauth-coordinator';
import { getMcpOAuthToken } from '../oauth-token-store';

const CANARIES = [
  'secret-canary-access-1',
  'secret-canary-refresh-2',
  'secret-canary-client-3',
];
const NOW = '2026-11-05T00:00:00.000Z';
const CONFIG_ID = 'cfg';

interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address: AddressInfo | string | null = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET' }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('MCP OAuth coordinator (CAN-4126)', () => {
  let server: Server;
  let base: string;
  let requests: RecordedRequest[];
  let proxyPort: number;
  const live = new Set(['lease-7']);
  const fakeLeases: McpSignInPresenterLeases = {
    leaseFor: (id) => (id === 7 ? 'lease-7' : null),
    isLive: (id) => live.has(id),
  };
  const coordinator = createMcpOAuthCoordinator({ leases: () => fakeLeases });
  const settled: McpOAuthSettledEvent[] = [];
  const results: unknown[] = [];
  let caseNumber = 0;
  let completedState = '';

  const config: McpServerConfigData = {
    id: CONFIG_ID,
    name: 'Default',
    description: '',
    enabled: true,
    envVars: {},
    extraArgs: [],
    extraHeaders: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
  const definition = (
    oauth: Partial<NonNullable<McpServerDefinitionData['oauth']>> = {},
  ): McpServerDefinitionData => {
    caseNumber += 1;
    return {
      id: `srv-${String(caseNumber)}`,
      name: 'Server',
      description: '',
      type: 'http',
      url: `${base}/mcp`,
      oauth: {
        authorizationUrl: `${base}/authorize`,
        tokenUrl: `${base}/token`,
        clientId: 'client-1',
        clientSecret: 'secret-canary-client-3',
        usePkce: true,
        ...oauth,
      },
      createdAt: NOW,
      updatedAt: NOW,
    };
  };
  const tokenRequests = (): RecordedRequest[] =>
    requests.filter((request) => request.path === '/token');
  const stateOf = (authorizationUrl: string | undefined): string =>
    new URL(authorizationUrl ?? 'http://x').searchParams.get('state') ?? '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'can-4126-coordinator-'));
    setMcpOAuthSettledListener((event) => settled.push(event));
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        requests.push({
          method: req.method ?? '',
          path,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (path === '/mcp') {
          res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
          res.end();
        } else if (path === '/token') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'secret-canary-access-1',
              refresh_token: 'secret-canary-refresh-2',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    base = `http://127.0.0.1:${String(await listen(server))}`;
    proxyPort = await freePort();
  });

  afterAll(async () => {
    setMcpOAuthSettledListener(null);
    await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests = [];
    launches.length = 0;
  });

  it('a main-window sign-in completes through the loopback callback', async () => {
    const target = definition();
    const started = await coordinator.start({
      definition: target,
      config,
      proxyPort,
      presenterWebContentsId: 99,
    });
    results.push(started);

    expect(started.status).toBe('started');
    expect(launches).toHaveLength(1);
    const state = stateOf(launches[0]);
    expect(started.flowId).toBe(state);
    const completed = await coordinator.completeCallback(
      new URL(
        `http://127.0.0.1:${String(proxyPort)}/oauth/callback?code=c1&state=${state}`,
      ),
    );
    results.push(completed);
    completedState = state;

    expect(completed).toEqual({
      success: true,
      message: 'OAuth sign-in completed.',
    });
    expect(tokenRequests()).toHaveLength(1);
    expect(
      new URLSearchParams(tokenRequests()[0]?.body).get('client_secret'),
    ).toBe('secret-canary-client-3');
    expect((await getMcpOAuthToken(target.id, CONFIG_ID))?.accessToken).toBe(
      'secret-canary-access-1',
    );
  });

  it('a plugin sign-in completes through a vendor callback port', async () => {
    const callbackPort = await freePort();
    const target = definition({ callbackPort, vendorRegisteredRedirect: true });
    const started = await coordinator.start({
      definition: target,
      config,
      proxyPort,
    });
    results.push(started);
    const state = stateOf(started.authorizationUrl);

    const response = await get(
      `http://127.0.0.1:${String(callbackPort)}/callback?code=c2&state=${state}`,
    );

    expect(response.status).toBe(200);
    expect((await getMcpOAuthToken(target.id, CONFIG_ID))?.accessToken).toBe(
      'secret-canary-access-1',
    );
  });

  it('an embedded sign-in is presented only to the client that holds the lease', async () => {
    const target = definition();
    await expect(
      coordinator.start({
        definition: target,
        config,
        proxyPort,
        browser: 'embedded',
        presenterWebContentsId: 8,
      }),
    ).rejects.toThrow(EMBEDDED_SIGN_IN_NEEDS_LEASE_MESSAGE);
    expect(launches).toHaveLength(0);
    expect(requests).toHaveLength(0);

    const started = await coordinator.start({
      definition: target,
      config,
      proxyPort,
      browser: 'embedded',
      presenterWebContentsId: 7,
    });
    results.push(started);

    expect(started.status).toBe('started');
    expect(started.authorizationUrl).toBeTruthy();
    expect(launches).toHaveLength(0);
  });

  it('an embedded sign-in whose presenting lease ended is refused at the callback', async () => {
    const target = definition();
    const started = await coordinator.start({
      definition: target,
      config,
      proxyPort,
      browser: 'embedded',
      presenterWebContentsId: 7,
    });
    results.push(started);
    const state = stateOf(started.authorizationUrl);
    live.delete('lease-7');
    const callback = new URL(
      `http://127.0.0.1:${String(proxyPort)}/oauth/callback?code=c4&state=${state}`,
    );

    try {
      const refused = await coordinator.completeCallback(callback);
      results.push(refused);
      expect(refused).toEqual({
        success: false,
        message: 'Sign-in was canceled.',
      });
      expect(tokenRequests()).toHaveLength(0);
      expect(await getMcpOAuthToken(target.id, CONFIG_ID)).toBeNull();
      expect(await coordinator.completeCallback(callback)).toEqual({
        success: false,
        message: 'OAuth sign-in state expired or invalid.',
      });
    } finally {
      live.add('lease-7');
    }
  });

  it('a callback with an unknown or reused state is refused and saves nothing', async () => {
    const callback = (state: string): URL =>
      new URL(
        `http://127.0.0.1:${String(proxyPort)}/oauth/callback?code=c5&state=${state}`,
      );
    expect(completedState).not.toBe('');
    for (const state of ['AAAAAAAAAAAAAAAAAAAAAA', completedState]) {
      const result = await coordinator.completeCallback(callback(state));
      results.push(result);
      expect(result.success).toBe(false);
    }
    expect(tokenRequests()).toHaveLength(0);
  });

  it('the integration server routes callbacks only through the coordinator', async () => {
    await jest.isolateModulesAsync(async () => {
      const completeCallback = jest.fn(() =>
        Promise.resolve({ success: true, message: 'OAuth sign-in completed.' }),
      );
      const handleMcpOAuthCallback = jest.fn();
      jest.doMock('../oauth-coordinator', () => ({
        getMcpOAuthCoordinator: (): {
          completeCallback: typeof completeCallback;
        } => ({
          completeCallback,
        }),
      }));
      jest.doMock('../oauth-client', () => ({
        ...jest.requireActual<typeof OAuthClientModule>('../oauth-client'),
        handleMcpOAuthCallback,
      }));
      jest.doMock('../../canopy-cloud/client', () => ({
        CanopyCloudClientError: jest.requireActual<
          typeof CanopyCloudClientModule
        >('../../canopy-cloud/client').CanopyCloudClientError,
        resolveCanopyCloudCredentialContext: jest.fn(),
      }));
      const { McpHttpProxyService } = await import('../http-proxy-service');
      const service = new McpHttpProxyService();
      const port = await freePort();
      try {
        await service.ensureStarted(port);
        const response = await get(
          `http://127.0.0.1:${String(port)}/oauth/callback?state=s`,
        );

        expect(response.status).toBe(200);
        expect(completeCallback).toHaveBeenCalledTimes(1);
        expect(completeCallback).toHaveBeenCalledWith(
          new URL(`http://127.0.0.1:${String(port)}/oauth/callback?state=s`),
        );
        expect(handleMcpOAuthCallback).not.toHaveBeenCalled();
      } finally {
        await service.shutdown();
      }
    });
  }, 60_000);

  it('no token or client secret reaches the client', () => {
    expect(settled.length).toBeGreaterThan(0);
    for (const event of settled)
      expect(Object.keys(event).sort()).toEqual(
        Object.keys(event).length === 1
          ? ['success']
          : ['configId', 'serverId', 'success'],
      );
    for (const text of [...results, ...settled].map((value) =>
      JSON.stringify(value),
    ))
      for (const canary of CANARIES) expect(text).not.toContain(canary);
  });
});

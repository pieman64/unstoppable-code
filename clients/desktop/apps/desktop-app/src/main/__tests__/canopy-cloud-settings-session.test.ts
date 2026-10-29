import { EventEmitter } from 'node:events';

interface RecordedRequest {
  url: string;
  method: string;
  origin: string | undefined;
  credentials: string | undefined;
  redirect: string | undefined;
  cache: string | undefined;
  session: unknown;
  headers: Record<string, string>;
  body: string;
  aborted: boolean;
}

interface StreamControl {
  push(text: string): void;
  end(): void;
}

type FakeReply =
  | { status: number; headers?: Record<string, string>; body?: string }
  | { redirect: { status: number; location: string } }
  | { error: string }
  | { hang: true }
  | { stream: (control: StreamControl) => void; status?: number };

const mockRequests: RecordedRequest[] = [];
let mockRoute: (
  request: RecordedRequest,
) => FakeReply | Promise<FakeReply> = () => ({ status: 404 });
const mockPermissionRequest = jest.fn<
  void,
  [
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ]
>();
const mockPermissionCheck = jest.fn<
  void,
  [handler: (webContents: unknown, permission: string) => boolean]
>();
const mockClearStorageData = jest.fn();
const mockFakeSession = {
  setPermissionRequestHandler: mockPermissionRequest,
  setPermissionCheckHandler: mockPermissionCheck,
  clearStorageData: mockClearStorageData,
};
const mockFromPartition = jest.fn();
const mockAppOn = jest.fn<void, [event: string, listener: () => void]>();
const mockAppRemoveListener = jest.fn();
const mockRequestCanopyCloudJson = jest.fn<
  Promise<unknown>,
  [path: string, init: Record<string, unknown>]
>();
const mockGetCanopyCloudCredentials = jest.fn();
const mockSubscribeAccountChanges = jest.fn<
  () => void,
  [listener: (entry: unknown) => void]
>();
const mockUnsubscribeAccountChanges = jest.fn();
const mockPeekCanopyCloudAccount = jest.fn<unknown, []>();

class MockIncomingMessage extends EventEmitter {
  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string>,
  ) {
    super();
  }
  readonly statusMessage = '';
}

class MockClientRequest extends EventEmitter {
  readonly record: RecordedRequest;
  private followed = false;

  constructor(options: {
    url: string;
    method?: string;
    origin?: string;
    credentials?: string;
    redirect?: string;
    cache?: string;
    session?: unknown;
  }) {
    super();
    this.record = {
      url: options.url,
      method: options.method ?? 'GET',
      origin: options.origin,
      credentials: options.credentials,
      redirect: options.redirect,
      cache: options.cache,
      session: options.session,
      headers: {},
      body: '',
      aborted: false,
    };
    mockRequests.push(this.record);
  }

  setHeader(name: string, value: string): void {
    this.record.headers[name.toLowerCase()] = value;
  }

  write(chunk: string | Buffer): void {
    this.record.body += chunk.toString();
  }

  abort(): void {
    this.record.aborted = true;
  }

  followRedirect(): void {
    this.followed = true;
  }

  end(): void {
    void Promise.resolve(mockRoute(this.record)).then((reply) =>
      this.deliver(reply),
    );
  }

  private deliver(reply: FakeReply): void {
    if (this.record.aborted) return;
    if ('hang' in reply) return;
    if ('error' in reply) {
      this.emit('error', new Error(reply.error));
      return;
    }
    if ('redirect' in reply) {
      this.emit(
        'redirect',
        reply.redirect.status,
        this.record.method,
        reply.redirect.location,
        {},
      );
      if (!this.followed)
        this.emit('error', new Error('Redirect was cancelled'));
      return;
    }
    if ('stream' in reply) {
      const message = new MockIncomingMessage(reply.status ?? 200, {
        'content-type': 'text/event-stream',
      });
      this.emit('response', message);
      reply.stream({
        push: (text) => {
          if (!this.record.aborted) message.emit('data', Buffer.from(text));
        },
        end: () => {
          if (!this.record.aborted) message.emit('end');
        },
      });
      return;
    }
    const message = new MockIncomingMessage(reply.status, {
      'content-type': 'application/json',
      ...(reply.headers ?? {}),
    });
    this.emit('response', message);
    setImmediate(() => {
      if (this.record.aborted) return;
      if (reply.body !== undefined)
        message.emit('data', Buffer.from(reply.body));
      message.emit('end');
    });
  }
}

jest.mock('electron', () => ({
  app: {
    on: (...args: unknown[]): unknown => mockAppOn(...args),
    removeListener: (...args: unknown[]): unknown =>
      mockAppRemoveListener(...args),
  },
  session: {
    fromPartition: (...args: unknown[]): unknown => mockFromPartition(...args),
  },
  net: {
    request: (
      options: ConstructorParameters<typeof MockClientRequest>[0],
    ): MockClientRequest => new MockClientRequest(options),
  },
}));
jest.mock('../canopy-cloud/client', () => {
  class CanopyCloudClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status?: number,
    ) {
      super(message);
    }
  }
  return {
    CanopyCloudClientError,
    requestCanopyCloudJson: (...args: unknown[]): unknown =>
      mockRequestCanopyCloudJson(...args),
  };
});
jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: (): unknown => mockGetCanopyCloudCredentials(),
  peekCanopyCloudAccount: (): unknown => mockPeekCanopyCloudAccount(),
  subscribeCanopyCloudAccountChanges: (...args: unknown[]): unknown =>
    mockSubscribeAccountChanges(...args),
  hasCanopyCloudIdentityChanged: (
    previous: { apiKey: string; account?: { id: string } } | null,
    next: { apiKey: string; account?: { id: string } },
  ): boolean =>
    previous === null ||
    (previous.account && next.account
      ? previous.account.id !== next.account.id
      : previous.apiKey !== next.apiKey),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import { BRAND } from '@canopy/brand/current';
import { SettingsOperationError } from '@canopy/protocol/settings';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  SETTINGS_BRIDGE_IDLE_MS,
  SETTINGS_BRIDGE_PARTITION,
  SETTINGS_BRIDGE_SIGN_OUT_TIMEOUT_MS,
  acquireSettingsBridgeSession,
  disposeAllSettingsBridgeSessions,
  installSettingsBridgeLifecycle,
  resetSettingsBridgeForTests,
  type SettingsBridgeSession,
} from '../canopy-cloud/settings-session';

const BASE = 'https://cloud.example.test';
const OTHER_BASE = 'https://cloud-two.example.test';
const ACCOUNT_ID = 'acct-1';
const CONSUME_PATH = `/api/v1/${BRAND.web.apiNamespace}/auth-link/consume`;
const CONSUME_URL = `${BASE}${CONSUME_PATH}?code=abc`;

function bootstrap(viewerId = ACCOUNT_ID): string {
  return JSON.stringify({
    version: 1,
    viewer: { id: viewerId, email: 'a@example.test', name: null },
    account: {
      billingEnabled: true,
      digestsEnabled: true,
      integrationsEnabled: true,
      freeAccess: false,
    },
    organizations: [],
    organization: null,
  });
}

function credentials(
  overrides: { baseUrl?: string; accountId?: string } = {},
): unknown {
  return {
    baseUrl: overrides.baseUrl ?? BASE,
    apiKey: 'csk_test',
    capabilities: [],
    memorySearchOrganizationExternalIds: [],
    account: {
      id: overrides.accountId ?? ACCOUNT_ID,
      name: 'A',
      email: 'a@example.test',
      role: 'DEVELOPER',
    },
  };
}

let routes: Record<string, (request: RecordedRequest) => FakeReply> = {};

function defaultRoute(
  request: RecordedRequest,
): FakeReply | Promise<FakeReply> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  const custom = routes[key];
  if (custom) return custom(request);
  if (url.pathname === CONSUME_PATH)
    return { redirect: { status: 303, location: `${url.origin}/` } };
  if (key === 'GET /api/v1/settings/bootstrap')
    return { status: 200, body: bootstrap() };
  if (key === 'POST /api/auth/sign-out') return { status: 200, body: '{}' };
  return { status: 200, body: '{}' };
}

function requestsTo(pathname: string): RecordedRequest[] {
  return mockRequests.filter(
    (request) => new URL(request.url).pathname === pathname,
  );
}

async function flush(times = 5): Promise<void> {
  for (let index = 0; index < times; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

async function readySession(): Promise<SettingsBridgeSession> {
  const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
  await session.ensureReady();
  return session;
}

async function rejection(
  promise: Promise<unknown>,
): Promise<SettingsOperationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SettingsOperationError) return error;
    throw error;
  }
  throw new Error('Expected a rejection');
}

beforeEach((): void => {
  jest.useRealTimers();
  jest.clearAllMocks();
  resetSettingsBridgeForTests();
  mockRequests.length = 0;
  routes = {};
  mockRoute = defaultRoute;
  mockFromPartition.mockReturnValue(mockFakeSession);
  mockClearStorageData.mockResolvedValue(undefined);
  mockGetCanopyCloudCredentials.mockResolvedValue(credentials());
  mockPeekCanopyCloudAccount.mockReturnValue(null);
  mockRequestCanopyCloudJson.mockResolvedValue({ url: CONSUME_URL });
  mockSubscribeAccountChanges.mockReturnValue(mockUnsubscribeAccountChanges);
});

afterEach(async (): Promise<void> => {
  jest.useRealTimers();
  await disposeAllSettingsBridgeSessions('quit');
});

describe('settings bridge session creation', () => {
  it('creates sessions lazily and reuses the live one', async () => {
    const first = await acquireSettingsBridgeSession(ACCOUNT_ID);
    const second = await acquireSettingsBridgeSession(ACCOUNT_ID);
    expect(second).toBe(first);
    expect(first.state).toBe('uninitialized');
    expect(first.generation).toBe(1);
    expect(mockFromPartition).not.toHaveBeenCalled();
    expect(mockRequestCanopyCloudJson).not.toHaveBeenCalled();
    expect(mockRequests).toHaveLength(0);
  });

  it('refuses an account that is not the signed-in account', async () => {
    expect(
      (await rejection(acquireSettingsBridgeSession('acct-other'))).code,
    ).toBe('unauthenticated');
    mockGetCanopyCloudCredentials.mockRejectedValue(new Error('no key'));
    expect(
      (await rejection(acquireSettingsBridgeSession(ACCOUNT_ID))).code,
    ).toBe('unauthenticated');
  });

  it('uses an in-memory partition with every permission denied', async () => {
    const session = await readySession();
    expect(session.state).toBe('ready');
    expect(mockFromPartition).toHaveBeenCalledTimes(1);
    expect(mockFromPartition).toHaveBeenCalledWith(SETTINGS_BRIDGE_PARTITION, {
      cache: false,
    });
    expect(SETTINGS_BRIDGE_PARTITION).toBe('canopy-settings-bridge');
    expect(SETTINGS_BRIDGE_PARTITION.startsWith('persist:')).toBe(false);
    const requestHandler = mockPermissionRequest.mock.calls[0]?.[0];
    const callback = jest.fn();
    if (requestHandler === undefined) throw new Error('no handler');
    requestHandler({}, 'media', callback);
    expect(callback).toHaveBeenCalledWith(false);
    const checkHandler = mockPermissionCheck.mock.calls[0]?.[0];
    if (checkHandler === undefined) throw new Error('no handler');
    expect(checkHandler({}, 'notifications')).toBe(false);
    for (const request of mockRequests) {
      expect(request.session).toBe(mockFakeSession);
      expect(request.credentials).toBe('include');
      expect(request.redirect).toBe('manual');
      expect(request.cache).toBe('no-store');
      expect(new URL(request.url).origin).toBe(BASE);
    }
  });
});

describe('settings bridge minting', () => {
  it('mints once for concurrent callers with the captured credential', async () => {
    const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
    await Promise.all([session.ensureReady(), session.ensureReady()]);
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledTimes(1);
    const [path, init] = mockRequestCanopyCloudJson.mock.calls[0] ?? [];
    expect(path).toBe(`/api/v1/${BRAND.web.apiNamespace}/auth-link`);
    expect(init).toMatchObject({
      method: 'POST',
      credentialContext: { apiKey: 'csk_test', baseUrl: BASE },
    });
    expect(requestsTo(CONSUME_PATH)).toHaveLength(1);
    expect(requestsTo('/api/v1/settings/bootstrap')).toHaveLength(1);
    expect(session.state).toBe('ready');
  });

  it('disposes and fails when the bootstrap viewer is another account', async () => {
    routes['GET /api/v1/settings/bootstrap'] = (): FakeReply => ({
      status: 200,
      body: bootstrap('acct-2'),
    });
    const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
    expect((await rejection(session.ensureReady())).code).toBe('expired');
    expect(session.state).toBe('disposed');
    expect(requestsTo('/api/auth/sign-out')).toHaveLength(1);
    expect(mockClearStorageData).toHaveBeenCalled();
    const next = await acquireSettingsBridgeSession(ACCOUNT_ID);
    expect(next).not.toBe(session);
    expect(next.generation).toBe(2);
  });

  it('terminates on a 403 two-factor mint and never remints around it', async () => {
    mockRequestCanopyCloudJson.mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'Two-factor authentication required',
        403,
      ),
    );
    const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
    expect((await rejection(session.ensureReady())).code).toBe('expired');
    expect(session.state).toBe('expired');
    expect(
      (await rejection(session.ensureReady({ userInitiated: true }))).code,
    ).toBe('expired');
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledTimes(1);
    expect(requestsTo(CONSUME_PATH)).toHaveLength(0);
  });

  it('rejects a consume URL on another origin before requesting it', async () => {
    mockRequestCanopyCloudJson.mockResolvedValue({
      url: `https://evil.example.test${CONSUME_PATH}?code=abc`,
    });
    const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
    expect((await rejection(session.ensureReady())).code).toBe(
      'invalid_response',
    );
    expect(mockRequests).toHaveLength(0);
  });

  it('fails when consume redirects to /login', async () => {
    routes[`GET ${CONSUME_PATH}`] = (): FakeReply => ({
      redirect: { status: 303, location: `${BASE}/login` },
    });
    const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
    expect((await rejection(session.ensureReady())).code).toBe('expired');
    expect(session.state).toBe('expired');
    expect(mockClearStorageData).toHaveBeenCalled();
  });

  it('fails when consume redirects to another origin', async () => {
    routes[`GET ${CONSUME_PATH}`] = (): FakeReply => ({
      redirect: { status: 303, location: 'https://evil.example.test/' },
    });
    const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
    expect((await rejection(session.ensureReady())).code).toBe(
      'invalid_response',
    );
  });

  it('reports an unsupported server for a missing bootstrap and cools down', async () => {
    routes['GET /api/v1/settings/bootstrap'] = (): FakeReply => ({
      status: 404,
    });
    const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
    expect((await rejection(session.ensureReady())).code).toBe(
      'unsupported_server',
    );
    expect(session.state).toBe('uninitialized');
    expect((await rejection(session.ensureReady())).code).toBe(
      'unsupported_server',
    );
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledTimes(1);
    expect(
      (await rejection(session.ensureReady({ userInitiated: true }))).code,
    ).toBe('unsupported_server');
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledTimes(2);
  });

  it('maps an unreachable mint to offline', async () => {
    mockRequestCanopyCloudJson.mockRejectedValue(
      new CanopyCloudClientError('network-error', 'down'),
    );
    const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
    expect((await rejection(session.ensureReady())).code).toBe('offline');
  });
});

describe('settings bridge requests', () => {
  it('sends Origin only for auth requests and writes', async () => {
    const session = await readySession();
    mockRequests.length = 0;
    await session.fetch('/api/account/api-keys', { method: 'GET' });
    await session.fetch('/api/auth/change-password', {
      method: 'POST',
      body: '{}',
      authOrigin: true,
    });
    await session.fetch('/api/account/profile', {
      method: 'PATCH',
      body: '{}',
    });
    expect(mockRequests.map((request) => request.origin)).toEqual([
      undefined,
      BASE,
      BASE,
    ]);
    expect(mockRequests[1]?.body).toBe('{}');
  });

  it('refuses paths that would leave the configured origin', async () => {
    const session = await readySession();
    for (const path of [
      '//evil.example.test/x',
      'https://evil.example.test',
      '/\\evil',
    ])
      expect(
        (await rejection(session.fetch(path, { method: 'GET' }))).code,
      ).toBe('failed');
  });

  it('expires on 401 and remints at most once per user action', async () => {
    const session = await readySession();
    routes['GET /api/account/profile'] = (): FakeReply => ({ status: 401 });
    const response = await session.fetch('/api/account/profile', {
      method: 'GET',
    });
    expect(response.status).toBe(401);
    expect(session.state).toBe('expired');
    expect(
      (
        await rejection(
          session.fetch('/api/account/profile', { method: 'GET' }),
        )
      ).code,
    ).toBe('expired');
    expect((await rejection(session.ensureReady())).code).toBe('expired');
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledTimes(1);

    mockRequestCanopyCloudJson.mockRejectedValue(
      new CanopyCloudClientError('http-error', 'Two-factor required', 403),
    );
    const [first, second] = await Promise.allSettled([
      session.ensureReady({ userInitiated: true }),
      session.ensureReady({ userInitiated: true }),
    ]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('rejected');
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledTimes(2);
    expect(
      (await rejection(session.ensureReady({ userInitiated: true }))).code,
    ).toBe('expired');
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledTimes(2);
  });

  it('stays ready on a 401 that rejects a typed credential', async () => {
    const session = await readySession();
    routes['POST /api/account/two-factor/session'] = (): FakeReply => ({
      status: 401,
    });
    const response = await session.fetch('/api/account/two-factor/session', {
      method: 'POST',
      rejectedCredentialOn401: true,
    });
    expect(response.status).toBe(401);
    expect(session.state).toBe('ready');
    await session.ensureReady();
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledTimes(1);
  });

  it('recovers with one user-initiated remint after a 401', async () => {
    const session = await readySession();
    routes['GET /api/account/profile'] = (): FakeReply => ({ status: 401 });
    await session.fetch('/api/account/profile', { method: 'GET' });
    expect(session.state).toBe('expired');
    await session.ensureReady({ userInitiated: true });
    expect(session.state).toBe('ready');
    expect(mockRequestCanopyCloudJson).toHaveBeenCalledTimes(2);
    expect(session.generation).toBe(1);
  });

  it('discards a response that completes after disposal', async () => {
    const session = await readySession();
    let release: (reply: FakeReply) => void = () => undefined;
    mockRoute = (request): FakeReply | Promise<FakeReply> =>
      new URL(request.url).pathname === '/api/account/slow'
        ? new Promise<FakeReply>((resolve) => {
            release = resolve;
          })
        : defaultRoute(request);
    const pending = session.fetch('/api/account/slow', { method: 'GET' });
    await flush();
    void session.dispose('account_changed');
    release({ status: 200, body: '{"ok":true}' });
    expect((await rejection(pending)).code).toBe('expired');
    expect(
      (await rejection(session.fetch('/api/account/x', { method: 'GET' })))
        .code,
    ).toBe('expired');
  });

  it('discards a response from before a remint', async () => {
    const session = await readySession();
    let release: (reply: FakeReply) => void = () => undefined;
    routes['GET /api/account/profile'] = (): FakeReply => ({ status: 401 });
    mockRoute = (request): FakeReply | Promise<FakeReply> =>
      new URL(request.url).pathname === '/api/account/slow'
        ? new Promise<FakeReply>((resolve) => {
            release = resolve;
          })
        : defaultRoute(request);
    const stale = session.fetch('/api/account/slow', { method: 'GET' });
    await flush();
    await session.fetch('/api/account/profile', { method: 'GET' });
    await session.ensureReady({ userInitiated: true });
    release({ status: 200, body: '{"ok":true}' });
    expect((await rejection(stale)).code).toBe('expired');
    expect(session.state).toBe('ready');
  });

  it('reports a write sent before a remint as uncertain, not ended', async () => {
    const session = await readySession();
    let release: (reply: FakeReply) => void = () => undefined;
    routes['GET /api/account/profile'] = (): FakeReply => ({ status: 401 });
    mockRoute = (request): FakeReply | Promise<FakeReply> =>
      new URL(request.url).pathname === '/api/account/slow'
        ? new Promise<FakeReply>((resolve) => {
            release = resolve;
          })
        : defaultRoute(request);
    const stale = session.fetch('/api/account/slow', { method: 'PATCH' });
    await flush();
    await session.fetch('/api/account/profile', { method: 'GET' });
    await session.ensureReady({ userInitiated: true });
    release({ status: 200, body: '{"ok":true}' });
    expect((await rejection(stale)).code).toBe('uncertain');
  });
});

describe('settings bridge mint bootstrap reuse', () => {
  const BOOTSTRAP_PATH = '/api/v1/settings/bootstrap';

  it('answers the first account-scoped bootstrap read once from the mint', async () => {
    const session = await readySession();
    expect(requestsTo(BOOTSTRAP_PATH)).toHaveLength(1);
    const first = await session.fetch(BOOTSTRAP_PATH, { method: 'GET' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(JSON.parse(bootstrap()));
    expect(requestsTo(BOOTSTRAP_PATH)).toHaveLength(1);
    await session.fetch(BOOTSTRAP_PATH, { method: 'GET' });
    expect(requestsTo(BOOTSTRAP_PATH)).toHaveLength(2);
  });

  it('sends a concurrent second read to the network', async () => {
    const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
    const [first, second] = await Promise.all([
      session.fetch(BOOTSTRAP_PATH, { method: 'GET' }),
      session.fetch(BOOTSTRAP_PATH, { method: 'GET' }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The mint's own read plus exactly one network read.
    expect(requestsTo(BOOTSTRAP_PATH)).toHaveLength(2);
  });

  it('never answers an organization-scoped read from the mint, which consumes it', async () => {
    const session = await readySession();
    await session.fetch(`${BOOTSTRAP_PATH}?organizationId=org-1`, {
      method: 'GET',
    });
    expect(requestsTo(BOOTSTRAP_PATH)).toHaveLength(2);
    expect(mockRequests.at(-1)?.url).toBe(
      `${BASE}${BOOTSTRAP_PATH}?organizationId=org-1`,
    );
    // Only the first bootstrap read after the mint may use the entry, so a
    // later account read (a forced refresh or Retry) goes to the network.
    await session.fetch(BOOTSTRAP_PATH, { method: 'GET' });
    expect(requestsTo(BOOTSTRAP_PATH)).toHaveLength(3);
  });

  it('discards the mint bootstrap after 30 seconds', async () => {
    const now = jest.spyOn(Date, 'now');
    const start = Date.now();
    now.mockReturnValue(start);
    const session = await readySession();
    now.mockReturnValue(start + 30_001);
    await session.fetch(BOOTSTRAP_PATH, { method: 'GET' });
    expect(requestsTo(BOOTSTRAP_PATH)).toHaveLength(2);
    now.mockRestore();
  });

  it('discards the mint bootstrap after a write', async () => {
    const session = await readySession();
    routes['POST /api/account/organizations'] = (): FakeReply => ({
      status: 200,
      body: '{"ok":true}',
    });
    await session.fetch('/api/account/organizations', { method: 'POST' });
    await session.fetch(BOOTSTRAP_PATH, { method: 'GET' });
    expect(requestsTo(BOOTSTRAP_PATH)).toHaveLength(2);
  });

  it('discards the mint bootstrap on a remint', async () => {
    const session = await readySession();
    routes['GET /api/account/profile'] = (): FakeReply => ({ status: 401 });
    await session.fetch('/api/account/profile', { method: 'GET' });
    expect(session.state).toBe('expired');
    let mintReads = 0;
    routes[`GET ${BOOTSTRAP_PATH}`] = (): FakeReply => {
      mintReads += 1;
      return { status: 200, body: bootstrap() };
    };
    await session.ensureReady({ userInitiated: true });
    // The remint's own read; the first mint's entry is gone and the new one
    // answers the next read.
    expect(mintReads).toBe(1);
    await session.fetch(BOOTSTRAP_PATH, { method: 'GET' });
    expect(mintReads).toBe(1);
    await session.fetch(BOOTSTRAP_PATH, { method: 'GET' });
    expect(mintReads).toBe(2);
  });
});

describe('settings bridge lifecycle', () => {
  it('disposes after the idle period, but not while a stream is retained', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const session = await readySession();
    const release = session.retainStream();
    jest.advanceTimersByTime(SETTINGS_BRIDGE_IDLE_MS * 2);
    expect(session.state).toBe('ready');
    release();
    release();
    jest.advanceTimersByTime(SETTINGS_BRIDGE_IDLE_MS - 1);
    expect(session.state).toBe('ready');
    jest.advanceTimersByTime(1);
    expect(session.state).toBe('disposed');
    await flush();
    expect(requestsTo('/api/auth/sign-out')).toHaveLength(1);
  });

  it('restarts the idle clock on each operation', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    const session = await readySession();
    jest.advanceTimersByTime(SETTINGS_BRIDGE_IDLE_MS - 1_000);
    await session.fetch('/api/account/profile', { method: 'GET' });
    jest.advanceTimersByTime(SETTINGS_BRIDGE_IDLE_MS - 1_000);
    expect(session.state).toBe('ready');
    jest.advanceTimersByTime(1_000);
    expect(session.state).toBe('disposed');
  });

  it('disposes on identity or credential changes, revocation, and quit', async () => {
    const teardown = installSettingsBridgeLifecycle();
    expect(installSettingsBridgeLifecycle()).toBe(teardown);
    const listener = mockSubscribeAccountChanges.mock.calls[0]?.[0];
    if (listener === undefined) throw new Error('no listener');
    const quitCall = mockAppOn.mock.calls.find(
      (call) => call[0] === 'before-quit',
    );
    const onQuit = quitCall?.[1];
    if (onQuit === undefined) throw new Error('no quit handler');

    const first = await readySession();
    // The first event after install has no known previous credential.
    listener({ apiKey: 'csk_test', account: { id: ACCOUNT_ID } });
    expect(first.state).toBe('disposed');
    const second = await readySession();
    expect(second).not.toBe(first);
    expect(second.generation).toBe(2);
    // A same-identity refresh (status or capability merge) keeps the session.
    listener({ apiKey: 'csk_test', account: { id: ACCOUNT_ID } });
    expect(second.state).toBe('ready');
    // A rotated key ends it even for the same account.
    listener({ apiKey: 'csk_rotated', account: { id: ACCOUNT_ID } });
    expect(second.state).toBe('disposed');
    const rotated = await readySession();
    listener({ apiKey: 'csk_rotated', account: { id: 'other-account' } });
    expect(rotated.state).toBe('disposed');
    const beforeSignOut = await readySession();
    listener(null);
    expect(beforeSignOut.state).toBe('disposed');
    const third = await readySession();
    onQuit();
    expect(third.state).toBe('disposed');

    teardown();
    expect(mockUnsubscribeAccountChanges).toHaveBeenCalled();
    expect(mockAppRemoveListener).toHaveBeenCalledWith('before-quit', onQuit);
  });

  it('keeps the session on a same-identity first event when the account was already loaded', async () => {
    mockPeekCanopyCloudAccount.mockReturnValue({
      apiKey: 'csk_test',
      account: { id: ACCOUNT_ID },
    });
    installSettingsBridgeLifecycle();
    const listener = mockSubscribeAccountChanges.mock.calls[0]?.[0];
    if (listener === undefined) throw new Error('no listener');
    const session = await readySession();
    listener({ apiKey: 'csk_test', account: { id: ACCOUNT_ID } });
    expect(session.state).toBe('ready');
    listener({ apiKey: 'csk_test', account: { id: 'other-account' } });
    expect(session.state).toBe('disposed');
  });

  it('shares one session between concurrent first acquisitions', async () => {
    const [first, second] = await Promise.all([
      acquireSettingsBridgeSession(ACCOUNT_ID),
      acquireSettingsBridgeSession(ACCOUNT_ID),
    ]);
    expect(second).toBe(first);
    await Promise.all([first.ensureReady(), second.ensureReady()]);
    expect(requestsTo(CONSUME_PATH)).toHaveLength(1);
  });

  it('replaces the session when the base URL changes', async () => {
    const first = await readySession();
    mockGetCanopyCloudCredentials.mockResolvedValue(
      credentials({ baseUrl: OTHER_BASE }),
    );
    const second = await acquireSettingsBridgeSession(ACCOUNT_ID);
    expect(first.state).toBe('disposed');
    expect(second).not.toBe(first);
    expect(second.origin).toBe(OTHER_BASE);
  });

  it("makes a later session wait for a failed mint's sign-out", async () => {
    let releaseFirstSignOut = (): void => undefined;
    let signOuts = 0;
    mockRoute = (request): FakeReply | Promise<FakeReply> => {
      const url = new URL(request.url);
      if (url.origin === BASE && url.pathname === '/api/v1/settings/bootstrap')
        return { status: 500 };
      if (url.pathname === '/api/auth/sign-out') {
        signOuts += 1;
        if (signOuts === 1)
          return new Promise<FakeReply>((resolve) => {
            releaseFirstSignOut = (): void => resolve({ status: 200 });
          });
      }
      return defaultRoute(request);
    };
    const first = await acquireSettingsBridgeSession(ACCOUNT_ID);
    const failedMint = first.ensureReady().catch(() => undefined);
    await flush();
    expect(requestsTo('/api/auth/sign-out')).toHaveLength(1);

    mockGetCanopyCloudCredentials.mockResolvedValue(
      credentials({ baseUrl: OTHER_BASE }),
    );
    mockRequestCanopyCloudJson.mockResolvedValue({
      url: `${OTHER_BASE}${CONSUME_PATH}?code=def`,
    });
    const second = await acquireSettingsBridgeSession(ACCOUNT_ID);
    const ready = second.ensureReady();
    await flush();
    const consumedOnSecond = (): number =>
      requestsTo(CONSUME_PATH).filter(
        (request) => new URL(request.url).origin === OTHER_BASE,
      ).length;
    expect(consumedOnSecond()).toBe(0);

    releaseFirstSignOut();
    await ready;
    await failedMint;
    expect(consumedOnSecond()).toBe(1);
  });

  it('bounds the sign-out so a hung server cannot delay disposal', async () => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    routes['POST /api/auth/sign-out'] = (): FakeReply => ({ hang: true });
    const session = await readySession();
    let disposed = false;
    const disposal = session.dispose('quit').then(() => {
      disposed = true;
    });
    expect(session.dispose('quit')).toBe(session.dispose('idle'));
    await flush();
    expect(disposed).toBe(false);
    const signOut = requestsTo('/api/auth/sign-out');
    expect(signOut).toHaveLength(1);
    expect(signOut[0]?.origin).toBe(BASE);
    jest.advanceTimersByTime(SETTINGS_BRIDGE_SIGN_OUT_TIMEOUT_MS);
    await flush();
    await disposal;
    expect(disposed).toBe(true);
    expect(signOut[0]?.aborted).toBe(true);
    expect(mockClearStorageData).toHaveBeenCalledTimes(1);
  });

  it('skips sign-out when no session cookies were ever issued', async () => {
    const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
    await session.dispose('idle');
    expect(mockRequests).toHaveLength(0);
    expect(mockClearStorageData).not.toHaveBeenCalled();
    expect((await rejection(session.ensureReady())).code).toBe('expired');
  });

  it('notifies state listeners through the lifecycle', async () => {
    const session = await acquireSettingsBridgeSession(ACCOUNT_ID);
    const states: string[] = [];
    session.onStateChange((state) => states.push(state));
    await session.ensureReady();
    await session.dispose('idle');
    expect(states).toEqual(['minting', 'ready', 'disposed']);
  });
});

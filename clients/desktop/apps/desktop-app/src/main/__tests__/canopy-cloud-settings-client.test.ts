import { z } from 'zod';
import type * as SettingsProtocol from '@canopy/protocol/settings';
import type {
  AnySettingsOperation,
  SettingsEvent,
  SettingsOperationName,
  SettingsOperationRequest,
} from '@canopy/protocol/settings';

const mockOverrides = new Map<string, AnySettingsOperation>();

jest.mock('electron', () => ({
  app: { on: jest.fn(), removeListener: jest.fn() },
  session: { fromPartition: jest.fn() },
  net: { request: jest.fn() },
}));
jest.mock('../canopy-cloud/client', () => ({
  CanopyCloudClientError: class extends Error {},
  requestCanopyCloudJson: jest.fn(),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  getCanopyCloudCredentials: jest.fn(),
  subscribeCanopyCloudAccountChanges: jest.fn(),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('@canopy/protocol/settings', () => {
  const actual: typeof SettingsProtocol = jest.requireActual(
    '@canopy/protocol/settings',
  );
  return {
    ...actual,
    settingsOperation: (name: SettingsOperationName): AnySettingsOperation =>
      mockOverrides.get(name) ?? actual.settingsOperation(name),
    settingsOperationRequest: (
      name: SettingsOperationName,
      input: unknown,
    ): unknown => {
      const override = mockOverrides.get(name);
      return override
        ? override.request(input)
        : actual.settingsOperationRequest(name, input);
    },
    validateSettingsOperationResult: (
      name: SettingsOperationName,
      response: unknown,
    ): unknown => {
      const override = mockOverrides.get(name);
      if (!override)
        return actual.validateSettingsOperationResult(name, response);
      const parsed = override.result.safeParse(response);
      return parsed.success ? { ok: true, result: parsed.data } : { ok: false };
    },
  };
});

import { SettingsOperationError } from '@canopy/protocol/settings';
import {
  SETTINGS_FEED_MAX_PENDING_EVENTS,
  executeSettingsOperation,
  openSettingsFeedStream,
} from '../canopy-cloud/settings-client';
import {
  SettingsBridgeSession,
  type SettingsBridgeRequestInit,
} from '../canopy-cloud/settings-session';

const BASE = 'https://cloud.example.test';
const ORG = 'org-1';

interface FetchCall {
  path: string;
  init: SettingsBridgeRequestInit;
}

let session: SettingsBridgeSession;
let fetchCalls: FetchCall[];
let respond: (call: FetchCall) => Promise<Response> | Response;
let retain: jest.Mock<() => void, []>;
let released: jest.Mock<void, []>;
let storageFetch: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function bootstrapBody(): unknown {
  return {
    version: 1,
    viewer: { id: 'acct-1', email: 'a@example.test', name: null },
    account: {
      billingEnabled: true,
      digestsEnabled: true,
      integrationsEnabled: true,
      freeAccess: false,
    },
    organizations: [],
    organization: null,
  };
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

const writeEntry: AnySettingsOperation = {
  kind: 'write',
  transport: 'backend',
  input: z.unknown(),
  result: z.looseObject({ ok: z.boolean() }),
  request: (): SettingsOperationRequest => ({
    method: 'POST',
    path: '/api/account/profile',
    body: { name: 'A' },
  }),
};

const authEntry: AnySettingsOperation = {
  ...writeEntry,
  transport: 'auth',
  request: (): SettingsOperationRequest => ({
    method: 'POST',
    path: '/api/auth/change-password',
    body: { currentPassword: 'x', newPassword: 'y' },
  }),
};

const uploadEntry: AnySettingsOperation = {
  kind: 'write',
  transport: 'upload',
  input: z.unknown(),
  result: z.looseObject({ imageUrl: z.string() }),
  request: (): SettingsOperationRequest => ({
    method: 'POST',
    path: '/unused',
  }),
  upload: {
    maxBytes: 10,
    contentTypes: ['image/png'],
    sign: (): SettingsOperationRequest => ({
      method: 'POST',
      path: '/api/account/avatar/sign',
      body: {},
    }),
    commit: (_input, signed): SettingsOperationRequest => ({
      method: 'POST',
      path: '/api/account/avatar/commit',
      body: { objectKey: signed.objectKey },
    }),
  },
};

beforeEach((): void => {
  jest.useRealTimers();
  mockOverrides.clear();
  fetchCalls = [];
  respond = (): Response => json(200, bootstrapBody());
  session = new SettingsBridgeSession({
    accountId: 'acct-1',
    generation: 1,
    baseUrl: BASE,
  });
  jest
    .spyOn(session, 'fetch')
    .mockImplementation(
      async (path: string, init: SettingsBridgeRequestInit) => {
        const call = { path, init };
        fetchCalls.push(call);
        return respond(call);
      },
    );
  released = jest.fn<void, []>();
  retain = jest.fn<() => void, []>(() => released);
  jest.spyOn(session, 'retainStream').mockImplementation(() => retain());
  storageFetch = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach((): void => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function useFakeTimers(): void {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
  });
}

describe('executeSettingsOperation reads', () => {
  it('executes the table request and returns the validated result', async () => {
    const result = await executeSettingsOperation(
      session,
      'settings.bootstrap',
      {},
    );
    expect(result).toEqual(bootstrapBody());
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.path).toBe('/api/v1/settings/bootstrap');
    expect(fetchCalls[0]?.init.method).toBe('GET');
    expect(fetchCalls[0]?.init.authOrigin).toBeUndefined();
    expect(fetchCalls[0]?.init.headers).toEqual({ Accept: 'application/json' });
  });

  it('treats a missing bootstrap route as an unsupported server', async () => {
    respond = (): Response => json(404, { error: 'Not found' });
    expect(
      (
        await rejection(
          executeSettingsOperation(session, 'settings.bootstrap', {}),
        )
      ).code,
    ).toBe('unsupported_server');
    expect(fetchCalls).toHaveLength(1);
  });

  it('retries a transient read failure with the bounded policy', async () => {
    useFakeTimers();
    const statuses = [503, 502];
    respond = (): Response => {
      const status = statuses.shift();
      return status === undefined
        ? json(200, bootstrapBody())
        : json(status, {});
    };
    const pending = executeSettingsOperation(session, 'settings.bootstrap', {});
    await jest.advanceTimersByTimeAsync(400);
    await jest.advanceTimersByTimeAsync(1_500);
    expect(await pending).toEqual(bootstrapBody());
    expect(fetchCalls).toHaveLength(3);
  });

  it('gives up after the bounded retries and reports offline', async () => {
    useFakeTimers();
    respond = (): Response => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    };
    const pending = rejection(
      executeSettingsOperation(session, 'settings.bootstrap', {}),
    );
    await jest.advanceTimersByTimeAsync(2_000);
    expect((await pending).code).toBe('offline');
    expect(fetchCalls).toHaveLength(3);
  });

  it('does not retry a non-transient read failure', async () => {
    respond = (): Response => json(500, { error: 'boom' });
    expect(
      (
        await rejection(
          executeSettingsOperation(session, 'settings.bootstrap', {}),
        )
      ).code,
    ).toBe('failed');
    expect(fetchCalls).toHaveLength(1);
  });

  it('rejects malformed JSON and schema mismatches as invalid responses', async () => {
    respond = (): Response =>
      new Response('{not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    expect(
      (
        await rejection(
          executeSettingsOperation(session, 'settings.bootstrap', {}),
        )
      ).code,
    ).toBe('invalid_response');
    respond = (): Response => json(200, { version: 1, viewer: { id: '' } });
    expect(
      (
        await rejection(
          executeSettingsOperation(session, 'settings.bootstrap', {}),
        )
      ).code,
    ).toBe('invalid_response');
  });

  it('tolerates additive bootstrap fields', async () => {
    respond = (): Response =>
      json(200, { ...Object(bootstrapBody()), future: [1] });
    expect(
      await executeSettingsOperation(session, 'settings.bootstrap', {}),
    ).toMatchObject({ future: [1] });
  });

  it('maps a redirect to sign-in onto an expired session', async () => {
    respond = (): Response =>
      new Response(null, {
        status: 307,
        headers: { location: `${BASE}/login` },
      });
    expect(
      (
        await rejection(
          executeSettingsOperation(session, 'settings.bootstrap', {}),
        )
      ).code,
    ).toBe('expired');
  });

  it('passes session-level failures through unchanged', async () => {
    respond = (): Response => {
      throw new SettingsOperationError({ code: 'expired' });
    };
    expect(
      (
        await rejection(
          executeSettingsOperation(session, 'settings.bootstrap', {}),
        )
      ).code,
    ).toBe('expired');
    expect(fetchCalls).toHaveLength(1);
  });
});

describe('executeSettingsOperation writes', () => {
  beforeEach((): void => {
    mockOverrides.set('settings.pageData', writeEntry);
  });

  it('sends the JSON body and never retries a 5xx, reporting uncertain', async () => {
    respond = (): Response => json(503, {});
    const error = await rejection(
      executeSettingsOperation(session, 'settings.pageData', {}),
    );
    expect(error.code).toBe('uncertain');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ name: 'A' }),
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('reports a network failure on a write as uncertain without retrying', async () => {
    respond = (): Response => {
      throw new Error('socket hang up');
    };
    expect(
      (
        await rejection(
          executeSettingsOperation(session, 'settings.pageData', {}),
        )
      ).code,
    ).toBe('uncertain');
    expect(fetchCalls).toHaveLength(1);
  });

  it('keeps the server message and code for a rejected write', async () => {
    respond = (): Response =>
      json(409, { error: 'The last owner cannot leave', code: 'last_owner' });
    const error = await rejection(
      executeSettingsOperation(session, 'settings.pageData', {}),
    );
    expect(error.code).toBe('failed');
    expect(error.status).toBe(409);
    expect(error.serverCode).toBe('last_owner');
    expect(error.message).toBe('The last owner cannot leave');
  });

  it('maps 401 on a ready session to expired and 403 to forbidden', async () => {
    respond = (): Response => json(401, {});
    expect(
      (
        await rejection(
          executeSettingsOperation(session, 'settings.pageData', {}),
        )
      ).code,
    ).toBe('expired');
    respond = (): Response => json(403, {});
    expect(
      (
        await rejection(
          executeSettingsOperation(session, 'settings.pageData', {}),
        )
      ).code,
    ).toBe('forbidden');
  });

  it('reports a wrong two-factor code as failed and keeps the session', async () => {
    mockOverrides.clear();
    respond = (): Response => json(401, { error: 'Invalid two-factor code' });
    const error = await rejection(
      executeSettingsOperation(session, 'account.security.twoFactor.verify', {
        code: '000000',
      }),
    );
    expect(error.code).toBe('failed');
    expect(error.status).toBe(401);
    expect(fetchCalls[0]?.init.rejectedCredentialOn401).toBe(true);
  });

  it('sends Better Auth entries with the web origin', async () => {
    mockOverrides.set('settings.pageData', authEntry);
    respond = (): Response => json(200, { ok: true });
    expect(
      await executeSettingsOperation(session, 'settings.pageData', {}),
    ).toEqual({
      ok: true,
    });
    expect(fetchCalls[0]?.path).toBe('/api/auth/change-password');
    expect(fetchCalls[0]?.init.authOrigin).toBe(true);
  });
});

describe('executeSettingsOperation uploads', () => {
  beforeEach((): void => {
    mockOverrides.set('settings.pageData', uploadEntry);
    respond = (call): Response =>
      call.path === '/api/account/avatar/sign'
        ? json(200, {
            uploadUrl: 'https://storage.example.test/bucket/obj?sig=1',
            objectKey: 'obj',
            headers: {
              'x-goog-content-length-range': '0,10',
              Authorization: 'leak',
            },
          })
        : json(200, { imageUrl: 'https://storage.example.test/obj' });
  });

  it('refuses oversize files and undeclared types before any network call', async () => {
    const oversize = await rejection(
      executeSettingsOperation(
        session,
        'settings.pageData',
        {},
        {
          uploadBytes: new Uint8Array(11),
          uploadContentType: 'image/png',
        },
      ),
    );
    expect(oversize.serverCode).toBe('file_too_large');
    const wrongType = await rejection(
      executeSettingsOperation(
        session,
        'settings.pageData',
        {},
        {
          uploadBytes: new Uint8Array(4),
          uploadContentType: 'image/svg+xml',
        },
      ),
    );
    expect(wrongType.serverCode).toBe('unsupported_type');
    expect(fetchCalls).toHaveLength(0);
    expect(storageFetch).not.toHaveBeenCalled();
  });

  it('signs, PUTs the bytes to storage without credentials, then commits', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await executeSettingsOperation(
      session,
      'settings.pageData',
      {},
      {
        uploadBytes: bytes,
        uploadContentType: 'image/png',
      },
    );
    expect(result).toEqual({ imageUrl: 'https://storage.example.test/obj' });
    expect(fetchCalls.map((call) => call.path)).toEqual([
      '/api/account/avatar/sign',
      '/api/account/avatar/commit',
    ]);
    expect(storageFetch).toHaveBeenCalledTimes(1);
    const [target, init] = storageFetch.mock.calls[0] ?? [];
    expect(target instanceof URL ? target.href : target).toBe(
      'https://storage.example.test/bucket/obj?sig=1',
    );
    expect(init).toMatchObject({
      method: 'PUT',
      credentials: 'omit',
      redirect: 'error',
    });
    expect(init?.headers).toEqual({
      'x-goog-content-length-range': '0,10',
      'Content-Type': 'image/png',
    });
    const body = init?.body;
    expect(body instanceof Uint8Array ? Array.from(body) : null).toEqual([
      1, 2, 3,
    ]);
    expect(fetchCalls[1]?.init.body).toBe(JSON.stringify({ objectKey: 'obj' }));
  });

  it.each([
    ['http storage', 'http://storage.example.test/obj'],
    ['the backend origin', `${BASE}/api/upload`],
  ])('refuses a signed target on %s', async (_label, uploadUrl) => {
    respond = (): Response => json(200, { uploadUrl });
    expect(
      (
        await rejection(
          executeSettingsOperation(
            session,
            'settings.pageData',
            {},
            {
              uploadBytes: new Uint8Array(3),
              uploadContentType: 'image/png',
            },
          ),
        )
      ).code,
    ).toBe('invalid_response');
    expect(storageFetch).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(1);
  });

  it('does not commit when the storage PUT fails', async () => {
    storageFetch.mockResolvedValue(new Response(null, { status: 403 }));
    const error = await rejection(
      executeSettingsOperation(
        session,
        'settings.pageData',
        {},
        {
          uploadBytes: new Uint8Array(3),
          uploadContentType: 'image/png',
        },
      ),
    );
    expect(error.serverCode).toBe('upload_failed');
    expect(fetchCalls).toHaveLength(1);
  });
});

interface SseControl {
  response: Response;
  push(text: string): void;
  end(): void;
}

function sse(): SseControl {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(value): void {
      controller = value;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    push: (text): void => controller?.enqueue(encoder.encode(text)),
    end: (): void => controller?.close(),
  };
}

function frame(sequence: number, eventId = `evt-${sequence}`): string {
  const envelope = {
    type: 'feed.item',
    eventId,
    occurredAt: '2026-10-16T00:00:00.000Z',
    sequence,
    payload: { id: `item-${sequence}`, type: 'pr_opened' },
  };
  return `id: ${sequence}\nevent: feed.item\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function creditFrame(sequence: number, eventId = `credit-${sequence}`): string {
  const envelope = {
    type: 'credit.pool',
    eventId,
    occurredAt: '2026-10-16T00:00:00.000Z',
    sequence,
    payload: { balanceCredits: 1_250 },
  };
  return `id: ${sequence}\nevent: credit.pool\ndata: ${JSON.stringify(envelope)}\n\n`;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

function summarize(events: SettingsEvent[]): string[] {
  return events.map((event) => {
    if (event.type === 'feed.item')
      return `item:${event.sequence}:${event.eventId}`;
    if (event.type === 'state')
      return event.error === undefined
        ? `state:${event.state}`
        : `state:${event.state}:${event.error}`;
    if (event.type === 'credit.pool') return 'credit';
    return 'reconnected';
  });
}

describe('openSettingsFeedStream', () => {
  it('parses feed frames, ignores other frames, and dedupes', async () => {
    const control = sse();
    respond = (): Response => control.response;
    const events: SettingsEvent[] = [];
    const stream = openSettingsFeedStream(
      session,
      {
        kind: 'organization-feed',
        organizationId: ORG,
        teamId: 'team-1',
        lastSequence: 5,
      },
      { onEvent: (event) => events.push(event) },
    );
    await settle();
    expect(fetchCalls[0]?.path).toBe(
      `/api/account/organizations/${ORG}/stream?teamId=team-1`,
    );
    expect(fetchCalls[0]?.init.headers).toMatchObject({
      Accept: 'text/event-stream',
      'Last-Event-ID': '5',
    });
    control.push('retry: 3000\n: connected\n\n');
    control.push(frame(4));
    control.push(frame(6).slice(0, 30));
    control.push(frame(6).slice(30).replace(/\n/g, '\r\n'));
    control.push('event: other\ndata: {}\n\n');
    control.push('event: feed.item\ndata: {not json\n\n');
    control.push(frame(7, 'evt-6'));
    control.push(frame(8));
    control.push(frame(8, 'evt-8b'));
    await settle();
    expect(summarize(events)).toEqual([
      'state:connecting',
      'state:open',
      'item:6:evt-6',
      'item:8:evt-8',
    ]);
    const item = events.find((event) => event.type === 'feed.item');
    expect(item).toMatchObject({
      organizationId: ORG,
      item: { id: 'item-6', type: 'pr_opened' },
    });
    expect(retain).toHaveBeenCalledTimes(1);
    stream.close();
    expect(released).toHaveBeenCalledTimes(1);
    expect(fetchCalls[0]?.init.signal?.aborted).toBe(true);
  });

  it('delivers credit-pool signals without a balance for an organization wallet', async () => {
    const control = sse();
    respond = (): Response => control.response;
    const events: SettingsEvent[] = [];
    const stream = openSettingsFeedStream(
      session,
      { kind: 'credit-pool', organizationId: ORG },
      { onEvent: (event) => events.push(event) },
    );
    await settle();
    expect(fetchCalls[0]?.path).toBe(
      `/api/account/organizations/${ORG}/stream`,
    );
    control.push(frame(1));
    control.push(creditFrame(2));
    control.push(creditFrame(2));
    control.push('event: credit.pool\ndata: {"type":"credit.pool"}\n\n');
    control.push(creditFrame(3));
    await settle();
    expect(summarize(events)).toEqual([
      'state:connecting',
      'state:open',
      'credit',
      'credit',
    ]);
    expect(events.find((event) => event.type === 'credit.pool')).toEqual({
      type: 'credit.pool',
      organizationId: ORG,
    });
    stream.close();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('reads the personal credit stream and omits the organization', async () => {
    const control = sse();
    respond = (): Response => control.response;
    const events: SettingsEvent[] = [];
    const stream = openSettingsFeedStream(
      session,
      { kind: 'credit-pool' },
      { onEvent: (event) => events.push(event) },
    );
    await settle();
    expect(fetchCalls[0]?.path).toBe('/api/account/billing/credits/stream');
    expect(fetchCalls[0]?.init.headers).not.toHaveProperty('Last-Event-ID');
    control.push(creditFrame(1));
    await settle();
    expect(events).toEqual([
      { type: 'state', state: 'connecting' },
      { type: 'state', state: 'open' },
      { type: 'credit.pool' },
    ]);
    stream.close();
  });

  it('reconnects with backoff from the last sequence and announces it', async () => {
    useFakeTimers();
    const first = sse();
    const second = sse();
    const responses = [first.response, second.response];
    respond = (): Response => responses.shift() ?? json(503, {});
    const events: SettingsEvent[] = [];
    const stream = openSettingsFeedStream(
      session,
      { kind: 'organization-feed', organizationId: ORG },
      { onEvent: (event) => events.push(event) },
      { random: () => 0 },
    );
    await settle();
    expect(fetchCalls[0]?.init.headers).not.toHaveProperty('Last-Event-ID');
    first.push(frame(10));
    first.end();
    await settle();
    expect(summarize(events).slice(-1)).toEqual(['state:reconnecting']);
    expect(fetchCalls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(500);
    await settle();
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.init.headers).toMatchObject({
      'Last-Event-ID': '10',
    });
    second.push(frame(10));
    second.push(frame(11));
    await settle();
    expect(summarize(events)).toEqual([
      'state:connecting',
      'state:open',
      'item:10:evt-10',
      'state:reconnecting',
      'state:open',
      'reconnected',
      'item:11:evt-11',
    ]);
    stream.close();
  });

  it('backs off exponentially while the route keeps failing', async () => {
    useFakeTimers();
    respond = (): Response => json(503, {});
    const stream = openSettingsFeedStream(
      session,
      { kind: 'organization-feed', organizationId: ORG },
      { onEvent: () => undefined },
      { random: () => 1 },
    );
    await settle();
    expect(fetchCalls).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(fetchCalls).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1_999);
    await settle();
    expect(fetchCalls).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(fetchCalls).toHaveLength(3);
    stream.close();
  });

  it.each([
    [401, 'state:disabled:expired'],
    [403, 'state:disabled:forbidden'],
    [404, 'state:disabled'],
  ])('stops on %s', async (status, expected) => {
    useFakeTimers();
    respond = (): Response => json(status, {});
    const events: SettingsEvent[] = [];
    openSettingsFeedStream(
      session,
      { kind: 'organization-feed', organizationId: ORG },
      { onEvent: (event) => events.push(event) },
    );
    await settle();
    expect(summarize(events)).toEqual(['state:connecting', expected]);
    expect(released).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(fetchCalls).toHaveLength(1);
  });

  it('stops with expired when the session has ended', async () => {
    respond = (): Response => {
      throw new SettingsOperationError({ code: 'expired' });
    };
    const events: SettingsEvent[] = [];
    openSettingsFeedStream(
      session,
      { kind: 'organization-feed', organizationId: ORG },
      { onEvent: (event) => events.push(event) },
    );
    await settle();
    expect(summarize(events)).toEqual([
      'state:connecting',
      'state:disabled:expired',
    ]);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('bounds pending events, dropping the oldest and asking for a refetch', async () => {
    const control = sse();
    respond = (): Response => control.response;
    const events: SettingsEvent[] = [];
    const stream = openSettingsFeedStream(
      session,
      { kind: 'organization-feed', organizationId: ORG },
      { onEvent: (event) => events.push(event) },
    );
    await settle();
    const total = SETTINGS_FEED_MAX_PENDING_EVENTS + 5;
    let burst = '';
    for (let sequence = 1; sequence <= total; sequence += 1)
      burst += frame(sequence);
    control.push(burst);
    await settle();
    const items = events.filter((event) => event.type === 'feed.item');
    expect(items).toHaveLength(SETTINGS_FEED_MAX_PENDING_EVENTS);
    expect(items[0]).toMatchObject({ sequence: 6 });
    expect(summarize(events).slice(-1)).toEqual(['reconnected']);
    stream.close();
  });

  it('emits nothing after close', async () => {
    const control = sse();
    respond = (): Response => control.response;
    const events: SettingsEvent[] = [];
    const stream = openSettingsFeedStream(
      session,
      { kind: 'organization-feed', organizationId: ORG },
      { onEvent: (event) => events.push(event) },
    );
    await settle();
    stream.close();
    stream.close();
    const before = events.length;
    control.push(frame(1));
    await settle();
    expect(events).toHaveLength(before);
    expect(released).toHaveBeenCalledTimes(1);
  });
});

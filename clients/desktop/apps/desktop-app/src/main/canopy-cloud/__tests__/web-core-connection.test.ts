import type {
  CanopyCallerDescriptor,
  CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';
import { SettingsOperationError } from '@canopy/protocol/settings';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import type { RelayBindingConnection } from '../../canopy-runtime/renderer-relay/definitions';
import type {
  SettingsBridgeRequestInit,
  SettingsBridgeState,
} from '../settings-session';
import {
  WEB_CORE_CONNECTIONS_PATH,
  createWebCoreBindingProvider,
  type WebCoreBridgeSession,
} from '../web-core-connection';

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-renderer:main',
  clientInstanceId: 'renderer-relay:test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [],
};

interface BridgeCall {
  readonly accountId: string;
  readonly path: string;
  readonly init: SettingsBridgeRequestInit;
}

interface Push {
  readonly id: number;
  readonly message: CanopyJsonRpcMessage;
}

const push = (id: number): Push => ({
  id,
  message: { jsonrpc: '2.0', method: 'core.events.push', params: { n: id } },
});

const encoder = new TextEncoder();
const frame = (entry: Push): Uint8Array =>
  encoder.encode(`id: ${entry.id}\ndata: ${JSON.stringify(entry.message)}\n\n`);

/**
 * A stub web core behind the bridge. Its events route replays every push
 * after `Last-Event-ID`; the first stream drops after `dropAfter` pushes.
 */
class StubWebCore {
  readonly calls: BridgeCall[] = [];
  readonly eventHeaders: Record<string, string>[] = [];
  pushes: Push[] = [];
  dropAfter: number | null = null;
  private nextConnection = 0;

  handle(
    accountId: string,
    path: string,
    init: SettingsBridgeRequestInit,
  ): Response {
    this.calls.push({ accountId, path, init });
    if (path === WEB_CORE_CONNECTIONS_PATH && init.method === 'POST') {
      this.nextConnection += 1;
      return Response.json(
        { connectionId: `${accountId}-${this.nextConnection}` },
        { status: 201 },
      );
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (path.endsWith('/events')) return this.events(init);
    const message: unknown = JSON.parse(String(init.body));
    const id: unknown =
      typeof message === 'object' && message !== null
        ? Reflect.get(message, 'id')
        : null;
    return Response.json({ jsonrpc: '2.0', id, result: { ok: true } });
  }

  private events(init: SettingsBridgeRequestInit): Response {
    const headers = init.headers ?? {};
    this.eventHeaders.push(headers);
    const after = Number(headers['last-event-id'] ?? '0');
    const replay = this.pushes.filter((entry) => entry.id > after);
    const drop = this.dropAfter;
    this.dropAfter = null;
    const sent = drop === null ? replay : replay.slice(0, drop);
    let next = 0;
    // Pull-driven, so the drop lands after the client read what was sent.
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        init.signal?.addEventListener('abort', () => {
          try {
            controller.close();
          } catch {
            // Already errored.
          }
        });
      },
      pull(controller): Promise<void> | void {
        const entry = sent[next];
        next += 1;
        if (entry !== undefined) return controller.enqueue(frame(entry));
        if (drop !== null) return controller.error(new Error('stream dropped'));
        // A live stream stays open with nothing more to say.
        return new Promise<void>(() => undefined);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
}

interface FakeBridge extends WebCoreBridgeSession {
  readonly retained: () => number;
  dispose(): void;
}

function fakeBridge(server: StubWebCore, accountId: string): FakeBridge {
  let state: SettingsBridgeState = 'ready';
  let retained = 0;
  const listeners = new Set<(next: SettingsBridgeState) => void>();
  return {
    get state(): SettingsBridgeState {
      return state;
    },
    retained: () => retained,
    fetch: (path, init) =>
      state === 'disposed'
        ? Promise.reject(new SettingsOperationError({ code: 'expired' }))
        : Promise.resolve(server.handle(accountId, path, init)),
    retainStream: () => {
      retained += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained -= 1;
      };
    },
    onStateChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      state = 'disposed';
      listeners.forEach((listener) => listener('disposed'));
    },
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met');
}

function open(
  provider: ReturnType<typeof createWebCoreBindingProvider>,
  signal = new AbortController().signal,
): Promise<RelayBindingConnection> {
  return provider({ caller: CALLER, webContentsId: 1, signal });
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const opened: CanopyFramedConnection[] = [];
afterEach(() => {
  opened.splice(0).forEach((connection) => connection.close());
  jest.restoreAllMocks();
});

describe('web core connection (CAN-4185 PR-C)', () => {
  it('every request goes through the bridge session, never a renderer-supplied credential', async () => {
    const globalFetch = jest.spyOn(globalThis, 'fetch');
    const server = new StubWebCore();
    const bridge = fakeBridge(server, 'account-a');
    const connection = await open(
      createWebCoreBindingProvider({
        isEnabled: () => true,
        acquireSession: () => Promise.resolve(bridge),
      }),
    );
    opened.push(connection);
    await connection.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'core.chat.list',
      params: {
        authorization: 'Bearer csk_renderer',
        headers: { cookie: 'session=renderer', authorization: 'Bearer csk_x' },
      },
    });
    await expect(connection.receive()).resolves.toMatchObject({ id: 1 });
    await eventually(() => server.eventHeaders.length > 0);

    expect(globalFetch).not.toHaveBeenCalled();
    expect(server.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of server.calls) {
      expect(call.accountId).toBe('account-a');
      for (const name of Object.keys(call.init.headers ?? {}))
        expect(['content-type', 'accept', 'last-event-id']).toContain(name);
      expect(JSON.stringify(call.init.headers ?? {})).not.toMatch(
        /csk_|cookie|authorization/i,
      );
    }
  });

  it('an account change ends the connection and the next open mints for the new account', async () => {
    const server = new StubWebCore();
    let current = fakeBridge(server, 'account-a');
    const first = current;
    const acquireSession = jest.fn(() => Promise.resolve(current));
    const provider = createWebCoreBindingProvider({
      isEnabled: () => true,
      acquireSession,
    });
    const before = await open(provider);
    opened.push(before);
    await eventually(() => first.retained() === 1);

    // Sign-out, account switch, key rotation and revocation all dispose the bridge.
    first.dispose();
    current = fakeBridge(server, 'account-b');
    expect(before.signal.aborted).toBe(true);
    await eventually(() => first.retained() === 0);
    const callsAfterDispose = server.calls.length;

    const after = await open(provider);
    opened.push(after);
    expect(acquireSession).toHaveBeenCalledTimes(2);
    expect(after.signal.aborted).toBe(false);
    const later = server.calls.slice(callsAfterDispose);
    expect(later[0]).toMatchObject({
      accountId: 'account-b',
      path: WEB_CORE_CONNECTIONS_PATH,
    });
    expect(later.every((call) => call.accountId === 'account-b')).toBe(true);
  });

  it('a raw network failure from the bridge stays retryable', async () => {
    const offline: WebCoreBridgeSession = {
      ...fakeBridge(new StubWebCore(), 'account-a'),
      fetch: () => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')),
    };
    const error = await rejection(
      open(
        createWebCoreBindingProvider({
          isEnabled: () => true,
          acquireSession: () => Promise.resolve(offline),
        }),
      ),
    );
    expect(error).toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
    });
  });

  it('flag off refuses before any network call', async () => {
    const globalFetch = jest.spyOn(globalThis, 'fetch');
    const acquireSession = jest.fn(() =>
      Promise.resolve(fakeBridge(new StubWebCore(), 'account-a')),
    );
    const error = await rejection(
      open(
        createWebCoreBindingProvider({
          isEnabled: () => false,
          acquireSession,
        }),
      ),
    );
    expect(error).toMatchObject({
      payload: { kind: 'capability_unavailable', retry: { kind: 'never' } },
    });
    expect(acquireSession).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('a POST sends Origin', async () => {
    const server = new StubWebCore();
    const connection = await open(
      createWebCoreBindingProvider({
        isEnabled: () => true,
        acquireSession: () => Promise.resolve(fakeBridge(server, 'account-a')),
      }),
    );
    opened.push(connection);
    await connection.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'core.workspace.list',
      params: {},
    });
    await connection.receive();
    const posts = server.calls.filter((call) => call.init.method === 'POST');
    expect(posts.map((call) => call.path)).toEqual([
      WEB_CORE_CONNECTIONS_PATH,
      `${WEB_CORE_CONNECTIONS_PATH}/account-a-1`,
    ]);
    for (const call of posts) expect(call.init.authOrigin).toBe(true);
  });

  it('a dropped events stream reopens with Last-Event-ID and delivers no push twice', async () => {
    const server = new StubWebCore();
    server.pushes = [push(1), push(2), push(3)];
    server.dropAfter = 2;
    const bridge = fakeBridge(server, 'account-a');
    const connection = await open(
      createWebCoreBindingProvider({
        isEnabled: () => true,
        acquireSession: () => Promise.resolve(bridge),
      }),
    );
    opened.push(connection);

    const delivered: CanopyJsonRpcMessage[] = [];
    for (let index = 0; index < 3; index += 1)
      delivered.push(await connection.receive());

    expect(delivered).toEqual(
      [push(1), push(2), push(3)].map((p) => p.message),
    );
    expect(server.eventHeaders).toHaveLength(2);
    expect(server.eventHeaders[0]?.['last-event-id']).toBeUndefined();
    expect(server.eventHeaders[1]?.['last-event-id']).toBe('2');
    // The dropped stream released its keep-alive; only the live one holds it.
    expect(bridge.retained()).toBe(1);
  });
});

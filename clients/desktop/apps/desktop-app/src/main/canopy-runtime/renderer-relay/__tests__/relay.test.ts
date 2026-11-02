import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { z } from 'zod';
import type * as CoreClientModule from '@canopy/core-client';
import type { CanopyClient, CanopyClientOptions } from '@canopy/core-client';
import {
  createInMemoryFramedPair,
  type CanopyFramedConnection,
} from '@canopy/core-transport';
import {
  CanopyErrorPayloadSchema,
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyQuery,
  defineCanopyStream,
  encodeCanopyError,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyInstructionDefinition,
  type CanopyInstructionDefinitionMap,
  type CanopyQueryDefinition,
  type CanopyQueryDefinitionMap,
  type CanopyStreamDefinition,
  type CanopyStreamDefinitionMap,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcRequest,
} from '@canopy/protocol/canopy-core';
import type { CanopyCoreRelayReply } from '../../../../shared/canopy-core-relay';
import {
  createRendererRelay,
  RENDERER_RELAY_LIMITS,
  type RendererRelay,
  type RendererRelayEvent,
  type RendererRelayLimits,
  type RendererRelaySender,
} from '../relay';
import { relayAllows, type RendererRelaySurface } from '../surface-allowlist';
import { INTERFACE_RELAY_ALLOWLIST } from '../interface-allowlist.generated';
import { PORTAL_COMMAND_TYPES } from '@canopy/protocol/portal';

// --- Definitions: real operation names, test-sized schemas -------------------

const json = z.record(z.string(), z.json());
const query = (
  grant: `core.${string}.${string}`,
  result: z.ZodType = json,
): CanopyQueryDefinition =>
  defineCanopyQuery({
    plane: 'core',
    domain: 'test',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [grant],
    params: z.strictObject({ delayMs: z.number().optional() }),
    result,
    error: CanopyErrorPayloadSchema,
  });
const instruction = (
  grant: `core.${string}.${string}`,
): CanopyInstructionDefinition =>
  defineCanopyInstruction({
    plane: 'core',
    domain: 'test',
    version: 1,
    placement: 'core-only',
    idempotency: 'keyed',
    requiredGrants: [grant],
    params: z.strictObject({ value: z.number().optional() }),
    result: json,
    error: CanopyErrorPayloadSchema,
  });
const stream = (grant: `core.${string}.${string}`): CanopyStreamDefinition =>
  defineCanopyStream({
    plane: 'core',
    domain: 'test',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [grant],
    params: z.strictObject({}),
    openResult: z.object({
      subscriptionId: z.string().min(1),
      acceptedCursor: CanopyStreamCursorSchema.nullable(),
    }),
    item: json,
    end: CanopyStreamEndSchema,
    error: CanopyErrorPayloadSchema,
  });

const HEALTH = 'core.runtime.health.get';
const WORKSPACES = 'core.workspace.list';
const REGISTER = 'core.client.capabilities.register';
const CHAT_CREATE = 'core.chat.create';
const EVENTS = 'core.runtime.events';
const CHAT_EVENTS = 'core.chat.events';
const GIT_BRANCHES = 'worker.git.branch.list';

const mockDefinitions = {
  queries: {
    'core.runtime.initialize': query('core.runtime.read'),
    [HEALTH]: query('core.runtime.read', z.object({ status: z.string() })),
    [WORKSPACES]: query('core.workspace.read'),
    // A name whose envelope admits `_execution` (CAN-5496).
    [GIT_BRANCHES]: query('core.runtime.read'),
  },
  instructions: {
    [REGISTER]: instruction('core.client.manage'),
    'core.client.lease.acquire': instruction('core.client.manage'),
    [CHAT_CREATE]: instruction('core.chat.write'),
  },
  streams: {
    [EVENTS]: stream('core.runtime.read'),
    [CHAT_EVENTS]: stream('core.chat.read'),
  },
};

// The binding worker owns ./definitions; the relay only reads RELAY_DEFINITIONS lazily.
// Not `virtual`: a virtual mock of this real module is skipped once another
// suite in the same Jest worker has resolved it.
jest.mock('../definitions', () => ({
  get RELAY_DEFINITIONS(): typeof mockDefinitions {
    return mockDefinitions;
  },
}));

// Records every stream handle the relay opens, so tests can see late closes.
const mockOpenedHandles: { close: jest.SpyInstance }[] = [];
let mockStallInstructions = false;
jest.mock('@canopy/core-client', () => {
  const actual = jest.requireActual<typeof CoreClientModule>(
    '@canopy/core-client',
  );
  return {
    ...actual,
    createCanopyClient: async (
      options: CanopyClientOptions<
        CanopyQueryDefinitionMap,
        CanopyInstructionDefinitionMap,
        CanopyStreamDefinitionMap
      >,
    ): Promise<CanopyClient> => {
      const client = await actual.createCanopyClient(options);
      const openStream: CanopyClient['openStream'] = async (
        name,
        params,
        streamOptions,
      ) => {
        const handle = await client.openStream(name, params, streamOptions);
        mockOpenedHandles.push({ close: jest.spyOn(handle, 'close') });
        return handle;
      };
      const instructionCall: CanopyClient['instruction'] = (...args) =>
        mockStallInstructions
          ? new Promise(() => undefined)
          : client.instruction(...args);
      return { ...client, openStream, instruction: instructionCall };
    },
  };
});

// --- Fake core -----------------------------------------------------------------

class CoreError extends Error {
  constructor(readonly payload: CanopyErrorPayload) {
    super(payload.message);
  }
}

type Handler = (params: Record<string, unknown>) => unknown;
type CoreMethod = `core.${string}.${string}`;
const isCoreMethod = (method: string): method is CoreMethod =>
  /^core\.[^.]+\..+$/.test(method);

interface FakeCore {
  readonly server: CanopyFramedConnection;
  readonly requests: CanopyJsonRpcRequest[];
  emit(subscriptionId: string, item: unknown): Promise<void>;
  end(subscriptionId: string): Promise<void>;
  /** Server-side open subscriptions; a released one is gone. */
  subscriptions(): string[];
  /** The host-local hook a releasing binding exposes. */
  release: jest.Mock<void, [string]>;
}

const ALL_OPERATIONS = [
  ...Object.keys(mockDefinitions.queries),
  ...Object.keys(mockDefinitions.instructions),
];
const ALL_STREAMS = Object.keys(mockDefinitions.streams);

function serveCore(
  server: CanopyFramedConnection,
  handlers: Record<string, Handler>,
  operations: string[],
): FakeCore {
  const requests: CanopyJsonRpcRequest[] = [];
  const open = new Map<string, CoreMethod>();
  let sequence = 0;
  const send = (message: CanopyJsonRpcMessage): Promise<void> =>
    server.send(message).catch(() => undefined);
  const cursor = (): { daemonEpoch: string; sequence: number } => ({
    daemonEpoch: 'epoch-1',
    sequence,
  });
  const methodOf = (subscriptionId: string): CoreMethod => {
    const method = open.get(subscriptionId);
    if (!method) throw new Error(`No open ${subscriptionId}.`);
    return method;
  };
  const answer = async (request: CanopyJsonRpcRequest): Promise<void> => {
    const { id, method, params } = request;
    if (method === 'core.runtime.initialize')
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          runtime: {
            runtimeId: 'runtime-1',
            hostId: 'host-1',
            authorityId: 'local-desktop',
            profile: 'core+worker',
            daemonEpoch: 'epoch-1',
            protocolVersions: [1],
            state: 'ready',
            buildVersion: '0.0.0-test',
          },
          selectedProtocolVersion: 1,
          capabilities: { operations, events: [], streams: ALL_STREAMS },
          limits: {},
          authentication: { required: true, methods: [] },
        },
      });
    try {
      const result = await (handlers[method] ?? ((): unknown => ({})))(params);
      if (ALL_STREAMS.includes(method)) {
        const subscriptionId = `sub-${String(id)}`;
        if (isCoreMethod(method)) open.set(subscriptionId, method);
        return send({
          jsonrpc: '2.0',
          id,
          result: { subscriptionId, acceptedCursor: null },
        });
      }
      return send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      const payload: CanopyErrorPayload =
        error instanceof CoreError
          ? error.payload
          : { kind: 'internal', message: 'handler', retry: { kind: 'never' } };
      return send({ jsonrpc: '2.0', id, error: encodeCanopyError(payload) });
    }
  };
  void (async (): Promise<void> => {
    for (;;) {
      const message = await server.receive().catch(() => null);
      if (!message) return;
      if (!('method' in message) || !('id' in message)) continue;
      requests.push(message);
      void answer(message);
    }
  })();
  return {
    server,
    requests,
    subscriptions: () => Array.from(open.keys()),
    release: jest.fn((subscriptionId: string) => {
      open.delete(subscriptionId);
    }),
    emit: (subscriptionId: string, item: unknown): Promise<void> => {
      sequence += 1;
      return send({
        jsonrpc: '2.0',
        method: `${methodOf(subscriptionId)}.item`,
        params: {
          subscriptionId,
          cursor: cursor(),
          itemId: `item-${sequence}`,
          occurredAt: '2026-10-08T12:00:00Z',
          item,
        },
      });
    },
    end: (subscriptionId: string): Promise<void> => {
      const method = methodOf(subscriptionId);
      open.delete(subscriptionId);
      return send({
        jsonrpc: '2.0',
        method: `${method}.end`,
        params: {
          subscriptionId,
          cursor: cursor(),
          outcome: 'completed',
          error: null,
        },
      });
    },
  };
}

// --- Renderer fixtures -------------------------------------------------------

class FakeSender extends EventEmitter {
  destroyed = false;
  readonly mainFrame = {
    url: 'app://renderer/index.html',
    detached: false,
    isDestroyed: (): boolean => false,
  };
  constructor(readonly id: number) {
    super();
  }
  getURL(): string {
    return this.mainFrame.url;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  lifecycleListeners(): number {
    return [
      'destroyed',
      'render-process-gone',
      'did-start-navigation',
      'did-navigate',
    ]
      .map((name) => this.listenerCount(name))
      .reduce((a, b) => a + b, 0);
  }
}

const TRUSTED_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: [
    'core.runtime.read',
    'core.workspace.read',
    'core.client.manage',
    'core.chat.read',
    'core.secret.admin',
  ],
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

interface Harness {
  relay: RendererRelay;
  cores: FakeCore[];
  callers: CanopyCallerDescriptor[];
  bindingProvider: jest.Mock;
  resolveSurface: jest.Mock;
  surfaces: Map<RendererRelaySender, RendererRelaySurface>;
  sender(surface?: RendererRelaySurface): FakeSender;
  call(sender: FakeSender, input: unknown): Promise<CanopyCoreRelayReply>;
}

let active: Harness[] = [];
let nextSenderId = 1;

function harness(
  options: {
    handlers?: Record<string, Handler>;
    operations?: string[];
    limits?: Partial<RendererRelayLimits>;
    /** Omit the binding's releaseStream hook, as a replacement provider may. */
    hookless?: boolean;
  } = {},
): Harness {
  const cores: FakeCore[] = [];
  const callers: CanopyCallerDescriptor[] = [];
  const surfaces = new Map<RendererRelaySender, RendererRelaySurface>();
  const handlers: Record<string, Handler> = {
    [HEALTH]: () => ({ status: 'ok' }),
    ...options.handlers,
  };
  const bindingProvider = jest.fn(
    async (input: { caller: CanopyCallerDescriptor; signal: AbortSignal }) => {
      callers.push(input.caller);
      const pair = await createInMemoryFramedPair();
      const core = serveCore(
        pair.server,
        handlers,
        options.operations ?? ALL_OPERATIONS,
      );
      cores.push(core);
      return options.hookless
        ? pair.client
        : Object.assign(pair.client, { releaseStream: core.release });
    },
  );
  const resolveSurface = jest.fn((event: RendererRelayEvent) => {
    const surface = surfaces.get(event.sender);
    if (!surface) throw new Error('untrusted /Users/secret/path');
    return { surface, caller: TRUSTED_CALLER };
  });
  const relay = createRendererRelay({
    bindingProvider,
    resolveSurface,
    limits: options.limits,
  });
  const built: Harness = {
    relay,
    cores,
    callers,
    bindingProvider,
    resolveSurface,
    surfaces,
    sender(surface = 'main') {
      const sender = new FakeSender(nextSenderId++);
      surfaces.set(sender, surface);
      return sender;
    },
    call: (sender, input) =>
      relay.invoke({ sender, senderFrame: sender.mainFrame }, input),
  };
  active.push(built);
  return built;
}

afterEach(() => {
  active.forEach(({ relay, cores }) => {
    relay.dispose();
    cores.forEach((core) => core.server.close());
  });
  active = [];
  mockStallInstructions = false;
});

const health = { kind: 'request', method: HEALTH, params: {} } as const;
const openEvents = { kind: 'openStream', method: EVENTS, params: {} } as const;

function errorKind(reply: CanopyCoreRelayReply): string | null {
  return reply.ok ? null : reply.error.kind;
}

function valueOf(reply: CanopyCoreRelayReply): unknown {
  if (!reply.ok)
    throw new Error(`relay error ${reply.error.kind}: ${reply.error.message}`);
  return reply.value;
}

function subscriptionOf(reply: CanopyCoreRelayReply): string {
  const parsed = z.object({ subscriptionId: z.string() }).parse(valueOf(reply));
  return parsed.subscriptionId;
}

// --- Tests -------------------------------------------------------------------

describe('surface allowlist', () => {
  it('serves the generated interface set to the main surface minus admin methods', () => {
    expect(relayAllows('main', 'query', HEALTH)).toBe(true);
    expect(relayAllows('main', 'query', WORKSPACES)).toBe(true);
    expect(relayAllows('main', 'stream', CHAT_EVENTS)).toBe(true);
    expect(relayAllows('main', 'query', 'core.runtime.initialize')).toBe(false);
    expect(relayAllows('main', 'query', 'worker.runtime.initialize')).toBe(
      false,
    );
    expect(
      relayAllows('main', 'instruction', 'core.client.lease.acquire'),
    ).toBe(false);
    expect(relayAllows('main', 'instruction', 'core.client.lease.renew')).toBe(
      false,
    );
    expect(relayAllows('main', 'query', 'core.not.generated')).toBe(false);
    expect(relayAllows('main', 'instruction', HEALTH)).toBe(false);
  });

  it('never relays the trusted W5 record port, though the interface profile admits it (W6g)', () => {
    for (const [kind, method] of [
      ['query', 'core.workspaceRecords.capture'],
      ['query', 'core.workspaceRecords.recovery.get'],
      ['instruction', 'core.workspaceRecords.commit'],
      // Receipts and reservations (CAN-5506).
      ['query', 'core.workspaceRecords.receipt.lookup'],
      ['query', 'core.workspaceRecords.reservation.list'],
      ['instruction', 'core.workspaceRecords.reservation.reserve'],
      ['instruction', 'core.workspaceRecords.reservation.updateDiagnostics'],
      ['instruction', 'core.workspaceRecords.reservation.release'],
      ['instruction', 'core.workspaceRecords.reservation.markRecoveryRequired'],
    ] as const) {
      expect(INTERFACE_RELAY_ALLOWLIST.authority[kind]).toContain(method);
      for (const surface of ['main', 'app-advisor'] as const)
        expect(relayAllows(surface, kind, method)).toBe(false);
    }
    // Portal commands are their own closed catalog, with no record port entry.
    expect(
      PORTAL_COMMAND_TYPES.filter((type) => /workspaceRecords/i.test(type)),
    ).toEqual([]);
  });

  it('narrows App Advisor to its declared subset', () => {
    expect(relayAllows('app-advisor', 'query', HEALTH)).toBe(true);
    expect(relayAllows('app-advisor', 'stream', EVENTS)).toBe(true);
    expect(relayAllows('app-advisor', 'instruction', REGISTER)).toBe(true);
    expect(relayAllows('app-advisor', 'query', WORKSPACES)).toBe(false);
    expect(relayAllows('app-advisor', 'stream', CHAT_EVENTS)).toBe(false);
    expect(relayAllows('app-advisor', 'instruction', CHAT_CREATE)).toBe(false);
  });

  it('applies access-mode rows from the generated allowlist', () => {
    expect(relayAllows('main', 'instruction', CHAT_CREATE, 'read-only')).toBe(
      false,
    );
  });
});

describe('renderer relay', () => {
  it('accepts Electron WebContents as a sender (compile-time check)', () => {
    const fits: WebContents extends RendererRelaySender ? true : false = true;
    expect(fits).toBe(true);
  });

  it('serves core.runtime.health.get over a lazily created renderer connection', async () => {
    const h = harness();
    const sender = h.sender();
    expect(h.bindingProvider).not.toHaveBeenCalled();

    const reply = await h.call(sender, health);

    expect(reply).toEqual({ ok: true, value: { status: 'ok' } });
    expect(h.bindingProvider).toHaveBeenCalledTimes(1);
    const { clientInstanceId, ...caller } = h.callers[0];
    expect(clientInstanceId).toMatch(/^renderer-relay:[0-9a-f-]{36}$/);
    expect(caller).toEqual({
      principalId: 'local-desktop-renderer:main',
      authorityId: 'local-desktop',
      interfaceKind: 'desktop',
      grants: [
        'core.runtime.read',
        'core.workspace.read',
        'core.client.manage',
        'core.chat.read',
      ],
    });
    expect(h.cores[0].requests.map((request) => request.method)).toEqual([
      'core.runtime.initialize',
      HEALTH,
    ]);
  });

  it('shares one connection setup between concurrent first calls', async () => {
    const h = harness();
    const sender = h.sender();
    const replies = await Promise.all([
      h.call(sender, health),
      h.call(sender, health),
    ]);
    expect(replies.every((reply) => reply.ok)).toBe(true);
    expect(h.bindingProvider).toHaveBeenCalledTimes(1);
  });

  it('gives App Advisor its own principal and only the grants its subset needs', async () => {
    const h = harness();
    await h.call(h.sender('app-advisor'), health);
    expect(h.callers[0].principalId).toBe('local-desktop-renderer:app-advisor');
    expect(h.callers[0].grants).toEqual([
      'core.runtime.read',
      'core.client.manage',
    ]);
  });

  it('never grants more than the trusted caller holds', async () => {
    const h = harness();
    const sender = h.sender();
    h.resolveSurface.mockImplementation(() => ({
      surface: 'main',
      caller: { ...TRUSTED_CALLER, grants: ['core.runtime.read'] },
    }));
    await h.call(sender, health);
    expect(h.callers[0].grants).toEqual(['core.runtime.read']);
  });

  it('revalidates the sender on every invocation', async () => {
    const h = harness();
    const sender = h.sender();
    expect((await h.call(sender, health)).ok).toBe(true);
    h.surfaces.delete(sender);

    const reply = await h.call(sender, health);

    expect(reply).toEqual({
      ok: false,
      error: {
        kind: 'permission_denied',
        message: 'Untrusted renderer.',
        retry: { kind: 'never' },
      },
    });
    expect(h.resolveSurface).toHaveBeenCalledTimes(2);
    expect(
      h.cores[0].requests.filter((request) => request.method === HEALTH),
    ).toHaveLength(1);
  });

  it('rejects an untrusted sender before any connection exists', async () => {
    const h = harness();
    const stranger = new FakeSender(99);
    const reply = await h.call(stranger, health);
    expect(errorKind(reply)).toBe('permission_denied');
    expect(h.bindingProvider).not.toHaveBeenCalled();
    expect(stranger.lifecycleListeners()).toBe(0);
  });

  it('replaces the connection when a sender changes surface', async () => {
    const h = harness();
    const sender = h.sender('main');
    await h.call(sender, health);
    h.surfaces.set(sender, 'app-advisor');

    const reply = await h.call(sender, {
      kind: 'request',
      method: WORKSPACES,
      params: {},
    });

    expect(errorKind(reply)).toBe('capability_unavailable');
    await waitFor(() => h.cores[0].server.signal.aborted);
    expect((await h.call(sender, health)).ok).toBe(true);
    expect(h.callers.map((caller) => caller.principalId)).toEqual([
      'local-desktop-renderer:main',
      'local-desktop-renderer:app-advisor',
    ]);
  });

  it('gives each sender a distinct connection identity', async () => {
    const h = harness();
    await h.call(h.sender(), health);
    await h.call(h.sender(), health);
    expect(h.callers).toHaveLength(2);
    expect(h.callers[0].clientInstanceId).not.toBe(
      h.callers[1].clientInstanceId,
    );
  });

  describe('request validation', () => {
    it.each([
      ['an unknown kind', { kind: 'admin', method: HEALTH, params: {} }],
      ['a spoofed caller', { ...health, caller: TRUSTED_CALLER }],
      ['a spoofed surface', { ...health, surface: 'main' }],
      ['missing params', { kind: 'request', method: HEALTH }],
      ['a malformed method', { kind: 'request', method: 'health', params: {} }],
      ['a Date param', { ...health, params: { at: new Date() } }],
      ['a Map param', { ...health, params: { map: new Map() } }],
      ['a NaN param', { ...health, params: { n: Number.NaN } }],
      ['an undefined param', { ...health, params: { u: undefined } }],
      [
        'a typed array param',
        { ...health, params: { bytes: new Uint8Array(1) } },
      ],
      ['a non-object input', 'request'],
      [
        'a stream read with a numeric id',
        { kind: 'readStream', subscriptionId: 1 },
      ],
      ['close with extra fields', { kind: 'close', principalId: 'x' }],
    ])('rejects %s as invalid_argument', async (_name, input) => {
      const h = harness();
      expect(errorKind(await h.call(h.sender(), input))).toBe(
        'invalid_argument',
      );
      expect(h.bindingProvider).not.toHaveBeenCalled();
    });

    it('rejects a cyclic input as invalid_argument', async () => {
      const h = harness();
      const params: Record<string, unknown> = {};
      params.self = params;
      expect(errorKind(await h.call(h.sender(), { ...health, params }))).toBe(
        'invalid_argument',
      );
    });

    it('rejects params outside the operation schema through the client', async () => {
      const h = harness();
      const reply = await h.call(h.sender(), {
        ...health,
        params: { extra: true },
      });
      expect(errorKind(reply)).toBe('invalid_argument');
      expect(h.cores[0].requests.map((request) => request.method)).toEqual([
        'core.runtime.initialize',
      ]);
    });

    // CAN-5496: only a trusted host builder supplies host execution.
    it('refuses a renderer _execution, even for an operation that accepts one', async () => {
      const h = harness({ handlers: { [GIT_BRANCHES]: () => ({}) } });
      const sender = h.sender();
      expect(
        (
          await h.call(sender, {
            kind: 'request',
            method: GIT_BRANCHES,
            params: {},
          })
        ).ok,
      ).toBe(true);
      const reply = await h.call(sender, {
        kind: 'request',
        method: GIT_BRANCHES,
        params: {
          _execution: { childEnvironment: { GIT_SSH_COMMAND: 'touch /tmp/x' } },
        },
      });
      expect(errorKind(reply)).toBe('invalid_argument');
      expect(h.cores[0].requests.map((request) => request.method)).toEqual([
        'core.runtime.initialize',
        GIT_BRANCHES,
      ]);
    });

    it('rejects malformed request metadata', async () => {
      const h = harness();
      const reply = await h.call(h.sender(), {
        ...health,
        params: { _meta: { principalId: 'spoof' } },
      });
      expect(errorKind(reply)).toBe('invalid_argument');
    });
  });

  describe('method policy', () => {
    it.each([
      ['request', 'core.runtime.initialize'],
      ['request', 'worker.runtime.initialize'],
      ['request', 'core.client.lease.acquire'],
      ['request', 'core.client.lease.renew'],
      ['request', 'core.not.defined'],
      ['request', EVENTS],
      ['openStream', HEALTH],
    ])('refuses %s %s without reaching the core', async (kind, method) => {
      const h = harness();
      const sender = h.sender();
      await h.call(sender, health);
      const reply = await h.call(sender, { kind, method, params: {} });
      expect(errorKind(reply)).toBe('capability_unavailable');
      expect(h.cores[0].requests.map((request) => request.method)).toEqual([
        'core.runtime.initialize',
        HEALTH,
      ]);
    });

    it('narrows App Advisor calls to its subset', async () => {
      const h = harness({ handlers: { [REGISTER]: () => ({ revision: 1 }) } });
      const advisor = h.sender('app-advisor');
      expect((await h.call(advisor, health)).ok).toBe(true);
      expect(
        valueOf(
          await h.call(advisor, {
            kind: 'request',
            method: REGISTER,
            params: { _meta: { idempotencyKey: 'register-1' } },
          }),
        ),
      ).toEqual({ revision: 1 });
      expect((await h.call(advisor, openEvents)).ok).toBe(true);
      expect(
        errorKind(
          await h.call(advisor, {
            kind: 'request',
            method: WORKSPACES,
            params: {},
          }),
        ),
      ).toBe('capability_unavailable');
      expect(
        errorKind(
          await h.call(advisor, {
            kind: 'openStream',
            method: CHAT_EVENTS,
            params: {},
          }),
        ),
      ).toBe('capability_unavailable');

      const main = h.sender('main');
      expect(
        (
          await h.call(main, {
            kind: 'request',
            method: WORKSPACES,
            params: {},
          })
        ).ok,
      ).toBe(true);
    });

    it('intersects the policy with the connection manifest', async () => {
      const h = harness({ operations: [HEALTH] });
      const reply = await h.call(h.sender(), {
        kind: 'request',
        method: WORKSPACES,
        params: {},
      });
      expect(errorKind(reply)).toBe('capability_unavailable');
      expect(h.cores[0].requests.map((request) => request.method)).toEqual([
        'core.runtime.initialize',
      ]);
    });

    it('forwards a keyed instruction with the relay deadline applied', async () => {
      const seen: Record<string, unknown>[] = [];
      const h = harness({
        handlers: {
          [REGISTER]: (params) => {
            seen.push(params);
            return {};
          },
        },
      });
      const sender = h.sender();
      const far = new Date(Date.now() + 3_600_000).toISOString();
      const before = Date.now();
      const reply = await h.call(sender, {
        kind: 'request',
        method: REGISTER,
        params: {
          value: 1,
          _meta: { idempotencyKey: 'key-1', deadlineAt: far },
        },
      });
      expect(reply.ok).toBe(true);
      const meta = z
        .object({ idempotencyKey: z.string(), deadlineAt: z.string() })
        .parse(seen[0]._meta);
      expect(meta.idempotencyKey).toBe('key-1');
      const deadline = Date.parse(meta.deadlineAt);
      expect(deadline).toBeGreaterThanOrEqual(
        before + RENDERER_RELAY_LIMITS.deadlineMs - 1,
      );
      expect(deadline).toBeLessThanOrEqual(
        Date.now() + RENDERER_RELAY_LIMITS.deadlineMs,
      );
    });

    it('relays typed core errors without details and redacts untyped failures', async () => {
      const h = harness({
        handlers: {
          [WORKSPACES]: () => {
            throw new CoreError({
              kind: 'not_found',
              message: 'No workspace.',
              code: 'core.workspace.notFound',
              details: { path: '/Users/secret' },
              retry: { kind: 'never' },
            });
          },
        },
      });
      const reply = await h.call(h.sender(), {
        kind: 'request',
        method: WORKSPACES,
        params: {},
      });
      expect(reply).toEqual({
        ok: false,
        error: {
          kind: 'not_found',
          message: 'No workspace.',
          code: 'core.workspace.notFound',
          retry: { kind: 'never' },
        },
      });

      const failing = harness();
      failing.bindingProvider.mockRejectedValueOnce(
        new Error('spawn /Users/secret failed'),
      );
      expect(await failing.call(failing.sender(), health)).toEqual({
        ok: false,
        error: {
          kind: 'internal',
          message: 'The relay request failed.',
          retry: { kind: 'never' },
        },
      });
    });

    it('retries setup on the next call after a failed connection', async () => {
      const h = harness();
      const sender = h.sender();
      h.bindingProvider.mockRejectedValueOnce(new Error('boom'));
      expect((await h.call(sender, health)).ok).toBe(false);
      expect((await h.call(sender, health)).ok).toBe(true);
      expect(h.bindingProvider).toHaveBeenCalledTimes(2);
    });
  });

  describe('caps', () => {
    it('preserves the original key when the relay instruction deadline wins', async () => {
      mockStallInstructions = true;
      const h = harness({ limits: { deadlineMs: 100 } });
      const sender = h.sender();
      await h.call(sender, health);
      const reply = await h.call(sender, {
        kind: 'request',
        method: REGISTER,
        params: { _meta: { idempotencyKey: 'deadline-key' } },
      });
      expect(reply).toMatchObject({
        ok: false,
        error: {
          kind: 'deadline_exceeded',
          retry: { kind: 'same_idempotency_key' },
        },
      });
    });

    it('preserves the original key when an instruction reply exceeds the cap', async () => {
      const h = harness({
        limits: { maxFrameBytes: 4096 },
        handlers: { [REGISTER]: () => ({ pad: 'x'.repeat(5000) }) },
      });
      expect(
        await h.call(h.sender(), {
          kind: 'request',
          method: REGISTER,
          params: { _meta: { idempotencyKey: 'reply-key' } },
        }),
      ).toMatchObject({
        ok: false,
        error: {
          kind: 'resource_exhausted',
          retry: { kind: 'same_idempotency_key' },
        },
      });
    });
    it('rejects an input over 1 MiB before connecting', async () => {
      const h = harness();
      const reply = await h.call(h.sender(), {
        ...health,
        params: { pad: 'x'.repeat(RENDERER_RELAY_LIMITS.maxFrameBytes) },
      });
      expect(errorKind(reply)).toBe('resource_exhausted');
      expect(h.bindingProvider).not.toHaveBeenCalled();
    });

    it('rejects a reply over the frame cap', async () => {
      const h = harness({
        limits: { maxFrameBytes: 4096 },
        handlers: { [WORKSPACES]: () => ({ pad: 'x'.repeat(5000) }) },
      });
      const reply = await h.call(h.sender(), {
        kind: 'request',
        method: WORKSPACES,
        params: {},
      });
      expect(errorKind(reply)).toBe('resource_exhausted');
    });

    it('allows 32 concurrent calls per connection and refuses the 33rd', async () => {
      const gate = deferred();
      const h = harness({
        handlers: { [WORKSPACES]: () => gate.promise.then(() => ({})) },
      });
      const sender = h.sender();
      const list = { kind: 'request', method: WORKSPACES, params: {} };
      const pending = Array.from(
        { length: RENDERER_RELAY_LIMITS.maxConcurrentCalls },
        () => h.call(sender, list),
      );
      expect(errorKind(await h.call(sender, list))).toBe('resource_exhausted');
      expect(errorKind(await h.call(h.sender(), health))).toBeNull();
      gate.resolve();
      expect((await Promise.all(pending)).every((reply) => reply.ok)).toBe(
        true,
      );
      expect((await h.call(sender, list)).ok).toBe(true);
    });

    it('expires a request at the relay deadline', async () => {
      const h = harness({
        limits: { deadlineMs: 50 },
        handlers: { [WORKSPACES]: () => new Promise(() => undefined) },
      });
      const reply = await h.call(h.sender(), {
        kind: 'request',
        method: WORKSPACES,
        params: {},
      });
      expect(errorKind(reply)).toBe('deadline_exceeded');
    });
  });

  describe('streams', () => {
    it('pulls frames one read at a time with relay-minted subscription ids', async () => {
      const h = harness();
      const sender = h.sender();
      const subscriptionId = subscriptionOf(await h.call(sender, openEvents));
      const [coreSubscription] = h.cores[0].subscriptions();
      expect(subscriptionId).not.toBe(coreSubscription);

      const read = { kind: 'readStream', subscriptionId };
      const first = h.call(sender, read);
      expect(errorKind(await h.call(sender, read))).toBe('failed_precondition');
      await h.cores[0].emit(coreSubscription, { n: 1 });
      expect(valueOf(await first)).toMatchObject({
        kind: 'item',
        item: { n: 1 },
      });

      await h.cores[0].end(coreSubscription);
      expect(valueOf(await h.call(sender, read))).toMatchObject({
        kind: 'end',
        outcome: 'completed',
      });
      expect(errorKind(await h.call(sender, read))).toBe('not_found');
    });

    it('keeps a frame that arrives after a read deadline for the next read', async () => {
      const h = harness({ limits: { deadlineMs: 50 } });
      const sender = h.sender();
      const subscriptionId = subscriptionOf(await h.call(sender, openEvents));
      const read = { kind: 'readStream', subscriptionId };
      expect(errorKind(await h.call(sender, read))).toBe('deadline_exceeded');
      await h.cores[0].emit(h.cores[0].subscriptions()[0], { n: 7 });
      expect(valueOf(await h.call(sender, read))).toMatchObject({
        item: { n: 7 },
      });
    });

    it('refuses another sender’s stream', async () => {
      const h = harness();
      const owner = h.sender();
      const other = h.sender();
      const subscriptionId = subscriptionOf(await h.call(owner, openEvents));
      expect(
        errorKind(await h.call(other, { kind: 'readStream', subscriptionId })),
      ).toBe('not_found');
      expect(
        errorKind(await h.call(other, { kind: 'closeStream', subscriptionId })),
      ).toBe('not_found');
      await h.cores[0].emit(h.cores[0].subscriptions()[0], { n: 2 });
      expect(
        valueOf(await h.call(owner, { kind: 'readStream', subscriptionId })),
      ).toMatchObject({
        item: { n: 2 },
      });
    });

    it('caps open streams at 16, reserving slots before setup completes', async () => {
      const h = harness();
      const sender = h.sender();
      const replies = await Promise.all(
        Array.from({ length: RENDERER_RELAY_LIMITS.maxOpenStreams + 1 }, () =>
          h.call(sender, openEvents),
        ),
      );
      expect(replies.filter((reply) => reply.ok)).toHaveLength(16);
      expect(
        replies.filter((reply) => errorKind(reply) === 'resource_exhausted'),
      ).toHaveLength(1);

      const opened = replies.find((reply) => reply.ok);
      if (!opened) throw new Error('no stream opened');
      const closeReply = await h.call(sender, {
        kind: 'closeStream',
        subscriptionId: subscriptionOf(opened),
      });
      expect(closeReply).toEqual({ ok: true, value: null });
      expect((await h.call(sender, openEvents)).ok).toBe(true);
    });

    it('holds an abandoned open’s reservation and releases its wire stream on arrival', async () => {
      const gate = deferred();
      const h = harness({
        limits: { deadlineMs: 50, maxOpenStreams: 1 },
        handlers: { [EVENTS]: () => gate.promise },
      });
      const sender = h.sender();
      expect(errorKind(await h.call(sender, openEvents))).toBe(
        'deadline_exceeded',
      );
      // The open is still in flight at the core, so its slot stays taken.
      expect(errorKind(await h.call(sender, openEvents))).toBe(
        'resource_exhausted',
      );

      const before = mockOpenedHandles.length;
      gate.resolve();
      await waitFor(() => h.cores[0].release.mock.calls.length === 1);
      const [lateOpen] = h.cores[0].requests.filter(
        (request) => request.method === EVENTS,
      );
      expect(h.cores[0].release).toHaveBeenCalledWith(
        `sub-${String(lateOpen.id)}`,
      );
      expect(h.cores[0].subscriptions()).toEqual([]);
      expect(mockOpenedHandles[before].close).toHaveBeenCalled();
      expect((await h.call(sender, openEvents)).ok).toBe(true);
      expect(h.bindingProvider).toHaveBeenCalledTimes(1);
    });

    it('releases a closed stream on its own connection without disturbing siblings', async () => {
      const h = harness();
      const sender = h.sender();
      const first = subscriptionOf(await h.call(sender, openEvents));
      const second = subscriptionOf(await h.call(sender, openEvents));
      const [firstWire, secondWire] = h.cores[0].subscriptions();

      expect(
        await h.call(sender, { kind: 'closeStream', subscriptionId: first }),
      ).toEqual({ ok: true, value: null });

      expect(h.cores[0].release.mock.calls).toEqual([[firstWire]]);
      expect(h.cores[0].subscriptions()).toEqual([secondWire]);
      await h.cores[0].emit(secondWire, { n: 3 });
      expect(
        valueOf(
          await h.call(sender, { kind: 'readStream', subscriptionId: second }),
        ),
      ).toMatchObject({ item: { n: 3 } });
      expect(h.cores[0].server.signal.aborted).toBe(false);
    });

    it('does not release a stream the core ended', async () => {
      const h = harness();
      const sender = h.sender();
      const subscriptionId = subscriptionOf(await h.call(sender, openEvents));
      const [wire] = h.cores[0].subscriptions();
      await h.cores[0].end(wire);
      expect(
        valueOf(await h.call(sender, { kind: 'readStream', subscriptionId })),
      ).toMatchObject({ kind: 'end' });
      // The hook may also run for an ended stream; it must stay harmless.
      expect(h.cores[0].server.signal.aborted).toBe(false);
      expect((await h.call(sender, health)).ok).toBe(true);
    });

    it('closes the whole connection to end a stream when the binding has no release hook', async () => {
      const h = harness({ hookless: true });
      const sender = h.sender();
      const subscriptionId = subscriptionOf(await h.call(sender, openEvents));

      expect(
        await h.call(sender, { kind: 'closeStream', subscriptionId }),
      ).toEqual({ ok: true, value: null });

      await waitFor(() => h.cores[0].server.signal.aborted);
      expect(sender.lifecycleListeners()).toBe(0);
      expect((await h.call(sender, openEvents)).ok).toBe(true);
      expect(h.bindingProvider).toHaveBeenCalledTimes(2);
    });

    it('ends a stream whose frame exceeds the cap', async () => {
      const h = harness({ limits: { maxFrameBytes: 4096 } });
      const sender = h.sender();
      const subscriptionId = subscriptionOf(await h.call(sender, openEvents));
      await h.cores[0].emit(h.cores[0].subscriptions()[0], {
        pad: 'x'.repeat(5000),
      });
      const read = { kind: 'readStream', subscriptionId };
      expect(errorKind(await h.call(sender, read))).toBe('resource_exhausted');
      expect(errorKind(await h.call(sender, read))).toBe('not_found');
    });
  });

  describe('lifecycle', () => {
    it('reconnects after an established binding drops and retires its stream ids', async () => {
      const h = harness();
      const sender = h.sender();
      const subscriptionId = subscriptionOf(await h.call(sender, openEvents));
      h.cores[0].server.close();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await h.call(sender, health)).ok).toBe(true);
      expect(h.bindingProvider).toHaveBeenCalledTimes(2);
      expect(
        errorKind(await h.call(sender, { kind: 'readStream', subscriptionId })),
      ).toBe('not_found');
    });

    it('preserves streams and pending requests when navigation is cancelled', async () => {
      const gate = deferred();
      const h = harness({
        handlers: {
          [WORKSPACES]: () => gate.promise.then(() => ({ kept: true })),
        },
      });
      const sender = h.sender();
      const subscriptionId = subscriptionOf(await h.call(sender, openEvents));
      const pending = h.call(sender, {
        kind: 'request',
        method: WORKSPACES,
        params: {},
      });
      await waitFor(() =>
        h.cores[0].requests.some((request) => request.method === WORKSPACES),
      );
      sender.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
      });
      sender.emit(
        'will-navigate',
        { preventDefault: jest.fn() },
        'blocked://navigation',
      );
      gate.resolve();
      expect(await pending).toEqual({ ok: true, value: { kept: true } });
      expect(h.cores[0].server.signal.aborted).toBe(false);
      await h.cores[0].emit(h.cores[0].subscriptions()[0], { kept: true });
      expect(
        valueOf(await h.call(sender, { kind: 'readStream', subscriptionId })),
      ).toMatchObject({ item: { kept: true } });
      expect(h.bindingProvider).toHaveBeenCalledTimes(1);
    });

    it('retires a session used between navigation start and commit', async () => {
      const h = harness();
      const sender = h.sender();
      await h.call(sender, health);
      sender.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
      });
      const intervening = subscriptionOf(await h.call(sender, openEvents));
      sender.emit('did-navigate', {}, sender.getURL(), 200, 'OK');
      expect((await h.call(sender, health)).ok).toBe(true);
      expect(h.bindingProvider).toHaveBeenCalledTimes(2);
      expect(
        errorKind(
          await h.call(sender, {
            kind: 'readStream',
            subscriptionId: intervening,
          }),
        ),
      ).toBe('not_found');
    });

    it('preserves keyed recovery when navigation loses a dispatched instruction result', async () => {
      const gate = deferred();
      const h = harness({
        handlers: { [REGISTER]: () => gate.promise.then(() => ({})) },
      });
      const sender = h.sender();
      await h.call(sender, health);
      const pending = h.call(sender, {
        kind: 'request',
        method: REGISTER,
        params: { _meta: { idempotencyKey: 'lost-key' } },
      });
      await waitFor(() =>
        h.cores[0].requests.some((request) => request.method === REGISTER),
      );
      sender.emit('did-navigate', {}, sender.getURL(), 200, 'OK');
      gate.resolve();
      expect(await pending).toMatchObject({
        ok: false,
        error: {
          kind: 'unavailable',
          retry: { kind: 'same_idempotency_key' },
        },
      });
    });
    it.each([
      [
        'main-frame navigation',
        (sender: FakeSender): boolean =>
          sender.emit('did-navigate', {}, sender.getURL(), 200, 'OK'),
      ],
      ['destroyed', (sender: FakeSender): boolean => sender.emit('destroyed')],
      [
        'render-process-gone',
        (sender: FakeSender): boolean =>
          sender.emit('render-process-gone', {}, {}),
      ],
    ])(
      'closes the connection on %s and never delivers old results',
      async (_name, trigger) => {
        const gate = deferred();
        const h = harness({
          handlers: {
            [WORKSPACES]: () => gate.promise.then(() => ({ stale: true })),
          },
        });
        const sender = h.sender();
        const subscriptionId = subscriptionOf(await h.call(sender, openEvents));
        const pendingRead = h.call(sender, {
          kind: 'readStream',
          subscriptionId,
        });
        const pendingCall = h.call(sender, {
          kind: 'request',
          method: WORKSPACES,
          params: {},
        });
        await waitFor(() =>
          h.cores[0].requests.some((request) => request.method === WORKSPACES),
        );

        trigger(sender);
        gate.resolve();

        expect(errorKind(await pendingCall)).toBe('unavailable');
        expect(errorKind(await pendingRead)).toBe('unavailable');
        await waitFor(() => h.cores[0].server.signal.aborted);
        expect(sender.lifecycleListeners()).toBe(0);

        // The next call gets a fresh identity, and old stream ids are gone.
        expect(
          errorKind(
            await h.call(sender, { kind: 'readStream', subscriptionId }),
          ),
        ).toBe('not_found');
        expect((await h.call(sender, health)).ok).toBe(true);
        expect(h.callers).toHaveLength(2);
        expect(h.callers[1].clientInstanceId).not.toBe(
          h.callers[0].clientInstanceId,
        );
      },
    );

    it.each([
      ['same-document', { isMainFrame: true, isSameDocument: true }],
      ['subframe', { isMainFrame: false, isSameDocument: false }],
    ])('keeps the connection across %s navigation', async (_name, details) => {
      const h = harness();
      const sender = h.sender();
      await h.call(sender, health);
      sender.emit('did-start-navigation', details);
      await h.call(sender, health);
      expect(h.bindingProvider).toHaveBeenCalledTimes(1);
    });

    it('closes the session when connection setup passes the deadline', async () => {
      const h = harness({ limits: { deadlineMs: 50 } });
      const sender = h.sender();
      // A binding that ignores its abort signal and never settles.
      h.bindingProvider.mockImplementationOnce(
        () => new Promise<CanopyFramedConnection>(() => undefined),
      );
      expect(['deadline_exceeded', 'unavailable']).toContain(
        errorKind(await h.call(sender, health)),
      );
      await waitFor(() => sender.lifecycleListeners() === 0);
      expect((await h.call(sender, health)).ok).toBe(true);
      expect(h.bindingProvider).toHaveBeenCalledTimes(2);
    });

    it('closes a connection whose binding resolves after disconnect', async () => {
      const h = harness();
      const sender = h.sender();
      const binding = deferred<CanopyFramedConnection>();
      const seen: { signal?: AbortSignal } = {};
      h.bindingProvider.mockImplementationOnce(
        (input: { signal: AbortSignal }) => {
          seen.signal = input.signal;
          return binding.promise;
        },
      );
      const pending = h.call(sender, health);
      sender.emit('destroyed');
      expect(errorKind(await pending)).toBe('unavailable');
      expect(seen.signal?.aborted).toBe(true);

      const pair = await createInMemoryFramedPair();
      binding.resolve(pair.client);
      await waitFor(() => pair.client.signal.aborted);
      pair.server.close();
    });

    it('closes on a renderer close request and reconnects lazily', async () => {
      const h = harness();
      const sender = h.sender();
      await h.call(sender, health);
      expect(await h.call(sender, { kind: 'close' })).toEqual({
        ok: true,
        value: null,
      });
      await waitFor(() => h.cores[0].server.signal.aborted);
      expect(sender.lifecycleListeners()).toBe(0);
      expect((await h.call(sender, health)).ok).toBe(true);
      expect(h.bindingProvider).toHaveBeenCalledTimes(2);
    });

    it('closes every connection on dispose and refuses later calls', async () => {
      const h = harness();
      const first = h.sender();
      const second = h.sender();
      await h.call(first, health);
      await h.call(second, health);
      h.relay.dispose();
      await waitFor(() => h.cores.every((core) => core.server.signal.aborted));
      expect(first.lifecycleListeners() + second.lifecycleListeners()).toBe(0);
      expect(errorKind(await h.call(first, health))).toBe('unavailable');
      expect(h.bindingProvider).toHaveBeenCalledTimes(2);
    });
  });
});

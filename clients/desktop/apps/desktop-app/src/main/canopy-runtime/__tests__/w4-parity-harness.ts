import { W4Resources } from './w4-acquisition';
import { Buffer } from 'node:buffer';
import {
  CANOPY_INSTRUCTION_DEFINITIONS,
  CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES,
  CANOPY_QUERY_DEFINITIONS,
  CANOPY_STREAM_DEFINITIONS,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CanopyErrorPayloadSchema,
  CoreRuntimeInitializeResultSchema,
  composeCanopyOperationEnvelopes,
  encodeCanopyError,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcRequest,
  type CanopyOperationEnvelopes,
  type CanopyQueryRequestMetadata,
  type CanopyStreamItem,
  type CoreRuntimeInitializeResult,
} from '@canopy/protocol/canopy-core';
import {
  createInMemoryFramedPair,
  type CanopyFramedConnection,
} from '@canopy/core-transport';
import { createCanopyClient, type CanopyClient } from '@canopy/core-client';
import type {
  ChatStateChangedEvent,
  ChatStateCommandPort,
  ChatStateSnapshot,
  FileTreeDirectoryRequest,
  FileTreeDirectoryResponse,
  FileTreeRootsRequest,
  FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import { IdentifierValidationError } from '../../lib/identifier-validation-error';
import {
  PortalServiceError,
  type PortalServiceErrorCode,
} from '../../services/portal-service-error';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import type { WorkerFilesystemServices } from '../worker-filesystem-adapter';

// Binding contract. The runners keep their own direct baseline and reach the
// selected backend only through these required test controls, so J3 (CAN-3729)
// supplies a socket/pipe binding without editing the runners. Every input is
// plain data so a daemon in another process can apply it.

/** Plain-data stand-in for the error a file-tree service throws. */
export type W4FixtureError =
  | { type: 'portal'; code: PortalServiceErrorCode }
  | { type: 'identifier-validation'; message: string }
  | { type: 'unexpected'; message: string };

export interface W4FilesystemFixture {
  roots?: FileTreeRootsResponse;
  entries?: FileTreeDirectoryResponse;
  error?: W4FixtureError;
}

export interface W4FilesystemServiceInputs {
  roots: FileTreeRootsRequest[];
  directory: FileTreeDirectoryRequest[];
}

export interface W4FilesystemDriver {
  /** Serves `fixture` from the backend's file-tree services; clears inputs. */
  serve(fixture: W4FilesystemFixture): Promise<void>;
  /** Service inputs the backend received since the last `serve`. */
  serviceInputs(): Promise<W4FilesystemServiceInputs>;
}

export interface W4ChatDriver {
  /** Commits the next `createW4ChatState` revision; resolves once emitted. */
  commit(): Promise<void>;
  /** Replaces the runtime (new stream epoch) over the same durable chat state. */
  restart(): Promise<void>;
}

export interface W4ParityEndpoint {
  /** Authenticated client end; the client takes it over at handshake. */
  connection: CanopyFramedConnection;
  /** Test-only activation, run after initialize and released before client closure. */
  activate?(client: W4ParityClient): Promise<{ close(): Promise<void> }>;
  /** Releases the binding's server side. Called once, after the client. */
  close(): Promise<void>;
}

/**
 * One started backend with state independent of the direct baseline. It must
 * retain chat history across client reconnects, as a daemon does.
 */
export interface W4ParityBackend {
  /** What `core.runtime.initialize` advertises. */
  expected: { operations: readonly string[]; streams: readonly string[] };
  filesystem: W4FilesystemDriver;
  chat: W4ChatDriver;
  connect(
    options: W4ParitySessionOptions,
    signal?: AbortSignal,
  ): Promise<W4ParityEndpoint>;
  shutdown(): Promise<void>;
}

export interface W4ParityBinding {
  name: string;
  start(): Promise<W4ParityBackend>;
}

export function materializeW4FixtureError(spec: W4FixtureError): Error {
  switch (spec.type) {
    case 'portal':
      return new PortalServiceError(spec.code, `service ${spec.code}`);
    case 'identifier-validation':
      return new IdentifierValidationError(spec.message);
    case 'unexpected':
      return new Error(spec.message);
  }
}

/** Recording file-tree services plus the driver that configures them. */
export function createW4FilesystemFixtureServices(): {
  services: WorkerFilesystemServices;
  driver: W4FilesystemDriver;
} {
  let fixture: W4FilesystemFixture = {};
  let inputs: W4FilesystemServiceInputs = { roots: [], directory: [] };
  const settle = <T>(value: T): Promise<T> =>
    fixture.error
      ? Promise.reject(materializeW4FixtureError(fixture.error))
      : Promise.resolve(structuredClone(value));
  return {
    services: {
      listFileTreeRoots: (request): Promise<FileTreeRootsResponse> => {
        inputs.roots.push(structuredClone(request));
        return settle(fixture.roots ?? { roots: [] });
      },
      listFileTreeDirectory: (request): Promise<FileTreeDirectoryResponse> => {
        inputs.directory.push(structuredClone(request));
        return settle(fixture.entries ?? { entries: [] });
      },
    },
    driver: {
      serve: (next): Promise<void> => {
        fixture = structuredClone(next);
        inputs = { roots: [], directory: [] };
        return Promise.resolve();
      },
      serviceInputs: () => Promise.resolve(structuredClone(inputs)),
    },
  };
}

export type W4ChatItem = CanopyStreamItem<'core.chat.events'>;
export const W4_CHAT_SCOPE = {
  projectId: 'project-w4',
  worktreeId: 'worktree-w4',
};
const CREATED_AT = '2026-10-01T00:00:00.000Z';

/** Deterministic chat state: independent copies emit byte-equal events. */
export function createW4ChatState(): {
  port: ChatStateCommandPort;
  commit: () => void;
  revision: () => number;
  subscribers: () => number;
} {
  const listeners = new Set<(event: ChatStateChangedEvent) => void>();
  const state: ChatStateSnapshot = {
    schemaVersion: 1,
    ...W4_CHAT_SCOPE,
    revision: 0,
    tabsFile: { version: 1, activeTabId: '', tabs: [] },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
  const port: ChatStateCommandPort = {
    getState: jest.fn(() => Promise.resolve(structuredClone(state))),
    getTranscriptPage: jest.fn(),
    searchTranscript: jest.fn(),
    readToolOutput: jest.fn(),
    readVisual: jest.fn(),
    command: jest.fn(),
    subscribe: (listener) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
  const commit = (): void => {
    const revision = state.revision + 1;
    const tab = {
      id: `chat-${revision}`,
      title: `Chat ${revision}`,
      createdAt: CREATED_AT,
      messages: [],
    };
    state.revision = revision;
    state.tabsFile.tabs.push(tab);
    state.tabsFile.activeTabId = tab.id;
    const event: ChatStateChangedEvent = {
      schemaVersion: 1,
      eventId: `w4-event-${revision}`,
      occurredAt: CREATED_AT,
      ...W4_CHAT_SCOPE,
      baseRevision: revision - 1,
      revision,
      changes: [{ type: 'tab.upserted', tab }],
    };
    Array.from(listeners).forEach((listener) => listener(event));
  };
  return {
    port,
    commit,
    revision: () => state.revision,
    subscribers: () => listeners.size,
  };
}

export interface W4DispatcherHost {
  readonly runtime: DesktopCanopyDispatcher;
  /** Items the history hold received since the last (re)start. */
  readonly items: readonly W4ChatItem[];
  commit(): void;
  revision(): number;
  /** Live chat-state subscriptions: the history hold plus open streams. */
  subscribers(): number;
  restart(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * The production dispatcher over test-owned services. The desktop adapter
 * drops chat history when its last subscriber closes, so the host holds its
 * own `core.chat.events` subscriber for as long as each runtime lives.
 */
export async function startW4DispatcherHost(
  holder: string,
  services?: WorkerFilesystemServices,
): Promise<W4DispatcherHost> {
  const chat = createW4ChatState();
  const caller: CanopyCallerDescriptor = {
    principalId: 'w4-parity',
    clientInstanceId: holder,
    authorityId: 'local-desktop',
    interfaceKind: 'test',
    grants: ['core.chat.read'],
  };
  let runtime = createDesktopRuntime({
    services,
    getChatStatePort: () => chat.port,
  });
  let items: W4ChatItem[] = [];
  const hold = (): ReturnType<DesktopCanopyDispatcher['openStream']> => {
    items = [];
    return runtime.openStream(
      'core.chat.events',
      { scope: W4_CHAT_SCOPE },
      {
        caller,
        onFrame: (frame) => {
          if (frame.kind === 'item') items.push(frame.item);
        },
      },
    );
  };
  const acquireHold = async (): ReturnType<
    DesktopCanopyDispatcher['openStream']
  > => {
    try {
      return await hold();
    } catch (error) {
      try {
        await runtime.shutdown();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'W4 hold setup and cleanup failed',
        );
      }
      throw error;
    }
  };
  let held = await acquireHold();
  const stop = async (): Promise<void> => {
    held.close();
    await runtime.shutdown();
  };
  return {
    get runtime(): DesktopCanopyDispatcher {
      return runtime;
    },
    get items(): readonly W4ChatItem[] {
      return items;
    },
    commit: chat.commit,
    revision: chat.revision,
    subscribers: chat.subscribers,
    async restart(): Promise<void> {
      await stop();
      runtime = createDesktopRuntime({
        services,
        getChatStatePort: () => chat.port,
      });
      held = await acquireHold();
    },
    shutdown: stop,
  };
}

/** Serves an independent production dispatcher over an in-memory framed pair. */
export const inMemoryParityBinding: W4ParityBinding = {
  name: 'in-memory',
  async start(): Promise<W4ParityBackend> {
    const fixtures = createW4FilesystemFixtureServices();
    const host = await startW4DispatcherHost(
      'w4-backend-hold',
      fixtures.services,
    );
    return {
      expected: { operations: SERVED_OPERATIONS, streams: SERVED_STREAMS },
      filesystem: fixtures.driver,
      chat: {
        commit: (): Promise<void> => Promise.resolve(host.commit()),
        restart: () => host.restart(),
      },
      async connect(options): Promise<W4ParityEndpoint> {
        const pair = await createInMemoryFramedPair();
        const serving = serveW4Runtime(host.runtime, pair.server, options);
        return {
          connection: pair.client,
          async close(): Promise<void> {
            pair.client.close();
            pair.server.close();
            await serving;
          },
        };
      },
      shutdown: () => host.shutdown(),
    };
  },
};

/**
 * A fake daemon proving the contract: hooks are async and cross a cloning
 * control boundary into its own backend, and every call is counted.
 */
export function createW4FakeDaemonBinding(): {
  binding: W4ParityBinding;
  hookCalls: Map<string, number>;
} {
  const hookCalls = new Map<string, number>();
  const remote = async <T>(hook: string, run: () => Promise<T>): Promise<T> => {
    hookCalls.set(hook, (hookCalls.get(hook) ?? 0) + 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return structuredClone(await run());
  };
  const binding: W4ParityBinding = {
    name: 'fake-daemon',
    async start(): Promise<W4ParityBackend> {
      const daemon = await inMemoryParityBinding.start();
      return {
        expected: daemon.expected,
        filesystem: {
          serve: (fixture) =>
            remote('filesystem.serve', () =>
              daemon.filesystem.serve(structuredClone(fixture)),
            ),
          serviceInputs: () =>
            remote('filesystem.serviceInputs', () =>
              daemon.filesystem.serviceInputs(),
            ),
        },
        chat: {
          commit: () => remote('chat.commit', () => daemon.chat.commit()),
          restart: () => remote('chat.restart', () => daemon.chat.restart()),
        },
        connect: (options) => daemon.connect(options),
        shutdown: () => daemon.shutdown(),
      };
    },
  };
  return { binding, hookCalls };
}

const INITIALIZE = 'core.runtime.initialize';
const HEALTH = 'core.runtime.health.get';
const ROOTS = 'worker.filesystem.roots.list';
const DIRECTORY = 'worker.filesystem.directory.list';
const SNAPSHOT = 'core.chat.snapshot.get';
const CHAT_EVENTS = 'core.chat.events';
/** Placeholder until the daemon descriptor carries a real build (C5). */
const W4_BUILD_VERSION = '0.0.0-w4-parity';

const SERVED_OPERATIONS = [ROOTS, DIRECTORY, SNAPSHOT] as const;
const SERVED_STREAMS = [CHAT_EVENTS] as const;

const w4Caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'w4-parity',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.runtime.read', 'core.chat.read', 'worker.filesystem.read'],
};

const ENVELOPES = new Map<string, CanopyOperationEnvelopes>([
  [
    INITIALIZE,
    composeCanopyOperationEnvelopes(
      INITIALIZE,
      CORE_TRANSPORT_QUERY_DEFINITIONS[INITIALIZE],
    ),
  ],
  ...SERVED_OPERATIONS.map((name): [string, CanopyOperationEnvelopes] => [
    name,
    composeCanopyOperationEnvelopes(name, CANOPY_QUERY_DEFINITIONS[name]),
  ]),
  ...SERVED_STREAMS.map((name): [string, CanopyOperationEnvelopes] => [
    name,
    composeCanopyOperationEnvelopes(name, CANOPY_STREAM_DEFINITIONS[name]),
  ]),
]);

export const W4_INSTRUCTION_DEFINITIONS = {
  ...CANOPY_INSTRUCTION_DEFINITIONS,
  ...CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
};

export interface W4ParitySessionOptions {
  setupTimeoutMs?: number;
  /** Rewrites a query result after the dispatcher and before the wire. */
  mutateResult?: (method: string, result: unknown) => unknown;
}

export type W4ParityClient = CanopyClient<
  typeof CANOPY_QUERY_DEFINITIONS,
  typeof W4_INSTRUCTION_DEFINITIONS,
  typeof CANOPY_STREAM_DEFINITIONS
>;

export interface W4ParitySession {
  client: W4ParityClient;
  /** Closes this connection only; the backend keeps serving. Idempotent. */
  disconnect(): Promise<void>;
}

class W4BridgeError extends Error {
  constructor(readonly payload: CanopyErrorPayload) {
    super(payload.message);
  }
}

function typedPayload(error: unknown): CanopyErrorPayload | null {
  if (!(error instanceof Object) || !('payload' in error)) return null;
  const parsed = CanopyErrorPayloadSchema.safeParse(error.payload);
  return parsed.success ? parsed.data : null;
}

async function readyHealth(
  runtime: DesktopCanopyDispatcher,
): ReturnType<typeof runtime.query<typeof HEALTH>> {
  let health = await runtime.query(HEALTH, {}, { caller: w4Caller });
  for (
    let attempt = 0;
    health.runtime.state === 'starting' && attempt < 20;
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    health = await runtime.query(HEALTH, {}, { caller: w4Caller });
  }
  return health;
}

async function initializeResult(
  runtime: DesktopCanopyDispatcher,
  offered: readonly number[],
): Promise<CoreRuntimeInitializeResult> {
  const { runtime: descriptor } = await readyHealth(runtime);
  // No common version fails the result schema: the handshake fails closed.
  const common = offered.filter((v) => descriptor.protocolVersions.includes(v));
  return CoreRuntimeInitializeResultSchema.parse({
    runtime: { ...descriptor, buildVersion: W4_BUILD_VERSION },
    selectedProtocolVersion: Math.max(0, ...common),
    capabilities: {
      operations: [...SERVED_OPERATIONS],
      events: [],
      streams: [...SERVED_STREAMS],
    },
    limits: {},
    authentication: { required: true, methods: [] },
  });
}

/** Serves one framed connection; settles after the connection closes. */
async function serveW4Runtime(
  runtime: DesktopCanopyDispatcher,
  server: CanopyFramedConnection,
  options: W4ParitySessionOptions,
): Promise<void> {
  const handles = new Set<{ close(): void }>();
  const inFlight = new Set<Promise<void>>();
  const dispose = (): void => {
    handles.forEach((handle) => handle.close());
    handles.clear();
  };
  server.signal.addEventListener('abort', dispose, { once: true });
  // One chain keeps every reply and notification in send order.
  let delivery = Promise.resolve();
  const send = (message: CanopyJsonRpcMessage): Promise<void> => {
    delivery = delivery
      .then(() => server.send(message))
      .catch(() => server.close());
    return delivery;
  };

  const forwardQuery = (
    method: (typeof SERVED_OPERATIONS)[number],
    params: Record<string, unknown>,
    metadata: CanopyQueryRequestMetadata | undefined,
  ): Promise<unknown> => {
    const call = { caller: w4Caller, metadata };
    switch (method) {
      case ROOTS:
        return runtime.query(
          ROOTS,
          CANOPY_QUERY_DEFINITIONS[ROOTS].params.parse(params),
          call,
        );
      case DIRECTORY:
        return runtime.query(
          DIRECTORY,
          CANOPY_QUERY_DEFINITIONS[DIRECTORY].params.parse(params),
          call,
        );
      case SNAPSHOT:
        return runtime.query(
          SNAPSHOT,
          CANOPY_QUERY_DEFINITIONS[SNAPSHOT].params.parse(params),
          call,
        );
    }
  };

  const openChatEvents = async (
    id: CanopyJsonRpcRequest['id'],
    params: Record<string, unknown>,
    metadata: CanopyQueryRequestMetadata | undefined,
  ): Promise<void> => {
    const handle = await runtime.openStream(
      CHAT_EVENTS,
      CANOPY_STREAM_DEFINITIONS[CHAT_EVENTS].params.parse(params),
      { caller: w4Caller, metadata },
    );
    if (server.signal.aborted) return handle.close();
    handles.add(handle);
    const { subscriptionId } = handle.openResult;
    // Queue the open reply first; the handle buffers frames until onFrame.
    const opened = send({ jsonrpc: '2.0', id, result: handle.openResult });
    handle.onFrame((frame) => {
      if (frame.kind === 'item') {
        void send({
          jsonrpc: '2.0',
          method: `${CHAT_EVENTS}.item`,
          params: {
            subscriptionId,
            cursor: frame.cursor,
            itemId: `${frame.cursor.daemonEpoch}#${frame.cursor.sequence}`,
            occurredAt: new Date().toISOString(),
            item: frame.item,
          },
        });
        return;
      }
      handles.delete(handle);
      void send({
        jsonrpc: '2.0',
        method: `${CHAT_EVENTS}.end`,
        params: {
          subscriptionId,
          cursor: frame.cursor,
          outcome: frame.outcome,
          error: frame.error,
        },
      });
    });
    await opened;
  };

  const respond = async (message: CanopyJsonRpcRequest): Promise<void> => {
    const { id, method } = message;
    const envelopes = ENVELOPES.get(method);
    if (!envelopes) {
      await send({
        jsonrpc: '2.0',
        id,
        error: {
          code: CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.methodNotFound,
          message: `Unknown method ${method}.`,
        },
      });
      return;
    }
    try {
      if (!envelopes.request.safeParse(message).success)
        throw new W4BridgeError({
          kind: 'invalid_argument',
          message: `Invalid ${method} parameters.`,
          retry: { kind: 'never' },
        });
      const { _meta: metadata, ...params } = message.params;
      if (method === INITIALIZE) {
        const offered =
          CORE_TRANSPORT_QUERY_DEFINITIONS[INITIALIZE].params.parse(params)
            .client.protocolVersions;
        const result = await initializeResult(runtime, offered);
        await send({ jsonrpc: '2.0', id, result });
      } else if (method === CHAT_EVENTS) {
        await openChatEvents(id, params, metadata);
      } else if (
        method === ROOTS ||
        method === DIRECTORY ||
        method === SNAPSHOT
      ) {
        const raw = await forwardQuery(method, params, metadata);
        const result = options.mutateResult?.(method, raw) ?? raw;
        await send({ jsonrpc: '2.0', id, result });
      }
    } catch (error) {
      const payload = typedPayload(error) ?? {
        kind: 'internal',
        message: 'The W4 bridge failed.',
        retry: { kind: 'never' },
      };
      await send({ jsonrpc: '2.0', id, error: encodeCanopyError(payload) });
    }
  };

  try {
    while (!server.signal.aborted) {
      const message = await server.receive().catch(() => null);
      if (!message) break;
      if (!('method' in message) || !('id' in message)) continue;
      const task = respond(message).finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
  } finally {
    server.signal.removeEventListener('abort', dispose);
    // A stream opened while the connection closed is closed here too.
    await Promise.allSettled([...inFlight]);
    dispose();
  }
}

/** Connects a client to one endpoint of the selected backend. */
export async function createW4ParitySession(
  backend: W4ParityBackend,
  options: W4ParitySessionOptions = {},
): Promise<W4ParitySession> {
  const timeoutMs = options.setupTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error('Invalid W4 setup timeout.');
  const resources = new W4Resources();
  const timer = setTimeout(() => {
    void resources
      .cancel(new Error('Timed out: W4 session setup'))
      .catch(() => undefined);
  }, timeoutMs);
  try {
    const endpoint = await resources.acquire(
      backend.connect(options, resources.controller.signal),
      (value) => value.close(),
    );
    const client = await resources.acquire(
      createCanopyClient({
        connection: endpoint.connection,
        clientName: 'w4-parity-harness',
        clientVersion: W4_BUILD_VERSION,
        signal: resources.controller.signal,
        definitions: {
          queries: CANOPY_QUERY_DEFINITIONS,
          instructions: W4_INSTRUCTION_DEFINITIONS,
          streams: CANOPY_STREAM_DEFINITIONS,
        },
      }),
      (value) => value.close(),
    );
    if (endpoint.activate)
      await resources.acquire(endpoint.activate(client), (value) =>
        value.close(),
      );
    return { client, disconnect: () => resources.close() };
  } catch (error) {
    return resources.fail(error, 'W4 setup and cleanup failed');
  } finally {
    clearTimeout(timer);
  }
}

type W4Outcome =
  | { ok: true; bytes: Buffer }
  | { ok: false; kind: CanopyErrorPayload['kind']; message: string };

async function settleOutcome(
  name: string,
  side: 'direct' | 'daemon',
  run: () => Promise<unknown>,
): Promise<W4Outcome> {
  let value: unknown;
  try {
    value = await run();
  } catch (error) {
    const payload = typedPayload(error);
    if (!payload)
      throw new Error(`${name}: ${side} failed without a typed error payload.`);
    return { ok: false, kind: payload.kind, message: payload.message };
  }
  const json = value === undefined ? undefined : JSON.stringify(value);
  if (json === undefined)
    throw new Error(`${name}: ${side} returned no result.`);
  return { ok: true, bytes: Buffer.from(json, 'utf8') };
}

function describeOutcome(outcome: W4Outcome): string {
  return outcome.ok
    ? `result ${outcome.bytes.toString('utf8')}`
    : `error kind ${outcome.kind} (${outcome.message})`;
}

/**
 * Successful results must be byte-equal as UTF-8 JSON; failures must carry the
 * same typed error kind. Messages may differ: the wire never promises them.
 */
export async function assertW4Parity(
  name: string,
  direct: () => Promise<unknown>,
  daemon: () => Promise<unknown>,
): Promise<void> {
  const expected = await settleOutcome(name, 'direct', direct);
  const actual = await settleOutcome(name, 'daemon', daemon);
  const same = expected.ok
    ? actual.ok && expected.bytes.equals(actual.bytes)
    : !actual.ok && expected.kind === actual.kind;
  if (!same)
    throw new Error(
      `${name}: direct ${describeOutcome(expected)} but daemon ${describeOutcome(actual)}.`,
    );
}

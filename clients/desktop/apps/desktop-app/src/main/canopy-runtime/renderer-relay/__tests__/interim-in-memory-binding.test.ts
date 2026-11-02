import {
  LEDGER_GRANTS,
  LedgerEntryAddResultSchema,
  type CanopyCallerDescriptor,
  type CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';
import type { RuntimeHealthCheck } from '@canopy/core-runtime';
import type {
  ChatStateChangedEvent,
  ChatStateCommandPort,
} from '@canopy/desktop-shared/types';
import type {
  CanopyFramedConnection,
  CanopyFramedPair,
} from '@canopy/core-transport';
import type * as Transport from '@canopy/core-transport';
import { createCanopyClient } from '@canopy/core-client';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../desktop-runtime';
import {
  createLedgerServiceHarness,
  type LedgerServiceHarness,
} from '../../../ledger/__tests__/fixtures/in-process-ledger-store-client';
import { CAPABILITIES_REGISTER, RELAY_DEFINITIONS } from '../definitions';
import {
  createInterimInMemoryBindingProvider,
  type InterimInMemoryBindingOptions,
} from '../interim-in-memory-binding';

/** Every pair the binding creates, so a test can drive its server end. */
const mockPairs: CanopyFramedPair[] = [];
jest.mock('@canopy/core-transport', () => {
  const actual = jest.requireActual<typeof Transport>('@canopy/core-transport');
  return {
    ...actual,
    createInMemoryFramedPair: async (
      ...args: Parameters<typeof actual.createInMemoryFramedPair>
    ): Promise<CanopyFramedPair> => {
      const pair = await actual.createInMemoryFramedPair(...args);
      mockPairs.push(pair);
      return pair;
    },
  };
});

jest.mock('../../../services/files-service', () => ({
  listFileTreeRoots: jest.fn(),
  listFileTreeDirectory: jest.fn(),
}));

const HEALTH = 'core.runtime.health.get';
const EVENTS = 'core.runtime.events';
const INITIALIZE = 'core.runtime.initialize';
const CAPABILITY = {
  name: 'core.native.notify',
  version: 1,
  inputSchema: {},
  outputSchema: {},
};
const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function caller(
  grants: CanopyCallerDescriptor['grants'],
): CanopyCallerDescriptor {
  return {
    principalId: 'local-desktop-renderer',
    clientInstanceId: 'renderer-1',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants,
  };
}

let runtime: DesktopCanopyDispatcher;
let status: RuntimeHealthCheck['status'] = 'pass';
/** Pads health results and runtime events to probe frame caps. */
let checkMessage: string | null = null;
/** The runtime's live chat-event subscriptions, as the chat service sees them. */
const chatListeners = new Set<(event: ChatStateChangedEvent) => void>();
const unused = (): Promise<never> => Promise.reject(new Error('unused'));
const chatPort: ChatStateCommandPort = {
  searchTranscript: unused,
  getState: unused,
  getTranscriptPage: unused,
  readToolOutput: unused,
  readVisual: unused,
  command: unused,
  subscribe: (listener) => {
    chatListeners.add(listener);
    return () => void chatListeners.delete(listener);
  },
};
beforeEach(async () => {
  status = 'pass';
  checkMessage = null;
  chatListeners.clear();
  runtime = createDesktopRuntime({
    getChatStatePort: () => chatPort,
    shutdownTimeoutMs: 60_000,
    runtimeServices: [
      {
        name: 'relay-test',
        plane: 'core',
        health: (): RuntimeHealthCheck => ({
          name: 'relay-test',
          status,
          message: checkMessage,
        }),
      },
    ],
  });
  await settle();
});
// A 60 s drain window: shutdown settles in time only if every relay stream closed.
afterEach(() => runtime.shutdown());

async function connect(
  grants: CanopyCallerDescriptor['grants'],
  options: InterimInMemoryBindingOptions = {},
  signal = new AbortController().signal,
): Promise<Awaited<ReturnType<typeof createCanopyClient>>> {
  const provider = createInterimInMemoryBindingProvider(runtime, options);
  const connection = await provider({ caller: caller(grants), signal });
  return createCanopyClient({
    connection,
    clientName: 'relay-test',
    clientVersion: '1.0.0',
    definitions: RELAY_DEFINITIONS,
  });
}

async function response(
  connection: CanopyFramedConnection,
  id: number,
): Promise<CanopyJsonRpcMessage> {
  for (;;) {
    const message = await connection.receive();
    if ('id' in message && message.id === id && !('method' in message))
      return message;
  }
}

async function call(
  connection: CanopyFramedConnection,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<number | 'ok'> {
  const request: CanopyJsonRpcMessage = {
    jsonrpc: '2.0' as const,
    id,
    method: INITIALIZE,
    params,
  };
  // Keep unknown methods in the wire test without widening the typed request.
  Reflect.set(request, 'method', method);
  await connection.send(request);
  const message = await response(connection, id);
  return 'error' in message ? message.error.code : 'ok';
}

const initializeParams = {
  client: {
    name: 'raw',
    version: '1',
    protocolVersions: [1],
    capabilities: [],
  },
};

describe('interim in-memory relay binding', () => {
  it('preserves keyed recovery when a committed instruction result exceeds the wire cap', async () => {
    jest.spyOn(runtime, 'instruction').mockResolvedValue({
      commandId: 'command-1',
      revision: 1,
      outcome: 'applied',
      pad: 'x'.repeat(3 * 1024 * 1024),
    });
    const client = await connect(['core.chat.write', 'core.runtime.read']);
    try {
      await expect(
        client.instruction(
          'core.chat.create',
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            commandId: 'command-1',
            origin: 'desktop',
            action: { type: 'chat.create_tab', tabId: 'tab-1' },
          },
          { metadata: { idempotencyKey: 'oversized-key' } },
        ),
      ).rejects.toMatchObject({
        payload: {
          kind: 'resource_exhausted',
          retry: { kind: 'same_idempotency_key' },
        },
      });
      await expect(client.query(HEALTH, {})).resolves.toMatchObject({
        runtime: { state: 'ready' },
      });
    } finally {
      await client.close();
    }
  });
  it('applies channel admission registered through the binding', async () => {
    const client = await createInterimInMemoryBindingProvider(runtime)({
      caller: caller(['core.runtime.read']),
      signal: new AbortController().signal,
    });
    const server = mockPairs[mockPairs.length - 1]?.server;
    if (!server) throw new Error('No framed pair was created.');
    const refusal = {
      kind: 'permission_denied',
      message: 'Channels are not admitted.',
      retry: { kind: 'never' },
    } as const;
    const accepted = jest.fn();
    client.onChannel(accepted, { admit: () => refusal });
    await expect(
      server.openChannel({
        kind: 'pipeline.output',
        leaseId: 'lease-1',
        caps: { maxChunkBytes: 64, maxBufferedChunks: 2 },
      }),
    ).rejects.toMatchObject({ payload: refusal });
    expect(accepted).not.toHaveBeenCalled();
    client.close();
  });

  it('serves health over a real framed handshake with the runtime identity', async () => {
    const client = await connect(['core.runtime.read']);
    const health = await client.query(HEALTH, {});
    expect(health).toMatchObject({ runtime: { state: 'ready' } });
    expect(client.identity).toMatchObject({
      buildVersion: '0.0.0-test',
      profile: 'core+worker',
      runtimeId: 'local-desktop',
      protocolVersion: 1,
      daemonEpoch: (
        await runtime.query(
          HEALTH,
          {},
          { caller: caller(['core.runtime.read']) },
        )
      ).runtime.daemonEpoch,
    });
    const denied = Object.entries(RELAY_DEFINITIONS.queries).find(
      ([, definition]) =>
        definition.requiredGrants.some(
          (grant) => grant !== 'core.runtime.read',
        ),
    )?.[0];
    expect(denied).toBeDefined();
    expect(client.manifest.has('operations', HEALTH)).toBe(true);
    expect(client.manifest.has('operations', denied ?? '')).toBe(false);
    expect(client.manifest.has('operations', INITIALIZE)).toBe(false);
    expect(client.manifest.has('operations', CAPABILITIES_REGISTER)).toBe(
      false,
    );
    expect(client.manifest.has('streams', EVENTS)).toBe(true);
    expect([...client.manifest.events]).toEqual([]);
    await client.close();
  });

  it('forwards runtime events after the open response', async () => {
    const client = await connect(['core.runtime.read']);
    const handle = await client.openStream(EVENTS, { cursor: null });
    const frames = handle.frames[Symbol.asyncIterator]();
    const ready = await frames.next();
    expect(ready.value).toMatchObject({
      kind: 'item',
      item: { event: 'ready' },
    });
    status = 'warn';
    await client.query(HEALTH, {});
    const degraded = await frames.next();
    expect(degraded.value).toMatchObject({
      kind: 'item',
      item: { event: 'degraded' },
    });
    await client.close();
  });

  it('forwards capability registration per connection and drops it on disconnect', async () => {
    const onCapabilities = jest.fn();
    const controller = new AbortController();
    const client = await connect(
      ['core.client.manage'],
      { onCapabilities },
      controller.signal,
    );
    expect(client.manifest.has('operations', CAPABILITIES_REGISTER)).toBe(true);
    const register = (
      idempotencyKey: string,
      capabilities: unknown[],
    ): Promise<unknown> =>
      client.instruction(
        CAPABILITIES_REGISTER,
        { capabilities },
        { metadata: { idempotencyKey } },
      );
    const first = await register('k1', [CAPABILITY]);
    expect(first).toEqual({
      registrationRevision: 1,
      effectiveCapabilities: [CAPABILITY.name],
    });
    expect(await register('k1', [CAPABILITY])).toEqual(first);
    expect(onCapabilities).toHaveBeenCalledTimes(1);
    expect(onCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ clientInstanceId: 'renderer-1' }),
      [CAPABILITY],
    );
    await expect(register('k1', [])).rejects.toMatchObject({
      payload: { kind: 'conflict' },
    });
    await expect(
      register('k2', [CAPABILITY, CAPABILITY]),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(await register('k3', [])).toMatchObject({ registrationRevision: 2 });
    controller.abort();
    expect(client.connection.signal.aborted).toBe(true);
    for (
      let tick = 0;
      tick < 20 && onCapabilities.mock.calls.length < 3;
      tick++
    )
      await settle();
    expect(onCapabilities).toHaveBeenCalledTimes(3);
    expect(onCapabilities).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientInstanceId: 'renderer-1' }),
      [],
    );
  });

  it('releases a renderer-closed stream on the host hook before disconnect', async () => {
    const provider = createInterimInMemoryBindingProvider(runtime);
    const connection = await provider({
      caller: caller(['core.chat.read']),
      signal: new AbortController().signal,
    });
    const client = await createCanopyClient({
      connection,
      clientName: 'relay-test',
      clientVersion: '1.0.0',
      definitions: RELAY_DEFINITIONS,
    });
    // Past MAX_STREAMS (32): an unreleased slot would exhaust the connection.
    for (let round = 0; round < 40; round += 1) {
      const handle = await client.openStream('core.chat.events', {
        scope: 'all',
        cursor: null,
      });
      expect(chatListeners.size).toBe(1);
      handle.close();
      connection.releaseStream?.(handle.openResult.subscriptionId);
      for (let tick = 0; tick < 20 && chatListeners.size > 0; tick += 1)
        await settle();
      expect(chatListeners.size).toBe(0);
    }
    connection.releaseStream?.('unknown-subscription');
    expect(client.connection.signal.aborted).toBe(false);
    await client.openStream('core.chat.events', { scope: 'all', cursor: null });
    expect(chatListeners.size).toBe(1);
    await client.close();
    for (let tick = 0; tick < 20 && chatListeners.size > 0; tick += 1)
      await settle();
    expect(chatListeners.size).toBe(0);
  });

  it('closes on the input signal and releases open streams', async () => {
    const controller = new AbortController();
    const client = await connect(['core.runtime.read'], {}, controller.signal);
    const handle = await client.openStream(EVENTS, { cursor: null });
    controller.abort();
    const frames: unknown[] = [];
    for await (const frame of handle.frames) frames.push(frame);
    expect(frames.at(-1)).toMatchObject({ kind: 'end' });
    expect(client.signal.aborted).toBe(true);
  });

  it('rejects aborted and malformed callers before connecting', async () => {
    const provider = createInterimInMemoryBindingProvider(runtime);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      provider({ caller: caller([]), signal: aborted.signal }),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
    await expect(
      provider({
        caller: { ...caller([]), principalId: '' },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'unauthenticated' } });
  });

  it('enforces handshake order, schemas, grants, installed methods and caps', async () => {
    const provider = createInterimInMemoryBindingProvider(runtime, {
      onCapabilities: jest.fn(),
    });
    const signal = new AbortController().signal;
    const raw = await provider({
      caller: caller(['core.runtime.read']),
      signal,
    });
    expect(await call(raw, 1, HEALTH, {})).toBe(-32006);
    expect(await call(raw, 2, INITIALIZE, initializeParams)).toBe('ok');
    expect(await call(raw, 3, HEALTH, { extra: true })).toBe(-32602);
    expect(await call(raw, 4, 'core.admin.shutdown', {})).toBe(-32601);
    // params._meta reaches the bound in-process call as request metadata.
    expect(
      await call(raw, 6, HEALTH, {
        _meta: { deadlineAt: '2000-01-01T00:00:00Z' },
      }),
    ).toBe(-32009);
    expect(
      await call(raw, 5, CAPABILITIES_REGISTER, {
        capabilities: [],
        _meta: { idempotencyKey: 'k' },
      }),
    ).toBe(-32002);
    for (let id = 100; id < 132; id += 1)
      expect(await call(raw, id, EVENTS, { cursor: null })).toBe('ok');
    expect(await call(raw, 132, EVENTS, { cursor: null })).toBe(-32011);
    await expect(
      raw.send({
        jsonrpc: '2.0',
        id: 133,
        method: HEALTH,
        params: { pad: 'x'.repeat(2 * 1024 * 1024) },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'resource_exhausted' } });
    raw.close();

    const ungranted = await provider({ caller: caller([]), signal });
    expect(await call(ungranted, 1, INITIALIZE, initializeParams)).toBe('ok');
    expect(await call(ungranted, 2, HEALTH, {})).toBe(-32002);
    ungranted.close();
  });

  // CAN-5496: a renderer `_execution` stays in the params, which refuse it.
  it('refuses a renderer _execution as invalid params, even where the envelope admits it', async () => {
    const provider = createInterimInMemoryBindingProvider(runtime);
    const raw = await provider({
      caller: caller(['core.runtime.read', 'worker.git.read']),
      signal: new AbortController().signal,
    });
    expect(await call(raw, 1, INITIALIZE, initializeParams)).toBe('ok');
    expect(
      await call(raw, 2, 'worker.git.branch.list', {
        scope: { workspaceId: 'workspace', worktreeId: 'worktree' },
        repository: { kind: 'checkout' },
        _execution: { childEnvironment: { GIT_SSH_COMMAND: 'touch /tmp/x' } },
      }),
    ).toBe(-32602);
    raw.close();
  });

  const MiB = 1024 * 1024;
  const bytes = (value: unknown): number =>
    Buffer.byteLength(JSON.stringify(value));

  async function registrar(onCapabilities: jest.Mock): Promise<{
    register: (key: string, capabilities: unknown[]) => Promise<unknown>;
    close: () => Promise<void>;
  }> {
    const client = await connect(['core.client.manage'], { onCapabilities });
    return {
      register: (idempotencyKey, capabilities) =>
        client.instruction(
          CAPABILITIES_REGISTER,
          { capabilities },
          { metadata: { idempotencyKey } },
        ),
      close: () => client.close(),
    };
  }

  it('compares registration replays by canonical value, not key order', async () => {
    const onCapabilities = jest.fn();
    const { register, close } = await registrar(onCapabilities);
    const nested = {
      ...CAPABILITY,
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'string', minLength: 1 } },
      },
    };
    const reordered = {
      outputSchema: {},
      inputSchema: {
        properties: { a: { minLength: 1, type: 'string' } },
        type: 'object',
      },
      version: 1,
      name: CAPABILITY.name,
    };
    const first = await register('k1', [nested]);
    expect(await register('k1', [reordered])).toEqual(first);
    expect(onCapabilities).toHaveBeenCalledTimes(1);
    await expect(
      register('k1', [
        {
          ...nested,
          inputSchema: {
            type: 'object',
            properties: { a: { type: 'number' } },
          },
        },
      ]),
    ).rejects.toMatchObject({ payload: { kind: 'conflict' } });
    expect(onCapabilities).toHaveBeenCalledTimes(1);
    await close();
  });

  it('keeps every key outcome for the connection and refuses keys past capacity', async () => {
    const onCapabilities = jest.fn();
    const { register, close } = await registrar(onCapabilities);
    const first = await register('key-0', [CAPABILITY]);
    for (let index = 1; index < 32; index += 1)
      await register(`key-${index}`, index % 2 ? [] : [CAPABILITY]);
    expect(onCapabilities).toHaveBeenCalledTimes(32);
    await expect(register('key-32', [])).rejects.toMatchObject({
      payload: { kind: 'resource_exhausted' },
    });
    expect(onCapabilities).toHaveBeenCalledTimes(32);
    // The oldest key still replays its own outcome without a stale re-forward.
    expect(await register('key-0', [CAPABILITY])).toEqual(first);
    await expect(register('key-0', [])).rejects.toMatchObject({
      payload: { kind: 'conflict' },
    });
    expect(await register('key-31', [])).toMatchObject({
      registrationRevision: 32,
    });
    expect(onCapabilities).toHaveBeenCalledTimes(32);
    await close();
  });

  it('carries a query result near the 1 MiB relay cap and fails oversized ones alone', async () => {
    const client = await connect(['core.runtime.read']);
    const baseline = await client.query(HEALTH, {});
    // Just under 1 MiB, so its response envelope is over 1 MiB.
    // `null` (4 bytes) becomes a quoted string (length + 2).
    checkMessage = 'x'.repeat(MiB - 16 - bytes(baseline) + 2);
    expect(bytes(await client.query(HEALTH, {}))).toBe(MiB - 16);
    checkMessage = 'x'.repeat(3 * MiB);
    await expect(client.query(HEALTH, {})).rejects.toMatchObject({
      payload: { kind: 'resource_exhausted' },
    });
    checkMessage = null;
    expect(await client.query(HEALTH, {})).toMatchObject({
      runtime: { state: 'ready' },
    });
    expect(client.connection.signal.aborted).toBe(false);
    await client.close();
  });

  it('carries a stream item near the 1 MiB relay cap and ends oversized streams alone', async () => {
    const client = await connect(['core.chat.read', 'core.runtime.read']);
    const handle = await client.openStream('core.chat.events', {
      scope: 'all',
      cursor: null,
    });
    const frames = handle.frames[Symbol.asyncIterator]();
    const tabIds: string[] = [];
    const event = (): ChatStateChangedEvent => ({
      schemaVersion: 1,
      eventId: `event-${tabIds.length}`,
      occurredAt: '2026-10-08T12:00:00.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      baseRevision: 0,
      revision: 1,
      changes: [{ type: 'tab.order_changed', tabIds }],
    });
    const publish = (): void =>
      chatListeners.forEach((listener) => listener(event()));
    // Item under 1 MiB by less than the wire item envelope (> 200 bytes).
    const target = MiB - 160;
    while (bytes(event()) + 503 <= target) tabIds.push('t'.repeat(500));
    tabIds.push('t'.repeat(target - bytes(event()) - 3));
    expect(bytes(event())).toBe(target);
    publish();
    const item = await frames.next();
    if (item.done) throw new Error('The stream ended early.');
    expect(item.value).toMatchObject({ kind: 'item' });
    expect(bytes(item.value)).toBeLessThanOrEqual(MiB);
    expect(bytes(item.value)).toBeGreaterThan(target);
    // Past the wire cap: only this stream ends, at its last delivered cursor.
    tabIds.splice(
      0,
      tabIds.length,
      ...Array.from({ length: 6_000 }, () => 't'.repeat(500)),
    );
    publish();
    const ended = await frames.next();
    expect(ended.value).toMatchObject({
      kind: 'end',
      outcome: 'error',
      cursor: item.value.cursor,
      error: { kind: 'resource_exhausted' },
    });
    expect(chatListeners.size).toBe(0);
    expect(await client.query(HEALTH, {})).toMatchObject({
      runtime: { state: 'ready' },
    });
    expect(client.connection.signal.aborted).toBe(false);
    await client.close();
  });
});

// The Ledger's keyed params declare `_meta` inside a preprocess pipe, so the
// relay keeps it in params (core-runtime's paramsDeclareMeta).
describe('interim in-memory relay binding: Ledger keyed instructions', () => {
  let harness: LedgerServiceHarness;
  let ledgerRuntime: DesktopCanopyDispatcher;

  beforeEach(() => {
    harness = createLedgerServiceHarness();
    harness.enabled = true;
    ledgerRuntime = createDesktopRuntime({
      getChatStatePort: () => chatPort,
      shutdownTimeoutMs: 60_000,
      ledgerService: harness.service,
    });
  });
  afterEach(async () => {
    await ledgerRuntime.shutdown();
    harness.dispose();
  });

  async function connectAs(
    principalId: string,
  ): Promise<Awaited<ReturnType<typeof createCanopyClient>>> {
    const provider = createInterimInMemoryBindingProvider(ledgerRuntime);
    const connection = await provider({
      caller: {
        ...caller([LEDGER_GRANTS.read, LEDGER_GRANTS.write]),
        principalId,
      },
      signal: new AbortController().signal,
    });
    return createCanopyClient({
      connection,
      clientName: 'relay-test',
      clientVersion: '1.0.0',
      definitions: RELAY_DEFINITIONS,
    });
  }

  const addEntry = (
    client: Awaited<ReturnType<typeof createCanopyClient>>,
    idempotencyKey: string,
  ): Promise<unknown> =>
    client.instruction(
      'core.ledger.entry.add',
      {
        type: 'TASK',
        title: 'Plan the work',
        content: 'Write the plan.',
        _meta: { idempotencyKey },
      },
      { metadata: { idempotencyKey } },
    );

  it('keeps _meta in params so a bound caller adds and updates an entry', async () => {
    const client = await connectAs(harness.register());
    try {
      const added = LedgerEntryAddResultSchema.parse(
        await addEntry(client, 'relay-ledger-add'),
      );
      expect(added.entry.title).toBe('Plan the work');
      await expect(
        client.instruction(
          'core.ledger.entry.update',
          {
            entryId: added.entry.entryId,
            expectedRevision: 1,
            status: 'IN_PROGRESS',
            _meta: { idempotencyKey: 'relay-ledger-update' },
          },
          { metadata: { idempotencyKey: 'relay-ledger-update' } },
        ),
      ).resolves.toMatchObject({ entry: { status: 'IN_PROGRESS' } });
    } finally {
      await client.close();
    }
  });

  it('reaches the service, which refuses an unbound renderer principal', async () => {
    const client = await connectAs('local-desktop-renderer:main');
    try {
      await expect(
        addEntry(client, 'relay-ledger-unbound'),
      ).rejects.toMatchObject({
        payload: {
          kind: 'permission_denied',
          message: 'The caller may not perform this Feed operation.',
        },
      });
      expect(harness.store.client.calls).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

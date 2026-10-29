import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { test as nodeTest, type TestContext } from 'node:test';
import path from 'node:path';
import { connectAcp } from '../client';
import { AcpClientError, type AcpErrorCode } from '../errors';
import type {
  AcpClient,
  AcpClientOptions,
  AcpPermissionRequest,
} from '../types';
import type { SessionNotification } from '@agentclientprotocol/sdk';

function test(
  name: string,
  scenario: (context: TestContext) => Promise<void>,
): void {
  // Node's runner owns completion and reports rejected scenarios to the parent.
  void nodeTest(name, scenario);
}

function startAgent(profile = 'normal'): {
  options: AcpClientOptions;
  closeCount: () => number;
  dispose(): Promise<void>;
} {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'fake-agent.mjs'), profile],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  child.stderr.resume();
  let closes = 0;
  return {
    options: {
      transport: {
        input: Readable.toWeb(child.stdout),
        output: Writable.toWeb(child.stdin),
        close: (): void => {
          closes++;
          child.kill();
        },
      },
      clientInfo: { name: 'test-host', version: '1.0.0' },
      resourceGeneration: 1,
      onUpdate: (): void => {},
      timeouts: {
        initializeMs: 5000,
        requestMs: 3000,
        promptMs: 5000,
        permissionMs: 1000,
        cancelMs: 250,
        turnCancelMs: 250,
      },
    },
    closeCount: (): number => closes,
    async dispose(): Promise<void> {
      child.kill();
      await exited;
    },
  };
}

test('cancel rejects an unattached resumed session without throwing synchronously', async () => {
  const agent = startAgent();
  try {
    const client = await connectAcp(agent.options);
    try {
      let cancellation: Promise<void> | undefined;
      assert.doesNotThrow(() => {
        cancellation = client.cancel('not-yet-loaded');
      });
      assert.ok(cancellation);
      await assert.rejects(cancellation, hasCode('invalid-session'));
    } finally {
      client.close();
    }
  } finally {
    await agent.dispose();
  }
});

test('negotiates stable ACP v1 and protects the capability snapshot', async () => {
  const agent = startAgent();
  try {
    const client = await connectAcp(agent.options);
    try {
      const snapshot = client.getInitialization();
      assert.equal(snapshot.protocolVersion, 1);
      assert.equal(snapshot.agentInfo?.name, 'fake-acp');
      assert.deepEqual(snapshot._meta?.futureExtension, { enabled: true });
      snapshot.agentCapabilities = { loadSession: true };
      assert.deepEqual(client.getInitialization().agentCapabilities, {});
    } finally {
      client.close();
    }
  } finally {
    await agent.dispose();
  }
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = (): void => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function hasCode(code: AcpErrorCode): (error: unknown) => boolean {
  return (error): boolean =>
    error instanceof AcpClientError && error.code === code;
}

async function setup(
  t: TestContext,
  profile = 'full',
  overrides: Partial<AcpClientOptions> = {},
): Promise<{
  client: AcpClient;
  sessionId: string;
  updates: SessionNotification[];
  closeCount: () => number;
}> {
  const agent = startAgent(profile);
  t.after(() => agent.dispose());
  const updates: SessionNotification[] = [];
  const client = await connectAcp({
    ...agent.options,
    onUpdate: (update): void => {
      updates.push(update);
    },
    ...overrides,
    timeouts: { ...agent.options.timeouts, ...overrides.timeouts },
  });
  t.after(() => client.close());
  const { sessionId } = await client.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });
  return { client, sessionId, updates, closeCount: agent.closeCount };
}

function prompt(
  client: AcpClient,
  sessionId: string,
  instruction: string,
  signal?: AbortSignal,
): ReturnType<AcpClient['prompt']> {
  return client.prompt(
    { sessionId, prompt: [{ type: 'text', text: instruction }] },
    1,
    signal,
  );
}

test('advertises no unimplemented file or terminal callbacks', async (t) => {
  const { client } = await setup(t);
  assert.deepEqual(client.getInitialization()._meta?.client, {
    protocolVersion: 1,
    clientInfo: { name: 'test-host', version: '1.0.0' },
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  });
});

test('forwards vendor capability flags on initialize and answers extension requests', async (t) => {
  const agent = startAgent();
  t.after(() => agent.dispose());
  const client = await connectAcp({
    ...agent.options,
    clientCapabilityMeta: { parameterizedModelPicker: true },
  });
  t.after(() => client.close());
  assert.deepEqual(client.getInitialization()._meta?.client, {
    protocolVersion: 1,
    clientInfo: { name: 'test-host', version: '1.0.0' },
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      _meta: { parameterizedModelPicker: true },
    },
  });
  assert.deepEqual(await client.extMethod('fake/echo', { probe: 1 }), {
    echoed: { probe: 1 },
  });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    client.extMethod('fake/echo', {}, aborted.signal),
    hasCode('cancelled'),
  );
  // A disposed client rejects rather than throwing from a Promise-returning
  // method, so callers can rely on `.catch` alone.
  client.close();
  let threw = false;
  let pending: Promise<unknown> | undefined;
  try {
    pending = client.extMethod('fake/echo', {});
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  await assert.rejects(pending ?? Promise.resolve(), hasCode('closed'));
});

test('rejects incompatible versions and closes the process once', async (t) => {
  const agent = startAgent('wrong-version');
  t.after(() => agent.dispose());
  await assert.rejects(connectAcp(agent.options), hasCode('unsupported'));
  assert.equal(agent.closeCount(), 1);
});

test('bounds a hung initialize and closes the process', async (t) => {
  const agent = startAgent('no-initialize');
  t.after(() => agent.dispose());
  await assert.rejects(
    connectAcp({ ...agent.options, timeouts: { initializeMs: 150 } }),
    hasCode('timeout'),
  );
  assert.equal(agent.closeCount(), 1);
});

test('rejects invalid deadlines before connecting and releases the transport', async (t) => {
  const agent = startAgent();
  t.after(() => agent.dispose());
  await assert.rejects(
    connectAcp({ ...agent.options, timeouts: { requestMs: 0 } }),
    hasCode('invalid-input'),
  );
  assert.equal(agent.closeCount(), 1);
});

test('streams text and tool updates in order, preserving metadata and session identity', async (t) => {
  const { client, sessionId, updates } = await setup(t);
  assert.equal(
    (await prompt(client, sessionId, 'stream')).stopReason,
    'end_turn',
  );
  assert.deepEqual(
    updates.map((event) => event.update.sessionUpdate),
    [
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
    ],
  );
  assert(updates.every((event) => event.sessionId === sessionId));
  assert.deepEqual(updates[1]?.update._meta, { future: 1 });
});

test('preserves updates sent before session/new returns and discards unrelated updates', async (t) => {
  const { sessionId, updates } = await setup(t, 'early-update');
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.sessionId, sessionId);
});

test('bounds unsolicited updates while session creation is pending', async (t) => {
  await assert.rejects(setup(t, 'flood-updates'), hasCode('protocol'));
});

test('a raised update cap accepts a chatty session start', async (t) => {
  const { updates } = await setup(t, 'flood-updates', {
    maxPendingUpdates: 128,
  });
  assert.equal(updates.length, 70);
});

test('a large bounded pre-session burst does not block its session/new response', async (t) => {
  const { updates } = await setup(t, 'large-early-updates', {
    maxPendingUpdates: 128,
  });
  assert.equal(updates.length, 70);
  assert(
    updates.every(
      (update) => update.update.sessionUpdate === 'agent_message_chunk',
    ),
  );
});

test('a prompt deadline cancels the turn and keeps the connection usable', async (t) => {
  const { client, sessionId, closeCount } = await setup(t, 'full', {
    timeouts: { promptMs: 100, turnCancelMs: 250 },
  });
  await assert.rejects(prompt(client, sessionId, 'wait'), hasCode('timeout'));
  assert.equal(closeCount(), 0);
  await prompt(client, sessionId, 'stream');
  assert.equal(closeCount(), 0);
});

test('a prompt deadline closes the connection only when cancellation is ignored', async (t) => {
  const { client, sessionId, closeCount } = await setup(
    t,
    'ignore-turn-cancel',
    { timeouts: { promptMs: 100, cancelMs: 250, turnCancelMs: 250 } },
  );
  await assert.rejects(prompt(client, sessionId, 'wait'), hasCode('timeout'));
  assert.equal(closeCount(), 1);
});

test('a null prompt deadline lets a slow turn settle without any other request bound', async (t) => {
  // requestMs is shorter than the fake agent's slow turn, so a prompt that
  // fell back to the generic request deadline would time out here.
  const { client, sessionId, closeCount } = await setup(t, 'full', {
    timeouts: { promptMs: null, requestMs: 400 },
  });
  assert.equal(
    (await prompt(client, sessionId, 'slow')).stopReason,
    'end_turn',
  );
  assert.equal(closeCount(), 0);
});

test('a null prompt deadline still ends the turn on host cancellation', async (t) => {
  const started = deferred<void>();
  const { client, sessionId, closeCount } = await setup(t, 'full', {
    onUpdate: (): void => started.resolve(),
    timeouts: { promptMs: null },
  });
  const controller = new AbortController();
  const running = prompt(client, sessionId, 'wait', controller.signal);
  await started.promise;
  controller.abort();
  assert.equal((await running).stopReason, 'cancelled');
  assert.equal(closeCount(), 0);
});

test('a null prompt deadline still rejects a turn whose agent disconnects', async (t) => {
  const { client, sessionId, closeCount } = await setup(t, 'full', {
    timeouts: { promptMs: null },
  });
  await assert.rejects(
    prompt(client, sessionId, 'disconnect'),
    hasCode('closed'),
  );
  await client.closed;
  assert.equal(closeCount(), 1);
});

test('a null prompt deadline still closes a CLI that ignores host cancellation', async (t) => {
  const started = deferred<void>();
  const { client, sessionId, closeCount } = await setup(
    t,
    'ignore-turn-cancel',
    {
      onUpdate: (): void => started.resolve(),
      timeouts: { promptMs: null, cancelMs: 250, turnCancelMs: 250 },
    },
  );
  const controller = new AbortController();
  const running = prompt(client, sessionId, 'wait', controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(running, hasCode('timeout'));
  assert.equal(closeCount(), 1);
});

test('rejects a provider reusing an attached session ID', async (t) => {
  const { client, closeCount } = await setup(t, 'duplicate-session');
  await assert.rejects(
    client.newSession({ cwd: process.cwd(), mcpServers: [] }),
    hasCode('protocol'),
  );
  assert.equal(closeCount(), 1);
});

test('gates optional methods, content types, workspace roots, and MCP transports', async (t) => {
  const { client, sessionId } = await setup(t, 'normal');
  await assert.rejects(
    client.loadSession({
      sessionId: 'old',
      cwd: process.cwd(),
      mcpServers: [],
    }),
    hasCode('unsupported'),
  );
  await assert.rejects(
    client.resumeSession({
      sessionId: 'old',
      cwd: process.cwd(),
      mcpServers: [],
    }),
    hasCode('unsupported'),
  );
  await assert.rejects(client.listSessions(), hasCode('unsupported'));
  await assert.rejects(client.closeSession(sessionId), hasCode('unsupported'));
  await assert.rejects(
    client.prompt(
      {
        sessionId,
        prompt: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
      },
      1,
    ),
    hasCode('unsupported'),
  );
  await assert.rejects(
    client.newSession({
      cwd: process.cwd(),
      mcpServers: [
        {
          type: 'http',
          name: 'tools',
          url: 'https://example.invalid/mcp',
          headers: [],
        },
      ],
    }),
    hasCode('unsupported'),
  );
  await assert.rejects(
    client.newSession({
      cwd: process.cwd(),
      additionalDirectories: [process.cwd()],
      mcpServers: [],
    }),
    hasCode('unsupported'),
  );
  await prompt(client, sessionId, 'still usable');
});

test('authenticates only using an advertised method', async (t) => {
  const { client } = await setup(t);
  await assert.rejects(
    client.authenticate({ methodId: 'unknown' }),
    hasCode('unsupported'),
  );
  assert.deepEqual(await client.authenticate({ methodId: 'test' }), {});
});

test('sends the full MCP configuration and rejects relative workspace paths', async (t) => {
  const { client } = await setup(t);
  const params = {
    cwd: process.cwd(),
    mcpServers: [
      {
        name: 'tools',
        command: 'fake-tools',
        args: ['--test'],
        env: [{ name: 'TOKEN', value: 'test-only' }],
      },
    ],
  };
  const session = await client.newSession(params);
  assert.deepEqual(session._meta?.received, params);
  await assert.rejects(
    client.newSession({ cwd: './relative', mcpServers: [] }),
    hasCode('invalid-input'),
  );
  const resumed = await client.resumeSession({
    sessionId: 'saved',
    cwd: process.cwd(),
    mcpServers: [],
  });
  assert.deepEqual(resumed._meta?.received, {
    sessionId: 'saved',
    cwd: process.cwd(),
    mcpServers: [],
  });
});

test('load replays transcript updates and prevents prompts during attachment', async (t) => {
  const replay = deferred<void>();
  const { client } = await setup(t, 'slow-attach', {
    onUpdate: (): void => replay.resolve(),
  });
  const loading = client.loadSession({
    sessionId: 'saved',
    cwd: process.cwd(),
    mcpServers: [],
  });
  await replay.promise;
  await assert.rejects(prompt(client, 'saved', 'too early'), hasCode('busy'));
  await loading;
  await prompt(client, 'saved', 'ready');
  await assert.rejects(
    client.loadSession({
      sessionId: 'saved',
      cwd: process.cwd(),
      mcpServers: [],
    }),
    hasCode('busy'),
  );
});

test('close excludes new turns and detaches the session', async (t) => {
  const { client, sessionId } = await setup(t, 'slow-close');
  const closing = client.closeSession(sessionId);
  await assert.rejects(prompt(client, sessionId, 'too late'), hasCode('busy'));
  await closing;
  await assert.rejects(
    prompt(client, sessionId, 'detached'),
    hasCode('invalid-session'),
  );
  assert.equal((await client.listSessions()).nextCursor, 'page-2');
});

test('delete requires capability and removes only an attached idle session', async (t) => {
  const normal = await setup(t, 'normal');
  await assert.rejects(
    normal.client.deleteSession(normal.sessionId),
    hasCode('unsupported'),
  );
  const { client, sessionId } = await setup(t, 'slow-close');
  await assert.rejects(
    client.deleteSession('not-attached'),
    hasCode('invalid-session'),
  );
  const deleting = client.deleteSession(sessionId);
  await assert.rejects(prompt(client, sessionId, 'too late'), hasCode('busy'));
  await deleting;
  await assert.rejects(
    prompt(client, sessionId, 'deleted'),
    hasCode('invalid-session'),
  );
});

test('sends agent-specific requests verbatim and survives their errors', async (t) => {
  const { client } = await setup(t);
  assert.deepEqual(await client.extMethod('vendor/echo', { value: 1 }), {
    echoed: { value: 1 },
  });
  await assert.rejects(
    client.extMethod('vendor/missing', {}),
    hasCode('provider'),
  );
  assert.deepEqual(await client.extMethod('vendor/echo', {}), { echoed: {} });
  await assert.rejects(
    client.extMethod('session/new', {}),
    hasCode('invalid-input'),
  );
  await assert.rejects(
    client.extMethod('vendor/echo', {}, undefined, 0),
    hasCode('invalid-input'),
  );
  client.invalidate();
  await assert.rejects(
    client.extMethod('vendor/echo', {}),
    hasCode('stale-generation'),
  );
});

test('fails an unanswered agent-specific request at its own deadline', async (t) => {
  const { client, closeCount } = await setup(t);
  const started = Date.now();
  await assert.rejects(
    client.extMethod('vendor/hang', {}, undefined, 100),
    hasCode('timeout'),
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(closeCount(), 1);
});

test('allows concurrent sessions but rejects overlapping turns in one session', async (t) => {
  const started = deferred<void>();
  const { client, sessionId } = await setup(t, 'full', {
    onUpdate: (): void => started.resolve(),
  });
  const running = prompt(client, sessionId, 'wait');
  await started.promise;
  await assert.rejects(prompt(client, sessionId, 'overlap'), hasCode('busy'));
  const second = await client.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });
  await prompt(client, second.sessionId, 'parallel');
  await client.cancel(sessionId);
  assert.equal((await running).stopReason, 'cancelled');
  await prompt(client, sessionId, 'next turn');
});

test('a prompt AbortSignal sends whole-turn cancellation and settles without disconnecting', async (t) => {
  const started = deferred<void>();
  const { client, sessionId, closeCount } = await setup(t, 'full', {
    onUpdate: (): void => started.resolve(),
  });
  const controller = new AbortController();
  const running = prompt(client, sessionId, 'wait', controller.signal);
  await started.promise;
  controller.abort();
  assert.equal((await running).stopReason, 'cancelled');
  assert.equal(closeCount(), 0);
});

test('a noncooperative cancelled turn closes the connection within the grace period', async (t) => {
  const started = deferred<void>();
  const { client, sessionId, closeCount } = await setup(
    t,
    'ignore-turn-cancel',
    { onUpdate: (): void => started.resolve() },
  );
  const running = assert.rejects(
    prompt(client, sessionId, 'wait'),
    hasCode('timeout'),
  );
  await started.promise;
  await assert.rejects(client.cancel(sessionId), hasCode('timeout'));
  await running;
  assert.equal(closeCount(), 1);
});

test('RPC cancellation leaves an active session turn running', async (t) => {
  const listed = deferred<void>();
  const { client, sessionId, closeCount } = await setup(t, 'slow-list', {
    onUpdate: (event): void => {
      if (
        event.update.sessionUpdate === 'agent_message_chunk' &&
        event.update.content.type === 'text' &&
        event.update.content.text === 'list-pending'
      )
        listed.resolve();
    },
  });
  const running = prompt(client, sessionId, 'wait');
  const controller = new AbortController();
  const listing = assert.rejects(
    client.listSessions({}, controller.signal),
    hasCode('cancelled'),
  );
  await listed.promise;
  controller.abort();
  await listing;
  assert.equal(closeCount(), 0);
  await assert.rejects(
    prompt(client, sessionId, 'still active'),
    hasCode('busy'),
  );
  await client.cancel(sessionId);
  await running;
});

test('RPC cancellation closes a connection whose agent ignores cancellation', async (t) => {
  const listed = deferred<void>();
  const { client, sessionId, closeCount } = await setup(
    t,
    'ignore-rpc-cancel',
    {
      onUpdate: (event): void => {
        if (
          event.update.sessionUpdate === 'agent_message_chunk' &&
          event.update.content.type === 'text' &&
          event.update.content.text === 'list-pending'
        )
          listed.resolve();
      },
    },
  );
  const running = assert.rejects(
    prompt(client, sessionId, 'wait'),
    hasCode('cancelled'),
  );
  const controller = new AbortController();
  const listing = assert.rejects(
    client.listSessions({}, controller.signal),
    hasCode('cancelled'),
  );
  await listed.promise;
  controller.abort();
  await listing;
  await running;
  assert.equal(closeCount(), 1);
});

test('generation changes require recreation while allowing an existing turn to settle', async (t) => {
  const started = deferred<void>();
  const { client, sessionId } = await setup(t, 'full', {
    onUpdate: (): void => started.resolve(),
  });
  await assert.rejects(
    client.prompt({ sessionId, prompt: [] }, 2),
    hasCode('stale-generation'),
  );
  const running = prompt(client, sessionId, 'wait');
  await started.promise;
  client.invalidate();
  await client.cancel(sessionId);
  await running;
  await assert.rejects(
    prompt(client, sessionId, 'stale'),
    hasCode('stale-generation'),
  );
  await assert.rejects(
    client.newSession({ cwd: process.cwd(), mcpServers: [] }),
    hasCode('stale-generation'),
  );
});

test('snapshots connection identity against caller mutation', async (t) => {
  const agent = startAgent();
  t.after(() => agent.dispose());
  const client = await connectAcp(agent.options);
  t.after(() => client.close());
  agent.options.resourceGeneration = 2;
  agent.options.onUpdate = (): never => {
    throw new Error('mutated');
  };
  const { sessionId } = await client.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });
  await prompt(client, sessionId, 'original generation');
});

for (const decision of ['allow', 'deny']) {
  test(`permission ${decision} returns the matching one-shot option`, async (t) => {
    const { client, sessionId } = await setup(t, 'full', {
      onPermission: (request) => {
        assert.equal(request.resourceGeneration, 1);
        assert.equal(request.requestId, 'permission-1');
        return Promise.resolve(decision === 'allow' ? 'allow' : 'deny');
      },
    });
    const result = await prompt(client, sessionId, 'permission');
    assert.deepEqual(result._meta?.permissions, [
      {
        id: 'permission-1',
        outcome: {
          outcome: 'selected',
          optionId: `permission-1-${decision === 'allow' ? 'yes' : 'no'}`,
        },
      },
    ]);
  });
}

test('concurrent permission replies retain their request IDs when resolved in reverse order', async (t) => {
  const pending: Array<{
    request: AcpPermissionRequest;
    decision: ReturnType<typeof deferred<'allow' | 'deny'>>;
  }> = [];
  const both = deferred<void>();
  const secondReplied = deferred<void>();
  const { client, sessionId } = await setup(t, 'full', {
    onUpdate: (event): void => {
      if (
        event.update.sessionUpdate === 'agent_message_chunk' &&
        event.update.content.type === 'text' &&
        event.update.content.text === 'permission-replied:permission-2'
      )
        secondReplied.resolve();
    },
    onPermission: (request) => {
      const decision = deferred<'allow' | 'deny'>();
      pending.push({ request, decision });
      if (pending.length === 2) both.resolve();
      return decision.promise;
    },
  });
  const running = prompt(client, sessionId, 'two-permissions');
  await both.promise;
  pending[1]?.decision.resolve('deny');
  await secondReplied.promise;
  pending[0]?.decision.resolve('allow');
  const result = await running;
  assert.deepEqual(result._meta?.permissions, [
    {
      id: 'permission-2',
      outcome: { outcome: 'selected', optionId: 'permission-2-no' },
    },
    {
      id: 'permission-1',
      outcome: { outcome: 'selected', optionId: 'permission-1-yes' },
    },
  ]);
});

for (const profile of [
  'missing-handler',
  'throwing-handler',
  'hung-handler',
  'permanent-only',
]) {
  test(`fails closed on ${profile}`, async (t) => {
    const overrides: Partial<AcpClientOptions> = {};
    if (profile === 'throwing-handler')
      overrides.onPermission = (): Promise<'allow'> =>
        Promise.reject(new Error('SECRET'));
    if (profile === 'hung-handler')
      overrides.onPermission = (): Promise<'allow'> => new Promise(() => {});
    if (profile === 'permanent-only')
      overrides.onPermission = (): Promise<'allow'> => Promise.resolve('allow');
    const { client, sessionId } = await setup(t, 'full', overrides);
    const result = await prompt(
      client,
      sessionId,
      profile === 'permanent-only' ? profile : 'permission',
    );
    assert.deepEqual(result._meta?.permissions, [
      { id: 'permission-1', outcome: { outcome: 'cancelled' } },
    ]);
  });
}

test('turn cancellation aborts a pending permission and ignores a late allow', async (t) => {
  const received = deferred<AcpPermissionRequest>();
  const decision = deferred<'allow' | 'deny'>();
  const { client, sessionId } = await setup(t, 'full', {
    onPermission: (request) => {
      received.resolve(request);
      return decision.promise;
    },
  });
  const running = prompt(client, sessionId, 'permission');
  const request = await received.promise;
  await client.cancel(sessionId);
  assert.equal(request.signal.aborted, true);
  decision.resolve('allow');
  await running;
  await prompt(client, sessionId, 'next turn');
});

for (const instruction of [
  'malformed',
  'bad-envelope',
  'oversized',
  'oversized-line',
  'truncated',
]) {
  test(`rejects ${instruction} frames without leaking raw payloads`, async (t) => {
    const { client, sessionId, closeCount } = await setup(t, 'full', {
      maxMessageBytes: 2048,
    });
    await assert.rejects(
      prompt(client, sessionId, instruction),
      (error: unknown): boolean => {
        assert(error instanceof AcpClientError);
        assert.equal(error.code, 'protocol');
        assert(!error.message.includes('SECRET'));
        return true;
      },
    );
    assert.equal(closeCount(), 1);
  });
}

test('reassembles fragmented Unicode frames', async (t) => {
  const { client, sessionId, updates } = await setup(t);
  await prompt(client, sessionId, 'fragmented');
  assert.deepEqual(updates[0]?.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '🌳' },
  });
});

test('measures ACP source pressure while an asynchronous update sink is held', async (t) => {
  let releaseSink = (): void => undefined;
  const heldSink = new Promise<void>((resolve) => {
    releaseSink = resolve;
  });
  let received = 0;
  let receivedBytes = 0;
  let completed = 0;
  const completions: Promise<void>[] = [];
  const firstUpdate = deferred<void>();
  const { client, sessionId } = await setup(t, 'full', {
    onUpdate: (notification) => {
      if (notification.update.sessionUpdate !== 'agent_message_chunk')
        return undefined;
      received += 1;
      if (received === 1) firstUpdate.resolve(undefined);
      receivedBytes += Buffer.byteLength(JSON.stringify(notification));
      const completion = heldSink.then(() => {
        completed += 1;
      });
      completions.push(completion);
      return completion;
    },
  });
  const turn = prompt(client, sessionId, 'pressure');
  const outcome = turn.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  try {
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await Promise.race([
        firstUpdate.promise.then(() => 'started'),
        new Promise<'stalled'>((resolve) => {
          startTimer = setTimeout(() => resolve('stalled'), 3000);
        }),
      ]);
      assert.equal(first, 'started');
    } finally {
      if (startTimer) clearTimeout(startTimer);
    }
    let sampleTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        outcome.then(() => undefined),
        new Promise<void>((resolve) => {
          sampleTimer = setTimeout(resolve, 500);
        }),
      ]);
    } finally {
      if (sampleTimer) clearTimeout(sampleTimer);
    }
    assert.equal(completed, 0);
    const largestFrameBytes =
      Buffer.byteLength(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `127:${'x'.repeat(2048)}` },
            },
          },
        }),
      ) + 1;
    process.stdout.write(
      `ACP_PRESSURE_METRIC ${JSON.stringify({
        received,
        retainedBytesLowerBound: receivedBytes,
        completed,
        largestFrameBytes,
      })}\n`,
    );
    assert.ok(receivedBytes <= 64 * 1024 + largestFrameBytes);
  } finally {
    releaseSink();
    const result = await outcome;
    assert.equal(result.ok, true);
    await Promise.all(completions);
  }
  assert.equal(received, 128);
  assert.equal(completed, 128);
});

test('disposes ACP transport while an update sink never settles', async (t) => {
  const firstUpdate = deferred<void>();
  const { client, sessionId, closeCount } = await setup(t, 'full', {
    onUpdate: (notification) => {
      if (notification.update.sessionUpdate === 'agent_message_chunk') {
        firstUpdate.resolve(undefined);
        return new Promise<void>(() => undefined);
      }
    },
  });
  const running = prompt(client, sessionId, 'pressure');
  const outcome = running.then(
    () => 'completed',
    () => 'rejected',
  );
  await firstUpdate.promise;
  client.close();
  await client.closed;
  assert.equal(await outcome, 'rejected');
  assert.equal(closeCount(), 1);
});

test('waits for the same session update admission before reporting a prompt result', async (t) => {
  let releaseUpdate = (): void => undefined;
  const heldUpdate = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const firstUpdate = deferred<void>();
  const { client, sessionId } = await setup(t, 'full', {
    onUpdate: (notification) => {
      if (notification.update.sessionUpdate === 'agent_message_chunk') {
        firstUpdate.resolve(undefined);
        return heldUpdate;
      }
    },
  });
  const turn = prompt(client, sessionId, 'single-held-update');
  let settled = false;
  void turn.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await firstUpdate.promise;
    // The fake writes the prompt result immediately after the update. A later
    // list response on the same ordered stream proves that result passed the
    // transport before we inspect prompt settlement.
    assert.equal((await client.listSessions()).nextCursor, 'page-2');
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false);
    releaseUpdate();
    const result = await turn;
    assert.equal(result.stopReason, 'end_turn');
  } finally {
    releaseUpdate();
    client.close();
  }
});

test('cancels a prompt while its same-session update admission is held', async (t) => {
  const firstUpdate = deferred<void>();
  const { client, sessionId, closeCount } = await setup(t, 'full', {
    onUpdate: (notification) => {
      if (notification.update.sessionUpdate === 'agent_message_chunk') {
        firstUpdate.resolve(undefined);
        return new Promise<void>(() => undefined);
      }
    },
    timeouts: { promptMs: null },
  });
  const controller = new AbortController();
  const running = prompt(
    client,
    sessionId,
    'single-held-update',
    controller.signal,
  );
  try {
    await firstUpdate.promise;
    controller.abort();
    await assert.rejects(running, hasCode('cancelled'));
    assert.equal(closeCount(), 0);
  } finally {
    controller.abort();
    client.close();
  }
});

test('sanitizes remote errors while retaining a usable connection', async (t) => {
  const { client, sessionId } = await setup(t);
  await assert.rejects(
    prompt(client, sessionId, 'provider-error'),
    (error: unknown): boolean => {
      assert(error instanceof AcpClientError);
      assert.equal(error.code, 'provider');
      assert.equal(error.method, 'session/prompt');
      assert.equal(error.rpcCode, -32000);
      assert(!JSON.stringify(error).includes('SECRET'));
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  await prompt(client, sessionId, 'recovered');
});

test('peer disconnect rejects pending work and disposes once', async (t) => {
  const { client, sessionId, closeCount } = await setup(t);
  await assert.rejects(
    prompt(client, sessionId, 'disconnect'),
    hasCode('closed'),
  );
  await client.closed;
  client.close();
  client.close();
  assert.equal(closeCount(), 1);
});

test('preserves cleanup ownership when the host supplies a class-based transport', async (t) => {
  const agent = startAgent();
  t.after(() => agent.dispose());
  class HostTransport {
    readonly input = agent.options.transport.input;
    readonly output = agent.options.transport.output;
    closes = 0;
    close(): void {
      this.closes++;
      agent.options.transport.close();
    }
  }
  const transport = new HostTransport();
  const client = await connectAcp({ ...agent.options, transport });
  client.close();
  await client.closed;
  assert.equal(transport.closes, 1);
  assert.equal(agent.closeCount(), 1);
});

test('bounds a hung prompt and aborts outstanding permissions on disposal', async (t) => {
  const received = deferred<AcpPermissionRequest>();
  const { client, sessionId } = await setup(t, 'full', {
    timeouts: { promptMs: 100, permissionMs: 5000 },
    onPermission: (request) => {
      received.resolve(request);
      return new Promise(() => {});
    },
  });
  const running = assert.rejects(
    prompt(client, sessionId, 'permission'),
    hasCode('timeout'),
  );
  const request = await received.promise;
  await running;
  assert.equal(request.signal.aborted, true);
});

test('a host update callback failure terminates pending work with a safe error', async (t) => {
  const { client, sessionId } = await setup(t, 'full', {
    onUpdate: (): never => {
      throw new Error('SECRET');
    },
  });
  await assert.rejects(
    prompt(client, sessionId, 'stream'),
    hasCode('protocol'),
  );
});

test('applies session config through the SDK and rejects unattached sessions', async (t) => {
  const { client, sessionId } = await setup(t);
  await assert.rejects(
    client.setSessionConfigOption({
      sessionId: 'missing',
      configId: 'model',
      value: 'fixture',
    }),
    hasCode('invalid-session'),
  );
  const result = await client.setSessionConfigOption({
    sessionId,
    configId: 'model',
    value: 'fixture',
  });
  assert.equal(result.configOptions[0]?.currentValue, 'fixture');
});

test('serializes configuration with prompts and refuses stale profiles', async (t) => {
  const { client, sessionId } = await setup(t);
  const configuring = client.setSessionConfigOption({
    sessionId,
    configId: 'model',
    value: 'fixture',
  });
  await assert.rejects(prompt(client, sessionId, 'stream'), hasCode('busy'));
  await configuring;
  const running = prompt(client, sessionId, 'stream');
  await assert.rejects(
    client.setSessionConfigOption({
      sessionId,
      configId: 'model',
      value: 'fixture',
    }),
    hasCode('busy'),
  );
  await running;
  client.invalidate();
  await assert.rejects(
    client.setSessionConfigOption({
      sessionId,
      configId: 'model',
      value: 'fixture',
    }),
    hasCode('stale-generation'),
  );
});

test('rejects unknown update variants without leaking payloads or stalling credits', async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]): void => {
    errors.push(args);
  });
  const { client, sessionId, closeCount } = await setup(t, 'full', {
    timeouts: { promptMs: 1000 },
  });
  await assert.rejects(
    prompt(client, sessionId, 'unknown-update'),
    (error: unknown): boolean => {
      assert(error instanceof AcpClientError);
      assert.equal(error.code, 'protocol');
      assert.equal(error.message, 'Unsupported or invalid ACP session update');
      return true;
    },
  );
  assert.equal(closeCount(), 1);
  assert(!JSON.stringify(errors).includes('SECRET'));
});

test('native forks attach a distinct session and deliver only their bounded replay', async (t) => {
  const { client, sessionId, updates } = await setup(t);
  const params = { sessionId, cwd: process.cwd(), mcpServers: [] };
  const forked = await client.forkSession(params);
  assert.notEqual(forked.sessionId, sessionId);
  assert.deepEqual(forked._meta?.received, params);
  assert.deepEqual(
    updates.map((update) => update.sessionId),
    [forked.sessionId],
  );
  assert.equal(
    (await prompt(client, forked.sessionId, 'hello')).stopReason,
    'end_turn',
  );
  assert.equal(
    (await prompt(client, sessionId, 'hello')).stopReason,
    'end_turn',
  );
});

test('native forks refuse absent capabilities, unknown sources and stale profiles', async (t) => {
  const unsupported = await setup(t, 'normal');
  await assert.rejects(
    async () =>
      unsupported.client.forkSession({
        sessionId: unsupported.sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      }),
    hasCode('unsupported'),
  );
  const { client, sessionId } = await setup(t);
  await assert.rejects(
    async () =>
      client.forkSession({
        sessionId: 'foreign',
        cwd: process.cwd(),
        mcpServers: [],
      }),
    hasCode('invalid-session'),
  );
  client.invalidate();
  await assert.rejects(
    async () =>
      client.forkSession({ sessionId, cwd: process.cwd(), mcpServers: [] }),
    hasCode('stale-generation'),
  );
});

test('native forks reject a reused provider id and close the connection', async (t) => {
  const { client, sessionId, closeCount } = await setup(t, 'fork-duplicate');
  await assert.rejects(
    async () =>
      client.forkSession({ sessionId, cwd: process.cwd(), mcpServers: [] }),
    hasCode('protocol'),
  );
  assert.equal(closeCount(), 1);
});

test('native forks bound pre-response replay rather than stranding update credits', async (t) => {
  const { client, sessionId, closeCount } = await setup(t, 'fork-flood');
  await assert.rejects(
    async () =>
      client.forkSession({ sessionId, cwd: process.cwd(), mcpServers: [] }),
    hasCode('protocol'),
  );
  assert.equal(closeCount(), 1);
});

test('native forks block overlapping creation and source turns until they settle', async (t) => {
  const { client, sessionId } = await setup(t, 'fork-slow');
  const fork = client.forkSession({
    sessionId,
    cwd: process.cwd(),
    mcpServers: [],
  });
  await assert.rejects(
    client.newSession({ cwd: process.cwd(), mcpServers: [] }),
    hasCode('busy'),
  );
  await assert.rejects(
    async () =>
      client.forkSession({ sessionId, cwd: process.cwd(), mcpServers: [] }),
    hasCode('busy'),
  );
  await assert.rejects(prompt(client, sessionId, 'hello'), hasCode('busy'));
  const forked = await fork;
  assert.equal(
    (await prompt(client, forked.sessionId, 'hello')).stopReason,
    'end_turn',
  );
  assert.equal(
    (await prompt(client, sessionId, 'hello')).stopReason,
    'end_turn',
  );
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { openCodeApprovalPlugin } from '../approval-plugin';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
type Hook = (event: Record<string, unknown>) => Promise<void> | void;
interface PluginModule {
  default: {
    setup(context: Record<string, unknown>): Promise<() => Promise<void>>;
  };
}
function pluginModule(value: unknown): value is PluginModule {
  return (
    record(value) &&
    record(value.default) &&
    typeof value.default.setup === 'function'
  );
}

void test('v2 plugin gates native tool execution and exposes only authenticated metadata', async () => {
  let metadataUrl = '';
  let allowed = true;
  const requests: Record<string, unknown>[] = [];
  const host = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const raw of request) {
      const chunk: unknown = raw;
      assert.ok(chunk instanceof Uint8Array);
      chunks.push(Buffer.from(chunk));
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(record(payload));
    requests.push(payload);
    if (payload.kind === 'ready' && typeof payload.serverUrl === 'string')
      metadataUrl = payload.serverUrl;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        permission: allowed ? 'allow' : 'deny',
        ...(payload.kind === 'tool' && allowed
          ? { updated_input: { path: '/approved.txt', content: 'approved' } }
          : {}),
      }),
    );
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  const address = host.address();
  assert.ok(address && typeof address !== 'string');
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const source = openCodeApprovalPlugin(
      `http://127.0.0.1:${address.port}`,
      'hook-secret',
      {
        XDG_CONFIG_HOME: '/caller/config',
      },
    );
    const imported: unknown = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    );
    assert.ok(pluginModule(imported));
    const plugin = imported.default;
    const hooks = new Map<string, Hook>();
    const tools = [
      {
        id: 'write',
        name: 'write',
        input: { type: 'object' },
        description: 'Write',
      },
    ];
    const mcpConfig = { type: 'remote', codemode: true };
    cleanup = await plugin.setup({
      mcp: {
        transform: (callback: (editor: unknown) => void) =>
          callback({
            list: () => [['selected', mcpConfig]],
            update: (
              _name: string,
              update: (draft: typeof mcpConfig) => void,
            ) => update(mcpConfig),
          }),
      },
      location: { directory: '/workspace' },
      app: { version: '2.0.32' },
      tool: {
        hook: (name: string, callback: Hook) =>
          hooks.set(`tool.${name}`, callback),
        list: () => Promise.resolve(tools),
        transform: () => undefined,
      },
      shell: {
        hook: (name: string, callback: Hook) =>
          hooks.set(`shell.${name}`, callback),
      },
      agent: { transform: () => undefined },
      model: {
        list: () => Promise.resolve([{ id: 'model', providerID: 'fixture' }]),
      },
      session: {
        get: () => Promise.resolve({ id: 'session' }),
        context: () =>
          Promise.resolve([
            { id: 'message', type: 'system', text: 'retained' },
          ]),
      },
      provider: {
        list: () =>
          Promise.resolve({
            data: [
              {
                id: 'fixture',
                name: 'Fixture',
                headers: { authorization: 'secret-header' },
              },
              { id: 'local', name: 'Local' },
              {
                id: 'environment',
                name: 'Environment',
                integrationID: 'env-auth',
              },
            ],
          }),
      },
      integration: {
        list: () =>
          Promise.resolve({
            data: [
              {
                id: 'fixture',
                metadata: { token: 'secret-token' },
                connections: [
                  {
                    type: 'credential',
                    id: 'first',
                    label: 'Personal',
                    method: 'key',
                  },
                  {
                    type: 'credential',
                    id: 'second',
                    label: 'Work',
                    method: 'oauth',
                    status: {
                      status: 'needs_auth',
                      message: 'secret-error',
                      url: 'https://secret.invalid',
                    },
                  },
                ],
              },
              {
                id: 'env-auth',
                connections: [
                  {
                    type: 'env',
                    name: 'PROVIDER_API_KEY',
                    value: 'secret-env-value',
                  },
                ],
              },
            ],
          }),
        connection: {
          active: (id: string) =>
            Promise.resolve(
              id === 'env-auth'
                ? { type: 'env', name: 'PROVIDER_API_KEY' }
                : { type: 'credential', id: 'second' },
            ),
          resolve: () => {
            throw new Error('Credential resolution is forbidden');
          },
        },
      },
    });
    assert.equal(mcpConfig.codemode, false);
    assert.ok(metadataUrl);
    assert.equal((await fetch(new URL('/models', metadataUrl))).status, 401);
    assert.equal((await fetch(new URL('/accounts', metadataUrl))).status, 401);
    const headers = { Authorization: `Bearer hook-secret` };
    assert.equal(
      (
        await fetch(new URL('/accounts', metadataUrl), {
          headers,
          method: 'POST',
        })
      ).status,
      405,
    );
    const models = await fetch(new URL('/models', metadataUrl), { headers });
    assert.deepEqual(await models.json(), [
      { id: 'model', providerID: 'fixture' },
    ]);
    const accounts = await fetch(new URL('/accounts', metadataUrl), {
      headers,
    });
    assert.equal(accounts.status, 200);
    assert.deepEqual(await accounts.json(), {
      providers: [
        {
          id: 'fixture',
          name: 'Fixture',
          accounts: [
            {
              label: 'Personal',
              method: 'key',
              selected: false,
              needsSignIn: false,
            },
            {
              label: 'Work',
              method: 'oauth',
              selected: true,
              needsSignIn: true,
            },
          ],
        },
        { id: 'local', name: 'Local', accounts: [] },
        {
          id: 'environment',
          name: 'Environment',
          accounts: [
            {
              label: 'PROVIDER_API_KEY',
              method: 'env',
              selected: true,
              needsSignIn: false,
            },
          ],
        },
      ],
    });
    assert.equal(
      (await fetch(new URL('/unknown', metadataUrl), { headers })).status,
      404,
    );
    const contextResponse = await fetch(
      new URL('/sessions/session/context', metadataUrl),
      { headers },
    );
    assert.deepEqual(await contextResponse.json(), {
      data: [{ id: 'message', type: 'system', text: 'retained' }],
    });
    const event = {
      sessionID: 'session',
      id: 'call',
      tool: 'write',
      input: { path: '/original.txt', content: 'original' },
    };
    await hooks.get('tool.execute.before')?.(event);
    assert.deepEqual(requests.at(-1), {
      kind: 'tool',
      sessionId: 'session',
      toolCallId: 'call',
      toolName: 'write',
      toolArgs: { path: '/original.txt', content: 'original' },
    });
    assert.deepEqual(event.input, {
      path: '/approved.txt',
      content: 'approved',
    });
    allowed = false;
    const before = hooks.get('tool.execute.before');
    assert.ok(before);
    await assert.rejects(
      Promise.resolve().then(() => before(event)),
      /denied/,
    );
    const shell = {
      env: {
        XDG_CONFIG_HOME: '/private',
        XDG_CACHE_HOME: '/private',
        XDG_STATE_HOME: '/private',
      },
    };
    await hooks.get('shell.create.before')?.(shell);
    assert.deepEqual(shell.env, {
      XDG_CONFIG_HOME: '/caller/config',
      XDG_CACHE_HOME: undefined,
      XDG_STATE_HOME: undefined,
    });
  } finally {
    await cleanup?.();
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
  }
});

void test('fork mutations require a host scope and a fresh independent native fork', async () => {
  let metadataUrl = '';
  const host = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const raw of request) {
      const chunk: unknown = raw;
      assert.ok(chunk instanceof Uint8Array);
      chunks.push(Buffer.from(chunk));
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(record(payload));
    if (typeof payload.serverUrl === 'string') metadataUrl = payload.serverUrl;
    response.end(JSON.stringify({ permission: 'allow' }));
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  const address = host.address();
  assert.ok(address && typeof address !== 'string');
  let cleanup: (() => Promise<void>) | undefined;
  const mutations: unknown[] = [];
  const info = {
    id: 'fork',
    fork: { sessionID: 'source' },
    time: { created: 200 },
    location: { directory: '/source' },
  };
  try {
    for (const scoped of [false, true]) {
      const source = openCodeApprovalPlugin(
        `http://127.0.0.1:${address.port}`,
        'secret',
        {},
        scoped
          ? {
              sourceSessionId: 'source',
              sourceCwd: '/source',
              destinationCwd: '/destination',
              createdAfter: 100,
            }
          : undefined,
      );
      const imported: unknown = await import(
        `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
      );
      assert.ok(pluginModule(imported));
      cleanup = await imported.default.setup({
        shell: { hook: () => undefined },
        agent: { transform: () => undefined },
        mcp: { transform: () => undefined },
        tool: { hook: () => undefined },
        session: {
          get: () => Promise.resolve(info),
          move: (input: unknown) => {
            mutations.push(input);
            info.location.directory = '/destination';
            return Promise.resolve();
          },
          remove: (input: unknown) => {
            mutations.push(input);
            return Promise.resolve();
          },
        },
      });
      const send = (
        sessionId: string,
        operation = 'move',
        authorization = 'Bearer secret',
      ): Promise<Response> =>
        fetch(new URL('/fork', metadataUrl), {
          method: 'POST',
          headers: { authorization },
          body: JSON.stringify({ sessionId, operation }),
        });
      assert.equal((await send('fork', 'move', 'bad')).status, 401);
      assert.equal((await send('source')).status, scoped ? 403 : 405);
      assert.equal((await send('foreign')).status, scoped ? 403 : 405);
      info.time.created = 1;
      assert.equal((await send('fork')).status, scoped ? 403 : 405);
      info.time.created = 200;
      assert.equal(
        (await send('fork', 'arbitrary')).status,
        scoped ? 403 : 405,
      );
      assert.equal((await send('fork')).status, scoped ? 200 : 405);
      assert.equal((await send('fork', 'remove')).status, scoped ? 200 : 405);
      await cleanup();
      cleanup = undefined;
    }
    assert.deepEqual(mutations, [
      { sessionID: 'fork', directory: '/destination' },
      { sessionID: 'fork' },
    ]);
  } finally {
    await cleanup?.();
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
  }
});

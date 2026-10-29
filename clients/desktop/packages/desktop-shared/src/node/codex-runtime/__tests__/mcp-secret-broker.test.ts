import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { request as httpRequest } from 'node:http';
import { McpAvailabilityObserver } from '../mcp-availability-observer';
import {
  CodexMcpSecretBroker,
  type CodexStdioMcpLaunchRoute,
} from '../mcp-secret-broker';

jest.mock('../../../pipelines/config-paths', () => ({
  getEnhancedEnv: jest.fn(() => ({
    ...process.env,
    UNRELATED_MANAGED_SECRET: 'host-secret',
  })),
}));

class StartupControlledBroker extends CodexMcpSecretBroker {
  private releaseStartupPromise: () => void = () => undefined;
  private readonly startupPromise = new Promise<void>((resolve) => {
    this.releaseStartupPromise = resolve;
  });

  releaseStartup(): void {
    this.releaseStartupPromise();
  }

  protected override ensureStarted(): Promise<void> {
    return this.startupPromise;
  }
}

describe('CodexMcpSecretBroker', () => {
  let root: string;
  let broker: CodexMcpSecretBroker;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mcp-broker-'));
    broker = new CodexMcpSecretBroker(root, '/opt/canopy');
  });

  function readRouteAuth(route: CodexStdioMcpLaunchRoute): {
    launchToken: string;
  } {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(root, `${route.routeId}.auth.json`), 'utf8'),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('launchToken' in parsed) ||
      typeof parsed.launchToken !== 'string'
    )
      throw new Error('Invalid route authorization');
    return { launchToken: parsed.launchToken };
  }

  function locatorPort(route: CodexStdioMcpLaunchRoute): number {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(
        path.join(root, `${route.routeId.split('.')[0]}.json`),
        'utf8',
      ),
    );
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('port' in parsed) ||
      typeof parsed.port !== 'number'
    )
      throw new Error('Invalid broker locator');
    return parsed.port;
  }

  afterEach(async () => {
    await broker.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps secrets parent-owned while relaying the launched MCP process', async () => {
    const route = await broker.registerRoute({
      ownerId: 'chat-1',
      routeKey: 'github/default/v1',
      command: process.execPath,
      args: [
        '-e',
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(process.env.SENTINEL_SECRET ? 'configured' : 'missing'))",
      ],
      env: { SENTINEL_SECRET: 'sentinel-secret-value' },
    });
    const repeated = await broker.registerRoute({
      ownerId: 'chat-1',
      routeKey: 'github/default/v1',
      command: process.execPath,
      args: [
        '-e',
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(process.env.SENTINEL_SECRET ? 'configured' : 'missing'))",
      ],
      env: { SENTINEL_SECRET: 'sentinel-secret-value' },
    });

    expect(repeated).toEqual(route);
    expect(JSON.stringify(route)).not.toContain('sentinel-secret-value');
    const brokerId = route.routeId.split('.')[0];
    const locatorText = fs.readFileSync(
      path.join(root, `${brokerId}.json`),
      'utf8',
    );
    expect(locatorText).not.toContain('sentinel-secret-value');
    const locator: unknown = JSON.parse(locatorText);
    if (
      typeof locator !== 'object' ||
      locator === null ||
      !('port' in locator) ||
      typeof locator.port !== 'number'
    )
      throw new Error('Invalid broker locator');
    const routeAuth = readRouteAuth(route);
    const routeAuthPath = path.join(root, `${route.routeId}.auth.json`);
    expect(fs.readFileSync(routeAuthPath, 'utf8')).not.toContain(
      'sentinel-secret-value',
    );
    if (process.platform !== 'win32') {
      expect(fs.statSync(routeAuthPath).mode & 0o077).toBe(0);
    }
    expect(JSON.stringify(route)).not.toContain(routeAuth.launchToken);
    const descriptorResponse = await fetch(
      `http://127.0.0.1:${String(locator.port)}/descriptor/${route.routeId}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${routeAuth.launchToken}`,
          'content-type': 'application/octet-stream',
        },
        body: '',
      },
    );
    expect(descriptorResponse.status).toBe(404);

    const launchResponse = await fetch(
      `http://127.0.0.1:${String(locator.port)}/launch/${route.routeId}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${routeAuth.launchToken}`,
          'content-type': 'application/octet-stream',
        },
        body: '',
      },
    );
    await expect(launchResponse.text()).resolves.toBe('configured');
    expect(JSON.stringify(route)).not.toContain('sentinel-secret-value');
    expect(locatorText).not.toContain('sentinel-secret-value');
  });

  it.each([false, true])(
    'forwards observer-only large results with large request=%s without terminating the server',
    async (largeRequest) => {
      const pidFile = path.join(root, 'observed-child.pid');
      const publish = jest.fn();
      const largeText = '🦊'.repeat(600_000);
      const expected =
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: largeText } }) +
        '\n';
      const route = await broker.registerRoute(
        {
          ownerId: 'observed-chat',
          routeKey: 'large-result',
          command: process.execPath,
          args: [
            '-e',
            `
        require('node:fs').writeFileSync(process.argv[1], String(process.pid));
        require('node:readline').createInterface({input: process.stdin}).on('line', line => {
          const request = JSON.parse(line);
          process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result:{text:request.params.arguments.text || '🦊'.repeat(600_000)}})+'\\n');
        });
        setInterval(() => {}, 1000);
      `,
            pidFile,
          ],
        },
        { observeConnection: () => new McpAvailabilityObserver(publish) },
      );
      const request = httpRequest({
        hostname: '127.0.0.1',
        port: locatorPort(route),
        path: `/launch/${route.routeId}`,
        method: 'POST',
        headers: {
          authorization: `Bearer ${readRouteAuth(route).launchToken}`,
        },
      });
      const received = new Promise<Buffer>((resolve, reject) => {
        request.once('error', reject);
        request.once('response', (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.once('error', reject);
          response.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            bytes += chunk.length;
            if (bytes >= Buffer.byteLength(expected))
              resolve(Buffer.concat(chunks));
          });
          response.once('end', () => resolve(Buffer.concat(chunks)));
        });
      });
      request.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'echo',
            arguments: { text: largeRequest ? largeText : '' },
          },
        }) + '\n',
      );
      try {
        await expect(received).resolves.toEqual(Buffer.from(expected));
        const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
        expect(() => process.kill(childPid, 0)).not.toThrow();
      } finally {
        request.destroy();
      }
    },
  );

  it('uses a delegated route base environment without ambient managed secrets', async () => {
    const route = await broker.registerRoute({
      ownerId: 'delegated-child',
      routeKey: 'selected-server',
      command: process.execPath,
      args: [
        '-e',
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ managed: process.env.UNRELATED_MANAGED_SECRET ?? null, configured: process.env.SELECTED_SERVER_TOKEN ?? null })))",
      ],
      baseEnv: { PATH: process.env.PATH ?? '' },
      env: { SELECTED_SERVER_TOKEN: 'selected-token' },
    });
    const locatorText = fs.readFileSync(
      path.join(root, `${route.routeId.split('.')[0]}.json`),
      'utf8',
    );
    const locator: unknown = JSON.parse(locatorText);
    if (
      typeof locator !== 'object' ||
      locator === null ||
      !('port' in locator) ||
      typeof locator.port !== 'number'
    )
      throw new Error('Invalid broker locator');
    const auth = readRouteAuth(route);
    const response = await fetch(
      `http://127.0.0.1:${String(locator.port)}/launch/${route.routeId}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${auth.launchToken}`,
          'content-type': 'application/octet-stream',
        },
        body: '',
      },
    );
    await expect(response.json()).resolves.toEqual({
      managed: null,
      configured: 'selected-token',
    });
  });

  it('projects a launcher working directory without retaining route secrets', async () => {
    const cwdBroker = new CodexMcpSecretBroker(
      root,
      '/opt/canopy',
      ['launcher-prefix'],
      '/opt/canopy-runtime',
    );
    try {
      const route = await cwdBroker.registerRoute({
        ownerId: 'chat-cwd',
        routeKey: 'server/default/v1',
        command: process.execPath,
        env: { SENTINEL_SECRET: 'sentinel-secret-value' },
      });

      expect(route.command).toBe('/opt/canopy');
      expect(route.cwd).toBe('/opt/canopy-runtime');
      expect(route.args).toContain('launcher-prefix');
      expect(JSON.stringify(route)).not.toContain('sentinel-secret-value');
    } finally {
      await cwdBroker.shutdown();
    }
  });

  it('authorizes selected stdio tool calls before forwarding and leaves initialization available', async () => {
    const toolCallGate = jest.fn(
      (call: { toolName: string; arguments: unknown; signal: AbortSignal }) =>
        call.toolName === 'explode'
          ? Promise.reject(new Error('PRIVATE_GATE_DIAGNOSTIC'))
          : Promise.resolve(call.toolName === 'review'),
    );
    const options = { signal: new AbortController().signal, toolCallGate };
    const route = await broker.registerRoute(
      {
        ownerId: 'delegate',
        routeKey: 'selected-server',
        command: process.execPath,
        args: [
          '-e',
          "let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>{for(const line of text.trim().split('\\n')){if(!line)continue;const req=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{forwarded:req}})+'\\n');}})",
        ],
      },
      options,
    );
    const locator = { port: locatorPort(route) };
    const response = await fetch(
      `http://127.0.0.1:${String(locator.port)}/launch/${route.routeId}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${readRouteAuth(route).launchToken}`,
        },
        body:
          [
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
            {
              jsonrpc: '2.0',
              id: 2,
              method: 'tools/call',
              params: { name: 'review', arguments: { path: 'src' } },
            },
            {
              jsonrpc: '2.0',
              id: 3,
              method: 'tools/call',
              params: {
                name: 'delete',
                arguments: { secret: 'DENIED_PAYLOAD' },
              },
            },
            [
              {
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/call',
                params: {
                  name: 'review',
                  arguments: { secret: 'BATCH_PAYLOAD' },
                },
              },
            ],
            {
              jsonrpc: '2.0',
              id: 5,
              method: 'tools/call',
              params: { name: 'review', arguments: ['INVALID_ARGUMENTS'] },
            },
            {
              jsonrpc: '2.0',
              id: 6,
              method: 'tools/call',
              params: { name: 'explode', arguments: {} },
            },
          ]
            .map((value) => JSON.stringify(value))
            .join('\n') + '\n',
      },
    );
    const output = await response.text();
    expect(toolCallGate).toHaveBeenCalledTimes(3);
    const approvedCall = toolCallGate.mock.calls[0]?.[0];
    expect(approvedCall).toMatchObject({
      toolName: 'review',
      arguments: { path: 'src' },
    });
    expect(approvedCall?.signal).toBeInstanceOf(AbortSignal);
    expect(output).toContain('initialize');
    expect(output).toContain('review');
    expect(output).not.toContain('DENIED_PAYLOAD');
    expect(output).not.toContain('BATCH_PAYLOAD');
    expect(output).not.toContain('INVALID_ARGUMENTS');
    expect(output).not.toContain('PRIVATE_GATE_DIAGNOSTIC');
    const denied = output
      .split('\n')
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line))
      .find(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          'id' in value &&
          value.id === 3,
      );
    expect(denied).toMatchObject({ id: 3, error: { code: -32000 } });
  });

  it('rotates an otherwise identical route when its authorization gate changes', async () => {
    const request = {
      ownerId: 'delegate',
      routeKey: 'selected-server',
      command: process.execPath,
    };
    const firstOptions = {
      signal: new AbortController().signal,
      toolCallGate: (): Promise<boolean> => Promise.resolve(true),
    };
    const secondOptions = {
      signal: new AbortController().signal,
      toolCallGate: (): Promise<boolean> => Promise.resolve(false),
    };
    const first = await broker.registerRoute(request, firstOptions);
    expect(await broker.registerRoute(request, firstOptions)).toEqual(first);
    const second = await broker.registerRoute(request, secondOptions);
    expect(second.routeId).not.toBe(first.routeId);
    expect(fs.existsSync(path.join(root, `${first.routeId}.auth.json`))).toBe(
      false,
    );
  });

  it('keeps denial replies separate from fragmented upstream JSON responses', async () => {
    const route = await broker.registerRoute(
      {
        ownerId: 'fragmented-delegate',
        routeKey: 'selected-server',
        command: process.execPath,
        args: [
          '-e',
          'process.stdin.resume();process.stdout.write(\'{"jsonrpc":"2.0","id":1,"result":\');setTimeout(()=>process.stdout.write(\'{"text":"ok 🦊"}}\\n\'),30)',
        ],
      },
      { toolCallGate: () => Promise.resolve(false) },
    );
    const locator = { port: locatorPort(route) };
    const response = await fetch(
      `http://127.0.0.1:${String(locator.port)}/launch/${route.routeId}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${readRouteAuth(route).launchToken}`,
        },
        body:
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'denied', arguments: {} },
          }) + '\n',
      },
    );
    const replies: unknown[] = (await response.text())
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(replies).toHaveLength(2);
    expect(replies).toEqual(
      expect.arrayContaining([
        { jsonrpc: '2.0', id: 1, result: { text: 'ok 🦊' } },
        {
          jsonrpc: '2.0',
          id: 2,
          error: {
            code: -32000,
            message: 'The MCP tool call was not approved.',
          },
        },
      ]),
    );
  });

  it('aborts pending approval on revocation and never forwards a late approval', async () => {
    let enterGate: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enterGate = resolve;
    });
    let approve: (value: boolean) => void = () => undefined;
    const approval = new Promise<boolean>((resolve) => {
      approve = resolve;
    });
    let gateSignal: AbortSignal | undefined;
    const receipt = path.join(root, 'upstream-receipt');
    const options = {
      toolCallGate: (call: { signal: AbortSignal }): Promise<boolean> => {
        gateSignal = call.signal;
        enterGate();
        return approval;
      },
    };
    const route = await broker.registerRoute(
      {
        ownerId: 'pending-delegate',
        routeKey: 'selected-server',
        command: process.execPath,
        args: [
          '-e',
          "process.stdin.on('data',chunk=>require('node:fs').appendFileSync(process.argv[1],chunk));setInterval(()=>{},1000)",
          receipt,
        ],
      },
      options,
    );
    const locator = { port: locatorPort(route) };
    const response = fetch(
      `http://127.0.0.1:${String(locator.port)}/launch/${route.routeId}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${readRouteAuth(route).launchToken}`,
        },
        body:
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'review', arguments: {} },
          }) + '\n',
      },
    )
      .then((value) => value.text())
      .catch(() => 'closed');
    await entered;
    await broker.revokeOwner('pending-delegate');
    approve(true);
    await response;
    expect(gateSignal?.aborted).toBe(true);
    expect(fs.existsSync(receipt)).toBe(false);
  });

  it('does not expose launch descriptors even to an authenticated caller', async () => {
    const route = await broker.registerRoute({
      ownerId: 'chat-1',
      routeKey: 'server',
      command: process.execPath,
      env: { SENTINEL_SECRET: 'sentinel-secret-value' },
    });
    const locator = { port: locatorPort(route) };
    const routeAuth = readRouteAuth(route);

    const response = await fetch(
      `http://127.0.0.1:${String(locator.port)}/descriptor/${route.routeId}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${routeAuth.launchToken}`,
        },
      },
    );
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.not.toContain(
      'sentinel-secret-value',
    );
  });

  it('revokes future launches for an owner', async () => {
    const route = await broker.registerRoute({
      ownerId: 'chat-1',
      routeKey: 'server',
      command: '/usr/bin/server',
    });
    const locator = { port: locatorPort(route) };
    const routeAuth = readRouteAuth(route);
    await broker.revokeOwner('chat-1');
    expect(fs.existsSync(path.join(root, `${route.routeId}.auth.json`))).toBe(
      false,
    );

    const response = await fetch(
      `http://127.0.0.1:${String(locator.port)}/launch/${route.routeId}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${routeAuth.launchToken}`,
          'content-type': 'application/octet-stream',
        },
        body: '',
      },
    );
    expect(response.status).toBe(404);
  });

  it('does not commit a registration aborted while the broker starts', async () => {
    await broker.shutdown();
    const controlledBroker = new StartupControlledBroker(root, '/opt/canopy');
    broker = controlledBroker;
    const controller = new AbortController();
    const registration = broker.registerRoute(
      {
        ownerId: 'chat-aborted',
        routeKey: 'server',
        command: '/usr/bin/server',
      },
      { signal: controller.signal },
    );

    await Promise.resolve();
    controller.abort();
    controlledBroker.releaseStartup();

    await expect(registration).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      fs.readdirSync(root).some((entry) => entry.endsWith('.auth.json')),
    ).toBe(false);
  });

  it('does not commit a registration after its owner is revoked', async () => {
    await broker.shutdown();
    const controlledBroker = new StartupControlledBroker(root, '/opt/canopy');
    broker = controlledBroker;
    const registration = broker.registerRoute({
      ownerId: 'chat-revoked-during-startup',
      routeKey: 'server',
      command: '/usr/bin/server',
    });

    await Promise.resolve();
    await broker.revokeOwner('chat-revoked-during-startup');
    controlledBroker.releaseStartup();

    await expect(registration).rejects.toThrow('was revoked');
    expect(
      fs.readdirSync(root).some((entry) => entry.endsWith('.auth.json')),
    ).toBe(false);
  });

  it('rejects registrations that begin after owner revocation completes', async () => {
    await broker.revokeOwner('chat-already-revoked');

    await expect(
      broker.registerRoute({
        ownerId: 'chat-already-revoked',
        routeKey: 'server',
        command: '/usr/bin/server',
      }),
    ).rejects.toThrow('was revoked');
    expect(
      fs.readdirSync(root).some((entry) => entry.endsWith('.auth.json')),
    ).toBe(false);
  });

  it('awaits bounded escalation before completing active child revocation', async () => {
    const route = await broker.registerRoute({
      ownerId: 'chat-1',
      routeKey: 'stubborn-server',
      command: process.execPath,
      args: [
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)",
      ],
    });
    const locator = { port: locatorPort(route) };
    const routeAuth = readRouteAuth(route);
    const launchResponse = await fetch(
      `http://127.0.0.1:${String(locator.port)}/launch/${route.routeId}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${routeAuth.launchToken}`,
          'content-type': 'application/octet-stream',
        },
        body: '',
      },
    );
    const reader = launchResponse.body?.getReader();
    if (!reader) throw new Error('expected MCP launch response body');
    const firstChunk = await reader.read();
    const childPid = Number(new TextDecoder().decode(firstChunk.value));
    expect(Number.isSafeInteger(childPid)).toBe(true);

    await broker.revokeOwner('chat-1');

    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('includes source-launcher prefix arguments in the opaque route', async () => {
    const prefixedBroker = new CodexMcpSecretBroker(
      root,
      '/repo/node_modules/.bin/tsx',
      ['/repo/apps/desktop-cli/src/index.ts'],
    );
    await broker.shutdown();
    broker = prefixedBroker;

    const route = await broker.registerRoute({
      ownerId: 'chat-1',
      routeKey: 'server',
      command: '/usr/bin/server',
    });

    expect(route).toMatchObject({
      command: '/repo/node_modules/.bin/tsx',
      args: [
        '/repo/apps/desktop-cli/src/index.ts',
        '__codex-mcp-stdio-launcher',
        route.capabilityId,
        route.routeId,
      ],
    });
    const routeAuth = readRouteAuth(route);
    expect(routeAuth.launchToken).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(route)).not.toContain(routeAuth.launchToken);
  });

  it('rejects a different route credential even with a valid route id', async () => {
    const first = await broker.registerRoute({
      ownerId: 'chat-1',
      routeKey: 'first',
      command: process.execPath,
      args: ['-e', "process.stdout.write('first')"],
    });
    const second = await broker.registerRoute({
      ownerId: 'chat-2',
      routeKey: 'second',
      command: process.execPath,
      args: ['-e', "process.stdout.write('second')"],
    });
    const locator = { port: locatorPort(first) };
    const secondAuth = readRouteAuth(second);

    const response = await fetch(
      `http://127.0.0.1:${String(locator.port)}/launch/${first.routeId}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secondAuth.launchToken}`,
          'content-type': 'application/octet-stream',
        },
        body: '',
      },
    );

    expect(response.status).toBe(404);
  });

  it('keeps launch authorization out of the retained route and locator', async () => {
    const route = await broker.registerRoute({
      ownerId: 'chat-1',
      routeKey: 'server',
      command: '/usr/bin/server',
    });
    const brokerId = route.routeId.split('.')[0];
    const locatorText = fs.readFileSync(
      path.join(root, `${brokerId}.json`),
      'utf8',
    );
    const routeAuth = readRouteAuth(route);

    expect(route.args).toContain(route.routeId);
    expect(route.args).not.toContain(routeAuth.launchToken);
    expect(JSON.stringify(route)).not.toContain(routeAuth.launchToken);
    expect(locatorText).not.toContain(routeAuth.launchToken);
    expect(locatorText).not.toContain('"token"');
  });
});

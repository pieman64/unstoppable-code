import { build } from 'esbuild';
import { registerSecretsEnvInjector } from '@canopy/desktop-shared/pipelines/config-paths';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexMcpSecretBroker } from '@canopy/desktop-shared/node/codex-runtime/mcp-secret-broker';
import { getCodexMcpBrokerRuntimeDir } from '@canopy/desktop-shared/node/codex-runtime/mcp-runtime-dir';
import { snapshotOpenCodeMcpTools } from '../opencode/capability-snapshot';
import { readOpenCodeMcpSnapshot } from '@canopy/desktop-shared/node/opencode/mcp-snapshot';

const mockRuntime = {
  registerStdioMcpRoute: jest.fn<
    ReturnType<CodexMcpSecretBroker['registerRoute']>,
    Parameters<CodexMcpSecretBroker['registerRoute']>
  >(),
  revokeStdioMcpRoutes: jest.fn<
    ReturnType<CodexMcpSecretBroker['revokeOwner']>,
    Parameters<CodexMcpSecretBroker['revokeOwner']>
  >(),
};
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): typeof mockRuntime => mockRuntime,
}));

let root: string;
let launcher: string;
let server: string;
let broker: CodexMcpSecretBroker;
const originalTemp = {
  TMPDIR: process.env.TMPDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'opencode-discovery-temp-'));
  launcher = join(root, 'launcher.cjs');
  server = join(root, 'server.cjs');
  await build({
    stdin: {
      contents: `import { runCodexMcpStdioLauncher } from './packages/desktop-shared/src/node/codex-runtime/mcp-stdio-launcher'; runCodexMcpStdioLauncher().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });`,
      resolveDir: resolve(__dirname, '../../../../..'),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: launcher,
    logLevel: 'silent',
  });
  await writeFile(
    server,
    `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const input=JSON.parse(line); if (!('id' in input)) return;
 const result=input.method==='initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}} : {tools:[{name:'echo',description:process.env.PROBE_ENV ? JSON.stringify({managed:process.env.GH_TOKEN==='synthetic-managed-pat',selected:process.env.GH_TOKEN==='synthetic-selected-pat',configured:process.env.FIXTURE_VALUE,path:!!process.env.PATH,cwd:process.cwd()}) : process.env.FIXTURE_VALUE,inputSchema:{type:'object'}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:input.id,result})+'\\n');
});`,
  );
});
beforeEach(() => {
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  broker = new CodexMcpSecretBroker(
    getCodexMcpBrokerRuntimeDir(),
    process.execPath,
    [launcher],
  );
  mockRuntime.registerStdioMcpRoute.mockImplementation(
    broker.registerRoute.bind(broker),
  );
  mockRuntime.revokeStdioMcpRoutes.mockImplementation(
    broker.revokeOwner.bind(broker),
  );
});
afterEach(async () => {
  await broker.shutdown();
  registerSecretsEnvInjector(null);
  for (const key of ['TMPDIR', 'TMP', 'TEMP'] as const) {
    const value = originalTemp[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each([false, true])(
  'discovers through the authenticated broker with a non-default host temp directory (prebrokered=%s)',
  async (prebrokered) => {
    const selected = {
      name: 'fixture',
      command: process.execPath,
      args: [server],
      env: [
        { name: 'FIXTURE_VALUE', value: 'broker-owned-secret' },
        { name: 'TMPDIR', value: '/not-the-host-temp' },
      ],
    };
    const route = prebrokered
      ? await broker.registerRoute(
          {
            ownerId: 'test-delegation',
            routeKey: selected.name,
            cwd: root,
            command: selected.command,
            args: selected.args,
            env: Object.fromEntries(
              selected.env.map((entry) => [entry.name, entry.value]),
            ),
          },
          { toolCallGate: () => Promise.resolve(false) },
        )
      : undefined;
    const snapshot = await snapshotOpenCodeMcpTools(
      route
        ? [
            {
              name: selected.name,
              command: route.command,
              args: route.args,
              env: [],
            },
          ]
        : [selected],
      {},
      root,
      AbortSignal.timeout(3000),
      prebrokered,
    );
    expect(snapshot[0]?.tools[0]?.name).toBe('echo');
    expect(snapshot[0]?.tools[0]?.description).toBe('broker-owned-secret');
  },
);

it('control: the same broker authenticates when the launcher has the host temp directory', async () => {
  const selected = {
    name: 'fixture',
    command: process.execPath,
    args: [server],
    env: [],
  };
  const result = await readOpenCodeMcpSnapshot(
    [selected],
    {},
    AbortSignal.timeout(3000),
    async () => {
      const route = await broker.registerRoute(
        {
          ownerId: 'control',
          routeKey: 'fixture',
          cwd: root,
          command: selected.command,
          args: selected.args,
          env: { FIXTURE_VALUE: 'broker-owned-secret' },
        },
        { toolCallGate: () => Promise.resolve(false) },
      );
      return {
        name: 'fixture',
        command: route.command,
        args: route.args,
        env: ['TMPDIR', 'TMP', 'TEMP'].map((name) => ({
          name,
          value: tmpdir(),
        })),
      };
    },
  );
  expect(result[0]?.tools[0]?.description).toBe('broker-owned-secret');
});

it('aborting silent discovery stops the broker-owned server and its descendant', async () => {
  const hangingServer = join(root, 'hanging-server.cjs');
  const pidFile = join(root, 'discovery-pids.txt');
  await writeFile(
    hangingServer,
    `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[2], process.pid + ',' + descendant.pid);
process.stdin.resume();
setInterval(() => {}, 1000);
`,
  );
  const controller = new AbortController();
  const result = snapshotOpenCodeMcpTools(
    [
      {
        name: 'silent',
        command: process.execPath,
        args: [hangingServer, pidFile],
        env: [],
      },
    ],
    {},
    root,
    controller.signal,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    let pidText = '';
    const startedDeadline = Date.now() + 2_000;
    while (!pidText && Date.now() < startedDeadline) {
      pidText = await readFile(pidFile, 'utf8').catch(() => '');
      if (!pidText) await delay(10);
    }
    expect(pidText).not.toBe('');
    const pids = pidText.split(',').map(Number);
    expect(pids).toHaveLength(2);
    for (const pid of pids) {
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();
    }
    controller.abort(new Error('Discovery authority withdrawn'));
    expect(await result).toBeInstanceOf(Error);
    const owner =
      mockRuntime.registerStdioMcpRoute.mock.calls.at(-1)?.[0].ownerId;
    expect(owner).toEqual(expect.stringContaining('opencode-snapshot:'));
    expect(mockRuntime.revokeStdioMcpRoutes).toHaveBeenCalledWith(owner);
    for (const pid of pids) {
      const exitDeadline = Date.now() + 2_000;
      let exited = false;
      while (!exited && Date.now() < exitDeadline) {
        try {
          process.kill(pid, 0);
          await delay(10);
        } catch (error) {
          if (
            !(
              typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'ESRCH'
            )
          )
            throw error;
          exited = true;
        }
      }
      expect(exited).toBe(true);
    }
  } finally {
    controller.abort();
    await result;
  }
});

it.each([false, true])(
  'discovery excludes managed credentials and preserves selected credentials (explicit=%s)',
  async (explicit) => {
    registerSecretsEnvInjector(() => ({ GH_TOKEN: 'synthetic-managed-pat' }));
    const snapshot = await snapshotOpenCodeMcpTools(
      [
        {
          name: 'credential-fixture',
          command: process.execPath,
          args: [server],
          env: [
            { name: 'PROBE_ENV', value: '1' },
            { name: 'FIXTURE_VALUE', value: 'selected-server-value' },
            ...(explicit
              ? [{ name: 'GH_TOKEN', value: 'synthetic-selected-pat' }]
              : []),
          ],
        },
      ],
      {},
      root,
      AbortSignal.timeout(3000),
    );
    expect(JSON.parse(snapshot[0]?.tools[0]?.description ?? '{}')).toEqual({
      managed: false,
      selected: explicit,
      configured: 'selected-server-value',
      path: true,
      cwd: await realpath(root),
    });
  },
);

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  runCodexMcpStdioLauncher,
  type CodexMcpLauncherIo,
} from '@canopy/core-platform/codex-mcp-launcher';
import { CodexMcpSecretBroker } from '../mcp-secret-broker';

let runtimeDir = '';
let workDir = '';
let broker: CodexMcpSecretBroker | null = null;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(tmpdir(), 'mcp-launcher-relay-'));
  runtimeDir = path.join(workDir, 'runtime');
  broker = new CodexMcpSecretBroker(runtimeDir, 'unused-launcher', []);
});

afterEach(async () => {
  await broker?.shutdown();
  broker = null;
  await fs.rm(workDir, { recursive: true, force: true });
});

async function launchOnce(
  capabilityId: string,
  routeId: string,
  input: string,
): Promise<{ code: number; output: string }> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const io: CodexMcpLauncherIo = {
    stdin,
    stdout,
    onceSignal: () => undefined,
    isAlive: () => true,
    runtimeDir,
  };
  const relay = runCodexMcpStdioLauncher({ capabilityId, routeId }, io);
  stdin.end(input);
  const code = await relay;
  return { code, output: Buffer.concat(chunks).toString('utf8') };
}

// The launcher reaches the broker's launch route, /^\/launch\/([a-f0-9]{32}\.[a-f0-9]{48})$/.
it('a launcher exit leaves the broker serving the next launch', async () => {
  if (!broker) throw new Error('broker missing');
  const route = await broker.registerRoute({
    ownerId: 'owner-1',
    routeKey: 'echo',
    command: process.execPath,
    args: ['-e', 'process.stdin.pipe(process.stdout)'],
    cwd: workDir,
    baseEnv: {},
    env: {},
  });

  await expect(
    launchOnce(route.capabilityId, route.routeId, 'one\n'),
  ).resolves.toEqual({ code: 0, output: 'one\n' });
  await expect(
    launchOnce(route.capabilityId, route.routeId, 'two\n'),
  ).resolves.toEqual({ code: 0, output: 'two\n' });

  await expect(
    broker.registerRoute({
      ownerId: 'owner-2',
      routeKey: 'echo',
      command: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd: workDir,
      baseEnv: {},
      env: {},
    }),
  ).resolves.toMatchObject({ command: 'unused-launcher' });
});

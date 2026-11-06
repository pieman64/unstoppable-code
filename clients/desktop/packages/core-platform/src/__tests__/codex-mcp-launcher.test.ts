import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  CodexMcpLauncherError,
  runCodexMcpStdioLauncher,
  type CodexMcpLauncherIo,
} from '../codex-mcp-launcher';

const posixIt = process.platform === 'win32' ? it.skip : it;

interface BrokerSeen {
  readonly url: string | undefined;
  readonly authorization: string | undefined;
}

let runtimeDir = '';
let server: Server | null = null;
let seen: BrokerSeen[] = [];

const brokerId = randomBytes(16).toString('hex');
const routeId = `${brokerId}.${randomBytes(24).toString('hex')}`;
const capabilityId = randomBytes(32).toString('hex');
const launchToken = randomBytes(32).toString('hex');

async function startEchoBroker(): Promise<number> {
  seen = [];
  server = createServer((request: IncomingMessage, response) => {
    seen.push({
      url: request.url,
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    request.pipe(response);
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

async function writeRendezvous(
  port: number,
  options: { ticketMode?: number; locatorParentPid?: number } = {},
): Promise<void> {
  await fs.writeFile(
    path.join(runtimeDir, `${brokerId}.json`),
    JSON.stringify({
      version: 3,
      port,
      parentPid: options.locatorParentPid ?? process.pid,
    }),
    { mode: 0o600 },
  );
  const ticketPath = path.join(runtimeDir, `${routeId}.auth.json`);
  await fs.writeFile(
    ticketPath,
    JSON.stringify({
      version: 1,
      routeId,
      capabilityId,
      launchToken,
      parentPid: process.pid,
    }),
    { mode: 0o600 },
  );
  if (options.ticketMode !== undefined) {
    await fs.chmod(ticketPath, options.ticketMode);
  }
}

function launcherIo(
  overrides: Partial<CodexMcpLauncherIo> = {},
): CodexMcpLauncherIo & { stdin: PassThrough; stdout: PassThrough } {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    onceSignal: () => undefined,
    isAlive: () => true,
    runtimeDir,
    ...overrides,
  } as CodexMcpLauncherIo & { stdin: PassThrough; stdout: PassThrough };
}

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(tmpdir(), 'codex-mcp-launcher-'));
  await fs.chmod(runtimeDir, 0o700);
});

afterEach(async () => {
  const closing = server;
  server = null;
  if (closing) {
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

it('relays a registered route byte for byte', async () => {
  await writeRendezvous(await startEchoBroker());
  const io = launcherIo();
  const chunks: Buffer[] = [];
  io.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

  const relay = runCodexMcpStdioLauncher({ capabilityId, routeId }, io);
  io.stdin.end('ping\n');

  await expect(relay).resolves.toBe(0);
  expect(Buffer.concat(chunks).toString('utf8')).toBe('ping\n');
  expect(seen).toEqual([
    { url: `/launch/${routeId}`, authorization: `Bearer ${launchToken}` },
  ]);
});

posixIt('refuses a ticket others can read', async () => {
  await writeRendezvous(await startEchoBroker(), { ticketMode: 0o644 });

  const relay = runCodexMcpStdioLauncher(
    { capabilityId, routeId },
    launcherIo(),
  );

  await expect(relay).rejects.toBeInstanceOf(CodexMcpLauncherError);
  await expect(relay).rejects.toThrow(
    'MCP broker runtime file permissions are too broad',
  );
  expect(seen).toEqual([]);
});

it('refuses a locator whose parent differs from the ticket', async () => {
  await writeRendezvous(await startEchoBroker(), {
    locatorParentPid: process.pid + 1,
  });

  await expect(
    runCodexMcpStdioLauncher({ capabilityId, routeId }, launcherIo()),
  ).rejects.toThrow(new CodexMcpLauncherError('MCP broker identity mismatch'));
  expect(seen).toEqual([]);
});

it('refuses a dead broker parent', async () => {
  await writeRendezvous(await startEchoBroker());

  await expect(
    runCodexMcpStdioLauncher(
      { capabilityId, routeId },
      launcherIo({ isAlive: () => false }),
    ),
  ).rejects.toThrow(
    new CodexMcpLauncherError('MCP broker parent is no longer running'),
  );
  expect(seen).toEqual([]);
});

it('missing ids refuse before any file is read', async () => {
  const missingDir = path.join(runtimeDir, 'absent');

  await expect(
    runCodexMcpStdioLauncher(
      { capabilityId, routeId: '' },
      launcherIo({ runtimeDir: missingDir }),
    ),
  ).rejects.toThrow(
    new CodexMcpLauncherError('MCP launcher credentials are unavailable'),
  );
  await expect(fs.stat(missingDir)).rejects.toMatchObject({ code: 'ENOENT' });
});

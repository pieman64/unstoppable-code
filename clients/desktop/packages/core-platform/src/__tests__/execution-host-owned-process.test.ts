import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { createExecutionProcessServices } from '../index';
import type {
  PlatformExecutionProcessServices,
  PlatformOperatingSystem,
} from '@canopy/core-runtime';
import {
  EXECUTION_HOST_CHANNEL_ENV,
  EXECUTION_HOST_STDIO_CHANNEL,
  encodeExecutionHostFrame,
} from '../execution-host/channel';
import { createOwnedProcessHostPort } from '../execution-host/owned-process-host';
import type {
  ExecutionHostPort,
  ExecutionHostProcess,
} from '../execution-host/port';

// Real hosts on the host OS under plain Node: the fixture is bundled with the
// production channel and launched over the owned-process primitive. darwin
// and linux need nothing native; win32 needs the prebuilt owned-child addon
// (CANOPY_OWNED_CHILD_ADDON), which the PlatformServices job provides and,
// with CANOPY_OWNED_CHILD_ACCEPTANCE=1, requires.

const os = ((): PlatformOperatingSystem => {
  const platform: string = process.platform;
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32')
    return platform;
  throw new Error(`unsupported test host ${platform}`);
})();
const ROOT = path.resolve(__dirname, '../../../..');
const addon = process.env.CANOPY_OWNED_CHILD_ADDON
  ? path.resolve(ROOT, process.env.CANOPY_OWNED_CHILD_ADDON)
  : undefined;
const available = os !== 'win32' || (addon !== undefined && existsSync(addon));
if (!available && process.env.CANOPY_OWNED_CHILD_ACCEPTANCE === '1')
  throw new Error('Owned-child acceptance requires CANOPY_OWNED_CHILD_ADDON');
const ENTRY = 'channel-host.js';

// Real children under a loaded CI host can outlast the 5 s default.
jest.setTimeout(30_000);

let dir = '';
let services: PlatformExecutionProcessServices;
let port: ExecutionHostPort;
let diagnostics: string[];
const strays = new Set<number>();

function present(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return field(error, 'code') === 'EPERM';
  }
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Reflect.get(value, key)
    : undefined;
}

/** Every event the host reports, in order. */
function record(host: ExecutionHostProcess): {
  events: string[];
  messages: unknown[];
  exit: Promise<number>;
  next: (type: string) => Promise<unknown>;
} {
  const events: string[] = [];
  const messages: unknown[] = [];
  const waiters: { type: string; resolve: (message: unknown) => void }[] = [];
  host.on('spawn', () => events.push('spawn'));
  host.on('message', (message) => {
    events.push('message');
    messages.push(message);
    for (const waiter of waiters.splice(0))
      if (field(message, 'type') === waiter.type) waiter.resolve(message);
      else waiters.push(waiter);
  });
  const exit = new Promise<number>((resolve) => {
    host.on('exit', (code) => {
      events.push('exit');
      resolve(code);
    });
  });
  return {
    events,
    messages,
    exit,
    next: (type) =>
      new Promise((resolve) => {
        const seen = messages.find(
          (message) => field(message, 'type') === type,
        );
        if (seen !== undefined) resolve(seen);
        else waiters.push({ type, resolve });
      }),
  };
}

function launch(): ExecutionHostProcess {
  return port.launch({ entry: ENTRY, serviceName: 'test-host' });
}

const describeHosts = available ? describe : describe.skip;

beforeAll(() => {
  dir = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'execution-host-')),
  );
  buildSync({
    entryPoints: [
      path.join(__dirname, 'fixtures', 'execution-host-channel-host.ts'),
    ],
    outfile: path.join(dir, ENTRY),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
});

beforeEach(() => {
  diagnostics = [];
  services = createExecutionProcessServices({ os, nativePath: addon });
  port = createOwnedProcessHostPort({
    services,
    nodeExecutable: process.execPath,
    entryDirectory: dir,
    cwd: dir,
    environment: () => process.env,
    diagnostics: (stream, bytes) =>
      diagnostics.push(`${stream}:${Buffer.from(bytes).toString('utf8')}`),
  });
});

afterEach(async () => {
  if (available) await services.shutdown();
  for (const pid of Array.from(strays)) {
    if (present(pid)) process.kill(pid, 'SIGKILL');
  }
  strays.clear();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describeHosts('owned-process execution hosts', () => {
  it('reports spawn once, delivers messages posted before it, and exits after the last message', async () => {
    const host = launch();
    const seen = record(host);
    expect(host.pid).toBeUndefined();
    host.postMessage({ type: 'echo', value: 'before spawn' });
    expect(await seen.next('echo')).toEqual({
      type: 'echo',
      value: 'before spawn',
    });
    expect(host.pid).toEqual(expect.any(Number));
    host.postMessage({ type: 'exit', code: 3 });
    expect(await seen.exit).toBe(3);
    expect(seen.events).toEqual(['spawn', 'message', 'exit']);
    expect(diagnostics).toContain('stdout:not a frame\n');
    expect(() => host.postMessage({ type: 'echo' })).toThrow();
    expect(host.kill()).toBe(false);
  });

  it('keeps the structured-clone shapes a utility process gives messages', async () => {
    const host = launch();
    const seen = record(host);
    host.postMessage({ type: 'structured' });
    await until(() => seen.messages.length === 1);
    const message = seen.messages[0];
    expect(field(message, 'map')).toEqual(new Map([['a', 1]]));
    expect(field(message, 'date')).toEqual(new Date(0));
    const bytes = field(message, 'bytes');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(
      Buffer.from(bytes instanceof Uint8Array ? bytes : []).toJSON().data,
    ).toEqual([0, 255]);
    expect(field(message, 'big')).toBe(BigInt(10));
    expect(message).toHaveProperty('missing', undefined);
    expect(host.kill()).toBe(true);
    await seen.exit;
  });

  it('never drops the terminal outcome under output pressure', async () => {
    const host = launch();
    const seen = record(host);
    // 4 MiB through a 256 KiB credit window: the host blocks on its pipe.
    host.postMessage({ type: 'burst', count: 64, size: 64 * 1024 });
    expect(await seen.exit).toBe(0);
    const chunks = seen.messages.filter(
      (message) => field(message, 'type') === 'chunk',
    );
    expect(chunks.map((chunk) => field(chunk, 'index'))).toEqual(
      Array.from({ length: 64 }, (_, index) => index),
    );
    expect(seen.messages.at(-1)).toEqual({ type: 'done' });
    expect(seen.events.at(-1)).toBe('exit');
    expect(seen.events.filter((event) => event === 'exit')).toHaveLength(1);
  });

  it('reports a crash once and refuses messages after it', async () => {
    const host = launch();
    const seen = record(host);
    host.postMessage({ type: 'echo', value: 1 });
    await seen.next('echo');
    host.postMessage({ type: 'crash' });
    const code = await seen.exit;
    if (os === 'win32') expect(code).not.toBe(0);
    else expect(code).toBe(137);
    expect(seen.events.filter((event) => event === 'exit')).toHaveLength(1);
    expect(() => host.postMessage({ type: 'echo' })).toThrow();
  });

  it('stops the whole owned tree when killed', async () => {
    const host = launch();
    const seen = record(host);
    host.postMessage({ type: 'grandchild' });
    const pid = Number(field(await seen.next('grandchild'), 'pid'));
    strays.add(pid);
    expect(present(pid)).toBe(true);
    expect(host.kill()).toBe(true);
    await seen.exit;
    await until(() => !present(pid));
    expect(seen.events.filter((event) => event === 'exit')).toHaveLength(1);
  });

  it('refuses a kill before the host starts, as a utility process does', async () => {
    const host = launch();
    const seen = record(host);
    expect(host.kill()).toBe(false);
    host.once('spawn', () => {
      expect(host.kill()).toBe(true);
    });
    await seen.exit;
    expect(seen.events).toEqual(['spawn', 'exit']);
  });

  it('stops every host tree on shutdown', async () => {
    const host = launch();
    const seen = record(host);
    host.postMessage({ type: 'grandchild' });
    const pid = Number(field(await seen.next('grandchild'), 'pid'));
    strays.add(pid);
    await services.shutdown();
    await seen.exit;
    expect(present(pid)).toBe(false);
  });

  it('reports exit without spawn for a host that never started', async () => {
    const unstartable = createOwnedProcessHostPort({
      services,
      nodeExecutable: 'node',
      entryDirectory: dir,
      cwd: dir,
      environment: () => process.env,
    });
    const host = unstartable.launch({ entry: ENTRY, serviceName: 'test-host' });
    const seen = record(host);
    expect(await seen.exit).toBe(1);
    expect(seen.events).toEqual(['exit']);
  });

  it('launches bundled entries only', () => {
    expect(() =>
      port.launch({ entry: '../channel-host.js', serviceName: 'test-host' }),
    ).toThrow('Unknown execution host entry.');
  });

  it('exits when its launcher goes away', async () => {
    const child = spawn(process.execPath, [path.join(dir, ENTRY)], {
      env: {
        ...process.env,
        [EXECUTION_HOST_CHANNEL_ENV]: EXECUTION_HOST_STDIO_CHANNEL,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const output: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    const closed = new Promise<number | null>((resolve) =>
      child.once('close', resolve),
    );
    child.stdin.write(encodeExecutionHostFrame({ type: 'echo', value: 'x' }));
    await until(() => Buffer.concat(output).includes('canopy-host:'));
    child.stdin.end();
    expect(await closed).toBe(0);
  });
});

describeHosts('execution probes', () => {
  const node = (script: string): Parameters<ExecutionHostPort['probe']>[0] => ({
    executable: process.execPath,
    args: ['-e', script],
    // This is the complete child environment, not an overlay. The primitive
    // deliberately blanks omitted Windows runtime keys to prevent inheritance.
    // Match the narrow Node environment in supervision-execution-process.test.ts;
    // keep temporary files inside this fixture instead of inheriting host state.
    environment:
      os === 'win32'
        ? {
            SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '',
            TEMP: dir,
            TMP: dir,
          }
        : { PATH: process.env.PATH ?? '' },
    timeoutMs: 10_000,
    maxOutputBytes: 1024,
  });

  it('returns stdout of a clean exit', async () => {
    await expect(
      port.probe(node('process.stdout.write("one\\ntwo")')),
    ).resolves.toEqual({ ok: true, stdout: 'one\ntwo' });
  });

  it('fails a non-zero exit', async () => {
    await expect(port.probe(node('process.exit(2)'))).resolves.toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  it('uses only the probe environment, without inheriting host variables', async () => {
    const hostEnvironment = jest.replaceProperty(process, 'env', {
      ...process.env,
      CANOPY_EXECUTION_PROBE_HOST_ONLY: 'host-only',
    });
    try {
      const request = node(
        'process.stdout.write(JSON.stringify([process.env.CANOPY_EXECUTION_PROBE_HOST_ONLY ?? null, process.env.CANOPY_EXECUTION_PROBE_REQUEST_ONLY]))',
      );
      await expect(
        port.probe({
          ...request,
          environment: {
            ...request.environment,
            CANOPY_EXECUTION_PROBE_REQUEST_ONLY: 'request-only',
          },
        }),
      ).resolves.toEqual({ ok: true, stdout: '[null,"request-only"]' });
    } finally {
      hostEnvironment.restore();
    }
  });

  it('stops the whole probe tree on timeout', async () => {
    const pidFile = path.join(dir, `probe-${Date.now()}.pid`);
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)'], { stdio: 'ignore', detached: process.platform === 'win32' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => undefined, 1 << 30);
    `;
    const result = port.probe({ ...node(script), timeoutMs: 1_500 });
    await until(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    strays.add(pid);
    await expect(result).resolves.toEqual({ ok: false, reason: 'timeout' });
    await until(() => !present(pid));
  });

  it('stops a probe whose output exceeds its bound', async () => {
    await expect(
      port.probe(
        node(
          'process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1e9)',
        ),
      ),
    ).resolves.toEqual({ ok: false, reason: 'too-large' });
  });

  it('does not start an executable that is not fully qualified', async () => {
    await expect(
      port.probe({ ...node(''), executable: 'node' }),
    ).resolves.toEqual({ ok: false, reason: 'not-started' });
  });
});

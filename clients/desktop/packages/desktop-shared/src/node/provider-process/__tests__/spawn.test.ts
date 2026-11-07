import type * as ChildProcessModule from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  spawnProviderProcessDirect,
  type ProviderProcess,
  type ProviderProcessError,
  type ProviderProcessOwner,
  type ProviderProcessRequest,
} from '../spawn';

/** Lets a malformed owner through the type system, as an untyped caller would. */
function untypedOwner(value: object): value is ProviderProcessOwner {
  return typeof value === 'object';
}

// Real children under plain Node. Group kills are POSIX-only; Windows keeps
// the forced tree kill, which the port's own suite covers.
const itPosix = process.platform === 'win32' ? it.skip : it;

let dir = '';
const strays = new Set<number>();

function present(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
  }
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function request(
  args: string[],
  overrides: Partial<ProviderProcessRequest> = {},
): ProviderProcessRequest {
  return {
    command: process.execPath,
    args,
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    owner: { kind: 'turn', id: 'spawn-test' },
    ...overrides,
  };
}

interface Observed {
  errors: ProviderProcessError[];
  closes: [number | null, NodeJS.Signals | null][];
  closed: Promise<void>;
  stdout: Promise<Buffer>;
}

function observe(child: ProviderProcess): Observed {
  const errors: ProviderProcessError[] = [];
  const closes: [number | null, NodeJS.Signals | null][] = [];
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const stdout = new Promise<Buffer>((resolve) => {
    child.stdout.once('end', () => resolve(Buffer.concat(chunks)));
  });
  child.once('error', (error) => errors.push(error));
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      closes.push([code, signal]);
      resolve();
    });
  });
  return { errors, closes, closed, stdout };
}

/** Resolves with the first stdout line. */
function firstLine(child: ProviderProcess): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8');
      const end = text.indexOf('\n');
      if (end < 0) return;
      child.stdout.off('data', onData);
      resolve(text.slice(0, end));
    };
    child.stdout.on('data', onData);
  });
}

beforeAll(() => {
  dir = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'provider-spawn-')),
  );
});

afterEach(() => {
  for (const pid of Array.from(strays))
    if (present(pid)) process.kill(pid, 'SIGKILL');
  strays.clear();
  jest.restoreAllMocks();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('spawnProviderProcessDirect', () => {
  it('streams stdout and reports close with code and signal', async () => {
    const child = spawnProviderProcessDirect(
      request([
        '-e',
        `const bytes = Buffer.alloc(100 * 1024);
         for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
         process.stdout.write(bytes, () => { process.exitCode = 3; });`,
      ]),
    );
    const observed = observe(child);
    expect(Number.isInteger(child.pid)).toBe(true);
    expect(child.pid).toBeGreaterThan(0);
    const bytes = await observed.stdout;
    await observed.closed;
    expect(bytes.length).toBe(100 * 1024);
    for (let i = 0; i < bytes.length; i++)
      if (bytes[i] !== i % 251) throw new Error(`byte ${i} out of order`);
    expect(observed.closes).toEqual([[3, null]]);
    expect(observed.errors).toEqual([]);
  });

  it('a missing executable reports one error then close(null, null)', async () => {
    const child = spawnProviderProcessDirect(
      request([], { command: path.join(dir, 'missing') }),
    );
    const observed = observe(child);
    await observed.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(observed.errors.map((error) => error.code)).toEqual(['ENOENT']);
    expect(observed.closes).toEqual([[null, null]]);
    expect(child.pid).toBeUndefined();
  });

  it('an invalid owner spawns nothing', async () => {
    await jest.isolateModulesAsync(async (): Promise<void> => {
      const childProcess =
        jest.requireActual<typeof ChildProcessModule>('node:child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn');
      const { spawnProviderProcessDirect: isolatedSpawn } =
        await import('../spawn');
      const owners: object[] = [
        { kind: 'turn', id: '' },
        { kind: 'other', id: 'x' },
      ];
      for (const owner of owners) {
        // Owners arrive from callers the compiler cannot see.
        if (!untypedOwner(owner)) throw new Error('unreachable');
        const child = isolatedSpawn({ ...request(['-e', '']), owner });
        const observed = observe(child);
        await observed.closed;
        expect(observed.errors.map((error) => error.code)).toEqual([
          'ERR_PROVIDER_PROCESS_OWNER',
        ]);
        expect(observed.closes).toEqual([[null, null]]);
        expect(child.pid).toBeUndefined();
      }
      expect(spawnSpy).not.toHaveBeenCalled();
    });
  });

  itPosix(
    'stop kills the whole group even after the leader closed',
    async () => {
      const child = spawnProviderProcessDirect(
        request([
          '-e',
          `const { spawn } = require('node:child_process');
           const grandchild = spawn(process.execPath, ['-e',
             "process.on('SIGTERM', () => undefined); process.stdout.write('ready'); setInterval(() => undefined, 1 << 30);"],
             { stdio: ['ignore', 'pipe', 'ignore'] });
           grandchild.stdout.once('data', () => process.stdout.write(grandchild.pid + '\\n'));
           process.on('SIGTERM', () => process.exit(0));
           setInterval(() => undefined, 1 << 30);`,
        ]),
      );
      const observed = observe(child);
      const grandchild = Number(await firstLine(child));
      strays.add(grandchild);
      expect(present(grandchild)).toBe(true);
      await child.stop({ graceMs: 200 });
      expect(observed.closes).toEqual([[0, null]]);
      await until(() => !present(grandchild), 3_000);
    },
  );

  itPosix('stop escalates an ignored SIGTERM after the grace', async () => {
    const child = spawnProviderProcessDirect(
      request([
        '-e',
        `process.on('SIGTERM', () => undefined);
         process.stdout.write('ready\\n');
         setInterval(() => undefined, 1 << 30);`,
      ]),
    );
    const observed = observe(child);
    await firstLine(child);
    const started = Date.now();
    await child.stop({ graceMs: 300 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(observed.closes).toEqual([[null, 'SIGKILL']]);
  });

  it('stop is idempotent', async () => {
    const child = spawnProviderProcessDirect(
      request(['-e', 'setInterval(() => undefined, 1 << 30);']),
    );
    const observed = observe(child);
    const first = child.stop({ graceMs: 100 });
    const second = child.stop({ graceMs: 5_000 });
    expect(second).toBe(first);
    await first;
    expect(observed.closes).toHaveLength(1);
  });
});

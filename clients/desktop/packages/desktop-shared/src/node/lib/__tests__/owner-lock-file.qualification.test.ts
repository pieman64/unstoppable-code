import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type * as NodeFs from 'node:fs';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const mockUnlinkHook: { current?: (target: string) => void } = {};
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof NodeFs>('node:fs');
  return {
    ...actual,
    unlinkSync: (target: NodeFs.PathLike): void => {
      mockUnlinkHook.current?.(String(target));
      actual.unlinkSync(target);
    },
  };
});
import {
  ensurePrivateLockDirectory,
  withOwnerLockFile,
  withOwnerLockFileSync,
} from '../owner-lock-file';

const REPOSITORY_ROOT = resolve(__dirname, '../../../../../..');
const HOLDER = join(__dirname, 'owner-lock-holder-process.ts');
const children = new Set<ChildProcess>();
let root = '';
let lockPath = '';

type Mode = 'async' | 'sync';

function exited(child: ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', () => resolve()));
}

async function startHolder(
  mode: Mode,
  holdPath = lockPath,
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', HOLDER, mode, holdPath],
    { cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Holder exited early with ${String(code)}`)),
    );
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (chunk.includes('held')) resolve();
    });
  });
  return child;
}

/** A live process whose PID stands in for a reused one. */
function startUnrelatedProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e5)'], {
    stdio: 'ignore',
  });
  children.add(child);
  return child;
}

function readRecord(file: string): Record<string, unknown> {
  const record: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!record || typeof record !== 'object') throw new Error('No lock record');
  return { ...record };
}

async function crashHolder(mode: Mode): Promise<Record<string, unknown>> {
  const holder = await startHolder(mode);
  holder.kill('SIGKILL');
  await exited(holder);
  return readRecord(lockPath);
}

function rewriteOwnerPid(file: string, pid: number | undefined): void {
  writeFileSync(file, JSON.stringify({ ...readRecord(file), pid }), {
    mode: 0o600,
  });
}

function acquire(mode: Mode, maxWaitMs: number): Promise<string> {
  const options = { maxWaitMs, pollMs: 20, timeoutMessage: 'busy' };
  return mode === 'sync'
    ? Promise.resolve().then(() =>
        withOwnerLockFileSync(lockPath, () => 'acquired', options),
      )
    : withOwnerLockFile(lockPath, () => Promise.resolve('acquired'), options);
}

function livenessTokens(): string[] {
  return readdirSync(join(root, '.owner-liveness')).filter((name) =>
    name.endsWith('.sqlite'),
  );
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'owner-lock-liveness-'));
  await ensurePrivateLockDirectory(root);
  lockPath = join(root, 'writer.lock');
});

afterEach(async () => {
  delete mockUnlinkHook.current;
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map(exited));
  children.clear();
  rmSync(root, { recursive: true, force: true });
});

describe.each<Mode>(['async', 'sync'])('%s owner lock', (mode) => {
  it('reclaims a crashed holder whose PID now belongs to a live process', async () => {
    const record = await crashHolder(mode);
    rewriteOwnerPid(lockPath, startUnrelatedProcess().pid);

    const started = Date.now();
    await expect(acquire(mode, 3_000)).resolves.toBe('acquired');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(existsSync(lockPath)).toBe(false);
    expect(livenessTokens()).not.toContain(`${String(record.liveness)}.sqlite`);
  }, 30_000);

  it('keeps a live holder until the waiter times out', async () => {
    await startHolder(mode);
    const before = readFileSync(lockPath, 'utf8');

    await expect(acquire(mode, 400)).rejects.toThrow('busy');
    expect(readFileSync(lockPath, 'utf8')).toBe(before);
  }, 30_000);

  it('clears a stale reclaim guard left by a crashed holder', async () => {
    const record = await crashHolder(mode);
    const unrelated = startUnrelatedProcess().pid;
    rewriteOwnerPid(lockPath, unrelated);
    mkdirSync(`${lockPath}.reclaim`, { mode: 0o700 });
    writeFileSync(
      join(`${lockPath}.reclaim`, 'owner.json'),
      JSON.stringify({ ...record, pid: unrelated, nonce: 'reclaim' }),
      { mode: 0o600 },
    );

    await expect(acquire(mode, 3_000)).resolves.toBe('acquired');
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
  }, 30_000);
});

describe('records from builds without liveness', () => {
  it('keeps PID liveness: a live PID blocks and an exited PID is reclaimed', async () => {
    const record = await crashHolder('async');
    const legacy = { ...record };
    delete legacy.liveness;
    writeFileSync(
      lockPath,
      JSON.stringify({ ...legacy, pid: startUnrelatedProcess().pid }),
      { mode: 0o600 },
    );
    await expect(acquire('async', 400)).rejects.toThrow('busy');

    const exitedProcess = startUnrelatedProcess();
    exitedProcess.kill('SIGKILL');
    await exited(exitedProcess);
    rewriteOwnerPid(lockPath, exitedProcess.pid);
    await expect(acquire('sync', 3_000)).resolves.toBe('acquired');
  }, 30_000);
});

it('sweeps liveness files of exited processes and keeps live ones', async () => {
  const otherLock = join(root, 'other.lock');
  await startHolder('async', otherLock);
  const liveToken = String(readRecord(otherLock).liveness);
  const crashed = String((await crashHolder('sync')).liveness);
  rmSync(lockPath);
  expect(livenessTokens().sort()).toEqual(
    [`${liveToken}.sqlite`, `${crashed}.sqlite`].sort(),
  );

  await expect(acquire('async', 3_000)).resolves.toBe('acquired');
  expect(livenessTokens()).toEqual([`${liveToken}.sqlite`]);
}, 30_000);

it('keeps its liveness token only while it holds a lock in the directory', async () => {
  const during: string[][] = [];
  await withOwnerLockFile(
    lockPath,
    async () => {
      during.push(livenessTokens());
      await withOwnerLockFile(
        join(root, 'nested.lock'),
        () => {
          during.push(livenessTokens());
          return Promise.resolve();
        },
        { maxWaitMs: 1_000, timeoutMessage: 'busy' },
      );
      during.push(livenessTokens());
    },
    { maxWaitMs: 1_000, timeoutMessage: 'busy' },
  );

  expect(during.map((tokens) => tokens.length)).toEqual([1, 1, 1]);
  expect(new Set(during.flat()).size).toBe(1);
  expect(livenessTokens()).toEqual([]);
  rmSync(root, { recursive: true });
  expect(existsSync(root)).toBe(false);
}, 30_000);

it('never removes a token file a starting owner locked during a sweep', async () => {
  const liveness = join(root, '.owner-liveness');
  mkdirSync(liveness, { mode: 0o700 });
  const token = join(liveness, `${randomUUID()}.sqlite`);
  writeFileSync(token, '', { mode: 0o600, flag: 'wx' });
  const created = lstatSync(token, { bigint: true }).ino;
  const owner = new DatabaseSync(token);
  owner.exec('PRAGMA busy_timeout = 0');
  owner.exec('PRAGMA journal_mode = MEMORY');
  let ownerHolds = false;
  mockUnlinkHook.current = (target): void => {
    if (target !== token || ownerHolds) return;
    // The starting owner takes its lock at the sweep's last step.
    try {
      owner.exec('BEGIN EXCLUSIVE');
      ownerHolds = lstatSync(token, { bigint: true }).ino === created;
    } catch {
      ownerHolds = false;
    }
  };

  await expect(acquire('async', 3_000)).resolves.toBe('acquired');

  expect(!ownerHolds || existsSync(token)).toBe(true);
  owner.close();
}, 30_000);

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type * as FsPromises from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  MemoryLocalLockOwnerFileSchema,
  type MemoryLocalLockOwnerFile,
} from '@canopy/protocol/memory-sync';
import {
  memoryEditRevision,
  withMemoryWriteLock,
} from '../memory/local/edit-coordination';
import { writeMemoryFileAtomically } from '../memory/local/memory-files';
import { appendInboxNote } from '../memory/local/store';
import {
  acquireMemoryScopeLock,
  LocalMemoryScopeLockTimeoutError,
  withMemoryScopeLock,
} from '../memory/local/scope-lock';
import { prepareMemoryScopeForWrite } from '../memory/local/scope-manifest';
import { runScopeChild } from './helpers/local-memory-scope/scope-child';

/**
 * Lets a test run other processes' steps at a chosen rename, the point a
 * takeover moves a lock aside, to replay interleavings deterministically.
 */
let mockInterceptRename:
  | ((from: string, to: string, run: () => Promise<void>) => Promise<void>)
  | null = null;
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    rename: (from: string, to: string): Promise<void> => {
      const run = (): Promise<void> => actual.rename(from, to);
      return mockInterceptRename
        ? mockInterceptRename(String(from), String(to), run)
        : run();
    },
  };
});

jest.setTimeout(60_000);

const STALE_MS = 30_000;
/** How long a replay lets another process's step run before going on. */
const STEP_MS = 500;

/** The pid of a process that has exited. */
function exitedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '']);
    child.once('error', reject);
    child.once('close', () => {
      if (child.pid === undefined) reject(new Error('no pid'));
      else resolve(child.pid);
    });
  });
}

async function writeLock(
  scopeDir: string,
  owner: Partial<MemoryLocalLockOwnerFile> & { heartbeatAgoMs: number },
): Promise<MemoryLocalLockOwnerFile> {
  const heartbeatAt = new Date(Date.now() - owner.heartbeatAgoMs).toISOString();
  const file: MemoryLocalLockOwnerFile = {
    version: 1,
    token: randomUUID(),
    pid: owner.pid ?? process.pid,
    hostname: owner.hostname ?? hostname(),
    processKind: 'app',
    acquiredAt: heartbeatAt,
    heartbeatAt,
  };
  await mkdir(join(scopeDir, '.lock'));
  await writeFile(join(scopeDir, '.lock', 'owner.json'), JSON.stringify(file));
  return file;
}

async function ownerAt(
  lockDir: string,
): Promise<MemoryLocalLockOwnerFile | null> {
  try {
    return MemoryLocalLockOwnerFileSchema.parse(
      JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')),
    );
  } catch {
    return null;
  }
}

function lockOwner(scopeDir: string): Promise<MemoryLocalLockOwnerFile | null> {
  return ownerAt(join(scopeDir, '.lock'));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Waits for `step` to finish, or for `STEP_MS` while it waits on a lock. */
function letRun(step: Promise<unknown>): Promise<void> {
  return Promise.race([
    step.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => setTimeout(resolve, STEP_MS)),
  ]);
}

/** A takeover moving the lock at `.lock` aside. */
function isMoveAside(scopeDir: string, from: string, to: string): boolean {
  return (
    from === join(scopeDir, '.lock') && basename(to).startsWith('.lock.stale-')
  );
}

/**
 * Critical sections of simulated processes, all waiting on one gate, that
 * record the most ever inside at once.
 */
function criticalSections(scopeDir: string): {
  start(): { entered: Promise<void>; done: Promise<void> };
  finish(): void;
  readonly maxInside: number;
} {
  const gate = deferred();
  let inside = 0;
  let maxInside = 0;
  return {
    start() {
      const entered = deferred();
      const done = withMemoryScopeLock(
        scopeDir,
        async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          entered.resolve();
          await gate.promise;
          inside -= 1;
        },
        { timeoutMs: 20_000 },
      );
      return { entered: entered.promise, done };
    },
    finish: gate.resolve,
    get maxInside(): number {
      return maxInside;
    },
  };
}

describe('local memory scope lock', () => {
  let scopeDir: string;
  let warning: jest.SpyInstance;

  beforeEach(async () => {
    scopeDir = await mkdtemp(join(tmpdir(), 'local-memory-lock-'));
    warning = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => undefined);
  });

  afterEach(async () => {
    mockInterceptRename = null;
    warning.mockRestore();
    await rm(scopeDir, { recursive: true, force: true });
  });

  it('keeps two processes out of each other’s writes and advances one revision per write', async () => {
    await prepareMemoryScopeForWrite(scopeDir);
    const before = await memoryEditRevision(scopeDir);
    const [incarnation, revision] = before.split(':');

    await Promise.all([
      runScopeChild(['count', scopeDir, '25']),
      runScopeChild(['count', scopeDir, '25']),
    ]);

    // Each write reads the counter, yields and writes it back plus one: no
    // update is lost only when no two writes ever overlapped.
    await expect(readFile(join(scopeDir, 'counter.txt'), 'utf8')).resolves.toBe(
      '50',
    );
    expect(await memoryEditRevision(scopeDir)).toBe(
      `${incarnation}:${Number(revision) + 50}`,
    );
    expect(
      (await readdir(scopeDir)).filter((name) => name.startsWith('.lock')),
    ).toEqual([]);
  });

  it('takes over a lock whose holder died on this host', async () => {
    const stale = await writeLock(scopeDir, {
      pid: await exitedPid(),
      heartbeatAgoMs: STALE_MS + 1_000,
    });
    const lock = await acquireMemoryScopeLock(scopeDir, { timeoutMs: 1_000 });
    const owner = await lockOwner(scopeDir);
    expect(owner?.token).toBe(lock.token);
    expect(owner?.pid).toBe(process.pid);
    await lock.release();
    expect(await readdir(scopeDir)).toEqual([`.lock.stale-${stale.token}`]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('stopped refreshing'),
      { code: 'LOCAL_MEMORY_LOCK_STOLEN' },
    );
  });

  it.each<
    [string, { pid?: number; hostname?: string; heartbeatAgoMs: number }]
  >([
    [
      'a live process on this host',
      { pid: process.ppid, heartbeatAgoMs: STALE_MS + 1_000 },
    ],
    ['a recent heartbeat from a dead process', { heartbeatAgoMs: 1_000 }],
    [
      'a recent heartbeat from another host',
      { hostname: 'other-host', heartbeatAgoMs: 1_000 },
    ],
  ])('waits for, and never takes, a lock held by %s', async (_label, owner) => {
    const held = await writeLock(scopeDir, {
      ...owner,
      pid: owner.pid ?? (await exitedPid()),
    });

    await expect(
      acquireMemoryScopeLock(scopeDir, { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(LocalMemoryScopeLockTimeoutError);
    expect((await lockOwner(scopeDir))?.token).toBe(held.token);
  });

  it('takes over a silent lock held from another host, and a lock without an owner', async () => {
    await writeLock(scopeDir, {
      hostname: 'other-host',
      pid: process.ppid,
      heartbeatAgoMs: STALE_MS + 1_000,
    });
    await (
      await acquireMemoryScopeLock(scopeDir, { timeoutMs: 1_000 })
    ).release();

    await mkdir(join(scopeDir, '.lock'));
    const old = new Date(Date.now() - STALE_MS - 1_000);
    await utimes(join(scopeDir, '.lock'), old, old);
    const lock = await acquireMemoryScopeLock(scopeDir, { timeoutMs: 1_000 });
    expect((await lockOwner(scopeDir))?.token).toBe(lock.token);
    await lock.release();
  });

  it('lets only one of several waiters past a stale lock at a time', async () => {
    await writeLock(scopeDir, {
      pid: await exitedPid(),
      heartbeatAgoMs: STALE_MS + 1_000,
    });
    let inside = 0;
    let overlapped = false;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        withMemoryScopeLock(
          scopeDir,
          async () => {
            inside += 1;
            overlapped ||= inside > 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            inside -= 1;
          },
          { timeoutMs: 5_000 },
        ),
      ),
    );
    expect(overlapped).toBe(false);
    // One took the stale lock over; the rest waited for whoever held it.
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('never lets a takeover displace a lock taken after its holder, judged stale, released it', async () => {
    // A holder on another host that looks stale (60 s silent) but is alive.
    const silent = await acquireMemoryScopeLock(scopeDir, {
      hostname: 'other-host',
      heartbeatMs: 3_600_000,
    });
    const ownerPath = join(scopeDir, '.lock', 'owner.json');
    const owner = MemoryLocalLockOwnerFileSchema.parse(
      JSON.parse(await readFile(ownerPath, 'utf8')),
    );
    await writeFile(
      ownerPath,
      JSON.stringify({
        ...owner,
        heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const sections = criticalSections(scopeDir);
    const started: Array<Promise<unknown>> = [];
    const replayed = deferred();
    mockInterceptRename = async (from, to, run): Promise<void> => {
      if (!isMoveAside(scopeDir, from, to)) return run();
      mockInterceptRename = null;
      // Between the takeover's inspection and its move: the silent holder
      // releases and a new process takes the lock.
      const released = silent.release();
      started.push(released);
      await letRun(released);
      const newer = sections.start();
      started.push(newer.done);
      await letRun(newer.entered);
      await run();
      // A third process takes the name the move left free.
      const third = sections.start();
      started.push(third.done);
      await letRun(third.entered);
      replayed.resolve();
    };

    started.push(sections.start().done);
    await replayed.promise;
    const overlapDuringReplay = sections.maxInside;
    sections.finish();
    const settled = await Promise.allSettled(started);

    expect(overlapDuringReplay).toBeLessThanOrEqual(1);
    expect(sections.maxInside).toBe(1);
    expect(settled.filter(({ status }) => status === 'rejected')).toEqual([]);
    // The holder judged stale learns, at its release, that it lost the lock.
    expect(silent.lost).toBe(true);
  });

  it('never lets two waiters that judged one dead holder stale both take it over', async () => {
    // Dead long enough that a moved-aside copy is already past retention.
    await writeLock(scopeDir, {
      pid: await exitedPid(),
      heartbeatAgoMs: 20 * 60_000,
    });
    const longAgo = new Date(Date.now() - 20 * 60_000);
    await utimes(join(scopeDir, '.lock'), longAgo, longAgo);
    const sections = criticalSections(scopeDir);
    const started: Array<Promise<unknown>> = [];
    const secondMoveArrived = deferred();
    const secondMoveMayRun = deferred();
    const replayed = deferred();
    let moves = 0;
    mockInterceptRename = async (from, to, run): Promise<void> => {
      if (!isMoveAside(scopeDir, from, to)) return run();
      moves += 1;
      if (moves === 1) {
        // Let the second waiter reach its own move too, if it can.
        await letRun(secondMoveArrived.promise);
        await run();
        // A third process takes the free lock and cleans up old tombstones.
        const third = sections.start();
        started.push(third.done);
        await letRun(third.entered);
        secondMoveMayRun.resolve();
        if (moves === 1) replayed.resolve();
        return;
      }
      if (moves === 2) {
        secondMoveArrived.resolve();
        await secondMoveMayRun.promise;
        // The second waiter moves whatever holds the lock now.
        await run();
        const fourth = sections.start();
        started.push(fourth.done);
        await letRun(fourth.entered);
        replayed.resolve();
        return;
      }
      return run();
    };

    started.push(sections.start().done, sections.start().done);
    await replayed.promise;
    const overlapDuringReplay = sections.maxInside;
    sections.finish();
    const settled = await Promise.allSettled(started);

    expect(overlapDuringReplay).toBeLessThanOrEqual(1);
    expect(sections.maxInside).toBe(1);
    expect(settled.filter(({ status }) => status === 'rejected')).toEqual([]);
    expect(
      warning.mock.calls.filter(
        ([, options]) =>
          (options as { code?: string } | undefined)?.code ===
          'LOCAL_MEMORY_LOCK_STOLEN',
      ),
    ).toHaveLength(1);
  });

  it('stops a holder’s write once another process took its lock over, and never removes the new lock', async () => {
    let successor: MemoryLocalLockOwnerFile | undefined;
    await expect(
      withMemoryWriteLock(scopeDir, async () => {
        // Another process judged this holder stale and took the lock over.
        await rename(join(scopeDir, '.lock'), join(scopeDir, '.lock.stale-x'));
        successor = await writeLock(scopeDir, { heartbeatAgoMs: 0 });
        await writeMemoryFileAtomically(
          scopeDir,
          join(scopeDir, 'MEMORY.md'),
          'written after losing the lock',
        );
      }),
    ).rejects.toMatchObject({ name: 'LocalMemoryScopeLockLostError' });

    await expect(readFile(join(scopeDir, 'MEMORY.md'), 'utf8')).rejects.toThrow(
      /ENOENT/,
    );
    expect((await lockOwner(scopeDir))?.token).toBe(successor?.token);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('took over a local memory lock'),
      { code: 'LOCAL_MEMORY_LOCK_LOST' },
    );
  });

  it('fails a note save with the lost lock, writing nothing, when another process takes the lock over', async () => {
    mockInterceptRename = async (from, to, run): Promise<void> => {
      await run();
      if (basename(to) !== 'manifest.json') return;
      mockInterceptRename = null;
      // Another process took the lock over once the scope was readied.
      await rename(join(scopeDir, '.lock'), join(scopeDir, '.lock.stale-x'));
      await writeLock(scopeDir, { heartbeatAgoMs: 0 });
    };

    await expect(
      appendInboxNote(scopeDir, {
        text: 'Saved after losing the lock',
        source: { provider: 'claude', chatId: 'chat-1' },
      }),
    ).rejects.toMatchObject({ name: 'LocalMemoryScopeLockLostError' });
    expect(await readdir(join(scopeDir, 'inbox'))).toEqual([]);
  });

  it('reports, and never ignores, a newer lock it moved aside and could not put back', async () => {
    const stale = await writeLock(scopeDir, {
      pid: await exitedPid(),
      heartbeatAgoMs: STALE_MS + 1_000,
    });
    let newer: MemoryLocalLockOwnerFile | undefined;
    let third: MemoryLocalLockOwnerFile | undefined;
    mockInterceptRename = async (from, to, run): Promise<void> => {
      if (!isMoveAside(scopeDir, from, to)) return run();
      mockInterceptRename = null;
      // The lock changed hands after the takeover inspected it, and a third
      // process takes the name the move leaves free.
      await rm(join(scopeDir, '.lock'), { recursive: true });
      newer = await writeLock(scopeDir, { heartbeatAgoMs: 0 });
      await run();
      third = await writeLock(scopeDir, { heartbeatAgoMs: 0 });
    };

    await expect(
      acquireMemoryScopeLock(scopeDir, { timeoutMs: 2_000 }),
    ).rejects.toMatchObject({ name: 'LocalMemoryScopeLockLostError' });

    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('could not put it back'),
      { code: 'LOCAL_MEMORY_LOCK_DISPLACED' },
    );
    expect((await lockOwner(scopeDir))?.token).toBe(third?.token);
    expect(
      (await ownerAt(join(scopeDir, `.lock.stale-${stale.token}`)))?.token,
    ).toBe(newer?.token);
  });

  it('refreshes its heartbeat while held and never removes a lock another process took over', async () => {
    const lock = await acquireMemoryScopeLock(scopeDir, { heartbeatMs: 20 });
    const first = await lockOwner(scopeDir);
    let refreshed = first;
    for (
      const deadline = Date.now() + 10_000;
      refreshed?.heartbeatAt === first?.heartbeatAt && Date.now() < deadline;
      refreshed = await lockOwner(scopeDir)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(refreshed?.token).toBe(lock.token);
    expect(Date.parse(refreshed?.heartbeatAt ?? '')).toBeGreaterThan(
      Date.parse(first?.heartbeatAt ?? ''),
    );

    // Another process judged it stale and moved it aside: the holder
    // notices at its next heartbeat and stops refreshing.
    await rename(join(scopeDir, '.lock'), join(scopeDir, '.lock.stale-x'));
    while (!lock.lost) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('took over a local memory lock'),
      { code: 'LOCAL_MEMORY_LOCK_LOST' },
    );
    const successor = await writeLock(scopeDir, { heartbeatAgoMs: 0 });
    await lock.release();
    expect((await lockOwner(scopeDir))?.token).toBe(successor.token);
  });

  it('removes its own lock at release after judging it lost while it was moved aside and put back', async () => {
    const lock = await acquireMemoryScopeLock(scopeDir);
    // A takeover moved the lock aside, found it live and put it back.
    await rename(join(scopeDir, '.lock'), join(scopeDir, '.lock.aside'));
    await expect(lock.assertHeld()).rejects.toMatchObject({
      name: 'LocalMemoryScopeLockLostError',
    });
    await rename(join(scopeDir, '.lock.aside'), join(scopeDir, '.lock'));
    await lock.release();

    // Another live process on this host never waits out the lock.
    const next = await acquireMemoryScopeLock(scopeDir, {
      pid: process.ppid,
      timeoutMs: 1_000,
    });
    expect((await lockOwner(scopeDir))?.token).toBe(next.token);
    await next.release();
  });
});

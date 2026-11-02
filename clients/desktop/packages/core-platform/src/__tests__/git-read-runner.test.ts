import { createWindowsClosureWitness } from '../supervision/windows-closure';
import childProcess, { spawn, type ChildProcess } from 'node:child_process';
import { createHook, executionAsyncId } from 'node:async_hooks';
import { getEventListeners } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createChildServices } from '../supervision/child';
import { killProcessTree } from '../supervision/kill-tree';
import type { SupervisionOperations } from '../supervision/shared';
import {
  createGitReadRunner,
  supervisionFor,
  type GitReadOutput,
  type GitReadRequest,
  type GitReadRunner,
  type GitReadRunnerOptions,
  type ScratchOperations,
} from '../git-read/runner';
import type { ExecutableProbe } from '../git-read/resolve';
import { executableIdentity, type GitReadCommand } from '../git-read/commands';

const HOST =
  process.platform === 'darwin' || process.platform === 'linux'
    ? process.platform
    : undefined;
const posix = HOST ? describe : describe.skip;
const MiB = 1024 * 1024;
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let dir = '';
let serial = 0;
const groups = new Set<number>();

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), 'code') === 'EPERM';
  }
}

async function groupGone(pgid: number, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!groupAlive(pgid)) return true;
    await delay(20);
  }
  return !groupAlive(pgid);
}

/** A fake `git` whose first act records its PID (its group ID) in `$PIDFILE`. */
function script(body: string): { file: string; pidfile: string } {
  serial += 1;
  const file = join(dir, `fake-${serial}.sh`);
  const pidfile = join(dir, `fake-${serial}.pid`);
  writeFileSync(file, `#!/bin/sh\necho $$ > "$PIDFILE"\n${body}\n`);
  chmodSync(file, 0o755);
  return { file, pidfile };
}

/** A freshly written script can take a while to start on macOS. */
async function started(pidfile: string): Promise<void> {
  await until(
    () => existsSync(pidfile) && readFileSync(pidfile, 'utf8') !== '',
  );
}

/**
 * Two sleeping members, then `$PIDFILE.ready`. On macOS a group signal that
 * lands while the shell forks can miss the new member, so stop after `formed`.
 */
const GROUP = 'sleep 30 & sleep 30 & : > "$PIDFILE.ready"; wait';
async function formed(pidfile: string): Promise<void> {
  await until(() => existsSync(`${pidfile}.ready`));
}

function rootOf(pidfile: string): number {
  const pid = Number(readFileSync(pidfile, 'utf8').trim());
  groups.add(pid);
  return pid;
}

const ENV = { PATH: '/usr/bin:/bin', LANG: 'C' };
const NON_STRING_ENV: Record<string, string> = {};
Reflect.set(NON_STRING_ENV, 'A', 1);
function request(
  pidfile: string,
  overrides: Partial<GitReadRequest> = {},
): GitReadRequest {
  return {
    cwd: dir,
    environment: { ...ENV, HOME: dir, PIDFILE: pidfile },
    deadlineAt: performance.now() + 10_000,
    ...overrides,
  };
}

function runner(
  options: Partial<GitReadRunnerOptions> = {},
): ReturnType<typeof createGitReadRunner> {
  return createGitReadRunner({
    os: HOST ?? 'linux',
    timing: { drainMs: 100, cleanupReserveMs: 500, escalateMs: 200 },
    ...options,
  });
}

/** For exact kill lists: a loaded host can report the exit after `escalateMs: 200`. */
const PATIENT = { drainMs: 100, cleanupReserveMs: 3000, escalateMs: 2000 };

function version(
  options: Partial<GitReadRunnerOptions>,
  file: string,
  req: GitReadRequest,
): Promise<GitReadOutput> {
  return runner(options).run({ kind: 'git-version', executable: file }, req);
}

/** Graceful on every POSIX host; `git-version` is forced on Linux (desktop's SIGKILL rule). */
function ignoreCheck(
  options: Partial<GitReadRunnerOptions>,
  file: string,
  req: GitReadRequest,
): Promise<GitReadOutput> {
  return runner(options).run(
    { kind: 'git-check-ignore', executable: file, input: new Uint8Array(0) },
    req,
  );
}

/** Bounded, so a regression fails the test instead of polling past it. */
async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error(`Not met within ${ms} ms`);
    await delay(10);
  }
}

/** Blocks the event loop, so nothing the runner queued can run meanwhile. */
function blockUntil(condition: () => boolean, ms = 10_000): boolean {
  const end = performance.now() + ms;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!condition()) {
    if (performance.now() > end) return false;
    Atomics.wait(cell, 0, 0, 5);
  }
  return true;
}

const settle = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

/** Async-resource type of the current turn, for the signal-rule seam. */
const turnTypes = new Map<number, string>();
const turnHook = createHook({
  init: (id, type) => void turnTypes.set(id, type),
  destroy: (id) => void turnTypes.delete(id),
});

interface Kill {
  readonly pid: number;
  readonly signal: 'SIGTERM' | 'SIGKILL' | 0;
  readonly turn: string | undefined;
  readonly rootPresent: boolean;
}

/** Instrumented `SupervisionOperations.kill` (G0): records the turn and root state. */
function recordingKill(
  kills: Kill[],
  forward = true,
): SupervisionOperations['kill'] {
  return (pid, signal) => {
    let rootPresent = true;
    try {
      process.kill(Math.abs(pid), 0);
    } catch {
      rootPresent = false;
    }
    kills.push({ pid, signal, turn: turnTypes.get(executionAsyncId()), rootPresent }); // prettier-ignore
    if (forward) process.kill(pid, signal);
  };
}
const SAFE_TURNS = ['Timeout', 'Immediate'];

beforeAll(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'git-read-runner-'));
  writeFileSync(join(dir, 'two-byte.txt'), 'é'.repeat(MiB / 2));
  turnHook.enable();
});

afterEach(() => {
  groups.forEach((pgid) => {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  });
  groups.clear();
});

afterAll(() => {
  turnHook.disable();
  rmSync(dir, { recursive: true, force: true });
});

posix('git read runner (POSIX only: sh fixtures, process groups)', () => {
  it('runs in the explicit cwd with only the supplied environment', async () => {
    process.env.GIT_READ_AMBIENT = 'leaked';
    try {
      const { file, pidfile } = script(
        'pwd -P; printf "%s" "${GIT_READ_AMBIENT-unset}"; printf err >&2; exit 3',
      );
      const output = await version({}, file, request(pidfile));
      expect(output).toEqual({
        code: 3,
        signal: null,
        stdout: `${dir}\nunset`,
        stderr: 'err',
        pipes: 'closed',
      });
    } finally {
      delete process.env.GIT_READ_AMBIENT;
    }
  });

  it('writes binary stdin exactly and ends it', async () => {
    const { file, pidfile } = script('cat > "$OUT"');
    const out = join(dir, 'stdin.bin');
    const input = new Uint8Array(Array.from({ length: 70_000 }, (_, i) => i % 256)); // prettier-ignore
    const req = request(pidfile);
    const output = await runner().run(
      { kind: 'git-check-ignore', executable: file, input },
      { ...req, environment: { ...req.environment, OUT: out } },
    );
    expect(output.code).toBe(0);
    expect(Buffer.compare(readFileSync(out), Buffer.from(input))).toBe(0);
  });

  // Desktop rejects at the EPIPE; the runner stops the root and settles then too.
  it('settles promptly on a stdin failure while the root keeps running', async () => {
    const kills: Kill[] = [];
    // The EPIPE follows both forks: members read /dev/null, the root closes stdin.
    const { file, pidfile } = script(
      'sleep 30 </dev/null & sleep 30 </dev/null & exec 0<&-; wait',
    );
    const begun = performance.now();
    const outcome = await settle(
      runner({
        operations: { kill: recordingKill(kills) },
        timing: PATIENT,
      }).run(
        { kind: 'git-check-ignore', executable: file, input: new Uint8Array(4 * MiB) }, // prettier-ignore
        request(pidfile),
      ),
    );
    expect(outcome).toMatchObject({ error: { code: 'EPIPE' } });
    expect(performance.now() - begun).toBeLessThan(3000);
    const pgid = rootOf(pidfile);
    expect(kills).toEqual([
      { pid: -pgid, signal: 'SIGTERM', turn: 'Immediate', rootPresent: true },
    ]);
    expect(await groupGone(pgid)).toBe(true);
  });

  // A root that never reads stdin can close it before the runner writes
  // (CAN-4739). Empty input has nothing to lose; a lost byte still fails.
  it.each([
    ['empty input resolves', 0],
    ['a lost byte rejects with EPIPE', 1],
  ] as const)('after the root closes stdin, %s', async (_, length) => {
    const { file, pidfile } = script('exec 0<&-; : > "$PIDFILE.closed"');
    let rootClosedStdin = false;
    // The runner reads its operations after spawn and before writing stdin.
    const operations: Partial<SupervisionOperations> = {};
    Object.defineProperty(operations, 'kill', {
      enumerable: true,
      get: () => {
        rootClosedStdin = blockUntil(() => existsSync(`${pidfile}.closed`));
        return supervisionFor(ENV).kill;
      },
    });
    const outcome = await settle(
      runner({ operations }).run(
        { kind: 'git-check-ignore', executable: file, input: new Uint8Array(length) }, // prettier-ignore
        request(pidfile),
      ),
    );
    rootOf(pidfile);
    expect(rootClosedStdin).toBe(true);
    expect(outcome).toMatchObject(
      length === 0
        ? { value: { code: 0, signal: null, pipes: 'closed' } }
        : { error: { code: 'EPIPE' } },
    );
  });

  describe('per-stream limits (desktop execFile maxBuffer)', () => {
    it.each([
      ['exactly 1 MiB per stream', `head -c ${MiB} /dev/zero | tr '\\0' a; head -c ${MiB} /dev/zero | tr '\\0' b >&2`, true], // prettier-ignore
      ['1 MiB of two-byte characters', 'cat two-byte.txt', true],
      ['one byte over on stdout', `head -c ${MiB + 1} /dev/zero | tr '\\0' a`, 'stdout'], // prettier-ignore
      ['one byte over on stderr', `head -c ${MiB + 1} /dev/zero | tr '\\0' a >&2`, 'stderr'], // prettier-ignore
      // 400,000 raw bytes decode to 1,200,000 bytes of U+FFFD (C7).
      ['malformed UTF-8 counted after decoding', "head -c 400000 /dev/zero | tr '\\0' '\\377'", 'stdout'], // prettier-ignore
    ])('%s', async (_, body, expected) => {
      const { file, pidfile } = script(body);
      const outcome = await settle(version({}, file, request(pidfile)));
      if (expected === true)
        expect(outcome).toMatchObject({ value: { code: 0, pipes: 'closed' } });
      else
        expect(outcome).toMatchObject({
          error: { code: 'output_limit', stream: expected },
        });
    });

    it('kills the producing group on overflow', async () => {
      const { file, pidfile } = script('yes & wait');
      const outcome = await settle(version({}, file, request(pidfile)));
      expect(outcome).toMatchObject({ error: { code: 'output_limit' } });
      expect(await groupGone(rootOf(pidfile))).toBe(true);
    });
  });

  describe('after the root exits', () => {
    it('collects late output within the drain window', async () => {
      const { file, pidfile } = script('(sleep 0.2; echo late) & echo early');
      const options = { timing: { drainMs: 3000 } };
      const output = await version(options, file, request(pidfile));
      expect(output).toMatchObject({ stdout: 'early\nlate\n', pipes: 'closed' }); // prettier-ignore
    });

    // E3: a background member holds the pipes; drain is bounded and the group left alone.
    it('abandons held pipes after the drain window and leaves the group', async () => {
      const kills: Kill[] = [];
      const { file, pidfile } = script('sleep 30 & echo done; exit 0');
      const started = performance.now();
      const output = await version(
        { operations: { kill: recordingKill(kills) } },
        file,
        request(pidfile),
      );
      expect(performance.now() - started).toBeLessThan(2000);
      expect(output).toEqual({
        code: 0,
        signal: null,
        stdout: 'done\n',
        stderr: '',
        pipes: 'abandoned',
      });
      expect(kills).toEqual([]);
      const pgid = rootOf(pidfile);
      expect(groupAlive(pgid)).toBe(true);
      process.kill(-pgid, 'SIGKILL');
      expect(await groupGone(pgid)).toBe(true);
    });

    it('rejects with the abort reason during the drain without a group kill', async () => {
      const kills: Kill[] = [];
      const { file, pidfile } = script('sleep 30 & echo done');
      const controller = new AbortController();
      const reason = { why: 'client went away' };
      const req = request(pidfile, { signal: controller.signal });
      const options = {
        timing: { drainMs: 5000 },
        operations: { kill: recordingKill(kills) },
      };
      const work = settle(version(options, file, req));
      await started(pidfile);
      await delay(300);
      controller.abort(reason);
      expect(await work).toEqual({ error: reason });
      expect(kills).toEqual([]);
      expect(groupAlive(rootOf(pidfile))).toBe(true);
    });
  });

  // Node emits a child's 'close' after its stdio closes, and a spawn failure's
  // 'close' a loop turn after its 'error'. Held pipes close only when the
  // runner destroys them at the drain end, so each case aborts in that gap.
  describe('an abort while settlement waits for close', () => {
    let spawnSpy: jest.SpyInstance | undefined;
    afterEach(() => spawnSpy?.mockRestore());

    interface Gap {
      readonly closed: boolean;
      readonly stdioDestroyed: boolean;
    }

    /**
     * Aborts `controller` at `file`'s first stdio 'close', or a microtask after
     * its spawn 'error', and records whether that child had closed by then.
     */
    function abortInGap(
      file: string,
      controller: AbortController,
      reason: unknown,
    ): { readonly roots: ChildProcess[]; readonly gap: () => Gap | undefined } {
      const realSpawn = childProcess.spawn;
      const roots: ChildProcess[] = [];
      let gap: Gap | undefined;
      spawnSpy = jest
        .spyOn(childProcess, 'spawn')
        .mockImplementation((...args: Parameters<typeof realSpawn>) => {
          const child = realSpawn(...args);
          if (args[0] !== file) return child;
          roots.push(child);
          let closed = false;
          child.once('close', () => (closed = true));
          const abort = (): void => {
            if (controller.signal.aborted) return;
            gap = {
              closed,
              stdioDestroyed: Boolean(child.stdout?.destroyed && child.stderr?.destroyed), // prettier-ignore
            };
            controller.abort(reason);
          };
          child.stdout?.once('close', abort);
          child.stderr?.once('close', abort);
          child.once('error', () => queueMicrotask(abort));
          return child;
        });
      return { roots, gap: () => gap };
    }

    it.each(['request', 'host'] as const)(
      'rejects a drained success with a %s abort',
      async (source) => {
        const kills: Kill[] = [];
        const { file, pidfile } = script('sleep 30 & echo done; exit 0');
        const controller = new AbortController();
        const reason = new Error('discard');
        const { roots, gap } = abortInGap(file, controller, reason);
        const r = runner({
          hostSignal: source === 'host' ? controller.signal : undefined,
          operations: { kill: recordingKill(kills) },
        });
        const outcome = await settle(
          r.run(
            { kind: 'git-version', executable: file },
            request(pidfile, source === 'request' ? { signal: controller.signal } : {}), // prettier-ignore
          ),
        );
        rootOf(pidfile);
        expect(roots).toHaveLength(1);
        expect(gap()).toEqual({ closed: false, stdioDestroyed: true });
        expect(outcome).toEqual({ error: reason });
        expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
        expect(kills).toEqual([]);
        expect(await r.whenIdle(AbortSignal.abort())).toBe('idle');
      },
    );

    // The member overflows only after the runner saw the root exit, so the
    // overflow settles at once, without a kill, while the member holds the pipes.
    it('keeps an earlier output_limit', async () => {
      const kills: Kill[] = [];
      const { file, pidfile } = script(
        `(while [ ! -e "$PIDFILE.go" ]; do sleep 0.05; done; head -c ${MiB + 1} /dev/zero; sleep 30) & exit 0`, // prettier-ignore
      );
      const controller = new AbortController();
      const { roots, gap } = abortInGap(file, controller, new Error('late'));
      const work = settle(
        runner({
          operations: { kill: recordingKill(kills) },
          timing: { drainMs: 5000, cleanupReserveMs: 500 },
        }).run(
          { kind: 'git-version', executable: file },
          request(pidfile, { signal: controller.signal }),
        ),
      );
      await until(() => roots[0]?.exitCode === 0);
      writeFileSync(`${pidfile}.go`, '');
      const outcome = await work;
      rootOf(pidfile);
      expect(gap()).toEqual({ closed: false, stdioDestroyed: true });
      expect(outcome).toMatchObject({
        error: { code: 'output_limit', stream: 'stdout' },
      });
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
      expect(kills).toEqual([]);
    });

    it('keeps a spawn failure', async () => {
      const file = join(dir, 'missing-gap-git');
      const controller = new AbortController();
      const { roots, gap } = abortInGap(file, controller, new Error('late'));
      const r = runner();
      const outcome = await settle(
        r.run(
          { kind: 'git-version', executable: file },
          request('', { signal: controller.signal }),
        ),
      );
      expect(roots).toHaveLength(1);
      expect(gap()).toMatchObject({ closed: false });
      expect(outcome).toMatchObject({ error: { code: 'ENOENT' } });
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
      expect(await r.whenIdle(AbortSignal.abort())).toBe('idle');
    });
  });

  describe('deadline and cleanup reserve', () => {
    it('stops at the reserve and settles by the request deadline', async () => {
      const kills: Kill[] = [];
      const { file, pidfile } = script(GROUP);
      // Stops 1 s in, after the group forms; escalation waits 800 ms for the exit.
      const deadlineAt = performance.now() + 2000;
      const options = {
        operations: { kill: recordingKill(kills) },
        timing: { drainMs: 100, cleanupReserveMs: 1000, escalateMs: 800 },
      };
      const outcome = await settle(
        ignoreCheck(options, file, request(pidfile, { deadlineAt })),
      );
      expect(performance.now()).toBeLessThan(deadlineAt + 100);
      expect(outcome).toMatchObject({ error: { code: 'deadline_exceeded' } });
      const pgid = rootOf(pidfile);
      expect(kills).toEqual([
        { pid: -pgid, signal: 'SIGTERM', turn: 'Immediate', rootPresent: true },
      ]);
      expect(await groupGone(pgid)).toBe(true);
    });

    it('escalates an ignored graceful stop to a forced group kill', async () => {
      const kills: Kill[] = [];
      const { file, pidfile } = script("trap '' TERM; sleep 30 & wait");
      const options = { operations: { kill: recordingKill(kills) } };
      const deadlineAt = performance.now() + 1000;
      const outcome = await settle(
        ignoreCheck(options, file, request(pidfile, { deadlineAt })),
      );
      expect(outcome).toMatchObject({ error: { code: 'deadline_exceeded' } });
      const pgid = rootOf(pidfile);
      expect(kills.map(({ pid, signal }) => [pid, signal])).toEqual([
        [-pgid, 'SIGTERM'],
        [-pgid, 'SIGKILL'],
      ]);
      expect(kills.every(({ turn }) => SAFE_TURNS.includes(turn ?? ''))).toBe(
        true,
      );
      expect(await groupGone(pgid)).toBe(true);
    });

    it('reports unconfirmed cleanup when the root survives the reserve', async () => {
      const kills: Kill[] = [];
      const { file, pidfile } = script('sleep 30');
      const options = { operations: { kill: recordingKill(kills, false) } };
      const deadlineAt = performance.now() + 900;
      const outcome = await settle(
        ignoreCheck(options, file, request(pidfile, { deadlineAt })),
      );
      expect(performance.now()).toBeLessThan(deadlineAt + 100);
      expect(outcome).toMatchObject({
        error: {
          code: 'cleanup_unconfirmed',
          failure: { code: 'deadline_exceeded' },
        },
      });
      expect(kills).toHaveLength(2);
      expect(groupAlive(rootOf(pidfile))).toBe(true);
    });

    it('refuses a deadline inside the reserve without spawning', async () => {
      const { file, pidfile } = script('');
      const deadlineAt = performance.now() + 400;
      const outcome = await settle(
        version({}, file, request(pidfile, { deadlineAt })),
      );
      expect(outcome).toMatchObject({ error: { code: 'deadline_exceeded' } });
      expect(existsSync(pidfile)).toBe(false);
    });
  });

  describe('abort', () => {
    it.each(['request', 'host'] as const)(
      '%s abort kills the group and rejects with its reason',
      async (source) => {
        const kills: Kill[] = [];
        const { file, pidfile } = script(GROUP);
        const controller = new AbortController();
        const reason = new Error(`${source} stop`);
        const options = {
          operations: { kill: recordingKill(kills) },
          hostSignal: source === 'host' ? controller.signal : undefined,
          timing: PATIENT,
        };
        const req = request(pidfile, {
          signal: source === 'request' ? controller.signal : undefined,
        });
        const work = settle(ignoreCheck(options, file, req));
        await formed(pidfile);
        controller.abort(reason);
        expect(await work).toEqual({ error: reason });
        const pgid = rootOf(pidfile);
        expect(kills).toEqual([
          { pid: -pgid, signal: 'SIGTERM', turn: 'Immediate', rootPresent: true }, // prettier-ignore
        ]);
        expect(await groupGone(pgid)).toBe(true);
      },
    );

    it.each([
      ['git-check-ignore', 'SIGTERM'],
      ['git-version', HOST === 'linux' ? 'SIGKILL' : 'SIGTERM'],
    ] as const)('stops %s with a single %s', async (kind, signal) => {
      const kills: Kill[] = [];
      const { file, pidfile } = script(GROUP);
      const controller = new AbortController();
      const work = settle(
        runner({
          operations: { kill: recordingKill(kills) },
          timing: PATIENT,
        }).run(
          kind === 'git-version'
            ? { kind, executable: file }
            : { kind, executable: file, input: new Uint8Array(0) },
          request(pidfile, { signal: controller.signal }),
        ),
      );
      await formed(pidfile);
      controller.abort();
      await work;
      const pgid = rootOf(pidfile);
      expect(kills).toEqual([
        { pid: -pgid, signal, turn: 'Immediate', rootPresent: true },
      ]);
      expect(await groupGone(pgid)).toBe(true);
    });

    it.each(['request', 'host'] as const)(
      'reports unconfirmed cleanup with the %s abort reason when the root survives',
      async (source) => {
        const kills: Kill[] = [];
        const { file, pidfile } = script('sleep 30');
        const controller = new AbortController();
        const reason = new Error(`${source} stop`);
        const options = {
          operations: { kill: recordingKill(kills, false) },
          hostSignal: source === 'host' ? controller.signal : undefined,
        };
        const req = request(pidfile, {
          signal: source === 'request' ? controller.signal : undefined,
        });
        const work = settle(ignoreCheck(options, file, req));
        await started(pidfile);
        const abortedAt = performance.now();
        controller.abort(reason);
        const outcome = await work;
        expect(performance.now() - abortedAt).toBeLessThan(1500);
        expect(outcome).toMatchObject({
          error: { code: 'cleanup_unconfirmed', failure: reason },
        });
        expect(kills.map(({ signal }) => signal)).toEqual(['SIGTERM', 'SIGKILL']); // prettier-ignore
        expect(kills.every(({ turn }) => SAFE_TURNS.includes(turn ?? ''))).toBe(true); // prettier-ignore
        expect(groupAlive(rootOf(pidfile))).toBe(true);
      },
    );

    // First event wins: an abort during the cleanup reserve does not replace it.
    it.each([
      ['the root then exits', true, { code: 'output_limit', stream: 'stdout' }],
      ['the root survives', false, { code: 'cleanup_unconfirmed', failure: { code: 'output_limit', stream: 'stdout' } }], // prettier-ignore
    ])(
      'keeps an earlier failure when an abort follows and %s',
      async (_, rootExits, expected) => {
        const kills: Kill[] = [];
        const { file, pidfile } = script('yes & wait');
        const controller = new AbortController();
        const options = { operations: { kill: recordingKill(kills, false) } };
        const req = request(pidfile, { signal: controller.signal });
        const work = settle(version(options, file, req));
        await until(() => kills.length > 0);
        controller.abort(new Error('late abort'));
        const pgid = rootOf(pidfile);
        if (rootExits) process.kill(-pgid, 'SIGKILL');
        expect(await work).toMatchObject({ error: expected });
        if (rootExits) expect(await groupGone(pgid)).toBe(true);
      },
    );

    it.each(['request', 'host'] as const)(
      'a pre-aborted %s signal rejects without spawning',
      async (source) => {
        const { file, pidfile } = script('');
        const reason = { source };
        const signal = AbortSignal.abort(reason);
        const options = source === 'host' ? { hostSignal: signal } : {};
        const req = request(pidfile, source === 'request' ? { signal } : {});
        expect(await settle(version(options, file, req))).toEqual({
          error: reason,
        });
        expect(existsSync(pidfile)).toBe(false);
      },
    );
  });

  describe('request validation and spawn failure', () => {
    it.each<[string, Partial<GitReadRequest>]>([
      ['relative cwd', { cwd: 'relative' }],
      ['empty cwd', { cwd: '' }],
      ['non-finite deadline', { deadlineAt: Number.POSITIVE_INFINITY }],
      ['NUL in the environment', { environment: { A: 'x\0y' } }],
      ['non-string environment value', { environment: NON_STRING_ENV }],
    ])('rejects %s before spawning', async (_, overrides) => {
      const { file, pidfile } = script('');
      const outcome = await settle(
        version({}, file, request(pidfile, overrides)),
      );
      expect(outcome).toMatchObject({ error: { code: 'invalid_request' } });
      expect(existsSync(pidfile)).toBe(false);
    });

    // Spawn would resolve these through the host's PATH (Windows) or libuv's default (POSIX).
    it('rejects a relative command without PATH before spawning', async () => {
      const environment = { HOME: dir, LANG: 'C' };
      const req = { ...request(''), environment };
      const posixHost = await settle(
        runner().run(
          { kind: 'git-check-ignore', executable: 'sh', input: new Uint8Array(0) }, // prettier-ignore
          req,
        ),
      );
      expect(posixHost).toMatchObject({ error: { code: 'invalid_request' } });
      const windows = createGitReadRunner({ os: 'win32' });
      const where = await settle(
        windows.run({ kind: 'where-git' }, { ...req, cwd: 'C:\\repo' }),
      );
      expect(where).toMatchObject({ error: { code: 'invalid_request' } });
      const relativeGit = await settle(
        windows.checkIgnoredPathsWith(
          'git.exe',
          'C:\\repo',
          ['x'],
          environment,
        ),
      );
      expect(relativeGit).toMatchObject({ error: { code: 'invalid_request' } });
    });

    it('rejects a relative bare-init git without PATH before writing scratch', async () => {
      const req = { ...request(''), environment: { HOME: dir, LANG: 'C' } };
      const created: string[] = [];
      const bareInit = await settle(
        createGitReadRunner({
          os: 'darwin',
          scratch: {
            create: (prefix) => {
              created.push(prefix);
              return Promise.resolve(join(dir, 'unexpected-scratch'));
            },
          },
        }).run(
          {
            kind: 'git-bare-init-smoke',
            executable: 'git',
            temporaryRoot: dir,
          },
          req,
        ),
      );
      expect(bareInit).toMatchObject({ error: { code: 'invalid_request' } });
      expect(created).toEqual([]);
    });

    // D2: an empty or `.` entry would name the cwd for execvp.
    it('spawns the absolute path a bare command resolves to on the supplied PATH, never the cwd', async () => {
      const bin = mkdtempSync(join(dir, 'bin-'));
      const cwd = mkdtempSync(join(dir, 'cwd-'));
      for (const [where, at] of [
        ['path', bin],
        ['cwd', cwd],
      ]) {
        writeFileSync(join(at ?? '', 'canopy-git'), `#!/bin/sh\nprintf '%s %s' ${where} "$0"\n`); // prettier-ignore
        chmodSync(join(at ?? '', 'canopy-git'), 0o755);
      }
      const output = await version({}, 'canopy-git', {
        cwd,
        environment: { PATH: `:.:${bin}`, LANG: 'C' },
        deadlineAt: performance.now() + 10_000,
      });
      expect(output).toMatchObject({
        code: 0,
        stdout: `path ${join(bin, 'canopy-git')}`,
      });
    });

    it('rejects a bare command missing from the supplied PATH with command_not_found before spawning', async () => {
      const { pidfile } = script('');
      const empty = mkdtempSync(join(dir, 'empty-bin-'));
      const req = request(pidfile);
      const outcome = await settle(
        version({}, 'canopy-missing-git', {
          ...req,
          environment: { ...req.environment, PATH: empty },
        }),
      );
      expect(outcome).toMatchObject({ error: { code: 'command_not_found' } });
    });

    describe('PATH resolution under the request bounds', () => {
      const pending: ExecutableProbe = () => new Promise(() => undefined);
      const bare = (
        options: Partial<GitReadRunnerOptions>,
        overrides: Partial<GitReadRequest>,
      ): Promise<unknown> =>
        settle(version(options, 'canopy-git', request('', overrides)));

      it('rejects with the abort reason, without spawning', async () => {
        const asked: string[] = [];
        const probe: ExecutableProbe = (candidate) => {
          asked.push(candidate);
          return pending(candidate);
        };
        const controller = new AbortController();
        const reason = { aborted: 'during lookup' };
        const work = bare(
          { isExecutable: probe },
          { signal: controller.signal },
        );
        await until(() => asked.length > 0);
        controller.abort(reason);
        expect(await work).toEqual({ error: reason });
        expect(asked).toEqual(['/usr/bin/canopy-git']);
      });

      it('rejects deadline_exceeded at the stop time', async () => {
        const begun = performance.now();
        const outcome = await bare(
          { isExecutable: pending },
          { deadlineAt: begun + 500 + 200 },
        );
        expect(outcome).toMatchObject({ error: { code: 'deadline_exceeded' } });
        expect(performance.now() - begun).toBeGreaterThanOrEqual(150);
        expect(performance.now() - begun).toBeLessThan(600);
      });

      it('rejects a pre-aborted request without asking the probe', async () => {
        const asked: string[] = [];
        const reason = new Error('already');
        const outcome = await bare(
          { isExecutable: (candidate) => (asked.push(candidate), pending(candidate)) }, // prettier-ignore
          { signal: AbortSignal.abort(reason) },
        );
        expect(outcome).toEqual({ error: reason });
        expect(asked).toEqual([]);
      });

      it('passes a probe failure through', async () => {
        const failure = new Error('probe failed');
        const outcome = await bare(
          { isExecutable: () => Promise.reject(failure) },
          {},
        );
        expect(outcome).toEqual({ error: failure });
      });
    });

    it.each([
      ['missing executable', join(dir || '/', 'missing-git'), undefined],
      ['missing cwd', undefined, '/nonexistent-git-read-cwd'],
    ])('passes through the %s spawn error', async (_, executable, cwd) => {
      const { file, pidfile } = script('');
      const req = request(pidfile, cwd ? { cwd } : {});
      const outcome = await settle(version({}, executable ?? file, req));
      expect(outcome).toMatchObject({ error: { code: 'ENOENT' } });
    });
  });

  // The scratch write and removal run inside the request's deadline and abort.
  (HOST === 'darwin' ? describe : describe.skip)(
    'macOS bare-init scratch directory (macOS only: a macOS-only command)',
    () => {
      interface Gate<T> {
        readonly promise: Promise<T>;
        open(value: T): void;
        fail(error: unknown): void;
      }
      function gate<T>(): Gate<T> {
        const handlers: { open?: (value: T) => void; fail?: (error: unknown) => void } = {}; // prettier-ignore
        const promise = new Promise<T>((resolve, reject) => {
          handlers.open = resolve;
          handlers.fail = reject;
        });
        return {
          promise,
          open: (value) => handlers.open?.(value),
          fail: (error) => handlers.fail?.(error),
        };
      }
      const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
      const record =
        (removed: string[]): ScratchOperations['remove'] =>
        (directory) => {
          removed.push(directory);
          return Promise.resolve();
        };
      const OVERFLOW = "head -c 9000 /dev/zero | tr '\\0' a";

      function smoke(
        options: Partial<GitReadRunnerOptions>,
        file: string,
        req: GitReadRequest,
        root = dir,
      ): Promise<GitReadOutput> {
        return runner(options).run(
          {
            kind: 'git-bare-init-smoke',
            executable: file,
            temporaryRoot: root,
          },
          req,
        );
      }

      it('removes the directory', async () => {
        const root = mkdtempSync(join(dir, 'scratch-'));
        const { file, pidfile } = script('test -d "$5" && echo "$5"');
        const output = await smoke({}, file, request(pidfile), root);
        expect(output.stdout).toMatch(new RegExp(`^${root}/git-validation-`));
        expect(existsSync(output.stdout.trim())).toBe(false);
      });

      it('passes through a creation failure without running git', async () => {
        const failure = new Error('no space');
        const removed: string[] = [];
        const { file, pidfile } = script('');
        const scratch: ScratchOperations = {
          create: () => Promise.reject(failure),
          remove: record(removed),
        };
        expect(
          await settle(smoke({ scratch }, file, request(pidfile))),
        ).toEqual({
          error: failure,
        });
        expect(existsSync(pidfile)).toBe(false);
        expect(removed).toEqual([]);
      });

      it('stops at the reserve during creation and removes a late directory', async () => {
        const created = gate<string>();
        const removed: string[] = [];
        const { file, pidfile } = script('');
        const scratch: ScratchOperations = {
          create: () => created.promise,
          remove: record(removed),
        };
        const deadlineAt = performance.now() + 900;
        const outcome = await settle(
          smoke({ scratch }, file, request(pidfile, { deadlineAt })),
        );
        expect(performance.now()).toBeLessThan(deadlineAt + 100);
        expect(outcome).toMatchObject({ error: { code: 'deadline_exceeded' } });
        expect(existsSync(pidfile)).toBe(false);
        created.open('/late-scratch');
        await until(() => removed.length > 0);
        expect(removed).toEqual(['/late-scratch']);
      });

      it.each([
        ['completes soon after', true],
        ['hangs', false],
      ])(
        'rejects with an abort during creation that %s, after bounded removal',
        async (_, completes) => {
          const created = gate<string>();
          const removed: string[] = [];
          const { file, pidfile } = script('');
          const controller = new AbortController();
          const reason = new Error('stop during creation');
          const scratch: ScratchOperations = {
            create: () => created.promise,
            remove: record(removed),
          };
          const req = request(pidfile, { signal: controller.signal });
          const work = settle(smoke({ scratch }, file, req));
          await delay(50);
          const abortedAt = performance.now();
          controller.abort(reason);
          if (completes) setTimeout(() => created.open('/aborted-scratch'), 50);
          expect(await work).toEqual({ error: reason });
          // The runner's reserve is 500 ms.
          expect(performance.now() - abortedAt).toBeLessThan(1000);
          expect(existsSync(pidfile)).toBe(false);
          if (!completes) {
            expect(removed).toEqual([]);
            created.open('/aborted-scratch');
            await until(() => removed.length > 0);
          }
          expect(removed).toEqual(['/aborted-scratch']);
        },
      );

      it.each([
        ['a successful run', 'exit 0', 'reason'],
        ['an earlier failure', OVERFLOW, 'output_limit'],
      ] as const)(
        'settles an abort during removal after it, keeping %s first',
        async (_, body, expected) => {
          const removal = gate<void>();
          const controller = new AbortController();
          const reason = new Error('stop during removal');
          const { file, pidfile } = script(body);
          let removing = false;
          const scratch: ScratchOperations = {
            create: () => Promise.resolve(mkdtempSync(join(dir, 'abort-rm-'))),
            remove: () => {
              removing = true;
              return removal.promise;
            },
          };
          const req = request(pidfile, { signal: controller.signal });
          const work = settle(smoke({ scratch }, file, req));
          await until(() => removing);
          controller.abort(reason);
          await delay(50);
          removal.open();
          const outcome = await work;
          if (expected === 'reason') expect(outcome).toEqual({ error: reason });
          else expect(outcome).toMatchObject({ error: { code: expected } });
        },
      );

      it.each(['request', 'host'] as const)(
        'settles a %s abort during the run within one reserve, removal included',
        async (source) => {
          const { file, pidfile } = script('sleep 30');
          const controller = new AbortController();
          const reason = new Error(`${source} stop`);
          const reported: unknown[] = [];
          let removing = false;
          const scratch: ScratchOperations = {
            create: () => Promise.resolve(mkdtempSync(join(dir, 'abort-run-'))),
            remove: () => {
              removing = true;
              return never<void>();
            },
          };
          const options: Partial<GitReadRunnerOptions> = {
            scratch,
            onScratchCleanupFailure: (error) => void reported.push(error),
            // The root survives, so the stop spends the whole reserve.
            operations: { kill: recordingKill([], false) },
            hostSignal: source === 'host' ? controller.signal : undefined,
            timing: { drainMs: 100, cleanupReserveMs: 1000, escalateMs: 200 },
          };
          const req = request(pidfile, {
            signal: source === 'request' ? controller.signal : undefined,
          });
          const work = settle(smoke(options, file, req));
          await started(pidfile);
          rootOf(pidfile);
          const abortedAt = performance.now();
          controller.abort(reason);
          const outcome = await work;
          expect(performance.now() - abortedAt).toBeLessThan(1500);
          expect(outcome).toMatchObject({
            error: { code: 'cleanup_unconfirmed', failure: reason },
          });
          expect(removing).toBe(true);
          expect(reported).toMatchObject([{ code: 'cleanup_unconfirmed' }]);
        },
      );

      it('bounds a hung removal by the cleanup reserve, keeps the result and reports it', async () => {
        const { file, pidfile } = script('echo ok');
        const reported: unknown[] = [];
        let removeAt = 0;
        const scratch: ScratchOperations = {
          create: () => Promise.resolve(mkdtempSync(join(dir, 'hung-rm-'))),
          remove: () => {
            removeAt = performance.now();
            return never<void>();
          },
        };
        const options: Partial<GitReadRunnerOptions> = {
          scratch,
          onScratchCleanupFailure: (error) => void reported.push(error),
        };
        const output = await smoke(options, file, request(pidfile));
        expect(reported).toMatchObject([{ code: 'cleanup_unconfirmed' }]);
        // The runner's reserve is 500 ms.
        expect(performance.now() - removeAt).toBeLessThan(1000);
        expect(output).toMatchObject({ code: 0, stdout: 'ok\n' });
      });

      it('settles by the request deadline when it expires during removal', async () => {
        // A held pipe drains to the deadline, leaving removal no time.
        const { file, pidfile } = script('sleep 30 & echo ok');
        const scratch: ScratchOperations = {
          create: () => Promise.resolve(mkdtempSync(join(dir, 'late-rm-'))),
          remove: () => never<void>(),
        };
        const deadlineAt = performance.now() + 1500;
        const options = { scratch, timing: { drainMs: 5000, cleanupReserveMs: 500 } }; // prettier-ignore
        const output = await smoke(
          options,
          file,
          request(pidfile, { deadlineAt }),
        );
        expect(performance.now()).toBeLessThan(deadlineAt + 100);
        expect(output).toMatchObject({ code: 0, stdout: 'ok\n', pipes: 'abandoned' }); // prettier-ignore
        rootOf(pidfile);
      });

      it('keeps an earlier failure when removal fails and reports the removal failure', async () => {
        const root = mkdtempSync(join(dir, 'locked-'));
        const reported: unknown[] = [];
        // An unwritable subdirectory makes the real removal fail with EACCES.
        const { file, pidfile } = script(
          `mkdir "$5/locked" && : > "$5/locked/file" && chmod 500 "$5/locked" && ${OVERFLOW}`,
        );
        try {
          const outcome = await settle(
            smoke(
              { onScratchCleanupFailure: (error) => void reported.push(error) },
              file,
              request(pidfile),
              root,
            ),
          );
          expect(outcome).toMatchObject({
            error: { code: 'output_limit', stream: 'stdout' },
          });
          expect(reported).toMatchObject([{ code: 'EACCES' }]);
        } finally {
          readdirSync(root).forEach((name) =>
            chmodSync(join(root, name, 'locked'), 0o700),
          );
        }
      });

      it('keeps a successful result when removal fails and reports the removal failure', async () => {
        const failure = new Error('busy');
        const reported: unknown[] = [];
        const { file, pidfile } = script('echo ok');
        const scratch: ScratchOperations = {
          create: () => Promise.resolve(mkdtempSync(join(dir, 'failed-rm-'))),
          remove: () => Promise.reject(failure),
        };
        const options: Partial<GitReadRunnerOptions> = {
          scratch,
          onScratchCleanupFailure: (error: unknown) =>
            void reported.push(error),
        };
        const output = await smoke(options, file, request(pidfile));
        expect(output).toMatchObject({ code: 0, stdout: 'ok\n' });
        expect(reported).toEqual([failure]);
      });

      it('stays pending while a removal continues past its bound', async () => {
        const removal = gate<void>();
        const { file, pidfile } = script('echo ok');
        const r = runner({
          scratch: {
            create: () => Promise.resolve(mkdtempSync(join(dir, 'idle-rm-'))),
            remove: () => removal.promise,
          },
        });
        const output = await r.run(
          { kind: 'git-bare-init-smoke', executable: file, temporaryRoot: dir },
          request(pidfile),
        );
        expect(output).toMatchObject({ code: 0 });
        expect(await r.whenIdle(AbortSignal.timeout(100))).toBe('pending');
        const idle = r.whenIdle(AbortSignal.timeout(3000));
        removal.open();
        expect(await idle).toBe('idle');
      });

      it('stays pending for a late directory until it is removed', async () => {
        const created = gate<string>();
        const removal = gate<void>();
        const removed: string[] = [];
        const { file, pidfile } = script('');
        const r = runner({
          scratch: {
            create: () => created.promise,
            remove: (directory) => {
              removed.push(directory);
              return removal.promise;
            },
          },
        });
        const outcome = await settle(
          r.run(
            { kind: 'git-bare-init-smoke', executable: file, temporaryRoot: dir }, // prettier-ignore
            request(pidfile, { deadlineAt: performance.now() + 900 }),
          ),
        );
        expect(outcome).toMatchObject({ error: { code: 'deadline_exceeded' } });
        expect(await r.whenIdle(AbortSignal.timeout(100))).toBe('pending');
        created.open('/late-idle-scratch');
        await until(() => removed.length > 0);
        expect(await r.whenIdle(AbortSignal.timeout(100))).toBe('pending');
        const idle = r.whenIdle(AbortSignal.timeout(3000));
        removal.open();
        expect(await idle).toBe('idle');
        expect(removed).toEqual(['/late-idle-scratch']);
      });
    },
  );
});

// Runs on every host: the win32 kill path only reaches the recorded `run`.
describe('taskkill SystemRoot', () => {
  async function taskkillFor(
    environment: Record<string, string>,
  ): Promise<{ file: string; env: unknown }[]> {
    const runs: { file: string; env: unknown }[] = [];
    const ops = supervisionFor(environment, {
      run: (file, _args, _signal, env) => {
        runs.push({ file, env });
        return Promise.resolve('');
      },
      selfPid: 1,
    });
    await killProcessTree('win32', { pid: 4242, mode: 'force' }, ops);
    return runs;
  }

  it('uses the variant the children see when both cases are set', async () => {
    // Node keeps the first key in sort order: `SYSTEMROOT` precedes `SystemRoot`.
    expect(
      await taskkillFor({ SystemRoot: 'C:\\Host', SYSTEMROOT: 'D:\\Child' }),
    ).toEqual([
      {
        file: 'D:\\Child\\System32\\taskkill.exe',
        env: { SystemRoot: 'D:\\Child' },
      },
    ]);
  });

  it('accepts any case of a single key and never reads process.env', async () => {
    expect(await taskkillFor({ systemroot: 'E:\\Win' })).toEqual([
      { file: 'E:\\Win\\System32\\taskkill.exe', env: { SystemRoot: 'E:\\Win' } }, // prettier-ignore
    ]);
    const ambient = process.env.SystemRoot;
    process.env.SystemRoot = 'Z:\\Ambient';
    try {
      await expect(taskkillFor({ PATH: 'C:\\Git' })).rejects.toThrow(
        'SystemRoot is not absolute',
      );
    } finally {
      if (ambient === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = ambient;
    }
  });

  it('keeps an empty variant that sorts first, as the child does', async () => {
    // `SystemRoot` precedes `systemroot`, so the child sees `SystemRoot=`.
    await expect(
      taskkillFor({ systemroot: 'C:\\Windows', SystemRoot: '' }),
    ).rejects.toThrow('SystemRoot is not absolute');
  });
});

// D3: a POSIX root under the win32 kill path, with an injected taskkill.
posix(
  'Windows taskkill past settlement (POSIX host, injected taskkill)',
  () => {
    it.each([
      ['a request abort', 'request', 'fails'],
      ['a host abort', 'host', 'succeeds'],
    ] as const)(
      'settles at the reserve after %s without aborting the kill call, which then %s unobserved',
      async (_, source, late) => {
        const { file, pidfile } = script('exec /bin/sleep 30');
        const runs: { file: string; signal: AbortSignal | undefined }[] = [];
        let endKill: () => void = () => undefined;
        const run: SupervisionOperations['run'] = (taskkill, _args, signal) => {
          runs.push({ file: taskkill, signal });
          return new Promise((resolve, reject) => {
            endKill = (): void =>
              late === 'fails'
                ? reject(new Error('late taskkill failure'))
                : resolve('');
          });
        };
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void =>
          void unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        const controller = new AbortController();
        const reason = new Error('stop');
        try {
          // `//` keeps the paths absolute for win32 and valid on POSIX.
          const work = settle(
            createGitReadRunner({
              os: 'win32',
              operations: { run },
              timing: { drainMs: 50, cleanupReserveMs: 400 },
              hostSignal: source === 'host' ? controller.signal : undefined,
            }).run(
              { kind: 'git-check-ignore', executable: `/${file}`, input: new Uint8Array(0) }, // prettier-ignore
              {
                cwd: `/${dir}`,
                environment: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', PIDFILE: pidfile }, // prettier-ignore
                deadlineAt: performance.now() + 10_000,
                signal: source === 'request' ? controller.signal : undefined,
              },
            ),
          );
          await started(pidfile);
          const root = Number(readFileSync(pidfile, 'utf8').trim());
          try {
            const abortedAt = performance.now();
            controller.abort(reason);
            const outcome = await work;
            const settleMs = performance.now() - abortedAt;
            expect(outcome).toMatchObject({
              error: { code: 'cleanup_unconfirmed', failure: reason },
            });
            expect(settleMs).toBeGreaterThanOrEqual(350);
            expect(settleMs).toBeLessThan(1500);
            expect(runs.map(({ file: taskkill }) => taskkill)).toEqual([
              'C:\\Windows\\System32\\taskkill.exe',
            ]);
            // D3: no signal, so neither settlement nor the abort can end it.
            expect(runs[0]?.signal).toBeUndefined();
            endKill();
            await delay(50);
            expect(unhandled).toEqual([]);
          } finally {
            process.kill(root, 'SIGKILL');
          }
        } finally {
          process.off('unhandledRejection', onUnhandled);
        }
      },
    );
  },
);

// R5 §2.3: what a host's stop() and cleanup reports read from the runner.
posix('host integration: onKillCleanup and whenIdle (POSIX host)', () => {
  type Idle = Pick<GitReadRunner, 'whenIdle'>;
  const pendingNow = (r: Idle): Promise<string> =>
    r.whenIdle(AbortSignal.abort());
  const idleWithin = (r: Idle, ms: number): Promise<string> =>
    r.whenIdle(AbortSignal.timeout(ms));

  function rootGone(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  it('is idle at once with no work, even for an aborted signal', async () => {
    expect(await pendingNow(runner())).toBe('idle');
  });

  it.each([
    ['a missing executable', join(dir || '/', 'missing-idle-git'), undefined],
    ['a missing cwd', undefined, '/nonexistent-git-read-idle-cwd'],
  ])('is idle after a spawn failure for %s', async (_, executable, cwd) => {
    const { file, pidfile } = script('');
    const r = runner();
    const outcome = await settle(
      r.run(
        { kind: 'git-version', executable: executable ?? file },
        request(pidfile, cwd ? { cwd } : {}),
      ),
    );
    expect(outcome).toMatchObject({ error: { code: 'ENOENT' } });
    expect(await idleWithin(r, 1000)).toBe('idle');
  });

  it('rejects a non-signal with invalid_request', async () => {
    const r = runner();
    const outcome = await settle(
      Promise.resolve<unknown>(
        Reflect.apply(r.whenIdle.bind(r), undefined, []),
      ),
    );
    expect(outcome).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('waits for an in-flight request and wakes when it settles', async () => {
    const { file, pidfile } = script('sleep 0.3; echo ok');
    const r = runner();
    const work = r.run(
      { kind: 'git-version', executable: file },
      request(pidfile),
    );
    await started(pidfile);
    expect(await pendingNow(r)).toBe('pending');
    const idle = r.whenIdle(new AbortController().signal);
    expect(await work).toMatchObject({ code: 0, stdout: 'ok\n' });
    expect(await idle).toBe('idle');
  });

  it('waits for a lookup that is still in flight', async () => {
    const r = runner({ isExecutable: () => new Promise(() => undefined) });
    const controller = new AbortController();
    const work = settle(
      r.run(
        { kind: 'git-version', executable: 'canopy-git' },
        request('', { signal: controller.signal }),
      ),
    );
    expect(await idleWithin(r, 100)).toBe('pending');
    controller.abort(new Error('stop'));
    await work;
    // The abandoned lookup has no process or write behind it.
    expect(await pendingNow(r)).toBe('idle');
  });

  it('is idle right after a host abort settles a stopped request', async () => {
    const { file, pidfile } = script(GROUP);
    const host = new AbortController();
    const r = runner({ hostSignal: host.signal, timing: PATIENT });
    const work = settle(
      r.run(
        { kind: 'git-check-ignore', executable: file, input: new Uint8Array(0) }, // prettier-ignore
        request(pidfile),
      ),
    );
    await formed(pidfile);
    const reason = new Error('host stop');
    host.abort(reason);
    expect(await idleWithin(r, 3000)).toBe('idle');
    expect(await work).toEqual({ error: reason });
    expect(await groupGone(rootOf(pidfile))).toBe(true);
  });

  it('stays pending while an unconfirmed root lives on after settlement', async () => {
    const { file, pidfile } = script('sleep 30');
    const reports: string[] = [];
    const r = runner({
      operations: { kill: recordingKill([], false) },
      onKillCleanup: (outcome) => void reports.push(outcome),
    });
    const outcome = await settle(
      r.run(
        { kind: 'git-check-ignore', executable: file, input: new Uint8Array(0) }, // prettier-ignore
        request(pidfile, { deadlineAt: performance.now() + 900 }),
      ),
    );
    expect(outcome).toMatchObject({ error: { code: 'cleanup_unconfirmed' } });
    // POSIX kills complete inside the call, so none is still running.
    expect(reports).toEqual([]);
    expect(await idleWithin(r, 200)).toBe('pending');
    process.kill(-rootOf(pidfile), 'SIGKILL');
    expect(await idleWithin(r, 3000)).toBe('idle');
  });

  // The win32 kill path with an injected taskkill, as in the D3 suite above.
  describe('a Windows taskkill against the settled request', () => {
    interface Started {
      readonly runner: ReturnType<typeof createGitReadRunner>;
      readonly work: Promise<unknown>;
      readonly root: number;
      readonly reports: string[];
      readonly taskkills: number;
    }
    const reason = new Error('stop');
    const roots: number[] = [];
    afterEach(() => {
      roots.splice(0).forEach((pid) => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      });
    });

    async function abortedWin32(
      run: SupervisionOperations['run'],
      onKillCleanup?: GitReadRunnerOptions['onKillCleanup'],
    ): Promise<Started> {
      const { file, pidfile } = script('exec /bin/sleep 30');
      const reports: string[] = [];
      let taskkills = 0;
      const controller = new AbortController();
      const r = createGitReadRunner({
        os: 'win32',
        operations: {
          run: (...args) => {
            taskkills += 1;
            return run(...args);
          },
        },
        timing: { drainMs: 50, cleanupReserveMs: 400 },
        onKillCleanup:
          onKillCleanup ?? ((outcome): void => void reports.push(outcome)),
      });
      // `//` keeps the paths absolute for win32 and valid on POSIX.
      const work = settle(
        r.run(
          { kind: 'git-check-ignore', executable: `/${file}`, input: new Uint8Array(0) }, // prettier-ignore
          {
            cwd: `/${dir}`,
            environment: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', PIDFILE: pidfile }, // prettier-ignore
            deadlineAt: performance.now() + 10_000,
            signal: controller.signal,
          },
        ),
      );
      await started(pidfile);
      const root = Number(readFileSync(pidfile, 'utf8').trim());
      roots.push(root);
      controller.abort(reason);
      return {
        runner: r,
        work,
        root,
        reports,
        get taskkills(): number {
          return taskkills;
        },
      };
    }

    /** A taskkill that ends when `end` is called, then ends the root on success. */
    function heldTaskkill(): {
      run: SupervisionOperations['run'];
      end(outcome: 'succeeds' | 'fails', root?: number): void;
    } {
      let finish: (outcome: 'succeeds' | 'fails', root?: number) => void = () =>
        undefined;
      return {
        run: () =>
          new Promise((resolve, reject) => {
            finish = (outcome, root): void => {
              if (outcome === 'fails') return reject(new Error('late taskkill failure')); // prettier-ignore
              if (root !== undefined) process.kill(root, 'SIGKILL');
              resolve('');
            };
          }),
        end: (outcome, root) => finish(outcome, root),
      };
    }

    it('reports a kill still running at settlement once, and stays pending until it and the root end', async () => {
      const held = heldTaskkill();
      const s = await abortedWin32(held.run);
      expect(await s.work).toMatchObject({
        error: { code: 'cleanup_unconfirmed', failure: reason },
      });
      expect(s.reports).toEqual(['cleanup_unconfirmed']);
      expect(await idleWithin(s.runner, 100)).toBe('pending');
      const idle = s.runner.whenIdle(AbortSignal.timeout(3000));
      held.end('succeeds', s.root);
      expect(await idle).toBe('idle');
      expect(rootGone(s.root)).toBe(true);
      expect(s.reports).toEqual(['cleanup_unconfirmed']);
    });

    it('reports a late kill failure without changing the settled request', async () => {
      const held = heldTaskkill();
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown): void => void unhandled.push(error);
      process.on('unhandledRejection', onUnhandled);
      try {
        const s = await abortedWin32(held.run);
        const outcome = await s.work;
        expect(s.reports).toEqual(['cleanup_unconfirmed']);
        held.end('fails');
        await delay(50);
        expect(s.reports).toEqual(['cleanup_unconfirmed', 'failed']);
        // The settled result keeps the abort, not the late failure.
        expect(outcome).toMatchObject({
          error: { code: 'cleanup_unconfirmed', failure: reason },
        });
        // The kill failed, so the root still runs.
        expect(await idleWithin(s.runner, 100)).toBe('pending');
        process.kill(s.root, 'SIGKILL');
        expect(await idleWithin(s.runner, 3000)).toBe('idle');
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('reports a kill that ended the root but is still running at settlement', async () => {
      let root = 0;
      let finish: () => void = () => undefined;
      const s = await abortedWin32(
        () =>
          new Promise((resolve) => {
            process.kill(root, 'SIGKILL');
            finish = (): void => resolve('');
          }),
      );
      root = s.root;
      // The call happens in a later turn than `abortedWin32` returns.
      expect(await s.work).toEqual({ error: reason });
      expect(s.reports).toEqual(['cleanup_unconfirmed']);
      expect(await idleWithin(s.runner, 100)).toBe('pending');
      finish();
      expect(await idleWithin(s.runner, 3000)).toBe('idle');
      expect(s.reports).toEqual(['cleanup_unconfirmed']);
    });

    it('reports nothing for a kill that ends within the reserve, and is idle at settlement', async () => {
      let root = 0;
      const s = await abortedWin32(() => {
        process.kill(root, 'SIGKILL');
        return Promise.resolve('');
      });
      root = s.root;
      expect(await s.work).toEqual({ error: reason });
      expect(s.taskkills).toBe(1);
      expect(s.reports).toEqual([]);
      expect(await pendingNow(s.runner)).toBe('idle');
    });

    it('leaves a kill failure before settlement to the request, not the report', async () => {
      const failure = new Error('taskkill failed');
      const s = await abortedWin32(() => Promise.reject(failure));
      expect(await s.work).toMatchObject({
        error: { code: 'cleanup_unconfirmed', failure },
      });
      expect(s.reports).toEqual([]);
      expect(await idleWithin(s.runner, 100)).toBe('pending');
      process.kill(s.root, 'SIGKILL');
      expect(await idleWithin(s.runner, 3000)).toBe('idle');
    });

    it('keeps the result when the reporter throws', async () => {
      const held = heldTaskkill();
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown): void => void unhandled.push(error);
      process.on('unhandledRejection', onUnhandled);
      try {
        const s = await abortedWin32(held.run, () => {
          throw new Error('reporter');
        });
        expect(await s.work).toMatchObject({
          error: { code: 'cleanup_unconfirmed', failure: reason },
        });
        held.end('fails');
        await delay(50);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  });
});

posix('G0 signal rule (POSIX only: process-group signals)', () => {
  const os = HOST ?? 'linux';
  const options = createChildServices(os).childProcessOptions({
    lifetime: 'owned',
  });
  const start = (count: number): ChildProcess[] =>
    Array.from({ length: count }, () =>
      spawn('/bin/sh', ['-c', 'exit 0'], { ...options, stdio: 'ignore' }),
    );
  /** Holds the loop so every child exits before libuv reaps any of them. */
  const hold = (ms: number): void => {
    const end = Date.now() + ms;
    while (Date.now() < end);
  };
  const stale = (children: ChildProcess[]): number[] =>
    children
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => {
        try {
          process.kill(child.pid ?? 0, 0);
          return 0;
        } catch (error) {
          return Reflect.get(Object(error), 'code') === 'ESRCH' ? 1 : 0;
        }
      });

  // E1/E2: inside the first exit and its microtasks, reaped siblings still
  // read as live; by setImmediate none do.
  it('reproduces stale exit state outside timer and immediate turns', async () => {
    const children = start(12);
    hold(500);
    const observed = await new Promise<Record<string, number[]>>((resolve) => {
      children[0]?.once('exit', () => {
        const others = children.slice(1);
        const result: Record<string, number[]> = { exit: stale(others) };
        queueMicrotask(() => {
          result.microtask = stale(others);
        });
        setImmediate(() => {
          result.immediate = stale(others);
          resolve(result);
        });
      });
    });
    expect(observed.exit).toEqual(Array(11).fill(1));
    expect(observed.microtask).toEqual(Array(11).fill(1));
    expect(observed.immediate).toEqual([]);
  });

  // Negative control: the instrumented seam catches kills planted in the exit chain.
  it('flags kills planted in an exit listener or its continuations', async () => {
    const kills: Kill[] = [];
    const kill = recordingKill(kills, false);
    const [child] = start(1);
    const pid = child?.pid ?? 0;
    await new Promise<void>((resolve) =>
      child?.once('exit', () => {
        kill(-pid, 'SIGKILL');
        queueMicrotask(() => kill(-pid, 'SIGKILL'));
        void Promise.resolve().then(() => kill(-pid, 'SIGKILL'));
        setImmediate(() => {
          kill(-pid, 'SIGKILL');
          resolve();
        });
      }),
    );
    expect(kills.map(({ turn, rootPresent }) => [turn, rootPresent])).toEqual([
      ['PROCESSWRAP', false],
      ['Microtask', false],
      ['PROMISE', false],
      ['Immediate', false],
    ]);
    expect(kills.slice(0, 3).some(({ turn }) => SAFE_TURNS.includes(turn ?? ''))).toBe(false); // prettier-ignore
  });

  it('signals every runner group from a safe turn while the root is unreaped', async () => {
    const kills: Kill[] = [];
    const operations = { kill: recordingKill(kills) };
    const triggers: ['deadline' | 'abort' | 'limit', string][] = [
      ['deadline', GROUP],
      ['abort', GROUP],
      ['limit', 'yes & wait'],
    ];
    for (const [trigger, body] of triggers) {
      const { file, pidfile } = script(body);
      const controller = new AbortController();
      const deadlineAt = performance.now() + (trigger === 'deadline' ? 900 : 10_000); // prettier-ignore
      const work = settle(
        version(
          { operations },
          file,
          request(pidfile, { deadlineAt, signal: controller.signal }),
        ),
      );
      if (trigger === 'abort') {
        await formed(pidfile);
        controller.abort();
      }
      await work;
      expect(await groupGone(rootOf(pidfile))).toBe(true);
    }
    expect(kills.length).toBeGreaterThanOrEqual(3);
    for (const kill of kills) {
      expect(kill.pid).toBeLessThan(0);
      expect(SAFE_TURNS).toContain(kill.turn);
      expect(kill.rootPresent).toBe(true);
    }
  });
});

posix(
  'finite Windows closure gate (POSIX roots, unchanged win32 runner path)',
  () => {
    it.each(['natural', 'abandoned', 'cancelled', 'timed-out', 'preexisting'])(
      'records every %s invocation even when a later probe succeeds',
      async (mode) => {
        const witness = createWindowsClosureWitness();
        const first = script(
          mode === 'abandoned'
            ? '/bin/sleep 2 & exit 0'
            : mode === 'natural' || mode === 'preexisting'
              ? 'exit 0'
              : 'exec /bin/sleep 30',
        );
        const second = script('exit 0');
        const controller = new AbortController();
        const req = (pidfile: string): GitReadRequest => ({
          cwd: `/${dir}`,
          environment: {
            SystemRoot: 'C:\\Windows',
            PATH: 'C:\\Windows\\System32',
            PIDFILE: pidfile,
          },
          deadlineAt: performance.now() + (mode === 'timed-out' ? 350 : 3000),
          signal: controller.signal,
        });
        const preexisting =
          mode === 'preexisting'
            ? createGitReadRunner({ os: 'win32' })
            : undefined;
        await witness.run(async () => {
          const r =
            preexisting ??
            createGitReadRunner({
              os: 'win32',
              timing: { drainMs: 10, cleanupReserveMs: 100 },
              operations: {
                run: (_file, args) => {
                  // Simulates successful taskkill, NOT proof of descendants' exit.
                  process.kill(Number(args[1]), 'SIGKILL');
                  return Promise.resolve('');
                },
              },
            });
          const work = settle(
            r.run(
              { kind: 'git-version', executable: `/${first.file}` },
              req(first.pidfile),
            ),
          );
          if (mode === 'cancelled') {
            await started(first.pidfile);
            controller.abort(new Error('discard this validation probe'));
          }
          await work;
          await r.run(
            { kind: 'git-version', executable: `/${second.file}` },
            {
              ...req(second.pidfile),
              signal: undefined,
              deadlineAt: performance.now() + 3000,
            },
          );
          expect(await r.whenIdle(AbortSignal.timeout(3000))).toBe('idle');
        });
        const report = witness.finalize();
        expect(report.started).toBe(2);
        expect(witness.accepts(report)).toBe(mode === 'natural');
      },
    );

    // check-ignore is accepted only when its plan carries the fsmonitor
    // discharge, which only Git for Windows' git.exe at an audited version gets.
    it.each([
      ['git-version', 'fake', undefined, true],
      ['where-git', 'fake', undefined, true],
      ['git-check-ignore', 'git.exe', 'git version 2.47.1.windows.2', true],
      ['git-check-ignore', 'git.exe', 'git version 2.35.1.windows.1', false],
      ['git-check-ignore', 'git.exe', 'git version 2.57.0.windows.1', false],
      ['git-check-ignore', 'git.exe', 'git version 2.47.0.vfs.0.1', false],
      [
        'git-check-ignore',
        'git.exe',
        'git version 2.48.0-rc1.windows.1',
        false,
      ],
      ['git-check-ignore', 'git.exe', undefined, false],
      ['git-check-ignore', 'fake', 'git version 2.47.1.windows.2', false],
    ] as const)(
      'accepts a natural %s from %s (%s) only when it cannot leave an fsmonitor daemon (%s)',
      async (kind, image, version, accepted) => {
        const witness = createWindowsClosureWitness();
        // Read stdin to EOF as `git check-ignore --stdin` does: exiting first
        // races the stdin write into the runner's EPIPE. PATH is only the
        // where.exe directory, so a bare `cat` is not found.
        const drain =
          kind === 'git-check-ignore' ? '/bin/cat >/dev/null; ' : '';
        // Git for Windows sees the discharge, when planned, before its subcommand.
        const argv = accepted
          ? '-c core.fsmonitor=false check-ignore'
          : 'check-ignore -z --stdin';
        const fake = script(
          image === 'git.exe'
            ? `[ "$1 $2 $3" = "${argv}" ] || exit 9; ${drain}exit 0`
            : `${drain}exit 0`,
        );
        const executable =
          image === 'git.exe' ? join(dir, `git-${serial}`, 'git.exe') : fake.file; // prettier-ignore
        if (image === 'git.exe') {
          mkdirSync(dirname(executable));
          copyFileSync(fake.file, executable);
          chmodSync(executable, 0o755);
        }
        const whereDirectory = join(dir, `where-${serial}`);
        mkdirSync(whereDirectory);
        writeFileSync(join(whereDirectory, 'where.exe'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(whereDirectory, 'where.exe'), 0o755);
        const command: GitReadCommand =
          kind === 'where-git'
            ? { kind }
            : kind === 'git-version'
              ? { kind, executable: `/${executable}` }
              : {
                  kind,
                  executable: `/${executable}`,
                  input: new Uint8Array(0),
                  ...(version === undefined ? {} : { version }),
                  // As validation recorded it for this file.
                  identity: executableIdentity(statSync(executable)),
                };
        await witness.run(async () => {
          const r = createGitReadRunner({
            os: 'win32',
            timing: { drainMs: 10, cleanupReserveMs: 100 },
          });
          await expect(
            r.run(command, {
              cwd: `/${dir}`,
              environment: {
                SystemRoot: 'C:\\Windows',
                PATH: `/${whereDirectory}/`,
                PIDFILE: fake.pidfile,
              },
              deadlineAt: performance.now() + 3000,
            }),
          ).resolves.toMatchObject({ code: 0, signal: null, pipes: 'closed' });
          expect(await r.whenIdle(AbortSignal.timeout(3000))).toBe('idle');
        });
        const report = witness.finalize();
        expect(report).toMatchObject({ started: 1, pending: 0 });
        expect(witness.accepts(report)).toBe(accepted);
      },
    );

    // The selected Git's version reaches the plan; a bare path carries none.
    // The version vouches only for the file identity it was recorded with.
    it.each([
      [{ version: 'git version 2.47.1.windows.2', identity: 'recorded' }, true],
      [{ version: 'git version 2.47.1.windows.2' }, false],
      [
        { version: 'git version 2.35.1.windows.1', identity: 'recorded' },
        false,
      ],
      [{ version: undefined, identity: 'recorded' }, false],
      ['a bare path', false],
    ] as const)(
      'a check-ignore selection of %j is accepted: %s',
      async (selection, accepted) => {
        const witness = createWindowsClosureWitness();
        // Planning reads the version alone; acceptance also needs the identity.
        const argv =
          typeof selection !== 'string' && selection.version?.includes('2.47')
            ? '-c core.fsmonitor=false check-ignore'
            : 'check-ignore -z --stdin';
        const fake = script(
          `[ "$1 $2 $3" = "${argv}" ] || exit 9; /bin/cat >/dev/null; exit 1`,
        );
        const executable = `/${join(dir, `git-${serial}`, 'git.exe')}`;
        mkdirSync(dirname(executable));
        copyFileSync(fake.file, executable);
        chmodSync(executable, 0o755);
        const selected =
          typeof selection === 'string'
            ? executable
            : {
                executable,
                version: selection.version,
                ...('identity' in selection
                  ? { identity: executableIdentity(statSync(executable)) }
                  : {}),
              };
        await witness.run(async () => {
          const r = createGitReadRunner({
            os: 'win32',
            timing: { drainMs: 10, cleanupReserveMs: 100 },
          });
          await expect(
            r.checkIgnoredPathsSelected({
              cwd: `/${dir}`,
              paths: ['a.log'],
              environment: {
                SystemRoot: 'C:\\Windows',
                PATH: 'C:\\Windows\\System32',
                PIDFILE: fake.pidfile,
              },
              deadlineAt: performance.now() + 3000,
              signal: new AbortController().signal,
              executableForChunk: () => Promise.resolve(selected),
            }),
          ).resolves.toEqual(new Set());
          expect(await r.whenIdle(AbortSignal.timeout(3000))).toBe('idle');
        });
        const report = witness.finalize();
        expect(report).toMatchObject({ started: 1, pending: 0 });
        expect(witness.accepts(report)).toBe(accepted);
      },
    );

    // The audited version binds only the image whose stat identity validation
    // recorded: one replaced before the spawn, or during it, stays unsafe.
    it.each([
      ['never', true],
      ['before the spawn', false],
      ['during the spawn', false],
    ] as const)(
      'accepts an audited check-ignore whose image is replaced %s: %s',
      async (when, accepted) => {
        const witness = createWindowsClosureWitness();
        const fake = script(
          '[ "$1 $2 $3" = "-c core.fsmonitor=false check-ignore" ] || exit 9; /bin/cat >/dev/null; exit 1', // prettier-ignore
        );
        const executable = `/${join(dir, `git-${serial}`, 'git.exe')}`;
        mkdirSync(dirname(executable));
        copyFileSync(fake.file, executable);
        chmodSync(executable, 0o755);
        // `before`: the file no longer has the recorded identity. `during`:
        // it has it at the pre-spawn check and not after the spawn.
        const looks: string[] = [];
        const imageIdentity = (file: string): string => {
          looks.push(file);
          return when === 'never' ||
            (when === 'during the spawn' && looks.length === 1)
            ? 'recorded'
            : 'replaced';
        };
        await witness.run(async () => {
          const r = createGitReadRunner({
            os: 'win32',
            timing: { drainMs: 10, cleanupReserveMs: 100 },
            imageIdentity,
          });
          await expect(
            r.checkIgnoredPathsSelected({
              cwd: `/${dir}`,
              paths: ['a.log'],
              environment: {
                SystemRoot: 'C:\\Windows',
                PATH: 'C:\\Windows\\System32',
                PIDFILE: fake.pidfile,
              },
              deadlineAt: performance.now() + 3000,
              signal: new AbortController().signal,
              executableForChunk: () =>
                Promise.resolve({
                  executable,
                  version: 'git version 2.47.1.windows.2',
                  identity: 'recorded',
                }),
            }),
          ).resolves.toEqual(new Set());
          expect(await r.whenIdle(AbortSignal.timeout(3000))).toBe('idle');
        });
        const report = witness.finalize();
        expect(report).toMatchObject({ started: 1, pending: 0 });
        expect(witness.accepts(report)).toBe(accepted);
        // The started file is the one looked at.
        expect(looks.length).toBeGreaterThan(0);
        expect(new Set(looks)).toEqual(new Set([executable]));
      },
    );

    // The identity check costs a stat only for check-ignore in a closure run.
    it('looks at no image outside a closure run or for other commands', async () => {
      const fake = script('/bin/cat >/dev/null; exit 1');
      const executable = `/${join(dir, `git-${serial}`, 'git.exe')}`;
      mkdirSync(dirname(executable));
      copyFileSync(fake.file, executable);
      chmodSync(executable, 0o755);
      const looks: string[] = [];
      const r = createGitReadRunner({
        os: 'win32',
        timing: { drainMs: 10, cleanupReserveMs: 100 },
        imageIdentity: (file) => {
          looks.push(file);
          return 'recorded';
        },
      });
      const environment = {
        SystemRoot: 'C:\\Windows',
        PATH: 'C:\\Windows\\System32',
        PIDFILE: fake.pidfile,
      };
      await expect(
        r.checkIgnoredPathsSelected({
          cwd: `/${dir}`,
          paths: ['a.log'],
          environment,
          deadlineAt: performance.now() + 3000,
          signal: new AbortController().signal,
          executableForChunk: () =>
            Promise.resolve({
              executable,
              version: 'git version 2.47.1.windows.2',
              identity: 'recorded',
            }),
        }),
      ).resolves.toEqual(new Set());
      // git-version leaves stdin open, so its fake must not read it.
      const version = script('exit 0');
      const witness = createWindowsClosureWitness();
      await witness.run(async () => {
        await expect(
          r.run(
            { kind: 'git-version', executable: `/${version.file}` },
            {
              cwd: `/${dir}`,
              environment: { ...environment, PIDFILE: version.pidfile },
              deadlineAt: performance.now() + 3000,
            },
          ),
        ).resolves.toMatchObject({ code: 0 });
      });
      expect(await r.whenIdle(AbortSignal.timeout(3000))).toBe('idle');
      expect(looks).toEqual([]);
    });

    // The drain window ends before the held pipes close.
    it('is idle at an abandoned settlement only once its edge has closed', async () => {
      const witness = createWindowsClosureWitness();
      const fake = script('/bin/sleep 2 & exit 0');
      await witness.run(async () => {
        const r = createGitReadRunner({
          os: 'win32',
          timing: { drainMs: 10, cleanupReserveMs: 100 },
        });
        await expect(
          r.run(
            { kind: 'git-version', executable: `/${fake.file}` },
            {
              cwd: `/${dir}`,
              environment: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', PIDFILE: fake.pidfile }, // prettier-ignore
              deadlineAt: performance.now() + 3000,
            },
          ),
        ).resolves.toMatchObject({ code: 0, pipes: 'abandoned' });
        expect(await r.whenIdle(AbortSignal.abort())).toBe('idle');
      });
      expect(witness.finalize()).toMatchObject({ started: 1, pending: 0 });
    });
  },
);

// Every host, so a native Windows run exercises its own spawn failures. ENOENT
// emits error then a negative close; a file as cwd fails at spawn.
describe('finite Windows closure gate: spawn failures (every host)', () => {
  const rooted = (file: string): string => (HOST ? `/${file}` : file);
  const probe = (
    r: GitReadRunner,
    file: string,
    cwd = dir,
  ): Promise<GitReadOutput> =>
    r.run(
      { kind: 'git-version', executable: rooted(file) },
      {
        cwd: rooted(cwd),
        environment: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' }, // prettier-ignore
        deadlineAt: performance.now() + 10_000,
      },
    );

  // ENOENT emits 'error' a loop turn before the 'close' that closes its edge.
  it('is idle at a spawn failure only once its edge has closed', async () => {
    const witness = createWindowsClosureWitness();
    await witness.run(async () => {
      const r = createGitReadRunner({ os: 'win32' });
      await expect(probe(r, join(dir, 'missing-git'))).rejects.toThrow();
      expect(await r.whenIdle(AbortSignal.abort())).toBe('idle');
    });
    expect(witness.finalize()).toMatchObject({ started: 1, pending: 0 });
  });

  it.each(['none', 'missing', 'not-a-directory'])(
    'records a spawn failure (%s) before a successful probe',
    async (mode) => {
      const witness = createWindowsClosureWitness();
      await witness.run(async () => {
        const r = createGitReadRunner({ os: 'win32' });
        if (mode !== 'none')
          await expect(
            mode === 'missing'
              ? probe(r, join(dir, 'missing-git'))
              : probe(r, process.execPath, process.execPath),
          ).rejects.toThrow();
        expect(await probe(r, process.execPath)).toMatchObject({ code: 0 });
        expect(await r.whenIdle(AbortSignal.timeout(3000))).toBe('idle');
      });
      const report = witness.finalize();
      expect(report).toMatchObject({ started: mode === 'none' ? 1 : 2, pending: 0 }); // prettier-ignore
      expect(witness.accepts(report)).toBe(mode === 'none');
    },
  );
});

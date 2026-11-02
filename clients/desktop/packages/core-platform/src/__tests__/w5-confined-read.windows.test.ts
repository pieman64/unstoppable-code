import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import type { W5ConfinedFileReader } from '@canopy/core-runtime/node/w5/commit-log/worker-contract';
import {
  W5CommitLog,
  W5CommitLogRequestHandler,
  W5CommitRefusedError,
  anchorW5CaptureRoot,
} from '@canopy/core-runtime/node/w5/commit-log';
import { OWNED_CHILD_FILE } from '../supervision/owned-child';
import { windowsW5ConfinedFileReader } from '../w5-confined-read';

// Native Windows evidence for handle-confined W5 capture reads (CAN-5202).
// Off Windows nothing runs. On Windows the suite builds the owned-child addon
// unless CANOPY_OWNED_CHILD_ADDON names a prebuilt one, which
// CANOPY_OWNED_CHILD_ACCEPTANCE=1 requires. Symlink cases need Developer Mode
// (or the symlink privilege); junctions need none. Every race writes
// `[confined-read evidence]` lines to stderr.

const windows = process.platform === 'win32';
const windowsDescribe = windows ? describe : describe.skip;
const acceptance = process.env.CANOPY_OWNED_CHILD_ACCEPTANCE === '1';
const ROOT = path.resolve(__dirname, '../../../..');
const BUILD = path.join(ROOT, 'scripts', 'build-owned-child.mjs');
// Loaded addons stay mapped on Windows, so they live outside the deleted `dir`.
// Not `jest-*`: the owned-child suite prunes those scratch directories.
const NATIVE = path.join(ROOT, '.cache', 'native-owned-child');
const LIMIT = 1024 * 1024;
// Reading continues until the racer has completed MIN_SWAPS swaps (and the
// reads saw MIN_ATTEMPTS results and a refusal), bounded by RACE_MS.
// MIN_SWAPS puts 2 * 200 state transitions under a tight read loop. At the
// expected few milliseconds per swap it is reached in about a second, so
// RACE_MS is headroom for a slow disk or antivirus, not the usual length.
const RACE_MS = 20_000;
const MIN_ATTEMPTS = 500;
const MIN_SWAPS = 200;
// The racer stops itself this long after starting, even if never told to.
const RACER_MAX_MS = 25_000;
const STOP_WAIT_MS = 5_000;
const run = promisify(execFile);

// Shared counters: the test reads them live and sets STOP.
const STOP = 0;
const CYCLES = 1;
const SWAPPED = 2;
const FAILED = 3;
const COUNTERS = 4;

// Swaps `target` for a junction to `outside` and back until STOP or its
// deadline, holding each state for `holdMs` by spinning: Atomics.wait and
// timers round up to the 15.6 ms Windows tick. A failed step retries at once
// and is counted by step and errno code; a reader's open handle can fail a
// rename. Restoring retries until it succeeds. Posts the failure tally last.
const RACER = `
const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { target, parked, outside, counters, maxMs, holdMs } = workerData;
const [STOP, CYCLES, SWAPPED, FAILED] = [0, 1, 2, 3];
const count = new Int32Array(counters);
const deadline = Date.now() + maxMs;
const failures = {};
const fail = (step, error) => {
  const key = step + ':' + String((error && error.code) || 'unknown');
  failures[key] = (failures[key] || 0) + 1;
  Atomics.add(count, FAILED, 1);
};
const spin = (ms) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};
// rmdir removes a Windows junction; unlink removes a POSIX symlink.
const removeLink = () => {
  try { fs.rmdirSync(target); } catch { fs.unlinkSync(target); }
};
const restore = () => {
  for (;;) {
    try {
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      if (stat && stat.isSymbolicLink()) removeLink();
      fs.renameSync(parked, target);
      return true;
    } catch (error) {
      fail('restore', error);
      if (Date.now() > deadline + 5000) return false;
    }
  }
};
while (Atomics.load(count, STOP) === 0 && Date.now() < deadline) {
  Atomics.add(count, CYCLES, 1);
  try {
    fs.renameSync(target, parked);
  } catch (error) {
    fail('park', error);
    continue;
  }
  let linked = false;
  try {
    fs.symlinkSync(outside, target, 'junction');
    linked = true;
  } catch (error) {
    fail('junction', error);
  }
  spin(holdMs);
  if (!restore()) break;
  // A swap completes once the real directory is back.
  if (linked) Atomics.add(count, SWAPPED, 1);
  spin(holdMs);
}
parentPort.postMessage(failures);
`;

interface RaceCount {
  /** Attempts to park the real directory. */
  readonly cycles: number;
  /** Completed swaps: a junction in place of the directory, then the directory back. */
  readonly swapped: number;
  /** Failed steps, by `step:code`. */
  readonly failures: Record<string, number>;
  readonly failed: number;
}

let dir = '';
let root = '';
let outside = '';
let addon = '';
let reader: W5ConfinedFileReader;

function evidence(name: string, detail: unknown): void {
  process.stderr.write(
    `[confined-read evidence] ${name}: ${JSON.stringify(detail)}\n`,
  );
}

const read = (
  components: readonly string[],
  maxBytes = LIMIT,
  from = root,
): ReturnType<W5ConfinedFileReader['read']> =>
  reader.read(from, components, maxBytes);

const text = (value: Awaited<ReturnType<typeof read>>): string | null =>
  value.state === 'present' ? Buffer.from(value.bytes).toString('utf8') : null;

async function resolveAddon(): Promise<{ addon: string; prebuilt: boolean }> {
  const configured = process.env.CANOPY_OWNED_CHILD_ADDON;
  const prebuilt = configured ? path.resolve(ROOT, configured) : undefined;
  // Outside acceptance, a prebuilt addon from before CAN-5202 is rebuilt.
  if (
    prebuilt !== undefined &&
    existsSync(prebuilt) &&
    (acceptance || windowsW5ConfinedFileReader('win32', prebuilt)() !== null)
  )
    return { addon: prebuilt, prebuilt: true };
  if (acceptance)
    throw new Error(
      'Confined-read acceptance requires CANOPY_OWNED_CHILD_ADDON',
    );
  const scratch = path.join(NATIVE, `confined-read-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  const built = path.join(scratch, OWNED_CHILD_FILE);
  await run(process.execPath, [BUILD, '--out', built], {
    cwd: ROOT,
    windowsHide: true,
    timeout: 540_000,
    maxBuffer: 1 << 24,
  }).catch((error: unknown) => {
    // MSBuild reports compiler errors on stdout, which the error omits.
    const stdout: unknown = Reflect.get(Object(error), 'stdout');
    throw new Error(
      `build-owned-child failed: ${String(error)}\n${String(stdout).slice(-8000)}`,
    );
  });
  return { addon: built, prebuilt: false };
}

interface Race {
  /** Completed swaps so far, read live. */
  readonly swaps: () => number;
  readonly stop: () => Promise<RaceCount>;
}

// Races not yet stopped; afterEach stops them before deleting `dir`.
const active = new Set<Race>();

const within = <T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Starts a worker thread that swaps `target` with a junction to `to` until
 * stopped. A thread, not a process: its counters are live in shared memory,
 * and the kernel sees the same concurrent renames either way.
 */
function race(target: string, to: string): Race {
  const parked = `${target}-parked`;
  const counters = new SharedArrayBuffer(COUNTERS * 4);
  const count = new Int32Array(counters);
  const worker = new Worker(RACER, {
    eval: true,
    workerData: {
      target,
      parked,
      outside: to,
      counters,
      maxMs: RACER_MAX_MS,
      holdMs: 1,
    },
  });
  let failures: Record<string, number> = {};
  let crashed: unknown;
  worker.on('message', (message: unknown) => {
    if (typeof message === 'object' && message !== null)
      failures = Object.fromEntries(
        Object.entries(message).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      );
  });
  worker.on('error', (error: unknown) => {
    crashed = error;
  });
  const exited = once(worker, 'exit');
  let stopped: Promise<RaceCount> | undefined;
  const stop = async (): Promise<RaceCount> => {
    Atomics.store(count, STOP, 1);
    if ((await within(exited, STOP_WAIT_MS)) === 'timeout') {
      await worker.terminate();
      if ((await within(exited, STOP_WAIT_MS)) === 'timeout')
        throw new Error(`The racer for ${target} did not exit`);
    }
    // A terminated racer can stop between its steps; put the directory back.
    if (
      existsSync(parked) &&
      lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()
    )
      rmdirSync(target);
    if (existsSync(parked) && !existsSync(target)) renameSync(parked, target);
    if (crashed !== undefined)
      throw new Error(`The racer for ${target} failed`, { cause: crashed });
    return {
      cycles: Atomics.load(count, CYCLES),
      swapped: Atomics.load(count, SWAPPED),
      failed: Atomics.load(count, FAILED),
      failures,
    };
  };
  const handle: Race = {
    swaps: () => Atomics.load(count, SWAPPED),
    stop: () =>
      (stopped ??= stop().finally(() => {
        active.delete(handle);
      })),
  };
  active.add(handle);
  return handle;
}

/**
 * Whether reading under `swap` should go on: until the racer completed
 * MIN_SWAPS swaps, MIN_ATTEMPTS results came back and `refused()` holds, or
 * RACE_MS passed.
 */
function racing(
  swap: Race,
  started: number,
  attempts: number,
  refused: () => boolean,
): boolean {
  return (
    Date.now() < started + RACE_MS &&
    (swap.swaps() < MIN_SWAPS || attempts < MIN_ATTEMPTS || !refused())
  );
}

// Every result a confined read may give while a workspace directory is
// swapped: its parked moment reads as absent, and a rename's sharing
// violation as io.
const READ_OUTCOMES = ['present', 'absent', 'unsafe-path', 'io'];
// While an ancestor of the root is swapped only root-level results may come
// back, never one file's absence or unsafety: the root resolves to the decoy
// or is moved mid-walk (`root-changed`, even if it is back by the recheck), or
// is parked or mid-rename (`root-unavailable`).
const ROOT_SWAP_OUTCOMES = ['present', 'root-changed', 'root-unavailable'];

/** Every outcome in `tally` is one of `allowed`. */
function expectOnly(
  tally: Record<string, number>,
  allowed: readonly string[],
): void {
  expect(Object.keys(tally).filter((key) => !allowed.includes(key))).toEqual(
    [],
  );
}

/** Reads `components` from `from` while `swap` runs, until `refusal` was seen. */
async function readDuringRace(
  swap: Race,
  components: readonly string[],
  from: string,
  refusal: string,
): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  const started = Date.now();
  let attempts = 0;
  while (racing(swap, started, attempts, () => Boolean(tally[refusal]))) {
    attempts += 1;
    const result = await read(components, LIMIT, from);
    const key = result.state === 'unreadable' ? result.reason : result.state;
    tally[key] = (tally[key] ?? 0) + 1;
    // Only in-root bytes may ever come back.
    if (result.state === 'present') expect(text(result)).toBe('inside');
  }
  return tally;
}

windowsDescribe('Windows handle-confined W5 capture reads (CAN-5202)', () => {
  beforeAll(async () => {
    const resolved = await resolveAddon();
    addon = resolved.addon;
    const source = windowsW5ConfinedFileReader('win32', addon);
    const loaded = source();
    if (!loaded) throw new Error(`readConfinedFile did not load from ${addon}`);
    reader = loaded;
    evidence('suite', {
      node: process.version,
      addon,
      prebuilt: resolved.prebuilt,
    });
  }, 600_000);

  beforeEach(() => {
    dir = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'w5-confined-'));
    root = path.join(dir, 'workspaces');
    outside = path.join(dir, 'outside');
    mkdirSync(path.join(root, 'alpha'), { recursive: true });
    mkdirSync(outside);
    root = realpathSync.native(root);
    writeFileSync(path.join(root, 'index.json'), 'inside');
    writeFileSync(path.join(root, 'alpha', 'workspace.json'), 'inside');
    writeFileSync(path.join(outside, 'workspace.json'), 'outside secret');
    writeFileSync(path.join(outside, 'index.json'), 'outside secret');
  });

  afterEach(async () => {
    // A test that failed or timed out mid-race must not leave a racer running.
    const running: Race[] = Array.from(active);
    await Promise.allSettled(running.map((swap) => swap.stop()));
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  it('reads in-root files and reports absence, non-files and the byte bound', async () => {
    writeFileSync(path.join(root, 'index.json.bak'), '');
    mkdirSync(path.join(root, 'directory'));
    writeFileSync(path.join(root, 'plain'), 'not a directory');
    expect(text(await read(['index.json']))).toBe('inside');
    expect(text(await read(['alpha', 'workspace.json']))).toBe('inside');
    // Case-insensitive like every Win32 open, but the opened path must match.
    expect(await read(['ALPHA', 'workspace.json'])).toEqual({
      state: 'unreadable',
      reason: 'unsafe-path',
    });
    expect(await read(['index.json.bak'])).toEqual({
      state: 'present',
      bytes: Buffer.alloc(0),
    });
    expect(await read(['alpha', 'worktrees.json'])).toEqual({
      state: 'absent',
    });
    expect(await read(['beta', 'workspace.json'])).toEqual({ state: 'absent' });
    expect(await read(['directory'])).toEqual({
      state: 'unreadable',
      reason: 'not-file',
    });
    expect(await read(['plain', 'workspace.json'])).toEqual({
      state: 'unreadable',
      reason: 'io',
    });
    expect(text(await read(['index.json'], 'inside'.length))).toBe('inside');
    expect(await read(['index.json'], 'inside'.length - 1)).toEqual({
      state: 'too-large',
    });
    expect(await read(['index.json'], 0)).toEqual({ state: 'too-large' });
  });

  it('refuses a final-component file symlink, dangling symlink, directory symlink and junction', async () => {
    symlinkSync(
      path.join(outside, 'index.json'),
      path.join(root, 'index.json.bak'),
      'file',
    );
    symlinkSync(
      path.join(outside, 'missing'),
      path.join(root, 'dangling'),
      'file',
    );
    symlinkSync(outside, path.join(root, 'directory-link'), 'dir');
    symlinkSync(outside, path.join(root, 'junction'), 'junction');
    symlinkSync(
      path.join(outside, 'workspace.json'),
      path.join(root, 'alpha', 'worktrees.json'),
      'file',
    );
    for (const components of [
      ['index.json.bak'],
      ['dangling'],
      ['directory-link'],
      ['junction'],
      ['alpha', 'worktrees.json'],
    ])
      expect(await read(components)).toEqual({
        state: 'unreadable',
        reason: 'unsafe-path',
      });
  });

  it.each(['junction', 'dir'] as const)(
    'refuses a workspace directory that is a %s, even to an in-root directory',
    async (type) => {
      symlinkSync(outside, path.join(root, 'beta'), type);
      symlinkSync(path.join(root, 'alpha'), path.join(root, 'gamma'), type);
      for (const workspace of ['beta', 'gamma'])
        expect(await read([workspace, 'workspace.json'])).toEqual({
          state: 'unreadable',
          reason: 'unsafe-path',
        });
    },
  );

  it('refuses a root that is a junction or reached through one as changed, and a missing root as unavailable', async () => {
    const alias = path.join(dir, 'alias');
    symlinkSync(root, alias, 'junction');
    const parentAlias = path.join(dir, 'parent-alias');
    symlinkSync(dir, parentAlias, 'junction');
    for (const from of [alias, path.join(parentAlias, 'workspaces')])
      expect(await read(['index.json'], LIMIT, from)).toEqual({
        state: 'root-changed',
      });
    // A root that is now a file was replaced; one that is gone is unavailable.
    const plain = path.join(dir, 'plain-root');
    writeFileSync(plain, 'not a directory');
    expect(await read(['index.json'], LIMIT, plain)).toEqual({
      state: 'root-changed',
    });
    for (const from of [path.join(dir, 'missing'), path.join(plain, 'below')])
      expect(await read(['index.json'], LIMIT, from)).toEqual({
        state: 'root-unavailable',
      });
  });

  it('rejects invalid requests in the addon itself', () => {
    const loaded = { exports: {} };
    process.dlopen(loaded, addon);
    const native: unknown = loaded.exports;
    const readConfinedFile: unknown = Reflect.get(
      Object(native),
      'readConfinedFile',
    );
    if (typeof readConfinedFile !== 'function')
      throw new Error('The addon lacks readConfinedFile');
    const call = (...args: unknown[]): unknown =>
      Reflect.apply(readConfinedFile, native, args);
    const failure = (args: unknown[]): unknown => {
      try {
        call(...args);
        return 'no error';
      } catch (error) {
        return Reflect.get(Object(error), 'code');
      }
    };
    for (const args of [
      [root, ['..'], LIMIT],
      [root, ['.'], LIMIT],
      [root, ['alpha\\workspace.json'], LIMIT],
      [root, ['alpha/workspace.json'], LIMIT],
      [root, ['index.json:stream'], LIMIT],
      [root, ['index.json.'], LIMIT],
      [root, [''], LIMIT],
      [root, [], LIMIT],
      [root, ['a', 'b', 'c', 'd', 'e'], LIMIT],
      [root, ['index.json'], -1],
      [root, ['index.json'], 1.5],
      [root, ['index.json'], 64 * 1024 * 1024 + 1],
      ['workspaces', ['index.json'], LIMIT],
      [`\\\\?\\${root}`, ['index.json'], LIMIT],
      [root.replaceAll('\\', '/'), ['index.json'], LIMIT],
      [root, ['index.json']],
    ])
      expect([args, failure(args)]).toEqual([
        args,
        'ERR_CONFINED_READ_ARGUMENT',
      ]);
    // The device prefix the addon adds itself still reads.
    expect(
      Reflect.get(Object(call(root, ['index.json'], LIMIT)), 'state'),
    ).toBe('present');
  });

  it('never yields outside bytes while a workspace directory is repeatedly swapped for a junction', async () => {
    const swap = race(path.join(root, 'alpha'), outside);
    const tally = await readDuringRace(
      swap,
      ['alpha', 'workspace.json'],
      root,
      'unsafe-path',
    );
    const count = await swap.stop();
    evidence('workspace-swap racer', count);
    evidence('workspace-swap results', tally);
    expect(count.swapped).toBeGreaterThanOrEqual(MIN_SWAPS);
    expect(tally['unsafe-path']).toBeGreaterThan(0);
    expectOnly(tally, READ_OUTCOMES);
    expect(text(await read(['alpha', 'workspace.json']))).toBe('inside');
  }, 60_000);

  it('never yields outside bytes while an ancestor of the root is repeatedly swapped for a junction', async () => {
    // root = dir\tree\workspaces; the swap points `tree` at a decoy tree.
    const tree = path.join(dir, 'tree');
    const decoy = path.join(dir, 'decoy');
    mkdirSync(path.join(tree, 'workspaces'), { recursive: true });
    mkdirSync(path.join(decoy, 'workspaces'), { recursive: true });
    writeFileSync(path.join(tree, 'workspaces', 'index.json'), 'inside');
    writeFileSync(
      path.join(decoy, 'workspaces', 'index.json'),
      'outside secret',
    );
    const nested = realpathSync.native(path.join(tree, 'workspaces'));
    const swap = race(tree, decoy);
    const tally = await readDuringRace(
      swap,
      ['index.json'],
      nested,
      'root-changed',
    );
    const count = await swap.stop();
    evidence('ancestor-swap racer', count);
    evidence('ancestor-swap results', tally);
    expect(count.swapped).toBeGreaterThanOrEqual(MIN_SWAPS);
    expect(tally['root-changed']).toBeGreaterThan(0);
    expectOnly(tally, ROOT_SWAP_OUTCOMES);
    expect(text(await read(['index.json'], LIMIT, nested))).toBe('inside');
  }, 60_000);

  it('loads and reads in a worker thread beside a main-thread load, as the W5 worker does', async () => {
    const worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const loaded = { exports: {} };
      process.dlopen(loaded, workerData.addon);
      const result = loaded.exports.readConfinedFile(workerData.root, ['index.json'], 1024);
      parentPort.postMessage({
        state: result.state,
        text: result.bytes ? Buffer.from(result.bytes).toString('utf8') : null,
      });
      `,
      { eval: true, workerData: { addon, root } },
    );
    const exited = once(worker, 'exit');
    const messages: unknown[] = await once(worker, 'message');
    expect(await exited).toEqual([0]);
    expect(messages).toEqual([{ state: 'present', text: 'inside' }]);
    // The main thread's load still serves reads after the worker's env is torn down.
    expect(text(await read(['index.json']))).toBe('inside');
  });

  /** A failed capture, labelled by its error's class and reason. */
  interface Refusal {
    readonly refusal: string;
  }

  /**
   * `refused:<details.capture>` for the typed refusal (with the errno code of
   * a root that did not resolve, or `native` for one the reader could not
   * open); `untyped:<name>:<code or message>` for anything else, which the
   * read view could only treat as a failed capture.
   */
  function refusal(error: unknown): Refusal {
    if (error instanceof W5CommitRefusedError) {
      const reason = String(error.details.capture);
      const code: unknown = error.details.code;
      return {
        refusal:
          reason === 'root-unavailable'
            ? `refused:${reason}:${typeof code === 'string' ? code : 'native'}`
            : `refused:${reason}`,
      };
    }
    const code: unknown = Reflect.get(Object(error), 'code');
    return {
      refusal: `untyped:${error instanceof Error ? error.name : typeof error}:${
        typeof code === 'string'
          ? code
          : error instanceof Error
            ? error.message
            : String(error)
      }`,
    };
  }

  /** The capture root the host's first worker anchors for `trusted`. */
  async function anchor(trusted: string): Promise<string> {
    const anchored = await anchorW5CaptureRoot(trusted, undefined);
    if (anchored === undefined) throw new Error(`${trusted} did not anchor`);
    return anchored;
  }

  /**
   * Captures under `trusted` as the W5 worker does, confined to `captureRoot`
   * (anchored when the host started), with refusals as results.
   */
  async function capture(
    log: W5CommitLog,
    trusted: string,
    discoverWorkspaces: boolean,
    captureRoot: string,
  ): Promise<unknown> {
    const handler = new W5CommitLogRequestHandler(
      log,
      {
        dbPath: path.join(dir, 'commit-log.sqlite'),
        root: trusted,
        captureRoot,
      },
      { applied: [], recoveryRequired: [], interruptedReservations: 0 },
      {
        syncDirectory: (): Promise<never> =>
          Promise.reject(new Error('read-only')),
        writeFileDurably: (): Promise<never> =>
          Promise.reject(new Error('read-only')),
      },
      'win32',
      // The suite's one load, as the W5 worker keeps its first.
      () => reader,
    );
    return handler
      .run({
        id: 1,
        method: 'capture',
        args: [{ files: [{ kind: 'index' }], discoverWorkspaces }],
      })
      .catch(refusal);
  }

  const outcomes = (result: unknown): string[] => {
    const refused: unknown = Reflect.get(Object(result), 'refusal');
    if (typeof refused === 'string') return [refused];
    const files: unknown = Reflect.get(Object(result), 'files');
    if (!Array.isArray(files)) return ['malformed'];
    return files.map((file: unknown) => {
      const state = String(Reflect.get(Object(file), 'state'));
      return state === 'unreadable'
        ? String(Reflect.get(Object(file), 'reason'))
        : state;
    });
  };

  it('captures through the reader end to end, and never outside bytes', async () => {
    writeFileSync(
      path.join(root, 'index.json'),
      '{"workspaces":[{"id":"alpha"},{"id":"beta"}]}',
    );
    symlinkSync(outside, path.join(root, 'beta'), 'junction');
    const log = W5CommitLog.open(path.join(dir, 'commit-log.sqlite'));
    // A sibling of `dir`, so the junction to `dir` forms no cycle inside it.
    const parentAlias = `${dir}-alias`;
    try {
      const secret = Buffer.from('outside secret').toString('base64');
      const expected = [
        'present',
        'present',
        'absent',
        'unsafe-path',
        'unsafe-path',
      ];
      const result = await capture(log, root, true, await anchor(root));
      expect(Reflect.get(Object(result), 'discovery')).toBe('complete');
      expect(outcomes(result)).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain(secret);
      // A root that is, or sits under, a junction when the host anchors it
      // captures through the anchored realpath.
      const alias = path.join(dir, 'alias');
      symlinkSync(root, alias, 'junction');
      symlinkSync(dir, parentAlias, 'junction');
      const underAlias = path.join(parentAlias, 'workspaces');
      const anchored = await anchor(alias);
      expect(anchored).toBe(root);
      expect(await anchor(underAlias)).toBe(root);
      expect(outcomes(await capture(log, alias, true, anchored))).toEqual(
        expected,
      );
      expect(outcomes(await capture(log, underAlias, true, root))).toEqual(
        expected,
      );
      // Retargeted after anchoring, the root is refused before any read.
      rmdirSync(alias);
      symlinkSync(outside, alias, 'junction');
      const swapped = await capture(log, alias, true, anchored);
      expect(outcomes(swapped)).toEqual(['refused:root-changed']);
      expect(JSON.stringify(swapped)).not.toContain(secret);
    } finally {
      log.close();
      if (lstatSync(parentAlias, { throwIfNoEntry: false }))
        rmdirSync(parentAlias);
    }
  });

  it('never captures outside bytes while an ancestor of the root is repeatedly swapped for a junction', async () => {
    const tree = path.join(dir, 'tree');
    const decoy = path.join(dir, 'decoy');
    mkdirSync(path.join(tree, 'workspaces'), { recursive: true });
    mkdirSync(path.join(decoy, 'workspaces'), { recursive: true });
    writeFileSync(path.join(tree, 'workspaces', 'index.json'), 'inside');
    writeFileSync(
      path.join(decoy, 'workspaces', 'index.json'),
      'outside secret',
    );
    const nested = realpathSync.native(path.join(tree, 'workspaces'));
    // Anchored before the swaps start, as the host's first worker does.
    const anchored = await anchor(nested);
    const secret = Buffer.from('outside secret').toString('base64');
    const log = W5CommitLog.open(path.join(dir, 'commit-log.sqlite'));
    const tally: Record<string, number> = {};
    const swap = race(tree, decoy);
    try {
      const started = Date.now();
      let attempts = 0;
      // The refusal proves the capture saw the decoy and did not read it.
      const refusedDecoy = (): boolean =>
        Boolean(tally['refused:root-changed']);
      while (racing(swap, started, attempts, refusedDecoy)) {
        attempts += 1;
        const result = await capture(log, nested, false, anchored);
        expect(JSON.stringify(result)).not.toContain(secret);
        for (const outcome of outcomes(result))
          tally[outcome] = (tally[outcome] ?? 0) + 1;
      }
      const count = await swap.stop();
      evidence('capture ancestor-swap racer', count);
      evidence('capture ancestor-swap results', tally);
      expect(count.swapped).toBeGreaterThanOrEqual(MIN_SWAPS);
      expect(refusedDecoy()).toBe(true);
      // A full capture or a typed refusal of the whole query, never one
      // file's absence or unsafety: a root resolving to the decoy, before or
      // after realpath, or one mid-swap that did not resolve or open (ENOENT
      // while parked, an error code a rename leaves, or `native`).
      expectOnly(tally, [
        'present',
        'refused:root-changed',
        ...Object.keys(tally).filter((key) =>
          key.startsWith('refused:root-unavailable:'),
        ),
      ]);
      expect(outcomes(await capture(log, nested, false, anchored))).toEqual([
        'present',
      ]);
    } finally {
      log.close();
    }
  }, 60_000);

  it('captures from a data root under the user profile, spelled as the host spells it', async () => {
    // getWorkspacesRootDir(): join(os.homedir(), <brand dir>, 'workspaces'),
    // never resolved through realpath before it reaches the worker.
    const brand = mkdtempSync(path.join(homedir(), '.canopy-w5-confined-'));
    const log = W5CommitLog.open(path.join(dir, 'commit-log.sqlite'));
    try {
      const workspaces = path.join(brand, 'workspaces');
      mkdirSync(workspaces);
      writeFileSync(path.join(workspaces, 'index.json'), '{"workspaces":[]}');
      evidence('profile root', {
        root: workspaces,
        resolved: realpathSync.native(workspaces),
      });
      expect(
        outcomes(
          await capture(log, workspaces, true, await anchor(workspaces)),
        ),
      ).toEqual(['present']);
      // Another spelling, such as a drive letter's case, anchors to the same
      // root and captures.
      if (/^[A-Z]:\\/.test(workspaces)) {
        const lower = `${workspaces.charAt(0).toLowerCase()}${workspaces.slice(1)}`;
        expect(await anchor(lower)).toBe(await anchor(workspaces));
        expect(
          outcomes(await capture(log, lower, true, await anchor(lower))),
        ).toEqual(['present']);
      }
    } finally {
      log.close();
      rmSync(brand, { recursive: true, force: true });
    }
  });
});

import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as Runtime from '@canopy/core-runtime';
import {
  createOwnedChildServices,
  OwnedChildError,
} from '../supervision/owned-child';

const darwin = process.platform === 'darwin';
const darwinDescribe = darwin ? describe : describe.skip;
const BUILD = path.resolve(
  __dirname,
  '../../../../scripts/build-owned-child.mjs',
);
const MODULE = path.resolve(__dirname, '../supervision/owned-child.ts');
const ENV = { PATH: '/usr/bin:/bin' };
// `$1` receives the descendant PID; the descendant ignores SIGTERM.
const TREE = `trap '' TERM; /bin/sh -c 'trap "" TERM; n=0; while [ ! -f "$1" ] && [ "$n" -lt 600 ]; do /bin/sleep 0.05; n=$((n+1)); done' sh "$2" & echo $! > "$1";`;

let dir = '';
let addon = '';
/** Fixture PIDs; the fallback stop below only ever targets these. */
const fixtures = new Set<number>();
const stops = new Map<number, string>();
const rawCleanups = new Set<() => unknown>();
const children = new Set<Runtime.PlatformOwnedChild>();

function present(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), 'code') !== 'ESRCH';
  }
}

/** Independent observation; '' once the PID is gone (reaped, not a zombie). */
function ps(pid: number, column: 'stat' | 'pgid'): string {
  try {
    return execFileSync('/bin/ps', ['-o', `${column}=`, '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Already absent, not even a zombie: cleanup waits for the group to be reaped. */
function gone(pid: number): void {
  expect(ps(pid, 'stat')).toBe('');
  expect(present(pid)).toBe(false);
}

async function descendantOf(file: string): Promise<number> {
  let pid = 0;
  await until(() => {
    try {
      pid = Number(readFileSync(file, 'utf8').trim());
    } catch {
      pid = 0;
    }
    return pid > 1;
  });
  fixtures.add(pid);
  stops.set(pid, `${file}.stop`);
  return pid;
}

const services = (): Runtime.PlatformOwnedChildServices =>
  createOwnedChildServices({ os: 'darwin', nativePath: addon });

/** Spawns `sh -c "<TREE> <tail>"`; returns the owned root and its descendant. */
async function tree(
  tail: string,
): Promise<[Runtime.PlatformOwnedChild, number]> {
  const file = path.join(dir, `pid-${fixtures.size}-${Date.now()}`);
  const child = await services().spawn({
    executable: '/bin/sh',
    args: ['-c', `${TREE} ${tail}`, 'sh', file, `${file}.stop`],
    environment: ENV,
  });
  children.add(child);
  fixtures.add(child.pid);
  return [child, await descendantOf(file)];
}

async function rejection(work: () => unknown): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const typed = (code: string): unknown =>
  expect.objectContaining({ name: 'OwnedChildError', code });

const get = (value: unknown, key: string): unknown =>
  Reflect.get(Object(value), key);

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'owned-child-'));
  if (!darwin) return;
  // A per-suite output: parallel suites never share a build file.
  addon = path.join(dir, 'core-owned-child.node');
  execFileSync(process.execPath, [BUILD, '--out', addon], { stdio: 'pipe' });
}, 60_000);

afterEach(async () => {
  for (const child of Array.from(children))
    await child.terminate().catch(() => undefined);
  children.clear();
  // Fixture-owned files request self-exit; no post-reap PID is signal authority.
  stops.forEach((file) => writeFileSync(file, ''));
  rawCleanups.forEach((cleanup) => {
    try {
      cleanup();
    } catch {
      /* already released */
    }
  });
  rawCleanups.clear();
  await until(() => Array.from(fixtures).every((pid) => !present(pid)));
  stops.clear();
  fixtures.clear();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('unsupported hosts', () => {
  it.each(['linux', 'win32'] as const)(
    'rejects every %s spawn as capability_unavailable without loading',
    async (os) => {
      const owned = createOwnedChildServices({
        os,
        nativePath: '/missing.node',
      });
      const error = await rejection(() =>
        owned.spawn({ executable: '/bin/true', args: [], environment: {} }),
      );
      expect(error).toBeInstanceOf(OwnedChildError);
      expect(error).toEqual(typed('capability_unavailable'));
    },
  );

  it.each([
    ['missing', '/nonexistent/core-owned-child.node'],
    ['relative', 'core-owned-child.node'],
    ['not an addon', '/bin/sh'],
  ])('rejects a %s addon as capability_unavailable', async (_, nativePath) => {
    const owned = createOwnedChildServices({ os: 'darwin', nativePath });
    const error = await rejection(() =>
      owned.spawn({ executable: '/bin/true', args: [], environment: {} }),
    );
    expect(error).toEqual(typed('capability_unavailable'));
  });
});

darwinDescribe('darwin owned child', () => {
  it('holds an exited root until its TERM-ignoring group is gone', async () => {
    const [child, descendant] = await tree('exit 17');
    await expect(child.exited).resolves.toEqual({ code: 17, signal: null });
    // Root exited but unreaped: its PID, and so its group ID, stays reserved.
    expect(ps(child.pid, 'stat')).toMatch(/^Z/);
    expect(ps(descendant, 'pgid')).toBe(String(child.pid));
    expect(present(descendant)).toBe(true);

    // libuv reaps only its own children, never this root.
    for (let round = 0; round < 8; round++)
      await new Promise<void>((resolve, reject) =>
        spawn('/bin/sh', ['-c', 'exit 0'])
          .on('error', reject)
          .on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
          ),
      );
    expect(ps(child.pid, 'stat')).toMatch(/^Z/);

    await child.terminate();
    gone(descendant);
    expect(ps(child.pid, 'stat')).toBe('');
    await expect(child.terminate()).resolves.toBeUndefined();
    expect(thrown(() => child.commit())).toEqual(typed('failed_precondition'));
  });

  it('stops a running root together with its group', async () => {
    const [child, descendant] = await tree('wait');
    await child.terminate();
    await expect(child.exited).resolves.toEqual({
      code: null,
      signal: 'SIGKILL',
    });
    gone(descendant);
    expect(ps(child.pid, 'stat')).toBe('');
  });

  it('never stops a committed child and reaps it after a later exit', async () => {
    const [child, descendant] = await tree('wait');
    child.commit();
    child.commit();
    expect(await rejection(() => child.terminate())).toEqual(
      typed('failed_precondition'),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(present(child.pid) && present(descendant)).toBe(true);

    // The daemon's own later exit, simulated through fixture control.
    const stop = stops.get(descendant);
    if (!stop) throw new Error('missing fixture control');
    writeFileSync(stop, '');
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await until(() => ps(child.pid, 'stat') === '');
  });

  it('refuses to commit an exited root and rolls back its group', async () => {
    // Root exit between readiness and commit must not disown its group.
    const [child, descendant] = await tree('exit 0');
    await child.exited;
    expect(thrown(() => child.commit())).toEqual(typed('failed_precondition'));
    expect(present(descendant)).toBe(true);
    await child.terminate();
    gone(descendant);
    expect(ps(child.pid, 'stat')).toBe('');
  });

  it('restores default signal dispositions in the root', async () => {
    // Node ignores SIGPIPE; a shell cannot un-ignore an inherited ignore.
    const child = await services().spawn({
      executable: '/bin/sh',
      args: ['-c', 'kill -PIPE $$; exit 0'],
      environment: ENV,
    });
    children.add(child);
    await expect(child.exited).resolves.toEqual({
      code: null,
      signal: 'SIGPIPE',
    });
  });

  it('checks cancellation before any effect', async () => {
    const [child, descendant] = await tree('wait');
    const aborted = AbortSignal.abort();
    expect(() => child.commit(aborted)).toThrow();
    await expect(child.terminate(aborted)).rejects.toBe(aborted.reason);
    expect(present(child.pid) && present(descendant)).toBe(true);
    await child.terminate();
    gone(descendant);
  });

  it('serializes commit against a started stop', async () => {
    const [child, descendant] = await tree('wait');
    const first = child.terminate();
    const second = child.terminate();
    expect(thrown(() => child.commit())).toEqual(typed('failed_precondition'));
    await Promise.all([first, second]);
    gone(descendant);
    expect(ps(child.pid, 'stat')).toBe('');
  });

  it('keeps cleaning up after the caller stops waiting', async () => {
    const [child, descendant] = await tree('wait');
    const controller = new AbortController();
    const waiting = child.terminate(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBe(controller.signal.reason);
    await child.terminate();
    gone(descendant);
    expect(ps(child.pid, 'stat')).toBe('');
  });

  it('hands stdin and the exact environment over privately', async () => {
    const out = path.join(dir, 'handoff');
    const secret = JSON.stringify({ claim: 'x'.repeat(4000) });
    const child = await services().spawn({
      executable: '/bin/sh',
      args: ['-c', '/bin/cat > "$1"; /usr/bin/env > "$1.env"', 'sh', out],
      environment: { ...ENV, MARKER: 'stdin-v1' },
      stdin: secret,
    });
    children.add(child);
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await child.terminate();
    expect(readFileSync(out, 'utf8')).toBe(secret);
    const env = readFileSync(`${out}.env`, 'utf8');
    expect(env).toContain('MARKER=stdin-v1');
    expect(env).not.toContain('HOME=');
    expect(env).not.toContain(secret);
  });

  it.each<
    [
      string,
      Partial<Parameters<Runtime.PlatformOwnedChildServices['spawn']>[0]>,
    ]
  >([
    ['relative executable', { executable: 'sh' }],
    ['oversized stdin', { stdin: 'x'.repeat(4097) }],
    ['malformed environment', { environment: { 'A=B': 'c' } }],
    ['NUL argument', { args: ['\0'] }],
  ])('rejects a %s with no child', async (_, change) => {
    const error = await rejection(() =>
      services().spawn({
        executable: '/bin/sh',
        args: ['-c', 'exit 0'],
        environment: ENV,
        ...change,
      }),
    );
    expect(error).toEqual(typed('invalid_argument'));
  });

  it('rejects a spawn that creates no process', async () => {
    const error = await rejection(() =>
      services().spawn({
        executable: path.join(dir, 'missing'),
        args: [],
        environment: ENV,
      }),
    );
    expect(error).toEqual(typed('failed_precondition'));
  });

  it('binds native handles to the load that issued them', async () => {
    const load = (
      file: string,
    ): Record<string, (...args: unknown[]) => unknown> => {
      const module = { exports: {} };
      process.dlopen(module, file);
      return module.exports;
    };
    const copy = path.join(dir, 'second.node');
    copyFileSync(addon, copy);
    // Same file twice (two service compositions) and a separately built copy.
    const loads = [load(addon), load(addon), load(copy)];
    const handleOf = (
      native: Record<string, (...args: unknown[]) => unknown>,
      spawned: unknown,
    ): object => {
      fixtures.add(Number(get(spawned, 'pid')));
      const handle = get(spawned, 'handle');
      if (typeof handle !== 'object' || handle === null)
        throw new Error('no native handle');
      rawCleanups.add(() => native.rollbackSync(handle));
      return handle;
    };
    const handles = loads.map((native) =>
      handleOf(
        native,
        native.spawn('/bin/sleep', ['/bin/sleep', '30'], [], null),
      ),
    );
    const code = (run: () => unknown): unknown => {
      try {
        return run();
      } catch (error) {
        return get(error, 'code');
      }
    };
    loads.forEach((native, n) => {
      expect(code(() => native.stopGroup({}))).toBe('ERR_OWNED_CHILD_HANDLE');
      expect(code(() => native.stopGroup(42))).toBe('ERR_OWNED_CHILD_HANDLE');
      handles.forEach((handle, m) => {
        if (m !== n)
          expect(code(() => native.stopGroup(handle))).toBe(
            'ERR_OWNED_CHILD_HANDLE',
          );
      });
      // Later loads left earlier handles valid.
      expect(native.observe(handles[n])).toEqual({ state: 'running' });
    });
    loads.forEach((native, n) => {
      expect(native.rollbackSync(handles[n])).toBe(true);
      expect(code(() => native.stopGroup(handles[n]))).toBe(
        'ERR_OWNED_CHILD_HANDLE',
      );
      expect(code(() => native.observe(handles[n]))).toBe(
        'ERR_OWNED_CHILD_HANDLE',
      );
    });

    // Native refusal, independent of the adapter's own exit observation.
    const [native] = loads;
    const handle = handleOf(
      native,
      native.spawn('/bin/sh', ['/bin/sh', '-c', 'exit 0'], [], null),
    );
    await until(() => get(native.observe(handle), 'state') === 'exited');
    expect(code(() => native.commit(handle))).toBe('ERR_OWNED_CHILD_EXITED');
    expect(native.rollbackSync(handle)).toBe(true);
  });

  describe('host exit', () => {
    const HOST = `
      const [, , module, nativePath, file, tail, mode] = process.argv;
      const { createOwnedChildServices } = await import(module);
      const child = await createOwnedChildServices({ os: 'darwin', nativePath })
        .spawn({ executable: '/bin/sh', args: ['-c', ${JSON.stringify(TREE)} + ' ' + tail, 'sh', file, file + '.stop'], environment: { PATH: '/usr/bin:/bin' } });
      process.stdout.write(String(child.pid));
      const { existsSync } = await import('node:fs');
      while (!existsSync(file)) await new Promise((r) => setTimeout(r, 10));
      if (mode.startsWith('commit')) child.commit();
      if (mode.endsWith('exit')) process.exit(3);
      if (mode === 'owned-throw') throw new Error('host failed');
      if (mode === 'owned') await child.exited;
    `;

    async function host(
      tail: string,
      mode: string,
    ): Promise<{ code: number | null; root: number; descendant: number }> {
      const script = path.join(dir, 'host.mjs');
      const file = path.join(dir, `host-${mode}`);
      writeFileSync(script, HOST);
      const args = [
        script,
        pathToFileURL(MODULE).href,
        addon,
        file,
        tail,
        mode,
      ];
      const [code, stdout] = await new Promise<[number | null, string]>(
        (resolve) => {
          execFile(
            process.execPath,
            args,
            { env: ENV, timeout: 10_000 },
            (error, out) =>
              resolve([error ? Number(Reflect.get(error, 'code')) : 0, out]),
          );
        },
      );
      const root = Number(stdout);
      fixtures.add(root);
      return { code, root, descendant: await descendantOf(file) };
    }

    it.each([
      ['process.exit', 'wait', 'owned-exit', 3],
      ['an uncaught error', 'wait', 'owned-throw', 1],
      ['a natural end after root exit', 'exit 17', 'owned', 0],
    ])('rolls back an uncommitted group on %s', async (_, tail, mode, exit) => {
      const { code, root, descendant } = await host(tail, mode);
      expect(code).toBe(exit);
      gone(descendant);
      gone(root);
    });

    it.each(['commit', 'commit-exit'])(
      'leaves a committed daemon running after %s',
      async (mode) => {
        const { code, root, descendant } = await host('wait', mode);
        expect(code).toBe(mode === 'commit' ? 0 : 3);
        expect(ps(root, 'stat')).toMatch(/^S/);
        expect(present(descendant)).toBe(true);
        const stop = stops.get(descendant);
        if (!stop) throw new Error('missing fixture control');
        writeFileSync(stop, '');
        await until(() => !present(root) && !present(descendant));
      },
    );
  });
});

describe('controlled native failures', () => {
  const listeners = new Set<(code: number) => void>();
  beforeEach(() => {
    jest.useFakeTimers();
    process.listeners('exit').forEach((listener) => listeners.add(listener));
  });
  afterEach(() => {
    process.listeners('exit').forEach((listener) => {
      if (!listeners.has(listener)) process.removeListener('exit', listener);
    });
    listeners.clear();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  type ControlledNative = {
    spawn(this: void): { handle: object; pid: number };
    observe(this: void): {
      state: 'running' | 'exited' | 'lost';
      code?: number;
      signal?: null;
    };
    stopGroup(this: void): boolean;
    members(this: void): number;
    release(this: void): boolean;
    commit(this: void): boolean;
    rollbackSync(this: void): boolean;
    rollbackUndelivered(this: void): boolean;
  };
  function backend(): {
    native: jest.Mocked<ControlledNative>;
    services: Runtime.PlatformOwnedChildServices;
    state(next: 'running' | 'exited' | 'lost'): void;
  } {
    let state: 'running' | 'exited' | 'lost' = 'running';
    const native = {
      spawn: jest.fn(() => ({ handle: {}, pid: 101 })),
      observe: jest.fn(() =>
        state === 'exited' ? { state, code: 17, signal: null } : { state },
      ),
      stopGroup: jest.fn(() => {
        state = 'exited';
        return true;
      }),
      members: jest.fn(() => 0),
      release: jest.fn(() => true),
      commit: jest.fn(() => true),
      rollbackSync: jest.fn(() => true),
      rollbackUndelivered: jest.fn(() => true),
    };
    jest.spyOn(process, 'dlopen').mockImplementation((module) => {
      Object.assign(module, { exports: native });
    });
    return {
      native,
      services: createOwnedChildServices({
        os: 'darwin',
        nativePath: '/controlled/backend.node',
      }),
      state: (next: typeof state): void => {
        state = next;
      },
    };
  }

  const request = {
    executable: '/controlled/child',
    args: [],
    environment: {},
  };

  it('rejects committed exit if native reap fails instead of reporting successful exit', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    child.commit();
    b.state('exited');
    b.native.release.mockImplementation(() => {
      throw new Error('lost reservation');
    });
    const result = expect(child.exited).rejects.toMatchObject({
      code: 'unavailable',
    });
    await jest.advanceTimersByTimeAsync(20);
    await result;
    expect(b.native.stopGroup).not.toHaveBeenCalled();
  });

  it('does not signal after a lost reservation or simulated reused identity', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('lost');
    await expect(child.terminate()).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(b.native.stopGroup).not.toHaveBeenCalled();
    expect(b.native.release).not.toHaveBeenCalled();
  });

  it('keeps cleanup unconfirmed on enumeration failure and can retry the same owner', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('exited');
    b.native.release.mockImplementationOnce(() => {
      throw new Error('enumeration failed');
    });
    await expect(child.terminate()).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(b.native.stopGroup).not.toHaveBeenCalled();
    await expect(child.terminate()).resolves.toBeUndefined();
  });

  it('retries a transient native group enumeration failure within the same cleanup', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.native.release.mockImplementationOnce(() => {
      throw Object.assign(new Error('group listing changed'), {
        code: 'ERR_OWNED_CHILD_ENUMERATION',
      });
    });
    const result = child.terminate().then(
      () => null,
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(30);
    expect(await result).toBeNull();
    expect(b.native.release).toHaveBeenCalledTimes(2);
    expect(b.native.stopGroup).toHaveBeenCalledTimes(2);
    await expect(child.terminate()).resolves.toBeUndefined();
  });

  it('bounds persistent native enumeration failures without releasing ownership', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('exited');
    b.native.release.mockImplementation(() => {
      throw Object.assign(new Error('group listing unavailable'), {
        code: 'ERR_OWNED_CHILD_ENUMERATION',
      });
    });
    const result = child.terminate().then(
      () => null,
      (error: unknown) => error,
    );
    await jest.advanceTimersByTimeAsync(1_990);
    expect(b.native.release.mock.calls.length).toBeGreaterThan(1);
    expect(thrown(() => child.commit())).toEqual(typed('failed_precondition'));
    await jest.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({
      code: 'unavailable',
      message: 'Owned child cleanup did not complete.',
    });
    b.native.release.mockReturnValue(true);
    await expect(child.terminate()).resolves.toBeUndefined();
  });

  it('stops retrying enumeration if the root reservation is lost', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('exited');
    b.native.release.mockImplementationOnce(() => {
      throw Object.assign(new Error('group listing changed'), {
        code: 'ERR_OWNED_CHILD_ENUMERATION',
      });
    });
    const result = child.terminate().then(
      () => null,
      (error: unknown) => error,
    );
    b.state('lost');
    await jest.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({
      code: 'unavailable',
      message: 'Owned child ownership was lost.',
    });
    expect(b.native.release).toHaveBeenCalledTimes(1);
    expect(b.native.stopGroup).toHaveBeenCalledTimes(1);
  });

  it('keeps shared cleanup running when one caller aborts during enumeration retry', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('exited');
    b.native.release.mockImplementationOnce(() => {
      throw Object.assign(new Error('group listing changed'), {
        code: 'ERR_OWNED_CHILD_ENUMERATION',
      });
    });
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const cancelled = expect(child.terminate(controller.signal)).rejects.toBe(
      reason,
    );
    const shared = child.terminate();
    controller.abort(reason);
    await cancelled;
    expect(b.native.release).toHaveBeenCalledTimes(1);
    expect(thrown(() => child.commit())).toEqual(typed('failed_precondition'));
    await jest.advanceTimersByTimeAsync(10);
    await expect(shared).resolves.toBeUndefined();
    expect(b.native.release).toHaveBeenCalledTimes(2);
    expect(b.native.stopGroup).toHaveBeenCalledTimes(1);
  });

  it.each([
    'ERR_OWNED_CHILD_LOST',
    'ERR_OWNED_CHILD_HANDLE',
    'ERR_OWNED_CHILD_CLEANUP',
  ])('does not retry a non-enumeration release error: %s', async (code) => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('exited');
    b.native.release.mockImplementationOnce(() => {
      throw Object.assign(new Error('private native detail'), { code });
    });
    await expect(child.terminate()).rejects.toMatchObject({
      code: 'unavailable',
      message:
        code === 'ERR_OWNED_CHILD_CLEANUP'
          ? 'Owned child cleanup did not complete.'
          : 'Owned child ownership was lost.',
    });
    expect(b.native.release).toHaveBeenCalledTimes(1);
    expect(b.native.stopGroup).not.toHaveBeenCalled();
    await expect(child.terminate()).resolves.toBeUndefined();
  });

  it('reports the native cleanup deadline without releasing an unconfirmed group', async () => {
    const b = backend();
    const child = await b.services.spawn(request);
    b.state('exited');
    b.native.release.mockReturnValue(false);
    const result = expect(child.terminate()).rejects.toMatchObject({
      code: 'unavailable',
    });
    await jest.advanceTimersByTimeAsync(2_010);
    await result;
    b.native.release.mockReturnValue(true);
    await child.terminate();
  });

  it('retains undelivered native records for host-exit rollback without touching delivered children', async () => {
    const b = backend();
    b.native.spawn.mockImplementation(() => {
      throw Object.assign(new Error('private detail'), {
        code: 'ERR_OWNED_CHILD_CLEANUP',
      });
    });
    await expect(b.services.spawn(request)).rejects.toMatchObject({
      code: 'unavailable',
    });
    process
      .listeners('exit')
      .filter((listener) => !listeners.has(listener))
      .forEach((listener) => listener(0));
    expect(b.native.rollbackUndelivered).toHaveBeenCalledTimes(1);
    expect(b.native.stopGroup).not.toHaveBeenCalled();
  });
});

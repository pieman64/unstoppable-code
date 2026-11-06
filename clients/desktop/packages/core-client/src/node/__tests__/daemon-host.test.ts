import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createPlatformEndpointServices,
  createOwnedChildServices,
  createPlatformServices,
  WINDOWS_PROCESS_FILE,
} from '@canopy/core-platform';
import { CanopyClientError } from '../../errors';
import {
  createCanopyDaemonHostLaunch,
  type CanopyDaemonHostLaunch,
  type CanopyDaemonHostLaunchOptions,
  type CanopyDaemonMigrationLaunch,
} from '../index';

// Real files; native child ownership exists on Darwin, Linux and Windows.
// Windows uses the prebuilt addon (CANOPY_OWNED_CHILD_ADDON, else the
// build:owned-child default) and the identity helper: a loaded addon stays
// mapped, so it is never built into a deleted temp directory.
const windows = process.platform === 'win32';
const os =
  process.platform === 'darwin' ? 'darwin' : windows ? 'win32' : 'linux';
const ROOT = resolve(__dirname, '../../../../..');
const HELPER = join(ROOT, '.cache/bin/win32-x64', WINDOWS_PROCESS_FILE);
const native = createPlatformServices(
  os,
  createPlatformEndpointServices(os),
  windows ? { windowsProcessPath: HELPER } : {},
);
const signal = new AbortController().signal;
const SECRET = 'a'.repeat(64);
const node = process.execPath;
let nativePath = '';
let nativeDirectory = '';
let root = '';
let runtime = '';
let endpoint: { kind: 'socket' | 'pipe'; path: string } = {
  kind: 'socket',
  path: '',
};

/** The prebuilt Windows addon, building the default output only when absent. */
function windowsAddon(): string {
  const configured = process.env.CANOPY_OWNED_CHILD_ADDON;
  const addon = configured
    ? resolve(ROOT, configured)
    : join(ROOT, '.cache/native-owned-child/win32-x64/core-owned-child.node');
  if (!existsSync(addon)) {
    if (configured) throw new Error(`Missing owned-child addon ${addon}`);
    execFileSync(
      process.execPath,
      [join(ROOT, 'scripts/build-owned-child.mjs')],
      {
        cwd: ROOT,
        windowsHide: true,
      },
    );
  }
  if (!existsSync(HELPER))
    execFileSync(
      process.execPath,
      [join(ROOT, 'scripts/build-windows-process-identity.mjs')],
      { cwd: ROOT, windowsHide: true },
    );
  return addon;
}

/** The start identity of a live process, for exit checks that survive PID reuse. */
async function identityOf(pid: number): Promise<string> {
  const observed = await native.supervision.inspectProcess({ pid });
  if (observed.state !== 'running')
    throw new Error(`process ${pid} is ${observed.state}`);
  return observed.startIdentity;
}

/** Gone: no process, or another one, under the PID; polls up to `ms`. */
async function goneWithin(
  pid: number,
  startIdentity: string,
  ms = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const observed = await native.supervision.inspectProcess({ pid });
    if (
      observed.state === 'absent' ||
      (observed.state === 'running' && observed.startIdentity !== startIdentity)
    )
      return true;
    if (Date.now() > deadline) return false;
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** Polls for a PID file a fixture writes once it is ready. */
async function pidFrom(file: string, ms = 20_000): Promise<number> {
  const deadline = Date.now() + ms;
  for (;;) {
    const pid = Number(await fs.readFile(file, 'utf8').catch(() => ''));
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    if (Date.now() > deadline) throw new Error(`no PID in ${file}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

/**
 * Root source spawning a detached Node leaf. libuv's kill-on-close job takes
 * only attached children, so the leaf sits in the owned job alone and outlives
 * its parent: only owned-job cleanup ends it. It writes its PID once its stop
 * watch runs and ends itself on the stop file or after a minute.
 */
const detachedLeaf = (pidFile: string, stopFile: string): string => {
  const leaf = `const fs=require('fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopFile)}))process.exit(0)},25);setTimeout(()=>process.exit(70),60000);fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid))`;
  return `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore',detached:true,windowsHide:true});`;
};

const host = (
  overrides: Partial<CanopyDaemonHostLaunchOptions> = {},
): CanopyDaemonHostLaunch =>
  createCanopyDaemonHostLaunch({
    dataRoot: root,
    runtimeMode: 'dev',
    executable: node,
    platform: os,
    supervision: native.supervision,
    ownedChildren: createOwnedChildServices({ os, nativePath }),
    environmentSource: { ...process.env, SENTINEL_SECRET: 'env-leak' },
    prepareRuntime: async () => {
      await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
    },
    expectedEndpoint: endpoint,
    verifyPrivateFile: () => Promise.resolve(),
    ...overrides,
  });

const publish = async (
  fields: object = {},
): Promise<{ raw: object; tokenRef: string }> => {
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  const tokenRef = join(runtime, `core-${randomUUID()}.token`);
  await fs.writeFile(tokenRef, SECRET, { mode: 0o600 });
  const raw = { version: 1, pid: 1, endpoint, tokenRef, ...fields };
  await fs.writeFile(join(runtime, 'core.json'), JSON.stringify(raw));
  return { raw, tokenRef };
};

describe('daemon host', () => {
  beforeAll(async () => {
    if (windows) {
      nativePath = windowsAddon();
      return;
    }
    nativeDirectory = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), 'daemon-host-native-')),
    );
    nativePath = join(nativeDirectory, 'core-owned-child.node');
    execFileSync(process.execPath, [
      resolve('scripts/build-owned-child.mjs'),
      '--out',
      nativePath,
    ]);
  }, 600_000);
  afterAll(async () => {
    if (nativeDirectory)
      await fs.rm(nativeDirectory, { recursive: true, force: true });
  });
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'daemon-host-')));
    runtime = join(root, 'runtime');
    endpoint = windows
      ? { kind: 'pipe', path: `\\\\.\\pipe\\daemon-host-${randomUUID()}` }
      : { kind: 'socket', path: join(runtime, 'core.sock') };
  });
  afterEach(() =>
    fs.rm(root, { recursive: true, force: true, maxRetries: 10 }),
  );
  // Directory links need no privilege on Windows as junctions.
  const directoryLink = windows ? 'junction' : 'dir';

  it('passes the W5 host switch and pre-spawn step to every launch, and neither by default', () => {
    const beforeSpawn = {
      timeoutMs: 60_000,
      run: (): Promise<void> => Promise.resolve(),
    };
    const launch = host({ w5Host: true, beforeSpawn });
    expect(launch.daemon).toEqual({ executable: node, w5Host: true });
    expect(launch.beforeSpawn).toBe(beforeSpawn);
    const plain = host();
    expect(plain.daemon).toEqual({ executable: node });
    expect(plain).not.toHaveProperty('beforeSpawn');
    expect(host({ w5Host: false }).daemon).toEqual({ executable: node });
    // A trusted spawn request changes neither root binding nor discovery ports.
    expect(launch.dataRootHash).toBe(plain.dataRootHash);
    expect(launch.dataRoot).toBe(plain.dataRoot);
  });

  it('prepares the runtime before reading, and reports only absence as null', async () => {
    const { dataRootHash, ports } = host();
    expect(dataRootHash).toBe(createHash('sha256').update(root).digest('hex'));
    await expect(ports.descriptor.read(signal)).resolves.toBeNull();
    const { raw, tokenRef } = await publish();
    await expect(ports.descriptor.read(signal)).resolves.toEqual(raw);
    await expect(ports.descriptor.readToken(tokenRef, signal)).resolves.toBe(
      SECRET,
    );
  });

  it('fails closed on symlinked, foreign, or unverifiable references without deleting them', async () => {
    const { descriptor } = host().ports;
    const valid = await publish();
    const elsewhere = join(root, 'elsewhere.json');
    await fs.rename(join(runtime, 'core.json'), elsewhere);
    await fs.symlink(elsewhere, join(runtime, 'core.json'));
    const linkedToken = join(runtime, `core-${randomUUID()}.token`);
    await fs.symlink(valid.tokenRef, linkedToken);
    const rejected = await Promise.allSettled([
      descriptor.read(signal),
      descriptor.readToken(linkedToken, signal),
      descriptor.readToken(join(root, `core-${randomUUID()}.token`), signal),
    ]);
    for (const fields of [
      { endpoint: { kind: 'socket', path: join(root, 'other.sock') } },
      { tokenRef: join(root, `core-${randomUUID()}.token`) },
      { tokenRef: join(runtime, 'core-not-a-uuid.token') },
    ]) {
      await fs.rm(join(runtime, 'core.json'));
      await publish(fields);
      rejected.push(...(await Promise.allSettled([descriptor.read(signal)])));
    }
    const insecure = host({
      verifyPrivateFile: () => Promise.reject(new Error('insecure')),
    }).ports.descriptor;
    rejected.push(
      ...(await Promise.allSettled([
        insecure.read(signal),
        insecure.readToken(valid.tokenRef, signal),
      ])),
    );
    for (const result of rejected) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected')
        expect(result.reason).toBeInstanceOf(CanopyClientError);
    }
    await expect(fs.readFile(elsewhere, 'utf8')).resolves.toBe(
      JSON.stringify(valid.raw),
    );
    await expect(fs.readFile(valid.tokenRef, 'utf8')).resolves.toBe(SECRET);
  });

  it('maps inspection to start identity and fails typed when unverifiable', async () => {
    const self = host().ports.supervisor.inspectProcess(process.pid, signal);
    expect(typeof (await self)?.startIdentity).toBe('string');
    const supervision = {
      ...native.supervision,
      inspectProcess: (): Promise<{ state: 'unverifiable'; reason: string }> =>
        Promise.resolve({ state: 'unverifiable' as const, reason: '/secret' }),
    };
    const failure = host({ supervision }).ports.supervisor.inspectProcess(
      process.pid,
      signal,
    );
    await expect(failure).rejects.toThrow(CanopyClientError);
    await expect(failure).rejects.not.toThrow('/secret');
  });

  it.each(['before', 'during'])(
    'rejects runtime replacement %s a token read without leaking the replacement token',
    async (when) => {
      const { tokenRef } = await publish();
      const replacement = join(root, 'replacement');
      await fs.mkdir(replacement, { mode: 0o700 });
      await fs.writeFile(
        join(replacement, tokenRef.slice(runtime.length + 1)),
        'b'.repeat(64),
        { mode: 0o600 },
      );
      const swap = async (): Promise<void> => {
        await fs.rename(runtime, join(root, 'original-runtime'));
        await fs.symlink(replacement, runtime, directoryLink);
      };
      const { descriptor } = host({
        verifyPrivateFile: async (file) => {
          if (when === 'during' && file === tokenRef) await swap();
        },
      }).ports;
      await descriptor.read(signal);
      if (when === 'before') await swap();
      await expect(
        descriptor.readToken(tokenRef, signal),
      ).rejects.toMatchObject({ payload: { kind: 'failed_precondition' } });
      await expect(
        fs.readFile(
          join(root, 'original-runtime', tokenRef.slice(runtime.length + 1)),
          'utf8',
        ),
      ).resolves.toBe(SECRET);
    },
  );

  // Darwin and Linux share these native cases; Windows registers its own
  // variants (below), so no OS reports another's cases as skipped.
  const posixIt = windows ? undefined : it;

  posixIt?.(
    'hands the claim to a real child over stdin, never argv or env',
    async () => {
      const out = join(root, 'child.txt');
      const script = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('fs').writeFileSync(process.argv[1],[s,process.env.CANOPY_DAEMON_CLAIM_HANDOFF??'-',JSON.stringify([process.argv,process.env])].join('\\n')))`;
      const handle = { claimId: 'bearer-claim-secret', dataRoot: root };
      const { supervisor } = host().ports;
      const run = async (claimHandle?: object): Promise<string[]> => {
        const command = { executable: node, args: ['-e', script, out], signal };
        const child = await supervisor.spawnDaemon({ ...command, claimHandle });
        await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
        await supervisor.terminateDaemon(child, signal);
        return (await fs.readFile(out, 'utf8')).split('\n');
      };
      const [stdin = '', marker, visible] = await run(handle);
      const received: unknown = JSON.parse(stdin);
      expect(received).toEqual(handle);
      expect(marker).toBe('stdin-v1');
      expect(visible).not.toContain('bearer-claim-secret');
      expect(visible).not.toContain('env-leak');
      expect((await run()).slice(0, 2)).toEqual(['', '-']);
    },
  );

  it('rejects before any child exists for missing or foreign executables and oversized handles', async () => {
    const missing = join(
      root,
      windows ? 'missing-daemon.exe' : 'missing-daemon',
    );
    const command = { executable: node, args: [], signal };
    const { supervisor } = host({ executable: missing }).ports;
    await expect(
      supervisor.spawnDaemon({ ...command, executable: missing }),
    ).rejects.toMatchObject({
      payload: { kind: 'failed_precondition' },
    });
    await expect(supervisor.spawnDaemon(command)).rejects.toThrow(
      CanopyClientError,
    );
    await expect(
      host().ports.supervisor.spawnDaemon({
        ...command,
        claimHandle: { padding: 'x'.repeat(4096) },
      }),
    ).rejects.toThrow(CanopyClientError);
  });

  posixIt?.(
    'stops a child whose startup is cancelled after spawn resolves',
    async () => {
      const controller = new AbortController();
      const { supervisor } = host().ports;
      const child = await supervisor.spawnDaemon({
        executable: node,
        args: ['-e', 'setInterval(()=>{},1000)'],
        signal: controller.signal,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        controller.abort();
        await expect(
          Promise.race([
            child.exited,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('cancelled child survived')),
                4000,
              );
            }),
          ]),
        ).resolves.toMatchObject({ signal: 'SIGKILL' });
      } finally {
        clearTimeout(timer);
        await supervisor.terminateDaemon(child, new AbortController().signal);
      }
    },
  );

  posixIt?.each([
    ['obeys', 'setInterval(()=>{},1e3)'],
    ['ignores', ''],
  ])(
    'stops the owned tree when the root %s TERM and a grandchild ignores it, within a bound',
    async (_label, rootTail) => {
      const pidFile = join(root, 'grandchild.pid');
      const ignoreTerm = `process.on('SIGTERM',()=>{});setInterval(()=>{},1e3);`;
      // The grandchild reports its PID only once its TERM handler is installed.
      const grandchild = `${ignoreTerm}require('fs').writeFileSync(process.argv[1],String(process.pid))`;
      const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)},process.argv[1]],{stdio:'ignore'});${rootTail || ignoreTerm}`;
      const { supervisor } = host().ports;
      const args = ['-e', script, pidFile];
      const child = await supervisor.spawnDaemon({
        executable: node,
        args,
        signal,
      });
      let pid = 0;
      while (!pid)
        pid = Number(await fs.readFile(pidFile, 'utf8').catch(() => 0));
      const started = performance.now();
      await supervisor.terminateDaemon(child, signal);
      await child.exited;
      expect(performance.now() - started).toBeLessThan(5_000);
      // Inspection reports an unreaped zombie as absent: a container's
      // non-reaping PID 1 may keep the orphaned grandchild as one on Linux.
      const alive = async (): Promise<boolean> =>
        (await native.supervision.inspectProcess({ pid })).state !== 'absent';
      for (let i = 0; i < 50 && (await alive()); i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await alive()).toBe(false);
    },
  );

  it('rejects a forged child before touching unrelated process ownership', async () => {
    const supervisor = host().ports.supervisor;
    const unrelated = {
      pid: process.pid,
      exited: Promise.resolve({ code: 0, signal: null }),
    };
    await expect(
      supervisor.terminateDaemon(unrelated, signal),
    ).rejects.toMatchObject({ payload: { kind: 'failed_precondition' } });
    expect(() => supervisor.commitDaemon?.(unrelated, signal)).toThrow(
      CanopyClientError,
    );
  });

  it('preserves a typed native ownership limitation without falling back to Node spawn', async () => {
    const supervisor = host({
      ownedChildren: {
        spawn: () =>
          Promise.reject(
            Object.assign(new Error('private backend detail'), {
              code: 'capability_unavailable',
            }),
          ),
      },
    }).ports.supervisor;
    await expect(
      supervisor.spawnDaemon({ executable: node, args: [], signal }),
    ).rejects.toMatchObject({
      payload: {
        kind: 'capability_unavailable',
        message: 'Core child ownership is unavailable.',
      },
    });
  });

  it('reports an unconfirmed partial spawn without allowing claim release', async () => {
    const supervisor = host({
      ownedChildren: {
        spawn: () =>
          Promise.reject(
            Object.assign(new Error('private native detail'), {
              code: 'unavailable',
            }),
          ),
      },
    }).ports.supervisor;
    await expect(
      supervisor.spawnDaemon({ executable: node, args: [], signal }),
    ).rejects.toMatchObject({
      cleanupUnconfirmed: true,
      payload: { kind: 'unavailable', message: 'Core cleanup failed.' },
    });
  });

  posixIt?.(
    'cleans a native root that exits before its handle is delivered to the host',
    async () => {
      const pidFile = join(root, 'delayed-child.pid');
      const stopFile = join(root, 'private-stop');
      const code = `setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(stopFile)}))process.exit(0)},25);process.on('SIGTERM',()=>{});process.send('ready')`;
      const script = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(code)}],{stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>{require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.exit(17)});`;
      const services = createOwnedChildServices({ os, nativePath });
      const supervisor = host({
        ownedChildren: {
          spawn: async (request) => {
            const child = await services.spawn(request);
            await child.exited;
            return child;
          },
        },
      }).ports.supervisor;
      const child = await supervisor.spawnDaemon({
        executable: node,
        args: ['-e', script],
        signal,
      });
      const descendant = Number(await fs.readFile(pidFile, 'utf8'));
      try {
        expect(() => supervisor.commitDaemon?.(child, signal)).toThrow();
        await supervisor.terminateDaemon(child, signal);
        await supervisor.terminateDaemon(child, signal);
        await expect(
          native.supervision.inspectProcess({ pid: child.pid }),
        ).resolves.toEqual({ state: 'absent' });
        await expect(
          native.supervision.inspectProcess({ pid: descendant }),
        ).resolves.toEqual({ state: 'absent' });
      } finally {
        await fs.writeFile(stopFile, '');
        await supervisor.terminateDaemon(child, signal);
      }
    },
  );
  it('hands only the private per-launch bearer to the Electron migration adapter on stdin', async () => {
    const child = {
      pid: 123,
      exited: new Promise<{ code: number | null; signal: string | null }>(
        () => undefined,
      ),
      commit: jest.fn(),
      terminate: jest.fn(() => Promise.resolve()),
    };
    const spawn = jest.fn<
      ReturnType<CanopyDaemonMigrationLaunch['spawn']>,
      Parameters<CanopyDaemonMigrationLaunch['spawn']>
    >(() => Promise.resolve(child));
    const ordinarySpawn = jest.fn(() => Promise.resolve(child));
    const launch = host({
      ownedChildren: { spawn: ordinarySpawn },
      migration: { spawn },
    });
    expect(launch.daemon.migrationChannel).toBe(true);
    const claimHandle = { opaque: 'private-claim' };
    const daemon = await launch.ports.supervisor.spawnDaemon({
      executable: node,
      args: ['--migration-channel'],
      claimHandle,
      signal,
    });
    expect(ordinarySpawn).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    const [request, auth, forwardedSignal] = spawn.mock.calls[0];
    expect(forwardedSignal).toBe(signal);
    expect(auth.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(auth.dataRootHash).toBe(launch.dataRootHash);
    expect(request.environment.CANOPY_DAEMON_CLAIM_HANDOFF).toBe(
      'stdin-migration-v1',
    );
    expect(JSON.parse(request.stdin ?? '')).toEqual({
      claim: claimHandle,
      auth,
    });
    expect(JSON.stringify(request.args)).not.toContain(auth.secret);
    expect(JSON.stringify(request.environment)).not.toContain(auth.secret);
    await launch.ports.supervisor.terminateDaemon(daemon, signal);
  });

  // Windows variants of the Darwin native cases. Each descendant is detached,
  // so libuv's kill-on-close job cannot end it and hide a regression.
  const windowsIt = windows ? it : undefined;

  windowsIt?.(
    'refuses a startup claim handoff, which Windows never passes to a child',
    async () => {
      const { supervisor } = host().ports;
      await expect(
        supervisor.spawnDaemon({
          executable: node,
          args: ['-e', ''],
          claimHandle: { claimId: 'bearer-claim-secret' },
          signal,
        }),
      ).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          message: 'Core executable could not be started.',
        },
      });
    },
  );

  windowsIt?.(
    'stops a cancelled child and its detached descendant after spawn resolves',
    async () => {
      const pidFile = join(root, 'leaf.pid');
      const stopFile = join(root, 'leaf.stop');
      const controller = new AbortController();
      const { supervisor } = host().ports;
      const child = await supervisor.spawnDaemon({
        executable: node,
        args: [
          '-e',
          `${detachedLeaf(pidFile, stopFile)}setInterval(()=>{},1e3)`,
        ],
        signal: controller.signal,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const leaf = await pidFrom(pidFile);
        const leafIdentity = await identityOf(leaf);
        controller.abort();
        await expect(
          Promise.race([
            child.exited,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('cancelled child survived')),
                4000,
              );
            }),
          ]),
        ).resolves.toEqual({ code: null, signal: 'SIGKILL' });
        expect(await goneWithin(leaf, leafIdentity)).toBe(true);
      } finally {
        clearTimeout(timer);
        await fs.writeFile(stopFile, '');
        await supervisor.terminateDaemon(child, new AbortController().signal);
      }
    },
    30_000,
  );

  windowsIt?.(
    'stops the owned tree, including a detached grandchild, within a bound',
    async () => {
      const pidFile = join(root, 'grandchild.pid');
      const stopFile = join(root, 'grandchild.stop');
      const { supervisor } = host().ports;
      const child = await supervisor.spawnDaemon({
        executable: node,
        args: [
          '-e',
          `${detachedLeaf(pidFile, stopFile)}setInterval(()=>{},1e3)`,
        ],
        signal,
      });
      try {
        const grandchild = await pidFrom(pidFile);
        const identity = await identityOf(grandchild);
        const started = performance.now();
        await supervisor.terminateDaemon(child, signal);
        await expect(child.exited).resolves.toEqual({
          code: null,
          signal: 'SIGKILL',
        });
        expect(performance.now() - started).toBeLessThan(5_000);
        expect(await goneWithin(grandchild, identity)).toBe(true);
      } finally {
        await fs.writeFile(stopFile, '');
      }
    },
    30_000,
  );

  windowsIt?.(
    'cleans the detached descendant of a native root that exits before its handle is delivered',
    async () => {
      const pidFile = join(root, 'delayed-leaf.pid');
      const stopFile = join(root, 'private-stop');
      // The root exits once its leaf has reported, leaving the leaf behind.
      const script = `${detachedLeaf(pidFile, stopFile)}setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(pidFile)}))process.exit(17)},25);`;
      const services = createOwnedChildServices({ os, nativePath });
      const supervisor = host({
        ownedChildren: {
          spawn: async (request) => {
            const child = await services.spawn(request);
            await child.exited;
            return child;
          },
        },
      }).ports.supervisor;
      const child = await supervisor.spawnDaemon({
        executable: node,
        args: ['-e', script],
        signal,
      });
      try {
        const leaf = await pidFrom(pidFile);
        const identity = await identityOf(leaf);
        expect(() => supervisor.commitDaemon?.(child, signal)).toThrow();
        await supervisor.terminateDaemon(child, signal);
        await supervisor.terminateDaemon(child, signal);
        expect(await goneWithin(leaf, identity)).toBe(true);
      } finally {
        await fs.writeFile(stopFile, '');
        await supervisor.terminateDaemon(child, signal);
      }
    },
    30_000,
  );

  windowsIt?.(
    'maps a job-assignment failure to a typed start failure without a Node spawn fallback (mapping, not induced)',
    async () => {
      // The addon reports a root it could not place in its job as a failed
      // start (ERR_OWNED_CHILD_SPAWN); no hook can make the kernel refuse.
      const spawn = jest.fn(() =>
        Promise.reject(
          Object.assign(new Error('private native detail'), {
            code: 'failed_precondition',
          }),
        ),
      );
      const supervisor = host({ ownedChildren: { spawn } }).ports.supervisor;
      const failure = supervisor.spawnDaemon({
        executable: node,
        args: [],
        signal,
      });
      await expect(failure).rejects.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          message: 'Core executable could not be started.',
        },
      });
      await expect(failure).rejects.not.toHaveProperty('cleanupUnconfirmed');
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );
});

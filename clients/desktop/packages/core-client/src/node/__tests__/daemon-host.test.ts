import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createPlatformEndpointServices,
  createOwnedChildServices,
  createPlatformServices,
} from '@canopy/core-platform';
import { CanopyClientError } from '../../errors';
import {
  createCanopyDaemonHostLaunch,
  type CanopyDaemonHostLaunch,
  type CanopyDaemonHostLaunchOptions,
} from '../index';

// Real files; native child ownership is available only on Darwin.
const os = process.platform === 'darwin' ? 'darwin' : 'linux';
const native = createPlatformServices(os, createPlatformEndpointServices(os));
const signal = new AbortController().signal;
const SECRET = 'a'.repeat(64);
const node = process.execPath;
let nativePath = '';
let nativeDirectory = '';
let root = '';
let runtime = '';
let endpoint = { kind: 'socket' as const, path: '' };

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

(process.platform === 'win32' ? describe.skip : describe)('daemon host', () => {
  beforeAll(async () => {
    nativeDirectory = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), 'daemon-host-native-')),
    );
    nativePath = join(nativeDirectory, 'core-owned-child.node');
    execFileSync(process.execPath, [
      resolve('scripts/build-owned-child.mjs'),
      '--out',
      nativePath,
    ]);
  });
  afterAll(() => fs.rm(nativeDirectory, { recursive: true, force: true }));
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'daemon-host-')));
    runtime = join(root, 'runtime');
    endpoint = { kind: 'socket', path: join(runtime, 'core.sock') };
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

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
        await fs.symlink(replacement, runtime, 'dir');
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

  (process.platform === 'darwin' ? it : it.skip)(
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
    const missing = join(root, 'missing-daemon');
    const command = { executable: node, args: [], signal };
    const { supervisor } = host({ executable: missing }).ports;
    await expect(
      supervisor.spawnDaemon({ ...command, executable: missing }),
    ).rejects.toMatchObject({
      payload: {
        kind:
          process.platform === 'darwin'
            ? 'failed_precondition'
            : 'capability_unavailable',
      },
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

  (process.platform === 'darwin' ? it : it.skip)(
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

  (process.platform === 'darwin' ? it : it.skip).each([
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
      const alive = (): boolean => {
        try {
          return process.kill(pid, 0);
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 50 && alive(); i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(alive()).toBe(false);
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

  (process.platform === 'darwin' ? it : it.skip)(
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
});

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanopyStartupClaimPort } from '@canopy/core-transport/node';
import { bindCanopyDaemonEndpoint } from '@canopy/core-runtime/node';
import type {
  PlatformEndpointListener,
  PlatformOperatingSystem,
  PlatformProcessInspection,
  PlatformUnixSocketAddress,
} from '@canopy/core-runtime';
import { createPlatformServices, createPlatformEndpointServices } from '..';

const os: PlatformOperatingSystem =
  process.platform === 'darwin' ? 'darwin' : 'linux';
const posix = process.platform === 'win32' ? test.skip : test;
let root: string;
let address: PlatformUnixSocketAddress;
let owner: PlatformProcessInspection;
const children: ChildProcess[] = [];
const clients: Socket[] = [];
const listeners: PlatformEndpointListener<unknown>[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'b-')));
  await mkdir(join(root, 'runtime'), { mode: 0o700 });
  address = { kind: 'unix-socket', path: join(root, 'runtime', 'core.sock') };
  owner = { state: 'absent' };
});
afterEach(async () => {
  clients.splice(0).forEach((client) => client.destroy());
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }),
  );
  await rm(root, { recursive: true, force: true });
});

async function host(): Promise<Parameters<typeof bindCanopyDaemonEndpoint>[0]> {
  const claims = createCanopyStartupClaimPort({
    dataRoot: root,
    owner: { pid: process.pid, startIdentity: 'test-start' },
    inspectProcess: () =>
      Promise.resolve({ kind: 'alive', startIdentity: 'test-start' }),
  });
  const acquired = await claims.tryAcquire();
  if (acquired.kind !== 'acquired') throw new Error('Claim unavailable');
  const platform = createPlatformServices(
    os,
    createPlatformEndpointServices(os, {
      validateStartupClaim: (claim) => claims.verify(claim),
    }),
  );
  return {
    dataRoot: root,
    claims,
    claimHandle: acquired.handle,
    platform: {
      ...platform,
      supervision: {
        ...platform.supervision,
        inspectProcess: () => Promise.resolve(owner),
      },
    },
  };
}

async function socketOwner(blocked = false): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    require('net').createServer().listen({path:process.argv[1],backlog:1},()=>{
      process.stdout.write('ready');
      ${blocked ? 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);' : ''}
    });
  `,
      address.path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  if (!child.stdout) throw new Error('Missing stdout');
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(() => {
      throw new Error('Fixture exited before bind');
    }),
  ]);
  return child;
}

async function boundIdentity(): Promise<{ device: string; inode: string }> {
  const stat = await lstat(address.path, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
}

async function descriptor(
  child: ChildProcess,
  endpoint = address.path,
  // null writes a pre-socketIdentity descriptor.
  socketIdentity?: object | null,
  fields: object = {},
): Promise<void> {
  if (socketIdentity === undefined) socketIdentity = await boundIdentity();
  await writeFile(
    join(root, 'runtime', 'core.json'),
    JSON.stringify({
      version: 1,
      pid: child.pid,
      startIdentity: 'old-owner',
      endpoint: { kind: 'socket', path: endpoint },
      protocolRange: { min: 1, max: 1 },
      buildVersion: 'test',
      tokenRef: join(root, 'runtime', 'old.token'),
      socketIdentity: socketIdentity ?? undefined,
      ...fields,
    }),
    { mode: 0o600 },
  );
}

posix(
  'an absent path binds under a held claim without publishing discovery',
  async () => {
    const options = await host();
    const { listener, socketIdentity } =
      await bindCanopyDaemonEndpoint(options);
    listeners.push(listener);
    expect(listener.address).toEqual(address);
    expect(socketIdentity).toEqual(await boundIdentity());
    await expect(
      lstat(join(root, 'runtime', 'core.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await options.claims.identity(options.claimHandle)).not.toBeNull();
  },
);

const refusedDescriptors = [
  'missing',
  'malformed',
  'unversioned',
  'future-version',
  'foreign',
  'unbound',
  'mismatched',
];
posix.each(refusedDescriptors)(
  'refused socket with %s descriptor fails closed',
  async (kind) => {
    const options = await host();
    const child = await socketOwner();
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    if (kind === 'malformed')
      await writeFile(join(root, 'runtime', 'core.json'), '{}');
    if (kind === 'unversioned')
      await descriptor(child, address.path, undefined, { version: undefined });
    if (kind === 'future-version')
      await descriptor(child, address.path, undefined, { version: 2 });
    if (kind === 'foreign')
      await descriptor(child, join(root, 'runtime', 'foreign.sock'));
    if (kind === 'unbound') await descriptor(child, address.path, null);
    if (kind === 'mismatched')
      await descriptor(child, address.path, { device: '1', inode: '1' });
    const before = await lstat(address.path);
    const attempt = bindCanopyDaemonEndpoint(options);
    void attempt.then(
      ({ listener }) => listeners.push(listener),
      () => undefined,
    );
    await expect(attempt).rejects.toThrow('offline repair');
    expect((await lstat(address.path)).ino).toBe(before.ino);
  },
);

posix.each<PlatformProcessInspection>([
  { state: 'running', startIdentity: 'old-owner' },
  { state: 'unverifiable', reason: 'permission denied' },
])('refused socket preserves an unproven owner: $state', async (inspection) => {
  const options = await host();
  const child = await socketOwner();
  await descriptor(child);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  owner = inspection;
  const before = await lstat(address.path);
  const attempt = bindCanopyDaemonEndpoint(options);
  void attempt.then(
    ({ listener }) => listeners.push(listener),
    () => undefined,
  );
  await expect(attempt).rejects.toThrow('offline repair');
  expect((await lstat(address.path)).ino).toBe(before.ino);
});

posix.each<PlatformProcessInspection>([
  { state: 'absent' },
  { state: 'running', startIdentity: 'reused-pid' },
])(
  'refused socket recovers only a proven departed owner: $state',
  async (inspection) => {
    const options = await host();
    const child = await socketOwner();
    await descriptor(child);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    owner = inspection;
    const { listener } = await bindCanopyDaemonEndpoint(options);
    listeners.push(listener);
    expect(listener.address).toEqual(address);
    expect(await options.claims.identity(options.claimHandle)).not.toBeNull();
  },
);

(process.platform === 'darwin' ? test : test.skip)(
  'a live full backlog never authorizes unlink',
  async () => {
    const options = await host();
    const child = await socketOwner(true);
    await descriptor(child);
    owner = { state: 'running', startIdentity: 'old-owner' };
    for (let i = 0; i < 3; i++) {
      const client = createConnection(address.path);
      clients.push(client);
      await new Promise<void>((resolve) => {
        client.once('connect', resolve);
        client.once('error', () => resolve());
      });
    }
    const endpoints = options.platform.endpoints;
    if (endpoints.semantics !== 'filesystem-socket')
      throw new Error('Wrong family');
    expect((await endpoints.probe(address)).state).toBe('refused');
    const before = await lstat(address.path);
    const attempt = bindCanopyDaemonEndpoint(options);
    void attempt.then(
      ({ listener }) => listeners.push(listener),
      () => undefined,
    );
    await expect(attempt).rejects.toThrow('offline repair');
    expect(child.exitCode).toBeNull();
    expect((await lstat(address.path)).ino).toBe(before.ino);
  },
);

async function replaceDepartedOwner(blocked: boolean): Promise<ChildProcess> {
  const departed = await socketOwner();
  await descriptor(departed);
  const exited = once(departed, 'exit');
  departed.kill('SIGKILL');
  await exited;
  // Pins the departed inode so the successor cannot reuse its number.
  await link(address.path, join(root, 'runtime', 'departed.sock'));
  await unlink(address.path);
  owner = { state: 'absent' };
  return socketOwner(blocked);
}

posix(
  'a departed owner never authorizes unlinking a successor socket',
  async () => {
    const options = await host();
    const successor = await replaceDepartedOwner(false);
    const exited = once(successor, 'exit');
    successor.kill('SIGKILL');
    await exited;
    const before = await lstat(address.path);
    const attempt = bindCanopyDaemonEndpoint(options);
    void attempt.then(
      ({ listener }) => listeners.push(listener),
      () => undefined,
    );
    await expect(attempt).rejects.toThrow('offline repair');
    expect((await lstat(address.path)).ino).toBe(before.ino);
  },
);

(process.platform === 'darwin' ? test : test.skip)(
  'a departed owner never authorizes unlinking a live full-backlog successor',
  async () => {
    const options = await host();
    const successor = await replaceDepartedOwner(true);
    for (let i = 0; i < 3; i++) {
      const client = createConnection(address.path);
      clients.push(client);
      await new Promise<void>((resolve) => {
        client.once('connect', resolve);
        client.once('error', () => resolve());
      });
    }
    const endpoints = options.platform.endpoints;
    if (endpoints.semantics !== 'filesystem-socket')
      throw new Error('Wrong family');
    expect((await endpoints.probe(address)).state).toBe('refused');
    const before = await lstat(address.path);
    const attempt = bindCanopyDaemonEndpoint(options);
    void attempt.then(
      ({ listener }) => listeners.push(listener),
      () => undefined,
    );
    await expect(attempt).rejects.toThrow('offline repair');
    expect(successor.exitCode).toBeNull();
    expect((await lstat(address.path)).ino).toBe(before.ino);
  },
);

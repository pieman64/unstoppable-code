import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlatformEndpointServices } from '../endpoints';
import type {
  PlatformEndpointListener,
  PlatformOperatingSystem,
  PlatformSocketEndpointServices,
  PlatformUnixSocketAddress,
} from '@canopy/core-runtime';

// CAN-5694: a data root too long for its own socket path is reached through a
// private per-user alias, re-checked on every use. The alias root is a
// temporary directory so the user's real one is never touched.

const os: PlatformOperatingSystem =
  process.platform === 'win32'
    ? 'win32'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux';
const posix = os === 'win32' ? describe.skip : describe;
const uid = process.getuid?.() ?? -1;

let base: string;
let aliasRoot: string;
let longRoot: string;
const listeners: PlatformEndpointListener<PlatformUnixSocketAddress>[] = [];

function sockets(
  options: { readonly getuid?: () => number } = {},
): PlatformSocketEndpointServices {
  const port = createPlatformEndpointServices(os, {
    socketAliasRoot: aliasRoot,
    ...options,
  });
  if (port.semantics !== 'filesystem-socket') throw new Error('Wrong family');
  return port;
}

async function connects(target: string): Promise<boolean> {
  const client = createConnection(target);
  try {
    await once(client, 'connect');
    return true;
  } catch {
    return false;
  } finally {
    client.destroy();
  }
}

posix('long data root socket alias (CAN-5694)', () => {
  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), 'alias-')));
    // Short, like the real `/tmp` root, wherever the test's temporary directory is.
    aliasRoot = await realpath(await mkdtemp('/tmp/canopy-alias-'));
    longRoot = path.join(base, 'd'.repeat(60), 'e'.repeat(60));
    await mkdir(path.join(longRoot, 'runtime'), {
      recursive: true,
      mode: 0o700,
    });
    await chmod(longRoot, 0o700);
  });

  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((l) => l.close()));
    await rm(base, { recursive: true, force: true });
    await rm(aliasRoot, { recursive: true, force: true });
  });

  it('keeps a short root on its own runtime socket path', () => {
    const shortRoot = '/srv/c';
    const address = createPlatformEndpointServices(os).address({
      dataRoot: shortRoot,
      endpointName: 'core',
    });
    expect(address).toEqual({
      kind: 'unix-socket',
      path: '/srv/c/runtime/core.sock',
    });
  });

  it('defaults to a per-user directory under the fixed temporary root', () => {
    const port = createPlatformEndpointServices(os, { getuid: () => 501 });
    if (port.semantics !== 'filesystem-socket') throw new Error('Wrong family');
    const address = port.address({ dataRoot: longRoot, endpointName: 'core' });
    const root = os === 'darwin' ? '/private/tmp' : '/tmp';
    expect(address.alias?.directory).toBe(`${root}/canopy-501`);
    expect(address.path).toMatch(
      new RegExp(`^${root}/canopy-501/[0-9a-f]{16}/core\\.sock$`),
    );
    expect(Buffer.byteLength(address.path)).toBeLessThan(64);
  });

  it('binds and connects a long root through the alias, with the socket in the private runtime directory', async () => {
    const port = sockets();
    const address = port.address({ dataRoot: longRoot, endpointName: 'core' });
    expect(
      Buffer.byteLength(path.join(longRoot, 'runtime', 'core.sock')),
    ).toBeGreaterThan(107);
    expect(address.alias?.directory).toBe(
      path.join(aliasRoot, `canopy-${uid}`),
    );
    expect(address.alias?.link).toMatch(/\/[0-9a-f]{16}$/);
    expect(address.alias?.runtimeDirectory).toBe(
      path.join(longRoot, 'runtime'),
    );
    expect(await port.probe(address)).toEqual({ state: 'absent' });
    const bound = await port.bind(address);
    if (bound.kind !== 'bound') throw new Error('Not bound');
    listeners.push(bound.listener);

    const directory = await lstat(path.join(aliasRoot, `canopy-${uid}`));
    expect(directory.isDirectory()).toBe(true);
    expect(directory.mode & 0o777).toBe(0o700);
    const inRuntime = path.join(longRoot, 'runtime', 'core.sock');
    const socket = await lstat(inRuntime, { bigint: true });
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777n).toBe(0o600n);
    expect(bound.identity).toEqual({ device: socket.dev, inode: socket.ino });
    expect(await port.probe(address)).toEqual({ state: 'live' });
    expect(await connects(address.path)).toBe(true);

    // A temporary cleaner removed the link: the next use recreates it.
    if (!address.alias) throw new Error('No alias');
    await unlink(address.alias.link);
    await port.prepare(address);
    expect(await realpath(address.alias.link)).toBe(
      path.join(longRoot, 'runtime'),
    );
    expect(await connects(address.path)).toBe(true);

    await bound.listener.close();
    listeners.splice(0);
    await expect(lstat(inRuntime)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a long root without its runtime directory as absent and links nothing', async () => {
    await rm(path.join(longRoot, 'runtime'), { recursive: true });
    const port = sockets();
    const address = port.address({ dataRoot: longRoot, endpointName: 'core' });
    if (!address.alias) throw new Error('No alias');
    expect(await port.probe(address)).toEqual({ state: 'absent' });
    expect(await port.verifyIdentity(address, { device: 1n, inode: 1n })).toBe(
      'absent',
    );
    await expect(port.prepare(address)).rejects.toThrow(
      'Endpoint alias target is absent.',
    );
    await expect(lstat(address.alias.link)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a squatted alias directory owned by another user', async () => {
    const other = uid + 1;
    await mkdir(path.join(aliasRoot, `canopy-${other}`), { mode: 0o700 });
    const port = sockets({ getuid: () => other });
    const address = port.address({ dataRoot: longRoot, endpointName: 'core' });
    await expect(port.prepare(address)).rejects.toThrow(
      'Endpoint alias directory is not private.',
    );
    await expect(port.bind(address)).rejects.toThrow(
      'Endpoint alias directory is not private.',
    );
  });

  it('refuses an alias directory with a wider mode, and never narrows it', async () => {
    const directory = path.join(aliasRoot, `canopy-${uid}`);
    await mkdir(directory);
    await chmod(directory, 0o755);
    const port = sockets();
    const address = port.address({ dataRoot: longRoot, endpointName: 'core' });
    await expect(port.probe(address)).rejects.toThrow(
      'Endpoint alias directory is not private.',
    );
    expect((await lstat(directory)).mode & 0o777).toBe(0o755);
  });

  it('refuses an alias directory that is a symbolic link', async () => {
    const real = path.join(base, 'real');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, path.join(aliasRoot, `canopy-${uid}`));
    const port = sockets();
    const address = port.address({ dataRoot: longRoot, endpointName: 'core' });
    await expect(port.prepare(address)).rejects.toThrow(
      'Endpoint alias directory is not private.',
    );
  });

  it('refuses a link to another directory, on every use and without repointing it', async () => {
    const port = sockets();
    const address = port.address({ dataRoot: longRoot, endpointName: 'core' });
    if (!address.alias) throw new Error('No alias');
    await port.prepare(address);
    const elsewhere = path.join(base, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o700 });
    await unlink(address.alias.link);
    await symlink(elsewhere, address.alias.link);
    await expect(port.prepare(address)).rejects.toThrow(
      'Endpoint alias is foreign.',
    );
    await expect(port.probe(address)).rejects.toThrow(
      'Endpoint alias is foreign.',
    );
    await expect(port.bind(address)).rejects.toThrow(
      'Endpoint alias is foreign.',
    );
    expect(await realpath(address.alias.link)).toBe(elsewhere);
  });
});

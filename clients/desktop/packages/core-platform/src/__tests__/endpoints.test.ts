import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPlatformEndpointServices as endpoints } from '../endpoints';
import type {
  PlatformEndpointListener,
  PlatformUnixSocketAddress,
  PlatformOperatingSystem,
} from '@canopy/core-runtime';

const os: PlatformOperatingSystem =
  process.platform === 'win32'
    ? 'win32'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux';
const posix = os === 'win32' ? it.skip : it;
const claim = { dataRoot: '', claimId: 'held' };
let root: string;
const listeners: PlatformEndpointListener<PlatformUnixSocketAddress>[] = [];
beforeEach(async () => {
  root = await mkdtemp(
    path.join(tmpdir().replace(/^\/private\/var\//, '/var/'), 'e'),
  );
  claim.dataRoot = root;
  await mkdir(path.join(root, 'runtime'), { mode: 0o700 });
});
afterEach(async () => {
  await Promise.all(listeners.splice(0).map((l) => l.close()));
  await rm(root, { recursive: true, force: true });
});

it('selects semantics from the passed host and rejects unsafe names/paths', async () => {
  expect(endpoints('linux').semantics).toBe('filesystem-socket');
  const pipes = endpoints('win32');
  expect(pipes.semantics).toBe('first-instance-pipe');
  const request = { dataRoot: 'C:\\data', endpointName: 'core' };
  const address = pipes.address(request);
  expect(address).toEqual(pipes.address(request));
  expect(address).not.toEqual(
    pipes.address({ ...request, dataRoot: 'C:\\other' }),
  );
  expect(() => pipes.address({ ...request, endpointName: '../x' })).toThrow();
  expect(() =>
    endpoints('linux').address({ ...request, dataRoot: 'relative' }),
  ).toThrow();
  if (
    address.kind !== 'named-pipe' ||
    pipes.semantics !== 'first-instance-pipe'
  )
    throw new Error('Wrong family');
  expect('unlinkStale' in pipes).toBe(false);
  await expect(pipes.bind(address)).rejects.toThrow(
    'Named pipe security required.',
  );
});

posix(
  'binds exclusively, exchanges bytes, bounds writes and releases all clients',
  async () => {
    const port = endpoints(os);
    if (port.semantics !== 'filesystem-socket') throw new Error('Wrong family');
    const address = port.address({ dataRoot: root, endpointName: 'a' });
    expect(await port.probe(address)).toEqual({ state: 'absent' });
    const results = await Promise.all([port.bind(address), port.bind(address)]);
    expect(results.map((r) => r.kind).sort()).toEqual(['bound', 'in-use']);
    const bound = results.find((r) => r.kind === 'bound');
    if (!bound || bound.kind !== 'bound') throw new Error('Not bound');
    listeners.push(bound.listener);
    expect((await lstat(address.path)).mode & 0o777).toBe(0o600);
    const incoming = bound.listener.connections()[Symbol.asyncIterator]();
    const client = createConnection(address.path);
    await once(client, 'connect');
    const accepted = await incoming.next();
    if (accepted.done) throw new Error('No stream');
    const stream = accepted.value;
    client.write('ping');
    expect(Buffer.from((await stream.read()) ?? []).toString()).toBe('ping');
    const reply = once(client, 'data');
    await stream.write(Buffer.from('pong'));
    const bytes: unknown = (await reply)[0];
    expect(
      bytes instanceof Uint8Array ? Buffer.from(bytes).toString() : null,
    ).toBe('pong');
    await expect(stream.write(new Uint8Array(65537))).rejects.toThrow('limit');
    const abort = new AbortController();
    const read = stream.read({ signal: abort.signal });
    abort.abort();
    await expect(read).rejects.toThrow('aborted');
    const disconnected = once(client, 'close');
    await bound.listener.close();
    await disconnected;
    expect(stream.signal.aborted).toBe(true);
    expect(await stream.read()).toBeNull();
    expect((await incoming.next()).done).toBe(true);
    expect(await port.probe(address)).toEqual({ state: 'absent' });
  },
);

posix(
  'only unlinks refused sockets under a verified claim, never replacement files or symlinks',
  async () => {
    const port = endpoints(os, {
      validateStartupClaim: (c) => Promise.resolve(c === claim),
    });
    if (port.semantics !== 'filesystem-socket') throw new Error('Wrong family');
    const address = port.address({ dataRoot: root, endpointName: 'a' });
    const child = spawn(
      process.execPath,
      [
        '-e',
        'require("net").createServer().listen(process.argv[1],()=>process.stdout.write("ready"))',
        address.path,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      if (!child.stdout) throw new Error('Missing stdout');
      await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'exit').then(() => {
          throw new Error('Socket fixture exited before bind.');
        }),
      ]);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const refused = await port.probe(address);
      if (refused.state !== 'refused') throw new Error(JSON.stringify(refused));
      const request = { address, expected: refused.identity, claim };
      expect(await port.verifyIdentity(address, refused.identity)).toBe(
        'match',
      );
      const untrusted = endpoints(os);
      if (untrusted.semantics !== 'filesystem-socket')
        throw new Error('Wrong family');
      expect(await untrusted.unlinkStale(request)).toBe('changed');
      expect(await port.unlinkStale({ ...request, claim: { ...claim } })).toBe(
        'changed',
      );
      const backup = port.address({ dataRoot: root, endpointName: 'b' });
      await rename(address.path, backup.path);
      const replacement = await port.bind(address);
      if (replacement.kind !== 'bound') throw new Error('Not bound');
      listeners.push(replacement.listener);
      expect(await port.verifyIdentity(address, refused.identity)).toBe(
        'changed',
      );
      expect(await port.unlinkStale(request)).toBe('changed');
      expect((await port.probe(address)).state).toBe('live');
      expect(await port.unlinkStale({ ...request, address: backup })).toBe(
        'unlinked',
      );
      await replacement.listener.close();
      await writeFile(address.path, 'replacement');
      expect((await port.probe(address)).state).toBe('ambiguous');
      expect(await port.unlinkStale(request)).toBe('changed');
      await unlink(address.path);
      await symlink(path.join(root, 'runtime'), address.path);
      expect((await port.probe(address)).state).toBe('ambiguous');
      expect(await port.unlinkStale(request)).toBe('changed');
      await unlink(address.path);
      expect(await port.unlinkStale(request)).toBe('absent');
    } finally {
      child.kill('SIGKILL');
    }
  },
);

posix(
  'close preserves a replacement at the canonical socket path',
  async () => {
    const port = endpoints(os);
    if (port.semantics !== 'filesystem-socket') throw new Error('Wrong family');
    const address = port.address({ dataRoot: root, endpointName: 'a' });
    const bound = await port.bind(address);
    if (bound.kind !== 'bound') throw new Error('Not bound');
    listeners.push(bound.listener);
    await rename(address.path, path.join(root, 'runtime', 'old.sock'));
    await writeFile(address.path, 'foreign');
    await bound.listener.close();
    expect(await readFile(address.path, 'utf8')).toBe('foreign');
  },
);

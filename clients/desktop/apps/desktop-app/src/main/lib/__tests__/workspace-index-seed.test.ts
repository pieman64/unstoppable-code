import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import {
  seedWorkspaceIndex,
  type WorkspaceIndexSeedRequest,
} from '../workspace-index-seed';
let primaryDataDir: string;
const posix = process.platform === 'win32' ? it.skip : it;
/** Host-cohort members of the primary folder (CAN-3797). */
async function members(): Promise<unknown[]> {
  const hosts = path.join(await realpath(primaryDataDir), 'runtime', 'hosts');
  const names = await readdir(hosts).catch(() => []);
  return Promise.all(
    names
      .filter((name) => !name.startsWith('.'))
      .map(
        async (name): Promise<unknown> =>
          JSON.parse(await readFile(path.join(hosts, name), 'utf8')),
      ),
  );
}
beforeEach(async () => {
  primaryDataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-index-seed-'));
});
afterEach(async () => {
  await rm(primaryDataDir, { recursive: true, force: true });
});
const seed = (): ReturnType<typeof seedWorkspaceIndex> =>
  seedWorkspaceIndex({
    source: 'preferences_create_primary_data_dir',
    primaryDataDir,
  });
it('seeds once with no backup, including competing and repeated calls', async () => {
  expect(await Promise.all([seed(), seed()])).toEqual([
    { seeded: true },
    { seeded: false },
  ]);
  const file = path.join(primaryDataDir, 'workspaces', 'index.json');
  const before = await readFile(file, 'utf8');
  expect(JSON.parse(before)).toEqual({ version: 1, workspaces: [] });
  expect(await seed()).toEqual({ seeded: false });
  expect(await readFile(file, 'utf8')).toBe(before);
  await expect(readFile(`${file}.bak`)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it.each(['{"version":1,"workspaces":[{"id":"keep"}]}', 'unreadable'])(
  'keeps an existing index byte for byte: %s',
  async (contents) => {
    const dir = path.join(primaryDataDir, 'workspaces');
    await mkdir(dir);
    await writeFile(path.join(dir, 'index.json'), contents);
    expect(await seed()).toEqual({ seeded: false });
    expect(await readFile(path.join(dir, 'index.json'), 'utf8')).toBe(contents);
  },
);
it('refuses an unknown source before creating a directory', async () => {
  const request: WorkspaceIndexSeedRequest = {
    source: 'preferences_create_primary_data_dir',
    primaryDataDir,
  };
  Object.assign(request, { source: 'unknown' });
  await expect(seedWorkspaceIndex(request)).rejects.toMatchObject({
    reason: 'invalid-request',
  });
  await expect(
    readFile(path.join(primaryDataDir, 'workspaces', 'index.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
posix(
  'registers the primary folder as an Electron host before it seeds',
  async () => {
    expect(await seed()).toEqual({ seeded: true });
    expect(await seed()).toEqual({ seeded: false });
    // One member for the rest of the process, whatever the resolved root.
    expect(await members()).toEqual([
      expect.objectContaining({ pid: process.pid, hostKind: 'electron' }),
    ]);
  },
);
posix(
  'refuses while maintenance holds the primary folder, writing no index',
  async () => {
    const platform = hostPlatformServices(
      createPlatformEndpointServices(hostPlatformOperatingSystem()),
    );
    const self = await platform.supervision.inspectProcess({
      pid: process.pid,
    });
    if (self.state !== 'running') throw new Error('identity unprovable');
    const runtime = path.join(primaryDataDir, 'runtime');
    await mkdir(runtime, { mode: 0o700 });
    // A live maintenance owner: this process, by its real start identity.
    await writeFile(
      path.join(runtime, 'w5-maintenance.json'),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        startIdentity: self.startIdentity,
        token: '12345678-1234-4234-8234-123456789abc',
      }),
    );
    await expect(seed()).rejects.toMatchObject({
      reason: 'maintenance-held',
    });
    expect(await members()).toEqual([]);
    await expect(
      readFile(path.join(primaryDataDir, 'workspaces', 'index.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
posix(
  'seeds a primary folder whose runtime folder maintenance cannot use, unregistered',
  async () => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'canopy-runtime-'));
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      // A linked runtime folder is never private, so registration fails.
      await symlink(elsewhere, path.join(primaryDataDir, 'runtime'));
      expect(await seed()).toEqual({ seeded: true });
      expect(warn).toHaveBeenCalledWith(
        'W5 host registration failed.',
        expect.objectContaining({
          writers: 'admitted unregistered (runtime-not-private)',
        }),
      );
      expect(await readdir(elsewhere)).toEqual([]);
    } finally {
      warn.mockRestore();
      await rm(elsewhere, { recursive: true, force: true });
    }
  },
);

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  seedWorkspaceIndex,
  type WorkspaceIndexSeedRequest,
} from '../workspace-index-seed';
let primaryDataDir: string;
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

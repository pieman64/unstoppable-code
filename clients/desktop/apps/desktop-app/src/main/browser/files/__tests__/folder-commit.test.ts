import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindFolder, type CommitRequest } from '../folder-commit';

let base: string;
let workspace: string;
let outside: string;
const TEMP = '.canopy-copy-00000000-0000-0000-0000-000000000000.part';

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'folder-commit-')));
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  await mkdir(join(workspace, 'exports'), { recursive: true });
  await mkdir(outside);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function identity(path: string): Promise<{ dev: number; ino: number }> {
  const stat = await lstat(path);
  return { dev: stat.dev, ino: stat.ino };
}
async function temp(folder: string): Promise<CommitRequest['temp']> {
  await writeFile(join(folder, TEMP), 'copy');
  return identity(join(folder, TEMP));
}

describe('bindFolder', () => {
  it('reports the identity of the folder it starts in', async () => {
    const bound = await bindFolder(join(workspace, 'exports'));
    try {
      expect(bound.identity).toEqual(
        await identity(join(workspace, 'exports')),
      );
    } finally {
      bound.close();
    }
  });

  it('commits in the bound folder after a parent is swapped for a link', async () => {
    for (const overwrite of [false, true]) {
      await rm(join(workspace, 'moved'), { recursive: true, force: true });
      await rm(join(workspace, 'exports'), { recursive: true, force: true });
      await mkdir(join(workspace, 'exports'));
      const copy = await temp(join(workspace, 'exports'));
      const bound = await bindFolder(join(workspace, 'exports'));
      await rename(join(workspace, 'exports'), join(workspace, 'moved'));
      await symlink(outside, join(workspace, 'exports'));
      expect(
        await bound.commit({
          tempName: TEMP,
          temp: copy,
          name: 'report.csv',
          overwrite,
        }),
      ).toEqual({ type: 'committed' });
      expect(await readdir(outside)).toEqual([]);
      expect(await readdir(join(workspace, 'moved'))).toEqual(['report.csv']);
      expect(
        await readFile(join(workspace, 'moved', 'report.csv'), 'utf8'),
      ).toBe('copy');
    }
  });

  it('keeps a file that has the name without overwrite, and removes the temp file', async () => {
    const folder = join(workspace, 'exports');
    await writeFile(join(folder, 'report.csv'), 'mine');
    const bound = await bindFolder(folder);
    expect(
      await bound.commit({
        tempName: TEMP,
        temp: await temp(folder),
        name: 'report.csv',
        overwrite: false,
      }),
    ).toEqual({ type: 'failed', code: 'EEXIST' });
    expect(await readFile(join(folder, 'report.csv'), 'utf8')).toBe('mine');
    expect(await readdir(folder)).toEqual(['report.csv']);
  });

  it('refuses a folder at the name with overwrite', async () => {
    const folder = join(workspace, 'exports');
    await mkdir(join(folder, 'report.csv'));
    const bound = await bindFolder(folder);
    expect(
      await bound.commit({
        tempName: TEMP,
        temp: await temp(folder),
        name: 'report.csv',
        overwrite: true,
      }),
    ).toEqual({ type: 'refused', reason: 'folder_at_name' });
    expect(await readdir(folder)).toEqual(['report.csv']);
  });

  it('leaves a temp name that no longer holds the copy', async () => {
    const folder = join(workspace, 'exports');
    const copy = await temp(folder);
    await writeFile(join(folder, `${TEMP}.new`), 'other');
    await rename(join(folder, `${TEMP}.new`), join(folder, TEMP));
    const bound = await bindFolder(folder);
    expect(
      await bound.commit({
        tempName: TEMP,
        temp: copy,
        name: 'report.csv',
        overwrite: false,
      }),
    ).toEqual({ type: 'refused', reason: 'temp_changed' });
    expect(await readdir(folder)).toEqual([TEMP]);
  });

  it('refuses a name that leaves the folder', async () => {
    const folder = join(workspace, 'exports');
    const copy = await temp(folder);
    for (const name of ['../report.csv', 'sub/report.csv', '..', '']) {
      const bound = await bindFolder(folder);
      expect(
        await bound.commit({
          tempName: TEMP,
          temp: copy,
          name,
          overwrite: true,
        }),
      ).toEqual({ type: 'refused', reason: 'bad_request' });
    }
    expect(await readdir(workspace)).toEqual(['exports']);
    expect(await readdir(folder)).toEqual([TEMP]);
  });

  it('commits nothing when closed before the commit', async () => {
    const folder = join(workspace, 'exports');
    await temp(folder);
    const bound = await bindFolder(folder);
    bound.close();
    await expect(
      bound.commit({
        tempName: TEMP,
        temp: await identity(join(folder, TEMP)),
        name: 'report.csv',
        overwrite: false,
      }),
    ).rejects.toThrow();
    expect(await readdir(folder)).toEqual([TEMP]);
  });

  it('fails for a folder that cannot be entered', async () => {
    await expect(bindFolder(join(workspace, 'missing'))).rejects.toThrow();
  });
});

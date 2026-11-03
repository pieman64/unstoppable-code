import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findNestedRepositories } from '../nested-repositories';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return { ...actual, readdir: jest.fn(actual.readdir) };
});

const actualFs = jest.requireActual<typeof FsPromises>('node:fs/promises');
const { readdir: readDirectory } = jest.requireMock<{
  readdir: jest.Mock<Promise<Dirent[]>, [string, { withFileTypes: true }]>;
}>('node:fs/promises');

describe('findNestedRepositories', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'nested-repos-'));
    readDirectory.mockClear();
  });

  afterEach(async () => {
    readDirectory.mockReset();
    readDirectory.mockImplementation((directory) =>
      actualFs.readdir(directory, { withFileTypes: true }),
    );
    await rm(root, { recursive: true, force: true });
  });

  async function repository(relative: string, file = false): Promise<string> {
    const directory = path.join(root, relative);
    await mkdir(directory, { recursive: true });
    if (file)
      await writeFile(path.join(directory, '.git'), 'gitdir: elsewhere');
    else await mkdir(path.join(directory, '.git'));
    return directory;
  }

  it('finds markers at depths 1 and 2, skipping hidden paths, symlinks, files and repository contents', async () => {
    const direct = await repository('direct');
    const nested = await repository('group/nested', true);
    await repository('group/deeper/ignored');
    await repository('direct/inner');
    await repository('.hidden/repo');
    await writeFile(path.join(root, 'plain-file'), '');
    await symlink(path.join(root, 'group'), path.join(root, 'alias'));
    await mkdir(path.join(root, 'symlink-marker'));
    await symlink(
      path.join(direct, '.git'),
      path.join(root, 'symlink-marker/.git'),
    );

    expect(await findNestedRepositories(root)).toEqual({
      repositories: [direct, nested],
      complete: true,
    });
    expect(
      readDirectory.mock.calls.map(([directory]) => directory),
    ).not.toContain(path.join(direct, 'inner'));
    expect(
      readDirectory.mock.calls.map(([directory]) => directory),
    ).not.toContain(path.join(root, 'group/deeper/ignored'));
  });

  it('uses deterministic breadth-first ordering even when readdir returns reverse order', async () => {
    const a = await repository('a/repo');
    const z = await repository('z');
    readDirectory.mockImplementation(async (directory) => {
      const entries = await actualFs.readdir(directory, {
        withFileTypes: true,
      });
      return entries.reverse();
    });
    expect(await findNestedRepositories(root, { directoryBudget: 3 })).toEqual({
      repositories: [z],
      complete: false,
    });
    expect(await findNestedRepositories(root)).toEqual({
      repositories: [a, z],
      complete: true,
    });
  });

  it('counts the root read and distinguishes exact completion from pending work', async () => {
    expect(await findNestedRepositories(root, { directoryBudget: 1 })).toEqual({
      repositories: [],
      complete: true,
    });
    const repo = await repository('repo');
    expect(await findNestedRepositories(root, { directoryBudget: 1 })).toEqual({
      repositories: [],
      complete: false,
    });
    expect(await findNestedRepositories(root, { directoryBudget: 2 })).toEqual({
      repositories: [repo],
      complete: true,
    });
    expect(await findNestedRepositories(root, { directoryBudget: 0 })).toEqual({
      repositories: [],
      complete: false,
    });
  });

  it('preserves successes when a required read fails, including missing roots', async () => {
    const repo = await repository('a');
    await mkdir(path.join(root, 'b'));
    readDirectory.mockImplementation((directory) => {
      if (directory === path.join(root, 'b'))
        return Promise.reject(new Error('EACCES'));
      return actualFs.readdir(directory, { withFileTypes: true });
    });
    expect(await findNestedRepositories(root)).toEqual({
      repositories: [repo],
      complete: false,
    });
    expect(await findNestedRepositories(path.join(root, 'missing'))).toEqual({
      repositories: [],
      complete: false,
    });
  });

  it('enforces the production 400-read budget including the root', async () => {
    for (let index = 0; index < 401; index += 1) {
      await repository(`repo-${String(index).padStart(3, '0')}`);
    }
    const scan = await findNestedRepositories(root);
    expect(scan.complete).toBe(false);
    expect(scan.repositories).toHaveLength(399);
    expect(readDirectory).toHaveBeenCalledTimes(400);
    expect(scan.repositories[398]).toBe(path.join(root, 'repo-398'));
  });
});

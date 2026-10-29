import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import type * as fsModule from 'node:fs';
import type * as fsPromisesModule from 'node:fs/promises';
import { open as openFile } from 'node:fs/promises';
import { linkSync, lstatSync, renameSync, symlinkSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import {
  CopyError,
  copyIntoDestination,
  copyTempName,
  prepareChosenDestination,
  prepareWorkspaceDestination,
  type CopyDestination,
} from '../workspace-copy';
import { bindFolder, type CommitOutcome } from '../folder-commit';
import type * as folderCommitModule from '../folder-commit';

// The real open, which one test wraps to swap a folder just before it.
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof fsPromisesModule>('node:fs/promises');
  return { ...actual, open: jest.fn(actual.open) };
});
// The real helper, which tests wrap to act between binding and the commit.
jest.mock('../folder-commit', () => {
  const actual =
    jest.requireActual<typeof folderCommitModule>('../folder-commit');
  return { ...actual, bindFolder: jest.fn(actual.bindFolder) };
});
// The real link and rename, which one test wraps to look names up one by one.
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof fsModule>('node:fs');
  return {
    ...actual,
    linkSync: jest.fn(actual.linkSync),
    renameSync: jest.fn(actual.renameSync),
  };
});

let base: string;
let workspace: string;
let outside: string;
let source: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'workspace-copy-'));
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  source = join(base, 'report.csv');
  await writeFile(source, 'a,b\n1,2\n');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function identity(path: string): { dev: number; ino: number } {
  const stat = lstatSync(path);
  return { dev: stat.dev, ino: stat.ino };
}
async function prepared(relativePath: string): Promise<CopyDestination> {
  const result = await prepareWorkspaceDestination(workspace, relativePath);
  if (!result.ok) throw new Error(result.error.message);
  return result.destination;
}
function copy(
  destination: CopyDestination,
  options: {
    overwrite?: boolean;
    signal?: AbortSignal;
    onProgress?: (copied: number) => void;
    mark?: (path: string) => Promise<void>;
    from?: string;
  } = {},
): Promise<{ path: string; bytes: number }> {
  const from = options.from ?? source;
  return copyIntoDestination({
    source: from,
    sourceIdentity: identity(from),
    destination,
    overwrite: options.overwrite ?? false,
    tempName: copyTempName(),
    signal: options.signal ?? new AbortController().signal,
    onProgress: options.onProgress,
    mark: options.mark,
  });
}
async function leftovers(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith('.part'));
}
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CopyError) return error.code;
    throw error;
  }
  throw new Error('Expected the copy to fail');
}

describe('prepareWorkspaceDestination', () => {
  it('resolves a nested path and lists the folders to create', async () => {
    const destination = await prepared('exports/2026/report.csv');
    expect(destination).toMatchObject({
      missing: ['exports', '2026'],
      name: 'report.csv',
      exists: false,
    });
    expect(destination.path).toBe(
      join(destination.base, 'exports', '2026', 'report.csv'),
    );
  });

  it.each([
    ['an absolute path', '/etc/report.csv'],
    ['a path that leaves the workspace', '../outside/report.csv'],
    ['a path that leaves it partway', 'a/../../report.csv'],
    ['an empty path', ''],
    ['a folder path', 'exports/'],
    ['a name with a NUL', 'report\u0000.csv'],
    ['a name the file system cannot hold', 'report?.csv'],
  ])('refuses %s', async (_label, path) => {
    const result = await prepareWorkspaceDestination(workspace, path);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_path' },
    });
  });

  it('refuses a folder that is a link, even one that points inside', async () => {
    await symlink(outside, join(workspace, 'away'));
    await mkdir(join(workspace, 'real'));
    await symlink(join(workspace, 'real'), join(workspace, 'alias'));
    for (const path of ['away/report.csv', 'alias/report.csv'])
      expect(await prepareWorkspaceDestination(workspace, path)).toMatchObject({
        ok: false,
        error: { code: 'file_not_eligible' },
      });
  });

  it('refuses a folder at the name, and reports a file there', async () => {
    await mkdir(join(workspace, 'taken'));
    await writeFile(join(workspace, 'existing.csv'), 'old');
    expect(await prepareWorkspaceDestination(workspace, 'taken')).toMatchObject(
      { ok: false, error: { code: 'file_not_eligible' } },
    );
    expect(await prepared('existing.csv')).toMatchObject({ exists: true });
  });
});

describe('prepareChosenDestination', () => {
  it('takes an absolute path whose folder exists', async () => {
    const result = await prepareChosenDestination(join(outside, 'copy.csv'));
    expect(result).toMatchObject({
      ok: true,
      destination: { name: 'copy.csv', missing: [], exists: false },
    });
  });

  it('refuses a relative path or a missing folder', async () => {
    expect(await prepareChosenDestination('copy.csv')).toMatchObject({
      ok: false,
      error: { code: 'invalid_path' },
    });
    expect(
      await prepareChosenDestination(join(outside, 'missing', 'copy.csv')),
    ).toMatchObject({ ok: false, error: { code: 'file_not_eligible' } });
  });
});

describe('copyIntoDestination', () => {
  it('copies the bytes, creates the folders, reports progress, and leaves no partial file', async () => {
    const progress: number[] = [];
    const destination = await prepared('exports/report.csv');
    const result = await copy(destination, {
      onProgress: (copied) => progress.push(copied),
    });
    expect(result).toEqual({
      path: join(destination.base, 'exports', 'report.csv'),
      bytes: 8,
    });
    expect(await readFile(result.path, 'utf8')).toBe('a,b\n1,2\n');
    expect(progress.at(-1)).toBe(8);
    expect(await leftovers(join(workspace, 'exports'))).toEqual([]);
  });

  it('keeps a file that took the name after the check, unless told to overwrite', async () => {
    const destination = await prepared('report.csv');
    await writeFile(join(workspace, 'report.csv'), 'mine');
    expect(await codeOf(copy(destination))).toBe('destination_exists');
    expect(await readFile(join(workspace, 'report.csv'), 'utf8')).toBe('mine');
    expect(await leftovers(workspace)).toEqual([]);

    await copy(await prepared('report.csv'), { overwrite: true });
    expect(await readFile(join(workspace, 'report.csv'), 'utf8')).toBe(
      'a,b\n1,2\n',
    );
  });

  it('replaces a link at the name without writing through it', async () => {
    await writeFile(join(outside, 'target.csv'), 'outside');
    await symlink(join(outside, 'target.csv'), join(workspace, 'report.csv'));
    await copy(await prepared('report.csv'), { overwrite: true });
    expect(lstatSync(join(workspace, 'report.csv')).isSymbolicLink()).toBe(
      false,
    );
    expect(await readFile(join(outside, 'target.csv'), 'utf8')).toBe('outside');
  });

  it('never writes through a folder swapped for a link after the check', async () => {
    await mkdir(join(workspace, 'exports'));
    const destination = await prepared('exports/report.csv');
    await rename(join(workspace, 'exports'), join(base, 'moved'));
    await symlink(outside, join(workspace, 'exports'));
    expect(await codeOf(copy(destination))).toBe('file_not_eligible');
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(join(base, 'moved'))).toEqual([]);
  });

  it('refuses a source that was replaced', async () => {
    const destination = await prepared('report.csv');
    const sourceIdentity = identity(source);
    // Made while the original exists, so it cannot reuse the original's inode.
    await writeFile(`${source}.new`, 'other');
    await rename(`${source}.new`, source);
    await expect(
      copyIntoDestination({
        source,
        sourceIdentity,
        destination,
        overwrite: false,
        tempName: copyTempName(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'file_not_eligible' });
    expect(await readdir(workspace)).toEqual([]);
  });

  it('stops when cancelled and removes its partial file', async () => {
    const large = join(base, 'large.bin');
    await writeFile(large, Buffer.alloc(8 * 1024 * 1024, 1));
    const controller = new AbortController();
    const destination = await prepared('large.bin');
    await expect(
      copy(destination, {
        from: large,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow();
    expect(await readdir(workspace)).toEqual([]);
  });

  it('never adds a file by its path on a file system without hard links, and replaces only with overwrite', async () => {
    const actual =
      jest.requireActual<typeof folderCommitModule>('../folder-commit');
    jest.mocked(bindFolder).mockImplementationOnce(async (folder) => {
      const bound = await actual.bindFolder(folder);
      return {
        identity: bound.identity,
        commit: (): Promise<CommitOutcome> => {
          bound.close();
          return Promise.resolve({ type: 'failed', code: 'EPERM' });
        },
        close: (): void => bound.close(),
      };
    });
    expect(await codeOf(copy(await prepared('report.csv')))).toBe(
      'file_not_eligible',
    );
    expect(await readdir(workspace)).toEqual([]);
    // Overwrite commits with a rename, which needs no hard link.
    await copy(await prepared('report.csv'), { overwrite: true });
    expect(await readFile(join(workspace, 'report.csv'), 'utf8')).toBe(
      'a,b\n1,2\n',
    );
    expect(await leftovers(workspace)).toEqual([]);
  });

  it('commits in the checked folder when a folder is swapped for a link after the helper binds to it', async () => {
    const actual =
      jest.requireActual<typeof folderCommitModule>('../folder-commit');
    const real = (): string =>
      jest.requireActual<typeof fsModule>('node:fs').realpathSync(workspace);
    // Something writing in the workspace moves the folder and puts a link to
    // a folder outside in its place, just before the commit.
    const swapAfterBinding = (): void => {
      jest.mocked(bindFolder).mockImplementationOnce(async (folder) => {
        const bound = await actual.bindFolder(folder);
        return {
          identity: bound.identity,
          commit: async (request): Promise<CommitOutcome> => {
            await rename(join(real(), 'exports'), join(real(), 'moved'));
            await symlink(outside, join(real(), 'exports'));
            return bound.commit(request);
          },
          close: (): void => bound.close(),
        };
      });
    };
    const reset = async (): Promise<void> => {
      await rm(join(workspace, 'exports'), { recursive: true, force: true });
      await rm(join(workspace, 'moved'), { recursive: true, force: true });
      await mkdir(join(workspace, 'exports'));
    };

    await reset();
    swapAfterBinding();
    await copy(await prepared('exports/report.csv'));
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(join(workspace, 'moved', 'report.csv'), 'utf8')).toBe(
      'a,b\n1,2\n',
    );
    expect(await leftovers(join(workspace, 'moved'))).toEqual([]);

    await reset();
    await writeFile(join(outside, 'report.csv'), 'outside');
    swapAfterBinding();
    await copy(await prepared('exports/report.csv'), { overwrite: true });
    expect(await readFile(join(outside, 'report.csv'), 'utf8')).toBe('outside');
    expect(await readFile(join(workspace, 'moved', 'report.csv'), 'utf8')).toBe(
      'a,b\n1,2\n',
    );
  });

  it('cannot be redirected by a folder swapped between the commit looking up its two names', async () => {
    const actual = jest.requireActual<typeof fsModule>('node:fs');
    // A link or rename looks up its source, then its destination. Something
    // writing in the workspace swaps the folder for a link in between: the
    // source is already found in the real folder, and the destination would
    // be found through the link, outside.
    const twoLookups =
      (commit: (from: string, to: string) => void) =>
      (from: fsModule.PathLike, to: fsModule.PathLike): void => {
        const real = actual.realpathSync(workspace);
        const fromFolder = actual.realpathSync(path.dirname(String(from)));
        actual.renameSync(join(real, 'exports'), join(real, 'moved'));
        symlinkSync(outside, join(real, 'exports'));
        // The source stays the file found in the real folder, now moved.
        const sourceNow = join(
          fromFolder === join(real, 'exports')
            ? join(real, 'moved')
            : fromFolder,
          path.basename(String(from)),
        );
        commit(
          sourceNow,
          join(
            actual.realpathSync(path.dirname(String(to))),
            path.basename(String(to)),
          ),
        );
      };
    const reset = async (): Promise<void> => {
      await rm(join(workspace, 'exports'), { recursive: true, force: true });
      await rm(join(workspace, 'moved'), { recursive: true, force: true });
      await mkdir(join(workspace, 'exports'));
    };

    await reset();
    jest
      .mocked(linkSync)
      .mockImplementationOnce(
        twoLookups((from, to) => actual.linkSync(from, to)),
      );
    await copy(await prepared('exports/report.csv')).catch(() => undefined);
    expect(await readdir(outside)).toEqual([]);

    await reset();
    jest
      .mocked(renameSync)
      .mockImplementationOnce(
        twoLookups((from, to) => actual.renameSync(from, to)),
      );
    await copy(await prepared('exports/report.csv'), {
      overwrite: true,
    }).catch(() => undefined);
    expect(await readdir(outside)).toEqual([]);
    jest.mocked(linkSync).mockImplementation(actual.linkSync);
    jest.mocked(renameSync).mockImplementation(actual.renameSync);
  });

  it('writes no byte into a folder swapped for a link before its temp file opens', async () => {
    const actual = jest.requireActual<typeof fsModule>('node:fs');
    const realOpen =
      jest.requireActual<typeof fsPromisesModule>('node:fs/promises').open;
    await mkdir(join(workspace, 'exports'));
    const destination = await prepared('exports/report.csv');
    let writes = 0;
    jest.mocked(openFile).mockImplementation(async (file, flags, mode) => {
      if (String(file).endsWith('.part')) {
        actual.renameSync(join(workspace, 'exports'), join(base, 'moved'));
        symlinkSync(outside, join(workspace, 'exports'));
        const handle = await realOpen(file, flags, mode);
        const write = handle.write.bind(handle);
        Object.defineProperty(handle, 'write', {
          value: (...args: Parameters<typeof write>) => {
            writes += 1;
            return write(...args);
          },
        });
        return handle;
      }
      return realOpen(file, flags, mode);
    });
    try {
      expect(await codeOf(copy(destination))).toBe('file_not_eligible');
    } finally {
      jest.mocked(openFile).mockImplementation(realOpen);
    }
    expect(writes).toBe(0);
    expect(await readdir(outside)).toEqual([]);
  });

  it('marks the copy as downloaded before it takes its name', async () => {
    const marked: string[] = [];
    const destination = await prepared('report.csv');
    await copy(destination, {
      mark: (path) => {
        marked.push(path);
        expect(existsSync(join(workspace, 'report.csv'))).toBe(false);
        return Promise.resolve();
      },
    });
    expect(marked).toHaveLength(1);
    expect(path.dirname(marked[0] ?? '')).toBe(destination.base);
    expect(await readFile(join(workspace, 'report.csv'), 'utf8')).toBe(
      'a,b\n1,2\n',
    );

    // A copy that cannot be marked is not saved.
    await expect(
      copy(await prepared('unmarked.csv'), {
        mark: () => Promise.reject(new Error('xattr failed')),
      }),
    ).rejects.toMatchObject({ code: 'copy_failed' });
    expect(existsSync(join(workspace, 'unmarked.csv'))).toBe(false);
    expect(await leftovers(workspace)).toEqual([]);
  });
});

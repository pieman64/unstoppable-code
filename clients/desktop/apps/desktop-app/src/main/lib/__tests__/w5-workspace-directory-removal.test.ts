import {
  mkdtemp,
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  removeWorkspaceDirectoryAfterRecordRemoval,
  removeWorkspaceNonW5Children,
} from '../w5-workspace-directory-removal';
import { logMainProcessWarn } from '../main-process-logging';

let mockRoot = '';
jest.mock('../paths', () => ({
  getWorkspaceDir: (id: string): string => join(mockRoot, id),
}));
jest.mock('../main-process-logging', () => ({ logMainProcessWarn: jest.fn() }));
beforeEach(async () => {
  mockRoot = await mkdtemp(join(tmpdir(), 'w5-directory-removal-'));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(mockRoot, { recursive: true, force: true });
});

it('removes non-W5 children first, preserving records and a peer recreation after commit', async () => {
  const directory = join(mockRoot, 'ws');
  await mkdir(join(directory, 'child'), { recursive: true });
  await writeFile(join(directory, 'child', 'file'), 'data');
  await writeFile(join(directory, 'workspace.json'), 'manifest');
  await writeFile(join(directory, 'worktrees.json'), 'list');
  await removeWorkspaceNonW5Children('ws');
  expect((await readdir(directory)).sort()).toEqual([
    'workspace.json',
    'worktrees.json',
  ]);
  await rm(join(directory, 'workspace.json'));
  await rm(join(directory, 'worktrees.json'));
  await writeFile(join(directory, 'workspace.json'), 'peer');
  await removeWorkspaceDirectoryAfterRecordRemoval('ws');
  expect(await readFile(join(directory, 'workspace.json'), 'utf8')).toBe(
    'peer',
  );
  expect(logMainProcessWarn).toHaveBeenCalledWith(expect.any(String), {
    workspaceId: 'ws',
    code: 'ENOTEMPTY',
  });
});

it('removes an empty directory and tolerates already absent directories', async () => {
  await mkdir(join(mockRoot, 'ws'));
  await removeWorkspaceDirectoryAfterRecordRemoval('ws');
  await expect(readdir(join(mockRoot, 'ws'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await removeWorkspaceDirectoryAfterRecordRemoval('ws');
  await removeWorkspaceNonW5Children('ws');
});

it('refuses a symlinked workspace instead of deleting the target directory contents', async () => {
  const target = join(mockRoot, 'source-repository');
  await mkdir(target);
  await writeFile(join(target, 'important'), 'preserve me');
  await symlink(target, join(mockRoot, 'ws'), 'dir');

  await expect(removeWorkspaceNonW5Children('ws')).rejects.toThrow(
    'symbolic link',
  );
  expect(await readFile(join(target, 'important'), 'utf8')).toBe('preserve me');
});

it('refuses raw cleanup inside an active decision, but permits after-apply work', async () => {
  const { runW5Commit, afterW5Apply } = await import('../w5-commit-scope');
  await mkdir(join(mockRoot, 'ws'));
  await runW5Commit(
    {},
    { operation: 'test' },
    async () => {
      await expect(removeWorkspaceNonW5Children('ws')).rejects.toThrow(
        'outside a W5 commit scope',
      );
      await expect(
        removeWorkspaceDirectoryAfterRecordRemoval('ws'),
      ).rejects.toThrow('outside a W5 commit scope');
      await afterW5Apply(() =>
        removeWorkspaceDirectoryAfterRecordRemoval('ws'),
      );
    },
    async () => {},
  );
  await expect(readdir(join(mockRoot, 'ws'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('refuses a workspace replaced with a symlink after enumeration, preserving the external tree', async () => {
  const directory = join(mockRoot, 'ws');
  const target = join(mockRoot, 'source-repository');
  await mkdir(directory);
  await mkdir(target);
  await writeFile(join(directory, 'important'), 'old');
  await writeFile(join(target, 'important'), 'preserve me');
  const originalReaddir = filesystem.readdir;
  const scan = jest
    .spyOn(filesystem, 'readdir')
    .mockImplementationOnce(async (...args) => {
      const entries = await originalReaddir(...args);
      await rename(directory, join(mockRoot, 'original'));
      await symlink(target, directory, 'dir');
      return entries;
    });

  const outcome = await removeWorkspaceNonW5Children('ws').then(
    () => null,
    (error: unknown) => error,
  );
  expect(scan).toHaveBeenCalledTimes(1);
  expect(outcome).toMatchObject({
    message: 'Workspace directory changed during cleanup',
  });
  expect(await readFile(join(target, 'important'), 'utf8')).toBe('preserve me');
  expect(await readFile(join(mockRoot, 'original', 'important'), 'utf8')).toBe(
    'old',
  );
});

it('refuses a different directory moved onto the same name after enumeration', async () => {
  const directory = join(mockRoot, 'ws');
  const replacement = join(mockRoot, 'replacement');
  await mkdir(directory);
  await mkdir(replacement);
  await writeFile(join(directory, 'child'), 'old');
  await writeFile(join(replacement, 'child'), 'peer');
  const originalReaddir = filesystem.readdir;
  const scan = jest
    .spyOn(filesystem, 'readdir')
    .mockImplementationOnce(async (...args) => {
      const entries = await originalReaddir(...args);
      await rename(directory, join(mockRoot, 'original'));
      await rename(replacement, directory);
      return entries;
    });

  await expect(removeWorkspaceNonW5Children('ws')).rejects.toThrow(
    'Workspace directory changed during cleanup',
  );
  expect(scan).toHaveBeenCalledTimes(1);
  expect(await readFile(join(directory, 'child'), 'utf8')).toBe('peer');
  expect(await readFile(join(mockRoot, 'original', 'child'), 'utf8')).toBe(
    'old',
  );
});

it('rechecks between children, refusing a replacement without deleting its contents', async () => {
  const directory = join(mockRoot, 'ws');
  const target = join(mockRoot, 'source-repository');
  await mkdir(directory);
  await mkdir(target);
  for (const child of ['a', 'b', 'workspace.json', 'worktrees.json']) {
    await writeFile(join(directory, child), 'old');
    await writeFile(join(target, child), 'peer');
  }
  const originalRm = filesystem.rm;
  const removal = jest
    .spyOn(filesystem, 'rm')
    .mockImplementationOnce(async (...args) => {
      await originalRm(...args);
      await rename(directory, join(mockRoot, 'original'));
      await symlink(target, directory, 'dir');
    });

  await expect(removeWorkspaceNonW5Children('ws')).rejects.toThrow(
    'Workspace directory changed during cleanup',
  );
  expect(removal).toHaveBeenCalledTimes(1);
  expect((await readdir(target)).sort()).toEqual([
    'a',
    'b',
    'workspace.json',
    'worktrees.json',
  ]);
  const remaining = await readdir(join(mockRoot, 'original'));
  expect(remaining).toHaveLength(3);
  expect(remaining).toEqual(
    expect.arrayContaining(['workspace.json', 'worktrees.json']),
  );
});

it('unlinks child symlinks without following targets and preserves literal POSIX filenames', async () => {
  const directory = join(mockRoot, 'ws');
  const target = join(mockRoot, 'source-repository');
  await mkdir(directory);
  await mkdir(target);
  await writeFile(join(target, 'workspace.json'), 'peer');
  await symlink(target, join(directory, 'external'), 'dir');
  await symlink(join(mockRoot, 'absent'), join(directory, 'dangling'), 'dir');
  // Backslash is a literal filename on POSIX, not a path separator.
  if (process.platform !== 'win32')
    await writeFile(join(directory, 'literal\\name'), 'old');
  await writeFile(join(directory, 'workspace.json'), 'manifest');
  await writeFile(join(directory, 'worktrees.json'), 'list');

  await removeWorkspaceNonW5Children('ws');
  expect((await readdir(directory)).sort()).toEqual([
    'workspace.json',
    'worktrees.json',
  ]);
  expect(await readFile(join(target, 'workspace.json'), 'utf8')).toBe('peer');
});

it('propagates a child removal failure without touching either W5 record', async () => {
  const directory = join(mockRoot, 'ws');
  await mkdir(directory);
  await writeFile(join(directory, 'child'), 'old');
  await writeFile(join(directory, 'workspace.json'), 'manifest');
  await writeFile(join(directory, 'worktrees.json'), 'list');
  const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
  const removal = jest.spyOn(filesystem, 'rm').mockRejectedValueOnce(busy);

  await expect(removeWorkspaceNonW5Children('ws')).rejects.toBe(busy);
  expect(removal).toHaveBeenCalledTimes(1);
  expect((await readdir(directory)).sort()).toEqual([
    'child',
    'workspace.json',
    'worktrees.json',
  ]);
});

it('refuses canonical ancestor drift even when the workspace inode is unchanged', async () => {
  const fixtureRoot = mockRoot;
  mockRoot = join(fixtureRoot, 'parent');
  const directory = join(mockRoot, 'ws');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'child'), 'old');
    const originalReaddir = filesystem.readdir;
    const scan = jest
      .spyOn(filesystem, 'readdir')
      .mockImplementationOnce(async (...args) => {
        const entries = await originalReaddir(...args);
        await rename(mockRoot, join(fixtureRoot, 'moved-parent'));
        await symlink(join(fixtureRoot, 'moved-parent'), mockRoot, 'dir');
        return entries;
      });

    await expect(removeWorkspaceNonW5Children('ws')).rejects.toThrow(
      'Workspace directory changed during cleanup',
    );
    expect(scan).toHaveBeenCalledTimes(1);
    expect(await readFile(join(directory, 'child'), 'utf8')).toBe('old');
  } finally {
    mockRoot = fixtureRoot;
  }
});

it.each([true, false])(
  'preserves a replaced root on permission failure (POSIX recovery available: %s)',
  async (posixRecoveryAvailable) => {
    const directory = join(mockRoot, 'ws');
    const target = join(mockRoot, 'source-repository');
    await mkdir(join(directory, 'child'), { recursive: true });
    await mkdir(join(target, 'child'), { recursive: true });
    await writeFile(join(directory, 'child', 'file'), 'old');
    await writeFile(join(target, 'child', 'file'), 'peer');
    const denied = Object.assign(new Error('denied'), {
      code: 'EACCES',
      syscall: 'unlink',
      path: join(directory, 'child', 'file'),
    });
    const opened = jest.spyOn(filesystem, 'open');
    const removal = jest
      .spyOn(filesystem, 'rm')
      .mockImplementationOnce(async () => {
        await rename(directory, join(mockRoot, 'original'));
        await symlink(target, directory, 'dir');
        throw denied;
      });

    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
    Object.defineProperty(process, 'getuid', {
      configurable: true,
      value: posixRecoveryAvailable ? (): number => 1000 : undefined,
    });
    try {
      const cleanup = removeWorkspaceNonW5Children('ws');
      if (posixRecoveryAvailable) {
        await expect(cleanup).rejects.toThrow(
          'Workspace directory changed during cleanup',
        );
      } else {
        // Without POSIX ownership, the boundary propagates the failure without repair.
        await expect(cleanup).rejects.toBe(denied);
      }
    } finally {
      if (getuidDescriptor) {
        Object.defineProperty(process, 'getuid', getuidDescriptor);
      } else {
        Reflect.deleteProperty(process, 'getuid');
      }
    }
    expect(removal).toHaveBeenCalledTimes(1);
    expect(opened).not.toHaveBeenCalled();
    expect(await readFile(join(target, 'child', 'file'), 'utf8')).toBe('peer');
    expect(
      await readFile(join(mockRoot, 'original', 'child', 'file'), 'utf8'),
    ).toBe('old');
  },
);

it('refuses non-directory roots and propagates unreadable directories', async () => {
  await writeFile(join(mockRoot, 'ws'), 'not a directory');
  await expect(removeWorkspaceNonW5Children('ws')).rejects.toThrow(
    'requires a directory',
  );
  await rm(join(mockRoot, 'ws'));
  await mkdir(join(mockRoot, 'ws'));
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  jest.spyOn(filesystem, 'readdir').mockRejectedValueOnce(denied);
  await expect(removeWorkspaceNonW5Children('ws')).rejects.toBe(denied);
});

it('preserves records behind nested child symlinks without following their targets', async () => {
  const directory = join(mockRoot, 'ws');
  const target = join(mockRoot, 'source-repository');
  await mkdir(join(directory, 'child'), { recursive: true });
  await mkdir(target);
  await writeFile(join(target, 'workspace.json'), 'peer');
  await symlink(target, join(directory, 'child', 'external'), 'dir');
  await writeFile(join(directory, 'workspace.json'), 'manifest');
  await writeFile(join(directory, 'worktrees.json'), 'list');

  await removeWorkspaceNonW5Children('ws');
  expect((await readdir(directory)).sort()).toEqual([
    'workspace.json',
    'worktrees.json',
  ]);
  expect(await readFile(join(target, 'workspace.json'), 'utf8')).toBe('peer');
});

it.each([
  ['WORKSPACE.JSON', 'Worktrees.Json'],
  ['worKspace.json', 'worktreeſ.json'],
])('preserves W5 record aliases %s and %s', async (manifest, list) => {
  const directory = join(mockRoot, 'ws');
  await mkdir(directory);
  await writeFile(join(directory, manifest), 'manifest');
  await writeFile(join(directory, list), 'list');
  await writeFile(join(directory, 'child'), 'remove me');

  await removeWorkspaceNonW5Children('ws');
  await removeWorkspaceDirectoryAfterRecordRemoval('ws');
  expect(await readFile(join(directory, manifest), 'utf8')).toBe('manifest');
  expect(await readFile(join(directory, list), 'utf8')).toBe('list');
  expect((await readdir(directory)).sort()).toEqual([manifest, list].sort());
  expect(logMainProcessWarn).toHaveBeenLastCalledWith(expect.any(String), {
    workspaceId: 'ws',
    code: 'ENOTEMPTY',
  });
});

it('reserves filesystem identities of the canonical records independently of spelling', async () => {
  const directory = join(mockRoot, 'ws');
  await mkdir(directory);
  await writeFile(join(directory, 'workspace.json'), 'manifest');
  await writeFile(join(directory, 'worktrees.json'), 'list');
  await link(
    join(directory, 'workspace.json'),
    join(directory, 'manifest-alias'),
  );
  await link(join(directory, 'worktrees.json'), join(directory, 'list-alias'));
  await writeFile(join(directory, 'child'), 'remove me');

  await removeWorkspaceNonW5Children('ws');
  expect((await readdir(directory)).sort()).toEqual([
    'list-alias',
    'manifest-alias',
    'workspace.json',
    'worktrees.json',
  ]);
  expect(await readFile(join(directory, 'workspace.json'), 'utf8')).toBe(
    'manifest',
  );
  expect(await readFile(join(directory, 'worktrees.json'), 'utf8')).toBe(
    'list',
  );
});

it('refuses cleanup when a canonical record identity cannot be inspected', async () => {
  const directory = join(mockRoot, 'ws');
  await mkdir(directory);
  await writeFile(join(directory, 'child'), 'keep on refusal');
  const originalLstat = filesystem.lstat;
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  jest.spyOn(filesystem, 'lstat').mockImplementation(async (...args) => {
    if (args[0] === join(directory, 'workspace.json')) throw denied;
    return originalLstat(...args);
  });
  const removal = jest.spyOn(filesystem, 'rm');

  await expect(removeWorkspaceNonW5Children('ws')).rejects.toBe(denied);
  expect(removal).not.toHaveBeenCalled();
  expect(await readFile(join(directory, 'child'), 'utf8')).toBe(
    'keep on refusal',
  );
});

it('propagates an unreadable root without attempting enumeration or removal', async () => {
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  jest.spyOn(filesystem, 'lstat').mockRejectedValueOnce(denied);
  const scan = jest.spyOn(filesystem, 'readdir');
  const removal = jest.spyOn(filesystem, 'rm');

  await expect(removeWorkspaceNonW5Children('ws')).rejects.toBe(denied);
  expect(scan).not.toHaveBeenCalled();
  expect(removal).not.toHaveBeenCalled();
});

it('logs EEXIST on final removal and propagates other directory errors without recursive fallback', async () => {
  const directory = join(mockRoot, 'ws');
  await mkdir(directory);
  await writeFile(join(directory, 'workspace.json'), 'peer');
  const removal = jest.spyOn(filesystem, 'rm');
  const finalRemoval = jest.spyOn(filesystem, 'rmdir');
  finalRemoval.mockRejectedValueOnce(
    Object.assign(new Error('exists'), { code: 'EEXIST' }),
  );

  await removeWorkspaceDirectoryAfterRecordRemoval('ws');
  expect(logMainProcessWarn).toHaveBeenLastCalledWith(expect.any(String), {
    workspaceId: 'ws',
    code: 'EEXIST',
  });
  const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
  finalRemoval.mockRejectedValueOnce(busy);
  await expect(removeWorkspaceDirectoryAfterRecordRemoval('ws')).rejects.toBe(
    busy,
  );
  expect(finalRemoval).toHaveBeenCalledTimes(2);
  expect(removal).not.toHaveBeenCalled();
  expect(await readFile(join(directory, 'workspace.json'), 'utf8')).toBe(
    'peer',
  );
});

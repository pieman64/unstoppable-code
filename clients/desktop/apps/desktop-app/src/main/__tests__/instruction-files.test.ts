import type * as FsPromises from 'node:fs/promises';
jest.mock('node:fs/promises');

import { statSync, type Stats } from 'node:fs';
import {
  access,
  copyFile,
  link,
  lstat,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveProjectInstructionFile,
  restoreProjectInstructionFiles,
  writeProjectInstructionFile,
  ensureAgentsMdSymlink,
  ensureAgentsMdSymlinkOrCopy,
  ensureRelativeSymlink,
  hasExpectedAgentsMdSymlinkOrCopy,
} from '../lib/instruction-files';
import { isProjectInstructionFileReadable } from '@canopy/desktop-shared/node/lib/project-instruction-files';

const mockedCopyFile = jest.mocked(copyFile);
const mockedLink = jest.mocked(link);
const mockedLstat = jest.mocked(lstat);
const mockedReadFile = jest.mocked(readFile);
const mockedReadlink = jest.mocked(readlink);
const mockedRm = jest.mocked(rm);
const mockedSymlink = jest.mocked(symlink);

function makeStats(isSymbolicLink: boolean): Stats {
  const stats = statSync(__filename);
  Object.defineProperty(stats, 'isSymbolicLink', {
    value: (): boolean => isSymbolicLink,
  });
  return stats;
}

function makeMissingError(): Error & { code: string } {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

function makeExistsError(): Error & { code: string } {
  return Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
}

function makePermissionError(): Error & { code: string } {
  return Object.assign(new Error('EPERM'), { code: 'EPERM' });
}

describe('instruction file symlink helpers', () => {
  const projectDir = '/tmp/project';
  const agentsPath = join(projectDir, 'AGENTS.md');

  beforeEach(() => {
    jest.clearAllMocks();
    mockedCopyFile.mockResolvedValue(undefined);
    mockedLink.mockResolvedValue(undefined);
    mockedReadFile.mockResolvedValue('same');
    mockedRm.mockResolvedValue(undefined);
    mockedSymlink.mockResolvedValue(undefined);
  });

  it('creates AGENTS.md when the symlink is missing', async () => {
    mockedLstat.mockRejectedValueOnce(makeMissingError());

    await ensureAgentsMdSymlink(projectDir, 'darwin');

    expect(mockedSymlink).toHaveBeenCalledWith('CLAUDE.md', agentsPath);
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('treats a concurrent matching symlink creation as success', async () => {
    mockedLstat
      .mockRejectedValueOnce(makeMissingError())
      .mockResolvedValueOnce(makeStats(true));
    mockedReadlink.mockResolvedValueOnce('CLAUDE.md');
    mockedSymlink.mockRejectedValueOnce(makeExistsError());

    await ensureAgentsMdSymlink(projectDir, 'darwin');

    expect(mockedSymlink).toHaveBeenCalledWith('CLAUDE.md', agentsPath);
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('leaves a correct symlink untouched', async () => {
    mockedLstat.mockResolvedValueOnce(makeStats(true));
    mockedReadlink.mockResolvedValueOnce('CLAUDE.md');

    await ensureAgentsMdSymlink(projectDir, 'darwin');

    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedSymlink).not.toHaveBeenCalled();
  });

  it('leaves an equivalent symlink target untouched', async () => {
    mockedLstat.mockResolvedValueOnce(makeStats(true));
    mockedReadlink.mockResolvedValueOnce('./CLAUDE.md');

    await ensureAgentsMdSymlink(projectDir, 'darwin');

    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedSymlink).not.toHaveBeenCalled();
  });

  it('replaces a regular file with the requested symlink', async () => {
    mockedLstat.mockResolvedValueOnce(makeStats(false));

    await ensureRelativeSymlink(agentsPath, 'CLAUDE.md');

    expect(mockedRm).toHaveBeenCalledWith(agentsPath, {
      recursive: true,
      force: true,
    });
    expect(mockedSymlink).toHaveBeenCalledWith('CLAUDE.md', agentsPath);
  });

  it('replaces a stale entry with the requested symlink', async () => {
    mockedLstat.mockResolvedValueOnce(makeStats(true));
    mockedReadlink.mockResolvedValueOnce('../CLAUDE.md');

    await ensureRelativeSymlink(agentsPath, 'CLAUDE.md');

    expect(mockedRm).toHaveBeenCalledWith(agentsPath, {
      recursive: true,
      force: true,
    });
    expect(mockedSymlink).toHaveBeenCalledWith('CLAUDE.md', agentsPath);
  });

  it('hardlinks AGENTS.md to CLAUDE.md when symlink creation is not permitted', async () => {
    mockedLstat.mockRejectedValueOnce(makeMissingError());
    mockedSymlink.mockRejectedValueOnce(makePermissionError());

    await ensureAgentsMdSymlinkOrCopy(projectDir, 'darwin');

    expect(mockedSymlink).toHaveBeenCalledWith('CLAUDE.md', agentsPath);
    expect(mockedRm).toHaveBeenCalledWith(agentsPath, {
      recursive: true,
      force: true,
    });
    expect(mockedLink).toHaveBeenCalledWith(
      resolve(projectDir, 'CLAUDE.md'),
      agentsPath,
    );
    expect(mockedCopyFile).not.toHaveBeenCalled();
  });

  it('copies AGENTS.md from CLAUDE.md when symlink and hardlink creation fail', async () => {
    mockedLstat.mockRejectedValueOnce(makeMissingError());
    mockedSymlink.mockRejectedValueOnce(makePermissionError());
    mockedLink.mockRejectedValueOnce(
      Object.assign(new Error('EXDEV'), { code: 'EXDEV' }),
    );

    await ensureAgentsMdSymlinkOrCopy(projectDir, 'darwin');

    expect(mockedLink).toHaveBeenCalledWith(
      resolve(projectDir, 'CLAUDE.md'),
      agentsPath,
    );
    expect(mockedCopyFile).toHaveBeenCalledWith(
      resolve(projectDir, 'CLAUDE.md'),
      agentsPath,
    );
  });

  it('accepts AGENTS.md copies that match CLAUDE.md', async () => {
    mockedLstat.mockResolvedValueOnce(makeStats(false));
    mockedReadFile
      .mockResolvedValueOnce('instructions')
      .mockResolvedValueOnce('instructions');

    await expect(hasExpectedAgentsMdSymlinkOrCopy(projectDir)).resolves.toBe(
      true,
    );
  });

  it('rejects stale AGENTS.md copies', async () => {
    mockedLstat.mockResolvedValueOnce(makeStats(false));
    mockedReadFile
      .mockResolvedValueOnce('stale')
      .mockResolvedValueOnce('current');

    await expect(hasExpectedAgentsMdSymlinkOrCopy(projectDir)).resolves.toBe(
      false,
    );
  });

  it('never attempts a symlink for AGENTS.md on Windows', async () => {
    await ensureAgentsMdSymlink(projectDir, 'win32');

    expect(mockedSymlink).not.toHaveBeenCalled();
    expect(mockedLstat).not.toHaveBeenCalled();
    expect(mockedRm).toHaveBeenCalledWith(agentsPath, {
      recursive: true,
      force: true,
    });
    expect(mockedLink).toHaveBeenCalledWith(
      resolve(projectDir, 'CLAUDE.md'),
      agentsPath,
    );
    expect(mockedCopyFile).not.toHaveBeenCalled();
  });

  it('copies AGENTS.md on Windows when hardlink creation fails', async () => {
    mockedLink.mockRejectedValueOnce(
      Object.assign(new Error('EXDEV'), { code: 'EXDEV' }),
    );

    await ensureAgentsMdSymlink(projectDir, 'win32');

    expect(mockedSymlink).not.toHaveBeenCalled();
    expect(mockedCopyFile).toHaveBeenCalledWith(
      resolve(projectDir, 'CLAUDE.md'),
      agentsPath,
    );
  });
});

describe('project-owned instruction files on disk', () => {
  const realFs = jest.requireActual<typeof FsPromises>('node:fs/promises');
  let root: string;
  beforeEach(async () => {
    jest.mocked(access).mockImplementation(realFs.access);
    jest.mocked(copyFile).mockImplementation(realFs.copyFile);
    jest.mocked(symlink).mockImplementation(realFs.symlink);
    jest.mocked(lstat).mockImplementation(realFs.lstat);
    jest.mocked(readFile).mockImplementation(realFs.readFile);
    jest.mocked(readlink).mockImplementation(realFs.readlink);
    jest.mocked(writeFile).mockImplementation(realFs.writeFile);
    root = await realFs.mkdtemp(join(tmpdir(), 'project-instructions-'));
  });
  afterEach(async () => {
    await realFs.rm(root, { recursive: true, force: true });
  });

  it('creates AGENTS.md for a project with no instructions', async () => {
    await writeProjectInstructionFile(
      await resolveProjectInstructionFile(root),
      '# New rules',
    );
    expect(await realFs.readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(
      '# New rules',
    );
    await expect(realFs.lstat(join(root, 'CLAUDE.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(
    (['AGENTS.md', 'CLAUDE.md'] as const).flatMap((alias) =>
      ['bare', 'dot-relative', 'absolute'].map((format) => ({ alias, format })),
    ),
  )(
    'preserves the $format $alias alias while editing its target',
    async ({ alias, format }) => {
      const target = alias === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
      const linkTarget =
        format === 'absolute'
          ? join(root, target)
          : format === 'dot-relative'
            ? `./${target}`
            : target;
      await realFs.writeFile(join(root, target), '# Original');
      await realFs.symlink(linkTarget, join(root, alias));
      await expect(isProjectInstructionFileReadable(root, alias)).resolves.toBe(
        true,
      );
      await writeProjectInstructionFile(
        await resolveProjectInstructionFile(root),
        '# Updated',
      );
      expect(await realFs.readlink(join(root, alias))).toBe(linkTarget);
      expect(await realFs.readFile(join(root, alias), 'utf8')).toBe(
        '# Updated',
      );
      expect((await realFs.lstat(join(root, target))).isFile()).toBe(true);
    },
  );

  it.each(
    (['AGENTS.md', 'CLAUDE.md'] as const).flatMap((alias) =>
      ['bare', 'dot-relative', 'absolute'].map((format) => ({ alias, format })),
    ),
  )(
    'repairs a broken $format $alias alias without replacing it',
    async ({ alias, format }) => {
      const target = alias === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
      const linkTarget =
        format === 'absolute'
          ? join(root, target)
          : format === 'dot-relative'
            ? `./${target}`
            : target;
      await realFs.symlink(linkTarget, join(root, alias));
      await expect(isProjectInstructionFileReadable(root, alias)).resolves.toBe(
        false,
      );
      const instructions = await resolveProjectInstructionFile(root);
      expect(instructions.exists).toBe(false);
      await writeProjectInstructionFile(instructions, '# Restored');
      expect(await realFs.readlink(join(root, alias))).toBe(linkTarget);
      expect(await realFs.readFile(join(root, alias), 'utf8')).toBe(
        '# Restored',
      );
      expect((await realFs.lstat(join(root, target))).isFile()).toBe(true);
    },
  );

  it.each([true, false])(
    'preserves regular file pairing (mirrored=%s)',
    async (mirrored) => {
      await realFs.writeFile(join(root, 'AGENTS.md'), '# Shared');
      await realFs.writeFile(
        join(root, 'CLAUDE.md'),
        mirrored ? '# Shared' : '# Claude only',
      );
      await writeProjectInstructionFile(
        await resolveProjectInstructionFile(root),
        '# Updated',
      );
      expect(await realFs.readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(
        '# Updated',
      );
      expect(await realFs.readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe(
        mirrored ? '# Updated' : '# Claude only',
      );
    },
  );

  it('does not read or overwrite an instruction symlink outside the project', async () => {
    const repo = join(root, 'repo');
    await realFs.mkdir(repo);
    await realFs.writeFile(join(root, 'outside.md'), '# Private test fixture');
    await realFs.symlink('../outside.md', join(repo, 'AGENTS.md'));
    jest.mocked(readFile).mockClear();
    await expect(resolveProjectInstructionFile(repo)).rejects.toThrow(
      /symbolic link/i,
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(await realFs.readFile(join(root, 'outside.md'), 'utf8')).toBe(
      '# Private test fixture',
    );
  });

  it.each(['AGENTS.md', 'CLAUDE.md'] as const)(
    'does not consider an indirect escaping %s alias readable',
    async (alias) => {
      const target = alias === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
      const repo = join(root, 'repo');
      await realFs.mkdir(repo);
      await realFs.mkdir(join(root, 'outside', 'nested'), { recursive: true });
      await realFs.writeFile(join(root, 'outside', target), '# External');
      await realFs.writeFile(join(repo, target), '# Local');
      await realFs.symlink('../outside/nested', join(repo, 'escape'));
      await realFs.symlink(`escape/../${target}`, join(repo, alias));

      expect(await realFs.readFile(join(repo, alias), 'utf8')).toBe(
        '# External',
      );
      await expect(isProjectInstructionFileReadable(repo, alias)).resolves.toBe(
        false,
      );
    },
  );

  it.each(['AGENTS.md', 'CLAUDE.md'] as const)(
    'rejects an indirect escaping %s alias even when its local target is absent',
    async (alias) => {
      const target = alias === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
      const repo = join(root, 'repo');
      await realFs.mkdir(repo);
      await realFs.mkdir(join(root, 'outside', 'nested'), { recursive: true });
      await realFs.writeFile(join(root, 'outside', target), '# External');
      await realFs.symlink('../outside/nested', join(repo, 'escape'));
      await realFs.symlink(`escape/../${target}`, join(repo, alias));

      await expect(resolveProjectInstructionFile(repo)).rejects.toThrow(
        /symbolic link/i,
      );
      expect(await realFs.readFile(join(repo, alias), 'utf8')).toBe(
        '# External',
      );
      await expect(realFs.lstat(join(repo, target))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('rejects an escaping AGENTS alias instead of editing unrelated local CLAUDE guidance', async () => {
    const repo = join(root, 'repo');
    await realFs.mkdir(repo);
    await realFs.mkdir(join(root, 'outside', 'nested'), { recursive: true });
    await realFs.writeFile(join(root, 'outside', 'CLAUDE.md'), '# External');
    await realFs.writeFile(join(repo, 'CLAUDE.md'), '# Local');
    await realFs.symlink('../outside/nested', join(repo, 'escape'));
    await realFs.symlink('escape/../CLAUDE.md', join(repo, 'AGENTS.md'));

    await expect(resolveProjectInstructionFile(repo)).rejects.toThrow(
      /symbolic link/i,
    );
    expect(await realFs.readFile(join(repo, 'CLAUDE.md'), 'utf8')).toBe(
      '# Local',
    );
  });

  it.each(['AGENTS.md', 'CLAUDE.md'] as const)(
    'does not turn an unsupported %s source alias into a different restored alias',
    async (alias) => {
      const target = alias === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
      const repo = join(root, 'repo');
      const destination = join(root, 'destination');
      await realFs.mkdir(repo);
      await realFs.mkdir(destination);
      await realFs.mkdir(join(root, 'outside', 'nested'), { recursive: true });
      await realFs.writeFile(join(root, 'outside', target), '# External');
      await realFs.writeFile(join(repo, target), '# Local');
      await realFs.symlink('../outside/nested', join(repo, 'escape'));
      await realFs.symlink(`escape/../${target}`, join(repo, alias));

      await restoreProjectInstructionFiles(
        { filePath: join(repo, target), exists: true },
        { filePath: join(destination, 'AGENTS.md'), exists: false },
      );
      expect(await realFs.readFile(join(destination, target), 'utf8')).toBe(
        '# Local',
      );
      await expect(
        realFs.lstat(join(destination, alias)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await realFs.readFile(join(repo, alias), 'utf8')).toBe(
        '# External',
      );
    },
  );
});

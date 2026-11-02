const mockExecFile = jest.fn();
const mockLstat = jest.fn();
const mockMkdir = jest.fn();
const mockReadFile = jest.fn();
const mockRename = jest.fn<Promise<void>, [oldPath: string, newPath: string]>();
const mockRm = jest.fn();
const mockUnlink = jest.fn();
const mockWriteFile = jest.fn<
  Promise<void>,
  [path: string, data: string, encoding: string]
>();

jest.mock('node:child_process', () => ({
  get execFile(): typeof mockExecFile {
    return mockExecFile;
  },
}));

jest.mock('node:fs/promises', () => ({
  get lstat(): typeof mockLstat {
    return mockLstat;
  },
  get mkdir(): typeof mockMkdir {
    return mockMkdir;
  },
  get readFile(): typeof mockReadFile {
    return mockReadFile;
  },
  get rename(): typeof mockRename {
    return mockRename;
  },
  get rm(): typeof mockRm {
    return mockRm;
  },
  get unlink(): typeof mockUnlink {
    return mockUnlink;
  },
  get writeFile(): typeof mockWriteFile {
    return mockWriteFile;
  },
}));

jest.mock('../lib/paths', () => ({
  getOrphanedWorktreeCleanupFilePath: jest.fn(
    () => '/data/orphaned-worktree-cleanup.json',
  ),
  getWorkspaceWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/data/workspaces/${workspaceId}/worktrees/${worktreeId}`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string, repoId: string) =>
      `/data/workspaces/${workspaceId}/worktrees/${worktreeId}/repos/${repoId}`,
  ),
  getWorkspaceWorktreesRootDir: jest.fn(
    (workspaceId: string) => `/data/workspaces/${workspaceId}/worktrees`,
  ),
}));

import {
  queueOrphanedMacosWorktreeDirectory,
  removeExactMacosWorktreeDirectory,
  removeStagedMacosWorktreeDirectory,
  resetOrphanedWorktreeCleanupQueueForTests,
  resolveExactWorktreeDirectoryTarget,
  restoreStagedMacosWorktreeDirectory,
  stageExactMacosWorktreeDirectoryForRemoval,
  sweepOrphanedMacosWorktreeDirectories,
} from '../lib/macos-worktree-directory-cleanup';

function setPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });
  return (): void => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}

function enoent(): Error & { code: string } {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function directoryStats(
  device = 42,
  inode = 84,
): {
  dev: number;
  ino: number;
  isDirectory: () => true;
} {
  return { dev: device, ino: inode, isDirectory: () => true };
}

describe('macOS worktree directory cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetOrphanedWorktreeCleanupQueueForTests();
    mockExecFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null) => void,
      ) => {
        callback(null);
      },
    );
    mockLstat.mockRejectedValue(enoent());
    mockMkdir.mockResolvedValue(undefined);
    mockReadFile.mockRejectedValue(enoent());
    mockRename.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('accepts only the exact top-level directory derived from validated ids', () => {
    expect(
      resolveExactWorktreeDirectoryTarget(
        'canopy',
        'eel',
        '/data/workspaces/canopy/worktrees/eel',
      ),
    ).toBe('/data/workspaces/canopy/worktrees/eel');

    expect(() =>
      resolveExactWorktreeDirectoryTarget(
        'canopy',
        'eel',
        '/data/workspaces/canopy/worktrees/eel/repos/canopy',
      ),
    ).toThrow('Refusing native worktree removal');
    expect(() =>
      resolveExactWorktreeDirectoryTarget(
        'canopy',
        'eel',
        '/data/workspaces/canopy/worktrees',
      ),
    ).toThrow('Refusing native worktree removal');
    expect(() =>
      resolveExactWorktreeDirectoryTarget(
        'canopy',
        'eel',
        '/data/workspaces/canopy/worktrees/other',
      ),
    ).toThrow('Refusing native worktree removal');
  });

  it('accepts only an exact nested repository directory when repo metadata is provided', () => {
    expect(
      resolveExactWorktreeDirectoryTarget(
        'canopy',
        'eel',
        '/data/workspaces/canopy/worktrees/eel/repos/docs',
        'docs',
      ),
    ).toBe('/data/workspaces/canopy/worktrees/eel/repos/docs');

    expect(() =>
      resolveExactWorktreeDirectoryTarget(
        'canopy',
        'eel',
        '/data/workspaces/canopy/worktrees/eel/repos/other',
        'docs',
      ),
    ).toThrow('Refusing native worktree removal');
  });

  it('invokes /bin/rm without a shell and with only the exact worktree path', async () => {
    const restorePlatform = setPlatform('darwin');
    try {
      await removeExactMacosWorktreeDirectory(
        'canopy',
        'eel',
        '/data/workspaces/canopy/worktrees/eel',
      );
    } finally {
      restorePlatform();
    }

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith(
      '/bin/rm',
      ['-rf', '--', '/data/workspaces/canopy/worktrees/eel'],
      { timeout: 300_000 },
      expect.any(Function),
    );
  });

  it('atomically stages only an exact top-level worktree directory', async () => {
    const restorePlatform = setPlatform('darwin');
    mockLstat.mockResolvedValue(directoryStats());
    let cleanupPath = '';
    try {
      cleanupPath = await stageExactMacosWorktreeDirectoryForRemoval(
        'canopy',
        'eel',
        '/data/workspaces/canopy/worktrees/eel',
      );
    } finally {
      restorePlatform();
    }

    expect(cleanupPath).toMatch(
      /^\/data\/workspaces\/canopy\/worktrees\/\.eel\.deleting-[0-9a-f-]{36}$/,
    );
    expect(mockRename).toHaveBeenCalledWith(
      '/data/workspaces/canopy/worktrees/eel',
      cleanupPath,
    );
    const journalPayload = String(mockWriteFile.mock.calls[0]?.[1] ?? '');
    expect(JSON.parse(journalPayload)).toMatchObject({
      entries: [
        {
          workspaceId: 'canopy',
          worktreeId: 'eel',
          worktreePath: '/data/workspaces/canopy/worktrees/eel',
          cleanupPath,
          device: 42,
          inode: 84,
        },
      ],
    });
    expect(mockWriteFile.mock.invocationCallOrder[0]).toBeLessThan(
      mockRename.mock.invocationCallOrder.find(
        (_order, index) =>
          mockRename.mock.calls[index]?.[0] ===
          '/data/workspaces/canopy/worktrees/eel',
      ) ?? Number.POSITIVE_INFINITY,
    );
  });

  it('journals and stages an exact nested repository worktree', async () => {
    const restorePlatform = setPlatform('darwin');
    mockLstat.mockResolvedValue(directoryStats());
    let cleanupPath = '';
    try {
      cleanupPath = await stageExactMacosWorktreeDirectoryForRemoval(
        'canopy',
        'eel',
        '/data/workspaces/canopy/worktrees/eel/repos/docs',
        'docs',
      );
    } finally {
      restorePlatform();
    }

    expect(cleanupPath).toMatch(
      /^\/data\/workspaces\/canopy\/worktrees\/eel\/repos\/\.docs\.deleting-[0-9a-f-]{36}$/,
    );
    const parsed: unknown = JSON.parse(
      String(mockWriteFile.mock.calls[0]?.[1] ?? ''),
    );
    expect(parsed).toMatchObject({
      entries: [
        {
          workspaceId: 'canopy',
          worktreeId: 'eel',
          repoId: 'docs',
          worktreePath: '/data/workspaces/canopy/worktrees/eel/repos/docs',
          cleanupPath,
        },
      ],
    });
  });

  it('removes a validated staged worktree path without accepting siblings', async () => {
    const restorePlatform = setPlatform('darwin');
    const cleanupPath =
      '/data/workspaces/canopy/worktrees/.eel.deleting-00000000-0000-4000-8000-000000000000';
    try {
      await removeStagedMacosWorktreeDirectory(
        'canopy',
        'eel',
        '/data/workspaces/canopy/worktrees/eel',
        cleanupPath,
      );
      await expect(
        removeStagedMacosWorktreeDirectory(
          'canopy',
          'eel',
          '/data/workspaces/canopy/worktrees/eel',
          '/data/workspaces/canopy/worktrees/.other.deleting-00000000-0000-4000-8000-000000000000',
        ),
      ).rejects.toThrow('Refusing staged worktree removal');
    } finally {
      restorePlatform();
    }

    expect(mockExecFile).toHaveBeenCalledWith(
      '/bin/rm',
      ['-rf', '--', cleanupPath],
      { timeout: 300_000 },
      expect.any(Function),
    );
  });

  it('restores only a validated staged path to its exact worktree location', async () => {
    const restorePlatform = setPlatform('darwin');
    const worktreePath = '/data/workspaces/canopy/worktrees/eel';
    const cleanupPath =
      '/data/workspaces/canopy/worktrees/.eel.deleting-00000000-0000-4000-8000-000000000000';
    try {
      await restoreStagedMacosWorktreeDirectory(
        'canopy',
        'eel',
        worktreePath,
        cleanupPath,
      );
    } finally {
      restorePlatform();
    }

    expect(mockRename).toHaveBeenCalledWith(cleanupPath, worktreePath);
  });

  it('never invokes the native fallback off macOS', async () => {
    const restorePlatform = setPlatform('linux');
    try {
      await expect(
        removeExactMacosWorktreeDirectory(
          'canopy',
          'eel',
          '/data/workspaces/canopy/worktrees/eel',
        ),
      ).rejects.toThrow('macOS-only');
    } finally {
      restorePlatform();
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('persists only a validated exact worktree directory for startup retry', async () => {
    const restorePlatform = setPlatform('darwin');
    mockLstat.mockResolvedValue(directoryStats());
    try {
      await queueOrphanedMacosWorktreeDirectory({
        workspaceId: 'canopy',
        worktreeId: 'eel',
        worktreePath: '/data/workspaces/canopy/worktrees/eel',
        error: Object.assign(new Error('denied'), { code: 'EPERM' }),
      });
    } finally {
      restorePlatform();
    }

    const payload = mockWriteFile.mock.calls[0]?.[1] ?? '';
    const parsed: unknown = JSON.parse(payload);
    expect(parsed).toMatchObject({
      version: 1,
      entries: [
        {
          workspaceId: 'canopy',
          worktreeId: 'eel',
          worktreePath: '/data/workspaces/canopy/worktrees/eel',
          device: 42,
          inode: 84,
          lastError: 'denied',
        },
      ],
    });
  });

  it('persists a validated staged worktree directory for startup retry', async () => {
    const restorePlatform = setPlatform('darwin');
    const cleanupPath =
      '/data/workspaces/canopy/worktrees/.eel.deleting-00000000-0000-4000-8000-000000000000';
    const unnormalizedCleanupPath = cleanupPath.replace(
      '/worktrees/',
      '/worktrees/./',
    );
    mockLstat.mockResolvedValue(directoryStats());
    try {
      await queueOrphanedMacosWorktreeDirectory({
        workspaceId: 'canopy',
        worktreeId: 'eel',
        worktreePath: '/data/workspaces/canopy/worktrees/eel',
        cleanupPath: unnormalizedCleanupPath,
        error: new Error('timed out'),
      });
    } finally {
      restorePlatform();
    }

    const payload = mockWriteFile.mock.calls[0]?.[1] ?? '';
    expect(JSON.parse(payload)).toMatchObject({
      entries: [
        {
          worktreePath: '/data/workspaces/canopy/worktrees/eel',
          cleanupPath,
          device: 42,
          inode: 84,
          lastError: 'timed out',
        },
      ],
    });
  });

  it('de-duplicates staged cleanup entries using the normalized path', async () => {
    const restorePlatform = setPlatform('darwin');
    const cleanupPath =
      '/data/workspaces/canopy/worktrees/.eel.deleting-00000000-0000-4000-8000-000000000000';
    mockLstat.mockResolvedValue(directoryStats(43, 85));
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        entries: [
          {
            workspaceId: 'canopy',
            worktreeId: 'eel',
            worktreePath: '/data/workspaces/canopy/worktrees/eel',
            cleanupPath,
            queuedAt: '2026-07-22T00:00:00.000Z',
            device: 42,
            inode: 84,
            lastError: 'first failure',
          },
        ],
      }),
    );
    try {
      await queueOrphanedMacosWorktreeDirectory({
        workspaceId: 'canopy',
        worktreeId: 'eel',
        worktreePath: '/data/workspaces/canopy/worktrees/eel',
        cleanupPath: cleanupPath.replace('/worktrees/', '/worktrees/./'),
        error: new Error('second failure'),
      });
    } finally {
      restorePlatform();
    }

    const parsed: unknown = JSON.parse(
      String(mockWriteFile.mock.calls[0]?.[1] ?? ''),
    );
    expect(parsed).toMatchObject({
      entries: [
        {
          cleanupPath,
          device: 43,
          inode: 85,
          lastError: 'second failure',
        },
      ],
    });
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Expected a cleanup queue object');
    }
    expect(Reflect.get(parsed, 'entries')).toHaveLength(1);
  });

  it('drops a journal entry when a crash occurred before the staging rename', async () => {
    const restorePlatform = setPlatform('darwin');
    const cleanupPath =
      '/data/workspaces/canopy/worktrees/.eel.deleting-00000000-0000-4000-8000-000000000000';
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        entries: [
          {
            workspaceId: 'canopy',
            worktreeId: 'eel',
            worktreePath: '/data/workspaces/canopy/worktrees/eel',
            cleanupPath,
            queuedAt: '2026-07-22T00:00:00.000Z',
            device: 42,
            inode: 84,
            lastError: 'Staged worktree cleanup is pending.',
          },
        ],
      }),
    );

    try {
      await sweepOrphanedMacosWorktreeDirectories();
    } finally {
      restorePlatform();
    }

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalledWith(
      '/data/orphaned-worktree-cleanup.json',
      { force: true },
    );
  });

  it('revalidates persisted entries before a startup sweep', async () => {
    const restorePlatform = setPlatform('darwin');
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        entries: [
          {
            workspaceId: 'canopy',
            worktreeId: 'eel',
            worktreePath: '/data/workspaces/canopy/worktrees/eel/repos/canopy',
            queuedAt: '2026-07-17T00:00:00.000Z',
            device: 42,
            inode: 84,
            lastError: 'denied',
          },
        ],
      }),
    );
    try {
      await sweepOrphanedMacosWorktreeDirectories();
    } finally {
      restorePlatform();
    }

    expect(mockExecFile).not.toHaveBeenCalled();
    const payload = mockWriteFile.mock.calls[0]?.[1] ?? '';
    const parsed: unknown = JSON.parse(payload);
    expect(parsed).toMatchObject({ entries: [{}] });
  });

  it('drops a queued entry without deleting when the directory identity changed', async () => {
    const restorePlatform = setPlatform('darwin');
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        entries: [
          {
            workspaceId: 'canopy',
            worktreeId: 'eel',
            worktreePath: '/data/workspaces/canopy/worktrees/eel',
            queuedAt: '2026-07-17T00:00:00.000Z',
            device: 42,
            inode: 84,
            lastError: 'denied',
          },
        ],
      }),
    );
    mockLstat.mockResolvedValue(directoryStats(42, 999));

    try {
      await sweepOrphanedMacosWorktreeDirectories();
    } finally {
      restorePlatform();
    }

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockRm).toHaveBeenCalledWith(
      '/data/orphaned-worktree-cleanup.json',
      { force: true },
    );
  });

  it('sweeps a persisted staged worktree path after revalidating its identity', async () => {
    const restorePlatform = setPlatform('darwin');
    const cleanupPath =
      '/data/workspaces/canopy/worktrees/.eel.deleting-00000000-0000-4000-8000-000000000000';
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        entries: [
          {
            workspaceId: 'canopy',
            worktreeId: 'eel',
            worktreePath: '/data/workspaces/canopy/worktrees/eel',
            cleanupPath,
            queuedAt: '2026-07-22T00:00:00.000Z',
            device: 42,
            inode: 84,
            lastError: 'timed out',
          },
        ],
      }),
    );
    mockLstat
      .mockResolvedValueOnce(directoryStats())
      .mockRejectedValueOnce(enoent());

    try {
      await sweepOrphanedMacosWorktreeDirectories();
    } finally {
      restorePlatform();
    }

    expect(mockExecFile).toHaveBeenCalledWith(
      '/bin/rm',
      ['-rf', '--', cleanupPath],
      { timeout: 300_000 },
      expect.any(Function),
    );
    expect(mockRm).toHaveBeenCalledWith(
      '/data/orphaned-worktree-cleanup.json',
      { force: true },
    );
  });
});

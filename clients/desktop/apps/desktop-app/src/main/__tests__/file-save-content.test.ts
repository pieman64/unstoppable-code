jest.mock('../lib/workspace-activity', () => ({
  touchWorkspaceTarget: jest.fn().mockResolvedValue(undefined),
}));
import { touchWorkspaceTarget } from '../lib/workspace-activity';
import { withWorkspaceTargetAutoArchiveLease } from '../lib/workspace-target-exclusion';
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/validation', () => ({
  validateAbsolutePath: jest.fn(),
  validateId: jest.fn(),
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));

jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(),
  isCoworkWorkspace: (id: string): boolean =>
    id === 'standalone-chat' || id === 'cowork-default',
}));

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getWorktreeAttachmentsDir: jest.fn(),
  getWorkspaceWorktreeAttachmentsDir: jest.fn(),
  getWorkspaceWorktreeRepoDir: jest.fn(),
}));

jest.mock('electron', () => ({
  shell: { showItemInFolder: jest.fn() },
}));

jest.mock('node:fs/promises', () => ({
  stat: jest.fn(),
  readFile: jest.fn(),
  open: jest.fn(),
  realpath: jest.fn(),
  writeFile: jest.fn(),
}));

import { realpath, stat, writeFile } from 'node:fs/promises';
import {
  IPC_CHANNELS,
  type SaveFileContentRequest,
  type SaveFileContentResponse,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import {
  getWorktreeAttachmentsDir,
  getWorkspaceWorktreeAttachmentsDir,
  getWorkspaceWorktreeRepoDir,
} from '../lib/paths';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { validateAbsolutePath, validateId } from '../lib/validation';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { getWorkspaceType } from '../lib/workspace-registry';
import { registerFilePreviewHandlers } from '../ipc/file-preview';
import {
  createDirectTextSaveDispatcher,
  trustedSaveCaller,
} from './file-preview-fixtures';

const MAX_EDIT_TEXT_BYTES = 5 * 1024 * 1024;

const mockedGetWorkspaceType = jest.mocked(getWorkspaceType);
const mockedGetWorktreeAttachmentsDir = jest.mocked(getWorktreeAttachmentsDir);
const mockedGetWorkspaceWorktreeAttachmentsDir = jest.mocked(
  getWorkspaceWorktreeAttachmentsDir,
);
const mockedGetWorkspaceWorktreeRepoDir = jest.mocked(
  getWorkspaceWorktreeRepoDir,
);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedRealpath = jest.mocked(realpath);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedStat = jest.mocked(stat);
const mockedValidateAbsolutePath = jest.mocked(validateAbsolutePath);
const mockedValidateId = jest.mocked(validateId);
const mockedWriteFile = jest.mocked(writeFile);

type SaveHandlerFn = (
  _event: unknown,
  request: SaveFileContentRequest,
) => Promise<SaveFileContentResponse>;

function getSaveHandler(): SaveHandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.fileSaveContent,
  );
  if (!call) {
    throw new Error('No save handler registered');
  }
  return call[1] as SaveHandlerFn;
}

function createFsError(
  code: string,
  message: string,
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function setRealpathMap(entries: Record<string, string | Error>): void {
  mockedRealpath.mockImplementation((target): Promise<string> => {
    const key = String(target);
    const result = entries[key];
    if (result === undefined) {
      return Promise.reject(new Error(`Unexpected realpath call for ${key}`));
    }
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve(result);
  });
}

function setStatSequence(
  values: Array<{ size: number; mtimeMs: number }>,
): void {
  mockedStat.mockReset();
  for (const value of values) {
    mockedStat.mockResolvedValueOnce(value as never);
  }
}

function baseRequest(
  overrides: Partial<SaveFileContentRequest> = {},
): SaveFileContentRequest {
  return {
    projectId: 'proj-1',
    worktreeId: 'worktree-1',
    absolutePath: '/worktree-root/src/file.ts',
    content: 'export const value = 1;\n',
    expectedModifiedAtMs: 1000,
    ...overrides,
  };
}

let dispatcher = createDirectTextSaveDispatcher();

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetWorkspaceType.mockReturnValue(null);
  mockedResolveWorktreeCwd.mockReturnValue('/worktree-root');
  mockedGetWorktreeAttachmentsDir.mockReturnValue('/attachments-root');
  mockedGetWorkspaceWorktreeAttachmentsDir.mockReturnValue(
    '/workspace-attachments',
  );
  mockedGetWorkspaceWorktreeRepoDir.mockImplementation(
    (_projectId, worktreeId, repoId) =>
      `/workspace-root/${worktreeId}/repos/${repoId}`,
  );
  mockedReadWorkspaceConfig.mockResolvedValue({
    version: 1,
    type: 'multi-repo',
    repos: [],
  });
  mockedWriteFile.mockResolvedValue(undefined);
  dispatcher = createDirectTextSaveDispatcher();
  registerFilePreviewHandlers(dispatcher, trustedSaveCaller);
});

describe('fileSaveContent handler', () => {
  it('registers file:save-content', () => {
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.fileSaveContent,
      expect.any(Function),
    );
  });

  it('writes valid text content and returns the saved metadata', async () => {
    const request = baseRequest();
    setRealpathMap({
      '/worktree-root/src/file.ts': '/worktree-root/src/file.ts',
      '/worktree-root': '/worktree-root',
      '/attachments-root': createFsError('ENOENT', 'missing attachments'),
    });
    setStatSequence([
      { size: 22, mtimeMs: 1000 },
      { size: 22, mtimeMs: 1005 },
    ]);

    const result = await getSaveHandler()(undefined, request);

    // The projection compares the exact version of the stat the check read.
    expect(dispatcher.saves).toEqual([
      [
        {
          projectId: 'proj-1',
          worktreeId: 'worktree-1',
          realPath: '/worktree-root/src/file.ts',
          content: request.content,
          expectedVersion: '22:1000',
        },
        {
          caller: {
            ...trustedSaveCaller(),
            grants: ['worker.filesystem.write'],
          },
        },
      ],
    ]);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      '/worktree-root/src/file.ts',
      request.content,
      'utf8',
    );
    expect(touchWorkspaceTarget).toHaveBeenCalledWith(
      request.projectId,
      request.worktreeId,
    );
    expect(result).toEqual({
      filename: 'file.ts',
      sizeBytes: 22,
      modifiedAtMs: 1005,
    });
  });

  it('does not write into a target owned by Auto Delete', async () => {
    setRealpathMap({
      '/worktree-root/src/file.ts': '/worktree-root/src/file.ts',
      '/worktree-root': '/worktree-root',
      '/attachments-root': createFsError('ENOENT', 'missing attachments'),
    });
    setStatSequence([
      { size: 22, mtimeMs: 1000 },
      { size: 22, mtimeMs: 1005 },
    ]);
    await withWorkspaceTargetAutoArchiveLease(
      'proj-1',
      'worktree-1',
      async () => {
        await expect(
          getSaveHandler()(undefined, baseRequest()),
        ).rejects.toThrow('automatically deleted');
      },
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('rejects an invalid relative absolutePath before writing', async () => {
    mockedValidateAbsolutePath.mockImplementationOnce(() => {
      throw new Error('Invalid absolutePath: must be an absolute path');
    });

    await expect(
      getSaveHandler()(
        undefined,
        baseRequest({ absolutePath: 'relative.txt' }),
      ),
    ).rejects.toThrow('Invalid absolutePath: must be an absolute path');
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedRealpath).not.toHaveBeenCalled();
  });

  it('rejects an invalid projectId before writing', async () => {
    mockedValidateId.mockImplementationOnce(() => {
      throw new Error(
        'Invalid projectId: must be lowercase alphanumeric with hyphens',
      );
    });

    await expect(
      getSaveHandler()(undefined, baseRequest({ projectId: 'Bad_Project' })),
    ).rejects.toThrow(
      'Invalid projectId: must be lowercase alphanumeric with hyphens',
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedStat).not.toHaveBeenCalled();
  });

  it.each([['/worktree-root/image.png'], ['/worktree-root/archive.zip']])(
    'rejects non-editable extension %s',
    async (absolutePath) => {
      await expect(
        getSaveHandler()(undefined, baseRequest({ absolutePath })),
      ).rejects.toThrow('Only text-based files can be edited');
      expect(mockedWriteFile).not.toHaveBeenCalled();
    },
  );

  it('rejects content larger than 5 MB', async () => {
    await expect(
      getSaveHandler()(
        undefined,
        baseRequest({ content: 'x'.repeat(MAX_EDIT_TEXT_BYTES + 1) }),
      ),
    ).rejects.toThrow('File content exceeds the 5 MB save limit');
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('rejects content containing null bytes', async () => {
    await expect(
      getSaveHandler()(undefined, baseRequest({ content: 'abc\0def' })),
    ).rejects.toThrow('File content cannot contain null bytes');
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('rejects when the file mtime no longer matches the loaded value', async () => {
    setRealpathMap({
      '/worktree-root/src/file.ts': '/worktree-root/src/file.ts',
      '/worktree-root': '/worktree-root',
      '/attachments-root': createFsError('ENOENT', 'missing attachments'),
    });
    setStatSequence([{ size: 22, mtimeMs: 1003 }]);

    await expect(
      getSaveHandler()(undefined, baseRequest()),
    ).rejects.toMatchObject({
      name: 'FileSaveConflictError',
      message: 'File changed on disk since it was loaded.',
    });
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(touchWorkspaceTarget).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'ENOENT', 'EIO'])(
    'preserves an unrelated filesystem write error (%s)',
    async (code) => {
      setRealpathMap({
        '/worktree-root/src/file.ts': '/worktree-root/src/file.ts',
        '/worktree-root': '/worktree-root',
        '/attachments-root': createFsError('ENOENT', 'missing attachments'),
      });
      setStatSequence([{ size: 22, mtimeMs: 1000 }]);
      const error = createFsError(code, 'write failed');
      mockedWriteFile.mockRejectedValueOnce(error);

      await expect(getSaveHandler()(undefined, baseRequest())).rejects.toBe(
        error,
      );
      expect(error.name).toBe('Error');
      expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts a 1 ms mtime difference', async () => {
    const request = baseRequest({ expectedModifiedAtMs: 1000 });
    setRealpathMap({
      '/worktree-root/src/file.ts': '/worktree-root/src/file.ts',
      '/worktree-root': '/worktree-root',
      '/attachments-root': createFsError('ENOENT', 'missing attachments'),
    });
    setStatSequence([
      { size: 22, mtimeMs: 1001 },
      { size: 22, mtimeMs: 1002 },
    ]);

    await expect(getSaveHandler()(undefined, request)).resolves.toMatchObject({
      filename: 'file.ts',
      sizeBytes: 22,
      modifiedAtMs: 1002,
    });
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
  });

  it('writes to the resolved file path returned by validation', async () => {
    const request = baseRequest({ absolutePath: '/worktree-root/alias.ts' });
    setRealpathMap({
      '/worktree-root/alias.ts': '/worktree-root/src/file.ts',
      '/worktree-root': '/worktree-root',
      '/attachments-root': createFsError('ENOENT', 'missing attachments'),
    });
    setStatSequence([
      { size: 22, mtimeMs: 1000 },
      { size: 22, mtimeMs: 1007 },
    ]);

    const result = await getSaveHandler()(undefined, request);

    expect(mockedWriteFile).toHaveBeenCalledWith(
      '/worktree-root/src/file.ts',
      request.content,
      'utf8',
    );
    expect(result).toEqual({
      filename: 'alias.ts',
      sizeBytes: 22,
      modifiedAtMs: 1007,
    });
  });

  it('rejects symlink escapes outside the allowed roots', async () => {
    setRealpathMap({
      '/worktree-root/link/file.ts': '/outside-root/file.ts',
      '/worktree-root': '/worktree-root',
      '/attachments-root': '/attachments-root',
    });

    await expect(
      getSaveHandler()(
        undefined,
        baseRequest({ absolutePath: '/worktree-root/link/file.ts' }),
      ),
    ).rejects.toThrow('Cannot save file outside allowed worktree roots');
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('allows Cowork project saves within the scoped project root', async () => {
    const request = baseRequest({
      projectId: 'cowork-default',
      worktreeId: 'home',
      absolutePath: '/cowork-home/known-issues.md',
      content: '# Known issues\n\nResolved.\n',
    });
    mockedGetWorkspaceType.mockReturnValue('cowork');
    mockedResolveWorktreeCwd.mockReturnValue('/cowork-home');
    setRealpathMap({
      '/cowork-home/known-issues.md': '/cowork-home/known-issues.md',
      '/cowork-home': '/cowork-home',
      '/attachments-root': createFsError('ENOENT', 'missing attachments'),
    });
    setStatSequence([
      { size: 28, mtimeMs: 1000 },
      { size: 28, mtimeMs: 1008 },
    ]);

    const result = await getSaveHandler()(undefined, request);

    expect(mockedWriteFile).toHaveBeenCalledWith(
      '/cowork-home/known-issues.md',
      request.content,
      'utf8',
    );
    expect(result).toEqual({
      filename: 'known-issues.md',
      sizeBytes: 28,
      modifiedAtMs: 1008,
    });
  });

  it('allows single-repo saves when the attachments root is missing', async () => {
    const request = baseRequest();
    setRealpathMap({
      '/worktree-root/src/file.ts': '/worktree-root/src/file.ts',
      '/worktree-root': '/worktree-root',
      '/attachments-root': createFsError('ENOENT', 'attachments missing'),
    });
    setStatSequence([
      { size: 22, mtimeMs: 1000 },
      { size: 22, mtimeMs: 1004 },
    ]);

    const result = await getSaveHandler()(undefined, request);

    expect(result.modifiedAtMs).toBe(1004);
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
  });

  it('allows multi-repo repo saves while skipping missing source and attachment roots', async () => {
    const workspaceConfig: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: '/reference-source',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
    };
    mockedGetWorkspaceType.mockReturnValue('multi-repo');
    mockedResolveWorktreeCwd.mockReturnValue('/workspace-root/worktree-1');
    mockedGetWorkspaceWorktreeAttachmentsDir.mockReturnValue(
      '/workspace-attachments',
    );
    mockedReadWorkspaceConfig.mockResolvedValue(workspaceConfig);
    setRealpathMap({
      '/workspace-root/worktree-1/repos/repo-a/src/index.ts':
        '/workspace-root/worktree-1/repos/repo-a/src/index.ts',
      '/workspace-root/worktree-1': createFsError('ENOENT', 'root missing'),
      '/workspace-root/worktree-1/repos/repo-a':
        '/workspace-root/worktree-1/repos/repo-a',
      '/workspace-attachments': createFsError('ENOENT', 'attachments missing'),
    });
    setStatSequence([
      { size: 10, mtimeMs: 1000 },
      { size: 14, mtimeMs: 1008 },
    ]);

    const result = await getSaveHandler()(
      undefined,
      baseRequest({
        absolutePath: '/workspace-root/worktree-1/repos/repo-a/src/index.ts',
      }),
    );

    expect(result).toEqual({
      filename: 'index.ts',
      sizeBytes: 14,
      modifiedAtMs: 1008,
    });
  });

  it('allows multi-repo source-root saves', async () => {
    const workspaceConfig: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: '/reference-source',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
    };
    mockedGetWorkspaceType.mockReturnValue('multi-repo');
    mockedResolveWorktreeCwd.mockReturnValue('/workspace-root/worktree-1');
    mockedGetWorkspaceWorktreeAttachmentsDir.mockReturnValue(
      '/workspace-attachments',
    );
    mockedReadWorkspaceConfig.mockResolvedValue(workspaceConfig);
    setRealpathMap({
      '/workspace-root/worktree-1/README.md':
        '/workspace-root/worktree-1/README.md',
      '/workspace-root/worktree-1': '/workspace-root/worktree-1',
      '/workspace-root/worktree-1/repos/repo-a':
        '/workspace-root/worktree-1/repos/repo-a',
      '/workspace-attachments': createFsError('ENOENT', 'attachments missing'),
    });
    setStatSequence([
      { size: 12, mtimeMs: 1000 },
      { size: 16, mtimeMs: 1010 },
    ]);

    const result = await getSaveHandler()(
      undefined,
      baseRequest({ absolutePath: '/workspace-root/worktree-1/README.md' }),
    );

    expect(result.filename).toBe('README.md');
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
  });

  it('allows multi-repo worktree-root saves without sourceRepoPath', async () => {
    const workspaceConfig: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
    };
    mockedGetWorkspaceType.mockReturnValue('multi-repo');
    mockedResolveWorktreeCwd.mockReturnValue('/workspace-root/worktree-1');
    mockedGetWorkspaceWorktreeAttachmentsDir.mockReturnValue(
      '/workspace-attachments',
    );
    mockedReadWorkspaceConfig.mockResolvedValue(workspaceConfig);
    setRealpathMap({
      '/workspace-root/worktree-1/CLAUDE.md':
        '/workspace-root/worktree-1/CLAUDE.md',
      '/workspace-root/worktree-1': '/workspace-root/worktree-1',
      '/workspace-root/worktree-1/repos/repo-a':
        '/workspace-root/worktree-1/repos/repo-a',
      '/workspace-attachments': createFsError('ENOENT', 'attachments missing'),
    });
    setStatSequence([
      { size: 12, mtimeMs: 1000 },
      { size: 18, mtimeMs: 1011 },
    ]);

    const result = await getSaveHandler()(
      undefined,
      baseRequest({ absolutePath: '/workspace-root/worktree-1/CLAUDE.md' }),
    );

    expect(result).toEqual({
      filename: 'CLAUDE.md',
      sizeBytes: 18,
      modifiedAtMs: 1011,
    });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      '/workspace-root/worktree-1/CLAUDE.md',
      expect.any(String),
      'utf8',
    );
  });

  it('skips non-ENOENT root realpath errors when another root contains the file', async () => {
    const workspaceConfig: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: '/reference-source',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' }],
    };
    mockedGetWorkspaceType.mockReturnValue('multi-repo');
    mockedResolveWorktreeCwd.mockReturnValue('/workspace-root/worktree-1');
    mockedGetWorkspaceWorktreeAttachmentsDir.mockReturnValue(
      '/workspace-attachments',
    );
    mockedReadWorkspaceConfig.mockResolvedValue(workspaceConfig);
    setRealpathMap({
      '/workspace-root/worktree-1/repos/repo-a/src/index.ts':
        '/workspace-root/worktree-1/repos/repo-a/src/index.ts',
      '/workspace-root/worktree-1': createFsError(
        'EACCES',
        'permission denied',
      ),
      '/workspace-root/worktree-1/repos/repo-a':
        '/workspace-root/worktree-1/repos/repo-a',
      '/workspace-attachments': createFsError('ENOENT', 'attachments missing'),
    });
    setStatSequence([
      { size: 10, mtimeMs: 1000 },
      { size: 10, mtimeMs: 1006 },
    ]);

    await expect(
      getSaveHandler()(
        undefined,
        baseRequest({
          absolutePath: '/workspace-root/worktree-1/repos/repo-a/src/index.ts',
        }),
      ),
    ).resolves.toMatchObject({
      filename: 'index.ts',
      modifiedAtMs: 1006,
    });
  });

  it('rejects when no candidate root resolves to a containing path', async () => {
    setRealpathMap({
      '/worktree-root/src/file.ts': '/worktree-root/src/file.ts',
      '/worktree-root': createFsError('EACCES', 'permission denied'),
      '/attachments-root': createFsError('ENOENT', 'attachments missing'),
    });

    await expect(getSaveHandler()(undefined, baseRequest())).rejects.toThrow(
      'Cannot save file outside allowed worktree roots',
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('rejects clearly when the target file no longer exists', async () => {
    setRealpathMap({
      '/worktree-root/src/file.ts': createFsError('ENOENT', 'missing file'),
    });

    await expect(getSaveHandler()(undefined, baseRequest())).rejects.toThrow(
      'Cannot save non-existent file: /worktree-root/src/file.ts',
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });
});

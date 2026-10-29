import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  type ArchivedContainerManifestV1,
  type ArchivedContainerListChangesRequest,
  type ArchivedContainerListChangesResponse,
  type ArchivedContainerReadChangeDiffRequest,
  type ArchivedContainerReadChangeDiffResponse,
} from '@canopy/desktop-shared/types';

type Handler = (_event: unknown, request: unknown) => unknown;
const handlers = new Map<string, Handler>();

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

jest.mock('@canopy/desktop-shared/node/pipelines/executor', () => ({
  getStepLogFilePath: jest.fn(),
  listExecutionSummariesWithStates: jest.fn(),
  loadExecutionState: jest.fn(),
}));
jest.mock('../lib/archived-containers', () => ({
  listArchivedContainers: jest.fn(),
  purgeArchivedContainer: jest.fn(),
  readArchivedContainerChatArchives: jest.fn(),
  readArchivedContainerChats: jest.fn(),
  readArchivedContainerManifest: jest.fn(),
  readArchivedContainerManifestIncludingExpired: jest.fn(),
  readArchivedContainerTrackedPlans: jest.fn(),
  setArchivedContainerLocked: jest.fn(),
  withArchivedWorkspaceOperationLock: jest.fn(
    (_projectId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));
jest.mock('../ledger/lifecycle', () => ({
  LEDGER_INTENT_REFUSING_WAIT_MS: 5_000,
  ledgerDatabaseMayExist: jest.fn(() => Promise.resolve(true)),
  notifyLedgerContainerPurged: jest.fn(),
  notifyLedgerContainerRestored: jest.fn(),
  recordLedgerRestoreIntent: jest.fn(() => Promise.resolve('recorded')),
}));
jest.mock('../lib/archived-container-restore', () => ({
  restoreArchivedContainer: jest.fn(),
}));
jest.mock('../lib/agent-attachments', () => ({
  listAttachmentsInDir: jest.fn(),
}));
jest.mock('../lib/chat-archives', () => ({
  toArchivedChatSummary: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getArchivedContainerAttachmentsDir: jest.fn(),
  getArchivedContainerExecutionsDir: jest.fn(),
}));
jest.mock('../lib/path-safety', () => ({
  isPathInside: jest.fn(),
}));
jest.mock('../lib/type-guards', () => ({
  isErrnoException: jest.fn(),
}));
jest.mock('../lib/worktree-service', () => ({
  retryDeferredTemporaryWorkspaceDeletion: jest.fn(),
}));
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(),
}));
jest.mock('../lib/github-pr', () => ({
  fetchPrStatusForRepo: jest.fn(),
}));
jest.mock('../lib/archived-container-git', () => ({
  assertArchivedGitStateMatchesWorkspace: jest.fn(() => Promise.resolve()),
  getArchivedContainerChangesService: jest.fn(),
}));

import {
  registerArchivedContainerHandlers,
  type ArchivedContainerChangesService,
} from '../ipc/archived-containers';
import {
  purgeArchivedContainer,
  readArchivedContainerManifest,
  readArchivedContainerManifestIncludingExpired,
  withArchivedWorkspaceOperationLock,
} from '../lib/archived-containers';
import { fetchPrStatusForRepo } from '../lib/github-pr';
import { isErrnoException } from '../lib/type-guards';
import { retryDeferredTemporaryWorkspaceDeletion } from '../lib/worktree-service';
import {
  ledgerDatabaseMayExist,
  notifyLedgerContainerPurged,
  notifyLedgerContainerRestored,
  recordLedgerRestoreIntent,
} from '../ledger/lifecycle';
import { assertArchivedGitStateMatchesWorkspace } from '../lib/archived-container-git';

const readArchivedContainerManifestMock = jest.mocked(
  readArchivedContainerManifest,
);
const readIdentityMock = jest.mocked(
  readArchivedContainerManifestIncludingExpired,
);
const fetchPrStatusForRepoMock = jest.mocked(fetchPrStatusForRepo);
const assertArchivedGitStateMatchesWorkspaceMock = jest.mocked(
  assertArchivedGitStateMatchesWorkspace,
);

const listChangesMock = jest.fn<
  Promise<ArchivedContainerListChangesResponse>,
  [ArchivedContainerListChangesRequest]
>();
const readChangeDiffMock = jest.fn<
  Promise<ArchivedContainerReadChangeDiffResponse>,
  [ArchivedContainerReadChangeDiffRequest]
>();
const changesService: ArchivedContainerChangesService = {
  listChanges: listChangesMock,
  readChangeDiff: readChangeDiffMock,
};

function handlerFor(channel: string): Handler {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`Missing handler for ${channel}`);
  }
  return handler;
}

describe('archived container IPC handlers', () => {
  beforeEach(() => {
    handlers.clear();
    jest.clearAllMocks();
    registerArchivedContainerHandlers(changesService);
  });

  it('registers the changed-file paging and diff channels', () => {
    expect(handlers.has(IPC_CHANNELS.archivedContainersListChanges)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.archivedContainersReadChangeDiff)).toBe(
      true,
    );
  });

  it('passes the conditional delete precondition through and reports a skip', async () => {
    jest.mocked(purgeArchivedContainer).mockResolvedValueOnce(false);
    const handler = handlerFor(IPC_CHANNELS.archivedContainersDelete);

    await expect(
      handler(undefined, {
        projectId: 'workspace-1',
        containerId: 'archive-1',
        onlyIfDeleted: true,
      }),
    ).resolves.toEqual({ deleted: false });
    expect(purgeArchivedContainer).toHaveBeenCalledWith(
      'workspace-1',
      'archive-1',
      { onlyIfDeleted: true },
    );
  });

  describe('Ledger lifecycle participant for permanent deletion', () => {
    const createdAt = '2026-09-01T08:00:00.000Z';

    beforeEach(() => {
      jest
        .mocked(retryDeferredTemporaryWorkspaceDeletion)
        .mockResolvedValue(null);
    });

    function archivedManifest(
      overrides: Partial<ArchivedContainerManifestV1> = {},
    ): ArchivedContainerManifestV1 {
      return {
        version: 1,
        kind: 'worktree',
        id: 'archive-1',
        projectId: 'workspace-1',
        name: 'Archived work',
        createdAt,
        archivedAt: '2026-09-20T08:00:00.000Z',
        retentionDays: 30,
        expiresAt: '2026-10-20T08:00:00.000Z',
        chatCount: 0,
        archivedChatCount: 0,
        executionCount: 0,
        ...overrides,
      };
    }

    function deleteArchive(projectId = 'workspace-1'): Promise<unknown> {
      return Promise.resolve(
        handlerFor(IPC_CHANNELS.archivedContainersDelete)(undefined, {
          projectId,
          containerId: 'archive-1',
        }),
      );
    }

    it.each([
      [
        'worktree',
        archivedManifest(),
        {
          kind: 'code_worktree',
          workspaceId: 'workspace-1',
          worktreeId: 'archive-1',
        },
      ],
      [
        'Cowork Work Entry',
        archivedManifest({ kind: 'work-entry' }),
        {
          kind: 'cowork_entry',
          workspaceId: 'workspace-1',
          entryId: 'archive-1',
        },
      ],
      [
        'App Advisor Work Entry',
        archivedManifest({
          kind: 'work-entry',
          projectId: APP_ADVISOR_PROJECT_ID,
        }),
        {
          kind: 'advisor_entry',
          appWorkspaceId: APP_ADVISOR_PROJECT_ID,
          entryId: 'archive-1',
        },
      ],
    ] as const)(
      'retires the original %s scope once after the purge commits',
      async (_kind, manifest, container) => {
        readIdentityMock.mockResolvedValueOnce(manifest);
        jest.mocked(purgeArchivedContainer).mockResolvedValueOnce(true);

        await expect(deleteArchive(manifest.projectId)).resolves.toEqual({
          deleted: true,
        });

        expect(notifyLedgerContainerPurged).toHaveBeenCalledTimes(1);
        expect(notifyLedgerContainerPurged).toHaveBeenCalledWith({
          container,
          containerCreatedAt: createdAt,
        });
        expect(
          jest.mocked(purgeArchivedContainer).mock.invocationCallOrder[0],
        ).toBeLessThan(
          jest.mocked(notifyLedgerContainerPurged).mock
            .invocationCallOrder[0] ?? 0,
        );
      },
    );

    it('reads the archive identity under the lock the purge runs in', async () => {
      let lockHeld = false;
      const observed: string[] = [];
      jest
        .mocked(withArchivedWorkspaceOperationLock)
        .mockImplementationOnce(
          async <T>(
            _projectId: string,
            operation: () => Promise<T>,
          ): Promise<T> => {
            lockHeld = true;
            try {
              return await operation();
            } finally {
              lockHeld = false;
            }
          },
        );
      readIdentityMock.mockImplementationOnce(() => {
        observed.push(`read:${String(lockHeld)}`);
        return Promise.resolve(archivedManifest());
      });
      jest.mocked(purgeArchivedContainer).mockImplementationOnce(() => {
        observed.push(`purge:${String(lockHeld)}`);
        return Promise.resolve(true);
      });
      jest.mocked(notifyLedgerContainerPurged).mockImplementationOnce(() => {
        observed.push(`notify:${String(lockHeld)}`);
      });

      await expect(deleteArchive()).resolves.toEqual({ deleted: true });

      expect(withArchivedWorkspaceOperationLock).toHaveBeenCalledWith(
        'workspace-1',
        expect.any(Function),
      );
      // The participant runs after the lock is released.
      expect(observed).toEqual(['read:true', 'purge:true', 'notify:false']);
    });

    it('makes the mapping of a partially restored archive durable before deleting it, then queues the reattach', async () => {
      readIdentityMock.mockResolvedValueOnce(
        archivedManifest({
          restoredTo: {
            kind: 'worktree',
            id: 'restored-1',
            restoredAt: '2026-09-21T08:00:00.000Z',
            createdAt: '2026-09-21T08:00:00.000Z',
          },
        }),
      );
      jest.mocked(purgeArchivedContainer).mockResolvedValueOnce(true);

      await expect(deleteArchive()).resolves.toEqual({ deleted: true });

      const mapping = [
        {
          container: {
            kind: 'code_worktree',
            workspaceId: 'workspace-1',
            worktreeId: 'archive-1',
          },
          containerCreatedAt: createdAt,
        },
        {
          container: {
            kind: 'code_worktree',
            workspaceId: 'workspace-1',
            worktreeId: 'restored-1',
          },
          containerCreatedAt: '2026-09-21T08:00:00.000Z',
        },
      ];
      expect(notifyLedgerContainerPurged).not.toHaveBeenCalled();
      // Waited on as long as a host that refuses without it waits.
      expect(recordLedgerRestoreIntent).toHaveBeenCalledWith(...mapping, {
        waitMs: 5_000,
      });
      expect(notifyLedgerContainerRestored).toHaveBeenCalledWith(...mapping);
      expect(
        jest.mocked(recordLedgerRestoreIntent).mock.invocationCallOrder[0],
      ).toBeLessThan(
        jest.mocked(purgeArchivedContainer).mock.invocationCallOrder[0] ?? 0,
      );
    });

    it.each([
      ['cannot be saved', 'not_durable'],
      ['write throws', 'throws'],
    ] as const)(
      'keeps a partially restored archive when its mapping %s',
      async (_case, failure) => {
        readIdentityMock.mockResolvedValueOnce(
          archivedManifest({
            restoredTo: {
              kind: 'worktree',
              id: 'restored-1',
              restoredAt: '2026-09-21T08:00:00.000Z',
              createdAt: '2026-09-21T08:00:00.000Z',
            },
          }),
        );
        if (failure === 'not_durable') {
          jest
            .mocked(recordLedgerRestoreIntent)
            .mockResolvedValueOnce('not_durable');
        } else {
          jest
            .mocked(recordLedgerRestoreIntent)
            .mockRejectedValueOnce(new Error('Ledger journal defect'));
        }

        // The archive may hold the only lasting record of where its scope
        // belongs, so it stays until the deletion is retried.
        await expect(deleteArchive()).rejects.toThrow(
          "Couldn't delete this item. Try again.",
        );

        expect(purgeArchivedContainer).not.toHaveBeenCalled();
        expect(notifyLedgerContainerRestored).not.toHaveBeenCalled();
        expect(notifyLedgerContainerPurged).not.toHaveBeenCalled();
        expect(retryDeferredTemporaryWorkspaceDeletion).not.toHaveBeenCalled();
      },
    );

    it('deletes a partially restored archive when no Ledger exists', async () => {
      readIdentityMock.mockResolvedValueOnce(
        archivedManifest({
          restoredTo: {
            kind: 'worktree',
            id: 'restored-1',
            restoredAt: '2026-09-21T08:00:00.000Z',
            createdAt: '2026-09-21T08:00:00.000Z',
          },
        }),
      );
      jest
        .mocked(recordLedgerRestoreIntent)
        .mockResolvedValueOnce('not_needed');
      jest.mocked(purgeArchivedContainer).mockResolvedValueOnce(true);

      await expect(deleteArchive()).resolves.toEqual({ deleted: true });

      expect(purgeArchivedContainer).toHaveBeenCalledTimes(1);
    });

    it.each([['EMFILE'], ['EIO'], ['EACCES']])(
      'keeps the archive when its manifest read fails with %s, which may pass',
      async (code) => {
        readIdentityMock.mockRejectedValueOnce(
          Object.assign(new Error('manifest read failed'), { code }),
        );
        jest.mocked(isErrnoException).mockReturnValueOnce(true);

        await expect(deleteArchive()).rejects.toThrow(
          "Couldn't delete this item. Try again.",
        );

        expect(purgeArchivedContainer).not.toHaveBeenCalled();
        expect(notifyLedgerContainerPurged).not.toHaveBeenCalled();
      },
    );

    it('deletes the archive when its manifest read fails and no Ledger exists', async () => {
      readIdentityMock.mockRejectedValueOnce(
        Object.assign(new Error('manifest read failed'), { code: 'EMFILE' }),
      );
      jest.mocked(isErrnoException).mockReturnValueOnce(true);
      jest.mocked(ledgerDatabaseMayExist).mockResolvedValueOnce(false);
      jest.mocked(purgeArchivedContainer).mockResolvedValueOnce(true);

      await expect(deleteArchive()).resolves.toEqual({ deleted: true });

      expect(purgeArchivedContainer).toHaveBeenCalledTimes(1);
    });

    it('deletes an archive whose manifest is missing', async () => {
      readIdentityMock.mockRejectedValueOnce(
        Object.assign(new Error('manifest missing'), { code: 'ENOENT' }),
      );
      jest.mocked(isErrnoException).mockReturnValueOnce(true);
      jest.mocked(purgeArchivedContainer).mockResolvedValueOnce(true);

      await expect(deleteArchive()).resolves.toEqual({ deleted: true });

      expect(purgeArchivedContainer).toHaveBeenCalledTimes(1);
      expect(notifyLedgerContainerPurged).not.toHaveBeenCalled();
      expect(ledgerDatabaseMayExist).not.toHaveBeenCalled();
    });

    it('reads the identity of an archive whose retention has lapsed', async () => {
      readIdentityMock.mockResolvedValueOnce(archivedManifest());
      jest.mocked(purgeArchivedContainer).mockResolvedValueOnce(true);

      await expect(deleteArchive()).resolves.toEqual({ deleted: true });

      expect(readIdentityMock).toHaveBeenCalledWith('workspace-1', 'archive-1');
      expect(readArchivedContainerManifestMock).not.toHaveBeenCalled();
      expect(notifyLedgerContainerPurged).toHaveBeenCalledTimes(1);
    });

    it('does not tell the Ledger when nothing was deleted or the purge failed', async () => {
      readIdentityMock.mockResolvedValueOnce(archivedManifest());
      jest.mocked(purgeArchivedContainer).mockResolvedValueOnce(false);
      await expect(deleteArchive()).resolves.toEqual({ deleted: false });

      readIdentityMock.mockResolvedValueOnce(archivedManifest());
      jest
        .mocked(purgeArchivedContainer)
        .mockRejectedValueOnce(new Error('archive purge failed'));
      await expect(deleteArchive()).rejects.toThrow('archive purge failed');

      expect(notifyLedgerContainerPurged).not.toHaveBeenCalled();
    });

    it('still deletes when the identity cannot be read, leaving the scope to startup reconciliation', async () => {
      readIdentityMock.mockRejectedValueOnce(
        new Error('Archived container archive-1 was not found'),
      );
      jest.mocked(purgeArchivedContainer).mockResolvedValueOnce(true);

      await expect(deleteArchive()).resolves.toEqual({ deleted: true });

      expect(notifyLedgerContainerPurged).not.toHaveBeenCalled();
      expect(retryDeferredTemporaryWorkspaceDeletion).toHaveBeenCalledWith(
        'workspace-1',
      );
    });

    it('completes the deletion when the Ledger participant throws', async () => {
      readIdentityMock.mockResolvedValueOnce(archivedManifest());
      jest.mocked(purgeArchivedContainer).mockResolvedValueOnce(true);
      jest.mocked(notifyLedgerContainerPurged).mockImplementationOnce(() => {
        throw new Error('Ledger participant defect');
      });

      await expect(deleteArchive()).resolves.toEqual({ deleted: true });

      expect(notifyLedgerContainerPurged).toHaveBeenCalledTimes(1);
      expect(retryDeferredTemporaryWorkspaceDeletion).toHaveBeenCalledWith(
        'workspace-1',
      );
    });
  });

  it('rejects a malformed conditional delete precondition', async () => {
    const handler = handlerFor(IPC_CHANNELS.archivedContainersDelete);

    await expect(
      handler(undefined, {
        projectId: 'workspace-1',
        containerId: 'archive-1',
        onlyIfDeleted: 'yes',
      }),
    ).rejects.toThrow('onlyIfDeleted must be a boolean');
    expect(purgeArchivedContainer).not.toHaveBeenCalled();
  });

  it.each([
    { projectId: '../workspace', containerId: 'archive-1' },
    { projectId: 'workspace-1', containerId: '../archive' },
  ])('rejects malformed list identity before delegation', async (request) => {
    const handler = handlerFor(IPC_CHANNELS.archivedContainersListChanges);

    await expect(handler(undefined, request)).rejects.toThrow('Invalid');
    expect(listChangesMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 501, '250'])(
    'rejects invalid changed-file page limit %p before delegation',
    async (limit) => {
      const handler = handlerFor(IPC_CHANNELS.archivedContainersListChanges);

      await expect(
        handler(undefined, {
          projectId: 'workspace-1',
          containerId: 'archive-1',
          limit,
        }),
      ).rejects.toThrow('Archived changes limit');
      expect(listChangesMock).not.toHaveBeenCalled();
    },
  );

  it.each(['', '   ', 42])(
    'rejects invalid changed-file cursor %p before delegation',
    async (cursor) => {
      const handler = handlerFor(IPC_CHANNELS.archivedContainersListChanges);

      await expect(
        handler(undefined, {
          projectId: 'workspace-1',
          containerId: 'archive-1',
          cursor,
        }),
      ).rejects.toThrow('Invalid archived changes cursor');
      expect(listChangesMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      repoId: undefined,
      filePath: 'src/index.ts',
      error: 'repoId is required',
    },
    { repoId: '', filePath: 'src/index.ts', error: 'repoId is required' },
    { repoId: 'repo-1', filePath: undefined, error: 'filePath is required' },
    { repoId: 'repo-1', filePath: '', error: 'filePath is required' },
    { repoId: 'repo-1', filePath: '../secret', error: 'Invalid filePath' },
    { repoId: 'repo-1', filePath: '/tmp/secret', error: 'Invalid filePath' },
    {
      repoId: 'repo-1',
      filePath: 'C:\\private\\secret',
      error: 'Invalid filePath',
    },
  ])(
    'rejects an unsafe diff selector before delegation',
    async ({ repoId, filePath, error }) => {
      const handler = handlerFor(IPC_CHANNELS.archivedContainersReadChangeDiff);

      await expect(
        handler(undefined, {
          projectId: 'workspace-1',
          containerId: 'archive-1',
          repoId,
          filePath,
        }),
      ).rejects.toThrow(error);
      expect(readChangeDiffMock).not.toHaveBeenCalled();
    },
  );

  it('delegates paging with the exact request and strips backend-only fields', async () => {
    const request = {
      projectId: 'workspace-1',
      containerId: 'archive-1',
      cursor: 'opaque-fingerprint:250',
      limit: 25,
      referenceRepoPath: '/renderer/injected/repo',
      snapshotRef: 'refs/renderer/injected',
    };
    const backendResponse = {
      files: [
        {
          path: 'src/new-name.ts',
          previousPath: 'src/old-name.ts',
          status: 'renamed' as const,
          insertions: 8,
          deletions: 2,
          repoId: 'repo-1',
          repoName: 'client',
          referenceRepoPath: '/private/repos/client',
          snapshotRef: 'refs/canopy/private',
        },
      ],
      totalCount: 1,
      nextCursor: null,
      truncated: false,
      gitState: { headCommit: 'private-object-id' },
    };
    listChangesMock.mockResolvedValue(backendResponse);

    const response = await handlerFor(
      IPC_CHANNELS.archivedContainersListChanges,
    )(undefined, request);

    expect(listChangesMock).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      containerId: 'archive-1',
      cursor: 'opaque-fingerprint:250',
      limit: 25,
    });
    expect(response).toEqual({
      files: [
        {
          path: 'src/new-name.ts',
          previousPath: 'src/old-name.ts',
          status: 'renamed',
          insertions: 8,
          deletions: 2,
          repoId: 'repo-1',
          repoName: 'client',
        },
      ],
      totalCount: 1,
      nextCursor: null,
      truncated: false,
    });
  });

  it('delegates diff reads and returns only the combined public response', async () => {
    const request = {
      projectId: 'workspace-1',
      containerId: 'archive-1',
      repoId: 'repo-1',
      filePath: 'src/index.ts',
      previousPath: '../../renderer-selected',
      headCommit: 'renderer-selected-object-id',
    };
    const backendResponse = {
      oldValue: 'before',
      newValue: 'after',
      filePath: 'src/index.ts',
      source: 'combined' as const,
      truncated: false,
      binary: false,
      referenceRepoPath: '/private/repos/client',
      headCommit: 'private-object-id',
    };
    readChangeDiffMock.mockResolvedValue(backendResponse);

    const response = await handlerFor(
      IPC_CHANNELS.archivedContainersReadChangeDiff,
    )(undefined, request);

    expect(readChangeDiffMock).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      containerId: 'archive-1',
      repoId: 'repo-1',
      filePath: 'src/index.ts',
    });
    expect(response).toEqual({
      oldValue: 'before',
      newValue: 'after',
      filePath: 'src/index.ts',
      source: 'combined',
      truncated: false,
      binary: false,
    });
  });

  it.each([
    'Version 1 archives do not contain Git changes',
    'Archived work entries do not contain Git changes',
    'Partially restored archives cannot be explored',
    'Invalid or stale archived changes cursor.',
  ])('preserves service rejection: %s', async (message) => {
    listChangesMock.mockRejectedValueOnce(new Error(message));

    await expect(
      handlerFor(IPC_CHANNELS.archivedContainersListChanges)(undefined, {
        projectId: 'workspace-1',
        containerId: 'archive-1',
      }),
    ).rejects.toThrow(message);
  });

  it.each([
    'Unknown archived repository.',
    'Invalid archived file path.',
    'The requested file is not part of this archived change set.',
    'Archived Git state for repository client is unavailable; the archive was preserved.',
  ])('preserves diff-service rejection: %s', async (message) => {
    readChangeDiffMock.mockRejectedValueOnce(new Error(message));

    await expect(
      handlerFor(IPC_CHANNELS.archivedContainersReadChangeDiff)(undefined, {
        projectId: 'workspace-1',
        containerId: 'archive-1',
        repoId: 'repo-1',
        filePath: 'src/image.png',
      }),
    ).rejects.toThrow(message);
  });

  it('forwards an archived image response without backend identities', async () => {
    readChangeDiffMock.mockResolvedValueOnce({
      oldValue: '',
      newValue: '',
      filePath: 'src/image.png',
      source: 'combined',
      truncated: false,
      binary: true,
      imagePreview: {
        oldDataUrl: 'data:image/png;base64,b2xk',
        newDataUrl: 'data:image/png;base64,bmV3',
      },
    });

    await expect(
      handlerFor(IPC_CHANNELS.archivedContainersReadChangeDiff)(undefined, {
        projectId: 'workspace-1',
        containerId: 'archive-1',
        repoId: 'repo-1',
        filePath: 'src/image.png',
      }),
    ).resolves.toEqual({
      oldValue: '',
      newValue: '',
      filePath: 'src/image.png',
      source: 'combined',
      truncated: false,
      binary: true,
      imagePreview: {
        oldDataUrl: 'data:image/png;base64,b2xk',
        newDataUrl: 'data:image/png;base64,bmV3',
      },
    });
  });

  it('forwards a non-image binary response distinctly from image previews', async () => {
    readChangeDiffMock.mockResolvedValueOnce({
      oldValue: '',
      newValue: '',
      filePath: 'dist/archive.bin',
      source: 'combined',
      truncated: false,
      binary: true,
    });

    await expect(
      handlerFor(IPC_CHANNELS.archivedContainersReadChangeDiff)(undefined, {
        projectId: 'workspace-1',
        containerId: 'archive-1',
        repoId: 'repo-1',
        filePath: 'dist/archive.bin',
      }),
    ).resolves.toEqual({
      oldValue: '',
      newValue: '',
      filePath: 'dist/archive.bin',
      source: 'combined',
      truncated: false,
      binary: true,
    });
  });

  describe('refresh pull requests', () => {
    const manifest = {
      version: 2,
      kind: 'worktree',
      id: 'archive-1',
      projectId: 'workspace-1',
      workspaceType: 'multi-repo',
      gitState: {
        repositories: [
          {
            repoId: 'repo-a',
            repoName: 'repo-a',
            referenceRepoPath: '/repos/repo-a',
            branchName: 'feature/x',
          },
          {
            repoId: 'repo-b',
            repoName: 'repo-b',
            referenceRepoPath: '/repos/repo-b',
            // No branch was recorded — nothing to look up.
          },
        ],
      },
    };

    it('returns one live status per repository and never leaks backend paths', async () => {
      readArchivedContainerManifestMock.mockResolvedValue(manifest);
      fetchPrStatusForRepoMock.mockResolvedValue({
        prNumber: 42,
        prUrl: 'https://github.com/acme/repo-a/pull/42',
        state: 'merged',
        title: 'Archived work',
        checkStatus: 'passing',
        checkDetails: [],
        reviewStatus: 'approved',
        reviewers: [],
        hasConflicts: false,
        commentCount: 0,
        updatedAt: '2026-07-25T00:00:00.000Z',
      });

      const response = await handlerFor(
        IPC_CHANNELS.archivedContainersRefreshPullRequests,
      )(undefined, { projectId: 'workspace-1', containerId: 'archive-1' });

      expect(fetchPrStatusForRepoMock).toHaveBeenCalledTimes(1);
      expect(assertArchivedGitStateMatchesWorkspaceMock).toHaveBeenCalledWith({
        workspaceId: 'workspace-1',
        containerId: 'archive-1',
        workspaceType: 'multi-repo',
        gitState: manifest.gitState,
      });
      expect(fetchPrStatusForRepoMock).toHaveBeenCalledWith(
        '/repos/repo-a',
        'feature/x',
      );
      expect(response).toMatchObject({
        repos: [
          {
            repoId: 'repo-a',
            repoName: 'repo-a',
            status: { prNumber: 42, state: 'merged' },
          },
          { repoId: 'repo-b', repoName: 'repo-b', status: null },
        ],
      });
      expect(JSON.stringify(response)).not.toContain('/repos/');
    });

    it('reports a failed lookup as no pull request instead of failing the call', async () => {
      readArchivedContainerManifestMock.mockResolvedValue(manifest);
      fetchPrStatusForRepoMock.mockRejectedValue(new Error('offline'));

      await expect(
        handlerFor(IPC_CHANNELS.archivedContainersRefreshPullRequests)(
          undefined,
          { projectId: 'workspace-1', containerId: 'archive-1' },
        ),
      ).resolves.toMatchObject({
        repos: [
          { repoId: 'repo-a', status: null },
          { repoId: 'repo-b', status: null },
        ],
      });
    });

    it('rejects stale repository identity before touching GitHub', async () => {
      readArchivedContainerManifestMock.mockResolvedValue(manifest);
      assertArchivedGitStateMatchesWorkspaceMock.mockRejectedValueOnce(
        new Error('Archived repository repo-a failed integrity validation.'),
      );

      await expect(
        handlerFor(IPC_CHANNELS.archivedContainersRefreshPullRequests)(
          undefined,
          { projectId: 'workspace-1', containerId: 'archive-1' },
        ),
      ).rejects.toThrow('failed integrity validation');
      expect(fetchPrStatusForRepoMock).not.toHaveBeenCalled();
    });

    it('returns an empty result for legacy archives without recorded Git state', async () => {
      readArchivedContainerManifestMock.mockResolvedValue({
        version: 1,
        kind: 'worktree',
        id: 'archive-1',
        projectId: 'workspace-1',
      });

      await expect(
        handlerFor(IPC_CHANNELS.archivedContainersRefreshPullRequests)(
          undefined,
          { projectId: 'workspace-1', containerId: 'archive-1' },
        ),
      ).resolves.toMatchObject({ repos: [] });
      expect(fetchPrStatusForRepoMock).not.toHaveBeenCalled();
    });

    it('collapses concurrent refreshes for the same archive onto one lookup', async () => {
      readArchivedContainerManifestMock.mockResolvedValue(manifest);
      fetchPrStatusForRepoMock.mockResolvedValue(null);
      const handler = handlerFor(
        IPC_CHANNELS.archivedContainersRefreshPullRequests,
      );
      const request = { projectId: 'workspace-1', containerId: 'archive-1' };

      const [first, second] = await Promise.all([
        handler(undefined, request),
        handler(undefined, request),
      ]);

      expect(first).toBe(second);
      expect(readArchivedContainerManifestMock).toHaveBeenCalledTimes(1);
    });

    it('rejects an invalid archive identity before touching GitHub', async () => {
      await expect(
        handlerFor(IPC_CHANNELS.archivedContainersRefreshPullRequests)(
          undefined,
          { projectId: '../escape', containerId: 'archive-1' },
        ),
      ).rejects.toThrow();
      expect(fetchPrStatusForRepoMock).not.toHaveBeenCalled();
    });
  });

  it('rejects an invalid optional matrix child id before reading a step log', async () => {
    const handler = handlerFor(
      IPC_CHANNELS.archivedContainersReadExecutionStepLog,
    );

    await expect(
      handler(undefined, {
        projectId: 'workspace-1',
        containerId: 'archive-1',
        executionId: 'execution-1',
        jobId: 'job-1',
        stepId: 'step-1',
        matrix_child_id: '../child-1',
      }),
    ).rejects.toThrow(
      'Invalid matrix_child_id: must be lowercase alphanumeric with hyphens',
    );
  });
});

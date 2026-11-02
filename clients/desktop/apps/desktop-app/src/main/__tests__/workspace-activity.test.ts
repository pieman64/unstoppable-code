import type * as ArchivedContainersModule from '../lib/archived-containers';
import { AsyncResource } from 'node:async_hooks';

const touchWorkEntryMock = jest.fn(() => Promise.resolve());
const updateWorkspaceWorktreeMock = jest.fn(
  (
    _projectId: string,
    _worktreeId: string,
    updater: (worktree: {
      id: string;
      branchName: string;
      createdAt: string;
      lastTouchedAt?: string;
    }) => unknown,
  ) => {
    updater({
      id: 'tree-1',
      branchName: 'feature/test',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    return Promise.resolve(true);
  },
);
const isCoworkWorkspaceMock = jest.fn<boolean, [string]>(() => false);
const withArchivedWorkspaceOperationLockMock = jest.fn(
  (_projectId: string, operation: () => Promise<unknown>) => operation(),
);
const sendToAllWindowsMock = jest.fn();

jest.mock('../lib/cowork-work-entries', () => ({
  get touchWorkEntry(): typeof touchWorkEntryMock {
    return touchWorkEntryMock;
  },
}));

jest.mock('../lib/workspace-persistence', () => ({
  get updateWorkspaceWorktree(): typeof updateWorkspaceWorktreeMock {
    return updateWorkspaceWorktreeMock;
  },
}));

jest.mock('../lib/workspace-registry', () => ({
  // The real predicate: App Advisor or a Cowork workspace.
  isWorkEntryWorkspace: (id: string): boolean =>
    id === 'app-advisor' || isCoworkWorkspaceMock(id),
}));

jest.mock('../lib/archived-containers', () => ({
  ...jest.requireActual<typeof ArchivedContainersModule>(
    '../lib/archived-containers',
  ),
  get withArchivedWorkspaceOperationLock(): typeof withArchivedWorkspaceOperationLockMock {
    return withArchivedWorkspaceOperationLockMock;
  },
}));

jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  get sendToAllWindows(): typeof sendToAllWindowsMock {
    return sendToAllWindowsMock;
  },
}));

import {
  flushWorkspaceTargetTouches,
  resetWorkspaceActivityForTests,
  runWithWorkspaceTargetActivityDeletion,
  touchWorkspaceTarget,
  touchWorkspaceTargetAfterCommit,
  touchWorkspaceTargetWithoutOperationLock,
} from '../lib/workspace-activity';
import { withArchivedWorkspaceOperationLock } from '../lib/archived-containers';

describe('workspace activity watermark', () => {
  beforeEach(() => {
    resetWorkspaceActivityForTests();
    touchWorkEntryMock.mockClear();
    updateWorkspaceWorktreeMock.mockClear();
    sendToAllWindowsMock.mockClear();
    withArchivedWorkspaceOperationLockMock.mockReset();
    withArchivedWorkspaceOperationLockMock.mockImplementation(
      jest.requireActual<typeof ArchivedContainersModule>(
        '../lib/archived-containers',
      ).withArchivedWorkspaceOperationLock,
    );
    isCoworkWorkspaceMock.mockReset();
    isCoworkWorkspaceMock.mockReturnValue(false);
  });

  it('drains queued activity before deletion and lets later external touches settle under its lock', async () => {
    const external = new AsyncResource('external-activity-during-deletion');
    let releaseLock: () => void = () => {};
    let enteredLock: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredLock = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = withArchivedWorkspaceOperationLock(
      'workspace-1',
      async () => {
        enteredLock();
        await gate;
      },
    );
    await entered;
    const priorTouch = touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000);
    let deletionEntered = false;
    const deletion = runWithWorkspaceTargetActivityDeletion(
      'workspace-1',
      'tree-1',
      () =>
        withArchivedWorkspaceOperationLock('workspace-1', async () => {
          deletionEntered = true;
          expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(1);
          const touch = external.runInAsyncScope(() =>
            touchWorkspaceTargetAfterCommit('workspace-1', 'tree-1', 1_121_000),
          );
          let settled = false;
          void touch.then(() => {
            settled = true;
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(settled).toBe(true);
          await touch;
          expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
        }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const startedBeforeDrain = deletionEntered;
    releaseLock();
    await Promise.all([blocker, priorTouch, deletion]);
    expect(startedBeforeDrain).toBe(false);
    await flushWorkspaceTargetTouches();
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
  });

  it('keeps ordinary activity behind the archive lock while deletion is in progress', async () => {
    const external = new AsyncResource('external-file-save-during-deletion');
    let touch: Promise<void> = Promise.resolve();
    let settledWhileDeleting = false;

    await runWithWorkspaceTargetActivityDeletion('workspace-1', 'tree-1', () =>
      withArchivedWorkspaceOperationLock('workspace-1', async () => {
        touch = external.runInAsyncScope(() =>
          touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000),
        );
        void touch.then(() => {
          settledWhileDeleting = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settledWhileDeleting).toBe(false);
      }),
    );

    await touch;
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it('persists committed chat activity while an ordinary same-target touch waits for the archive lock', async () => {
    const external = new AsyncResource(
      'committed-chat-activity-during-archive',
    );
    let releaseArchive: () => void = () => {};
    let archiveEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      archiveEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const archive = withArchivedWorkspaceOperationLock(
      'workspace-1',
      async () => {
        archiveEntered();
        await release;
      },
    );
    await entered;

    const ordinaryTouch = external.runInAsyncScope(() =>
      touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000),
    );
    const committedTouch = external.runInAsyncScope(() =>
      touchWorkspaceTargetAfterCommit('workspace-1', 'tree-1', 1_121_000),
    );
    let committedSettled = false;
    void committedTouch.then(() => {
      committedSettled = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledWhileArchiveHeld = committedSettled;
    releaseArchive();
    await Promise.all([archive, ordinaryTouch, committedTouch]);

    expect(settledWhileArchiveHeld).toBe(true);
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(1);
    const updater = updateWorkspaceWorktreeMock.mock.calls[0]?.[2];
    expect(
      updater?.({ id: 'tree-1', branchName: 'branch', createdAt: '' }),
    ).toMatchObject({
      lastTouchedAt: new Date(1_121_000).toISOString(),
    });
  });

  it('does not make committed chat activity wait for the tail of two queued archives', async () => {
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    let firstEntered: () => void = () => {};
    let secondEntered: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    const firstArchive = withArchivedWorkspaceOperationLock(
      'workspace-1',
      async () => {
        firstEntered();
        await firstGate;
      },
    );
    await firstStarted;
    const secondArchive = withArchivedWorkspaceOperationLock(
      'workspace-1',
      async () => {
        secondEntered();
        await secondGate;
      },
    );

    await expect(
      touchWorkspaceTargetAfterCommit('workspace-1', 'tree-1', 1_000_000),
    ).resolves.toBeUndefined();
    releaseFirst();
    await secondStarted;
    await expect(
      touchWorkspaceTargetAfterCommit('workspace-1', 'tree-1', 1_121_000),
    ).resolves.toBeUndefined();

    releaseSecond();
    await Promise.all([firstArchive, secondArchive]);
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
  });

  it('persists a newer post-commit watermark during deletion even inside the write interval', async () => {
    isCoworkWorkspaceMock.mockReturnValue(true);
    await touchWorkspaceTarget('cowork-1', 'entry-1', 1_000_000);

    await runWithWorkspaceTargetActivityDeletion('cowork-1', 'entry-1', () =>
      withArchivedWorkspaceOperationLock('cowork-1', () =>
        touchWorkspaceTargetAfterCommit('cowork-1', 'entry-1', 1_030_000),
      ),
    );

    expect(touchWorkEntryMock).toHaveBeenCalledTimes(2);
    expect(touchWorkEntryMock).toHaveBeenLastCalledWith(
      'cowork-1',
      'entry-1',
      new Date(1_030_000).toISOString(),
    );
  });

  it('flushes the newest coalesced post-commit watermark independently', async () => {
    await touchWorkspaceTargetAfterCommit('workspace-1', 'tree-1', 1_000_000);
    await touchWorkspaceTargetAfterCommit('workspace-1', 'tree-1', 1_030_000);

    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(1);
    expect(withArchivedWorkspaceOperationLockMock).not.toHaveBeenCalled();

    await flushWorkspaceTargetTouches();

    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
    const updater = updateWorkspaceWorktreeMock.mock.calls[1]?.[2];
    expect(
      updater?.({ id: 'tree-1', branchName: 'branch', createdAt: '' }),
    ).toMatchObject({
      lastTouchedAt: new Date(1_030_000).toISOString(),
    });
  });

  it('rejects a failed post-commit write and permits a same-timestamp retry', async () => {
    updateWorkspaceWorktreeMock.mockRejectedValueOnce(
      new Error('post-commit write failed'),
    );

    await expect(
      touchWorkspaceTargetAfterCommit('workspace-1', 'tree-1', 1_000_000),
    ).rejects.toThrow('post-commit write failed');

    await touchWorkspaceTargetAfterCommit('workspace-1', 'tree-1', 1_000_000);
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
  });

  it('announces only a committed watermark, never one whose write failed', async () => {
    updateWorkspaceWorktreeMock.mockImplementationOnce(
      (_projectId, _worktreeId, updater) => {
        // The row is computed under the lock, then the write fails.
        updater({ id: 'tree-1', branchName: 'branch', createdAt: '' });
        return Promise.reject(new Error('write failed'));
      },
    );

    await expect(
      touchWorkspaceTargetAfterCommit('workspace-1', 'tree-1', 1_000_000),
    ).rejects.toThrow('write failed');
    expect(sendToAllWindowsMock).not.toHaveBeenCalled();

    await touchWorkspaceTargetAfterCommit('workspace-1', 'tree-1', 1_000_000);
    expect(sendToAllWindowsMock).toHaveBeenCalledTimes(1);
    expect(sendToAllWindowsMock.mock.calls[0]).toEqual([
      'workspace:worktrees-updated',
      {
        workspaceId: 'workspace-1',
        worktree: {
          id: 'tree-1',
          branchName: 'feature/test',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastTouchedAt: new Date(1_000_000).toISOString(),
        },
      },
    ]);
  });

  it('persists Work Entry post-commit activity without the archive lock', async () => {
    isCoworkWorkspaceMock.mockReturnValue(true);

    await touchWorkspaceTargetAfterCommit(
      'cowork-1',
      'entry-1',
      '2026-09-21T12:00:00.000Z',
    );

    expect(touchWorkEntryMock).toHaveBeenCalledWith(
      'cowork-1',
      'entry-1',
      '2026-09-21T12:00:00.000Z',
    );
    expect(withArchivedWorkspaceOperationLockMock).not.toHaveBeenCalled();
  });

  it('flushes an already coalesced touch before deletion begins', async () => {
    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000);
    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_030_000);
    await runWithWorkspaceTargetActivityDeletion(
      'workspace-1',
      'tree-1',
      () => {
        expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
        return Promise.resolve();
      },
    );
    await flushWorkspaceTargetTouches();
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the completed watermark monotonic when an older concurrent direct write finishes last', async () => {
    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000);
    await runWithWorkspaceTargetActivityDeletion(
      'workspace-1',
      'tree-1',
      async () => {
        await Promise.all([
          touchWorkspaceTarget('workspace-1', 'tree-1', 1_121_000),
          touchWorkspaceTarget('workspace-1', 'tree-1', 1_070_000),
        ]);
      },
    );
    const completedWrites = updateWorkspaceWorktreeMock.mock.calls.length;
    await touchWorkspaceTargetWithoutOperationLock(
      'workspace-1',
      'tree-1',
      1_135_000,
    );
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(completedWrites);
  });

  it('persists activity before returning to a commit even if deletion later fails', async () => {
    await expect(
      runWithWorkspaceTargetActivityDeletion('workspace-1', 'tree-1', () =>
        withArchivedWorkspaceOperationLock('workspace-1', async () => {
          await touchWorkspaceTarget('workspace-1', 'tree-1', 1_090_000);
          await touchWorkspaceTarget('workspace-1', 'tree-1', 1_030_000);
          expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(1);
          throw new Error('teardown failed');
        }),
      ),
    ).rejects.toThrow('teardown failed');
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(1);
    const updater = updateWorkspaceWorktreeMock.mock.calls[0]?.[2];
    expect(
      updater?.({ id: 'tree-1', branchName: 'branch', createdAt: '' }),
    ).toMatchObject({
      lastTouchedAt: new Date(1_090_000).toISOString(),
    });
  });

  it('keeps concurrent deletion fences until the last operation exits', async () => {
    let release: () => void = () => {};
    let started: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runWithWorkspaceTargetActivityDeletion(
      'workspace-1',
      'tree-1',
      async () => {
        started();
        await gate;
        throw new Error('second cleanup lost the race');
      },
    );
    await entered;
    await runWithWorkspaceTargetActivityDeletion(
      'workspace-1',
      'tree-1',
      async () => {
        await touchWorkspaceTarget('workspace-1', 'tree-1', 1_090_000);
      },
    );
    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_121_000);
    release();
    await expect(first).rejects.toThrow('lost the race');
    await flushWorkspaceTargetTouches();
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
  });

  it('aborts deletion on a failed queued watermark and permits a subsequent retry', async () => {
    updateWorkspaceWorktreeMock.mockRejectedValueOnce(
      new Error('write failed'),
    );
    const pending = touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000);
    const rejected = expect(pending).rejects.toThrow('write failed');
    const operation = jest.fn(() => Promise.resolve());
    await expect(
      runWithWorkspaceTargetActivityDeletion(
        'workspace-1',
        'tree-1',
        operation,
      ),
    ).rejects.toThrow('write failed');
    await rejected;
    expect(operation).not.toHaveBeenCalled();
    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000);
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
  });

  it('retries a failed coalesced watermark on the next deletion attempt', async () => {
    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000);
    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_030_000);
    updateWorkspaceWorktreeMock.mockRejectedValueOnce(
      new Error('coalesced write failed'),
    );

    await expect(
      runWithWorkspaceTargetActivityDeletion('workspace-1', 'tree-1', () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow('coalesced write failed');

    await runWithWorkspaceTargetActivityDeletion('workspace-1', 'tree-1', () =>
      Promise.resolve(),
    );
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(3);
  });

  it('propagates failed activity writes during deletion and releases the fence for retry', async () => {
    updateWorkspaceWorktreeMock.mockRejectedValueOnce(
      new Error('activity write failed'),
    );
    await expect(
      runWithWorkspaceTargetActivityDeletion(
        'workspace-1',
        'tree-1',
        async () => {
          await touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000);
        },
      ),
    ).rejects.toThrow('activity write failed');
    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000);
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
  });

  it.each([1_000_000, 1_030_000, 1_061_000])(
    'completes an archive-owned activity write at %i while a background touch waits for its lock',
    async (timestamp) => {
      let releaseArchive: () => void = () => {};
      let archiveEntered: () => void = () => {};
      let beginOwnedTouch: () => void = () => {};
      let ownedTouch: Promise<void> = Promise.resolve();
      let completedWhileArchiveHeld = false;
      const entered = new Promise<void>((resolve) => {
        archiveEntered = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseArchive = resolve;
      });
      const startOwnedTouch = new Promise<void>((resolve) => {
        beginOwnedTouch = resolve;
      });
      const archive = withArchivedWorkspaceOperationLock(
        'workspace-1',
        async () => {
          archiveEntered();
          await startOwnedTouch;
          ownedTouch = touchWorkspaceTarget('workspace-1', 'tree-1', timestamp);
          void ownedTouch.then(() => {
            completedWhileArchiveHeld = true;
          });
          await release;
        },
      );
      await entered;
      const backgroundTouch = touchWorkspaceTarget(
        'workspace-1',
        'tree-1',
        1_000_000,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      beginOwnedTouch();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const observedCompletion = completedWhileArchiveHeld;
      // Release before asserting so a red run leaves no unresolved promises.
      releaseArchive();
      await Promise.all([archive, backgroundTouch, ownedTouch]);
      expect(observedCompletion).toBe(true);
    },
  );

  it('does not overwrite a newer persisted watermark with an older queued touch', async () => {
    await touchWorkspaceTarget(
      'workspace-1',
      'tree-1',
      '2026-09-01T00:00:00.000Z',
    );
    const updater = updateWorkspaceWorktreeMock.mock.calls[0]?.[2];
    const current = {
      id: 'tree-1',
      branchName: 'feature/test',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastTouchedAt: '2026-09-11T00:00:00.000Z',
    };
    expect(updater?.(current)).toEqual(current);
  });

  it('persists code-worktree activity and coalesces high-volume touches', async () => {
    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000);
    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_030_000);
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(1);
    expect(withArchivedWorkspaceOperationLockMock).toHaveBeenCalledWith(
      'workspace-1',
      expect.any(Function),
    );
    expect(sendToAllWindowsMock).toHaveBeenCalledWith(
      'workspace:worktrees-updated',
      {
        workspaceId: 'workspace-1',
        worktree: {
          id: 'tree-1',
          branchName: 'feature/test',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastTouchedAt: '1970-01-01T00:16:40.000Z',
        },
      },
    );

    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_061_000);
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
    const updater = updateWorkspaceWorktreeMock.mock.calls[1]?.[2];
    expect(
      updater?.({
        id: 'tree-1',
        branchName: 'feature/test',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual(
      expect.objectContaining({ lastTouchedAt: '1970-01-01T00:17:41.000Z' }),
    );
  });

  it('resolves a flush whose touch write fails without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const capture = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', capture);
    try {
      await touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000);
      await touchWorkspaceTarget('workspace-1', 'tree-1', 1_030_000);
      updateWorkspaceWorktreeMock.mockRejectedValueOnce(
        new Error('flush write failed'),
      );

      await expect(flushWorkspaceTargetTouches()).resolves.toBeUndefined();
      for (let turn = 0; turn < 5; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));

      expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', capture);
    }
  });

  it('flushes the newest touch suppressed inside the write interval', async () => {
    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_000_000);
    await touchWorkspaceTarget('workspace-1', 'tree-1', 1_030_000);

    await flushWorkspaceTargetTouches();

    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(2);
    const updater = updateWorkspaceWorktreeMock.mock.calls[1]?.[2];
    expect(
      updater?.({
        id: 'tree-1',
        branchName: 'feature/test',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual(
      expect.objectContaining({ lastTouchedAt: '1970-01-01T00:17:10.000Z' }),
    );
  });

  it('does not let an uncommitted queued touch suppress a lock-owned touch', async () => {
    let releaseQueuedTouch: (() => Promise<void>) | undefined;
    withArchivedWorkspaceOperationLockMock.mockImplementationOnce(
      (_projectId: string, operation: () => Promise<unknown>) =>
        new Promise<void>((resolve, reject) => {
          releaseQueuedTouch = async (): Promise<void> => {
            try {
              await operation();
              resolve();
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          };
        }),
    );
    const queuedTouch = touchWorkspaceTarget(
      'workspace-1',
      'tree-1',
      1_000_000,
    );
    await Promise.resolve();

    await touchWorkspaceTargetWithoutOperationLock(
      'workspace-1',
      'tree-1',
      1_000_000,
    );
    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(1);

    await releaseQueuedTouch?.();
    await queuedTouch;

    expect(updateWorkspaceWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it('persists cowork and App Advisor activity on the Work Entry row', async () => {
    isCoworkWorkspaceMock.mockReturnValue(true);
    await touchWorkspaceTarget(
      'cowork-1',
      'entry-1',
      '2026-08-31T12:00:00.000Z',
    );
    expect(touchWorkEntryMock).toHaveBeenCalledWith(
      'cowork-1',
      'entry-1',
      '2026-08-31T12:00:00.000Z',
    );
    expect(withArchivedWorkspaceOperationLockMock).toHaveBeenCalledWith(
      'cowork-1',
      expect.any(Function),
    );

    isCoworkWorkspaceMock.mockReturnValue(false);
    await touchWorkspaceTarget(
      'app-advisor',
      'entry-2',
      '2026-08-31T13:00:00.000Z',
    );
    expect(touchWorkEntryMock).toHaveBeenCalledWith(
      'app-advisor',
      'entry-2',
      '2026-08-31T13:00:00.000Z',
    );
    expect(withArchivedWorkspaceOperationLockMock).toHaveBeenCalledWith(
      'app-advisor',
      expect.any(Function),
    );
    expect(sendToAllWindowsMock).not.toHaveBeenCalled();
  });
});

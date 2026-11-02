const reconcileTrackedWorkspaceWorktreesMock = jest.fn();
const cleanupLiveWorktreeStateMock = jest.fn(() => Promise.resolve());
const purgeLiveWorktreeObservabilityDataMock = jest.fn(() => Promise.resolve());
const cleanupPersistedWorktreeDataMock = jest.fn(() =>
  Promise.resolve([] as string[]),
);

jest.mock('../lib/github-poller', () => ({
  get reconcileTrackedWorkspaceWorktrees(): typeof reconcileTrackedWorkspaceWorktreesMock {
    return reconcileTrackedWorkspaceWorktreesMock;
  },
}));
jest.mock('../lib/worktree-live-cleanup', () => ({
  get cleanupLiveWorktreeState(): typeof cleanupLiveWorktreeStateMock {
    return cleanupLiveWorktreeStateMock;
  },
  get purgeLiveWorktreeObservabilityData(): typeof purgeLiveWorktreeObservabilityDataMock {
    return purgeLiveWorktreeObservabilityDataMock;
  },
}));
jest.mock('../lib/worktree-data-cleanup', () => ({
  get cleanupPersistedWorktreeData(): typeof cleanupPersistedWorktreeDataMock {
    return cleanupPersistedWorktreeDataMock;
  },
}));
const notifyDesktopInventoryChangedMock = jest.fn();
jest.mock('../services/desktop-inventory-sync-signals', () => ({
  get notifyDesktopInventoryChanged(): typeof notifyDesktopInventoryChangedMock {
    return notifyDesktopInventoryChangedMock;
  },
}));
const notifyLedgerContainerRemovedExternallyMock = jest.fn();
jest.mock('../ledger/lifecycle', () => ({
  get notifyLedgerContainerRemovedExternally(): typeof notifyLedgerContainerRemovedExternallyMock {
    return notifyLedgerContainerRemovedExternallyMock;
  },
}));

import { reconcileExternalWorktreeSnapshot } from '../lib/worktree-registry-reconciliation';
import { setDelegationActivity } from '../agents/delegation/activity';

describe('reconcileExternalWorktreeSnapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cleanupLiveWorktreeStateMock.mockResolvedValue(undefined);
    cleanupPersistedWorktreeDataMock.mockResolvedValue([]);
  });

  it('tells the cloud inventory sync about every external worktree change', async () => {
    reconcileTrackedWorkspaceWorktreesMock.mockReturnValue({
      removedWorktreeIds: [],
    });
    await reconcileExternalWorktreeSnapshot('ws-1', [
      { id: 'wt-added', branchName: 'feature', createdAt: 'now' },
    ]);
    reconcileTrackedWorkspaceWorktreesMock.mockReturnValue({
      removedWorktreeIds: ['wt-gone'],
    });
    await reconcileExternalWorktreeSnapshot('ws-1', []);
    // Additions and removals alike: the sync diffs the per-worktree
    // pipeline documents against what the cloud holds.
    expect(notifyDesktopInventoryChangedMock).toHaveBeenCalledTimes(2);
    expect(notifyDesktopInventoryChangedMock).toHaveBeenCalledWith([
      'pipelines',
    ]);
  });

  it('does not clean up additions', async () => {
    reconcileTrackedWorkspaceWorktreesMock.mockReturnValue({
      addedWorktreeIds: ['wt-1'],
      removedWorktreeIds: [],
    });
    await reconcileExternalWorktreeSnapshot('workspace-1', []);
    expect(cleanupLiveWorktreeStateMock).not.toHaveBeenCalled();
  });

  it('orders live cleanup before persisted cleanup with live purge', async () => {
    reconcileTrackedWorkspaceWorktreesMock.mockReturnValue({
      addedWorktreeIds: [],
      removedWorktreeIds: ['wt-1'],
    });
    const order: string[] = [];
    cleanupLiveWorktreeStateMock.mockImplementation(() => {
      order.push('live');
      return Promise.resolve();
    });
    cleanupPersistedWorktreeDataMock.mockImplementation(() => {
      order.push('persisted');
      return Promise.resolve([]);
    });

    await reconcileExternalWorktreeSnapshot('workspace-1', []);

    expect(order).toEqual(['live', 'persisted']);
    expect(cleanupPersistedWorktreeDataMock).toHaveBeenCalledWith(
      'workspace-1',
      'wt-1',
      {
        observabilityMode: 'live-service',
        purgeObservabilityData: purgeLiveWorktreeObservabilityDataMock,
      },
    );
  });

  it('cleans up an out-of-process removal even while its delegates are live', async () => {
    reconcileTrackedWorkspaceWorktreesMock.mockReturnValue({
      addedWorktreeIds: [],
      removedWorktreeIds: ['wt-1'],
    });
    setDelegationActivity('cli-reconcile-owner', 'workspace-1/wt-1/chat-a', 1);
    try {
      await reconcileExternalWorktreeSnapshot('workspace-1', []);
    } finally {
      setDelegationActivity(
        'cli-reconcile-owner',
        'workspace-1/wt-1/chat-a',
        0,
      );
    }
    expect(cleanupLiveWorktreeStateMock).toHaveBeenCalledWith(
      'workspace-1',
      'wt-1',
    );
    expect(cleanupPersistedWorktreeDataMock).toHaveBeenCalled();
  });

  it('deduplicates concurrent cleanup for the same removal', async () => {
    let release: (() => void) | undefined;
    cleanupLiveWorktreeStateMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    reconcileTrackedWorkspaceWorktreesMock.mockReturnValue({
      addedWorktreeIds: [],
      removedWorktreeIds: ['wt-1'],
    });
    const first = reconcileExternalWorktreeSnapshot('workspace-1', []);
    const second = reconcileExternalWorktreeSnapshot('workspace-1', []);
    expect(cleanupLiveWorktreeStateMock).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all([first, second]);
    expect(notifyLedgerContainerRemovedExternallyMock).toHaveBeenCalledTimes(1);
  });

  describe('Ledger lifecycle participant', () => {
    it('tells the Ledger about every externally removed worktree', async () => {
      reconcileTrackedWorkspaceWorktreesMock.mockReturnValue({
        addedWorktreeIds: [],
        removedWorktreeIds: ['wt-1', 'wt-2'],
      });

      await reconcileExternalWorktreeSnapshot('workspace-1', []);

      // The snapshot holds only the remaining worktrees, so the removed
      // records' creation times are unknown.
      expect(notifyLedgerContainerRemovedExternallyMock).toHaveBeenCalledTimes(
        2,
      );
      expect(notifyLedgerContainerRemovedExternallyMock).toHaveBeenCalledWith(
        {
          kind: 'code_worktree',
          workspaceId: 'workspace-1',
          worktreeId: 'wt-1',
        },
        null,
      );
      expect(notifyLedgerContainerRemovedExternallyMock).toHaveBeenCalledWith(
        {
          kind: 'code_worktree',
          workspaceId: 'workspace-1',
          worktreeId: 'wt-2',
        },
        null,
      );
    });

    it('tells the Ledger after live cleanup and before persisted cleanup', async () => {
      reconcileTrackedWorkspaceWorktreesMock.mockReturnValue({
        addedWorktreeIds: [],
        removedWorktreeIds: ['wt-1'],
      });
      const order: string[] = [];
      cleanupLiveWorktreeStateMock.mockImplementation(() => {
        order.push('live');
        return Promise.resolve();
      });
      notifyLedgerContainerRemovedExternallyMock.mockImplementationOnce(() => {
        order.push('ledger');
      });
      cleanupPersistedWorktreeDataMock.mockImplementation(() => {
        order.push('persisted');
        return Promise.resolve([]);
      });

      await reconcileExternalWorktreeSnapshot('workspace-1', []);

      expect(order).toEqual(['live', 'ledger', 'persisted']);
    });

    it('tells the Ledger even when live and persisted cleanup fail', async () => {
      reconcileTrackedWorkspaceWorktreesMock.mockReturnValue({
        addedWorktreeIds: [],
        removedWorktreeIds: ['wt-1'],
      });
      cleanupLiveWorktreeStateMock.mockRejectedValueOnce(
        new Error('live cleanup failed'),
      );
      cleanupPersistedWorktreeDataMock.mockRejectedValueOnce(
        new Error('persisted cleanup failed'),
      );
      const warn = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      try {
        await reconcileExternalWorktreeSnapshot('workspace-1', []);
      } finally {
        warn.mockRestore();
      }

      expect(notifyLedgerContainerRemovedExternallyMock).toHaveBeenCalledWith(
        {
          kind: 'code_worktree',
          workspaceId: 'workspace-1',
          worktreeId: 'wt-1',
        },
        null,
      );
    });

    it('completes reconciliation when the Ledger participant throws', async () => {
      reconcileTrackedWorkspaceWorktreesMock.mockReturnValue({
        addedWorktreeIds: [],
        removedWorktreeIds: ['wt-1', 'wt-2'],
      });
      notifyLedgerContainerRemovedExternallyMock.mockImplementationOnce(() => {
        throw new Error('Ledger participant defect');
      });

      await expect(
        reconcileExternalWorktreeSnapshot('workspace-1', []),
      ).resolves.toBeUndefined();

      expect(notifyLedgerContainerRemovedExternallyMock).toHaveBeenCalledTimes(
        2,
      );
      expect(cleanupPersistedWorktreeDataMock).toHaveBeenCalledWith(
        'workspace-1',
        'wt-1',
        expect.objectContaining({ observabilityMode: 'live-service' }),
      );
      expect(cleanupPersistedWorktreeDataMock).toHaveBeenCalledWith(
        'workspace-1',
        'wt-2',
        expect.objectContaining({ observabilityMode: 'live-service' }),
      );
    });
  });
});

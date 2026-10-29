import {
  acquireSplitDestinationWorktreeClaim,
  acquireSplitLock,
  acquireWorkspaceArchiveRetentionLease,
  acquireWorkspaceDeletionLease,
  assertNotSplitDestinationWorktreeClaimed,
  assertNotSplitLocked,
  getSplitLockedWorktrees,
  isSplitDestinationWorktreeClaimed,
  isSplitLocked,
  onSplitLockChange,
  releaseIdleSplitLocks,
  releaseSplitDestinationWorktreeClaim,
  releaseSplitLock,
  SplitLockError,
  type SplitLockChangeEvent,
} from '../services/split-lock-service';
import {
  resetWorkspaceTargetExclusionsForTests,
  withWorkspaceTargetAutoArchiveLease,
} from '../lib/workspace-target-exclusion';

describe('split-lock-service', () => {
  afterEach(() => {
    // Ensure no lock leaks across tests.
    releaseSplitLock('ws', 'wt');
    releaseSplitLock('ws', 'other');
    releaseSplitLock('other-ws', 'wt');
    releaseSplitLock('ws-a', 'wt-a');
    releaseSplitLock('ws-b', 'wt-b');
    releaseSplitDestinationWorktreeClaim('ws', 'wt');
    releaseSplitDestinationWorktreeClaim('ws', 'other');
    resetWorkspaceTargetExclusionsForTests();
  });

  describe('lifecycle', () => {
    it('acquire marks the worktree locked and release clears it', () => {
      expect(isSplitLocked('ws', 'wt')).toBe(false);
      acquireSplitLock('ws', 'wt');
      expect(isSplitLocked('ws', 'wt')).toBe(true);
      releaseSplitLock('ws', 'wt');
      expect(isSplitLocked('ws', 'wt')).toBe(false);
    });

    it('locks are keyed by project AND worktree independently', () => {
      acquireSplitLock('ws', 'wt');
      expect(isSplitLocked('ws', 'other')).toBe(false);
      expect(isSplitLocked('other-ws', 'wt')).toBe(false);
    });

    it('release of an unheld lock is a safe no-op', () => {
      expect(() => releaseSplitLock('ws', 'wt')).not.toThrow();
      expect(isSplitLocked('ws', 'wt')).toBe(false);
    });
  });

  describe('double-acquire', () => {
    it('throws SplitLockError when acquiring an already-held lock', () => {
      acquireSplitLock('ws', 'wt');
      expect(() => acquireSplitLock('ws', 'wt')).toThrow(SplitLockError);
      // The original lock is preserved.
      expect(isSplitLocked('ws', 'wt')).toBe(true);
    });
  });

  it('rejects a split lock while Auto Delete owns the target lease', async () => {
    await withWorkspaceTargetAutoArchiveLease('ws', 'wt', () => {
      expect(() => acquireSplitLock('ws', 'wt')).toThrow(
        'being automatically deleted',
      );
      return Promise.resolve();
    });
    expect(isSplitLocked('ws', 'wt')).toBe(false);
  });

  describe('project deletion lease', () => {
    it('rejects deletion while any worktree in the project is split-locked', () => {
      acquireSplitLock('ws', 'wt');

      expect(() => acquireWorkspaceDeletionLease('ws')).toThrow(
        'Cannot delete a project while one of its worktrees is being split.',
      );
    });

    it('rejects a split until project deletion releases its lease', () => {
      const release = acquireWorkspaceDeletionLease('ws');
      try {
        expect(() => acquireSplitLock('ws', 'wt')).toThrow(SplitLockError);
      } finally {
        release();
      }

      expect(() => acquireSplitLock('ws', 'wt')).not.toThrow();
    });

    it('rejects deletion while a destination worktree is claimed', () => {
      acquireSplitDestinationWorktreeClaim('ws', 'wt');

      expect(() => acquireWorkspaceDeletionLease('ws')).toThrow(
        'Cannot delete a project while one of its worktrees is being split.',
      );
    });
  });

  describe('split destination claims', () => {
    it('holds a destination until released', () => {
      acquireSplitDestinationWorktreeClaim('ws', 'wt');
      expect(isSplitDestinationWorktreeClaimed('ws', 'wt')).toBe(true);
      expect(() =>
        assertNotSplitDestinationWorktreeClaimed(
          'ws',
          'wt',
          'archiving the worktree',
        ),
      ).toThrow(SplitLockError);

      releaseSplitDestinationWorktreeClaim('ws', 'wt');
      expect(isSplitDestinationWorktreeClaimed('ws', 'wt')).toBe(false);
      expect(() =>
        assertNotSplitDestinationWorktreeClaimed(
          'ws',
          'wt',
          'archiving the worktree',
        ),
      ).not.toThrow();
    });

    it('rejects duplicate destination claims', () => {
      acquireSplitDestinationWorktreeClaim('ws', 'wt');
      expect(() => acquireSplitDestinationWorktreeClaim('ws', 'wt')).toThrow(
        SplitLockError,
      );
    });
  });

  describe('project archive-retention lease', () => {
    it('rejects retention changes while a worktree is split-locked', () => {
      acquireSplitLock('ws', 'wt');

      expect(() => acquireWorkspaceArchiveRetentionLease('ws')).toThrow(
        'Cannot change deletion retention while this project is being split or deleted.',
      );
    });

    it('rejects a split until the retention change releases its lease', () => {
      const release = acquireWorkspaceArchiveRetentionLease('ws');
      try {
        expect(() => acquireSplitLock('ws', 'wt')).toThrow(
          'This project is busy with a project split or archive-retention change; try again once it finishes.',
        );
      } finally {
        release();
      }

      expect(() => acquireSplitLock('ws', 'wt')).not.toThrow();
    });
  });

  describe('assertNotSplitLocked', () => {
    it('returns silently when the worktree is not locked', () => {
      expect(() =>
        assertNotSplitLocked('ws', 'wt', 'running a hook'),
      ).not.toThrow();
    });

    it('throws a typed SplitLockError carrying the operation label', () => {
      acquireSplitLock('ws', 'wt');
      let caught: unknown;
      try {
        assertNotSplitLocked('ws', 'wt', 'running a hook');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SplitLockError);
      const lockError = caught as SplitLockError;
      expect(lockError.operation).toBe('running a hook');
      expect(lockError.workspaceId).toBe('ws');
      expect(lockError.worktreeId).toBe('wt');
      expect(lockError.message).toContain('running a hook');
    });
  });

  describe('onSplitLockChange', () => {
    it('emits locked=true on acquire and locked=false on release', () => {
      const events: SplitLockChangeEvent[] = [];
      const unsubscribe = onSplitLockChange((event) => events.push(event));
      try {
        acquireSplitLock('ws', 'wt');
        releaseSplitLock('ws', 'wt');
      } finally {
        unsubscribe();
      }
      expect(events).toEqual([
        { workspaceId: 'ws', worktreeId: 'wt', locked: true },
        { workspaceId: 'ws', worktreeId: 'wt', locked: false },
      ]);
    });

    it('does not emit on a no-op release', () => {
      const events: SplitLockChangeEvent[] = [];
      const unsubscribe = onSplitLockChange((event) => events.push(event));
      try {
        releaseSplitLock('ws', 'wt');
      } finally {
        unsubscribe();
      }
      expect(events).toEqual([]);
    });

    it('stops delivering after unsubscribe', () => {
      const events: SplitLockChangeEvent[] = [];
      const unsubscribe = onSplitLockChange((event) => events.push(event));
      unsubscribe();
      acquireSplitLock('ws', 'wt');
      releaseSplitLock('ws', 'wt');
      expect(events).toEqual([]);
    });
  });

  describe('releaseIdleSplitLocks', () => {
    it('releases idle locks, broadcasts, and returns the count', () => {
      const events: SplitLockChangeEvent[] = [];
      const unsubscribe = onSplitLockChange((event) => events.push(event));
      try {
        acquireSplitLock('ws-a', 'wt-a');
        acquireSplitLock('ws-b', 'wt-b');
        events.length = 0; // drop the acquire events

        // No execute in flight for anything -> every lock is idle.
        const released = releaseIdleSplitLocks(() => false);

        expect(released).toBe(2);
        expect(isSplitLocked('ws-a', 'wt-a')).toBe(false);
        expect(isSplitLocked('ws-b', 'wt-b')).toBe(false);
        // A release change was broadcast for each.
        expect(events).toContainEqual({
          workspaceId: 'ws-a',
          worktreeId: 'wt-a',
          locked: false,
        });
        expect(events).toContainEqual({
          workspaceId: 'ws-b',
          worktreeId: 'wt-b',
          locked: false,
        });
      } finally {
        unsubscribe();
      }
    });

    it('keeps a lock that has an execute in flight for its key', () => {
      const events: SplitLockChangeEvent[] = [];
      const unsubscribe = onSplitLockChange((event) => events.push(event));
      try {
        acquireSplitLock('ws-a', 'wt-a'); // idle
        acquireSplitLock('ws-b', 'wt-b'); // execute in flight
        events.length = 0;

        const released = releaseIdleSplitLocks(
          (workspaceId, worktreeId) =>
            workspaceId === 'ws-b' && worktreeId === 'wt-b',
        );

        expect(released).toBe(1);
        // Idle one released, in-flight one kept.
        expect(isSplitLocked('ws-a', 'wt-a')).toBe(false);
        expect(isSplitLocked('ws-b', 'wt-b')).toBe(true);
        expect(events).toEqual([
          { workspaceId: 'ws-a', worktreeId: 'wt-a', locked: false },
        ]);
      } finally {
        unsubscribe();
      }
    });

    it('returns 0 and emits nothing when no locks are held', () => {
      const events: SplitLockChangeEvent[] = [];
      const unsubscribe = onSplitLockChange((event) => events.push(event));
      try {
        expect(releaseIdleSplitLocks(() => false)).toBe(0);
        expect(events).toEqual([]);
      } finally {
        unsubscribe();
      }
    });
  });

  describe('getSplitLockedWorktrees', () => {
    it('snapshots every held lock as workspace/worktree pairs', () => {
      acquireSplitLock('ws-a', 'wt-a');
      acquireSplitLock('ws-b', 'wt-b');
      const snapshot = getSplitLockedWorktrees();
      expect(snapshot).toContainEqual({
        workspaceId: 'ws-a',
        worktreeId: 'wt-a',
      });
      expect(snapshot).toContainEqual({
        workspaceId: 'ws-b',
        worktreeId: 'wt-b',
      });
      expect(snapshot).toHaveLength(2);
    });

    it('returns an empty array when nothing is locked', () => {
      expect(getSplitLockedWorktrees()).toEqual([]);
    });
  });
});

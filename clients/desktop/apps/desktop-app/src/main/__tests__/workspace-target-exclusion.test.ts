import {
  isWorkspaceTargetRemovalPending,
  isWorkspaceTargetRuntimeStartReserved,
  markWorkspaceTargetRemovalPending,
  reserveWorkspaceTargetRuntimeStart,
  resetWorkspaceTargetExclusionsForTests,
  whenWorkspaceTargetRemovalSettled,
} from '../lib/workspace-target-exclusion';

describe('workspace target runtime start reservations', () => {
  beforeEach(() => {
    resetWorkspaceTargetExclusionsForTests();
  });

  it('reports a target as reserved until every reservation is released', () => {
    expect(isWorkspaceTargetRuntimeStartReserved('project-a', 'wt-1')).toBe(
      false,
    );

    const first = reserveWorkspaceTargetRuntimeStart('project-a', 'wt-1');
    const second = reserveWorkspaceTargetRuntimeStart('project-a', 'wt-1');

    expect(isWorkspaceTargetRuntimeStartReserved('project-a', 'wt-1')).toBe(
      true,
    );
    expect(isWorkspaceTargetRuntimeStartReserved('project-a', 'wt-2')).toBe(
      false,
    );

    first();
    expect(isWorkspaceTargetRuntimeStartReserved('project-a', 'wt-1')).toBe(
      true,
    );

    second();
    expect(isWorkspaceTargetRuntimeStartReserved('project-a', 'wt-1')).toBe(
      false,
    );
  });
});

describe('workspace target removal-pending registry', () => {
  beforeEach(() => {
    resetWorkspaceTargetExclusionsForTests();
  });

  it('reports a target as pending only between mark and release', () => {
    expect(isWorkspaceTargetRemovalPending('project-a', 'wt-1')).toBe(false);

    const release = markWorkspaceTargetRemovalPending('project-a', 'wt-1');

    expect(isWorkspaceTargetRemovalPending('project-a', 'wt-1')).toBe(true);
    expect(isWorkspaceTargetRemovalPending('project-a', 'wt-2')).toBe(false);
    expect(isWorkspaceTargetRemovalPending('project-b', 'wt-1')).toBe(false);

    release();

    expect(isWorkspaceTargetRemovalPending('project-a', 'wt-1')).toBe(false);
  });

  it('keeps the target pending until every mark is released', () => {
    const first = markWorkspaceTargetRemovalPending('project-a', 'wt-1');
    const second = markWorkspaceTargetRemovalPending('project-a', 'wt-1');

    first();
    expect(isWorkspaceTargetRemovalPending('project-a', 'wt-1')).toBe(true);

    second();
    expect(isWorkspaceTargetRemovalPending('project-a', 'wt-1')).toBe(false);
  });

  it('ignores a repeated release instead of releasing another mark', () => {
    const first = markWorkspaceTargetRemovalPending('project-a', 'wt-1');
    const second = markWorkspaceTargetRemovalPending('project-a', 'wt-1');

    first();
    first();
    expect(isWorkspaceTargetRemovalPending('project-a', 'wt-1')).toBe(true);

    second();
    expect(isWorkspaceTargetRemovalPending('project-a', 'wt-1')).toBe(false);
  });

  describe('waiting for a removal to settle', () => {
    function flush(): Promise<void> {
      return new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    function observe(settled: Promise<void>): { done: boolean } {
      const state = { done: false };
      void settled.then(() => {
        state.done = true;
      });
      return state;
    }

    it('resolves at once for a target that is not being removed', async () => {
      markWorkspaceTargetRemovalPending('project-a', 'wt-2');

      const settled = observe(
        whenWorkspaceTargetRemovalSettled('project-a', 'wt-1'),
      );
      await flush();

      expect(settled.done).toBe(true);
    });

    it('waits for the last mark to be released', async () => {
      const first = markWorkspaceTargetRemovalPending('project-a', 'wt-1');
      const second = markWorkspaceTargetRemovalPending('project-a', 'wt-1');
      const settled = observe(
        whenWorkspaceTargetRemovalSettled('project-a', 'wt-1'),
      );

      first();
      await flush();
      expect(settled.done).toBe(false);

      second();
      await flush();
      expect(settled.done).toBe(true);
    });

    it('keeps waiting when another removal starts as the last one ends', async () => {
      const first = markWorkspaceTargetRemovalPending('project-a', 'wt-1');
      const settled = observe(
        whenWorkspaceTargetRemovalSettled('project-a', 'wt-1'),
      );

      first();
      const retry = markWorkspaceTargetRemovalPending('project-a', 'wt-1');
      await flush();
      expect(settled.done).toBe(false);

      retry();
      await flush();
      expect(settled.done).toBe(true);
    });

    it('releases waiters on reset', async () => {
      markWorkspaceTargetRemovalPending('project-a', 'wt-1');
      const settled = observe(
        whenWorkspaceTargetRemovalSettled('project-a', 'wt-1'),
      );

      resetWorkspaceTargetExclusionsForTests();
      await flush();

      expect(settled.done).toBe(true);
    });
  });

  it('clears every mark on reset', () => {
    markWorkspaceTargetRemovalPending('project-a', 'wt-1');

    resetWorkspaceTargetExclusionsForTests();

    expect(isWorkspaceTargetRemovalPending('project-a', 'wt-1')).toBe(false);
  });
});

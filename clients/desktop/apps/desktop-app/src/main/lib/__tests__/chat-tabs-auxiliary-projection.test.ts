import type { ChatTabsFile } from '@canopy/desktop-shared/types';
import {
  createChatTabsAuxiliaryProjectionObserver,
  type ChatTabsAuxiliaryProjectionSteps,
} from '../chat-tabs-auxiliary-projection';

const DATA: ChatTabsFile = { version: 1, tabs: [], activeTabId: '' };
const NEWER: ChatTabsFile = { version: 1, tabs: [], activeTabId: 'newer' };

interface Harness {
  steps: {
    indexSearch: jest.Mock;
    syncBadges: jest.Mock;
    syncWorkEntrySummary: jest.Mock<
      ReturnType<ChatTabsAuxiliaryProjectionSteps['syncWorkEntrySummary']>,
      Parameters<ChatTabsAuxiliaryProjectionSteps['syncWorkEntrySummary']>
    >;
    publishRuntimeStatus: jest.Mock;
    publishScope: jest.Mock;
    nudgeSummary: jest.Mock;
    logRetry: jest.Mock;
  };
  retries: Array<{ run: () => void; delayMs: number }>;
  observer: ReturnType<typeof createChatTabsAuxiliaryProjectionObserver>;
  dispose: () => void;
}

function harness(
  syncWorkEntrySummary: ChatTabsAuxiliaryProjectionSteps['syncWorkEntrySummary'],
): Harness {
  const retries: Array<{ run: () => void; delayMs: number }> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const steps = {
    indexSearch: jest.fn(),
    syncBadges: jest.fn(),
    syncWorkEntrySummary: jest.fn(syncWorkEntrySummary),
    publishRuntimeStatus: jest.fn(),
    publishScope: jest.fn(),
    nudgeSummary: jest.fn(),
    logRetry: jest.fn(),
    schedule: (
      run: () => void,
      delayMs: number,
    ): ReturnType<typeof setTimeout> => {
      retries.push({ run, delayMs });
      const timer = setTimeout(() => undefined, 60_000);
      timers.push(timer);
      return timer;
    },
  };
  return {
    steps,
    retries,
    observer: createChatTabsAuxiliaryProjectionObserver(steps),
    dispose: (): void => timers.forEach(clearTimeout),
  };
}

const settle = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

describe('createChatTabsAuxiliaryProjectionObserver', () => {
  it('publishes the scope once and retries only a failing Work Entry summary', async () => {
    let failing = true;
    const { steps, retries, observer, dispose } = harness(() =>
      failing
        ? Promise.reject(new Error('Work Entry registry unreadable'))
        : Promise.resolve(),
    );
    try {
      await expect(
        observer('workspace-1', 'entry-1', DATA, undefined, 1, () => true),
      ).resolves.toBeUndefined();
      expect(steps.publishScope).toHaveBeenCalledTimes(1);
      expect(steps.logRetry).toHaveBeenCalledTimes(1);
      expect(retries.map((retry) => retry.delayMs)).toEqual([100]);

      retries[0]?.run();
      await settle();
      expect(steps.syncWorkEntrySummary).toHaveBeenCalledTimes(2);
      expect(retries.map((retry) => retry.delayMs)).toEqual([100, 200]);
      expect(steps.nudgeSummary).not.toHaveBeenCalled();

      failing = false;
      retries[1]?.run();
      await settle();
      expect(steps.syncWorkEntrySummary).toHaveBeenCalledTimes(3);
      expect(retries).toHaveLength(2);
      // Runtime-status activity, Portal and search ran once for the commit.
      expect(steps.publishScope).toHaveBeenCalledTimes(1);
      expect(steps.indexSearch).toHaveBeenCalledTimes(1);
      expect(steps.syncBadges).toHaveBeenCalledTimes(1);
      // The sidebar listed the stale summary when the scope published.
      expect(steps.nudgeSummary).toHaveBeenCalledTimes(1);
      expect(steps.nudgeSummary).toHaveBeenCalledWith('workspace-1', 'entry-1');
      expect(steps.nudgeSummary.mock.invocationCallOrder[0]).toBeGreaterThan(
        steps.publishScope.mock.invocationCallOrder[0] ?? Infinity,
      );
    } finally {
      dispose();
    }
  });

  it('does not nudge the sidebar for a summary that landed on its first attempt', async () => {
    const { steps, observer, dispose } = harness(() => Promise.resolve());
    try {
      await observer('workspace-1', 'entry-1', DATA, undefined, 1, () => true);
      expect(steps.publishScope).toHaveBeenCalledTimes(1);
      expect(steps.nudgeSummary).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it.each(['succeeds', 'fails'] as const)(
    'keeps the newest summary and its retry when an in-flight older retry %s after a newer failure',
    async (olderOutcome) => {
      interface Attempt {
        data: ChatTabsFile;
        isCurrent: (() => boolean) | undefined;
        resolve: () => void;
        reject: (error: Error) => void;
      }
      const attempts: Attempt[] = [];
      // Mirrors the real writer's generation fence: only a current snapshot lands.
      const persisted: ChatTabsFile[] = [];
      const { steps, retries, observer, dispose } = harness(
        (_projectId, _worktreeId, data, isCurrent) =>
          new Promise<void>((resolve, reject) => {
            attempts.push({
              data,
              isCurrent,
              resolve: () => {
                if (isCurrent?.() !== false) persisted.push(data);
                resolve();
              },
              reject,
            });
          }),
      );
      let revision = 1;
      const unreadable = (): Error =>
        new Error('Work Entry registry unreadable');
      try {
        const first = observer(
          'workspace-1',
          'entry-1',
          DATA,
          undefined,
          1,
          () => revision === 1,
        );
        attempts[0]?.reject(unreadable());
        await first;
        expect(retries).toHaveLength(1);

        // The older snapshot's retry is in flight when the newer commit lands.
        retries[0]?.run();
        await settle();
        expect(attempts).toHaveLength(2);
        revision = 2;
        const second = observer(
          'workspace-1',
          'entry-1',
          NEWER,
          undefined,
          2,
          () => revision === 2,
        );
        attempts[2]?.reject(unreadable());
        await second;
        expect(retries.map((retry) => retry.delayMs)).toEqual([100, 200]);

        if (olderOutcome === 'succeeds') attempts[1]?.resolve();
        else attempts[1]?.reject(unreadable());
        await settle();
        expect(persisted).toEqual([]);
        expect(retries).toHaveLength(2);
        expect(steps.nudgeSummary).not.toHaveBeenCalled();
        expect(steps.logRetry).toHaveBeenCalledTimes(2);

        // A superseded timer firing late neither retries nor publishes.
        retries[0]?.run();
        await settle();
        expect(attempts).toHaveLength(3);

        retries[1]?.run();
        await settle();
        expect(attempts[3]?.data).toBe(NEWER);
        attempts[3]?.resolve();
        await settle();
        expect(persisted).toEqual([NEWER]);
        expect(retries).toHaveLength(2);
        expect(steps.nudgeSummary).toHaveBeenCalledTimes(1);
        expect(steps.publishScope).toHaveBeenCalledTimes(2);
        expect(steps.publishScope).toHaveBeenNthCalledWith(
          2,
          'workspace-1',
          'entry-1',
          NEWER,
          undefined,
        );
      } finally {
        dispose();
      }
    },
  );

  it('replaces a pending summary retry with the next commit for that scope', async () => {
    let revision = 1;
    const { steps, retries, observer, dispose } = harness(() =>
      Promise.reject(new Error('Work Entry registry unreadable')),
    );
    try {
      await observer(
        'workspace-1',
        'entry-1',
        DATA,
        undefined,
        1,
        () => revision === 1,
      );
      await observer(
        'workspace-1',
        'other-entry',
        DATA,
        undefined,
        1,
        () => true,
      );
      revision = 2;
      await observer(
        'workspace-1',
        'entry-1',
        NEWER,
        undefined,
        2,
        () => revision === 2,
      );
      expect(retries).toHaveLength(3);

      // The superseded retry neither runs nor republishes the older snapshot.
      retries[0]?.run();
      await settle();
      expect(steps.syncWorkEntrySummary).toHaveBeenCalledTimes(3);

      retries[1]?.run();
      retries[2]?.run();
      await settle();
      expect(
        steps.syncWorkEntrySummary.mock.calls
          .slice(3)
          .map(([, entryId, data]) => [entryId, data]),
      ).toEqual([
        ['other-entry', DATA],
        ['entry-1', NEWER],
      ]);
      // Failures keep backing off across commits instead of restarting at 100ms.
      expect(retries.map((retry) => retry.delayMs)).toEqual([
        100, 100, 200, 200, 400,
      ]);
      expect(steps.publishScope).toHaveBeenCalledTimes(3);
    } finally {
      dispose();
    }
  });

  it('drops a summary retry once its snapshot is no longer current', async () => {
    let current = true;
    const { steps, retries, observer, dispose } = harness(() =>
      Promise.reject(new Error('Work Entry registry unreadable')),
    );
    try {
      await observer(
        'workspace-1',
        'entry-1',
        DATA,
        undefined,
        1,
        () => current,
      );
      current = false;
      retries[0]?.run();
      await settle();
      expect(steps.syncWorkEntrySummary).toHaveBeenCalledTimes(1);
      expect(retries).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it('leaves a summary failure superseded by a newer commit to that commit', async () => {
    let current = true;
    const { steps, retries, observer, dispose } = harness(() => {
      current = false;
      return Promise.reject(new Error('Work Entry registry unreadable'));
    });
    try {
      await expect(
        observer('workspace-1', 'entry-1', DATA, undefined, 1, () => current),
      ).resolves.toBeUndefined();
      expect(steps.publishScope).not.toHaveBeenCalled();
      expect(retries).toHaveLength(0);
    } finally {
      dispose();
    }
  });
});

function tabs(...ids: string[]): ChatTabsFile {
  return {
    version: 1,
    activeTabId: ids[0] ?? '',
    tabs: ids.map((id) => ({
      id,
      title: id,
      createdAt: '2026-10-28T00:00:00.000Z',
      messages: [],
    })),
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('detached search, badge and Portal projections', () => {
  const summaryLands = (): Promise<void> => Promise.resolve();
  const failure = (): Error => new Error('index write failed');

  it.each([
    ['search', 'indexSearch'],
    ['badges', 'syncBadges'],
    ['Portal', 'publishScope'],
  ] as const)(
    'retries %s when it rejects after the observer returned, without re-stamping runtime status',
    async (_label, stepName) => {
      const { steps, retries, observer, dispose } = harness(summaryLands);
      const first = deferred();
      steps[stepName].mockReturnValueOnce(first.promise);
      const data = tabs('chat-a');
      const delta = { changedTabIds: ['chat-a'], removedTabIds: [] };
      const isCurrent = (): boolean => true;
      try {
        await observer('workspace-1', 'wt-1', data, delta, 1, isCurrent);
        expect(retries).toHaveLength(0);

        first.reject(failure());
        await settle();
        expect(steps.logRetry).toHaveBeenCalledTimes(1);
        expect(retries.map((retry) => retry.delayMs)).toEqual([100]);

        retries[0]?.run();
        await settle();
        expect(steps[stepName]).toHaveBeenCalledTimes(2);
        if (stepName === 'syncBadges') {
          expect(steps.syncBadges).toHaveBeenNthCalledWith(
            2,
            'workspace-1',
            'wt-1',
            data,
          );
        } else if (stepName === 'indexSearch') {
          expect(steps.indexSearch).toHaveBeenNthCalledWith(
            2,
            'workspace-1',
            'wt-1',
            data,
            delta,
            isCurrent,
          );
        } else {
          expect(steps.publishScope).toHaveBeenNthCalledWith(
            2,
            'workspace-1',
            'wt-1',
            data,
            delta,
          );
        }
        expect(retries).toHaveLength(1);
        // Only the failed step reran for the already-published commit.
        expect(steps.publishRuntimeStatus).toHaveBeenCalledTimes(1);
        for (const other of [
          'indexSearch',
          'syncBadges',
          'publishScope',
        ] as const) {
          if (other !== stepName) {
            expect(steps[other]).toHaveBeenCalledTimes(1);
          }
        }
      } finally {
        dispose();
      }
    },
  );

  it('retries a step that throws synchronously without holding back publication', async () => {
    const { steps, retries, observer, dispose } = harness(summaryLands);
    steps.indexSearch.mockImplementationOnce(() => {
      throw failure();
    });
    try {
      await observer('workspace-1', 'wt-1', tabs(), undefined, 1, () => true);
      expect(steps.publishRuntimeStatus).toHaveBeenCalledTimes(1);
      expect(steps.publishScope).toHaveBeenCalledTimes(1);
      await settle();
      expect(retries.map((retry) => retry.delayMs)).toEqual([100]);
      retries[0]?.run();
      await settle();
      expect(steps.indexSearch).toHaveBeenCalledTimes(2);
      // A failed whole-scope run retries the whole scope.
      expect(steps.indexSearch).toHaveBeenNthCalledWith(
        2,
        'workspace-1',
        'wt-1',
        tabs(),
        undefined,
        expect.any(Function),
      );
    } finally {
      dispose();
    }
  });

  it('folds a failed delta into the next commit, resolving its tabs against the newer snapshot', async () => {
    const { steps, retries, observer, dispose } = harness(summaryLands);
    steps.indexSearch.mockImplementationOnce(() => Promise.reject(failure()));
    let revision = 1;
    const newerIsCurrent = (): boolean => revision === 2;
    try {
      await observer(
        'workspace-1',
        'wt-1',
        tabs('chat-a', 'chat-c'),
        { changedTabIds: ['chat-a', 'chat-c'], removedTabIds: [] },
        1,
        () => revision === 1,
      );
      await settle();
      expect(retries).toHaveLength(1);

      // chat-c was deleted by the newer commit; chat-a is re-projected from it.
      revision = 2;
      const newer = tabs('chat-a', 'chat-b');
      await observer(
        'workspace-1',
        'wt-1',
        newer,
        { changedTabIds: ['chat-b'], removedTabIds: [] },
        2,
        newerIsCurrent,
      );
      expect(steps.indexSearch).toHaveBeenLastCalledWith(
        'workspace-1',
        'wt-1',
        newer,
        { changedTabIds: ['chat-b', 'chat-a'], removedTabIds: ['chat-c'] },
        newerIsCurrent,
      );

      // The superseded timer neither reruns the step nor reschedules.
      retries[0]?.run();
      await settle();
      expect(steps.indexSearch).toHaveBeenCalledTimes(2);
      expect(retries).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it('retries a late failure of an older run against the newest snapshot', async () => {
    const { steps, retries, observer, dispose } = harness(summaryLands);
    const older = deferred();
    steps.indexSearch.mockReturnValueOnce(older.promise);
    let revision = 1;
    const newerIsCurrent = (): boolean => revision === 2;
    try {
      await observer(
        'workspace-1',
        'wt-1',
        tabs('chat-a'),
        { changedTabIds: ['chat-a'], removedTabIds: [] },
        1,
        () => revision === 1,
      );
      revision = 2;
      const newer = tabs('chat-a', 'chat-b');
      await observer(
        'workspace-1',
        'wt-1',
        newer,
        { changedTabIds: ['chat-b'], removedTabIds: [] },
        2,
        newerIsCurrent,
      );
      await settle();
      expect(retries).toHaveLength(0);

      older.reject(failure());
      await settle();
      expect(retries).toHaveLength(1);
      retries[0]?.run();
      await settle();
      // The older snapshot is never projected again, nor its currency check.
      expect(steps.indexSearch).toHaveBeenLastCalledWith(
        'workspace-1',
        'wt-1',
        newer,
        { changedTabIds: ['chat-a'], removedTabIds: [] },
        newerIsCurrent,
      );
    } finally {
      dispose();
    }
  });

  it('leaves a retry to the next commit while its snapshot is not current', async () => {
    const { steps, retries, observer, dispose } = harness(summaryLands);
    steps.publishScope.mockImplementationOnce(() => Promise.reject(failure()));
    let current = true;
    try {
      await observer(
        'workspace-1',
        'wt-1',
        tabs(),
        { changedTabIds: [], removedTabIds: ['chat-gone'] },
        1,
        () => current,
      );
      await settle();
      current = false;
      retries[0]?.run();
      await settle();
      expect(steps.publishScope).toHaveBeenCalledTimes(1);
      expect(retries).toHaveLength(1);

      // The next commit still carries the removal the failed run lost.
      await observer(
        'workspace-1',
        'wt-1',
        tabs('chat-new'),
        { changedTabIds: ['chat-new'], removedTabIds: [] },
        2,
        () => true,
      );
      expect(steps.publishScope).toHaveBeenLastCalledWith(
        'workspace-1',
        'wt-1',
        tabs('chat-new'),
        { changedTabIds: ['chat-new'], removedTabIds: ['chat-gone'] },
      );
    } finally {
      dispose();
    }
  });

  it('backs off across repeated failures and starts over once a retry lands', async () => {
    const { steps, retries, observer, dispose } = harness(summaryLands);
    steps.syncBadges
      .mockImplementationOnce(() => Promise.reject(failure()))
      .mockImplementationOnce(() => Promise.reject(failure()))
      .mockImplementationOnce(() => Promise.resolve())
      .mockImplementationOnce(() => Promise.reject(failure()));
    try {
      await observer('workspace-1', 'wt-1', tabs(), undefined, 1, () => true);
      await settle();
      retries[0]?.run();
      await settle();
      retries[1]?.run();
      await settle();
      expect(retries.map((retry) => retry.delayMs)).toEqual([100, 200]);

      await observer('workspace-1', 'wt-1', tabs(), undefined, 2, () => true);
      await settle();
      expect(retries.map((retry) => retry.delayMs)).toEqual([100, 200, 100]);
    } finally {
      dispose();
    }
  });

  it('counts one failure for commits coalesced into the same failed run', async () => {
    const { steps, retries, observer, dispose } = harness(summaryLands);
    // The search debounce settles every coalesced commit with one rejection.
    const shared = deferred();
    steps.indexSearch.mockReturnValue(shared.promise);
    let revision = 0;
    try {
      for (const id of ['chat-a', 'chat-b', 'chat-c']) {
        revision += 1;
        const current = revision;
        await observer(
          'workspace-1',
          'wt-1',
          tabs('chat-a', 'chat-b', 'chat-c'),
          { changedTabIds: [id], removedTabIds: [] },
          current,
          () => revision === current,
        );
      }
      shared.reject(failure());
      await settle();
      expect(steps.logRetry).toHaveBeenCalledTimes(1);
      expect(retries.map((retry) => retry.delayMs)).toEqual([100]);

      steps.indexSearch.mockReturnValueOnce(Promise.reject(failure()));
      retries[0]?.run();
      await settle();
      expect(steps.indexSearch).toHaveBeenLastCalledWith(
        'workspace-1',
        'wt-1',
        tabs('chat-a', 'chat-b', 'chat-c'),
        { changedTabIds: ['chat-a', 'chat-b', 'chat-c'], removedTabIds: [] },
        expect.any(Function),
      );
      // The second attempt backs off one step, not one per coalesced commit.
      expect(retries.map((retry) => retry.delayMs)).toEqual([100, 200]);
    } finally {
      dispose();
    }
  });

  it('backs off and logs each attempt when a failed worker rejects every one with the same error', async () => {
    const { steps, retries, observer, dispose } = harness(summaryLands);
    // A failed index worker rejects every later request with its one failure.
    const workerFailure = failure();
    steps.indexSearch.mockImplementation(() => Promise.reject(workerFailure));
    try {
      await observer(
        'workspace-1',
        'wt-1',
        tabs('chat-a'),
        { changedTabIds: ['chat-a'], removedTabIds: [] },
        1,
        () => true,
      );
      await settle();
      retries[0]?.run();
      await settle();
      retries[1]?.run();
      await settle();
      expect(retries.map((retry) => retry.delayMs)).toEqual([100, 200, 400]);
      expect(steps.logRetry).toHaveBeenCalledTimes(3);
    } finally {
      dispose();
    }
  });

  it('keeps one scope failure from retrying or delaying another scope', async () => {
    const { steps, retries, observer, dispose } = harness(summaryLands);
    steps.indexSearch.mockImplementation((_projectId, worktreeId) =>
      worktreeId === 'wt-failing' ? Promise.reject(failure()) : undefined,
    );
    try {
      await observer(
        'workspace-1',
        'wt-failing',
        tabs('chat-a'),
        { changedTabIds: ['chat-a'], removedTabIds: [] },
        1,
        () => true,
      );
      await observer(
        'workspace-1',
        'wt-healthy',
        tabs('chat-b'),
        { changedTabIds: ['chat-b'], removedTabIds: [] },
        1,
        () => true,
      );
      await settle();
      expect(steps.publishScope).toHaveBeenCalledTimes(2);
      expect(retries).toHaveLength(1);
      retries[0]?.run();
      await settle();
      expect(steps.indexSearch).toHaveBeenCalledTimes(3);
      expect(steps.indexSearch).toHaveBeenLastCalledWith(
        'workspace-1',
        'wt-failing',
        tabs('chat-a'),
        { changedTabIds: ['chat-a'], removedTabIds: [] },
        expect.any(Function),
      );
    } finally {
      dispose();
    }
  });
});

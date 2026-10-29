import {
  BACKGROUND_HELPER_PRIORITIES,
  backgroundHelperQueueTestExports,
  enqueueBackgroundHelperTask,
  shutdownBackgroundHelperQueue,
} from '../background-helper-queue';

describe('background helper queue', () => {
  beforeEach(() => {
    backgroundHelperQueueTestExports.reset();
  });

  it('serializes helpers and prioritizes pending work', async () => {
    const order: string[] = [];
    let releaseRunning: (() => void) | undefined;
    const running = enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.chatMetadata,
      task: async () => {
        order.push('running:start');
        await new Promise<void>((resolve) => {
          releaseRunning = resolve;
        });
        order.push('running:end');
      },
    });
    await Promise.resolve();

    const summary = enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.worktreeSummary,
      task: () => {
        order.push('summary');
        return Promise.resolve();
      },
    });
    const consolidation = enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.memoryConsolidation,
      task: () => {
        order.push('consolidation');
        return Promise.resolve();
      },
    });
    const memoryImport = enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.memoryImport,
      task: () => {
        order.push('memory-import');
        return Promise.resolve();
      },
    });
    const metadata = enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.chatMetadata,
      task: () => {
        order.push('metadata');
        return Promise.resolve();
      },
    });
    const branch = enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.branchNaming,
      task: () => {
        order.push('branch');
        return Promise.resolve();
      },
    });

    releaseRunning?.();
    await Promise.all([
      running,
      summary,
      consolidation,
      memoryImport,
      metadata,
      branch,
    ]);

    expect(order).toEqual([
      'running:start',
      'running:end',
      'branch',
      'metadata',
      'summary',
      'consolidation',
      'memory-import',
    ]);
  });

  it('continues after a rejected helper', async () => {
    const later = jest.fn(() => Promise.resolve());
    const failed = enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.branchNaming,
      task: () => Promise.reject(new Error('failed')),
    });
    const succeeded = enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.chatMetadata,
      task: later,
    });

    await expect(failed).rejects.toThrow('failed');
    await expect(succeeded).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('rejects queued and future helpers when shutdown begins', async () => {
    const queuedTask = jest.fn(() => Promise.resolve());
    const queued = enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.branchNaming,
      task: queuedTask,
    });

    shutdownBackgroundHelperQueue();

    await expect(queued).rejects.toThrow(
      'Background helper queue is shutting down',
    );
    await expect(
      enqueueBackgroundHelperTask({
        priority: BACKGROUND_HELPER_PRIORITIES.branchNaming,
        task: queuedTask,
      }),
    ).rejects.toThrow('Background helper queue is shutting down');
    await Promise.resolve();
    expect(queuedTask).not.toHaveBeenCalled();
  });
});

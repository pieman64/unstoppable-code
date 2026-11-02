import type { AppAdvisorWatcher } from '@canopy/desktop-shared/types';
import {
  LocalWatcherScheduler,
  WatcherRecipientNotReadyError,
} from '../app-advisor/local-watcher-scheduler';
import type { runWatcherCommand } from '../app-advisor/local-watcher-command';

describe('local watcher scheduler', () => {
  let rows: AppAdvisorWatcher[];
  let scheduler: LocalWatcherScheduler;
  const deliver = jest.fn<Promise<void>, [AppAdvisorWatcher, unknown, string]>(
    () => Promise.resolve(),
  );
  const run = jest.fn<
    ReturnType<typeof runWatcherCommand>,
    Parameters<typeof runWatcherCommand>
  >(() =>
    Promise.resolve({
      exitCode: 0,
      signal: null,
      output: {
        kind: 'inline' as const,
        text: 'done',
        byteSize: 4,
        lineCount: 1,
        complete: true,
      },
    }),
  );
  beforeEach(() => {
    jest.useFakeTimers();
    deliver.mockClear();
    run.mockReset();
    rows = [
      {
        version: 1,
        id: 'one',
        trigger: 'scheduled_wakeup',
        target: {
          kind: 'scheduled_wakeup',
          delaySeconds: 60,
          scheduledFor: new Date(Date.now() + 60_000).toISOString(),
        },
        destination: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
        status: 'active',
        label: 'Wake',
        createdAt: '',
        updatedAt: '',
        dedupeKey: 'one',
        runtimeState: {
          kind: 'local_watcher',
          attempts: 0,
          nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    ];
    scheduler = new LocalWatcherScheduler({
      list: (): Promise<AppAdvisorWatcher[]> =>
        Promise.resolve(rows.map((row) => structuredClone(row))),
      update: (
        id: string,
        mutate: (watcher: AppAdvisorWatcher) => void,
      ): Promise<AppAdvisorWatcher | undefined> => {
        const row = rows.find((row) => row.id === id);
        if (row) mutate(row);
        return Promise.resolve(row ? structuredClone(row) : undefined);
      },
      deliver,
      run,
      outputPath: (): Promise<string> => Promise.resolve('/unused/result.log'),
    });
  });
  afterEach(() => {
    scheduler.stop();
    jest.useRealTimers();
  });
  it('does not wake early and persists its outbox before delivery', async () => {
    deliver.mockImplementationOnce(() => {
      const state = rows[0].runtimeState;
      if (state?.kind !== 'local_watcher' || !state.pendingDelivery) {
        throw new Error('Expected a pending local watcher delivery.');
      }
      expect(typeof state.pendingDelivery.eventId).toBe('string');
      expect(rows[0].runtimeState).toMatchObject({
        pendingDelivery: {
          event: { outcome: 'success' },
        },
      });
      return Promise.resolve();
    });
    await scheduler.start();
    await jest.advanceTimersByTimeAsync(59_999);
    expect(deliver).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(rows[0].status).toBe('fired');
    await jest.advanceTimersByTimeAsync(120_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('retries exit 1 after the interval and reports exhaustion with final output', async () => {
    rows[0].trigger = 'command_watch_resolved';
    rows[0].target = {
      kind: 'command_watch',
      command: 'test -f ready',
      cwd: '/tmp',
      intervalSeconds: 5,
      maxAttempts: 2,
    };
    run.mockResolvedValue({
      exitCode: 1,
      signal: null,
      output: {
        kind: 'inline',
        text: 'done',
        byteSize: 4,
        lineCount: 1,
        complete: true,
      },
    });
    await scheduler.start();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(4999);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(rows[0].runtimeState).toMatchObject({
      pendingDelivery: {
        event: {
          outcome: 'failure',
          reason: 'max_attempts',
          attempts: 2,
          output: { text: 'done' },
        },
      },
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'one' }),
      expect.objectContaining({ reason: 'max_attempts' }),
      expect.any(String),
    );
    expect(rows[0].status).toBe('fired');
  });

  it('does not execute a command after its approved scope disappears', async () => {
    scheduler.stop();
    rows[0].trigger = 'command_watch_resolved';
    rows[0].target = {
      kind: 'command_watch',
      command: 'probe',
      cwd: '/tmp',
      intervalSeconds: 5,
      maxAttempts: 1,
    };
    rows[0].runtimeState = {
      kind: 'local_watcher',
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
    };
    scheduler = new LocalWatcherScheduler({
      list: (): Promise<AppAdvisorWatcher[]> =>
        Promise.resolve(structuredClone(rows)),
      update: (
        id: string,
        mutate: (watcher: AppAdvisorWatcher) => void,
      ): Promise<AppAdvisorWatcher | undefined> => {
        const row = rows.find((row) => row.id === id);
        if (row) mutate(row);
        return Promise.resolve(row ? structuredClone(row) : undefined);
      },
      run,
      deliver,
      outputPath: (): Promise<string> => Promise.resolve('/unused/result.log'),
      validateExecutionScope: (): Promise<boolean> => Promise.resolve(false),
    });

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(1);

    expect(run).not.toHaveBeenCalled();
    expect(rows[0].runtimeState).toMatchObject({
      attempts: 0,
      pendingDelivery: {
        event: { outcome: 'failure', reason: 'execution_scope_unavailable' },
      },
    });
  });
  it('reuses the durable delivery ID after a failed delivery', async () => {
    deliver.mockRejectedValueOnce(new Error('window unavailable'));
    await scheduler.start();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(rows[0].status).toBe('firing');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0][2]).toBe(deliver.mock.calls[1][2]);
  });
  it('keeps a delegate wakeup pending without spending attempts until its recipient loads', async () => {
    rows[0].destination = {
      projectId: 'p',
      worktreeId: 'w',
      chatId: 'c',
      delegationId: 'recipient',
    };
    deliver.mockRejectedValue(new WatcherRecipientNotReadyError());
    await scheduler.start();
    await jest.advanceTimersByTimeAsync(60_000);
    // More not-ready deliveries than the four-attempt failure budget.
    for (let attempt = 0; attempt < 6; attempt++)
      await jest.advanceTimersByTimeAsync(5_000);
    expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(rows[0]).toMatchObject({
      status: 'firing',
      runtimeState: { pendingDelivery: { attempts: 0 } },
    });
    expect(rows[0].deliveryError).toBeUndefined();
    deliver.mockResolvedValue(undefined);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(rows[0].status).toBe('fired');
    expect(new Set(deliver.mock.calls.map(([, , id]) => id)).size).toBe(1);
  });
  it('does not refund an interrupted last attempt after restart', async () => {
    rows[0].trigger = 'command_watch_resolved';
    rows[0].target = {
      kind: 'command_watch',
      command: 'test -f ready',
      cwd: '/tmp',
      intervalSeconds: 5,
      maxAttempts: 1,
    };
    rows[0].runtimeState = {
      kind: 'local_watcher',
      running: true,
      attempts: 1,
      nextAttemptAt: new Date().toISOString(),
    };
    await scheduler.start();
    await jest.advanceTimersByTimeAsync(1);
    expect(run).not.toHaveBeenCalled();
    expect(rows[0].runtimeState).toMatchObject({
      pendingDelivery: { event: { outcome: 'failure', reason: 'interrupted' } },
    });
  });

  it('caps simultaneous commands and cancels an in-flight attempt before returning', async () => {
    const resolvers: Array<() => void> = [];
    run.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(() =>
            resolve({
              exitCode: 0,
              signal: null,
              output: {
                kind: 'inline',
                text: 'done',
                byteSize: 4,
                lineCount: 1,
                complete: true,
              },
            }),
          );
        }),
    );
    rows = Array.from({ length: 5 }, (_, i) => ({
      ...structuredClone(rows[0]),
      id: `command-${i}`,
      trigger: 'command_watch_resolved',
      target: {
        kind: 'command_watch',
        command: 'probe',
        cwd: '/tmp',
        intervalSeconds: 5,
        maxAttempts: 1,
      },
      runtimeState: {
        kind: 'local_watcher',
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
      },
    }));
    await scheduler.start();
    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(4);
    let cancelled = false;
    const cancel = scheduler.cancel('command-0').then(() => {
      cancelled = true;
    });
    await Promise.resolve();
    expect(cancelled).toBe(false);
    resolvers[0]();
    await cancel;
    expect(cancelled).toBe(true);
    rows = rows.filter((row) => row.id !== 'command-0');
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(5);
    for (const resolve of resolvers.slice(1)) resolve();
    await jest.advanceTimersByTimeAsync(1);
  });

  it('surfaces process termination failures to cancel and drain callers', async () => {
    rows[0].trigger = 'command_watch_resolved';
    rows[0].target = {
      kind: 'command_watch',
      command: 'probe',
      cwd: '/tmp',
      intervalSeconds: 5,
      maxAttempts: 1,
    };
    rows[0].runtimeState = {
      kind: 'local_watcher',
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
    };
    run.mockImplementationOnce(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('process tree termination failed')),
            { once: true },
          );
        }),
    );

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(1);
    const cancel = scheduler.cancel('one');
    const drain = scheduler.drain();

    await expect(cancel).rejects.toThrow('process tree termination failed');
    await expect(drain).rejects.toThrow('process tree termination failed');
  });

  it('waits for every watcher task before surfacing a drain failure', async () => {
    rows = Array.from({ length: 2 }, (_, index) => ({
      ...structuredClone(rows[0]),
      id: `command-${index}`,
      trigger: 'command_watch_resolved',
      target: {
        kind: 'command_watch',
        command: 'probe',
        cwd: '/tmp',
        intervalSeconds: 5,
        maxAttempts: 1,
      },
      runtimeState: {
        kind: 'local_watcher',
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
      },
    }));
    const firstFailure = new Error('first termination failed');
    const secondFailure = new Error('second termination failed');
    let rejectSecond: ((error: Error) => void) | undefined;
    run
      .mockImplementationOnce(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(firstFailure), {
              once: true,
            });
          }),
      )
      .mockImplementationOnce(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                rejectSecond = reject;
              },
              { once: true },
            );
          }),
      );

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    let drainSettled = false;
    const drainOutcome = scheduler.drain().then(
      () => undefined,
      (error: unknown) => {
        drainSettled = true;
        return error;
      },
    );
    scheduler.stop();
    for (let index = 0; index < 10; index++) await Promise.resolve();

    expect(drainSettled).toBe(false);
    if (!rejectSecond) throw new Error('Expected the second task to abort.');
    rejectSecond(secondFailure);
    await expect(drainOutcome).resolves.toEqual(
      expect.objectContaining({
        failures: [firstFailure, secondFailure],
      }),
    );
    expect(drainSettled).toBe(true);
  });

  it('recovers a checkpointed terminal result without spending another command attempt', async () => {
    scheduler.stop();
    rows[0].trigger = 'command_watch_resolved';
    rows[0].target = {
      kind: 'command_watch',
      command: 'probe',
      cwd: '/tmp',
      intervalSeconds: 5,
      maxAttempts: 1,
    };
    rows[0].runtimeState = {
      kind: 'local_watcher',
      attempts: 1,
      running: true,
      nextAttemptAt: new Date().toISOString(),
    };
    scheduler = new LocalWatcherScheduler({
      list: (): Promise<AppAdvisorWatcher[]> =>
        Promise.resolve(structuredClone(rows)),
      update: (id, mutate): Promise<AppAdvisorWatcher | undefined> => {
        const row = rows.find((row) => row.id === id);
        if (row) mutate(row);
        return Promise.resolve(row ? structuredClone(row) : undefined);
      },
      run,
      deliver,
      outputPath: (): Promise<string> => Promise.resolve('/unused/result.log'),
      recover: (): ReturnType<
        NonNullable<
          ConstructorParameters<typeof LocalWatcherScheduler>[0]['recover']
        >
      > =>
        Promise.resolve({
          exitCode: 0,
          signal: null,
          output: {
            kind: 'inline',
            text: 'recovered',
            byteSize: 9,
            lineCount: 1,
            complete: true,
          },
        }),
    });
    await scheduler.start();
    await jest.advanceTimersByTimeAsync(1);
    expect(run).not.toHaveBeenCalled();
    expect(rows[0].runtimeState).toMatchObject({
      attempts: 1,
      pendingDelivery: {
        event: { outcome: 'success', output: { text: 'recovered' } },
      },
    });
  });

  it('reports a damaged result checkpoint without re-executing the command', async () => {
    scheduler.stop();
    rows[0].trigger = 'command_watch_resolved';
    rows[0].target = {
      kind: 'command_watch',
      command: 'probe',
      cwd: '/tmp',
      intervalSeconds: 5,
      maxAttempts: 2,
    };
    rows[0].runtimeState = {
      kind: 'local_watcher',
      attempts: 1,
      running: true,
      nextAttemptAt: new Date().toISOString(),
    };
    scheduler = new LocalWatcherScheduler({
      list: (): Promise<AppAdvisorWatcher[]> =>
        Promise.resolve(structuredClone(rows)),
      update: (id, mutate): Promise<AppAdvisorWatcher | undefined> => {
        const row = rows.find((row) => row.id === id);
        if (row) mutate(row);
        return Promise.resolve(row ? structuredClone(row) : undefined);
      },
      run,
      deliver,
      outputPath: (): Promise<string> => Promise.resolve('/unused/result.log'),
      recover: (): Promise<never> =>
        Promise.reject(new Error('Invalid checkpoint')),
    });
    await scheduler.start();
    await jest.advanceTimersByTimeAsync(2000);
    expect(run).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(rows[0].runtimeState).toMatchObject({
      pendingDelivery: {
        event: {
          outcome: 'failure',
          reason: 'recovery_error: Invalid checkpoint',
        },
      },
    });
  });
});

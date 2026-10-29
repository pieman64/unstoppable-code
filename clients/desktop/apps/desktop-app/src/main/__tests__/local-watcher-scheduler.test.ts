import type { AppAdvisorWatcher } from '@canopy/desktop-shared/types';
import type { DelegateWatchEvent } from '@canopy/protocol/delegation';
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
  it('keeps a delegate notification pending until its recipient loads', async () => {
    const deadlineAt = Date.now() - 1;
    rows = [
      {
        version: 1,
        id: 'delegate-pending',
        trigger: 'managed_delegation_completion',
        target: {
          kind: 'managed_delegation',
          projectId: 'p',
          worktreeId: 'w',
          mode: 'all',
          deadlineAt,
          targetCount: 1,
          recipient: 'delegate',
        },
        destination: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
        status: 'firing',
        label: 'Delegate completion',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        dedupeKey: 'delegate-pending',
        runtimeState: {
          kind: 'managed_delegation',
          nextAttemptAt: new Date().toISOString(),
          requestHash: 'hash',
          invocationKey: 'invocation',
          recipient: { kind: 'delegate', delegationId: 'recipient' },
          targets: [
            {
              delegationId: 'delegate-a',
              runGeneration: 1,
              status: 'completed',
              resultIndex: 1,
            },
          ],
          pendingDelivery: {
            eventId: 'durable-delivery',
            attempts: 0,
            event: {
              watcherId: 'delegate-pending',
              mode: 'all',
              outcome: 'completed',
              deadlineAt,
              targets: [
                {
                  delegationId: 'delegate-a',
                  runGeneration: 1,
                  status: 'completed',
                  resultIndex: 1,
                },
              ],
            },
          },
        },
      } satisfies AppAdvisorWatcher,
    ];
    deliver.mockRejectedValue(new WatcherRecipientNotReadyError());
    await scheduler.start();
    for (let attempt = 0; attempt < 5; attempt++)
      await jest.advanceTimersByTimeAsync(5_000);
    expect(rows[0]).toMatchObject({
      status: 'firing',
      runtimeState: { pendingDelivery: { attempts: 0 } },
    });
    deliver.mockResolvedValue(undefined);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(rows[0].status).toBe('fired');
    expect(
      deliver.mock.calls.every(([, , id]) => id === 'durable-delivery'),
    ).toBe(true);
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

  it('reconciles an overdue managed-delegation watch through the shared scheduler after restart', async () => {
    scheduler.stop();
    const event = {
      watcherId: 'delegate-watch',
      outcome: 'timeout' as const,
      mode: 'all' as const,
      deadlineAt: Date.now() - 1,
      targets: [
        {
          delegationId: 'delegate-a',
          runGeneration: 3,
          status: 'running' as const,
          resultIndex: null,
        },
      ],
    };
    rows = [
      {
        version: 1,
        id: 'delegate-watch',
        trigger: 'managed_delegation_completion',
        target: {
          kind: 'managed_delegation',
          projectId: 'p',
          worktreeId: 'w',
          mode: 'all',
          deadlineAt: event.deadlineAt,
          targetCount: 1,
          recipient: 'root',
        },
        destination: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
        status: 'active',
        label: 'Delegate completion',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        dedupeKey: 'delegate-watch',
        runtimeState: {
          kind: 'managed_delegation',
          nextAttemptAt: new Date(event.deadlineAt).toISOString(),
          requestHash: 'hash',
          invocationKey: 'invocation',
          recipient: { kind: 'root' },
          targets: event.targets,
        },
      } satisfies AppAdvisorWatcher,
    ];
    const evaluateManagedDelegation = jest.fn<
      Promise<typeof event>,
      [AppAdvisorWatcher]
    >(() => Promise.resolve(event));
    scheduler = new LocalWatcherScheduler({
      list: (): Promise<AppAdvisorWatcher[]> =>
        Promise.resolve(structuredClone(rows)),
      update: (
        id: string,
        mutate: (watcher: AppAdvisorWatcher) => void,
      ): Promise<AppAdvisorWatcher | undefined> => {
        const row = rows.find((candidate) => candidate.id === id);
        if (row) mutate(row);
        return Promise.resolve(row ? structuredClone(row) : undefined);
      },
      run,
      deliver,
      outputPath: (): Promise<string> => Promise.resolve('/unused/result.log'),
      evaluateManagedDelegation,
    } satisfies ConstructorParameters<typeof LocalWatcherScheduler>[0]);

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(1);

    expect(evaluateManagedDelegation).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'delegate-watch', status: 'firing' }),
      event,
      expect.any(String),
    );
    expect(rows[0].status).toBe('fired');
  });

  it('checks a managed-delegation watch immediately after restart even when its deadline is still in the future', async () => {
    scheduler.stop();
    const deadlineAt = Date.now() + 60_000;
    const event = {
      watcherId: 'delegate-watch',
      outcome: 'completed' as const,
      mode: 'any' as const,
      deadlineAt,
      targets: [
        {
          delegationId: 'delegate-a',
          runGeneration: 3,
          status: 'completed' as const,
          resultIndex: 3,
        },
      ],
    };
    rows = [
      {
        version: 1,
        id: 'delegate-watch',
        trigger: 'managed_delegation_completion',
        target: {
          kind: 'managed_delegation',
          projectId: 'p',
          worktreeId: 'w',
          mode: 'any',
          deadlineAt,
          targetCount: 1,
          recipient: 'root',
        },
        destination: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
        status: 'active',
        label: 'Delegate completion',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        dedupeKey: 'delegate-watch',
        runtimeState: {
          kind: 'managed_delegation',
          nextAttemptAt: new Date(deadlineAt).toISOString(),
          requestHash: 'hash',
          invocationKey: 'invocation',
          recipient: { kind: 'root' },
          targets: event.targets,
        },
      } satisfies AppAdvisorWatcher,
    ];
    const evaluateManagedDelegation = jest.fn<
      Promise<typeof event>,
      [AppAdvisorWatcher]
    >(() => Promise.resolve(event));
    scheduler = new LocalWatcherScheduler({
      list: (): Promise<AppAdvisorWatcher[]> =>
        Promise.resolve(structuredClone(rows)),
      update: (
        id: string,
        mutate: (watcher: AppAdvisorWatcher) => void,
      ): Promise<AppAdvisorWatcher | undefined> => {
        const row = rows.find((candidate) => candidate.id === id);
        if (row) mutate(row);
        return Promise.resolve(row ? structuredClone(row) : undefined);
      },
      run,
      deliver,
      outputPath: (): Promise<string> => Promise.resolve('/unused/result.log'),
      evaluateManagedDelegation,
    } satisfies ConstructorParameters<typeof LocalWatcherScheduler>[0]);

    await scheduler.start();
    await jest.advanceTimersByTimeAsync(1);

    expect(evaluateManagedDelegation).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(rows[0].status).toBe('fired');
  });

  it('does not commit a timeout evaluated before a qualifying settlement', async () => {
    scheduler.stop();
    const deadlineAt = Date.now() - 1;
    const row: AppAdvisorWatcher = {
      version: 1,
      id: 'delegate-race',
      trigger: 'managed_delegation_completion',
      target: {
        kind: 'managed_delegation',
        projectId: 'p',
        worktreeId: 'w',
        mode: 'all',
        deadlineAt,
        targetCount: 1,
        recipient: 'root',
      },
      destination: { projectId: 'p', worktreeId: 'w', chatId: 'c' },
      status: 'active',
      label: 'Delegate completion',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dedupeKey: 'delegate-race',
      runtimeState: {
        kind: 'managed_delegation',
        nextAttemptAt: new Date(deadlineAt).toISOString(),
        requestHash: 'hash',
        invocationKey: 'invocation',
        recipient: { kind: 'root' },
        targets: [
          {
            delegationId: 'delegate-a',
            runGeneration: 3,
            status: 'running',
            resultIndex: null,
          },
        ],
      },
    };
    rows = [row];
    let evaluations = 0;
    const evaluateManagedDelegation = jest.fn(
      (watcher: AppAdvisorWatcher): Promise<DelegateWatchEvent> => {
        evaluations++;
        if (
          evaluations === 1 &&
          row.runtimeState?.kind === 'managed_delegation'
        ) {
          row.runtimeState.targets[0].status = 'completed';
          row.runtimeState.targets[0].resultIndex = 1;
          row.runtimeState.targets[0].settledAt = deadlineAt;
        }
        if (watcher.runtimeState?.kind !== 'managed_delegation')
          throw new Error('Expected managed watcher');
        return Promise.resolve({
          watcherId: row.id,
          outcome:
            evaluations === 1 ? ('timeout' as const) : ('completed' as const),
          mode: 'all' as const,
          deadlineAt,
          targets: watcher.runtimeState.targets,
        });
      },
    );
    scheduler = new LocalWatcherScheduler({
      list: (): Promise<AppAdvisorWatcher[]> =>
        Promise.resolve(structuredClone(rows)),
      update: (id, mutate): Promise<AppAdvisorWatcher | undefined> => {
        const current = rows.find((candidate) => candidate.id === id);
        if (current) mutate(current);
        return Promise.resolve(current ? structuredClone(current) : undefined);
      },
      run,
      deliver,
      outputPath: (): Promise<string> => Promise.resolve('/unused/result.log'),
      evaluateManagedDelegation,
    });
    await scheduler.start();
    await jest.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'completed' }),
      expect.any(String),
    );
  });

  it('replaces a pending managed timeout when settlement arrives before delivery', async () => {
    const deadlineAt = Date.now() - 1;
    const row: AppAdvisorWatcher = {
      ...rows[0],
      id: 'delegate-pending-race',
      trigger: 'managed_delegation_completion',
      target: {
        kind: 'managed_delegation',
        projectId: 'p',
        worktreeId: 'w',
        mode: 'all',
        deadlineAt,
        targetCount: 1,
        recipient: 'root',
        outcome: 'timeout',
      },
      status: 'firing',
      runtimeState: {
        kind: 'managed_delegation',
        nextAttemptAt: new Date(deadlineAt).toISOString(),
        requestHash: 'hash',
        invocationKey: 'invocation',
        recipient: { kind: 'root' },
        targets: [
          {
            delegationId: 'delegate-a',
            runGeneration: 1,
            status: 'running',
            resultIndex: null,
          },
        ],
        pendingDelivery: {
          eventId: 'pending-id',
          attempts: 0,
          event: {
            watcherId: 'delegate-pending-race',
            outcome: 'timeout',
            mode: 'all',
            deadlineAt,
            targets: [
              {
                delegationId: 'delegate-a',
                runGeneration: 1,
                status: 'running',
                resultIndex: null,
              },
            ],
          },
        },
      },
    };
    rows = [row];
    scheduler = new LocalWatcherScheduler({
      list: (): Promise<AppAdvisorWatcher[]> =>
        Promise.resolve(structuredClone(rows)),
      update: (id, mutate): Promise<AppAdvisorWatcher | undefined> => {
        const current = rows.find((candidate) => candidate.id === id);
        if (current) {
          if (current.runtimeState?.kind === 'managed_delegation') {
            current.runtimeState.targets[0].status = 'completed';
            current.runtimeState.targets[0].resultIndex = 1;
            current.runtimeState.targets[0].settledAt = deadlineAt;
          }
          mutate(current);
        }
        return Promise.resolve(current ? structuredClone(current) : undefined);
      },
      run,
      deliver,
      outputPath: (): Promise<string> => Promise.resolve('/unused/result.log'),
    });
    await scheduler.start();
    await jest.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'completed' }),
      'pending-id',
    );
  });
});

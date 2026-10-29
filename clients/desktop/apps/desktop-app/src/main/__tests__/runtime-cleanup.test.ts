import {
  DRAINED_PROCESS_EXIT_DEADLINE_MS,
  DrainedProcessExitGuard,
  RuntimeCleanupStages,
  settleBestEffortCleanup,
  type RuntimeCleanupDiagnostic,
} from '../lifecycle/runtime-cleanup';

describe('settleBestEffortCleanup', () => {
  it('lets later teardown continue when a best-effort cleanup rejects', async () => {
    const laterCleanup = jest.fn();

    await settleBestEffortCleanup(Promise.reject(new Error('drain failed')));
    laterCleanup();

    expect(laterCleanup).toHaveBeenCalledTimes(1);
  });
});

// Shutdown deadlines apply only to ancillary services. A delayed durable write
// must keep the app alive until it finishes, while still identifying the wait.
describe('RuntimeCleanupStages', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('bounds an ancillary teardown that never settles and permits later cleanup', async () => {
    const report = jest.fn<void, [RuntimeCleanupDiagnostic]>();
    const stages = new RuntimeCleanupStages(report, 'app-quit');
    const later = jest.fn();
    const shutdown = stages.bestEffort(
      'mcp-proxy',
      () => new Promise(() => undefined),
    );
    await jest.advanceTimersByTimeAsync(5_000);
    await shutdown;
    await stages.run('preferences', later);
    expect(later).toHaveBeenCalledTimes(1);
    expect(
      report.mock.calls.map(([event]) => [
        event.cleanupStage,
        event.cleanupStatus,
      ]),
    ).toEqual([
      ['mcp-proxy', 'started'],
      ['mcp-proxy', 'timed_out'],
      ['preferences', 'started'],
      ['preferences', 'completed'],
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports a stalled durable drain without bypassing it', async () => {
    const report = jest.fn<void, [RuntimeCleanupDiagnostic]>();
    const stages = new RuntimeCleanupStages(report, 'app-quit');
    let finish: (() => void) | undefined;
    let finished = false;
    const pending = stages
      .run(
        'chat-state',
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .then(() => {
        finished = true;
      });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(finished).toBe(false);
    expect(report.mock.calls.map(([event]) => event.cleanupStatus)).toEqual([
      'started',
      'stalled',
    ]);
    finish?.();
    await pending;
    expect(finished).toBe(true);
    expect(report.mock.calls.at(-1)?.[0]).toMatchObject({
      cleanupStage: 'chat-state',
      cleanupStatus: 'completed',
      cleanupElapsedMs: 30_000,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retains a required failure and clears its watchdog', async () => {
    const report = jest.fn<void, [RuntimeCleanupDiagnostic]>();
    const stages = new RuntimeCleanupStages(report, 'fatal-exit');
    const failure = new Error(
      'do not copy raw private details into diagnostics',
    );
    await expect(
      stages.run('recovery', () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(report.mock.calls.map(([event]) => event.cleanupStatus)).toEqual([
      'started',
      'failed',
    ]);
    expect(JSON.stringify(report.mock.calls)).not.toContain(failure.message);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('handles rejection after an ancillary timeout without a second terminal event', async () => {
    const report = jest.fn<void, [RuntimeCleanupDiagnostic]>();
    const stages = new RuntimeCleanupStages(report, 'app-quit');
    let reject: ((error: Error) => void) | undefined;
    const pending = stages.bestEffort(
      'gateway-proxy',
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    await jest.advanceTimersByTimeAsync(5_000);
    await pending;
    reject?.(new Error('late failure'));
    await Promise.resolve();
    expect(report.mock.calls.map(([event]) => event.cleanupStatus)).toEqual([
      'started',
      'timed_out',
    ]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps cleanup independent of a diagnostic sink failure', async () => {
    const stages = new RuntimeCleanupStages(() => {
      throw new Error('sink failed');
    }, 'app-quit');
    await expect(
      stages.run('preferences', () => Promise.resolve(42)),
    ).resolves.toBe(42);
    await stages.bestEffort('mcp-proxy', () =>
      Promise.reject(new Error('optional failure')),
    );
    expect(jest.getTimerCount()).toBe(0);
  });
});

// After chat state drains the process cannot save work or serve chats, so a
// later stage that never settles, or a quit that never happens, must not leave
// it running until the user force quits.
describe('DrainedProcessExitGuard', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('never forces an exit before chat state has drained', async () => {
    const exit = jest.fn();
    const guard = new DrainedProcessExitGuard({ exit, report: jest.fn() });
    await jest.advanceTimersByTimeAsync(DRAINED_PROCESS_EXIT_DEADLINE_MS * 10);
    expect(guard.handleRepeatedQuit()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits once the post-drain deadline passes', async () => {
    const exit = jest.fn();
    const report = jest.fn<void, [RuntimeCleanupDiagnostic]>();
    const guard = new DrainedProcessExitGuard({ exit, report });
    guard.markDrained();
    await jest.advanceTimersByTimeAsync(DRAINED_PROCESS_EXIT_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'runtime_cleanup_stage',
        cleanupStage: 'drained-exit',
        cleanupStatus: 'timed_out',
      }),
    );
  });

  it('lets the post-cleanup quit run the normal quit sequence', () => {
    const exit = jest.fn();
    const report = jest.fn<void, [RuntimeCleanupDiagnostic]>();
    const guard = new DrainedProcessExitGuard({ exit, report });
    guard.markDrained();
    guard.markCleanupComplete();
    // Cleanup ends with app.quit(), which re-enters before-quit.
    expect(guard.handleRepeatedQuit()).toBe(false);
    expect(exit).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('exits immediately on a repeated quit after the drain, and only once', async () => {
    const exit = jest.fn();
    const guard = new DrainedProcessExitGuard({ exit, report: jest.fn() });
    guard.markDrained();
    expect(guard.handleRepeatedQuit()).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(DRAINED_PROCESS_EXIT_DEADLINE_MS);
    guard.markDrained();
    expect(guard.handleRepeatedQuit()).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

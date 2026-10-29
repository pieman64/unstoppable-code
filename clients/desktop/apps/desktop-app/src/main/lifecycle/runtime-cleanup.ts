export async function settleBestEffortCleanup(
  cleanup: Promise<unknown>,
): Promise<void> {
  await cleanup.catch(() => undefined);
}

export interface RuntimeCleanupDiagnostic {
  version: 1;
  timestamp: string;
  kind: 'runtime_cleanup_stage';
  reason: 'app-quit' | 'fatal-exit';
  cleanupStage: string;
  cleanupStatus: 'started' | 'completed' | 'failed' | 'stalled' | 'timed_out';
  cleanupElapsedMs: number;
}

const CLEANUP_WAIT_NOTICE_MS = 5_000;

/** Longest the process may outlive the chat-state drain. */
export const DRAINED_PROCESS_EXIT_DEADLINE_MS = 30_000;

/**
 * Once chat state has drained, the process can no longer save work or serve
 * chats. Later teardown is still awaited, but neither a stage that never
 * settles nor a quit that never happens may keep the process running.
 */
export class DrainedProcessExitGuard {
  private drainedAt: number | null = null;
  private cleanupComplete = false;
  private exited = false;

  constructor(
    private readonly options: {
      exit: () => void;
      report: (event: RuntimeCleanupDiagnostic) => void;
      reason?: RuntimeCleanupDiagnostic['reason'];
    },
  ) {}

  public markDrained(): void {
    if (this.drainedAt !== null) return;
    this.drainedAt = performance.now();
    setTimeout(
      () => this.forceExit('timed_out'),
      DRAINED_PROCESS_EXIT_DEADLINE_MS,
    ).unref();
  }

  /** Cleanup ends with its own app.quit(); that quit is not a repeated one. */
  public markCleanupComplete(): void {
    this.cleanupComplete = true;
  }

  /** Returns true when a repeated quit request ended the process. */
  public handleRepeatedQuit(): boolean {
    if (this.drainedAt === null || this.cleanupComplete) return false;
    this.forceExit('completed');
    return true;
  }

  private forceExit(status: 'completed' | 'timed_out'): void {
    if (this.exited || this.drainedAt === null) return;
    this.exited = true;
    try {
      this.options.report({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'runtime_cleanup_stage',
        reason: this.options.reason ?? 'app-quit',
        cleanupStage: 'drained-exit',
        cleanupStatus: status,
        cleanupElapsedMs: Math.round(performance.now() - this.drainedAt),
      });
    } catch {
      // A diagnostic sink must never prevent quitting.
    }
    this.options.exit();
  }
}

/** Required drains are observed, never bypassed. Only explicitly ancillary
 * services may continue on a deadline, after their durable producers stop. */
export class RuntimeCleanupStages {
  constructor(
    private readonly report: (event: RuntimeCleanupDiagnostic) => void,
    private readonly reason: RuntimeCleanupDiagnostic['reason'],
  ) {}

  private begin(stage: string): {
    emit: (status: RuntimeCleanupDiagnostic['cleanupStatus']) => void;
    finish: (status: 'completed' | 'failed' | 'timed_out') => boolean;
  } {
    const startedAt = performance.now();
    let finished = false;
    const emit = (status: RuntimeCleanupDiagnostic['cleanupStatus']): void => {
      if (finished) return;
      try {
        this.report({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'runtime_cleanup_stage',
          reason: this.reason,
          cleanupStage: stage,
          cleanupStatus: status,
          cleanupElapsedMs: Math.round(performance.now() - startedAt),
        });
      } catch {
        // A diagnostic sink must never prevent saving work or quitting.
      }
    };
    emit('started');
    return {
      emit,
      finish: (status): boolean => {
        if (finished) return false;
        emit(status);
        finished = true;
        return true;
      },
    };
  }

  public async run<T>(
    stage: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const observation = this.begin(stage);
    const notice = setTimeout(
      () => observation.emit('stalled'),
      CLEANUP_WAIT_NOTICE_MS,
    );
    notice.unref();
    try {
      const value = await operation();
      observation.finish('completed');
      return value;
    } catch (error) {
      observation.finish('failed');
      throw error;
    } finally {
      clearTimeout(notice);
    }
  }

  public bestEffort(
    stage: string,
    operation: () => Promise<unknown> | void,
  ): Promise<void> {
    const observation = this.begin(stage);
    return new Promise<void>((resolve) => {
      const finish = (status: 'completed' | 'failed' | 'timed_out'): void => {
        if (!observation.finish(status)) return;
        clearTimeout(deadline);
        resolve();
      };
      const deadline = setTimeout(
        () => finish('timed_out'),
        CLEANUP_WAIT_NOTICE_MS,
      );
      deadline.unref();
      // Invoke immediately; handlers consume even a rejection after timeout.
      try {
        void Promise.resolve(operation()).then(
          () => finish('completed'),
          () => finish('failed'),
        );
      } catch {
        finish('failed');
      }
    });
  }
}

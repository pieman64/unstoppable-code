import { randomUUID } from 'node:crypto';
import type { AppAdvisorWatcher } from '@canopy/desktop-shared/types';
import {
  LOCAL_WATCHER_LIMITS,
  type LocalWatcherEvent,
} from '@canopy/desktop-shared/types/local-watchers';
import type { runWatcherCommand } from './local-watcher-command';

interface Dependencies {
  list(): Promise<AppAdvisorWatcher[]>;
  update(
    id: string,
    mutate: (watcher: AppAdvisorWatcher) => void,
  ): Promise<AppAdvisorWatcher | undefined>;
  deliver(
    watcher: AppAdvisorWatcher,
    event: LocalWatcherEvent,
    deliveryId: string,
  ): Promise<void>;
  outputPath(watcher: AppAdvisorWatcher, attempt: number): Promise<string>;
  run: typeof runWatcherCommand;
  recover?: (
    outputPath: string,
  ) => Promise<Awaited<ReturnType<typeof runWatcherCommand>> | undefined>;
  discardOutput?: (outputPath: string) => Promise<void>;
  env?: (watcher: AppAdvisorWatcher) => NodeJS.ProcessEnv;
  validateExecutionScope?: (watcher: AppAdvisorWatcher) => Promise<boolean>;
}

export class LocalWatcherAggregateError extends Error {
  readonly failures: unknown[];

  constructor(message: string, failures: unknown[]) {
    super(message);
    this.name = 'LocalWatcherAggregateError';
    this.failures = failures;
  }
}

export class WatcherRecipientNotReadyError extends Error {
  constructor() {
    super('The retained delegate recipient is not currently loaded.');
    this.name = 'WatcherRecipientNotReadyError';
  }
}

export const WATCHER_DELIVERY_ATTEMPT_LIMIT = 4;

/** One nearest-deadline timer, bounded parallelism, no overlapping attempts per watcher. */
export class LocalWatcherScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private enabled = false;
  private scanning = false;
  private rescanRequested = false;
  private inFlight = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private generation = 0;
  constructor(private readonly deps: Dependencies) {}

  async start(): Promise<void> {
    this.enabled = true;
    await this.rescan().catch(() => this.schedule(5000));
  }

  stop(): void {
    this.enabled = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    for (const task of Array.from(this.inFlight.values()))
      task.controller.abort();
  }

  async cancel(id: string): Promise<void> {
    const task = this.inFlight.get(id);
    task?.controller.abort();
    await task?.done;
  }

  async drain(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.inFlight.values(), (task) => task.done),
    );
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status !== 'rejected') continue;
      const reason: unknown = result.reason;
      failures.push(reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new LocalWatcherAggregateError(
        'Multiple watcher tasks failed.',
        failures,
      );
  }

  async rescan(): Promise<void> {
    if (!this.enabled) return;
    if (this.scanning) {
      this.rescanRequested = true;
      return;
    }
    this.scanning = true;
    try {
      if (this.timer) clearTimeout(this.timer);
      let next = Infinity;
      const rows = await this.deps.list();
      for (const row of rows) {
        const state = row.runtimeState;
        if (
          !this.enabled ||
          state?.kind !== 'local_watcher' ||
          state.cancellationPending !== undefined ||
          (row.status !== 'active' && row.status !== 'firing') ||
          this.inFlight.has(row.id)
        )
          continue;
        const due = Date.parse(state.nextAttemptAt);
        if (
          due <= Date.now() &&
          this.inFlight.size < LOCAL_WATCHER_LIMITS.concurrency
        ) {
          const controller = new AbortController();
          const generation = this.generation;
          const done = Promise.resolve()
            .then(() => this.advance(row, controller.signal, generation))
            .finally(() => {
              this.inFlight.delete(row.id);
              if (this.enabled) this.schedule(1000);
            });
          // Keep the rejection observable for cancel()/drain() without leaving
          // background task failures as unhandled promise rejections.
          void done.catch(() => undefined);
          this.inFlight.set(row.id, { controller, done });
        } else if (due > Date.now()) next = Math.min(next, due);
      }
      if (Number.isFinite(next)) this.schedule(Math.max(1, next - Date.now()));
    } finally {
      this.scanning = false;
      if (this.rescanRequested) {
        this.rescanRequested = false;
        await this.rescan();
      }
    }
  }

  private schedule(delay: number): void {
    if (!this.enabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        void this.rescan().catch(() => this.schedule(5000));
      },
      Math.min(2_147_483_647, Math.max(1, delay)),
    );
    this.timer.unref?.();
  }

  private async advance(
    row: AppAdvisorWatcher,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    let state = row.runtimeState;
    if (state?.kind !== 'local_watcher') return;
    const live = (): boolean =>
      !signal.aborted && this.enabled && generation === this.generation;
    if (!state.pendingDelivery) {
      let event: LocalWatcherEvent;
      if (row.target.kind === 'scheduled_wakeup') {
        event = {
          type: 'local_watcher_resolved',
          outcome: 'success',
          reason: 'scheduled_wakeup',
          attempts: 0,
          completedAt: new Date().toISOString(),
        };
      } else if (row.target.kind === 'command_watch') {
        if (
          this.deps.validateExecutionScope &&
          !(await this.deps.validateExecutionScope(row))
        ) {
          await this.commitEvent(row.id, {
            type: 'local_watcher_resolved',
            outcome: 'failure',
            reason: 'execution_scope_unavailable',
            attempts: state.attempts,
            completedAt: new Date().toISOString(),
          });
          return;
        }
        let recovered:
          | Awaited<ReturnType<typeof runWatcherCommand>>
          | undefined;
        try {
          recovered =
            state.running && this.deps.recover
              ? await this.deps.recover(
                  await this.deps.outputPath(row, state.attempts),
                )
              : undefined;
        } catch (error) {
          if (!live()) return;
          await this.commitEvent(row.id, {
            type: 'local_watcher_resolved',
            outcome: 'failure',
            reason: `recovery_error: ${error instanceof Error ? error.message : String(error)}`,
            attempts: state.attempts,
            completedAt: new Date().toISOString(),
          });
          return;
        }
        if (
          state.running &&
          state.attempts >= row.target.maxAttempts &&
          !recovered
        ) {
          event = {
            type: 'local_watcher_resolved',
            outcome: 'failure',
            reason: 'interrupted',
            attempts: state.attempts,
            completedAt: new Date().toISOString(),
          };
        } else {
          const started = recovered
            ? row
            : await this.deps.update(row.id, (current) => {
                if (current.runtimeState?.kind !== 'local_watcher') return;
                current.runtimeState.attempts++;
                current.runtimeState.running = true;
              });
          if (
            !started ||
            started.runtimeState?.kind !== 'local_watcher' ||
            !live()
          )
            return;
          state = started.runtimeState;
          let result: Awaited<ReturnType<typeof runWatcherCommand>>;
          try {
            const outputPath = await this.deps.outputPath(row, state.attempts);
            if (!live()) return;
            result =
              recovered ??
              (await this.deps.run({
                command: row.target.command,
                cwd: row.target.cwd,
                outputPath,
                signal,
                env: this.deps.env?.(row),
              }));
          } catch (error) {
            if (signal.aborted) throw error;
            if (!live()) return;
            event = {
              type: 'local_watcher_resolved',
              outcome: 'failure',
              reason: `capture_error: ${error instanceof Error ? error.message : String(error)}`,
              attempts: state.attempts,
              completedAt: new Date().toISOString(),
            };
            await this.commitEvent(row.id, event);
            return;
          }
          if (!live()) return;
          if (
            !result.reason &&
            result.exitCode === 1 &&
            state.attempts < row.target.maxAttempts
          ) {
            const nextAt = new Date(
              Date.now() + row.target.intervalSeconds * 1000,
            ).toISOString();
            await this.deps.update(row.id, (current) => {
              if (current.runtimeState?.kind !== 'local_watcher') return;
              current.runtimeState.running = false;
              current.runtimeState.nextAttemptAt = nextAt;
            });
            if (this.deps.discardOutput && live())
              await this.deps
                .discardOutput(await this.deps.outputPath(row, state.attempts))
                .catch(() => undefined);
            return;
          }
          event = {
            type: 'local_watcher_resolved',
            outcome:
              !result.reason && result.exitCode === 0 ? 'success' : 'failure',
            reason:
              result.reason ??
              (result.exitCode === 0
                ? 'exit_zero'
                : result.exitCode === 1
                  ? 'max_attempts'
                  : 'exit_status'),
            attempts: state.attempts,
            completedAt: new Date().toISOString(),
            exitCode: result.exitCode,
            signal: result.signal,
            output: result.output,
          };
        }
      } else return;
      const committed = await this.commitEvent(row.id, event);
      if (!committed || committed.runtimeState?.kind !== 'local_watcher')
        return;
      row = committed;
      state = committed.runtimeState;
    }
    await this.deliverPending(row, signal, generation);
  }

  private async deliverPending(
    row: AppAdvisorWatcher,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    const state = row.runtimeState;
    if (state?.kind !== 'local_watcher') return;
    const live = (): boolean =>
      !signal.aborted && this.enabled && generation === this.generation;
    if (!live() || !state.pendingDelivery) return;
    const pending = state.pendingDelivery;
    const deliveryAttempt = pending.attempts + 1;
    const saved = await this.deps.update(row.id, (current) => {
      const currentState = current.runtimeState;
      if (
        currentState?.kind !== 'local_watcher' ||
        !currentState.pendingDelivery
      )
        return;
      currentState.pendingDelivery.attempts = deliveryAttempt;
      currentState.nextAttemptAt = new Date(
        Date.now() + [5000, 30_000, 120_000][Math.min(deliveryAttempt - 1, 2)],
      ).toISOString();
    });
    const savedState = saved?.runtimeState;
    if (
      !saved ||
      !live() ||
      savedState?.kind !== 'local_watcher' ||
      !savedState.pendingDelivery
    )
      return;
    try {
      await this.deps.deliver(
        saved,
        savedState.pendingDelivery.event,
        savedState.pendingDelivery.eventId,
      );
      if (!live()) return;
      await this.deps.update(row.id, (current) => {
        if (current.runtimeState?.kind !== 'local_watcher') return;
        current.status = 'fired';
        current.firedAt = new Date().toISOString();
        delete current.deliveryError;
      });
    } catch (error) {
      if (!live()) return;
      if (error instanceof WatcherRecipientNotReadyError) {
        // A delegate's wakeup or command watch waits for its retained
        // recipient without spending attempts.
        await this.deps.update(row.id, (current) => {
          const currentState = current.runtimeState;
          if (
            currentState?.kind !== 'local_watcher' ||
            currentState.pendingDelivery?.eventId !== pending.eventId
          )
            return;
          currentState.pendingDelivery.attempts = pending.attempts;
          currentState.nextAttemptAt = new Date(
            Date.now() + 5000,
          ).toISOString();
          delete current.deliveryError;
        });
        return;
      }
      await this.deps.update(row.id, (current) => {
        if (current.runtimeState?.kind !== 'local_watcher') return;
        current.deliveryError =
          error instanceof Error ? error.message : String(error);
        if (deliveryAttempt >= WATCHER_DELIVERY_ATTEMPT_LIMIT) {
          current.status = 'delivery_failed';
          current.failureKind = 'delivery';
          current.firedAt = new Date().toISOString();
        }
      });
    }
  }

  private commitEvent(
    id: string,
    event: LocalWatcherEvent,
  ): Promise<AppAdvisorWatcher | undefined> {
    return this.deps.update(id, (current) => {
      if (current.runtimeState?.kind !== 'local_watcher') return;
      current.status = 'firing';
      current.runtimeState.running = false;
      current.runtimeState.nextAttemptAt = new Date().toISOString();
      current.runtimeState.pendingDelivery = {
        eventId: randomUUID(),
        attempts: 0,
        event,
      };
    });
  }
}

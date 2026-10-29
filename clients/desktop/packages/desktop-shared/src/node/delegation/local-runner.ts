import { createHash } from 'node:crypto';
import type {
  AgentDelegationError,
  AgentDelegationEvent,
  AgentDelegationTerminalStatus,
  AgentDelegationUsage,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import {
  cleanupDiagnostic,
  cleanupTarget,
  describeValue,
  LocalDelegationCleanupError,
  type LocalDelegationCleanupFailure,
  type LocalDelegationCleanupResource,
  type LocalDelegationCleanupTarget,
} from './cleanup-diagnostics';
import { hasValidDelegationLineage } from './types';
import type {
  AgentRunRequest,
  AgentRunnerAdapter,
  AgentSteeringRequest,
  DelegatedEventSink,
  DelegationStopReason,
  DelegationStopReceipt,
  NativeRunHandle,
  ResolvedAgentRouteSnapshot,
  RunnerAvailability,
} from './types';
import type { ChatInputAdmission } from '@canopy/protocol/portal/input-delivery';

export interface LocalDelegationOutcome {
  readonly status: AgentDelegationTerminalStatus;
  readonly finalText?: string;
  readonly usage?: AgentDelegationUsage;
  readonly error?: AgentDelegationError;
}

export class DelegationRunnerError extends Error {
  constructor(readonly detail: AgentDelegationError) {
    super(detail.message);
  }
}

export interface LocalDelegationContext {
  readonly request: AgentRunRequest;
  readonly signal: AbortSignal;
  emit(event: AgentDelegationEvent['event']): Promise<void>;
  /**
   * Register immediately when a resource is acquired. Success removes it once.
   * A callback registered without a resource is reported as `unlabelled`.
   */
  retain(
    close: () => Promise<void>,
    resource?: LocalDelegationCleanupResource,
  ): void;
  /** Native owner-specific interruption only. Never stop a shared worker. */
  setInterrupt(interrupt: () => Promise<void>): void;
  /** Bind steering to this exact native turn. */
  setSteer(
    steer: (request: AgentSteeringRequest) => Promise<ChatInputAdmission>,
  ): void;
}

type Cleanup = () => Promise<void>;

/** Registration order; a success is removed, a failure replaces `pending`. */
type CleanupAttempt = Map<Cleanup, LocalDelegationCleanupFailure>;

interface LocalRun {
  readonly request: AgentRunRequest;
  readonly controller: AbortController;
  readonly cleanups: Map<Cleanup, LocalDelegationCleanupTarget>;
  /** Only while a cleanup attempt runs. */
  cleanupAttempt?: CleanupAttempt;
  cleanupAttempts: number;
  readonly abort: () => void;
  readonly signal: AbortSignal;
  task: Promise<void>;
  cleanup?: Promise<void>;
  interrupt?: () => Promise<void>;
  interruption?: Promise<void>;
  steer?: (request: AgentSteeringRequest) => Promise<ChatInputAdmission>;
  stopReason?: DelegationStopReason;
}

/** Common local lifecycle; native execution and events remain adapter-owned. */
export class LocalDelegationRunner implements AgentRunnerAdapter {
  private readonly runs = new Map<string, LocalRun>();
  readonly adapterVersion = '1';
  constructor(
    readonly harnessId: string,
    readonly runtimeKind: string,
    private readonly available: (
      route: ResolvedAgentRouteSnapshot,
    ) => Promise<RunnerAvailability>,
    private readonly execute: (
      context: LocalDelegationContext,
    ) => Promise<LocalDelegationOutcome>,
    private readonly reportError: (error: unknown) => void,
  ) {}

  canRun(route: ResolvedAgentRouteSnapshot): Promise<RunnerAvailability> {
    return this.available(route);
  }

  start(
    request: AgentRunRequest,
    sink: DelegatedEventSink,
  ): Promise<NativeRunHandle> {
    if (
      this.runs.has(request.delegationId) ||
      request.signal.aborted ||
      !hasValidDelegationLineage(request.parent) ||
      request.effectivePermission !== 'read-only'
    )
      return Promise.reject(new Error('Invalid local delegation launch'));
    const controller = new AbortController();
    let sequence = 0;
    let tail: Promise<void> = Promise.resolve();
    const turn = 0;
    let currentItems: readonly AgentDelegationTranscriptItem[] = [];
    let currentSourceItems: readonly AgentDelegationTranscriptItem[] = [];
    let currentItemPayloadBytes: readonly number[] = [];
    let currentItemsPayloadBytes = 0;
    const currentItemIds = new Map<string, string>();
    let currentUsage: AgentDelegationUsage = {};
    const totalUsage = (usage: AgentDelegationUsage): AgentDelegationUsage => {
      const sum: Record<string, number> = {};
      for (const key of [
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'cacheCreationInputTokens',
        'costUsd',
      ] as const)
        if (usage[key] !== undefined) sum[key] = usage[key] ?? 0;
      return sum;
    };
    const emit = (event: AgentDelegationEvent['event']): Promise<void> => {
      if (event.type === 'usage') {
        currentUsage = event.usage;
        event = { ...event, usage: totalUsage(event.usage) };
      }
      if (event.type === 'transcript') {
        const nextItems = currentItems.slice(0, event.items.length);
        const nextItemPayloadBytes = currentItemPayloadBytes.slice(
          0,
          event.items.length,
        );
        let payloadBytes = currentItemsPayloadBytes;
        for (
          let index = event.items.length;
          index < currentItemPayloadBytes.length;
          index++
        )
          payloadBytes -= currentItemPayloadBytes[index] ?? 0;
        // Recorder snapshots preserve object identity for unchanged Map values.
        // Compare those identities so only added or changed items are projected.
        for (let index = 0; index < event.items.length; index++) {
          const item = event.items[index];
          if (!item) continue;
          if (currentSourceItems[index] === item) continue;
          let id = currentItemIds.get(item.id);
          if (!id) {
            id = `turn${turn}:${createHash('sha256').update(item.id).digest('hex')}`;
            currentItemIds.set(item.id, id);
          }
          const projected = {
            ...item,
            id,
            sequence: item.sequence,
          };
          const itemPayloadBytes = Buffer.byteLength(
            JSON.stringify(projected) ?? 'null',
          );
          payloadBytes +=
            itemPayloadBytes - (currentItemPayloadBytes[index] ?? 0);
          nextItems[index] = projected;
          nextItemPayloadBytes[index] = itemPayloadBytes;
        }
        currentSourceItems = event.items;
        currentItems = nextItems;
        currentItemPayloadBytes = nextItemPayloadBytes;
        currentItemsPayloadBytes = payloadBytes;
        const items = currentItems;
        const itemCount = items.length;
        const serializedBytes =
          2 + currentItemsPayloadBytes + Math.max(0, itemCount - 1);
        if (itemCount > 65_536 || serializedBytes > 16 * 1024 * 1024)
          throw new Error(
            'Delegated continuation transcript exceeds retention limits',
          );
        event = { ...event, items };
      }
      const envelope = {
        delegationId: request.delegationId,
        runGeneration: request.runGeneration,
        sequence: ++sequence,
        occurredAt: Date.now(),
        event,
      };
      const delivered = tail.then(() => sink(envelope));
      // One caller must observe its rejected event without poisoning the
      // serialized channel for later progress and the terminal receipt.
      tail = delivered.catch(() => undefined);
      return delivered;
    };
    const abort = (): void => {
      controller.abort();
      const run = this.runs.get(request.delegationId);
      if (run?.interrupt && !run.interruption) {
        run.interruption = run.interrupt();
        void run.interruption.catch(this.reportError);
      }
    };
    const run: LocalRun = {
      request,
      controller,
      cleanups: new Map(),
      cleanupAttempts: 0,
      abort,
      signal: request.signal,
      task: Promise.resolve(),
    };
    this.runs.set(request.delegationId, run);
    request.signal.addEventListener('abort', abort, { once: true });
    const context: LocalDelegationContext = {
      request,
      signal: controller.signal,
      emit,
      retain: (close, resource) => {
        if (!run.cleanups.has(close))
          run.cleanups.set(close, cleanupTarget(resource));
      },
      setInterrupt: (interrupt) => {
        run.interrupt = interrupt;
        if (controller.signal.aborted) abort();
      },
      setSteer: (steer) => {
        run.steer = steer;
      },
    };
    run.task = Promise.resolve()
      .then(async () => {
        let outcome: LocalDelegationOutcome;
        try {
          outcome = await this.execute(context);
          outcome = {
            ...outcome,
            usage: totalUsage(outcome.usage ?? currentUsage),
          };
        } catch (error) {
          outcome = {
            status: 'failed',
            error:
              error instanceof DelegationRunnerError
                ? error.detail
                : {
                    code: 'runtime_error',
                    message:
                      'The delegated runner failed. Retained partial output is available.',
                    retryable: false,
                  },
          };
          this.reportError(error);
        }
        if (controller.signal.aborted)
          outcome = {
            ...outcome,
            status:
              run.stopReason === 'deadline_exceeded'
                ? 'deadline_exceeded'
                : 'cancelled',
          };
        try {
          await this.cleanup(run);
        } catch {
          // cleanup() reported this attempt.
          outcome = {
            ...outcome,
            status: 'failed',
            error: {
              code: 'launch_uncertain',
              message: 'Delegated runner cleanup could not be confirmed.',
              retryable: false,
            },
          };
        }
        await emit({ type: 'terminal', ...outcome });
      })
      .catch(this.reportError);
    return Promise.resolve({ runId: request.delegationId });
  }

  async stop(
    handle: NativeRunHandle,
    reason: DelegationStopReason,
  ): Promise<DelegationStopReceipt> {
    const run = this.runs.get(handle.runId);
    if (!run) return { stopped: true };
    run.stopReason ??= reason;
    run.abort();
    try {
      await this.bounded(run, run.task);
      await this.bounded(run, this.cleanup(run));
      return { stopped: true };
    } catch {
      return {
        stopped: false,
        error: {
          code: 'launch_uncertain',
          message: 'The delegated runner has not confirmed cancellation.',
          retryable: false,
        },
      };
    }
  }

  async steer(
    handle: NativeRunHandle,
    request: AgentSteeringRequest,
  ): Promise<ChatInputAdmission> {
    const run = this.runs.get(handle.runId);
    if (!run || run.controller.signal.aborted)
      return {
        kind: 'rejected',
        attemptId: request.attemptId,
        reason: 'The delegated turn is no longer active',
        fallback: 'ordinary',
      };
    if (!run.steer)
      return {
        kind: 'rejected',
        attemptId: request.attemptId,
        reason: 'The active delegated provider does not support steering',
      };
    return run.steer(request);
  }

  async close(handle: NativeRunHandle): Promise<void> {
    const run = this.runs.get(handle.runId);
    if (!run) return;
    await this.bounded(run, run.task);
    await this.bounded(run, this.cleanup(run));
    run.signal.removeEventListener('abort', run.abort);
    this.runs.delete(handle.runId);
  }

  private cleanup(run: LocalRun): Promise<void> {
    if (run.cleanup) return run.cleanup;
    run.cleanup = (async (): Promise<void> => {
      run.cleanupAttempts += 1;
      const entries = Array.from(run.cleanups);
      const attempt: CleanupAttempt = new Map(
        entries.map(
          ([close, target]): [Cleanup, LocalDelegationCleanupFailure] => [
            close,
            { ...target, settlement: 'pending' },
          ],
        ),
      );
      run.cleanupAttempt = attempt;
      await Promise.all(
        entries.reverse().map(async ([close, target]) => {
          let settlement: 'threw' | 'rejected' = 'threw';
          try {
            const closing = close();
            settlement = 'rejected';
            await closing;
            run.cleanups.delete(close);
            attempt.delete(close);
          } catch (error) {
            // Only the checked descriptor outlives this scope.
            attempt.set(close, {
              ...target,
              settlement,
              ...describeValue(error),
            });
          }
        }),
      );
      run.cleanupAttempt = undefined;
      if (attempt.size > 0) {
        const error = this.cleanupError(run, 'rejected', attempt);
        this.report(error);
        throw error;
      }
    })().finally(() => {
      run.cleanup = undefined;
    });
    return run.cleanup;
  }

  private bounded(run: LocalRun, operation: Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = this.cleanupError(run, 'timeout');
        reject(error);
        this.report(error);
      }, 15_000);
      void operation.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  /** A timeout outside an attempt lists no failures; each attempt reported its own. */
  private cleanupError(
    run: LocalRun,
    outcome: 'rejected' | 'timeout',
    attempt = run.cleanupAttempt,
  ): LocalDelegationCleanupError {
    return new LocalDelegationCleanupError(
      cleanupDiagnostic({
        harnessId: this.harnessId,
        runtimeKind: this.runtimeKind,
        delegationId: run.request.delegationId,
        runGeneration: run.request.runGeneration,
        attempt: run.cleanupAttempts,
        outcome,
        retained: run.cleanups.size,
        failures: attempt ? Array.from(attempt.values()) : [],
      }),
    );
  }

  /** Reporting can never change a settlement. */
  private report(error: unknown): void {
    try {
      this.reportError(error);
    } catch {
      // The settlement already carries the failure.
    }
  }
}

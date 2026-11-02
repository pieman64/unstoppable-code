/**
 * Waits for the turn a `wait-for-agent-reply` step watches to settle, as the
 * chat-state owner settles it (`ChatStateService.settledTurn`): the binding
 * the chat-completion watchers use. Evaluates once on start, then after
 * committed changes to the chat's scope (coalesced and single-flight) and on
 * a slow safety recheck. Binds the turn once, so a later turn never replaces
 * it. Never reads chat text.
 *
 * Pure over injected deps; no Electron. A rejection from any dep rejects the
 * wait after it unsubscribes. Once the wait is done (result, timeout, abort or
 * error), no dep is called again and `onPinned` never runs.
 */

export type WatchedInput =
  | { kind: 'turn'; turnId: string }
  | { kind: 'pending' }
  /** The input left the chat before any turn picked it up. */
  | { kind: 'never_ran' }
  | { kind: 'unknown' };

export type CurrentTurn =
  | { kind: 'turn'; turnId: string }
  | { kind: 'pending' }
  | { kind: 'none' }
  | { kind: 'unknown' };

/** Mirrors `ChatStateService.settledTurn`. */
export interface TurnSettlement {
  outcome: 'pending' | 'completed' | 'failed' | 'cancelled';
  /** The turn that ended: the watched turn, or the last resume that carried it on. */
  endedTurnId: string;
  /** Another turn started instead of resuming the interrupted one. */
  abandoned: boolean;
}

export interface AgentReplyWaitDeps {
  locateInput(messageId: string): Promise<WatchedInput>;
  currentTurn(): Promise<CurrentTurn>;
  settle(turnId: string): Promise<TurnSettlement>;
  /** Called after any committed change to the chat's scope; returns an unsubscribe. */
  onChange(listener: () => void): () => void;
}

export type SettledReplyState =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type AgentReplyWaitResult =
  | {
      kind: 'settled';
      turnId: string;
      endedTurnId: string;
      state: SettledReplyState;
    }
  | { kind: 'none' }
  | { kind: 'never_ran' }
  | { kind: 'unknown_message' }
  | { kind: 'timed_out'; turnId?: string };

export interface AgentReplyWaitOptions {
  messageId?: string;
  /** A turn this step attempt already bound before a restart. */
  pinnedTurnId?: string;
  deadlineAt: number;
  signal: AbortSignal;
  onPinned?(turnId: string): Promise<void>;
  /** Default 250 ms. */
  coalesceMs?: number;
  /** Default 30 s. */
  recheckMs?: number;
}

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RECHECK_MS = 30_000;

function replyStateOf(settlement: TurnSettlement): SettledReplyState | null {
  switch (settlement.outcome) {
    case 'pending':
      return null;
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      // An app restart interrupted it and another turn started instead of a resume.
      return settlement.abandoned ? 'interrupted' : 'cancelled';
  }
}

/** The run's cancellation as an `Error`, so rejections always carry one. */
export function abortReasonError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error('The wait was cancelled.');
}

export function waitForAgentReplyTurn(
  deps: AgentReplyWaitDeps,
  options: AgentReplyWaitOptions,
): Promise<AgentReplyWaitResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(abortReasonError(options.signal));
      return;
    }
    if (options.deadlineAt <= Date.now()) {
      resolve(
        options.pinnedTurnId !== undefined
          ? { kind: 'timed_out', turnId: options.pinnedTurnId }
          : { kind: 'timed_out' },
      );
      return;
    }

    let turnId = options.pinnedTurnId;
    let done = false;
    let running = false;
    let again = false;
    let coalesce: ReturnType<typeof setTimeout> | undefined;

    /** One pass; `null` means keep waiting (or the wait already ended). */
    const evaluateOnce = async (): Promise<AgentReplyWaitResult | null> => {
      if (turnId === undefined) {
        let bound: string;
        if (options.messageId !== undefined) {
          const input = await deps.locateInput(options.messageId);
          if (done) return null;
          if (input.kind === 'unknown') return { kind: 'unknown_message' };
          if (input.kind === 'never_ran') return { kind: 'never_ran' };
          if (input.kind === 'pending') return null;
          bound = input.turnId;
        } else {
          const current = await deps.currentTurn();
          if (done) return null;
          if (current.kind === 'none') return { kind: 'none' };
          if (current.kind !== 'turn') return null;
          bound = current.turnId;
        }
        // Pin before recording the bind, so a failed pin never leaves a bound
        // turn the next attempt can't see.
        await options.onPinned?.(bound);
        if (done) return null;
        turnId = bound;
      }
      const settlement = await deps.settle(turnId);
      if (done) return null;
      const state = replyStateOf(settlement);
      return state === null
        ? null
        : {
            kind: 'settled',
            turnId,
            endedTurnId: settlement.endedTurnId,
            state,
          };
    };

    const evaluate = async (): Promise<void> => {
      if (done) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const result = await evaluateOnce();
          if (done) return;
          if (result) {
            finish({ result });
            return;
          }
        } while (again);
      } catch (error) {
        finish({
          error: error instanceof Error ? error : new Error(String(error)),
        });
      } finally {
        running = false;
      }
    };

    const schedule = (): void => {
      if (done || coalesce !== undefined) return;
      coalesce = setTimeout(() => {
        coalesce = undefined;
        void evaluate();
      }, options.coalesceMs ?? DEFAULT_COALESCE_MS);
    };

    const onAbort = (): void => {
      finish({ error: abortReasonError(options.signal) });
    };
    // Subscribe before the first read so no commit between them is missed,
    // and before the abort listener so a throwing subscribe leaves none.
    const unsubscribe = deps.onChange(schedule);
    options.signal.addEventListener('abort', onAbort, { once: true });
    const recheck = setInterval(
      schedule,
      options.recheckMs ?? DEFAULT_RECHECK_MS,
    );
    const deadline = setTimeout(
      () => {
        finish({
          result:
            turnId !== undefined
              ? { kind: 'timed_out', turnId }
              : { kind: 'timed_out' },
        });
      },
      Math.max(0, options.deadlineAt - Date.now()),
    );

    function finish(
      outcome: { result: AgentReplyWaitResult } | { error: Error },
    ): void {
      if (done) return;
      done = true;
      unsubscribe();
      clearInterval(recheck);
      clearTimeout(deadline);
      if (coalesce !== undefined) clearTimeout(coalesce);
      options.signal.removeEventListener('abort', onAbort);
      if ('result' in outcome) resolve(outcome.result);
      else reject(outcome.error);
    }

    void evaluate();
  });
}

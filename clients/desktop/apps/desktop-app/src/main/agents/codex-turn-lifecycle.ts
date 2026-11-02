import type {
  SessionState,
  TurnBinding,
  TurnOrigin,
} from '@canopy/protocol/canopy-core';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type { TurnLifecycleProducer } from './provider-turn-lifecycle';

interface NativeTurn {
  threadId: string;
  turnId: string;
}

interface InputBinding {
  submissionId?: string;
  userMessageId?: string;
}

interface TrackedTurn {
  threadId: string;
  binding: TurnBinding;
  startedAtMs: number;
  closed: boolean;
  /** A restart execution: the native turn's timing spans the ended one too. */
  restart?: boolean;
  /** Start order across this tracker's executions. */
  sequence: number;
}

/** Root-only source evidence. This callback is never an admission/control path. */
export type CodexTurnLifecycleObservation =
  | (NativeTurn &
      InputBinding & {
        type: 'turn-started';
        origin: Extract<TurnOrigin, 'user' | 'autonomous' | 'restart'>;
        merged?: boolean;
        startedAtMs?: number | null;
      })
  | (NativeTurn & InputBinding & { type: 'input-bound' })
  | (NativeTurn & {
      type: 'turn-completed';
      status: 'completed' | 'failed' | 'interrupted';
      error?: string;
      completedAtMs?: number | null;
      durationMs?: number | null;
    })
  | {
      type: 'session-state';
      threadId: string;
      turnId?: string;
      state: SessionState['state'];
    };

/** The client's evidence plus the session's own terminal for an execution's input. */
export type CodexTurnTrackerObservation =
  | CodexTurnLifecycleObservation
  | {
      type: 'execution-ended';
      userMessageId: string;
      status: 'completed' | 'failed' | 'interrupted';
    };

/** Observational translation only; native authority stays with the client. */
export class CodexTurnLifecycleTracker {
  private readonly turns = new Map<string, TrackedTurn>();

  private readonly bindingViolations = new Set<TurnBinding>();

  /** Lifecycle ids this tracker issued, so a restart id is never reused. */
  private readonly issuedTurnIds = new Set<string>();

  private startSequence = 0;

  /** `hasEnded` answers whether the canonical state already ended a turn id. */
  constructor(
    private readonly producer: TurnLifecycleProducer,
    private readonly hasEnded: (turnId: string) => boolean = (): boolean =>
      false,
  ) {}

  observe(observation: CodexTurnTrackerObservation): void {
    this.observeWithPublishedBinding(observation);
  }

  /** Routing evidence only when this observation published a normalized binding. */
  observeWithPublishedBinding(
    observation: CodexTurnTrackerObservation,
  ): TurnBinding | undefined {
    if (observation.type === 'session-state') {
      const turnId = observation.turnId
        ? (this.turns.get(
            JSON.stringify([observation.threadId, observation.turnId]),
          )?.binding.turnId ?? observation.turnId)
        : undefined;
      this.producer.sessionState({
        providerSessionId: observation.threadId,
        state: observation.state,
        source: 'provider',
        ...(turnId ? { observedDuringTurnId: turnId } : {}),
      });
      return;
    }
    if (observation.type === 'execution-ended') {
      // A turn whose native turn/completed never arrived (a lost transport)
      // still ends with the session's terminal for its input.
      for (const turn of Array.from(this.turns.values()))
        if (
          !turn.closed &&
          turn.binding.userMessageIds.includes(observation.userMessageId)
        )
          this.closeUncompleted(
            turn,
            observation.status === 'interrupted'
              ? 'cancelled'
              : observation.status,
          );
      return;
    }
    const key = JSON.stringify([observation.threadId, observation.turnId]);
    let turn = this.turns.get(key);
    let publishedBinding: TurnBinding | undefined;
    if (observation.type === 'turn-started') {
      // A native start that names an execution that already ended is a fresh
      // execution, never a revival of the ended one (contracts §2): a reused
      // id here, or a destroyed session's resumed turn. A late merge into a
      // turn this session completed stays ignored.
      const restart = turn
        ? turn.closed && !observation.merged
        : this.hasEnded(observation.turnId);
      if (!turn || restart) {
        const turnId = restart
          ? this.restartTurnId(observation.turnId)
          : observation.turnId;
        this.issuedTurnIds.add(turnId);
        const starts = !observation.merged || restart;
        turn = {
          threadId: observation.threadId,
          binding: {
            turnId,
            origin: observation.origin,
            binding: 'unbound',
            submissionIds: [],
            userMessageIds: [],
            providerUserMessageUuids: [],
            // The provider started this turn; Codex doesn't name what woke it.
            ...(observation.origin === 'autonomous' ? { spawnedBy: {} } : {}),
          },
          startedAtMs: restart
            ? Date.now()
            : (observation.startedAtMs ?? Date.now()),
          closed: false,
          ...(restart ? { restart: true } : {}),
          sequence: ++this.startSequence,
        };
        this.turns.set(key, turn);
        if (starts) {
          this.bindInput(turn.binding, observation);
          publishedBinding = this.copyBinding(turn.binding);
          this.producer.turnStarted({
            ...this.copyBinding(turn.binding),
            providerSessionId: observation.threadId,
            phase: 'start',
            startedAtMs: turn.startedAtMs,
          });
          return publishedBinding;
        }
      }
      if (!observation.merged) return publishedBinding;
    }
    if (!turn || turn.closed) return;
    if (observation.type === 'turn-completed') {
      turn.closed = true;
      const endedAtMs = observation.completedAtMs ?? Date.now();
      this.producer.turnEnded({
        ...this.copyBinding(turn.binding),
        providerSessionId: observation.threadId,
        source: 'turn-completed',
        outcome:
          observation.status === 'interrupted'
            ? 'cancelled'
            : observation.status,
        endedAtMs,
        // Codex's own duration when it reports one for this execution; else
        // the reducer derives it net of the turn's approval pauses.
        ...(!turn.restart && typeof observation.durationMs === 'number'
          ? { durationMs: observation.durationMs }
          : {}),
        ...(observation.error ? { terminalReason: observation.error } : {}),
      });
      return;
    }
    if (this.bindInput(turn.binding, observation)) {
      this.producer.turnStarted({
        ...this.copyBinding(turn.binding),
        providerSessionId: observation.threadId,
        phase: 'binding-update',
        startedAtMs: turn.startedAtMs,
      });
      return this.copyBinding(turn.binding);
    }
    return undefined;
  }

  /** The lifecycle id a native root turn currently maps to. */
  executionTurnId(threadId: string, nativeTurnId: string): string | undefined {
    return this.turns.get(JSON.stringify([threadId, nativeTurnId]))?.binding
      .turnId;
  }

  /** The lifecycle id of the newest execution bound to an input. */
  latestExecutionTurnIdFor(userMessageId: string): string | undefined {
    let latest: TrackedTurn | undefined;
    for (const turn of Array.from(this.turns.values()))
      if (
        turn.binding.userMessageIds.includes(userMessageId) &&
        (latest === undefined || turn.sequence > latest.sequence)
      )
        latest = turn;
    return latest?.binding.turnId;
  }

  private restartTurnId(nativeTurnId: string): string {
    for (let attempt = 1; ; attempt += 1) {
      const turnId = `${nativeTurnId}:restart-${attempt}`;
      if (!this.issuedTurnIds.has(turnId) && !this.hasEnded(turnId))
        return turnId;
    }
  }

  /** A destroyed transport ends every turn it never saw complete. */
  closeOpenTurns(): void {
    for (const turn of Array.from(this.turns.values()))
      if (!turn.closed) this.closeUncompleted(turn, 'cancelled');
  }

  private closeUncompleted(
    turn: TrackedTurn,
    outcome: 'completed' | 'failed' | 'cancelled',
  ): void {
    turn.closed = true;
    const endedAtMs = Date.now();
    this.producer.turnEnded({
      ...this.copyBinding(turn.binding),
      providerSessionId: turn.threadId,
      source: outcome === 'cancelled' ? 'abort-fallback' : 'result',
      outcome,
      endedAtMs,
    });
  }

  private bindInput(binding: TurnBinding, input: InputBinding): boolean {
    if (this.bindingViolations.has(binding)) return false;
    if (
      input.userMessageId &&
      !binding.userMessageIds.includes(input.userMessageId) &&
      binding.userMessageIds.length >= 64
    ) {
      this.bindingViolations.add(binding);
      logMainProcessWarn(
        '[CodexTurnLifecycle] Bound input capacity exceeded.',
        {
          code: 'turn_binding_capacity_exceeded',
          turnId: binding.turnId,
          userMessageId: input.userMessageId,
          submissionId: input.submissionId,
        },
      );
      return false;
    }
    let changed = false;
    if (
      input.submissionId &&
      !binding.submissionIds.includes(input.submissionId)
    ) {
      binding.submissionIds.push(input.submissionId);
      changed = true;
    }
    if (
      input.userMessageId &&
      !binding.userMessageIds.includes(input.userMessageId)
    ) {
      binding.userMessageIds.push(input.userMessageId);
      changed = true;
    }
    if (changed) binding.binding = 'bound';
    return changed;
  }

  private copyBinding(binding: TurnBinding): TurnBinding {
    return {
      ...binding,
      submissionIds: [...binding.submissionIds],
      userMessageIds: [...binding.userMessageIds],
      providerUserMessageUuids: [],
    };
  }
}

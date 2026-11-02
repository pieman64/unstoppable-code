import { randomUUID } from 'node:crypto';
import {
  ChatTurnLifecycleEventSchema,
  type BackgroundSet,
  type ChatTurnLifecycleEvent,
  type ProducerBase,
  type SessionState,
  type SpawnedBy,
  type TurnEnded,
  type TurnStarted,
} from '@canopy/protocol/canopy-core';
import { logMainProcessWarn } from '../lib/main-process-logging';

export type TurnLifecycleProvider = ProducerBase['provider'];

export interface TurnLifecycleScope {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

type ProducerStampKey =
  | 'version'
  | 'provider'
  | 'projectId'
  | 'worktreeId'
  | 'chatId'
  | 'sequence'
  | 'eventId'
  | 'observedAtMs';

export type TurnStartedFields = Omit<TurnStarted, ProducerStampKey | 'type'>;
export type TurnEndedFields = Omit<TurnEnded, ProducerStampKey | 'type'>;
export type SessionStateFields = Omit<SessionState, ProducerStampKey | 'type'>;
export type BackgroundSetFields = Omit<
  BackgroundSet,
  ProducerStampKey | 'type'
>;

export interface TurnLifecycleProducer {
  turnStarted(fields: TurnStartedFields): void;
  turnEnded(fields: TurnEndedFields): void;
  sessionState(fields: SessionStateFields): void;
  backgroundSet(fields: BackgroundSetFields): void;
}

export type TurnLifecycleSink =
  | ((event: ChatTurnLifecycleEvent) => void)
  | null;

let lifecycleSink: TurnLifecycleSink = null;
let lifecycleClock: () => number = Date.now;

/** Whether the host's canonical turn state already ended a turn id. */
export type TurnLifecycleEndedLookup =
  | ((scope: TurnLifecycleScope, turnId: string) => boolean)
  | null;

let endedLookup: TurnLifecycleEndedLookup = null;

/** Whether the host is restarting a scope's provider session itself. */
export type TurnLifecycleHostRestartLookup =
  | ((scope: TurnLifecycleScope) => boolean)
  | null;

let hostRestartLookup: TurnLifecycleHostRestartLookup = null;

/** The cause a host continuation gives the turn its restarted session runs. */
export interface TurnLifecycleContinuation {
  userMessageId: string;
  spawnedBy: SpawnedBy;
}

// By chat, not provider: the continuation may start on another harness.
const continuations = new Map<
  string,
  TurnLifecycleContinuation & { turnId?: string }
>();

function chatKey(scope: TurnLifecycleScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]);
}

const producers = new Map<string, TurnLifecycleProducer>();
const sequences = new Map<string, number>();
const sinkChangeListeners = new Set<(registered: boolean) => void>();

function scopeKey(
  provider: TurnLifecycleProvider,
  scope: TurnLifecycleScope,
): string {
  return JSON.stringify([
    provider,
    scope.projectId,
    scope.worktreeId,
    scope.chatId,
  ]);
}

function nextBase(
  provider: TurnLifecycleProvider,
  scope: TurnLifecycleScope,
  key: string,
): ProducerBase {
  const sequence = (sequences.get(key) ?? 0) + 1;
  sequences.set(key, sequence);
  return {
    version: 1,
    provider,
    ...scope,
    sequence,
    eventId: randomUUID(),
    observedAtMs: lifecycleClock(),
  };
}

class InProcessTurnLifecycleProducer implements TurnLifecycleProducer {
  private warnedInvalidEvent = false;

  constructor(
    private readonly provider: TurnLifecycleProvider,
    private readonly scope: TurnLifecycleScope,
    private readonly key: string,
  ) {}

  turnStarted(fields: TurnStartedFields): void {
    // The first turn after an armed continuation is it, unless it binds to
    // another prompt; that disarms it.
    const key = chatKey(this.scope);
    const armed = continuations.get(key);
    let spawnedBy = fields.spawnedBy;
    if (armed && (armed.turnId ?? fields.turnId) === fields.turnId) {
      if (
        fields.userMessageIds.length === 0 ||
        fields.userMessageIds.includes(armed.userMessageId)
      ) {
        armed.turnId = fields.turnId;
        spawnedBy = { ...fields.spawnedBy, ...armed.spawnedBy };
      } else {
        continuations.delete(key);
      }
    }
    this.publish({
      ...fields,
      ...(spawnedBy === undefined ? {} : { spawnedBy }),
      ...nextBase(this.provider, this.scope, this.key),
      type: 'TurnStarted',
    });
  }

  turnEnded(fields: TurnEndedFields): void {
    const key = chatKey(this.scope);
    if (continuations.get(key)?.turnId === fields.turnId)
      continuations.delete(key);
    // A session the host restarts itself (to load tools) ends its turn
    // there; no one cancelled it.
    let restarted = false;
    if (fields.outcome === 'cancelled') {
      try {
        restarted = hostRestartLookup?.(this.scope) === true;
      } catch {
        restarted = false;
      }
    }
    this.publish({
      ...fields,
      ...(restarted ? { outcome: 'completed' as const } : {}),
      ...nextBase(this.provider, this.scope, this.key),
      type: 'TurnEnded',
    });
  }

  sessionState(fields: SessionStateFields): void {
    this.publish({
      ...fields,
      ...nextBase(this.provider, this.scope, this.key),
      type: 'SessionState',
    });
  }

  backgroundSet(fields: BackgroundSetFields): void {
    this.publish({
      ...fields,
      ...nextBase(this.provider, this.scope, this.key),
      type: 'BackgroundSet',
    });
  }

  private publish(event: ChatTurnLifecycleEvent): void {
    const validated = ChatTurnLifecycleEventSchema.safeParse(event);
    if (!validated.success) {
      if (!this.warnedInvalidEvent) {
        this.warnedInvalidEvent = true;
        logMainProcessWarn(
          '[ClaudeTurnLifecycle] Invalid provider-neutral lifecycle event was dropped.',
          validated.error,
        );
      }
      return;
    }

    const sink = lifecycleSink;
    if (!sink) return;

    try {
      sink(validated.data);
    } catch (error) {
      logMainProcessWarn(
        '[ClaudeTurnLifecycle] Lifecycle sink failed; event was dropped.',
        error,
      );
    }
  }
}

function notifySinkChange(registered: boolean): void {
  sinkChangeListeners.forEach((listener) => {
    try {
      listener(registered);
    } catch (error) {
      logMainProcessWarn(
        '[ProviderTurnLifecycle] Sink-change listener failed.',
        error,
      );
    }
  });
}

export function setTurnLifecycleSink(sink: TurnLifecycleSink): void {
  const wasRegistered = lifecycleSink !== null;
  lifecycleSink = sink;
  const isRegistered = lifecycleSink !== null;
  if (wasRegistered !== isRegistered) notifySinkChange(isRegistered);
}

export function setTurnLifecycleEndedLookup(
  lookup: TurnLifecycleEndedLookup,
): void {
  endedLookup = lookup;
}

export function setTurnLifecycleHostRestartLookup(
  lookup: TurnLifecycleHostRestartLookup,
): void {
  hostRestartLookup = lookup;
}

/**
 * Arms the cause the scope's next turn takes, the one a host continuation
 * starts; `null` disarms. Arming again replaces it.
 */
export function armTurnLifecycleContinuation(
  scope: TurnLifecycleScope,
  continuation: TurnLifecycleContinuation | null,
): void {
  if (continuation === null) continuations.delete(chatKey(scope));
  else
    continuations.set(chatKey(scope), {
      userMessageId: continuation.userMessageId,
      spawnedBy: { ...continuation.spawnedBy },
    });
}

/** False when no host answers: a producer then keeps the native id. */
export function hasTurnLifecycleEnded(
  scope: TurnLifecycleScope,
  turnId: string,
): boolean {
  try {
    return endedLookup?.(scope, turnId) === true;
  } catch {
    return false;
  }
}

/** Injects the host receipt clock; passing null restores the system clock. */
export function setTurnLifecycleClockForTests(
  clock: (() => number) | null,
): void {
  lifecycleClock = clock ?? Date.now;
}

export function onTurnLifecycleSinkChange(
  listener: (registered: boolean) => void,
): () => void {
  sinkChangeListeners.add(listener);
  // A listener loaded after the sink would otherwise miss its registration.
  if (lifecycleSink !== null) {
    try {
      listener(true);
    } catch (error) {
      logMainProcessWarn(
        '[ProviderTurnLifecycle] Sink-change listener failed.',
        error,
      );
    }
  }
  return () => sinkChangeListeners.delete(listener);
}

export function getTurnLifecycleProducer(
  provider: TurnLifecycleProvider,
  scope: TurnLifecycleScope,
): TurnLifecycleProducer {
  const key = scopeKey(provider, scope);
  const existing = producers.get(key);
  if (existing) return existing;

  const producer = new InProcessTurnLifecycleProducer(
    provider,
    { ...scope },
    key,
  );
  producers.set(key, producer);
  return producer;
}

export function releaseTurnLifecycleProducer(
  provider: TurnLifecycleProvider,
  scope: TurnLifecycleScope,
): void {
  producers.delete(scopeKey(provider, scope));
}

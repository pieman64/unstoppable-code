import { chatTurnTimerId } from '@canopy/agent-transcript/turn';
import type {
  ChatTurnEffect,
  ChatTurnRecord,
  PersistedChatTurnState,
} from '@canopy/agent-transcript/turn';
import type {
  ChatCoreMutation,
  ChatRuntimeState,
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { reduceChatState, type CanonicalChatState } from './chat-state-reducer';
import type { ChatTurnOwnershipSnapshot } from './chat-turn-ownership';
import type { ChatTurnStateHandoffSnapshot } from './chat-turn-state-handoff';

type TimerBlock = Extract<PersistedChatBlock, { type: 'turn_timer' }>;
type TimerEffect = Extract<ChatTurnEffect, { timerId: string }>;

/** Duration of the union, not the sum, of overlapping host-owned pauses. */
function pausedDuration(record: ChatTurnRecord, through: number): number {
  const intervals = record.pauses
    .map((pause) => ({
      start: Math.max(record.startedAtMs, pause.startedAtMs),
      end: Math.min(through, pause.endedAtMs ?? through),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((left, right) => left.start - right.start);
  let total = 0;
  let end = record.startedAtMs;
  for (const interval of intervals) {
    total += Math.max(0, interval.end - Math.max(end, interval.start));
    end = Math.max(end, interval.end);
  }
  return total;
}

function applyTimerEffect(
  block: TimerBlock,
  effect: TimerEffect,
  record: ChatTurnRecord,
): TimerBlock {
  // Replaying a captured prefix must never reopen or alter a settled timer.
  if (block.completedAt !== null || effect.type === 'timer.open') return block;
  const timerStart = block.startedAt ?? record.startedAtMs;
  if (effect.type === 'timer.pause') {
    if (
      (block.pausedAt != null && block.resumedAt == null) ||
      effect.atMs <= (block.resumedAt ?? -Infinity)
    )
      return block;
    // A pause owner opened before the start still pauses, from the start.
    return {
      ...block,
      pausedAt: Math.max(effect.atMs, timerStart),
      resumedAt: null,
    };
  }
  if (effect.type === 'timer.resume') {
    // An earlier resume belongs to an earlier interval, unless the pause began
    // at the start, where no earlier interval exists.
    if (
      block.pausedAt == null ||
      block.resumedAt != null ||
      (effect.atMs < block.pausedAt && block.pausedAt !== timerStart)
    )
      return block;
    const resumedAt = Math.max(effect.atMs, block.pausedAt);
    return {
      ...block,
      resumedAt,
      accumulatedPausedDurationMs:
        (block.accumulatedPausedDurationMs ?? 0) + resumedAt - block.pausedAt,
    };
  }
  const paused =
    record.pauses.length > 0
      ? pausedDuration(record, effect.atMs)
      : (block.accumulatedPausedDurationMs ?? 0) +
        (block.pausedAt != null && block.resumedAt == null
          ? Math.max(0, effect.atMs - block.pausedAt)
          : 0);
  const duration =
    effect.durationMs ??
    record.durationMs ??
    Math.max(0, effect.atMs - record.startedAtMs - paused);
  return {
    ...block,
    // A turn that waited on the user keeps the same elapsed-time origin at
    // completion as during every approval. Provider duration can use a different
    // boundary; encoding it as a new start would change whole-turn active time.
    // Unpaused turns retain the existing provider-duration projection.
    startedAt:
      record.pauses.length > 0
        ? timerStart
        : effect.atMs - Math.max(0, duration) - paused,
    completedAt: effect.atMs,
    accumulatedPausedDurationMs: paused,
    ...(block.pausedAt != null && block.resumedAt == null
      ? { resumedAt: effect.atMs }
      : {}),
    pauseOwnerIds: [],
  };
}

/**
 * Synchronous mutation builder, with no IO, clocks or notifications. Fold the
 * caller's content/pickup mutations first; S3b wires this into each transaction.
 * Transcript storage is append-only, so a new timer row appends and an existing
 * one changes in place, never moving; projections place a timer in its turn by
 * `turnId` and `userMessageId`, so its anchor need not be in the selected view.
 */
export function applyTurnEffects(
  current: CanonicalChatState,
  mutations: ChatCoreMutation[],
  snapshot: ChatTurnStateHandoffSnapshot,
  /**
   * Skip a turn whose timer cannot be placed instead of failing the whole
   * snapshot; the other turns' effects still apply. Returns the skipped ids.
   */
  options: { skipUnplaceable?: boolean } = {},
): string[] {
  const scratch = reduceChatState(current, mutations);
  const chatId = snapshot.scope.chatId;
  const tab = scratch.tabsFile.tabs.find(
    (candidate) => candidate.id === chatId,
  );
  if (!tab) throw new Error('Canonical timer targets a missing chat');
  const records = new Map<string, ChatTurnRecord>();
  for (const record of snapshot.turnRecords ?? [])
    records.set(record.id, record);
  for (const record of [snapshot.turn.lastEnded, snapshot.turn.current]) {
    if (record) records.set(record.id, record);
  }
  const skipped = new Set<string>();
  const fail = (turnId: string, message: string): void => {
    if (!options.skipUnplaceable) throw new Error(message);
    skipped.add(turnId);
  };
  const effectsByTurn = new Map<string, TimerEffect[]>();
  for (const effect of snapshot.effects ?? []) {
    if (!('timerId' in effect)) continue;
    if (effect.timerId !== chatTurnTimerId(effect.turnId)) {
      fail(effect.turnId, 'Canonical timer identity mismatch');
      continue;
    }
    if (!records.has(effect.turnId)) {
      fail(effect.turnId, 'Canonical timer is missing its turn record');
      continue;
    }
    const effects = effectsByTurn.get(effect.turnId) ?? [];
    effects.push(effect);
    effectsByTurn.set(effect.turnId, effects);
  }
  let messages = [...tab.messages];
  // Process effect owners in receipt order, followed by binding-only records.
  const turnIds = new Set([
    ...Array.from(effectsByTurn.keys()),
    ...Array.from(records.keys()),
  ]);
  const additions: ChatCoreMutation[] = [];
  for (const turnId of Array.from(turnIds)) {
    if (skipped.has(turnId)) continue;
    // A turn fails before it adds any mutation, so skipping it is clean.
    try {
      const record = records.get(turnId);
      if (!record) continue;
      const timerId = chatTurnTimerId(turnId);
      const index = messages.findIndex((message) => message.id === timerId);
      const existing = index < 0 ? undefined : messages[index];
      let timer = existing?.blocks.find(
        (block): block is TimerBlock =>
          block.type === 'turn_timer' && block.turnId === turnId,
      );
      if (existing && !timer)
        throw new Error('Canonical timer row has mismatched ownership');
      for (const effect of effectsByTurn.get(turnId) ?? []) {
        if (!timer) {
          if (effect.type !== 'timer.open')
            throw new Error('Canonical timer effect has no open timer');
          timer = {
            type: 'turn_timer',
            turnId,
            startedAt: effect.atMs,
            completedAt: null,
          };
        }
        timer = applyTimerEffect(timer, effect, record);
      }
      if (!timer) continue; // Binding alone cannot invent a timer.
      // Provider reduction may already have closed the timer. Only the
      // canonical record for this exact execution can establish its outcome.
      if (
        timer.completedAt !== null &&
        timer.outcome === undefined &&
        record.endedAtMs !== undefined &&
        record.outcome !== undefined
      )
        timer = { ...timer, outcome: record.outcome };
      // The anchor follows the binding, including a late one, so projections
      // can tell executions that share an anchor apart from other turns.
      const anchorId = record.userMessageId ?? record.inputIds?.[0];
      if (anchorId !== undefined && timer.userMessageId !== anchorId)
        timer = { ...timer, userMessageId: anchorId };
      // A wake's cause follows the record too, and leaves once a prompt binds;
      // a continuation after a tools load keeps it, to head its own turn.
      const spawnedBy =
        record.origin === 'autonomous' || record.spawnedBy?.toolsLoaded
          ? record.spawnedBy
          : undefined;
      const { spawnedBy: previous, ...rest } = timer;
      if (JSON.stringify(previous) !== JSON.stringify(spawnedBy))
        timer = spawnedBy === undefined ? rest : { ...rest, spawnedBy };
      const row: PersistedChatMessage = existing
        ? {
            ...existing,
            blocks: existing.blocks.map((block) =>
              block.type === 'turn_timer' && block.turnId === turnId
                ? timer
                : block,
            ),
          }
        : {
            id: timerId,
            role: 'system',
            timestamp: record.startedAtMs,
            blocks: [timer],
          };
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(row))
          additions.push({ type: 'message.upserted', chatId, message: row });
        messages[index] = row;
      } else {
        // A plain append: an open timer stays in the live turn's active tail.
        additions.push({ type: 'message.upserted', chatId, message: row });
        messages = [...messages, row];
      }
    } catch (error) {
      if (!options.skipUnplaceable) throw error;
      skipped.add(turnId);
    }
  }
  mutations.push(...additions);
  return Array.from(skipped);
}

/**
 * The timer rows a commit wrote for a snapshot's turns, the last write of
 * each, so its acknowledgement can publish them (the Portal projection). A
 * binding alone can change a row's anchor or wake cause, with no timer effect.
 */
export function snapshotTimerRows(
  mutations: readonly ChatCoreMutation[],
  snapshot: ChatTurnStateHandoffSnapshot,
): PersistedChatMessage[] {
  const timerIds = new Set([
    ...(snapshot.effects ?? []).flatMap((effect) =>
      'timerId' in effect ? [effect.timerId] : [],
    ),
    ...[
      ...(snapshot.turnRecords ?? []),
      snapshot.turn.lastEnded,
      snapshot.turn.current,
    ].flatMap((record) => (record ? [chatTurnTimerId(record.id)] : [])),
  ]);
  const rows = new Map<string, PersistedChatMessage>();
  for (const mutation of mutations)
    if (
      mutation.type === 'message.upserted' &&
      mutation.chatId === snapshot.scope.chatId &&
      timerIds.has(mutation.message.id)
    )
      rows.set(mutation.message.id, mutation.message);
  return Array.from(rows.values());
}

/** Pure root-status projection. Host queues and metadata never create a T. */
export function projectTurnRuntime(
  previous: ChatRuntimeState | undefined,
  turn: PersistedChatTurnState,
  ownership: ChatTurnOwnershipSnapshot,
): ChatRuntimeState {
  const base = previous ?? { status: 'idle', queuedMessageIds: [] };
  const current = turn.current;
  if (current) {
    const paused =
      turn.decisionPending ||
      current.pauses.some((pause) => pause.endedAtMs === undefined);
    return {
      ...base,
      turn,
      status: paused ? 'awaiting_input' : 'streaming',
      // An unbound root (no root receipt to bind it) keeps its host's
      // dispatch identity; the host never mints a T, it only labels this one.
      activeTurn: current.userMessageId
        ? {
            userMessageId: current.userMessageId,
            startedAt: current.startedAtMs,
            ...(base.activeTurn?.userMessageId === current.userMessageId &&
            base.activeTurn.sessionId
              ? { sessionId: base.activeTurn.sessionId }
              : {}),
          }
        : base.activeTurn,
    };
  }
  const dispatch = ownership.dispatchOwners.find(
    (owner) => owner.reason === 'awaiting-start',
  );
  const emptyCompletion =
    turn.lastEnded?.outcome === 'completed' &&
    base.error?.code === 'empty_completion' &&
    base.emptyCompletionRecovery?.turnUserMessageId ===
      turn.lastEnded.userMessageId;
  return {
    ...base,
    turn,
    // Before T, an owned dispatch keeps its row's identity (phase 15a).
    activeTurn: ownership.dispatchOwners.some(
      (owner) =>
        owner.reason === 'awaiting-start' &&
        owner.userMessageId !== undefined &&
        owner.userMessageId === base.activeTurn?.userMessageId,
    )
      ? base.activeTurn
      : undefined,
    status: dispatch
      ? 'starting'
      : ownership.hostQueuedInputCount > 0 || base.queuedMessageIds.length > 0
        ? 'queued'
        : emptyCompletion
          ? 'failed'
          : (turn.lastEnded?.outcome ?? 'idle'),
  };
}

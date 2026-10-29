import { resumePausedTurnTimer } from '@canopy/agent-transcript';
import type {
  ChatRuntimeState,
  PersistedChatBlock,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';

type TurnTimerBlock = Extract<PersistedChatBlock, { type: 'turn_timer' }>;

const ACTIVE_RUNTIME_STATUSES: ReadonlySet<ChatRuntimeState['status']> =
  new Set<ChatRuntimeState['status']>([
    'queued',
    'starting',
    'streaming',
    'awaiting_input',
    'completing',
  ]);

export function isActiveChatRuntime(
  runtime: ChatRuntimeState | undefined,
): boolean {
  return runtime !== undefined && ACTIVE_RUNTIME_STATUSES.has(runtime.status);
}

function turnTimerBlock(
  message: PersistedChatMessage,
): TurnTimerBlock | undefined {
  for (const block of message.blocks)
    if (block.type === 'turn_timer') return block;
  return undefined;
}

function isOpenTurnTimer(block: TurnTimerBlock): boolean {
  return (
    block.completedAt === null &&
    (block.pausedAt == null || block.resumedAt != null)
  );
}

/**
 * A completion belongs to settled history when no turn was active before the
 * event, or when it happened before the current active period started. An
 * untagged revival (for example a late tool result) re-arms the runtime
 * without an active turn record and without touching the timer. Settled rows
 * have already left the active projection, so editing them in place rewrites
 * the committed transcript.
 */
function completionIsSettled(
  completedAt: number,
  previousRuntime: ChatRuntimeState | undefined,
): boolean {
  if (!isActiveChatRuntime(previousRuntime)) return true;
  const activeSince = previousRuntime?.activeTurn?.startedAt;
  return activeSince === undefined || completedAt < activeSince;
}

/** Same accounting as a hidden delivery resuming its visible turn timer. */
function continuationTimer(
  settled: TurnTimerBlock,
  completedAt: number,
  now: number,
): TurnTimerBlock {
  return {
    type: 'turn_timer',
    ...(settled.startedAt !== undefined
      ? { startedAt: settled.startedAt }
      : {}),
    pausedAt: completedAt,
    resumedAt: now,
    accumulatedPausedDurationMs:
      Math.max(0, settled.accumulatedPausedDurationMs ?? 0) +
      Math.max(0, now - completedAt),
    completedAt: null,
  };
}

/**
 * Releases one pause owner's hold on a chat's turn timer
 * (`resumePausedTurnTimer`). A turn's terminal event leaves a paused timer
 * open, since its pause owner may still revive the turn. An owner that pauses
 * outside the turn's event commit chain (a delegate's approval pauses its
 * parent's timer) can therefore outlive the turn; when the last owner lets go
 * after the turn settled, nothing would complete the restarted timer, so the
 * release completes it. The paused interval stays paused, so the timer keeps
 * the turn's working time. An unknown runtime only resumes.
 */
export function releaseTurnTimerPause(
  messages: PersistedChatMessage[],
  runtime: ChatRuntimeState | undefined,
  ownerId: string,
  releasedAt: number,
): PersistedChatMessage[] {
  const released = resumePausedTurnTimer(messages, releasedAt, ownerId);
  if (
    released === messages ||
    runtime === undefined ||
    isActiveChatRuntime(runtime)
  )
    return released;
  const unchanged = new Set(messages);
  return released.map((message) => {
    const block = turnTimerBlock(message);
    if (unchanged.has(message) || !block || !isOpenTurnTimer(block))
      return message;
    return {
      ...message,
      blocks: message.blocks.map((candidate) =>
        candidate === block ? { ...block, completedAt: releasedAt } : candidate,
      ),
    };
  });
}

export interface SettledTurnTimerGuardInput {
  /** The chat's messages before the event was reduced. */
  previous: readonly PersistedChatMessage[];
  /** The reducer's proposed messages. */
  next: PersistedChatMessage[];
  previousRuntime: ChatRuntimeState | undefined;
  nextRuntime: ChatRuntimeState;
  now: number;
  createMessageId: () => string;
}

/**
 * Main's canonical rule for turn timers whose completion is settled: the
 * shared reducer reopens the last completed timer in place whenever work
 * continues a settled turn, which edits a committed row. Main never commits
 * that edit:
 *
 * - When the event leaves the runtime settled, the reopen came from a stale or
 *   follow-up producer (for example a revival-flagged `system/init` admitted
 *   as a settled-turn follow-up). The committed completion is kept.
 * - When the event revives the turn, the committed timer keeps its
 *   completion and one continuation timer row carries the turn's accounting
 *   (idle time since the completion counts as paused). The display shows a
 *   turn's last timer, so the visible timer resumes without rewriting history,
 *   and its later completion lands on the new row in the active projection.
 *
 * Returns `next` unchanged when nothing reopened a settled timer.
 */
export function preserveSettledTurnTimers(
  input: SettledTurnTimerGuardInput,
): PersistedChatMessage[] {
  const settledById = new Map<
    string,
    { block: TurnTimerBlock; completedAt: number }
  >();
  for (const message of input.previous) {
    const block = turnTimerBlock(message);
    if (
      block &&
      typeof block.completedAt === 'number' &&
      completionIsSettled(block.completedAt, input.previousRuntime)
    )
      settledById.set(message.id, { block, completedAt: block.completedAt });
  }
  if (settledById.size === 0) return input.next;

  const previousById = new Map(
    input.previous.map((message) => [message.id, message]),
  );
  let reopened: { block: TurnTimerBlock; completedAt: number } | undefined;
  let changed = false;
  const next = input.next.map((message) => {
    const settled = settledById.get(message.id);
    if (!settled) return message;
    const block = turnTimerBlock(message);
    if (!block || block.completedAt !== null) return message;
    const original = previousById.get(message.id);
    if (!original) return message;
    changed = true;
    reopened = settled;
    return original;
  });
  if (!changed) return input.next;
  if (
    reopened === undefined ||
    !isActiveChatRuntime(input.nextRuntime) ||
    next.some((message) => {
      const block = turnTimerBlock(message);
      return block !== undefined && isOpenTurnTimer(block);
    })
  )
    return next;
  return [
    ...next,
    {
      id: input.createMessageId(),
      role: 'system',
      timestamp: input.now,
      blocks: [
        continuationTimer(reopened.block, reopened.completedAt, input.now),
      ],
    },
  ];
}

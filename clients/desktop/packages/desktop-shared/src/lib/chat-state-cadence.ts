// Which committed chat state changes are streamed content.
//
// Streamed content is a message upsert, a non-resetting transcript descriptor
// update, or a runtime patch that changes nothing but `lastActivityAt`. Every
// provider commit carries such a runtime patch. Anything else changes a
// chat's lifecycle or structure (status, errors, queues, tabs, questions,
// archives, removals, replacements, transcript resets).
//
// Two consumers share this definition so they agree on it:
//
// - main's legacy IPC projection may merge consecutive streamed-content
//   events of one scope into one `chat:state-changed` message, and sends
//   every other event on its own;
// - the renderer may publish streamed content to React on the next animation
//   frame, and renders everything else at once.
//
// Both rules keep lifecycle transitions one event each, so React effects
// keyed on them still observe every intermediate state.

import type {
  ChatRuntimeState,
  ChatStateChange,
  ChatStateChangedEvent,
} from '../types';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Structural equality of JSON-shaped values; own keys must match exactly. */
function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      jsonValuesEqual(left[key], right[key]),
  );
}

/**
 * True when `next` differs from `current` at most in `lastActivityAt`. An
 * unknown `current` is never activity-only.
 */
function chatRuntimeOnlyActivityChanged(
  current: ChatRuntimeState | undefined,
  next: ChatRuntimeState,
): boolean {
  if (!current) return false;
  const { lastActivityAt: _currentActivity, ...currentRest } = current;
  const { lastActivityAt: _nextActivity, ...nextRest } = next;
  void _currentActivity;
  void _nextActivity;
  return jsonValuesEqual(currentRest, nextRest);
}

/**
 * True when one change is streamed content. `runtimeBefore` returns the
 * chat's runtime state from before the change's event was applied.
 */
function isStreamedChatStateChange(
  change: ChatStateChange,
  runtimeBefore: (chatId: string) => ChatRuntimeState | undefined,
): boolean {
  switch (change.type) {
    case 'delegation.card_state_updated':
      // Descriptor metadata is not streamed token output.
      return false;
    case 'message.upserted':
      return true;
    case 'transcript.updated':
      return change.reset !== true;
    case 'runtime.patched':
      return chatRuntimeOnlyActivityChanged(
        runtimeBefore(change.chatId),
        change.runtime,
      );
    default:
      return false;
  }
}

/** True when every change of a committed event is streamed content. */
export function isStreamedChatStateEvent(
  event: ChatStateChangedEvent,
  runtimeBefore: (chatId: string) => ChatRuntimeState | undefined,
): boolean {
  return (
    event.changes.length > 0 &&
    event.changes.every((change) =>
      isStreamedChatStateChange(change, runtimeBefore),
    )
  );
}

/**
 * One event equivalent to applying `events` in order: the first event's
 * `baseRevision`, the last event's identity and `revision`, and every change
 * in order. The events must be one scope's contiguous committed revisions;
 * a single event is returned unchanged.
 */
export function mergeChatStateChangedEvents(
  events: readonly [ChatStateChangedEvent, ...ChatStateChangedEvent[]],
): ChatStateChangedEvent {
  const [first] = events;
  if (events.length === 1) return first;
  const last = events[events.length - 1] ?? first;
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const next = events[index];
    if (
      next.projectId !== first.projectId ||
      next.worktreeId !== first.worktreeId ||
      next.baseRevision !== previous.revision
    ) {
      throw new Error('Only contiguous events of one scope can be merged.');
    }
  }
  return {
    ...first,
    eventId: last.eventId,
    occurredAt: last.occurredAt,
    revision: last.revision,
    changes: events.flatMap((event) => event.changes),
  };
}

/**
 * Most scopes one window declares individually; a renderer tracking more
 * declares every scope instead.
 */
export const MAX_DECLARED_CHAT_STATE_SCOPES = 4096;

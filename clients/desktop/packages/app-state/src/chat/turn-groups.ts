import { isClaudeAiCreditsFallbackErrorCode } from '@canopy/protocol/llm-gateway';
import type {
  PortalChatMessage,
  PortalChatToolFamily,
  PortalChatTurnGroup,
} from '@canopy/protocol/portal';

/**
 * Neutral turn-grouping for the shared chat store.
 *
 * This is the transport-agnostic counterpart to the desktop renderer's
 * `incremental-turn-groups.ts`. That implementation is hard-coupled to desktop
 * rich-block types (`DisplayBlock`, `groupIntoTurns`/`AgentUsage`) which live in
 * `@canopy/desktop-shared` and the desktop renderer — both forbidden imports for
 * `@canopy/app-state`. So this module re-derives the grouping over the neutral
 * {@link PortalChatMessage} shape from `@canopy/protocol`, preserving the one
 * behaviour the shared UI depends on: **referential identity of completed turn
 * groups**, so a downstream `React.memo` can skip re-rendering settled turns
 * while only the streaming tail changes.
 *
 * The intermediate-vs-final classification below is a deliberately simple,
 * documented default (the concluding textual answer and anything after it is
 * "final"; earlier tool-only steps are "intermediate"). The shared
 * `ui-app` transcript (`ChatTranscript`/`TurnGroupView`) renders these groups,
 * so the rule is load-bearing there; exact parity with the desktop
 * `splitFinalMessages` / server projector remains a follow-up refinement
 * (CAN-741) and any change must keep those consumers' tests green.
 */

/** Per-chat cache of completed turn groups, keyed by the anchoring user id. */
export interface TurnGroupCache {
  /** Which chat this cache belongs to; a mismatch invalidates the cache. */
  chatId: string;
  /** Completed groups from the previous computation, keyed by user message id. */
  completedGroups: Map<string, PortalChatTurnGroup>;
}

/** A fresh, empty cache; callers own one per chat thread. */
export function createEmptyTurnGroupCache(): TurnGroupCache {
  return { chatId: '', completedGroups: new Map() };
}

/** A message whose status is no longer streaming. */
function isTerminalStatus(status: PortalChatMessage['status']): boolean {
  return status !== 'streaming';
}

/**
 * A system message carrying only `turn_timer` parts — the turn's "Working…" /
 * "Completed X:XX" row. Its `createdAtMs` is pinned to the turn start (that is
 * its upsert identity), so in transcript order it sits *before* the assistant
 * answer; like the desktop `reorderMessagesForDisplay`, we float it to the end
 * of its turn for display. One deliberate divergence from desktop: where
 * desktop drops a duplicate timer for the same turn, this module floats all N
 * it finds — never hiding data over a dedupe heuristic. Mixed-part system
 * messages are not timers and stay where they are.
 *
 * This is the single shared timer-shape predicate: the display float here and
 * the transcript's spinner suppression ({@link hasLiveTurnTimer}) must agree,
 * or a message could suppress the fallback spinner while never rendering a
 * visible timer row.
 */
export function isTurnTimerMessage(message: PortalChatMessage): boolean {
  if (message.role !== 'system') {
    return false;
  }
  const parts = message.parts ?? [];
  return parts.length > 0 && parts.every((part) => part.kind === 'turn_timer');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the **current turn** (messages after the last `user` message)
 * carries a live turn timer — a row that already renders its own ticking
 * "Working…" spinner, making a transcript-level fallback spinner a duplicate.
 *
 * The scan is deliberately scoped to the current turn and requires the timer
 * message to still be `streaming` — strictly stricter than the store's
 * `openTimer` liveness scan (`semanticStalenessSignature` in
 * `create-chat-store.ts`), which checks only message status; this predicate
 * additionally requires a timer part without a numeric `completedAt`. An orphaned
 * timer from an interrupted earlier turn — `completedAt: null` forever, e.g.
 * after a mid-turn client `dispose()` that never settles open turns — must not
 * suppress a later turn's send→timer-gap fallback spinner. The walk therefore
 * starts at the tail and stops at the first `user` message.
 */
export function hasLiveTurnTimer(
  messages: readonly PortalChatMessage[],
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'user') break;
    if (!isTurnTimerMessage(message) || message.status !== 'streaming') {
      continue;
    }
    const live = (message.parts ?? []).some((part) => {
      const data = isRecord(part.data) ? part.data : {};
      return typeof data['completedAt'] !== 'number';
    });
    if (live) {
      return true;
    }
  }
  return false;
}

/** Maps a tool family to its `PortalChatTurnGroup.summary` count field. */
const TOOL_FAMILY_TO_SUMMARY_FIELD: Readonly<
  Record<
    PortalChatToolFamily,
    keyof NonNullable<PortalChatTurnGroup['summary']>
  >
> = {
  read: 'readCount',
  edit: 'editCount',
  write: 'writeCount',
  plan: 'planCount',
  bash: 'bashCount',
  grep: 'grepCount',
  glob: 'globCount',
  todo: 'todoCount',
  web: 'webCount',
  agent: 'agentCount',
  'ask-user': 'askUserCount',
  'script-output': 'scriptOutputCount',
  claude: 'claudeCount',
  watcher: 'watcherCount',
  canopy: 'canopyCount',
  graph: 'graphCount',
  skill: 'otherCount',
  monitor: 'otherCount',
  'app-advisor': 'otherCount',
  'pipeline-editor': 'otherCount',
  'computer-use': 'computerUseCount',
  unknown: 'otherCount',
};

/** Tally visible prose, thinking, and tool parts across intermediate messages. */
function summarizeIntermediate(
  intermediate: readonly PortalChatMessage[],
): PortalChatTurnGroup['summary'] {
  const counts: Record<string, number> = {};
  for (const message of intermediate) {
    if (message.text.trim().length > 0) {
      counts['messageCount'] = (counts['messageCount'] ?? 0) + 1;
    }
    for (const part of message.parts ?? []) {
      if (part.kind === 'thinking') {
        const data = isRecord(part.data) ? part.data : {};
        if (
          typeof data['text'] === 'string' &&
          data['text'].trim().length > 0
        ) {
          counts['thinkingCount'] = (counts['thinkingCount'] ?? 0) + 1;
        }
        continue;
      }
      if (part.kind === 'agent') {
        counts['agentCount'] = (counts['agentCount'] ?? 0) + 1;
        continue;
      }
      if (part.kind !== 'tool_use') {
        continue;
      }
      const field = TOOL_FAMILY_TO_SUMMARY_FIELD[part.toolFamily ?? 'unknown'];
      counts[field] = (counts[field] ?? 0) + 1;
    }
  }
  const summary: Record<string, number> = {};
  for (const [field, value] of Object.entries(counts)) {
    if (value > 0) {
      summary[field] = value;
    }
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/**
 * Whether a message's concluding content is an `ExitPlanMode` plan.
 *
 * A plan-mode turn ends on a tool call, not on prose: the plan lives in the
 * tool input and the message carries no `text`. Desktop's `splitFinalMessages`
 * anchors on the same block, so without this the shared transcript buries a
 * finished plan behind the collapsed "N steps" chip (CAN-3019).
 */
function isExitPlanModeMessage(message: PortalChatMessage): boolean {
  return (message.parts ?? []).some((part) => {
    // `PortalChatPart.data` is `unknown` by contract, so narrow rather than
    // assert: both producers (`runtime-chat-projection` for live frames and
    // `persisted-chat-projection` for a reloaded/seeded transcript) put the
    // raw provider tool name on `data.toolName`.
    const data: unknown = part.data;
    if (
      part.kind !== 'tool_use' ||
      typeof data !== 'object' ||
      data === null ||
      !('toolName' in data)
    ) {
      return false;
    }
    return data.toolName === 'ExitPlanMode';
  });
}

function hasDisplayText(message: PortalChatMessage): boolean {
  return (
    message.text.trim().length > 0 ||
    (message.parts ?? []).some(
      (part) =>
        part.kind === 'text' &&
        isRecord(part.data) &&
        isClaudeAiCreditsFallbackErrorCode(part.data['errorCode']),
    )
  );
}

/**
 * A host notice that stays beside the final answer when a turn collapses: a
 * system text message, or the line where the account proxy moved the chat to
 * another account. Mirrors desktop's `splitFinalMessages`.
 */
function isSystemTextMessage(message: PortalChatMessage): boolean {
  return (
    message.role === 'system' &&
    (hasDisplayText(message) ||
      (message.parts ?? []).some((part) => part.kind === 'account_switch'))
  );
}

const TASK_MANAGEMENT_TOOLS = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TodoWrite',
]);

function hasImagePart(message: PortalChatMessage): boolean {
  return (message.parts ?? []).some((part) => part.kind === 'image');
}

function isTaskManagementMessage(message: PortalChatMessage): boolean {
  const parts = message.parts ?? [];
  return (
    message.text.trim().length === 0 &&
    parts.length > 0 &&
    parts.every((part) => {
      if (part.kind !== 'tool_use') return false;
      const data = isRecord(part.data) ? part.data : {};
      return (
        typeof data['toolName'] === 'string' &&
        TASK_MANAGEMENT_TOOLS.has(data['toolName'])
      );
    })
  );
}

/**
 * Split a turn's assistant messages into the collapsed "intermediate" prefix
 * and the inline "final" suffix. The final segment starts at the last message
 * carrying real textual content (the concluding answer), or — when the turn
 * concluded with a plan instead of prose — at that `ExitPlanMode` message; if
 * neither exists, the whole turn is intermediate. Mirrors the intent of the
 * desktop `splitFinalMessages` without its block-level rules.
 *
 * A plan anchor also ENDS the final segment, matching desktop's
 * `trailingToolMessages`: Canopy denies `ExitPlanMode` on purpose, so the
 * provider emits a "the user rejected this tool use" result immediately after
 * the plan. Desktop never renders it on a collapsed turn, and neither may we,
 * or the transcript tells the user they refused the plan they just wrote.
 * Messages after the anchor stay `intermediate`, which also keeps them in the
 * collapsed summary's counts — again matching desktop, whose `computeTurnSummary`
 * tallies intermediate and trailing tool messages together.
 */
function splitFinal(assistant: readonly PortalChatMessage[]): {
  intermediate: PortalChatMessage[];
  final: PortalChatMessage[];
} {
  const hasNotices = assistant.some(isSystemTextMessage);
  let finalStart = assistant.length;
  let finalEnd = assistant.length;
  for (let i = assistant.length - 1; i >= 0; i--) {
    if (hasNotices && isSystemTextMessage(assistant[i])) continue;
    if (
      hasDisplayText(assistant[i]) ||
      hasImagePart(assistant[i]) ||
      isExitPlanModeMessage(assistant[i])
    ) {
      finalStart = i;
      finalEnd = i + 1;
      break;
    }
  }
  if (finalStart < assistant.length) {
    for (let i = finalStart - 1; i >= 0; i--) {
      const message = assistant[i];
      if (hasNotices && isSystemTextMessage(message)) continue;
      if (
        hasDisplayText(message) ||
        hasImagePart(message) ||
        isExitPlanModeMessage(message) ||
        isTaskManagementMessage(message)
      ) {
        finalStart = i;
        continue;
      }
      break;
    }
  }
  if (!hasNotices)
    return {
      intermediate: [
        ...assistant.slice(0, finalStart),
        ...assistant.slice(finalEnd),
      ],
      final: assistant.slice(finalStart, finalEnd),
    };
  return {
    intermediate: [
      ...assistant.slice(0, finalStart),
      ...assistant.slice(finalEnd),
    ].filter((message) => !isSystemTextMessage(message)),
    final: assistant.filter(
      (message, index) =>
        isSystemTextMessage(message) ||
        (index >= finalStart && index < finalEnd),
    ),
  };
}

/** Structural equality for two completed groups (id lists + summary). */
function groupsEqual(a: PortalChatTurnGroup, b: PortalChatTurnGroup): boolean {
  if (a.userMessageId !== b.userMessageId) return false;
  if (a.complete !== b.complete) return false;
  if (a.revertedAt !== b.revertedAt) return false;
  if (a.revertedPreview !== b.revertedPreview) return false;
  if (!arraysEqual(a.intermediateMessageIds, b.intermediateMessageIds)) {
    return false;
  }
  if (!arraysEqual(a.finalMessageIds, b.finalMessageIds)) return false;
  if (!arraysEqual(a.expandedMessageIds ?? [], b.expandedMessageIds ?? [])) {
    return false;
  }
  // Stringify equality is sound here because `summarizeIntermediate` is the only
  // producer of `summary` and always inserts keys in `TOOL_FAMILY_TO_SUMMARY_FIELD`
  // order, so two equal summaries serialize identically. Keep that invariant if
  // another code path ever constructs a summary.
  return JSON.stringify(a.summary) === JSON.stringify(b.summary);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface RawTurn {
  userMessageId: string;
  assistant: PortalChatMessage[];
  /** Turn-timer messages, floated after the final answer for display. */
  timers: PortalChatMessage[];
  complete: boolean;
}

/** Partition an ordered message list into user-anchored turns. */
function partitionTurns(messages: readonly PortalChatMessage[]): RawTurn[] {
  const turns: RawTurn[] = [];
  let current: RawTurn | null = null;
  for (const message of messages) {
    if (message.role === 'user') {
      if (current) {
        current.complete = true;
      }
      current = {
        userMessageId: message.messageId,
        assistant: [],
        timers: [],
        complete: true,
      };
      turns.push(current);
      continue;
    }
    // Assistant/system messages before any user message have no anchor to
    // attach to; skip them (they do not occur in normal transcripts).
    if (!current) {
      continue;
    }
    if (isTurnTimerMessage(message)) {
      current.timers.push(message);
    } else {
      current.assistant.push(message);
    }
    if (!isTerminalStatus(message.status)) {
      current.complete = false;
    }
  }
  return turns;
}

/**
 * Compute turn groups from an ordered message list, reusing cached object
 * references for completed groups that have not changed. The caller owns the
 * `cache` and passes it in; this function mutates it in place. A chat-id
 * mismatch transparently resets the cache.
 */
export function computeIncrementalTurnGroups(
  chatId: string,
  messages: readonly PortalChatMessage[],
  cache: TurnGroupCache,
  latestTurnActive = false,
): PortalChatTurnGroup[] {
  if (cache.chatId !== chatId) {
    cache.chatId = chatId;
    cache.completedGroups = new Map();
  }

  const turns = partitionTurns(messages);
  const nextCompleted = new Map<string, PortalChatTurnGroup>();

  const result = turns.map((turn, index): PortalChatTurnGroup => {
    const complete =
      turn.complete && (!latestTurnActive || index < turns.length - 1);
    const { intermediate, final } = splitFinal(turn.assistant);
    const visibleIntermediate = complete ? intermediate : [];
    const visibleFinal = complete ? final : turn.assistant;
    const group: PortalChatTurnGroup = {
      userMessageId: turn.userMessageId,
      intermediateMessageIds: visibleIntermediate.map((m) => m.messageId),
      // Timers render after the concluding answer (and outside the collapsed
      // intermediate chip), matching the desktop transcript order.
      finalMessageIds: [
        ...visibleFinal.map((m) => m.messageId),
        ...turn.timers.map((m) => m.messageId),
      ],
      expandedMessageIds: [
        ...turn.assistant.map((m) => m.messageId),
        ...turn.timers.map((m) => m.messageId),
      ],
      complete,
      summary: summarizeIntermediate(visibleIntermediate),
    };

    if (!complete) {
      // Streaming turns change every frame; never cache them.
      return group;
    }

    const cached = cache.completedGroups.get(turn.userMessageId);
    const resolved = cached && groupsEqual(cached, group) ? cached : group;
    nextCompleted.set(turn.userMessageId, resolved);
    return resolved;
  });

  cache.completedGroups = nextCompleted;
  return result;
}

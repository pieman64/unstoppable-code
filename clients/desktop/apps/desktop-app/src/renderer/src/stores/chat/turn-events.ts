// Predicates over chat events, turn lifecycle, and terminal-event payloads.
import type { WorktreeDiscovery } from '@canopy/desktop-shared/types';
import { CODEX_MISSING_ROLLOUT_ERROR_RE } from './constants';
import { isRecord } from './utils';
import type { ChatBlock, ChatMessage, ChatTab } from './types';

export function isCodexMissingRolloutResumeError(message: string): boolean {
  return CODEX_MISSING_ROLLOUT_ERROR_RE.test(message);
}

interface SlashCommandParsingOptions {
  readonly allowDollarTrigger?: boolean;
}

export function getLeadingSlashCommandName(
  text: string,
  options?: SlashCommandParsingOptions,
): string | null {
  const trimmed = text.trim();
  // `$` is a Codex-only skill trigger. This parser also feeds stale-session
  // detection for non-Codex tabs, where `$PATH` and `$100` are ordinary prose,
  // so dollar parsing must remain an explicit provider-aware opt-in.
  const match = options?.allowDollarTrigger
    ? trimmed.match(/^[/$](\S+)/)
    : trimmed.match(/^\/(\S+)/);
  return match?.[1] ?? null;
}

export function isKnownSlashCommand(
  text: string,
  discovery: WorktreeDiscovery | undefined,
  options?: SlashCommandParsingOptions,
): boolean {
  const slashCommandName = getLeadingSlashCommandName(text, options);
  if (!slashCommandName || !discovery) {
    return false;
  }

  return discovery.slashCommands.some(
    (command) =>
      command.name.replace(/^\/+/, '').toLowerCase() ===
      slashCommandName.toLowerCase(),
  );
}

export function shouldSuppressImplicitStaleSessionDetection(
  droppedMessageText: string,
  discovery: WorktreeDiscovery | undefined,
  options?: SlashCommandParsingOptions,
): boolean {
  const slashCommandName = getLeadingSlashCommandName(
    droppedMessageText,
    options,
  );
  if (!slashCommandName) {
    return false;
  }

  if (!discovery) {
    return false;
  }

  return isKnownSlashCommand(droppedMessageText, discovery, options) === false;
}

/**
 * True for chat events that represent a *new* agent/user turn producing content
 * (as opposed to terminal result/error, layout-only, or sync events). Used to
 * decide whether an archived chat should be un-archived because it received a
 * fresh response after its turn ended.
 */
export function isNewResponseTurnEventData(
  data: Record<string, unknown>,
): boolean {
  if (data.type === 'codex') {
    const event = isRecord(data.event) ? data.event : null;
    if (!event) {
      return false;
    }
    const eventType = typeof event?.type === 'string' ? event.type : '';
    return (
      eventType !== 'turn.completed' &&
      eventType !== 'turn.failed' &&
      eventType !== 'error'
    );
  }

  return (
    data.type === 'assistant' ||
    data.type === 'user' ||
    data.type === 'canopy_user_prompt'
  );
}

export function hasExplicitSessionExpirySignal(
  data: Record<string, unknown>,
): boolean {
  const terminalMessage = getTerminalMessage(data);

  return /session (?:has )?expired|expired session/i.test(terminalMessage);
}

export function getTerminalMessage(data: Record<string, unknown>): string {
  if (typeof data.error === 'string') {
    return data.error;
  }
  if (typeof data.result === 'string') {
    return data.result;
  }
  return '';
}

// SDK `terminal_reason` values that mean the user aborted the turn (e.g. hit Stop
// mid-stream). The Claude SDK can deliver these on a gracefully-yielded result with
// `is_error: true`, so recognize them as a clean cancellation rather than an error.
// NOTE: keep this list in sync with the duplicate in the main process
// (`USER_ABORT_TERMINAL_REASONS` in main/lib/chat-turn-audit.ts). They live in
// separate process bundles so a shared import isn't appropriate here.
export const USER_ABORT_TERMINAL_REASONS = [
  'aborted_streaming',
  'aborted_tools',
];

export function isUserCancellationTerminal(
  data: Record<string, unknown>,
): boolean {
  // Abort reasons only ever arrive on `result` events; guard on the type so a
  // future non-result event carrying a matching string can't be misclassified.
  if (
    data.type === 'result' &&
    typeof data.terminal_reason === 'string' &&
    USER_ABORT_TERMINAL_REASONS.includes(data.terminal_reason)
  ) {
    return true;
  }
  const terminalMessage = getTerminalMessage(data).trim();
  return (
    /^(?:session aborted|turn cancelled|cancelled)$/i.test(terminalMessage) ||
    /aborted by user/i.test(terminalMessage)
  );
}

export function getEventTurnUserMessageId(
  data: Record<string, unknown>,
): string | undefined {
  return typeof data.canopy_turn_user_message_id === 'string'
    ? data.canopy_turn_user_message_id
    : undefined;
}

export function getOpenTurnUserMessageId(
  messages: ChatMessage[],
): string | undefined {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    const hasOpenTimer = message.blocks.some(
      (block) =>
        block.type === 'turn_timer' &&
        block.completedAt === null &&
        (block.pausedAt == null || block.resumedAt != null),
    );
    if (!hasOpenTimer) {
      continue;
    }

    for (let userIndex = messageIndex - 1; userIndex >= 0; userIndex -= 1) {
      const userMessage = messages[userIndex];
      if (userMessage.role === 'user') {
        return userMessage.id;
      }
    }
    return undefined;
  }

  return undefined;
}

export function getLatestTurnUserMessageId(
  messages: ChatMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user') {
      return message.id;
    }
  }

  return undefined;
}

export function hasUserMessageIdAfterOpenTurnTimer(
  messages: ChatMessage[],
  userMessageId: string,
): boolean {
  let foundOpenTurnTimer = false;
  for (const message of messages) {
    if (foundOpenTurnTimer) {
      if (message.role === 'user' && message.id === userMessageId) {
        return true;
      }
      continue;
    }

    foundOpenTurnTimer = message.blocks.some(
      (block) =>
        block.type === 'turn_timer' &&
        block.completedAt == null &&
        (block.pausedAt == null || block.resumedAt != null),
    );
  }

  return false;
}

export function isStaleTurnEvent(
  tab: ChatTab,
  data: Record<string, unknown>,
): boolean {
  const eventTurnUserMessageId = getEventTurnUserMessageId(data);
  if (!eventTurnUserMessageId) {
    return false;
  }
  const openTurnUserMessageId = getOpenTurnUserMessageId(tab.messages);
  if (openTurnUserMessageId !== undefined) {
    return (
      eventTurnUserMessageId !== openTurnUserMessageId &&
      !hasUserMessageIdAfterOpenTurnTimer(tab.messages, eventTurnUserMessageId)
    );
  }

  const latestTurnUserMessageId = getLatestTurnUserMessageId(tab.messages);
  return (
    latestTurnUserMessageId !== undefined &&
    eventTurnUserMessageId !== latestTurnUserMessageId
  );
}

export function isTurnPreludeEvent(data: Record<string, unknown>): boolean {
  return (
    data.type === 'canopy_user_prompt' || data.type === 'canopy_injected_prompt'
  );
}

export function isForcedQueuedMessageCleanupTerminal(
  data: Record<string, unknown>,
): boolean {
  if (isUserCancellationTerminal(data)) {
    return true;
  }

  // Claude's SDK can settle an aborted query by closing the stream without a
  // cancellation-shaped result. The provider safety net then emits
  // "Session ended"; when a forced queued message already started the next turn,
  // that stale cleanup marker must not close the new turn timer.
  return (
    data.type === 'result' &&
    data.canopy_session_continues !== true &&
    getTerminalMessage(data).trim().toLowerCase() === 'session ended'
  );
}

export function shouldIgnoreForcedQueuedMessageCleanupTerminal(
  tab: ChatTab,
  data: Record<string, unknown>,
): boolean {
  if (tab.ignoreNextCancellationTerminal !== true) {
    return false;
  }

  const eventTurnUserMessageId = getEventTurnUserMessageId(data);
  if (!eventTurnUserMessageId) {
    return true;
  }

  const openTurnUserMessageId = getOpenTurnUserMessageId(tab.messages);
  return (
    openTurnUserMessageId === undefined ||
    eventTurnUserMessageId !== openTurnUserMessageId
  );
}

export function hasAssistantMessageAfterLastUser(
  messages: ChatMessage[],
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant') {
      return true;
    }
    if (message.role === 'user') {
      return false;
    }
  }

  return false;
}

export function getLastCompletedTurnDuration(
  messages: ChatMessage[],
): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    for (
      let blockIndex = message.blocks.length - 1;
      blockIndex >= 0;
      blockIndex -= 1
    ) {
      const block = message.blocks[blockIndex];
      if (block.type !== 'turn_timer') {
        continue;
      }
      if (block.completedAt === null) {
        return null;
      }
      if (block.startedAt === undefined) {
        return null;
      }
      const pausedDurationMs = getTurnTimerPausedDurationMs(
        block,
        block.completedAt,
      );
      return Math.max(
        0,
        block.completedAt - block.startedAt - pausedDurationMs,
      );
    }
  }

  return null;
}

export function getTurnTimerPausedDurationMs(
  block: ChatBlock & { type: 'turn_timer' },
  endAt: number,
): number {
  const accumulated =
    typeof block.accumulatedPausedDurationMs === 'number'
      ? Math.max(0, block.accumulatedPausedDurationMs)
      : block.pausedAt != null && block.resumedAt != null
        ? Math.max(
            0,
            block.resumedAt - Math.max(block.startedAt ?? 0, block.pausedAt),
          )
        : 0;
  const activePause =
    block.pausedAt != null && block.resumedAt == null
      ? Math.max(0, endAt - Math.max(block.startedAt ?? 0, block.pausedAt))
      : 0;
  return accumulated + activePause;
}

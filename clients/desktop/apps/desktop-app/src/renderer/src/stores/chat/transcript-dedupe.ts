// Transcript fingerprinting and replayed-message dedupe helpers used when
// merging live/persisted/terminal-synced chat transcripts.
import type {
  AgentArtifactCarryByTurn,
  ClaudeTerminalTranscriptSyncEventData,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { normalizeAgentArtifactCarryByTurn } from '@canopy/desktop-shared/lib/agent-artifacts';
import {
  blockFingerprint,
  LAYOUT_BLOCK_TYPES,
  normalizeFingerprintText,
} from '@canopy/desktop-shared/lib/transcript-fingerprint';
import { isRecord } from './utils';
import { isTurnDiffsRecord } from './turn-diffs';
import type { ChatMessage } from './types';

// Fingerprinting and the layout-block set live in `@canopy/agent-transcript`
// so main and the renderer cannot drift (CAN-3083). Re-exported here because
// this module has always been their renderer-side import path.
export { blockFingerprint, normalizeFingerprintText };

export function isPersistedChatMessage(
  value: unknown,
): value is PersistedChatMessage {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    (value.role === 'user' ||
      value.role === 'assistant' ||
      value.role === 'system') &&
    Array.isArray(value.blocks) &&
    typeof value.timestamp === 'number'
  );
}

export function isClaudeTerminalTranscriptSyncEventData(
  value: unknown,
): value is ClaudeTerminalTranscriptSyncEventData {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.type === 'claude_terminal_transcript_sync' &&
    Array.isArray(value.messages) &&
    value.messages.every(isPersistedChatMessage) &&
    typeof value.importedEventCount === 'number' &&
    (value.transcriptPath === undefined ||
      typeof value.transcriptPath === 'string') &&
    (value.replayedFromStart === undefined ||
      typeof value.replayedFromStart === 'boolean') &&
    (value.compactionAppended === undefined ||
      typeof value.compactionAppended === 'boolean') &&
    (value.settingsSync === undefined || isRecord(value.settingsSync)) &&
    (value.turnDiffs === undefined || isTurnDiffsRecord(value.turnDiffs))
  );
}

export function isTranscriptLayoutMessage(
  message: PersistedChatMessage,
): boolean {
  return message.blocks.every((block) => LAYOUT_BLOCK_TYPES.has(block.type));
}

export function messageFingerprint(message: PersistedChatMessage): string {
  return `${message.role}:${message.blocks.map(blockFingerprint).join('|')}`;
}

export function comparableMessages(
  messages: PersistedChatMessage[],
): Array<{ index: number; fingerprint: string }> {
  const result: Array<{ index: number; fingerprint: string }> = [];
  messages.forEach((message, index) => {
    if (!isTranscriptLayoutMessage(message)) {
      result.push({ index, fingerprint: messageFingerprint(message) });
    }
  });
  return result;
}

export function dropReplayedExistingPrefix(
  existing: PersistedChatMessage[],
  incoming: PersistedChatMessage[],
): PersistedChatMessage[] {
  const existingComparable = comparableMessages(existing);
  const incomingComparable = comparableMessages(incoming);
  const max = Math.min(existingComparable.length, incomingComparable.length);
  for (let count = max; count > 0; count -= 1) {
    let matches = true;
    for (let i = 0; i < count; i += 1) {
      const existingIndex = existingComparable.length - count + i;
      if (
        existingComparable[existingIndex]?.fingerprint !==
        incomingComparable[i]?.fingerprint
      ) {
        matches = false;
        break;
      }
    }
    if (matches) {
      let start = (incomingComparable[count - 1]?.index ?? -1) + 1;
      while (
        start < incoming.length &&
        isTranscriptLayoutMessage(incoming[start])
      ) {
        start += 1;
      }
      return incoming.slice(start);
    }
  }
  return incoming;
}

export function appendUniqueMessages(
  existing: PersistedChatMessage[],
  incoming: PersistedChatMessage[],
  options: { replayedFromStart?: boolean } = {},
): PersistedChatMessage[] {
  const messages =
    options.replayedFromStart === true
      ? dropReplayedExistingPrefix(existing, incoming)
      : incoming;
  let next = existing;
  for (const message of messages) {
    if (next.some((candidate) => candidate.id === message.id)) {
      continue;
    }
    if (next === existing) {
      next = [...existing];
    }
    next.push(message);
  }
  return next;
}

/** Keep optional carry metadata aligned with the transcript after replay dedupe. */
export function dedupeAgentArtifactCarryForTranscript(
  carry: unknown,
  messages: readonly PersistedChatMessage[],
): AgentArtifactCarryByTurn | undefined {
  return normalizeAgentArtifactCarryByTurn(
    carry,
    new Set(
      messages
        .filter((message) => message.role === 'user')
        .map((message) => message.id),
    ),
  );
}

/**
 * Remove transcript-synchronized timer blocks while a deferred-tools reload is
 * replacing the provider session. The interrupted segment may report a
 * completed fallback timer, but the renderer-owned logical timer must remain
 * open until the resumed segment actually completes.
 */
export function omitTurnTimerBlocks(
  messages: PersistedChatMessage[],
): PersistedChatMessage[] {
  const filtered: PersistedChatMessage[] = [];
  for (const message of messages) {
    const blocks = message.blocks.filter(
      (block) => block.type !== 'turn_timer',
    );
    if (blocks.length === 0) {
      continue;
    }
    filtered.push(
      blocks.length === message.blocks.length
        ? message
        : { ...message, blocks },
    );
  }
  return filtered;
}

export function newestUserTurnHasText(
  messages: ChatMessage[],
  text: string,
): boolean {
  const normalizedText = normalizeFingerprintText(text);
  let newestUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      newestUserMessageIndex = index;
      break;
    }
  }
  if (newestUserMessageIndex < 0) return false;

  const newestUserMessage = messages[newestUserMessageIndex];
  if (!newestUserMessage) return false;
  const newestUserMessageMatches = newestUserMessage.blocks.some(
    (block) =>
      block.type === 'text' &&
      normalizeFingerprintText(block.text) === normalizedText,
  );
  if (!newestUserMessageMatches) return false;

  const tail = messages.slice(newestUserMessageIndex + 1);
  return (
    tail.every((message) => message.role === 'system') &&
    tail.some((message) =>
      message.blocks.some(
        (block) => block.type === 'turn_timer' && block.completedAt === null,
      ),
    )
  );
}

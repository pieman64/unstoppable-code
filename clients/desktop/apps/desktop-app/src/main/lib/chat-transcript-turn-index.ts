import {
  extractCanonicalAgentArtifacts,
  serializeAgentArtifactReceipts,
} from '@canopy/protocol/agent-artifacts';
import { isArtifactDispatchTool } from '@canopy/desktop-shared/lib/agent-artifact-projection';
import { isRecord } from './type-guards';
import { isPersistedChatMessage } from './persisted-chat-message-validation';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import {
  groupIntoTurns,
  splitFinalMessages,
  computeTurnSummary,
} from '@canopy/desktop-shared/lib/turn-utils';
import {
  mergeToolResults,
  reorderMessagesForDisplay,
} from '@canopy/desktop-shared/lib/message-transforms';
import type { TranscriptTurnSummary } from '@canopy/agent-transcript/transcript-storage';
import {
  collectTurnFiles,
  turnFilePath,
  turnFileTarget,
} from '@canopy/desktop-shared/lib/turn-files';

export interface IndexedTurn extends Omit<TranscriptTurnSummary, 'before'> {
  /** Raw ordinals, including source rows of merged tool results. */
  retained: number[];
  frame: number[];
  frameTimer?: PersistedChatMessage;
}

export interface TranscriptTurnIndex {
  version: 5;
  committedByteLength: number;
  committedMessageCount: number;
  /** Ended-turn projections use exactly the same display helpers as the UI. */
  turns: IndexedTurn[];
}

export function indexTurn(
  rows: PersistedChatMessage[],
  start: number,
  followedByTurn = false,
): IndexedTurn {
  const hasTimer = rows.some((row) =>
    row.blocks.some((block) => block.type === 'turn_timer'),
  );
  const frameTimer: PersistedChatMessage | undefined =
    // A lone historical prompt provides no evidence of agent activity. Adding
    // a frame timer would turn it into a phantom running (or completed) turn.
    !hasTimer && rows.length > 1 && rows[0].role === 'user'
      ? {
          id: `${rows[0].id}-implicit-turn-timer`,
          role: 'system',
          timestamp: rows[rows.length - 1].timestamp,
          blocks: [
            {
              type: 'turn_timer',
              completedAt: followedByTurn
                ? rows[rows.length - 1].timestamp
                : null,
            },
          ],
        }
      : undefined;
  const rendered = groupIntoTurns(
    mergeToolResults(
      reorderMessagesForDisplay(frameTimer ? [...rows, frameTimer] : rows),
    ),
  );
  const group = rendered.find((item) => item.kind === 'turn-group');
  const assistantMessages =
    group?.kind === 'turn-group' ? group.assistantMessages : [];
  const { intermediateMessages, finalMessages, trailingToolMessages } =
    splitFinalMessages(assistantMessages);
  const retainedIds = new Set(
    group?.kind === 'turn-group' && group.isComplete
      ? finalMessages.map((message) => message.id)
      : [],
  );
  for (const message of finalMessages)
    for (const block of message.blocks) {
      if (
        'result' in block &&
        block.result &&
        'messageId' in block.result &&
        typeof block.result.messageId === 'string'
      )
        retainedIds.add(block.result.messageId);
    }
  // Questions can outlive completion and optimistic answer reservations. Keep
  // their source rows; the existing renderer filters settled/dismissed cards.
  for (const row of rows)
    if (
      row.blocks.some((block) => block.type === 'text' && block.asyncQuestion)
    )
      retainedIds.add(row.id);
  // A collapsed turn keeps its visuals, so keep the rows that render one: the
  // owning result and the call it answers.
  const visualToolUseIds = new Set(
    rows.flatMap((row) =>
      row.blocks.flatMap((block) =>
        block.type === 'tool_result' &&
        !block.isError &&
        (block.visualRef ||
          (isArtifactDispatchTool(block.toolName) &&
            (serializeAgentArtifactReceipts(block.agentArtifacts).length > 0 ||
              extractCanonicalAgentArtifacts(block.output).length > 0)))
          ? [block.toolUseId]
          : [],
      ),
    ),
  );
  if (visualToolUseIds.size > 0)
    for (const row of rows)
      if (
        row.blocks.some(
          (block) =>
            (block.type === 'tool_use' || block.type === 'tool_result') &&
            visualToolUseIds.has(block.toolUseId),
        )
      )
        retainedIds.add(row.id);
  const frame = rows.flatMap((row, index) =>
    index === 0 || row.blocks.some((block) => block.type === 'turn_timer')
      ? [start + index]
      : [],
  );
  const retained = rows.flatMap((row, index) =>
    retainedIds.has(row.id) || index >= rows.length - 16 ? [start + index] : [],
  );
  return {
    id: rows[0].id,
    start,
    end: start + rows.length,
    complete: group?.kind === 'turn-group' && group.isComplete,
    summary: computeTurnSummary([
      ...intermediateMessages,
      ...trailingToolMessages,
    ]),
    finalMessageIds: finalMessages.map((message) => message.id),
    files: collectTurnFiles(assistantMessages),
    frame,
    ...(frameTimer ? { frameTimer } : {}),
    retained,
  };
}

/**
 * Stream the raw source one turn at a time; never hydrate the whole chat.
 * Turn splits depend only on each row, so a turn that ends before an
 * unchanged boundary row is identical in any log sharing that prefix.
 */
export async function buildTurnIndex(
  source: AsyncIterable<PersistedChatMessage> | Iterable<PersistedChatMessage>,
  start = 0,
): Promise<IndexedTurn[]> {
  const turns: IndexedTurn[] = [];
  let rows: PersistedChatMessage[] = [];
  let ordinal = start;
  for await (const message of source) {
    if (rows.length > 0 && isUserTurnBoundary(message)) {
      turns.push(indexTurn(rows, ordinal, true));
      ordinal += rows.length;
      rows = [];
      // Let IPC and cancellation callbacks run between completed turns.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    rows.push(message);
  }
  if (rows.length > 0) turns.push(indexTurn(rows, ordinal));
  return turns;
}

export function isTranscriptTurnIndex(
  value: unknown,
): value is TranscriptTurnIndex {
  if (
    !isRecord(value) ||
    value.version !== 5 ||
    !Number.isSafeInteger(value.committedByteLength) ||
    !Number.isSafeInteger(value.committedMessageCount) ||
    !Array.isArray(value.turns)
  )
    return false;
  let end = 0;
  const valid = value.turns.every((turn: unknown) => {
    if (
      !isRecord(turn) ||
      typeof turn.id !== 'string' ||
      typeof turn.start !== 'number' ||
      typeof turn.end !== 'number' ||
      !Number.isSafeInteger(turn.start) ||
      !Number.isSafeInteger(turn.end) ||
      turn.start !== end ||
      turn.end <= turn.start ||
      typeof turn.complete !== 'boolean' ||
      !Array.isArray(turn.finalMessageIds) ||
      !turn.finalMessageIds.every((id: unknown) => typeof id === 'string') ||
      !isRecord(turn.summary) ||
      !Array.isArray(turn.files) ||
      !turn.files.every((file: unknown) => recordFile(file))
    )
      return false;
    const counts = turn.summary;
    if (
      !Object.keys(computeTurnSummary([])).every(
        (key) =>
          typeof counts[key] === 'number' &&
          Number.isSafeInteger(counts[key]) &&
          counts[key] >= 0,
      )
    )
      return false;
    const start = turn.start;
    const nextEnd = turn.end;
    if (
      ![turn.frame, turn.retained].every(
        (ordinals) =>
          Array.isArray(ordinals) &&
          ordinals.every(
            (ordinal: unknown) =>
              typeof ordinal === 'number' &&
              Number.isSafeInteger(ordinal) &&
              ordinal >= start &&
              ordinal < nextEnd,
          ),
      )
    )
      return false;
    if (
      turn.frameTimer !== undefined &&
      !isPersistedChatMessage(turn.frameTimer)
    )
      return false;
    end = nextEnd;
    return true;
  });
  return valid && end === value.committedMessageCount;
}

function recordFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    turnFilePath(value.path) === value.path &&
    typeof value.path === 'string' &&
    (value.target === undefined ||
      turnFileTarget(value.target) !== undefined) &&
    (value.state === 'creating' ||
      value.state === 'ready' ||
      value.state === 'failed')
  );
}

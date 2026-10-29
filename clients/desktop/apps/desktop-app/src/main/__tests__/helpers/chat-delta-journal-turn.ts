/**
 * Active-turn fixtures for the phase 10 delta-journal suites: a turn that
 * starts with a prompt and a running turn timer, streams tool calls as an
 * assistant `tool_use` row and a tool-result row per call, and ends by
 * completing the timer and going idle, the shape provider sessions commit.
 */
import type {
  ChatCoreMutation,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { idle, streaming, text, upsert } from './chat-delta-journal-scope';

export const TURN_STARTED_AT = 1_790_000_000_000;

export function timerRow(
  turn: string,
  block: Partial<{
    pausedAt: number | null;
    resumedAt: number | null;
    pauseOwnerIds: string[];
    accumulatedPausedDurationMs: number;
    completedAt: number | null;
  }> = {},
): PersistedChatMessage {
  return {
    id: `${turn}-timer`,
    role: 'system',
    timestamp: TURN_STARTED_AT,
    blocks: [
      {
        type: 'turn_timer',
        startedAt: TURN_STARTED_AT,
        completedAt: null,
        ...block,
      },
    ],
  };
}

export function toolUseRow(turn: string, call: number): PersistedChatMessage {
  return {
    id: `${turn}-call-${call}`,
    role: 'assistant',
    timestamp: TURN_STARTED_AT + call,
    blocks: [
      { type: 'text', text: `Running step ${call} of ${turn}` },
      {
        type: 'tool_use',
        toolUseId: `${turn}-tool-${call}`,
        toolName: 'mcp__canopy__GetScriptOutput',
        input: JSON.stringify({ scriptId: `transcript-performance-${call}` }),
      },
    ],
  };
}

export function toolResultRow(
  turn: string,
  call: number,
): PersistedChatMessage {
  return {
    id: `${turn}-result-${call}`,
    role: 'user',
    timestamp: TURN_STARTED_AT + call,
    blocks: [
      {
        type: 'tool_result',
        toolUseId: `${turn}-tool-${call}`,
        toolName: 'mcp__canopy__GetScriptOutput',
        output: `script transcript-performance-${call} printed line ${call}`,
        isError: false,
      },
    ],
  };
}

/** Turn start: the prompt is committed, the timer is the first active row. */
export function turnStart(chatId: string, turn: string): ChatCoreMutation[] {
  return [
    streaming(chatId, turn),
    upsert(
      chatId,
      text(turn, `Run the ${turn} turn.`, 'user', TURN_STARTED_AT),
    ),
    upsert(chatId, timerRow(turn)),
  ];
}

/** Turn end: the timer completes and the chat goes idle. */
export function turnEnd(chatId: string, turn: string): ChatCoreMutation[] {
  return [
    upsert(chatId, timerRow(turn, { completedAt: TURN_STARTED_AT + 60_000 })),
    upsert(chatId, text(`${turn}-final`, `${turn} complete.`)),
    idle(chatId),
  ];
}

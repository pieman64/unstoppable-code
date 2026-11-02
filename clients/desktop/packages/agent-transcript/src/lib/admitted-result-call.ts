import type { PersistedChatMessage } from '../types';
import { isUserTurnBoundary } from './turn-boundary';

export interface ToolCallAddress {
  readonly rowId: string;
  readonly blockOrdinal: number;
}

/** Nearest unmatched call in this canonical turn and routing lane. */
export function admittedResultCall(
  row: PersistedChatMessage,
  ordinal: number,
  previous: readonly PersistedChatMessage[],
  toolUseId: string,
): { authoritative: boolean; call?: ToolCallAddress } {
  let unmatchedResults = 0;
  const visit = (
    message: PersistedChatMessage,
    before: number,
  ): ToolCallAddress | undefined => {
    for (let at = before - 1; at >= 0; at -= 1) {
      const block = message.blocks[at];
      if (block.type === 'tool_result' && block.toolUseId === toolUseId)
        unmatchedResults += 1;
      if (block.type !== 'tool_use' || block.toolUseId !== toolUseId) continue;
      if (unmatchedResults > 0) {
        unmatchedResults -= 1;
        continue;
      }
      return { rowId: message.id, blockOrdinal: at };
    }
    return undefined;
  };
  const sameRow = visit(row, ordinal);
  if (sameRow) return { authoritative: true, call: sameRow };
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const message = previous[index];
    if (message.id === row.id) continue;
    if (
      isUserTurnBoundary(message) ||
      message.blocks.some((block) => block.type === 'turn_timer')
    )
      break;
    if (
      message.parentToolUseId !== row.parentToolUseId ||
      message.codexThreadId !== row.codexThreadId
    )
      continue;
    if (
      row.codexTurnId !== undefined &&
      message.codexTurnId !== undefined &&
      row.codexTurnId !== message.codexTurnId
    )
      continue;
    if (message.blocksRef !== undefined) return { authoritative: false };
    const call = visit(message, message.blocks.length);
    if (call) return { authoritative: true, call };
  }
  return { authoritative: true };
}

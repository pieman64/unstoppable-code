import type { ApprovalSafetyDeniedInfo } from '@canopy/protocol/approvals';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import type { ChatMessage } from '@/stores/chat/types';
import type { DisplayMessage } from './types';

function receiptOf(message: ChatMessage): ApprovalSafetyDeniedInfo | null {
  if (message.role !== 'system' || message.blocks.length !== 1) return null;
  const block = message.blocks[0];
  return block?.type === 'approval_safety_denied_info' ? block : null;
}

/** Placed copies keyed by source message, so unchanged rows keep identity. */
const placedMessages = new WeakMap<
  ChatMessage,
  { signature: string; message: ChatMessage }
>();

function withReceipts(
  message: ChatMessage,
  receipts: readonly ApprovalSafetyDeniedInfo[],
): ChatMessage {
  const signature = receipts.map((receipt) => receipt.receiptId).join('\0');
  const cached = placedMessages.get(message);
  if (cached?.signature === signature) return cached.message;
  // Results are folded into their tool rows by mergeToolResults, even when
  // delivered later. Only include adjacent result blocks in the insertion
  // point; a late result must never pull the notice past follow-up text or
  // another tool invocation.
  const rowEndIndexById = new Map<string, number>();
  message.blocks.forEach((block, index) => {
    if (block.type !== 'tool_use') return;
    let rowEnd = index;
    let next = message.blocks[rowEnd + 1];
    while (next?.type === 'tool_result' && next.toolUseId === block.toolUseId) {
      rowEnd += 1;
      next = message.blocks[rowEnd + 1];
    }
    rowEndIndexById.set(block.toolUseId, rowEnd);
  });
  const insertions = new Map<number, ApprovalSafetyDeniedInfo[]>();
  for (const receipt of receipts) {
    const index =
      receipt.toolUseId === undefined
        ? undefined
        : rowEndIndexById.get(receipt.toolUseId);
    if (index === undefined) continue;
    insertions.set(index, [...(insertions.get(index) ?? []), receipt]);
  }
  const blocks = message.blocks.flatMap((block, index) => [
    block,
    ...(insertions.get(index) ?? []),
  ]);
  const placed: ChatMessage = { ...message, blocks };
  placedMessages.set(message, { signature, message: placed });
  return placed;
}

/**
 * Moves each safety denial receipt (a system message main appends when it
 * denies a call) to just after its denied tool row, inside the message that
 * holds the row. Main commits the receipt while the provider's message is
 * still streaming, so in commit order it can land after that message's later
 * text, or before a row that has not arrived yet.
 *
 * A receipt renders exactly once: receipts sharing a `receiptId` collapse,
 * and a receipt with no matching row in the loaded messages stays where it
 * was committed. Returns `messages` itself when there is nothing to place.
 */
export function placeSafetyDenialReceipts(
  messages: ChatMessage[],
): ChatMessage[] {
  // Fast path for the hot streaming loop: most transcripts carry none.
  if (!messages.some((message) => receiptOf(message) !== null)) {
    return messages;
  }

  // Every tool row by provider ID; the same ID can recur across turns.
  const rowIndexesById = new Map<string, number[]>();
  const turnByIndex: (string | undefined)[] = [];
  let turnUserMessageId: string | undefined;
  messages.forEach((message, index) => {
    // Delegated follow-ups live in the same root transcript, but do not start
    // a new root turn. Approval receipts retain the root request's identity.
    if (
      isUserTurnBoundary(message) &&
      message.parentBlockId === undefined &&
      message.parentToolUseId === undefined
    )
      turnUserMessageId = message.id;
    turnByIndex[index] = turnUserMessageId;
    if (message.role === 'system') return;
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') continue;
      const indexes = rowIndexesById.get(block.toolUseId) ?? [];
      if (indexes[indexes.length - 1] !== index) indexes.push(index);
      rowIndexesById.set(block.toolUseId, indexes);
    }
  });

  const seen = new Set<string>();
  const placedByIndex = new Map<number, ApprovalSafetyDeniedInfo[]>();
  const removed = new Set<number>();
  messages.forEach((message, index) => {
    const receipt = receiptOf(message);
    if (!receipt) return;
    if (seen.has(receipt.receiptId)) {
      removed.add(index);
      return;
    }
    seen.add(receipt.receiptId);
    const indexes =
      receipt.toolUseId === undefined
        ? undefined
        : rowIndexesById.get(receipt.toolUseId);
    if (!indexes) return;
    // Main captures the originating user turn before awaiting the commit.
    // A delayed receipt can arrive in a later turn with a reused provider ID;
    // never infer its owner from proximity when explicit correlation exists.
    const origin = receipt.turnUserMessageId ?? turnByIndex[index];
    const originCandidates = indexes.filter(
      (rowIndex) => turnByIndex[rowIndex] === origin,
    );
    // Native Codex approvals identify a child by its thread ID, which the
    // persisted message also carries. Use that exact correlation when present.
    const threadCandidates =
      receipt.subagentId === undefined
        ? []
        : originCandidates.filter(
            (rowIndex) =>
              messages[rowIndex]?.codexThreadId === receipt.subagentId,
          );
    const candidates =
      threadCandidates.length > 0 ? threadCandidates : originCandidates;
    // Invocation IDs can also collide between root and subagent streams.
    // Keep ambiguous or unloaded history visible in commit order rather than
    // inventing a row association (including before a late child row arrives).
    if (candidates.length !== 1) return;
    const target = candidates[0];
    if (target === undefined) return;
    const targetMessage = messages[target];
    if (
      receipt.subagentId !== undefined &&
      (targetMessage?.codexThreadId !== undefined
        ? targetMessage.codexThreadId !== receipt.subagentId
        : targetMessage?.parentBlockId === undefined &&
          targetMessage?.parentToolUseId === undefined)
    )
      return;
    const list = placedByIndex.get(target) ?? [];
    list.push(receipt);
    placedByIndex.set(target, list);
    removed.add(index);
  });

  if (removed.size === 0) return messages;
  return messages.flatMap((message, index) => {
    if (removed.has(index)) return [];
    const receipts = placedByIndex.get(index);
    return receipts ? [withReceipts(message, receipts)] : [message];
  });
}

/** True when a placed safety notice rides in this message's blocks. */
export function displayMessageHasSafetyDenial(
  message: DisplayMessage,
): boolean {
  return message.blocks.some(
    (block) => block.type === 'approval_safety_denied_info',
  );
}

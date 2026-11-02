/** A submitted steer is user-authored content inside the current turn. */
export function isUserTurnBoundary(message: {
  role: string;
  blocks: readonly {
    type: string;
    asyncQuestionAnswer?: { startsTurn: boolean };
    steering?: { startsTurn: boolean };
  }[];
}): boolean {
  return (
    message.role === 'user' &&
    // Native provider transcripts can use the user role for a tool response.
    // That response still belongs to the call's turn, not a new human prompt.
    !(
      message.blocks.length > 0 &&
      message.blocks.every((block) => block.type === 'tool_result')
    ) &&
    !message.blocks.some(
      (block) =>
        block.type === 'text' &&
        (block.asyncQuestionAnswer?.startsTurn === false ||
          block.steering?.startsTurn === false),
    )
  );
}

/** A child-directed user message never starts a new root chat turn. */
export function isRootUserTurnBoundary(
  message: Parameters<typeof isUserTurnBoundary>[0] & {
    parentBlockId?: string;
    parentToolUseId?: string;
  },
): boolean {
  return (
    !message.parentBlockId &&
    !message.parentToolUseId &&
    isUserTurnBoundary(message)
  );
}

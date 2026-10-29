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
    !message.blocks.some(
      (block) =>
        block.type === 'text' &&
        (block.asyncQuestionAnswer?.startsTurn === false ||
          block.steering?.startsTurn === false),
    )
  );
}

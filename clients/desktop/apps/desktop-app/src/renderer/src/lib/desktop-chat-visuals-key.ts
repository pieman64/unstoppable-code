/**
 * The key a chat publishes its visuals under, and its Chat visuals panel
 * reads by. Kept apart from the visual host so the panel registry can build a
 * key without loading the chat UI.
 */
export function desktopChatVisualsKey(scope: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): string {
  return `${scope.projectId}/${scope.worktreeId}/${scope.chatId}`;
}

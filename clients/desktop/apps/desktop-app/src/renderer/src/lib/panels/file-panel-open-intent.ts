/** Renderer-only file-open intent; it carries no persisted state or transport. */
export interface FilePanelOpenIntent {
  readonly worktreeKey: string;
  readonly fileTabId: string;
  readonly previousChatTabId: string | null;
}

const listeners = new Set<(intent: FilePanelOpenIntent) => void>();

export function announceFilePanelOpen(intent: FilePanelOpenIntent): void {
  for (const listener of Array.from(listeners)) listener(intent);
}

export function subscribeFilePanelOpen(
  listener: (intent: FilePanelOpenIntent) => void,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

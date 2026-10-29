import type { VirtualItem } from '@tanstack/virtual-core';

interface SavedScrollPosition {
  top: number;
  left: number;
}

export type ChatScrollPositionTarget =
  | string
  | { projectId: string; worktreeId: string; chatId: string };

export interface SavedChatScrollPosition {
  chatId: string;
  top: number;
  /**
   * Dynamic row measurements captured by the transcript virtualizer. Pairing
   * these with `top` makes a remount reconstruct the same variable-height
   * scroll range before the raw offset is applied.
   */
  measurements?: VirtualItem[];
  /**
   * The user was following the newest content. A reopen goes to the current
   * bottom instead of `top`, so replies that arrived meanwhile are visible.
   */
  atBottom?: boolean;
}

const chatScrollPositions = new Map<string, SavedChatScrollPosition>();
const editorScrollPositions = new Map<string, SavedScrollPosition>();
const fileViewerScrollPositions = new Map<string, SavedScrollPosition>();

function chatScrollPositionKey(target: ChatScrollPositionTarget): string {
  return typeof target === 'string'
    ? target
    : JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

function targetChatId(target: ChatScrollPositionTarget): string {
  return typeof target === 'string' ? target : target.chatId;
}

export function getChatScrollPosition(
  target: ChatScrollPositionTarget,
): number | undefined {
  return chatScrollPositions.get(chatScrollPositionKey(target))?.top;
}

export function getSavedChatScrollPosition(
  target: ChatScrollPositionTarget,
): SavedChatScrollPosition | undefined {
  return chatScrollPositions.get(chatScrollPositionKey(target));
}

export function saveChatScrollPosition(
  target: ChatScrollPositionTarget,
  top: number,
  measurements?: VirtualItem[],
  atBottom?: boolean,
): void {
  const key = chatScrollPositionKey(target);
  const existing = chatScrollPositions.get(key);
  const followsBottom = atBottom ?? existing?.atBottom;
  chatScrollPositions.set(key, {
    chatId: targetChatId(target),
    top,
    ...(measurements !== undefined
      ? { measurements }
      : existing?.measurements
        ? { measurements: existing.measurements }
        : {}),
    ...(followsBottom !== undefined ? { atBottom: followsBottom } : {}),
  });
}

export function clearChatScrollPosition(
  target: ChatScrollPositionTarget,
): void {
  if (typeof target !== 'string') {
    chatScrollPositions.delete(chatScrollPositionKey(target));
    return;
  }
  chatScrollPositions.forEach((saved, key) => {
    if (saved.chatId === target) {
      chatScrollPositions.delete(key);
    }
  });
}

export function clearChatScrollPositions(chatIds: readonly string[]): void {
  const idSet = new Set(chatIds);
  chatScrollPositions.forEach((saved, key) => {
    if (idSet.has(saved.chatId)) {
      chatScrollPositions.delete(key);
    }
  });
}

export function getEditorScrollPosition(
  tabId: string,
): SavedScrollPosition | undefined {
  return editorScrollPositions.get(tabId);
}

export function saveEditorScrollPosition(
  tabId: string,
  position: SavedScrollPosition,
): void {
  editorScrollPositions.set(tabId, position);
}

export function clearEditorScrollPosition(tabId: string): void {
  editorScrollPositions.delete(tabId);
}

export function getFileViewerScrollPosition(
  tabId: string,
): SavedScrollPosition | undefined {
  return fileViewerScrollPositions.get(tabId);
}

export function saveFileViewerScrollPosition(
  tabId: string,
  position: SavedScrollPosition,
): void {
  fileViewerScrollPositions.set(tabId, position);
}

export function clearFileViewerScrollPosition(tabId: string): void {
  fileViewerScrollPositions.delete(tabId);
}

// ---------------------------------------------------------------------------
// Chat panel reveal bus (renderer)
// ---------------------------------------------------------------------------
//
// A tiny module-level pub/sub used to ask the panel grid to REVEAL (expand +
// select + focus) the panel bound to a chat when the user explicitly
// navigates to that chat — an unread-chat toast click or the overview unread
// card. The chat↔panel bridge only reveals when the chat-active tab CHANGES,
// so a click on a chat that is already the worktree's active tab (e.g. it went
// unread while collapsed) would clear unread without expanding its panel.
// This bus closes that gap while keeping `chatStore` panel-agnostic: the store
// only fires a request, and the panel-side subscriber (installed from
// `WorktreePart`) does the grid work. Mirrors `browserPanelActivation`.

export interface ChatPanelRevealTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

type Listener = (target: ChatPanelRevealTarget) => void;

const listeners = new Set<Listener>();

// The latest reveal, kept for a composer that mounts after it fires (the
// target worktree renders only once selected) and so missed the broadcast.
// The target composer takes it once its question is there, a newer reveal
// replaces it, and it expires once the navigation that fired it has had time
// to render, so a later visit after navigating elsewhere cannot reopen a
// prompt.
const PENDING_REVEAL_TTL_MS = 5_000;
let pendingReveal: (ChatPanelRevealTarget & { at: number }) | null = null;

/** Ask the panel grid to reveal (expand + select) the given chat's panel. */
export function requestChatPanelReveal(
  projectId: string,
  worktreeId: string,
  chatId: string,
): void {
  pendingReveal = { projectId, worktreeId, chatId, at: Date.now() };
  listeners.forEach((listener) => {
    listener({ projectId, worktreeId, chatId });
  });
}

/** Subscribe to chat-panel reveal requests. Returns an unsubscribe fn. */
export function subscribeChatPanelReveal(listener: Listener): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** Take the pending reveal when it targets this chat and is still fresh. */
export function consumeChatPanelReveal(target: ChatPanelRevealTarget): boolean {
  if (
    pendingReveal !== null &&
    Date.now() - pendingReveal.at > PENDING_REVEAL_TTL_MS
  )
    pendingReveal = null;
  if (
    pendingReveal?.projectId !== target.projectId ||
    pendingReveal.worktreeId !== target.worktreeId ||
    pendingReveal.chatId !== target.chatId
  )
    return false;
  pendingReveal = null;
  return true;
}

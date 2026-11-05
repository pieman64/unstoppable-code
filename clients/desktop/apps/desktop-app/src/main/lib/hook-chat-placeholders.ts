import type { BrowserWindow } from 'electron';

type HookChatPlaceholderReplayer = (window: BrowserWindow | null) => void;
let replayer: HookChatPlaceholderReplayer | null = null;

/** Set by hook-chat.ts when it loads; no hook chat can be queued before. */
export function registerHookChatPlaceholderReplayer(
  next: HookChatPlaceholderReplayer,
): void {
  replayer = next;
}

/** Show a window that just came up every hook chat still queued (CAN-4138). */
export function replayHookChatPlaceholders(window: BrowserWindow | null): void {
  replayer?.(window);
}

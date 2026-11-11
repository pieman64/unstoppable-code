import type { CloudChatsReconnectResult } from '@canopy/desktop-shared/types';

/** At most one user-initiated reconnect check per account in this window. */
export const CLOUD_CHATS_RECONNECT_WINDOW_MS = 10_000;

export interface WebCoreReconnectOptions {
  /** `canopyDesktopCloudChats`, evaluated in main. */
  readonly isEnabled: () => boolean;
  /** The signed-in account, or null when signed out. */
  readonly currentAccountId: () => Promise<string | null>;
  /** Rejects when the account's desktop key can't be read. */
  readonly readCredentials: () => Promise<unknown>;
  readonly now?: () => number;
}

/**
 * The cloud chats Reconnect action (CAN-4185 D7, CAN-5989). Since a
 * connection opens with the desktop key itself, there is nothing to remint:
 * Reconnect confirms the key is readable, and the renderer then reconnects,
 * which opens a fresh connection. Repeated clicks within the window share
 * one answer.
 */
export function createWebCoreReconnect(
  options: WebCoreReconnectOptions,
): () => Promise<CloudChatsReconnectResult> {
  const now = options.now ?? Date.now;
  let last: {
    readonly accountId: string;
    readonly at: number;
    readonly result: Promise<CloudChatsReconnectResult>;
  } | null = null;

  async function check(): Promise<CloudChatsReconnectResult> {
    try {
      await options.readCredentials();
      return { ok: true };
    } catch {
      return { ok: false, reason: 'unauthenticated' };
    }
  }

  return async () => {
    if (!options.isEnabled()) return { ok: false, reason: 'disabled' };
    const accountId = await options.currentAccountId();
    if (accountId === null) return { ok: false, reason: 'unauthenticated' };
    const at = now();
    if (
      last !== null &&
      last.accountId === accountId &&
      at - last.at < CLOUD_CHATS_RECONNECT_WINDOW_MS
    )
      return last.result;
    const result = check();
    last = { accountId, at, result };
    return result;
  };
}

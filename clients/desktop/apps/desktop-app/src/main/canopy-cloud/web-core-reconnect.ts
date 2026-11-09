import type { CloudChatsReconnectResult } from '@canopy/desktop-shared/types';
import type { SettingsBridgeSession } from './settings-session';
import { webCoreBridgeFailure } from './web-core-connection';

/** At most one user-initiated remint per account in this window. */
export const CLOUD_CHATS_RECONNECT_WINDOW_MS = 10_000;

export interface WebCoreReconnectOptions {
  /** `canopyDesktopCloudChats`, evaluated in main. */
  readonly isEnabled: () => boolean;
  /** The signed-in account, or null when signed out. */
  readonly currentAccountId: () => Promise<string | null>;
  readonly acquireSession: (
    accountId: string,
  ) => Promise<Pick<SettingsBridgeSession, 'ensureReady'>>;
  readonly now?: () => number;
}

/**
 * The cloud chats Reconnect action (CAN-4185 D7): the only user-initiated
 * remint of the bridge the web core connection rides. Repeated clicks within
 * the window share one attempt, so they cannot drive the auth-link mint
 * rate limit. The relay itself never remints.
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

  async function remint(accountId: string): Promise<CloudChatsReconnectResult> {
    try {
      const session = await options.acquireSession(accountId);
      await session.ensureReady({ userInitiated: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: webCoreBridgeFailure(error) };
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
    const result = remint(accountId);
    last = { accountId, at, result };
    return result;
  };
}

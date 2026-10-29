// The transcript's account switch line (CAN-4021): when the proxy moves a
// chat's requests to another account, the chat's session emits an event the
// shared transcript reducer turns into an `account_proxy_switch` line.

import { CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE } from '@canopy/agent-transcript/types';
import { onAccountProxyAccountChange } from './attribution';
import { findAccountProxyAccount } from './service';

export interface AccountProxySwitchEvent {
  readonly type: typeof CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE;
  readonly sourceEventId: string;
  readonly timestamp: number;
  readonly account: string;
  readonly previousAccount?: string;
  readonly previousAtLimit?: boolean;
  readonly provider?: string;
}

/** A name for an account the last account list did not include. */
function fallbackName(authIndex: string): string {
  return `Account ${authIndex.slice(0, 8)}`;
}

/**
 * Emits a switch event for each move of `sessionId` between accounts until
 * the returned function is called. Emitting is best effort.
 */
export function watchAccountProxySwitches(
  sessionId: string,
  emit: (event: AccountProxySwitchEvent) => void | Promise<void>,
  now: () => number = Date.now,
): () => void {
  let sequence = 0;
  return onAccountProxyAccountChange((change) => {
    if (change.sessionId !== sessionId) return;
    const account = findAccountProxyAccount(change.authIndex);
    const previous =
      change.previousAuthIndex === null
        ? null
        : findAccountProxyAccount(change.previousAuthIndex);
    const timestamp = now();
    sequence += 1;
    const event: AccountProxySwitchEvent = {
      type: CANOPY_ACCOUNT_PROXY_SWITCH_EVENT_TYPE,
      sourceEventId: `account-proxy-switch:${String(timestamp)}:${String(sequence)}`,
      timestamp,
      account: account?.label ?? fallbackName(change.authIndex),
      ...(change.previousAuthIndex !== null
        ? {
            previousAccount:
              previous?.label ?? fallbackName(change.previousAuthIndex),
          }
        : {}),
      ...(previous?.status === 'cooling' ? { previousAtLimit: true } : {}),
      ...(account?.provider ? { provider: account.provider } : {}),
    };
    void Promise.resolve()
      .then(() => emit(event))
      .catch(() => undefined);
  });
}

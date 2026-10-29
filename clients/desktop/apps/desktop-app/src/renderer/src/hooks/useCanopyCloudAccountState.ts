import { useEffect, useState } from 'react';
import { isConclusiveAccountRead } from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';

export interface CanopyCloudAccountState {
  /** The last conclusive account read, or `null` before the first one. */
  readonly account: CanopyCloudAccountPublicState | null;
  /**
   * The latest read reported an unreadable credential. Tracked apart from
   * {@link account} because that snapshot is deliberately held for a
   * non-conclusive read, while the read status is what the recovery banner
   * needs to surface.
   */
  readonly readError: boolean;
}

/**
 * The signed-in Cloud account, read on mount and re-read on every
 * `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT`. Holds the last-known-good account
 * across failed and non-conclusive reads, so an ambient re-probe never
 * flickers a signed-in user to "Sign in". Each mounted caller reads once per
 * event.
 */
export function useCanopyCloudAccountState(): CanopyCloudAccountState {
  const [account, setAccount] = useState<CanopyCloudAccountPublicState | null>(
    null,
  );
  const [readError, setReadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Per-refresh sequence token. `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT` can fire
    // in quick succession (an ambient focus re-probe immediately followed by a
    // sign-out), and the reads race. Without a token, last-*completed* wins, so
    // a slow earlier read could resolve after the sign-out read and restore the
    // former user's name and avatar indefinitely. Each `refresh()` bumps
    // `latest` so superseded resolutions no-op (last-*issued* wins). Mirrors the
    // identical guard in `useSubscriptionStatus`.
    let latest = 0;
    const refresh = (): void => {
      const seq = ++latest;
      const stale = (): boolean => cancelled || seq !== latest;
      void window.api
        .loadCanopyCloudAccount()
        .then((next) => {
          if (stale()) return;
          setReadError(next.read === 'error');
          // A degraded secure-store read *resolves* with a signed-out-looking
          // snapshot rather than rejecting, so the `.catch` below never sees it.
          // Hold last-known-good instead of blanking the row. A real sign-out
          // reports `read: 'ok'` and still clears.
          if (!isConclusiveAccountRead(next)) return;
          setAccount(next);
        })
        .catch(() => {
          // Deliberate no-op: hold the last-known-good account. This refresh
          // also runs on every ambient account-changed re-probe (window focus /
          // visibility), so blanking here flickered a signed-in user's name to
          // "Not signed in" and their avatar to the fallback icon whenever a
          // background read failed. On a first-load rejection `account` is
          // already null, so this is identical to the previous behavior. A real
          // sign-out *resolves* with `account: undefined` and still clears.
        });
    };
    refresh();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    return (): void => {
      cancelled = true;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    };
  }, []);

  return { account, readError };
}

import { useEffect, useRef, useState } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';

// Re-export the shared single-source-of-truth predicate so renderer callers can
// import both the pure check and the hook from one module.
export { isGuestAccount };

/**
 * Tracks whether the saved Canopy Cloud credential is a guest, for surfaces
 * rendered outside the account section. Re-reads whenever a sign-in / sign-out
 * elsewhere broadcasts `CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT`. Guarded so
 * components rendered in tests without the preload API do not crash.
 */
export function useIsGuestCredential(): boolean {
  const resolved = useGuestCredentialState();
  const [lastKnownGuest, setLastKnownGuest] = useState(false);
  useEffect(() => {
    if (resolved !== undefined) setLastKnownGuest(resolved);
  }, [resolved]);
  return resolved ?? lastKnownGuest;
}

/** Keeps an unresolved account read distinct from a confirmed non-guest. */
export function useGuestCredentialState(): boolean | undefined {
  const [isGuest, setIsGuest] = useState<boolean | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const loadAccount = window.api?.loadCanopyCloudAccount;
    if (typeof loadAccount !== 'function') {
      return (): void => {
        mountedRef.current = false;
      };
    }
    const refresh = (): void => {
      setIsGuest(undefined);
      void loadAccount()
        .then((account) => {
          if (mountedRef.current) {
            setIsGuest(
              account.read && account.read !== 'ok'
                ? undefined
                : isGuestAccount(account),
            );
          }
        })
        .catch(() => {
          if (mountedRef.current) setIsGuest(undefined);
        });
    };
    refresh();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    return (): void => {
      mountedRef.current = false;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    };
  }, []);

  return isGuest;
}

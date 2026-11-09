import { useEffect, useState } from 'react';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isConclusiveAccountRead } from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { readCanopyCloudAccountChangeReason } from '@/lib/canopyCloudAccountChange';

export type CanopyCloudSessionExpiry = 'none' | 'hosted' | 'manual';

function expiryOf(
  account: CanopyCloudAccountPublicState,
): CanopyCloudSessionExpiry {
  if (
    !account.hasApiKey ||
    account.sessionExpired !== true ||
    isGuestAccount(account)
  )
    return 'none';
  return account.credentialSource === 'manual' || account.authMode === 'api_key'
    ? 'manual'
    : 'hosted';
}

/**
 * Whether main holds a definitive rejection of the current non-guest
 * credential, and how to fix it. A failed read proves nothing, so it keeps the
 * known state, unless the account just changed and that state no longer applies.
 */
export function useCanopyCloudSessionExpired(): CanopyCloudSessionExpiry {
  const [expiry, setExpiry] = useState<CanopyCloudSessionExpiry>('none');

  useEffect(() => {
    let active = true;
    let readGeneration = 0;
    const api = window.api;

    const refresh = (identityChanged: boolean): void => {
      const generation = ++readGeneration;
      const settleUnread = (): void => {
        if (active && generation === readGeneration && identityChanged) {
          setExpiry('none');
        }
      };
      void api
        .loadCanopyCloudAccount()
        .then((account) => {
          if (!isConclusiveAccountRead(account)) {
            settleUnread();
          } else if (active && generation === readGeneration) {
            setExpiry(expiryOf(account));
          }
        })
        .catch(settleUnread);
    };
    // Also fires for same-account refreshes and failed re-probes, which say
    // nothing about the credential this state describes.
    const onAccountChanged = (event: Event): void => {
      // A legacy notification is not evidence that this credential changed.
      refresh(readCanopyCloudAccountChangeReason(event) === 'identity');
    };

    // Subscribe first, so a change during the initial read is not missed. The
    // push only rereads: dispatching the account event would invalidate
    // identity-scoped caches that a session rejection leaves valid.
    const unsubscribe = api.onCanopyCloudSessionStatus((): void => {
      refresh(false);
    });
    window.addEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      onAccountChanged,
    );
    refresh(false);
    return (): void => {
      active = false;
      unsubscribe();
      window.removeEventListener(
        CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
        onAccountChanged,
      );
    };
  }, []);

  return expiry;
}

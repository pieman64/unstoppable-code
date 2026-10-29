import { useEffect, useState } from 'react';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { normalizePersonalOrganizationId } from '@canopy/protocol/workspace-context';

/** Account facts the palette's Settings entries name and gate on. */
export interface PaletteAccountFacts {
  /** The signed-in account's personal organization; `null` for a guest. */
  readonly personalOrganizationId: string | null;
  /** Free app access, under which Billing reads "AI Credits". */
  readonly freeAccess: boolean;
}

const NO_ACCOUNT_FACTS: PaletteAccountFacts = {
  personalOrganizationId: null,
  freeAccess: false,
};

/**
 * Reads the cloud account once per palette open, and only while `enabled`
 * (hosted settings are openable), so a palette without account and
 * organization entries makes no extra reads. An unreadable account leaves
 * the defaults: no Personal pages and the Billing label.
 */
export function usePaletteAccountFacts(enabled: boolean): PaletteAccountFacts {
  const [facts, setFacts] = useState<PaletteAccountFacts>(NO_ACCOUNT_FACTS);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void Promise.all([
      window.api.loadCanopyCloudAccount(),
      window.api.loadCanopyCloudEntitlements(),
    ])
      .then(([account, entitlements]) => {
        if (cancelled) return;
        setFacts({
          personalOrganizationId: isGuestAccount(account)
            ? null
            : normalizePersonalOrganizationId(account.personalOrganizationId),
          freeAccess: entitlements.resolved && entitlements.freeAccess === true,
        });
      })
      .catch(() => {
        // Keep the defaults; the palette still lists every other entry.
      });
    return (): void => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? facts : NO_ACCOUNT_FACTS;
}

import type { JSX } from 'react';
import {
  accountProxyAccountsForHarness,
  type AccountProxyHarness,
} from '@canopy/desktop-shared/lib/account-proxy';
import { projectAccountProxyUsageAccount } from '@canopy/desktop-shared/lib/account-proxy-usage-projection';
import {
  getModelCatalogProviderLabel,
  ProviderAccountUsage,
} from '@canopy/ui-shared';
import { ACCOUNT_BUTTON_PRIMARY } from '@/lib/account-button-styles';
import {
  ACCOUNT_PROXY_SETTINGS_TITLE,
  accountProxyAccountState,
  accountProxyPoolNotice,
} from '@/components/settings/account-proxy/accountProxyCopy';
import {
  useAccountProxyLiveRefresh,
  useAccountProxyStatus,
} from '@/stores/accountProxyStore';
import { useNavigationStore } from '@/stores/navigationStore';

/**
 * A Usage card's body while the account proxy serves the provider's work on
 * this device: the proxy's accounts for it and each account's named limits,
 * how fresh they are and any failed read, in place of the user's own
 * sign-in, whose limits no longer apply. Rendered with the same shared
 * account view as the Remote Control usage panel.
 */
export function AccountProxyUsageSection({
  harness,
  nowMs,
  frameless,
}: {
  readonly harness: AccountProxyHarness;
  readonly nowMs: number;
  readonly frameless: boolean;
}): JSX.Element {
  const status = useAccountProxyStatus();
  const openSettings = useNavigationStore((state) => state.openSettings);
  useAccountProxyLiveRefresh(true);
  const label = getModelCatalogProviderLabel(harness);
  const notice = accountProxyPoolNotice(status, harness);
  const accounts = accountProxyAccountsForHarness(
    status?.accounts ?? [],
    harness,
  );
  const gap = frameless ? 'mt-2' : 'mt-4';

  return (
    <div data-testid={`usage-provider-${harness}-account-proxy`}>
      <div
        className={`flex min-w-0 items-center justify-between gap-3 fg-secondary ${
          frameless ? 'mt-1 text-xs' : 'mt-4 text-s'
        }`}
      >
        <p className="min-w-0">
          {`${label} runs through the account proxy on this device.`}
        </p>
        <button
          type="button"
          onClick={(): void => openSettings('account-proxy')}
          data-testid={`usage-provider-${harness}-account-proxy-manage`}
          className={`shrink-0 ${ACCOUNT_BUTTON_PRIMARY}`}
        >
          {`Manage ${ACCOUNT_PROXY_SETTINGS_TITLE}`}
        </button>
      </div>
      {notice !== null ? (
        <p className={`text-s fg-secondary ${gap}`}>{notice}</p>
      ) : (
        accounts.map((account) => (
          <div
            key={account.authIndex}
            data-testid="usage-account-proxy-account"
            className={gap}
          >
            <ProviderAccountUsage
              account={projectAccountProxyUsageAccount(account)}
              providerLabel={label}
              nowMs={nowMs}
              frameless={frameless}
            >
              <span className="shrink-0 text-xs fg-secondary">
                {accountProxyAccountState(account)}
              </span>
            </ProviderAccountUsage>
          </div>
        ))
      )}
    </div>
  );
}

import type { JSX } from 'react';
import {
  accountProxyAccountsForHarness,
  type AccountProxyHarness,
} from '@canopy/desktop-shared/lib/account-proxy';
import { projectAccountProxyUsageAccount } from '@canopy/desktop-shared/lib/account-proxy-usage-projection';
import {
  Button,
  getModelCatalogProviderLabel,
  ProviderAccountUsage,
  UsageRow,
  UsageRowList,
} from '@canopy/ui-shared';
import {
  ACCOUNT_PROXY_SETTINGS_TITLE,
  accountProxyAccountState,
  accountProxyPoolNotice,
} from '@/components/settings/account-proxy/accountProxyCopy';
import { AccountProxySignInAgainButton } from '@/components/settings/account-proxy/AccountProxySignInAgainButton';
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
}: {
  readonly harness: AccountProxyHarness;
  readonly nowMs: number;
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

  return (
    <div
      data-testid={`usage-provider-${harness}-account-proxy`}
      className="flex flex-col gap-2"
    >
      {notice === null
        ? accounts.map((account) => (
            <div
              key={account.authIndex}
              data-testid="usage-account-proxy-account"
            >
              <ProviderAccountUsage
                account={projectAccountProxyUsageAccount(account)}
                providerLabel={label}
                nowMs={nowMs}
              >
                <span className="shrink-0 text-xs fg-secondary">
                  {accountProxyAccountState(account)}
                </span>
                <AccountProxySignInAgainButton account={account} />
              </ProviderAccountUsage>
            </div>
          ))
        : null}
      <UsageRowList>
        <UsageRow
          title={ACCOUNT_PROXY_SETTINGS_TITLE}
          detail={
            notice ?? `${label} runs through the account proxy on this device.`
          }
          trailing={
            <Button
              variant="secondary"
              size="compact"
              onClick={(): void => openSettings('account-proxy')}
              aria-label={`Manage ${ACCOUNT_PROXY_SETTINGS_TITLE}`}
              data-testid={`usage-provider-${harness}-account-proxy-manage`}
            >
              Manage
            </Button>
          }
        />
      </UsageRowList>
    </div>
  );
}

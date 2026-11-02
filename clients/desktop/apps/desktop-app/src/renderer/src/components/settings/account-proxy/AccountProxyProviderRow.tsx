import type { JSX } from 'react';
import { Button, ProviderStatusDot } from '@canopy/ui-shared';
import { GlobeIcon } from '@canopy/ui-shared/icons/AppIcons';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { isAccountProxyAccountReady } from '@canopy/desktop-shared/lib/account-proxy';
import { useOpenSettingsSection } from '../settings-section-navigation';
import {
  useAccountProxyLiveRefresh,
  useAccountProxyStatus,
} from '@/stores/accountProxyStore';
import { SettingsRow } from '../SettingsLayout';
import { AccountProxyAccountList } from './AccountProxyAccountList';
import { accountProxyHost } from './accountProxyCopy';
import { AccountProxyErrorMessage } from './AccountProxyErrorMessage';

/**
 * Settings > Accounts > LLM provider: the proxy as a provider row beside
 * Claude and Codex (CAN-4019), with every account it shares listed under it.
 * Renders nothing until the user opts in under Experiments.
 */
export function AccountProxyProviderRow(): JSX.Element | null {
  const status = useAccountProxyStatus();
  const openSettings = useOpenSettingsSection();
  const connected =
    status?.available === true &&
    (status.state === 'connected' || status.state === 'error');
  useAccountProxyLiveRefresh(connected);
  if (!status?.available) return null;

  const host = status.connection
    ? accountProxyHost(status.connection.url)
    : null;
  const ready = status.accounts.filter(isAccountProxyAccountReady).length;
  let description: JSX.Element | string;
  if (status.state === 'not-configured') {
    description = 'Connect to a CLIProxyAPI server to run agents through it.';
  } else if (status.state === 'needs-key') {
    description = 'Add the management key to use this server on this device.';
  } else if (status.error) {
    description = (
      <span className="fg-destructive">
        <AccountProxyErrorMessage code={status.error.code} host={host} />
      </span>
    );
  } else {
    description = (
      <>
        {`${String(status.accounts.length)} ${
          status.accounts.length === 1 ? 'account' : 'accounts'
        } · ${String(ready)} ready · `}
        <span className={`font-mono ${POSTHOG_REPLAY_BLOCK_CLASS}`}>
          {host}
        </span>
      </>
    );
  }

  return (
    <SettingsRow
      dataTestId="settings-account-proxy-provider"
      label={
        <span className="inline-flex items-center gap-2">
          <GlobeIcon size={16} aria-hidden />
          Multi-account proxy
          {connected ? (
            <ProviderStatusDot tone={status.error ? 'failed' : 'connected'} />
          ) : null}
        </span>
      }
      description={description}
      control={
        <Button
          size="compact"
          data-testid="settings-account-proxy-manage"
          onClick={(): void => openSettings('account-proxy')}
        >
          {status.state === 'not-configured' ? 'Set up' : 'Manage'}
        </Button>
      }
    >
      {connected && status.accounts.length > 0 ? (
        <div
          className="flex flex-col gap-2.5 pl-4"
          data-testid="settings-account-proxy-accounts"
        >
          <AccountProxyAccountList
            accounts={status.accounts}
            variant="sub"
            actionsDisabled={
              status.error?.code === 'unauthorized' ||
              status.error?.code === 'blocked'
            }
          />
        </div>
      ) : null}
    </SettingsRow>
  );
}

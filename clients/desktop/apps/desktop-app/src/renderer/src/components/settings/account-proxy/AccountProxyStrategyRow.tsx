import { type JSX, useId, useState } from 'react';
import { isAccountProxyRoutingStrategy } from '@canopy/desktop-shared/lib/account-proxy';
import type {
  AccountProxyRoutingStrategy,
  AccountProxyStatus,
} from '@canopy/desktop-shared/types/account-proxy';
import {
  SettingsSelect,
  type SettingsSelectOption,
} from '@canopy/ui-shared/components';
import { useAccountProxyStore } from '@/stores/accountProxyStore';
import { SettingsRow } from '../SettingsLayout';

const STRATEGY_OPTIONS: readonly SettingsSelectOption<AccountProxyRoutingStrategy>[] =
  [
    { value: 'round-robin', label: 'Round robin' },
    { value: 'weighted-round-robin', label: 'Weighted round robin' },
    { value: 'fill-first', label: 'Fill first' },
  ];

const STRATEGY_DESCRIPTION =
  "Round robin sends each request to the next ready account. Weighted round robin spreads requests by each account's weight. Fill first uses one account until it reaches a limit.";

/** "Account order": the proxy's own `routing.strategy`, changed on the proxy. */
export function AccountProxyStrategyRow({
  status,
}: {
  readonly status: AccountProxyStatus;
}): JSX.Element | null {
  const selectId = useId();
  const [saving, setSaving] = useState<AccountProxyRoutingStrategy | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const routing = status.routing;
  if (!routing) return null;
  const local = status.connection?.kind === 'local';
  const keyRejected =
    status.error?.code === 'unauthorized' || status.error?.code === 'blocked';
  const blockedReason = keyRejected
    ? 'Enter the current management key to change the account order.'
    : local && status.local.phase !== 'running'
      ? 'Start the proxy to change the account order.'
      : null;

  const change = async (
    strategy: AccountProxyRoutingStrategy,
  ): Promise<void> => {
    const accountProxy = window.api.accountProxy;
    if (!accountProxy || strategy === routing.strategy) return;
    setSaving(strategy);
    setFailed(false);
    try {
      const next = await accountProxy.setRoutingStrategy({ strategy });
      useAccountProxyStore.getState().setStatus(next);
    } catch {
      setFailed(true);
    } finally {
      setSaving(null);
    }
  };

  return (
    <SettingsRow
      label="Account order"
      htmlFor={selectId}
      dataTestId="account-proxy-strategy"
      description={
        failed ? (
          <span
            className="fg-destructive"
            data-testid="account-proxy-strategy-error"
          >
            Couldn't change the account order. Try again.
          </span>
        ) : (
          (blockedReason ??
          (local
            ? STRATEGY_DESCRIPTION
            : `${STRATEGY_DESCRIPTION} Applies to everyone who uses this server.`))
        )
      }
      control={
        <SettingsSelect
          id={selectId}
          data-testid="account-proxy-strategy-select"
          options={STRATEGY_OPTIONS}
          value={saving ?? routing.strategy}
          disabled={saving !== null || blockedReason !== null}
          onValueChange={(next): void => {
            if (isAccountProxyRoutingStrategy(next)) void change(next);
          }}
        />
      }
    />
  );
}

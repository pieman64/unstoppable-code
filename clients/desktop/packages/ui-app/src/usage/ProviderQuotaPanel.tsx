'use client';

import { useState, type JSX } from 'react';
import { useCanopyClient, useWorkspaceCapabilities } from '@canopy/app-state';
import type {
  PortalProviderUsageAccount,
  PortalProviderUsageEntry,
  PortalProviderUsageProjection,
} from '@canopy/protocol/portal';
import {
  getModelCatalogProviderLabel,
  LimitSubCardView,
  OpenCodeAccountCard,
  ModelProviderIcon,
  ProviderAccountUsage,
  ProviderUsageAccountRow,
  UsageCardHeader,
  useMinuteClock,
} from '@canopy/ui-shared';

interface ProviderQuotaPanelProps {
  workspaceLocalId: string;
  projection?: PortalProviderUsageProjection;
  disabled?: boolean;
  isVisible: boolean;
}

/** The latest usage read across the proxy's accounts, if any. */
function newestAccountUpdate(
  accounts: readonly PortalProviderUsageAccount[],
): string | undefined {
  let newest: string | undefined;
  let newestMs = -Infinity;
  for (const account of accounts) {
    if (!account.lastUpdatedAt) continue;
    const ms = new Date(account.lastUpdatedAt).getTime();
    if (Number.isFinite(ms) && ms > newestMs) {
      newestMs = ms;
      newest = account.lastUpdatedAt;
    }
  }
  return newest;
}

/** A short state beside a proxy account that cannot serve now. */
function accountState(account: PortalProviderUsageAccount): string | null {
  switch (account.status) {
    case 'disabled':
      return 'Turned off';
    case 'cooling':
      return 'Usage limit reached';
    case 'error':
      return "Can't be used right now";
    case 'pending':
      return 'Finishing sign-in';
    case 'refreshing':
    case 'active':
      return account.planLabel ?? null;
  }
}

/**
 * The desktop's multi-account proxy accounts for a provider, in place of
 * its native sign-in while the proxy serves the provider's work.
 */
function AccountProxyAccounts({
  accounts,
  providerLabel,
  nowMs,
}: {
  accounts: PortalProviderUsageAccount[];
  providerLabel: string;
  nowMs: number;
}): JSX.Element {
  if (accounts.length === 0) {
    return (
      <p className="text-s fg-secondary">
        {`Add a ${providerLabel} account to the account proxy.`}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {accounts.map((account) => {
        const state = accountState(account);
        return (
          <ProviderAccountUsage
            key={account.id}
            account={account}
            providerLabel={providerLabel}
            nowMs={nowMs}
            frameless
          >
            {state === null ? null : (
              <span className="shrink-0 text-xs fg-secondary">{state}</span>
            )}
          </ProviderAccountUsage>
        );
      })}
    </div>
  );
}

function QuotaCard({
  entry,
  workspaceLocalId,
  disabled,
  nowMs,
}: {
  entry: PortalProviderUsageEntry;
  workspaceLocalId: string;
  disabled: boolean;
  nowMs: number;
}): JSX.Element {
  const client = useCanopyClient();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const authenticated = entry.authState === 'authenticated';
  const label = getModelCatalogProviderLabel(entry.provider);
  const refresh = async (): Promise<void> => {
    if (disabled || refreshing) return;
    setRefreshing(true);
    setRefreshError(false);
    try {
      await client.command('providerUsage.refresh', {
        workspaceLocalId,
        provider: entry.provider,
      });
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <article
      className="min-w-0 space-y-2"
      data-testid={`usage-provider-card-${entry.provider}`}
    >
      <UsageCardHeader
        icon={
          <ModelProviderIcon provider={entry.provider} width={18} height={18} />
        }
        title={label}
        authState={entry.authState}
        {...(entry.accounts === undefined
          ? {
              planLabel: entry.planLabel,
              planActive: authenticated,
              lastUpdatedAt: entry.lastUpdatedAt,
            }
          : {
              authLabel: 'via account proxy',
              planActive: false,
              lastUpdatedAt: newestAccountUpdate(entry.accounts),
            })}
        refreshing={refreshing}
        refreshDisabled={disabled}
        onRefresh={() => {
          void refresh();
        }}
        refreshLabel={`Refresh ${label} usage`}
        compact
        frameless
      />
      {entry.accounts !== undefined ? (
        <AccountProxyAccounts
          accounts={entry.accounts}
          providerLabel={label}
          nowMs={nowMs}
        />
      ) : (
        <ProviderUsageAccountRow
          accountLabel={
            authenticated
              ? (entry.accountLabel ?? entry.accountEmail ?? null)
              : null
          }
          statusLabel={
            authenticated
              ? 'Account name unavailable'
              : entry.authState === 'unknown'
                ? 'Account status unavailable'
                : 'Connect in the desktop app'
          }
          frameless
        >
          {null}
        </ProviderUsageAccountRow>
      )}
      {entry.accounts === undefined &&
        authenticated &&
        entry.windows.map((window) => (
          <LimitSubCardView
            key={window.id}
            nowMs={nowMs}
            frameless
            card={{
              key: window.id,
              title: window.label,
              unlimited: window.unlimited,
              usedPercent: window.usedPercent,
              resetsAt: window.resetsAt,
              windowDurationMs: window.windowDurationMs,
              creditsAreCount: window.credits?.unit === 'credits',
              credits: window.credits
                ? {
                    usedUsd: window.credits.spent,
                    remainingUsd: window.credits.remaining,
                    totalUsd: window.credits.total,
                  }
                : undefined,
            }}
          />
        ))}
      {entry.accounts === undefined &&
        authenticated &&
        entry.windows.length === 0 && (
          <p className="text-s fg-secondary">Usage unavailable</p>
        )}
      {((entry.accounts === undefined && entry.error) || refreshError) && (
        <p role="status" className="text-s fg-secondary">
          {refreshError
            ? 'Could not refresh usage. Try again.'
            : entry.error?.message}
        </p>
      )}
    </article>
  );
}

function QuotaCards({
  projection,
  workspaceLocalId,
  disabled,
}: Omit<ProviderQuotaPanelProps, 'isVisible'>): JSX.Element {
  const nowMs = useMinuteClock();
  const client = useCanopyClient();
  if (!projection)
    return (
      <p className="p-4 text-s fg-secondary">
        Usage is not available from this desktop yet.
      </p>
    );
  if (projection.providers.length === 0 && !projection.openCodeAccounts)
    return <p className="p-4 text-s fg-secondary">Usage unavailable</p>;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-4"
      data-testid="provider-quota-panel"
    >
      {projection.providers.map((entry) => (
        <QuotaCard
          key={`${workspaceLocalId}:${entry.provider}:${entry.authState}:${entry.accountLabel ?? entry.accountEmail ?? ''}`}
          entry={entry}
          workspaceLocalId={workspaceLocalId}
          disabled={disabled === true}
          nowMs={nowMs}
        />
      ))}
      {projection.openCodeAccounts && (
        <OpenCodeAccountCard
          key={workspaceLocalId}
          snapshot={projection.openCodeAccounts}
          disabled={disabled}
          onRefresh={() =>
            client.command('providerUsage.refresh', {
              workspaceLocalId,
              provider: 'opencode',
            })
          }
        />
      )}
    </div>
  );
}

/** Host-independent presentation; the selected workspace's client owns refresh. */
export function ProviderQuotaPanel(
  props: ProviderQuotaPanelProps,
): JSX.Element | null {
  const capabilities = useWorkspaceCapabilities(props.workspaceLocalId);
  if (!props.isVisible) return null;
  if (capabilities.providerQuotas !== true)
    return (
      <p className="p-4 text-s fg-secondary">
        Usage is unavailable for this project.
      </p>
    );
  return (
    <QuotaCards
      projection={props.projection}
      workspaceLocalId={props.workspaceLocalId}
      disabled={props.disabled}
    />
  );
}

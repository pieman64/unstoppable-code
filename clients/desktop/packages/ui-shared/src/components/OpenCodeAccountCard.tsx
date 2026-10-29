'use client';

import { useState, type JSX } from 'react';
import type {
  OpenCodeAccountMethod,
  OpenCodeAccountSnapshot,
} from '@canopy/protocol/portal';
import { ModelProviderIcon } from './ModelProviderIcon';
import { UsageCardHeader } from './UsageCardHeader';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

const METHOD_LABELS: Record<OpenCodeAccountMethod, string> = {
  key: 'API key',
  oauth: 'Browser sign-in',
  external: 'External credentials',
  env: 'Environment variable',
};

/** Shared presentation; hosts supply transport and connection availability. */
export function OpenCodeAccountCard({
  snapshot,
  onRefresh,
  disabled = false,
}: {
  snapshot: OpenCodeAccountSnapshot;
  onRefresh: () => Promise<void>;
  disabled?: boolean;
}): JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const refresh = async (): Promise<void> => {
    if (disabled || refreshing) return;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      await onRefresh();
    } catch {
      setRefreshFailed(true);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <article className="min-w-0 space-y-3" data-testid="opencode-account-card">
      <UsageCardHeader
        icon={<ModelProviderIcon provider="opencode" width={18} height={18} />}
        title="OpenCode"
        authState="unknown"
        authLabel="Provider accounts"
        planActive={false}
        lastUpdatedAt={snapshot.updatedAt}
        refreshing={refreshing}
        refreshDisabled={disabled}
        onRefresh={() => {
          void refresh();
        }}
        refreshLabel="Refresh OpenCode accounts"
        compact
        frameless
      />
      {snapshot.status === 'unavailable' ? (
        <p role="status" className="text-s fg-secondary">
          Account information is unavailable. Try refreshing.
        </p>
      ) : snapshot.providers.length === 0 ? (
        <p className="text-s fg-secondary">
          No providers reported by OpenCode.
        </p>
      ) : (
        <div className="space-y-3">
          {snapshot.providers.map((provider) => (
            <section key={provider.id} className="space-y-1">
              <h3
                className={`text-s font-medium fg-primary truncate ${REPLAY_BLOCK_CLASS}`}
              >
                {provider.name}
              </h3>
              {provider.accounts.length === 0 ? (
                <p className="text-s fg-secondary">
                  No account information reported.
                </p>
              ) : (
                <ul className="space-y-2">
                  {provider.accounts.map((account, index) => (
                    <li
                      key={`${account.method}:${account.label}:${index}`}
                      className="min-w-0 text-s"
                    >
                      <div
                        className={`truncate fg-primary ${REPLAY_BLOCK_CLASS}`}
                      >
                        {account.label || 'Account name unavailable'}
                      </div>
                      <div className="flex flex-wrap gap-x-2 text-xs fg-secondary">
                        <span>{METHOD_LABELS[account.method]}</span>
                        {account.selected && <span>Selected in OpenCode</span>}
                        {account.needsSignIn && <span>Sign in again</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
      <p className="text-s fg-secondary">
        Plan and usage limits are unavailable from OpenCode.
      </p>
      {refreshFailed && (
        <p role="status" className="text-s fg-secondary">
          Could not refresh accounts. Try again.
        </p>
      )}
    </article>
  );
}

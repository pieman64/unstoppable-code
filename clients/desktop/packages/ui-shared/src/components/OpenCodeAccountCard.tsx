'use client';

import type { JSX } from 'react';
import type {
  OpenCodeAccountMethod,
  OpenCodeAccountSnapshot,
} from '@canopy/protocol/portal';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { UsageGroup, UsageRow, UsageRowList } from './UsageGroup';

const METHOD_LABELS: Record<OpenCodeAccountMethod, string> = {
  key: 'API key',
  oauth: 'Browser sign-in',
  external: 'External credentials',
  env: 'Environment variable',
};

/**
 * OpenCode's provider accounts as a usage group: a row per reported account,
 * named with its provider and sign-in method. The host's usage refresh reads
 * them again; the group has no refresh of its own.
 */
export function OpenCodeAccountCard({
  snapshot,
}: {
  snapshot: OpenCodeAccountSnapshot;
}): JSX.Element {
  const rows = snapshot.providers.flatMap((provider) =>
    provider.accounts.length === 0
      ? [
          <UsageRow
            key={provider.id}
            testId="opencode-account-row"
            title={<span className={REPLAY_BLOCK_CLASS}>{provider.name}</span>}
            detail="No account information reported."
          />,
        ]
      : provider.accounts.map((account, index) => (
          <UsageRow
            key={`${provider.id}:${account.method}:${account.label}:${index}`}
            testId="opencode-account-row"
            title={
              <span className={REPLAY_BLOCK_CLASS}>
                {account.label || 'Account name unavailable'}
              </span>
            }
            detail={
              <>
                <span className={REPLAY_BLOCK_CLASS}>{provider.name}</span>
                {[
                  METHOD_LABELS[account.method],
                  ...(account.selected ? ['Selected in OpenCode'] : []),
                  ...(account.needsSignIn ? ['Sign in again'] : []),
                ].map((part) => (
                  <span key={part}> · {part}</span>
                ))}
              </>
            }
          />
        )),
  );
  return (
    <UsageGroup
      title="OpenCode"
      provider="opencode"
      plan="Provider accounts"
      testId="opencode-account-card"
    >
      {snapshot.status === 'unavailable' ? (
        <p role="status" className="px-0.5 text-s fg-secondary">
          Account information is unavailable. Try refreshing.
        </p>
      ) : snapshot.providers.length === 0 ? (
        <p className="px-0.5 text-s fg-secondary">
          No providers reported by OpenCode.
        </p>
      ) : (
        <UsageRowList>{rows}</UsageRowList>
      )}
      <p className="mt-1.5 px-0.5 text-xs fg-tertiary">
        Plan and usage limits are unavailable from OpenCode.
      </p>
    </UsageGroup>
  );
}

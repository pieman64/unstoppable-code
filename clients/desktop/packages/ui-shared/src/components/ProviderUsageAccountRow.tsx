import type { JSX, ReactNode } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { UsageRow } from './UsageGroup';

/**
 * A usage group's last row: the account, and its host-supplied management
 * action on the trailing edge (on its own line under the account, narrow).
 */
export function ProviderUsageAccountRow({
  accountLabel,
  statusLabel,
  title = 'Account',
  testId,
  children,
}: {
  /** The signed-in account's own label, usually its email, or `null` when
   * there is none to name. Session replay blocks it. */
  accountLabel: string | null;
  /** Shown in place of a `null` account label: sign-in or loading copy. */
  statusLabel: string;
  /** The row's name. Defaults to `Account`. */
  title?: string;
  testId?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <UsageRow
      title={title}
      testId={testId}
      detail={
        accountLabel === null ? (
          statusLabel
        ) : (
          <span className={REPLAY_BLOCK_CLASS}>{accountLabel}</span>
        )
      }
      trailing={children}
      trailingKind="action"
    />
  );
}

import type { JSX, ReactNode } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

/** Account identity and its host-supplied management action for usage views. */
export function ProviderUsageAccountRow({
  accountLabel,
  statusLabel,
  frameless = false,
  children,
}: {
  /** The signed-in account's own label, usually its email, or `null` when
   * there is none to name. Session replay blocks it. */
  accountLabel: string | null;
  /** Shown in place of a `null` account label: sign-in or loading copy. */
  statusLabel: string;
  frameless?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`flex min-w-0 items-center justify-between gap-3 fg-secondary ${frameless ? 'mt-1 text-xs' : 'mt-4 text-s'}`}
    >
      <p className="min-w-0 truncate">
        {!frameless && 'Account: '}
        {accountLabel === null ? (
          <span className="font-medium fg-primary">{statusLabel}</span>
        ) : (
          <span className={`font-medium fg-primary ${REPLAY_BLOCK_CLASS}`}>
            {accountLabel}
          </span>
        )}
      </p>
      {children}
    </div>
  );
}

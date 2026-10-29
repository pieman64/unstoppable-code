import type { JSX } from 'react';
import {
  GITHUB_PUSH_BLOCKED_LABEL,
  GITHUB_PUSH_ERROR_LABEL,
  PUSHING_LABEL,
  PUSH_TO_GITHUB_LABEL,
  TRY_AGAIN_LABEL,
} from './shareCopy';
import type { ShareBudgetPush } from './useSharePreview';

export interface ShareBudgetPushActionProps {
  budgetPush: ShareBudgetPush;
  /** Distinguishes the preview blocker from the publish-error remedy. */
  dataTestId: string;
}

/**
 * The one-click push offered next to an over-budget share.
 *
 * This is the only push button left in Share, and it only appears because the
 * share cannot publish at all without it: pushing moves the share's base
 * forward, so less has to travel as the encrypted overlay. It renders nothing
 * when a push cannot help (a Cowork share, or no commits GitHub lacks).
 */
export function ShareBudgetPushAction({
  budgetPush,
  dataTestId,
}: ShareBudgetPushActionProps): JSX.Element | null {
  if (!budgetPush.available) return null;
  const pushing = budgetPush.state === 'pushing';
  const failureLabel =
    budgetPush.state === 'push-error'
      ? GITHUB_PUSH_ERROR_LABEL
      : budgetPush.state === 'push-blocked'
        ? GITHUB_PUSH_BLOCKED_LABEL
        : null;
  return (
    <div className="space-y-1" aria-busy={pushing ? 'true' : undefined}>
      {failureLabel && (
        <p
          role="alert"
          className="text-xs fg-destructive"
          data-testid={`${dataTestId}-error`}
        >
          {failureLabel}
        </p>
      )}
      {budgetPush.state !== 'push-blocked' && (
        <button
          type="button"
          className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-xs font-medium fg-emphasis transition hover:opacity-90 disabled:opacity-50"
          data-testid={dataTestId}
          disabled={pushing}
          onClick={budgetPush.push}
        >
          {pushing
            ? PUSHING_LABEL
            : budgetPush.state === 'push-error'
              ? TRY_AGAIN_LABEL
              : PUSH_TO_GITHUB_LABEL}
        </button>
      )}
    </div>
  );
}

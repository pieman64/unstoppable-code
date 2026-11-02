import type { JSX } from 'react';
import type { CanopyProxyError } from '@canopy/protocol';
import { AiCreditsStopLine } from './AiCreditsStopLine';
import { MODEL_LIBRARY_UNLOCK_COPY } from './modelLibraryLock';

/**
 * Read-only rendering of a structured AI Credits proxy failure, shared by every
 * browser surface that replays a desktop transcript.
 *
 * Why this is shared rather than per-renderer: the desktop replaces the raw
 * body with `CanopyProxyErrorNotice`, but the same transcript is replayed by
 * the web Portal through two different renderers (the shared-run/cowork
 * `ChatMessageRenderer` and the live worktree chat's `ChatMessageView`). The
 * marker's own contract says it "must never appear in rendered text", so every
 * one of those surfaces needs the guard — and a forked copy per renderer is how
 * one of them silently ends up printing `{"error":{"canopy_proxy":...}}`.
 *
 * These surfaces are replays with no chat session behind them, so this shows
 * the explanation and the error id but none of the desktop notice's actions
 * (Retry / Open Settings), which would have nothing to act on.
 *
 * Copy rules match the desktop notice exactly: the whole path is named "the AI
 * provider". None of "gateway", "proxy", "upstream", "AI Credits", or the
 * marker is user-visible, and no HTTP status, attempt count, or elapsed time is
 * shown. The error id is the only diagnostic detail that reaches the user.
 */
export interface CanopyProxyErrorSummaryProps {
  error: CanopyProxyError;
  /** Overrides the test id so each surface can assert its own hook. */
  dataTestId?: string;
}

function summaryTitle(code: CanopyProxyError['code']): string {
  switch (code) {
    case 'credentials_unavailable':
      return "Couldn't connect to the AI provider";
    case 'upstream_unavailable':
      return "The AI provider didn't respond";
    case 'invalid_request':
      return "The AI provider couldn't accept this message";
    // The documented exception to "AI Credits stays out of the failure copy":
    // for every other code the balance is beside the point, but here the empty
    // balance IS the failure, so naming anything else would misdescribe it.
    case 'no_billing_source':
      return 'This message needed AI Credits';
    case 'session_budget_exhausted':
      return 'This session used its AI Credits budget';
    // The second such exception, for the same reason: what failed is precisely
    // who was paying. These surfaces are replays with no session to act on, so
    // the title has to carry the whole explanation on its own — no sign-in
    // action is offered here, unlike the desktop notice.
    case 'guest_model_not_allowed':
      return 'This message needed an account';
    // A signed-in account that has not purchased AI Credits yet. Like the
    // guest case above, the purchase is the whole explanation.
    case 'model_locked':
      return MODEL_LIBRARY_UNLOCK_COPY.proxyRefusalTitle;
    case 'proxy_internal_error':
      return 'Something went wrong reaching the AI provider';
    // The owner this work claimed is an organization the user has left
    // (CAN-3462). The title alone explains it; there is nothing to retry.
    case 'work_owner_not_member':
      return "You're no longer in this organization";
  }
}

export function CanopyProxyErrorSummary({
  error,
  dataTestId = 'canopy-proxy-error-summary',
}: CanopyProxyErrorSummaryProps): JSX.Element {
  // The same plain line as the desktop transcript (CAN-5160): the payment
  // choice belongs to the composer's banner, never to a transcript panel.
  if (error.code === 'no_billing_source') {
    return <AiCreditsStopLine dataTestId={dataTestId} />;
  }
  return (
    <div
      // `status` (polite), not the desktop notice's `alert` (assertive): these
      // surfaces replay a transcript, so interrupting the reader for a failure
      // that may be minutes old is wrong. `note` was worse still — screen
      // readers announce it as a generic region and never surface it as a
      // failure at all.
      role="status"
      data-testid={dataTestId}
      className="flex flex-col gap-1 rounded-lg border border-line-attention/40 bg-warning-subtle px-3 py-2 text-xs fg-primary"
    >
      <span className="font-medium fg-warning">{summaryTitle(error.code)}</span>
      {error.correlationId ? (
        <span className="fg-secondary">
          Error id:{' '}
          <span
            className="font-mono text-2xs"
            data-testid={`${dataTestId}-correlation-id`}
          >
            {error.correlationId}
          </span>
        </span>
      ) : null}
    </div>
  );
}

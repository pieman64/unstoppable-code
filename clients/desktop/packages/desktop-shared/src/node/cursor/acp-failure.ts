import { AcpClientError } from '../acp/errors';

/**
 * True when an ACP failure is a TRANSIENT transport fault rather than
 * evidence that a session's saved context is gone.
 *
 * The distinction matters because a resume-only caller reports "its saved
 * context is no longer available" when this is false, and that sentence must
 * not be said about a 30-second network hiccup. Treating every `loadSession`
 * rejection as proof of context loss — including the ACP client's own
 * fixed-window RPC timeout — both misdiagnoses a retryable blip and hides its
 * real cause.
 *
 * Only the codes that describe the CONNECTION rather than the session qualify:
 *
 * - `timeout` — the client's own fixed 15s/30s window elapsed (`bounded()`).
 * - `closed` — the connection went away underneath the call.
 * - `busy` — the session is mid-attach/close, so this call was simply early.
 *
 * Everything else stays context loss, deliberately. In particular an
 * agent-side rejection of `session/load` does NOT surface as
 * `invalid-session` — that code is only the client's own check that a session
 * is attached to this connection — so an allowlist of "real context loss"
 * codes would wrongly reclassify the ordinary orphaned-profile case that this
 * whole path exists to handle. A non-ACP error is likewise left as context
 * loss, matching the behaviour this driver was extracted from.
 */
export function isTransientAcpFailure(error: unknown): boolean {
  if (!(error instanceof AcpClientError)) return false;
  return (
    error.code === 'timeout' || error.code === 'closed' || error.code === 'busy'
  );
}

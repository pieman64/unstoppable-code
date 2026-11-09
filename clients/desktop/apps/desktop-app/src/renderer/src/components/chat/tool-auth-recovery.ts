import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import { readAuthDependencyFailures } from '@canopy/protocol/auth-recovery';
import { getCanonicalCanopyToolKey } from '@canopy/execution-engine/lib/canopy-injected-tools';
import { parseMcpToolName } from '@canopy/ui-shared/components';
import {
  isMcpConnectionError,
  legacyMcpAuthFailure,
} from './chatConnectionErrors';
import type { ToolResult } from './types';

/**
 * The sign-in failures a tool call's row offers to recover from, in the
 * order `AuthRecoveryCard` shows them; empty when there is nothing to
 * reconnect. Shared by the tool row and the step grouping, which must keep
 * such a call on its own row so its card stays in view.
 */
export function readToolAuthRecoveryFailures(
  toolName: string,
  result: ToolResult | undefined,
): AuthDependencyFailure[] {
  // Structured data wins when present (CAN-1814), but only after it is
  // re-validated here. Both write paths enforce `isValidAuthDependencyFailure`;
  // the READ path does not — `chat-tabs-reader.ts`'s `isPersistedChatBlock`
  // checks only toolUseId/toolName/output/isError and passes `authFailure`
  // through untouched. So a persisted block can pair a non-recoverable
  // `failureClass` with an `mcp_oauth` recovery, and without this guard it
  // would render "Connect MCP server" for a failure logging in cannot fix.
  // Reads BOTH the singular `authFailure` written before the multi-blocker
  // checklist and the `authFailures` array written since (CAN-1814 PR 2), and
  // reports separately whether main reached any readable verdict — which is
  // what the two fall-through rules below turn on.
  const authFailureRead = readAuthDependencyFailures(result ?? {});
  const structuredAuthFailures = authFailureRead.failures;
  // A present-but-unusable value is split by WHY it is unusable, because the
  // two cases mean opposite things (CAN-1814 follow-up):
  //
  //   - Shape-valid but semantically invalid (e.g. `quota_exceeded` paired
  //     with an `mcp_oauth` recovery): main DID reach a verdict, and it says
  //     this is not something reconnecting fixes. Fail closed — the text
  //     heuristic must not overrule a readable verdict.
  //   - Not shape-valid at all (truncated / hand-edited / garbage): there is
  //     no verdict to defer to. Failing closed here removed the user's only
  //     recovery path over a corrupt cache entry, while the tool output is
  //     independent evidence of a real auth failure. Fall through to the
  //     heuristic instead.
  const hasUnusableAuthFailure =
    structuredAuthFailures.length === 0 && authFailureRead.hasVerdict;
  // The card is driven by the failure itself, not by a boolean: it names the
  // dependency and derives its action from `recovery.kind`. Gating on
  // `dependencyClass` alone would render a login CTA for an HTTP 403, which
  // `classifyMcpAuthFailure` deliberately maps to `insufficient_scope` +
  // `recovery: { kind: 'none' }` — the token authenticated fine and was
  // refused on scope, so re-running OAuth cannot fix it. `AuthRecoveryCard`
  // owns that distinction now, which is why a non-recoverable structured
  // failure still renders here: it explains the real problem instead of the
  // nothing-at-all this branch used to show (CAN-1814 PR 2).
  //
  // The structured and legacy branches are deliberately ASYMMETRIC on
  // `result.isError`, and that is not an oversight (raised in CAN-1814 review
  // round 3). `isError` is a premise of the legacy branch — it has nothing but
  // the tool name and the output text to go on, so it may only guess from a
  // result that actually failed. The structured branch is main's verdict,
  // already reached from the errored `tool_result` (`pairPendingAuthFailures`
  // selects only from results with `is_error === true`), so re-deriving it
  // here adds nothing and makes the feature's ONLY user-visible surface
  // disappear the moment a producer attaches a failure to a result whose
  // `isError` did not survive projection — Codex signals `status: 'failed'`
  // rather than `is_error`. Pinned by the `isError false` test in
  // `__tests__/ToolCallBlock.test.tsx`.
  //
  // Canopy's OWN injected tools are excluded (CAN-1814 PR 4). Claude reaches
  // them over a branded MCP HTTP server, so under a brand whose namespace is
  // not the legacy `canopy` one `parseMcpToolName` accepts their names — and a
  // `WatchGitHubItems` error body mentioning a 401 then rendered a bogus
  // "Connect Watch git hub items" MCP card. They are not third-party servers,
  // and when one of them really does hit an auth wall main publishes a
  // structured failure for it, which the branch above already handles.
  const legacyAuthFailure =
    structuredAuthFailures.length === 0 &&
    !hasUnusableAuthFailure &&
    result?.isError === true &&
    parseMcpToolName(toolName) !== null &&
    getCanonicalCanopyToolKey(toolName) === null &&
    isMcpConnectionError(result.output)
      ? legacyMcpAuthFailure(toolName)
      : null;
  return structuredAuthFailures.length > 0
    ? structuredAuthFailures
    : legacyAuthFailure
      ? [legacyAuthFailure]
      : [];
}

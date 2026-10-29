import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import { toAuthDiagnosticDetail } from './auth-diagnostic-detail';

/**
 * Stable identity for the first-party GitHub integration.
 *
 * Namespaced by dependency class rather than being the bare string `github`,
 * so it can never collide with an MCP dependency id (`serverId:configId`) or a
 * provider dependency id (`claude` / `codex`) in the checklist's dedupe map.
 */
export const GITHUB_INTEGRATION_DEPENDENCY_ID = 'integration:github';

/**
 * The one failure code that means "the GitHub credential Canopy can currently
 * obtain was rejected".
 *
 * Shared by `GitHubBrokerErrorCode` and `WatchGitHubItemsErrorCode`, which is
 * what lets one classifier serve both the broker error and the tool result it
 * is projected into.
 */
export const GITHUB_NOT_AUTHENTICATED_CODE = 'not_authenticated';

export interface GitHubIntegrationAuthFailureInput {
  /**
   * Failure code reported by the GitHub-backed surface — a
   * `GitHubBrokerErrorCode` or the `WatchGitHubItemsErrorCode` the broker error
   * was projected into. Typed as `string` on purpose: those two unions live in
   * different packages and this module must not depend on either, and every
   * value other than {@link GITHUB_NOT_AUTHENTICATED_CODE} is declined anyway.
   */
  code: string;
  /** Raw diagnostic; redacted before it leaves this function. */
  diagnostic: string;
}

/**
 * Classify a failed first-party GitHub call as an authentication failure, or
 * decline (CAN-1814 PR 4).
 *
 * `null` means 'not an authentication failure' and is the guard that keeps a
 * rate limit, an outage, a 404, or a mid-request credential swap from
 * producing a reconnect prompt. In particular
 * `GitHubBrokerCredentialResetError` (`code: 'credential_reset'`) is retriable
 * by construction — the broker re-issues the request against the new
 * credential generation — so it must never reach the user as "GitHub needs to
 * be reconnected".
 *
 * `unauthenticated` rather than `expired`: `not_authenticated` is only raised
 * AFTER the broker has invalidated its token cache and re-resolved the
 * credential (`github-broker/index.ts`), so all that is actually known is that
 * no usable credential could be obtained. Nothing in that signal distinguishes
 * an expired token from a revoked one from never having authenticated, and the
 * three read identically to the user anyway ('needs to be reconnected'), so
 * claiming the narrower class would be an unearned diagnosis.
 */
export function classifyGitHubIntegrationAuthFailure(
  input: GitHubIntegrationAuthFailureInput,
): AuthDependencyFailure | null {
  if (input.code !== GITHUB_NOT_AUTHENTICATED_CODE) {
    return null;
  }
  return {
    dependencyClass: 'integration',
    dependencyId: GITHUB_INTEGRATION_DEPENDENCY_ID,
    displayName: 'GitHub',
    failureClass: 'unauthenticated',
    recovery: { kind: 'github_login' },
    detail: toAuthDiagnosticDetail(input.diagnostic),
  };
}

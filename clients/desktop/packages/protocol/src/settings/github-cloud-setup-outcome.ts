// ---------------------------------------------------------------------------
// "GitHub for cloud" callback query contract (REG-3020).
//
// Moved verbatim from `apps/web/src/lib/github/cloud-setup-outcome.ts`, which
// re-exports it.
//
// Browser-safe: it imports only the browser-safe service error codes and
// connect intents. One namespaced parameter family carries every result a
// GitHub for cloud flow lands back on an in-app page with, next to the page's
// own parameters (which are never touched, including a page's own `reason`):
//
// Setup URL results, written by the personal branch of the GitHub App's fixed
// Setup URL router as a 303 to the signed return path:
//
//   github_cloud=connected | requested | unavailable
//   github_cloud=error&github_cloud_reason=<GitHubCloudErrorCode | internal_error>
//
// Link markers, written by the browser into the Better Auth `linkSocial`
// callback URLs (Better Auth itself only appends `error`/`error_description`
// to the error callback):
//
//   github_cloud=linked[&github_cloud_intent=install]
//   github_cloud=link_error[&error=<Better Auth error code>]
//
// A link marker is NOT proof of a credential or consent: anyone can type it.
// `linked` only tells the page to continue the explicit Connect, which the
// server authenticates and verifies again.
//
// `github_cloud_reason` appears only with `error` and is always an allowlisted
// code: the router never reflects a provider message, a state, a nonce or any
// other request value. Readers show their own copy for the code. An unknown
// outcome reads as no result; an unknown or missing reason on `error` reads as
// `internal_error`; a Better Auth error other than "already linked to another
// user" reads as a generic link failure.
// ---------------------------------------------------------------------------

import {
  isGitHubCloudConnectIntent,
  type GitHubCloudConnectIntent,
} from './account-github';
import {
  GITHUB_CLOUD_ERROR_CODES,
  type GitHubCloudErrorCode,
} from './github-cloud-errors';

export const GITHUB_CLOUD_SETUP_OUTCOME_PARAM = 'github_cloud';
export const GITHUB_CLOUD_SETUP_REASON_PARAM = 'github_cloud_reason';
/** The Connect intent a `linked` marker continues; absent means `connect`. */
export const GITHUB_CLOUD_LINK_INTENT_PARAM = 'github_cloud_intent';

/** Better Auth's annotation on a social-link error callback. */
const BETTER_AUTH_ERROR_PARAM = 'error';
const BETTER_AUTH_ERROR_DESCRIPTION_PARAM = 'error_description';
/** Better Auth's code when the GitHub identity belongs to another user. */
const BETTER_AUTH_LINKED_TO_ANOTHER_USER =
  'account_already_linked_to_different_user';

const NAMESPACED_PARAMS = [
  GITHUB_CLOUD_SETUP_OUTCOME_PARAM,
  GITHUB_CLOUD_SETUP_REASON_PARAM,
  GITHUB_CLOUD_LINK_INTENT_PARAM,
] as const;

export const GITHUB_CLOUD_SETUP_OUTCOMES = [
  /** Installed (or updated) and verified; the connection was published. */
  'connected',
  /** An organization owner must approve the install request on GitHub. */
  'requested',
  /** GitHub for cloud is not available to this user (rollout flag off). */
  'unavailable',
  /** Not completed; see `github_cloud_reason`. */
  'error',
] as const;
export type GitHubCloudSetupOutcome =
  (typeof GITHUB_CLOUD_SETUP_OUTCOMES)[number];

/** Client-only markers on the Better Auth `linkSocial` callback URLs. */
export const GITHUB_CLOUD_LINK_OUTCOMES = [
  /** Better Auth's success callback: continue the explicit Connect. */
  'linked',
  /** Better Auth's error callback. */
  'link_error',
] as const;
export type GitHubCloudLinkOutcome =
  (typeof GITHUB_CLOUD_LINK_OUTCOMES)[number];

/** Any failure the connection service did not type. */
export const GITHUB_CLOUD_SETUP_INTERNAL_ERROR = 'internal_error';

export const GITHUB_CLOUD_SETUP_ERROR_REASONS = [
  ...GITHUB_CLOUD_ERROR_CODES,
  GITHUB_CLOUD_SETUP_INTERNAL_ERROR,
] as const;
export type GitHubCloudSetupErrorReason =
  | GitHubCloudErrorCode
  | typeof GITHUB_CLOUD_SETUP_INTERNAL_ERROR;

/** What the Setup URL router writes. */
export type GitHubCloudSetupResult =
  | { outcome: Exclude<GitHubCloudSetupOutcome, 'error'> }
  | { outcome: 'error'; reason: GitHubCloudSetupErrorReason };

/** Why linking failed, as far as the page may say. */
export type GitHubCloudLinkError =
  /** The GitHub identity is already linked to another user. */
  | 'identity-linked-elsewhere'
  /** Anything else Better Auth reported, or nothing at all. */
  | 'link-failed';

/** What the browser writes into the `linkSocial` callback URLs. */
export type GitHubCloudLinkMarker =
  | { outcome: 'linked'; intent: GitHubCloudConnectIntent }
  | { outcome: 'link_error' };

/** A link callback as the landing page reads it. */
export type GitHubCloudLinkResult =
  | { outcome: 'linked'; intent: GitHubCloudConnectIntent }
  | { outcome: 'link_error'; linkError: GitHubCloudLinkError };

/** Any GitHub for cloud result a landing URL can carry. */
export type GitHubCloudCallbackResult =
  | GitHubCloudSetupResult
  | GitHubCloudLinkResult;

export function isGitHubCloudSetupErrorReason(
  value: unknown,
): value is GitHubCloudSetupErrorReason {
  return GITHUB_CLOUD_SETUP_ERROR_REASONS.some((reason) => reason === value);
}

function deleteNamespacedParams(params: URLSearchParams): void {
  for (const name of NAMESPACED_PARAMS) params.delete(name);
}

/** Put `result` on a landing URL's query, replacing any earlier result. */
export function writeGitHubCloudSetupResult(
  params: URLSearchParams,
  result: GitHubCloudSetupResult,
): void {
  deleteNamespacedParams(params);
  params.set(GITHUB_CLOUD_SETUP_OUTCOME_PARAM, result.outcome);
  if (result.outcome === 'error') {
    params.set(GITHUB_CLOUD_SETUP_REASON_PARAM, result.reason);
  }
}

/** Put a link marker on a callback URL's query, replacing any earlier one. */
export function writeGitHubCloudLinkMarker(
  params: URLSearchParams,
  marker: GitHubCloudLinkMarker,
): void {
  deleteNamespacedParams(params);
  params.set(GITHUB_CLOUD_SETUP_OUTCOME_PARAM, marker.outcome);
  if (marker.outcome === 'linked' && marker.intent !== 'connect') {
    params.set(GITHUB_CLOUD_LINK_INTENT_PARAM, marker.intent);
  }
}

/** Better Auth appends its annotation after the page's own query. */
function lastValue(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length > 0 ? values[values.length - 1] : null;
}

/** The result on a landing URL's query, or `null` when it carries none. */
export function readGitHubCloudSetupResult(
  params: URLSearchParams,
): GitHubCloudCallbackResult | null {
  const outcome = params.get(GITHUB_CLOUD_SETUP_OUTCOME_PARAM);
  switch (outcome) {
    case 'connected':
    case 'requested':
    case 'unavailable':
      return { outcome };
    case 'error': {
      const reason = params.get(GITHUB_CLOUD_SETUP_REASON_PARAM);
      return {
        outcome,
        reason: isGitHubCloudSetupErrorReason(reason)
          ? reason
          : GITHUB_CLOUD_SETUP_INTERNAL_ERROR,
      };
    }
    case 'linked': {
      const intent = params.get(GITHUB_CLOUD_LINK_INTENT_PARAM);
      return {
        outcome,
        intent: isGitHubCloudConnectIntent(intent) ? intent : 'connect',
      };
    }
    case 'link_error':
      return {
        outcome,
        linkError:
          lastValue(params, BETTER_AUTH_ERROR_PARAM) ===
          BETTER_AUTH_LINKED_TO_ANOTHER_USER
            ? 'identity-linked-elsewhere'
            : 'link-failed',
      };
    default:
      return null;
  }
}

/** Remove the last value of `name`, keeping every other entry in order. */
function deleteLastValue(params: URLSearchParams, name: string): void {
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => {
    entries.push([key, value]);
  });
  const index = entries.map(([key]) => key).lastIndexOf(name);
  if (index < 0) return;
  entries.splice(index, 1);
  // Deleting a name twice is harmless, so no de-duplication is needed.
  entries
    .map(([key]) => key)
    .concat(name)
    .forEach((key) => params.delete(key));
  entries.forEach(([key, value]) => params.append(key, value));
}

/**
 * Remove this contract's parameters from a landing URL's query, plus Better
 * Auth's appended `error`/`error_description` on a link error callback. Every
 * other parameter stays. Returns whether anything was removed.
 */
export function stripGitHubCloudCallbackParams(
  params: URLSearchParams,
): boolean {
  const present = NAMESPACED_PARAMS.some((name) => params.has(name));
  if (!present) return false;
  if (params.get(GITHUB_CLOUD_SETUP_OUTCOME_PARAM) === 'link_error') {
    deleteLastValue(params, BETTER_AUTH_ERROR_PARAM);
    deleteLastValue(params, BETTER_AUTH_ERROR_DESCRIPTION_PARAM);
  }
  deleteNamespacedParams(params);
  return true;
}

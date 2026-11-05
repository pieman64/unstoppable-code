import { isOnboardingObject, normalizeTimestamp } from './shared';

/**
 * Durable, scope-local state for the one-time GitHub star nudge. Counts are
 * per persistence scope (desktop install, web account per browser).
 */
export interface GitHubStarPromptRecord {
  version: 1;
  /** Accepted chat sends, capped by writers at the threshold. */
  promptsSent: number;
  /** Diagnostic only; an impression does not retire the prompt. */
  shownAt?: string;
  dismissedAt?: string;
  /**
   * Star was accepted: starred in app, or the repository opened in the
   * browser. Not proof the repository was starred.
   */
  starredAt?: string;
}

/** Accepted sends after which the prompt becomes available. */
export const GITHUB_STAR_PROMPT_THRESHOLD = 5;

const TIMESTAMP_KEYS = ['shownAt', 'dismissedAt', 'starredAt'] as const;

/** Undefined means corrupt/unsupported, distinct from a never-initialized record. */
export function normalizeGitHubStarPromptRecord(
  value: unknown,
): GitHubStarPromptRecord | undefined {
  if (
    !isOnboardingObject(value) ||
    value.version !== 1 ||
    typeof value.promptsSent !== 'number' ||
    !Number.isSafeInteger(value.promptsSent) ||
    value.promptsSent < 0
  ) {
    return undefined;
  }
  const result: GitHubStarPromptRecord = {
    version: 1,
    promptsSent: value.promptsSent,
  };
  for (const key of TIMESTAMP_KEYS) {
    const timestamp = normalizeTimestamp(value[key]);
    if (timestamp !== undefined) result[key] = timestamp;
  }
  return result;
}

/**
 * Apply inside the persistence owner's serialized read/modify/write operation.
 * The count takes the maximum, so retried or stale writes cannot lower it, and
 * each timestamp is set once and then only advances, so a retired prompt stays
 * retired. This pure merge does not coordinate browser writers.
 */
export function mergeGitHubStarPromptRecords(
  current: GitHubStarPromptRecord,
  incoming: GitHubStarPromptRecord,
): GitHubStarPromptRecord {
  const merged: GitHubStarPromptRecord = {
    ...current,
    promptsSent: Math.max(current.promptsSent, incoming.promptsSent),
  };
  for (const key of TIMESTAMP_KEYS) {
    const timestamp = incoming[key];
    if (
      timestamp !== undefined &&
      (merged[key] === undefined || timestamp > merged[key])
    ) {
      merged[key] = timestamp;
    }
  }
  return merged;
}

export function isGitHubStarPromptRecordRetired(
  record: GitHubStarPromptRecord,
): boolean {
  return record.dismissedAt !== undefined || record.starredAt !== undefined;
}

export const STAR_SOURCE_REPOSITORY_FAILURE_REASONS = [
  'unavailable',
  'not_installed',
  'not_authenticated',
  'failed',
] as const;

export type StarSourceRepositoryFailureReason =
  (typeof STAR_SOURCE_REPOSITORY_FAILURE_REASONS)[number];

/**
 * The client-facing outcome of starring the product's source repository in
 * app. Any failure falls back to opening the repository in the browser.
 */
export type StarSourceRepositoryResult =
  | { starred: true }
  | { starred: false; reason: StarSourceRepositoryFailureReason };

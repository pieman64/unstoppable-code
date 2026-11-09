/**
 * Shared pipeline environment variable constants and helpers for the
 * base-branch feature.
 *
 * Both the main-process env builder and the builtin action runner must use
 * these identical constants so the contracts stay in sync.
 */
import {
  brandEnvCandidates,
  brandEnvName,
} from '@canopy/execution-engine/brand/env';

// ---------------------------------------------------------------------------
// Env var names
// ---------------------------------------------------------------------------

/** Single base branch for the active worktree. */
export const CANOPY_BASE_BRANCH_ENV = brandEnvName('BASE_BRANCH');

/** Whether the single base branch exists on the remote ("true" / "false"). */
export const CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_ENV = brandEnvName(
  'BASE_BRANCH_EXISTS_IN_REMOTE',
);

/** JSON-encoded map of repo-id → base branch name for multi-repo workspaces. */
export const CANOPY_BASE_BRANCH_BY_REPO_ENV = brandEnvName(
  'BASE_BRANCH_BY_REPO',
);

/** JSON-encoded map of repo-id → "true"/"false" for remote existence, multi-repo. */
export const CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO_ENV = brandEnvName(
  'BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO',
);

// ---------------------------------------------------------------------------
// All managed env keys (useful for stripping during replay)
// ---------------------------------------------------------------------------

export const BASE_BRANCH_MANAGED_ENV_KEYS = [
  ...brandEnvCandidates('BASE_BRANCH'),
  ...brandEnvCandidates('BASE_BRANCH_EXISTS_IN_REMOTE'),
  ...brandEnvCandidates('BASE_BRANCH_BY_REPO'),
  ...brandEnvCandidates('BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO'),
] as const;

// ---------------------------------------------------------------------------
// Serialize / parse helpers for repo-keyed JSON maps
// ---------------------------------------------------------------------------

/**
 * Serialize a `Record<string, string>` into a JSON string suitable for an
 * environment variable value. Returns `undefined` when the map is empty or
 * nullish so callers can skip setting the var.
 */
export function serializeRepoMap(
  map: Record<string, string> | undefined | null,
): string | undefined {
  if (!map || Object.keys(map).length === 0) return undefined;
  return JSON.stringify(map);
}

/**
 * Parse a JSON-encoded repo-keyed map back into a record.
 * Returns an empty object on invalid / missing input.
 */
export function parseRepoMap(
  raw: string | undefined | null,
): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }

    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        record[key] = value;
      }
    }

    return record;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Strip managed keys from an env object (used during replay)
// ---------------------------------------------------------------------------

/**
 * Return a shallow copy of `env` with all base-branch managed keys removed.
 * Useful when replaying a pipeline run so stale values don't leak through.
 */
export function stripBaseBranchEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const copy = { ...env };
  for (const key of BASE_BRANCH_MANAGED_ENV_KEYS) {
    delete copy[key];
  }
  return copy;
}

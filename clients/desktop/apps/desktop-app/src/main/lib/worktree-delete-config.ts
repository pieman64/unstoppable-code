import { getBrandEnv } from '@canopy/desktop-shared/brand/env';

export const DEFAULT_WORKTREE_DELETE_TIMEOUT_MS = 5 * 60_000;
const MIN_WORKTREE_DELETE_TIMEOUT_MS = 1_000;
const MAX_WORKTREE_DELETE_TIMEOUT_MS = 60 * 60_000;

export function getWorktreeDeleteTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const configured = getBrandEnv(env, 'WORKTREE_DELETE_TIMEOUT_MS');
  if (configured === undefined) {
    return DEFAULT_WORKTREE_DELETE_TIMEOUT_MS;
  }

  const timeoutMs = Number(configured);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_WORKTREE_DELETE_TIMEOUT_MS ||
    timeoutMs > MAX_WORKTREE_DELETE_TIMEOUT_MS
  ) {
    return DEFAULT_WORKTREE_DELETE_TIMEOUT_MS;
  }

  return timeoutMs;
}

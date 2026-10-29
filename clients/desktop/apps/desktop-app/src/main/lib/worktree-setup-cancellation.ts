export interface WorktreeSetupCancellationRef {
  workspaceId: string;
  worktreeId: string;
  createdAt: string;
}

const cancellationTokens = new Map<string, Set<string>>();

function getCancellationKey(ref: WorktreeSetupCancellationRef): string {
  return `${ref.workspaceId}\0${ref.worktreeId}`;
}

export function markWorktreeSetupCancellation(
  ref: WorktreeSetupCancellationRef,
): void {
  const key = getCancellationKey(ref);
  const tokens = cancellationTokens.get(key) ?? new Set<string>();
  tokens.add(ref.createdAt);
  cancellationTokens.set(key, tokens);
}

export function isWorktreeSetupCancellationRequested(
  ref: WorktreeSetupCancellationRef,
): boolean {
  return (
    cancellationTokens.get(getCancellationKey(ref))?.has(ref.createdAt) === true
  );
}

export function consumeWorktreeSetupCancellation(
  ref: WorktreeSetupCancellationRef,
): void {
  const key = getCancellationKey(ref);
  const tokens = cancellationTokens.get(key);
  if (!tokens) {
    return;
  }

  tokens.delete(ref.createdAt);
  if (tokens.size === 0) {
    cancellationTokens.delete(key);
  }
}

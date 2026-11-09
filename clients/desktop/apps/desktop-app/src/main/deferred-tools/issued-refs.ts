import type { DeferredToolsReloadScopeKey } from '@canopy/desktop-shared/types';

/** Chats whose search results Load remembers; the oldest is forgotten first. */
const MAX_SCOPES = 256;
/** Refs remembered per chat; the oldest is forgotten first. */
const MAX_REFS_PER_SCOPE = 2_000;

const issued = new Map<string, Set<string>>();

function scopeKey(scope: DeferredToolsReloadScopeKey): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]);
}

/**
 * Records the refs a search returned to one chat (CAN-5995). Load enables only
 * refs that search returned to the same chat in this process, so a ref built
 * by hand, or returned to another chat, is refused before any write.
 */
export function recordIssuedDeferredRefs(
  scope: DeferredToolsReloadScopeKey,
  refs: readonly string[],
): void {
  if (refs.length === 0) return;
  const key = scopeKey(scope);
  const current = issued.get(key) ?? new Set<string>();
  issued.delete(key);
  for (const ref of refs) {
    current.delete(ref);
    current.add(ref);
  }
  for (const ref of current) {
    if (current.size <= MAX_REFS_PER_SCOPE) break;
    current.delete(ref);
  }
  issued.set(key, current);
  for (const oldest of issued.keys()) {
    if (issued.size <= MAX_SCOPES) break;
    issued.delete(oldest);
  }
}

export function wasDeferredRefIssued(
  scope: DeferredToolsReloadScopeKey,
  ref: string,
): boolean {
  return issued.get(scopeKey(scope))?.has(ref) === true;
}

export function resetIssuedDeferredRefsForTests(): void {
  issued.clear();
}

/**
 * The identity every per-chat agent runtime is keyed by.
 *
 * A dependency-free leaf module on purpose. `session-manager.ts` owns the
 * session registry and pulls in observability, wake locks, telemetry, and the
 * provider clients; modules that need only the KEY — the Canopy-injected tool
 * executor publishing a mid-turn auth failure, for one — must be able to
 * compute it without dragging that graph in behind them (CAN-1814 PR 4).
 *
 * The format is load-bearing beyond the session map: `worktree-chat-turn.ts`
 * uses the same string as the route owner id under which pending
 * authentication failures are published and claimed, so a second, subtly
 * different spelling would silently never pair.
 */
export function buildChatSessionKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${projectId}/${worktreeId}/${chatId}`;
}

/**
 * Parse a session key back into its project / worktree / chat identifiers.
 *
 * The session map is keyed by the literal `${projectId}/${worktreeId}/${chatId}`
 * string. This is the single authoritative parser for that shape — do not
 * `.split('/')` on session keys outside of this helper. Call sites that already
 * hold the three identifiers separately should pass them directly instead of
 * re-deriving them from the key.
 */
export function parseChatSessionKey(key: string): {
  projectId: string;
  worktreeId: string;
  chatId: string;
} {
  const parts = key.split('/');
  if (parts.length !== 3) {
    throw new Error(`Invalid session key: ${key}`);
  }

  const [projectId, worktreeId, chatId] = parts;
  if (!projectId || !worktreeId || !chatId) {
    throw new Error(`Invalid session key: ${key}`);
  }
  return { projectId, worktreeId, chatId };
}

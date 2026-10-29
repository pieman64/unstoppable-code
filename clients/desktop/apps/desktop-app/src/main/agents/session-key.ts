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

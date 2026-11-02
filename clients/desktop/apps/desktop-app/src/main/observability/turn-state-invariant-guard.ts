/**
 * Runtime invariant diagnostics (turn-state phase 43c). Each committed turn
 * state carries the timer rows its commit wrote; a chat's open timers must
 * belong to its one running turn. A violation is reported once per chat and
 * invariant, and never changes the commit.
 */
import { buildChatSessionKey } from '../agents/session-key';
import type {
  ChatTurnStateChange,
  ChatTurnStateCommit,
} from '../services/chat-turn-state-handoff';
import type { SessionDiagnosticRecord } from './service';

type TurnStateInvariant = NonNullable<
  SessionDiagnosticRecord['turnStateInvariant']
>;

export function installTurnStateInvariantGuard(
  record: (diagnostic: SessionDiagnosticRecord) => void,
  chatState: {
    onTurnStateCommitted(
      listener: (commit: ChatTurnStateCommit) => void,
    ): () => void;
    onTurnStateChange(
      listener: (change: ChatTurnStateChange) => void,
    ): () => void;
  },
): () => void {
  // shortcut: only rows written by turn-state commits are seen, so a timer
  // opened before launch is missed; reading the transcript would not be O(1).
  const openTimers = new Map<string, Set<string>>();
  const reported = new Set<string>();
  // Host reconcile (restart) and reset-to-point or removal (reset) settle or
  // remove a chat's timers in transactions that publish no turn-state commit.
  const offChange = chatState.onTurnStateChange((change) => {
    if (change.cause !== 'restart' && change.cause !== 'reset') return;
    const { projectId, worktreeId, chatId } = change.scope;
    openTimers.delete(buildChatSessionKey(projectId, worktreeId, chatId));
  });
  const offCommitted = chatState.onTurnStateCommitted((commit) => {
    const { projectId, worktreeId, chatId } = commit.scope;
    const sessionKey = buildChatSessionKey(projectId, worktreeId, chatId);
    const open = openTimers.get(sessionKey) ?? new Set<string>();
    for (const row of commit.timerMessages ?? []) {
      for (const block of row.blocks) {
        if (block.type !== 'turn_timer') continue;
        if (block.completedAt === null) open.add(row.id);
        else open.delete(row.id);
      }
    }
    if (open.size === 0) openTimers.delete(sessionKey);
    else openTimers.set(sessionKey, open);
    const report = (invariant: TurnStateInvariant): void => {
      const id = JSON.stringify([sessionKey, invariant]);
      if (reported.has(id)) return;
      reported.add(id);
      try {
        record({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'turn_state_invariant_violation',
          sessionKey,
          projectId,
          worktreeId,
          chatId,
          providerType: 'unknown',
          turnStateInvariant: invariant,
          openTimerCount: open.size,
        });
      } catch {
        // Diagnostics are best-effort and must never change a commit.
      }
    };
    if (open.size > 1) report('two_open_timers');
    if (open.size > 0 && commit.state.current === undefined)
      report('settled_runtime_open_timer');
  });
  return (): void => {
    offChange();
    offCommitted();
  };
}

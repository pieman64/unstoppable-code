/**
 * Remote Control re-projection of a chat's summary when its canonical turn
 * phase or background count changes (turn-state phases 41a and 41b). The
 * summaries read both, but nothing else re-sends them when only background
 * work starts or ends, so the Portal's working state and background spinner
 * would otherwise go stale.
 */
import { backgroundTaskCount } from '@canopy/desktop-shared/lib/background-work';
import { getChatStateService } from '../services/chat-state-service';
import type { ChatTurnStateScope } from '../services/chat-turn-state-handoff';

export function subscribePortalCanonicalTurnSummaries(
  emitSummary: (scope: ChatTurnStateScope) => void,
): () => void {
  const service = getChatStateService();
  /** The last phase and count sent per chat, so an unchanged commit sends nothing. */
  const sent = new Map<string, string>();
  const unsubscribe = service.onTurnStateCommitted((commit): void => {
    const { projectId, worktreeId, chatId } = commit.scope;
    const key = JSON.stringify([projectId, worktreeId, chatId]);
    const signature = `${commit.state.phase}:${String(
      backgroundTaskCount(
        commit.state.background.managed,
        commit.state.background.native,
      ),
    )}`;
    if (sent.get(key) === signature) return;
    sent.set(key, signature);
    emitSummary({ projectId, worktreeId, chatId });
  });
  return (): void => {
    unsubscribe();
    sent.clear();
  };
}

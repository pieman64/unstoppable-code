/**
 * Canonical turn state decides the audit entries of turns no dispatcher
 * started, such as a wake (turn-state phase 35d1). Receipt state announces
 * each autonomous turn before its provider frames arrive; the turn's first
 * root frame opens its own entry and its terminal frame closes it, so the
 * entry keeps all of the turn's output and usage, whenever its commit lands.
 * Each ended turn's canonical duration, net of its approval and question
 * pauses, becomes its audit entry's duration (CAN-5096).
 */
import { chatTurnPausedDurationMs } from '@canopy/agent-transcript/turn';
import type { ChatTurnStateChange } from '../services/chat-turn-state-handoff';
import type { ObservabilityService } from './service';

/** Subscribe the audit to receipt turn state; canonical root turns only. */
export function installTurnStateAudit(
  observability: ObservabilityService,
  chatState: {
    onTurnStateChange(
      listener: (change: ChatTurnStateChange) => void,
    ): () => void;
  },
): () => void {
  observability.enableTurnStateAudit();
  return chatState.onTurnStateChange((change) => {
    // A hydrated, restarted or reset state starts no new turn.
    if (change.cause === 'lifecycle')
      observability.observeTurnState(change.scope, change.state);
    // Every ended turn reports its canonical duration, net of its pauses.
    const ended = change.state.lastEnded;
    for (const effect of change.effects) {
      if (
        effect.type !== 'timer.close' ||
        effect.durationMs === undefined ||
        ended === undefined ||
        ended.id !== effect.turnId
      )
        continue;
      observability.recordCanonicalTurnDuration(
        change.scope.projectId,
        change.scope.worktreeId,
        change.scope.chatId,
        {
          turnId: effect.turnId,
          ...(ended.userMessageId === undefined
            ? {}
            : { userMessageId: ended.userMessageId }),
          durationMs: effect.durationMs,
          pausedMs: chatTurnPausedDurationMs(ended),
        },
      );
    }
  });
}

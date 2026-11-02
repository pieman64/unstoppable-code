/**
 * Canonical turn state decides the audit entries of turns no dispatcher
 * started, such as a wake (turn-state phase 35d1). Receipt state announces
 * each autonomous turn before its provider frames arrive; the turn's first
 * root frame opens its own entry and its terminal frame closes it, so the
 * entry keeps all of the turn's output and usage, whenever its commit lands.
 */
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
  });
}

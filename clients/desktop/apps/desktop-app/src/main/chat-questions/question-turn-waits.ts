import type {
  ChatWaitLifecycle,
  ChatWaitStatus,
} from '@canopy/core-runtime/node/agent/waits';
import type { WorkerAgentTurnWaitResolution } from '@canopy/protocol/canopy-core';
import { emitChatTurnWait } from '../agent-runs/turn-runs';

const installed = new WeakMap<ChatWaitLifecycle, () => void>();

/** CAN-4128 D12: a failed wait ended without an answer, as a cancellation. */
function resolutionOf(status: ChatWaitStatus): WorkerAgentTurnWaitResolution {
  switch (status) {
    case 'answered':
      return 'answered';
    case 'expired':
      return 'expired';
    case 'cancelled':
    case 'failed':
      return 'cancelled';
  }
}

/**
 * Report every question wait on the chat's live turn run (CAN-4128 D10):
 * wait_opened with waitKind 'question', then wait_resolved. Approvals report
 * their own (CAN-4129); plan exit never waits. Installs once per lifecycle.
 */
export function installQuestionTurnWaits(
  lifecycle: ChatWaitLifecycle,
): () => void {
  const existing = installed.get(lifecycle);
  if (existing) return existing;
  const unsubscribe = lifecycle.observe({
    opened: ({ waitId, kind, scope }): void => {
      if (kind !== 'question' || !scope) return;
      emitChatTurnWait(scope, {
        kind: 'wait_opened',
        waitId,
        waitKind: 'question',
      });
    },
    settled: ({ waitId, kind, scope, status }): void => {
      if (kind !== 'question' || !scope) return;
      emitChatTurnWait(scope, {
        kind: 'wait_resolved',
        waitId,
        resolution: resolutionOf(status),
      });
    },
  });
  installed.set(lifecycle, unsubscribe);
  return unsubscribe;
}

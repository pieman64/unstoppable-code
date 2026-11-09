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
 * Report every approval wait on the chat's live turn run (CAN-4129, through
 * CAN-4128's emitChatTurnWait): wait_opened with waitKind 'approval', then
 * wait_resolved. Questions report their own (CAN-4128). Installs once per
 * lifecycle.
 */
export function installApprovalTurnWaits(
  lifecycle: ChatWaitLifecycle,
): () => void {
  const existing = installed.get(lifecycle);
  if (existing) return existing;
  const unsubscribe = lifecycle.observe({
    opened: ({ waitId, kind, scope }): void => {
      if (kind !== 'approval' || !scope) return;
      emitChatTurnWait(scope, {
        kind: 'wait_opened',
        waitId,
        waitKind: 'approval',
      });
    },
    settled: ({ waitId, kind, scope, status }): void => {
      if (kind !== 'approval' || !scope) return;
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

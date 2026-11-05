import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import { DELEGATION_SETTLED_STATUSES, delegationRunKey } from './item-changes';

export type DelegationLiveClass = 'essential' | 'detail';

interface DelegationLiveState {
  readonly status: AgentDelegationSnapshot['status'];
  readonly approvalPending: boolean;
  readonly controlOperationId: string | undefined;
  readonly controlStatus:
    | NonNullable<AgentDelegationSnapshot['control']>['status']
    | undefined;
  readonly stopRequestedOperationId: string | undefined;
  readonly stopRequestedStatus:
    | NonNullable<AgentDelegationSnapshot['stopRequested']>['status']
    | undefined;
}

function stateFor(transcript: AgentDelegationTranscript): DelegationLiveState {
  const snapshot = transcript.snapshot;
  return {
    status: snapshot.status,
    approvalPending: snapshot.approvalPending === true,
    controlOperationId: snapshot.control?.operationId,
    controlStatus: snapshot.control?.status,
    stopRequestedOperationId: snapshot.stopRequested?.operationId,
    stopRequestedStatus: snapshot.stopRequested?.status,
  };
}

function sameState(
  left: DelegationLiveState,
  right: DelegationLiveState,
): boolean {
  return (
    left.status === right.status &&
    left.approvalPending === right.approvalPending &&
    left.controlOperationId === right.controlOperationId &&
    left.controlStatus === right.controlStatus &&
    left.stopRequestedOperationId === right.stopRequestedOperationId &&
    left.stopRequestedStatus === right.stopRequestedStatus
  );
}

/** Classifies live snapshots without retaining their transcript contents. */
export class DelegationLiveFrameClassifier {
  private readonly runs = new Map<string, DelegationLiveState>();

  classify(transcript: AgentDelegationTranscript): DelegationLiveClass {
    const key = delegationRunKey(transcript);
    const current = stateFor(transcript);
    if (DELEGATION_SETTLED_STATUSES.has(current.status)) {
      this.runs.delete(key);
      return 'essential';
    }

    const previous = this.runs.get(key);
    this.runs.set(key, current);
    return !previous || !sameState(previous, current) ? 'essential' : 'detail';
  }

  /** Drops retained snapshots when their chat root is closed. */
  clear(): void {
    this.runs.clear();
  }
}

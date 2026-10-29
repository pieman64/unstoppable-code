import type { AgentDelegationSnapshot } from './index';
import type { AgentDelegationTranscriptItem } from './transcript';

/** Portable projections for the unmigrated desktop delegation viewer. */
export interface ManagedDelegationTreeEntry {
  snapshot: AgentDelegationSnapshot;
  description: string;
  prompt: string;
  executionMode: 'foreground' | 'background';
  runGeneration: number;
  sequence: number;
  createdAt: number;
  runStartedAt?: number;
  runSettledAt?: number;
  parentHarnessId: string;
}
export interface ManagedDelegationRootEntry {
  chatId: string;
  total: number;
  live: number;
  lastActivityAt: number;
}
export interface ManagedDelegationTranscriptPage {
  task: {
    description: string;
    prompt: string;
    executionMode: 'foreground' | 'background';
  };
  snapshot: AgentDelegationSnapshot;
  runGeneration: number;
  /** The run's transcript revision, which advances when any item changes. */
  revision: number;
  items: AgentDelegationTranscriptItem[];
  hasMore: boolean;
  /** No items: the run's revision is not newer than the request's `sinceRevision`. */
  unchanged?: true;
}
export interface ManagedDelegationWorktreeSummary {
  delegationId: string;
  checkout: 'retained' | 'discarded' | 'missing';
  startingRevision: string;
  startingSubject?: string;
  startingBranch?: string;
  filesChanged: number;
  additions: number;
  deletions: number;
  commitsAhead: number;
  untrackedFiles: number;
  applyState: 'not_applied' | 'applied' | 'apply_failed' | 'discarded';
  topFiles: {
    path: string;
    additions: number;
    deletions: number;
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  }[];
  truncated: boolean;
}

import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import type { DelegatedAgentCallBlock } from '../types';

// Schema-free on purpose: the renderer loads the package index at startup, and
// the card-state fitter's protocol schemas cost about 23 MB of heap there.

/** Raw-row copies are immutable fallbacks; aliases are derived on V2 overlay. */
export const STREAM_CARD_KEY_CLASSES = {
  type: 'creation',
  delegationId: 'creation',
  runGeneration: 'creation',
  depth: 'creation',
  parentDelegationId: 'creation',
  parentDescription: 'creation',
  permissions: 'creation',
  agentBlockId: 'creation',
  sequence: 'creation',
  parentHarnessId: 'creation',
  parentTurnId: 'creation',
  parentToolCallId: 'creation',
  createdAt: 'creation',
  selectedModelId: 'creation',
  runtimeModelId: 'creation',
  targetHarnessId: 'creation',
  requestedThinkingLevel: 'creation',
  effectiveThinkingLevel: 'creation',
  description: 'creation',
  prompt: 'creation',
  executionMode: 'creation',
  transcriptStore: 'creation',
  status: 'draft',
  routeSnapshot: 'draft',
  requestedModelId: 'draft',
  nativeSessionId: 'draft',
  nestedDelegation: 'draft',
  childDelegationIds: 'draft',
  capabilities: 'draft',
  isolatedWorkspace: 'draft',
  workspaceDiscarded: 'draft',
  control: 'draft',
  cancelledByUser: 'draft',
  stoppedBy: 'draft',
  outputTruncated: 'draft',
  resultIndex: 'canonical',
  error: 'canonical',
  usage: 'canonical',
  stopReason: 'canonical',
  finalText: 'canonical',
  finalTextRef: 'canonical',
  partialTextRef: 'canonical',
  partialText: 'live-only',
  phase: 'live-only',
  queue: 'live-only',
  approvalPending: 'live-only',
  stopRequested: 'live-only',
  workspaceObservation: 'live-only',
  streamRevision: 'read-only',
} as const satisfies Record<
  keyof DelegatedAgentCallBlock,
  'creation' | 'draft' | 'canonical' | 'live-only' | 'read-only'
>;

const SETTLED_STATUSES: ReadonlySet<AgentDelegationSnapshot['status']> =
  new Set<AgentDelegationSnapshot['status']>([
    'completed',
    'failed',
    'cancelled',
    'deadline_exceeded',
    'interrupted',
  ]);

type MutableSnapshot = {
  -readonly [Key in keyof AgentDelegationSnapshot]: AgentDelegationSnapshot[Key];
};

/** Legacy durable projection. Keep its spread/delete and property order unchanged. */
export function persistedDelegationSnapshot(
  snapshot: AgentDelegationSnapshot,
): AgentDelegationSnapshot {
  const persisted: MutableSnapshot & { streamRevision?: unknown } = {
    ...snapshot,
  };
  delete persisted.streamRevision;
  delete persisted.partialText;
  delete persisted.phase;
  delete persisted.queue;
  delete persisted.approvalPending;
  delete persisted.stopRequested;
  delete persisted.workspaceObservation;
  if (persisted.control?.status === 'accepted') delete persisted.control;
  if (!SETTLED_STATUSES.has(snapshot.status)) delete persisted.usage;
  return persisted;
}

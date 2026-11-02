// Shared, host-neutral display pieces for the subagent viewer: the Subagents
// panel, the subagent chat panel, Open chat on agent cards and attached-
// subagent chips. Pure display: no stores, transport or host checks.
//
// The subagent tree model lives in `@canopy/agent-transcript`; it is
// re-exported here so feature packages that may not import
// `@canopy/agent-transcript` directly (`@canopy/ui-app`) reach it through
// `@canopy/ui-shared`, as `normalizeCommandReadToolBlock` already does.
export {
  SUBAGENT_KINDS,
  countsAsSubagent,
  isNativeSubagentKind,
  isSubagentChatKind,
  isSubagentGroupKind,
  nativeSubagentInterruptSupported,
  parseWorkflowAgentNodeId,
  workflowAgentNodeId,
  workflowPhaseNodeId,
  workflowRunNodeId,
  autoSubagentLevelCount,
  buildSubagentTree,
  countSubagentsByFilter,
  formatSubagentReference,
  isLiveSubagentStatus,
  matchesSubagentFilter,
  parseSubagentReference,
  projectSubagentSkipEdges,
  projectSubagentTree,
  subagentAncestors,
  subagentDescendants,
  subagentRecipients,
  windowSubagentTree,
  withSubagentReference,
  type SubagentChatKind,
  type SubagentGroupKind,
  type SubagentKind,
  type SubagentWorkflowInfo,
  type WorkflowAgentInputState,
  type WorkflowAgentSubagentInput,
  type WorkflowRunSubagentInput,
  type SubagentLevelsSetting,
  type SubagentNode,
  type SubagentRecipient,
  type SubagentReference,
  type SubagentRun,
  type SubagentSkipEdgeNode,
  type SubagentSkipEdgeProjection,
  type SubagentStatus,
  type SubagentStatusFilter,
  type SubagentTree,
  type SubagentTreeWindow,
  type SubagentWindowItem,
  type SubagentWindowNode,
  type SubagentWindowStub,
  type AnySubagentChatTranscriptItem,
} from '@canopy/agent-transcript';
export * from './types';
export * from './subagent-copy';
export * from './common';
export * from './reference';
export * from './panel';
export * from './conversation';

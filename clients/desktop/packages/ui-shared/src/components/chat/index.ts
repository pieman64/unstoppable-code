// Pure display chat primitives shared between the desktop renderer and the
// web portal. All components in this barrel are display-only and free of
// stores, IPC, Electron, Node, or Next dependencies. Hosts wrap them with
// the runtime state they need (copy buttons, revert handlers, store subs).
export * from './tool-display-info';
export * from './exit-plan-mode-plan';
export * from './tool-display';
export * from './step-words';
export * from './ChatAppNote';
export * from './StepRow';
export * from './ChatCopyAction';
export * from './TurnMoreMenu';
export * from './ToolCallCard';
export * from './CollapsibleBlock';
export * from './CollapsedTurnSummary';
export * from './AgentBlockCard';
export * from './TurnGroup';
export * from './TurnDiffSummary';
export * from './QueuedMessageBubble';
export * from './MessageEditEntry';
export * from './MessageEditCard';
export * from './AskUserQuestionCard';
export {
  AgentVisualFrame,
  type AgentVisualFrameProps,
  type AgentVisualFrameStatus,
  type AgentVisualFrameTestIds,
  useAgentVisualHostTheme,
} from './AgentVisualFrame';

export { DeferredTextOutput } from './DeferredTextOutput';
export { TranscriptPagingControls } from './TranscriptPagingControls';
export * from './FileDeliverableCard';
export * from './FileAttachmentChip';
export * from './MessageImageAttachments';
export { DelegatedAgentCard } from './DelegatedAgentCard';
export {
  DelegatedAgentCapabilities,
  type DelegatedAgentCapabilitiesProps,
} from './DelegatedAgentCapabilities';
export * from './delegated-agent-copy';
export * from './CompactionInfoBlock';
export * from './AccountProxySwitchLine';
export * from './DeferredAccountProxySwitchPart';
export * from './SteeringTitle';
export * from './SteeringRequestTitle';
export { normalizeCommandReadToolBlock } from '@canopy/agent-transcript/lib/command-read-display';
export * from './subagents';

export { QuestionOptionText } from './QuestionOptionText';
export * from './TurnWorkHeader';

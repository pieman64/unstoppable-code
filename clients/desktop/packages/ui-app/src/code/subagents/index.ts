// Shared subagent viewer feature UI: the Subagents panel, the subagent chat
// panel, their view-state and draft stores, and the actions context the chat
// transcript reads for Open chat. Hosts mount these and supply data and
// callbacks; see each component's props.
export * from './types';
export { subagentCapabilitiesForKind } from './subagent-capabilities';
export {
  SubagentChatActionsContext,
  useSubagentChatActions,
  type SubagentChatActions,
} from './SubagentChatActionsContext';
export * from './panel';
export * from './conversation';

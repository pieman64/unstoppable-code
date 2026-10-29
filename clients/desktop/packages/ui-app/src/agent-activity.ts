/**
 * `@canopy/ui-app/agent-activity`: a turn's Agent activity section and the
 * per-turn grouping of background tasks. A dedicated subpath keeps the
 * transcript's import path off the root barrel.
 */
export {
  AgentActivitySection,
  type AgentActivitySectionProps,
} from './code/agent-activity/AgentActivitySection';
export {
  groupBackgroundWorkByTurn,
  type TurnToolUseOwnership,
} from './code/agent-activity/turn-background-tasks';
export {
  TurnAgentArtifacts,
  type TurnAgentArtifactsProps,
} from './code/agent-activity/TurnAgentArtifacts';
export { collectTurnAgentArtifacts } from './code/agent-activity/turn-agent-artifacts';
export {
  AgentArtifactTileHostProvider,
  useAgentArtifactTileHost,
  type AgentArtifactTileHost,
} from './code/agent-activity/agent-artifact-tile-host';

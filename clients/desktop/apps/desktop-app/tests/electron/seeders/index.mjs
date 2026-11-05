// Core harness seeders for the Canopy Electron UI-automation suite.
//
// Each seeder writes a test's own `CANOPY_DATA_DIR` (or registers mock-server
// scenario state) and is documented against the main-process reader/writer it
// targets. See Doc 4 §C (layered seeders) and Doc 13 §2/§4.

export { writeJson } from './fsHelpers.mjs';
export { seedCoworkWorkspace } from './seedCoworkWorkspace.mjs';
export { seedWorktreeChat } from './seedWorktreeChat.mjs';
export { seedOrphanedStreamingTurn } from './seedOrphanedStreamingTurn.mjs';
export { seedUsageLimitedChats } from './seedUsageLimitedChats.mjs';
export { injectChatEvent } from './injectChatEvent.mjs';
export {
  armClaudeQueryPrelude,
  readClaudeQueryPreludeState,
} from './claudeQueryPrelude.mjs';
export { seedTrackedPlans } from './seedTrackedPlans.mjs';
export {
  buildLargePlanFixture,
  buildTrackedPlan,
  dataModelDiffFor,
  logicDiffFor,
  readyDiagramArtifacts,
  sequenceGraphFor,
} from './trackedPlanFixtures.mjs';
export { registerSharedPlanScenario } from './sharedPlanCloud.mjs';
export { registerHostedSettingsScenario } from './hostedSettingsCloud.mjs';
export { seedUsageEvents } from './seedUsageEvents.mjs';
export { seedObservabilityAudit } from './seedObservabilityAudit.mjs';
export { seedCostInsights } from './seedCostInsights.mjs';
export { seedAutomations } from './seedAutomations.mjs';
export { seedMcpServers } from './seedMcpServers.mjs';
export { seedPipelineExecution } from './seedPipelineExecution.mjs';
export { seedStoredPipeline } from './seedStoredPipeline.mjs';
export { seedScriptRun } from './seedScriptRun.mjs';
export { seedWatchers } from './seedWatchers.mjs';
export { injectResourceSnapshot } from './seedResourceSnapshot.mjs';
export { injectBrowserSnapshot } from './seedBrowserSnapshot.mjs';
export {
  injectGithubPrStatus,
  buildPrStatusData,
} from './injectGithubPrStatus.mjs';
export {
  registerScenario,
  clearScenario,
  getScenarioActivity,
  resetScenarios,
  DEFAULT_MOCK_BASE_URL,
} from './registerScenario.mjs';
export { seedPluginsCache } from './seedPluginsCache.mjs';
export { seedWorkspaceApprovals } from './seedWorkspaceApprovals.mjs';
export { injectApprovalRequestEvent } from './injectApprovalRequestEvent.mjs';
export { initializeIsolatedCodexState } from './initializeIsolatedCodexState.mjs';
export { ORG_CONTEXT_ENV } from './seedOrgContextScoping.mjs';

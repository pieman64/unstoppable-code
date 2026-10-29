// Core harness seeders for the Canopy Electron UI-automation suite.
//
// Each seeder writes a test's own `CANOPY_DATA_DIR` (or registers mock-server
// scenario state) and is documented against the main-process reader/writer it
// targets. See Doc 4 §C (layered seeders) and Doc 13 §2/§4.

export { writeJson, writeJsonl, isoDay } from './fsHelpers.mjs';
export { seedBlueprintCatalog } from './seedBlueprintCatalog.mjs';
export { seedCoworkWorkspace } from './seedCoworkWorkspace.mjs';
export {
  seedChatsSectionFixture,
  CHATS_SECTION_CODE_WORKSPACE_ID,
  CHATS_SECTION_DEFAULT_COWORK_ID,
  CHATS_SECTION_NAMED_COWORK_ID,
} from './seedChatsSectionFixture.mjs';
export {
  seedPinnedItemsFixture,
  PINNED_ITEMS_ADVISOR_ENTRY_IDS,
  PINNED_ITEMS_PINNED_ADVISOR_ENTRY_ID,
  PINNED_ITEMS_PINNED_CHAT_ENTRY_ID,
  PINNED_ITEMS_PINNED_WORKTREE_ID,
} from './seedPinnedItemsFixture.mjs';
export { seedAgentModels } from './seedAgentModels.mjs';
export { seedUnreadPreviewWorkspace } from './seedUnreadPreviewWorkspace.mjs';
export { seedWorktreeChat } from './seedWorktreeChat.mjs';
export { seedOrphanedStreamingTurn } from './seedOrphanedStreamingTurn.mjs';
export { seedUsageLimitedChats } from './seedUsageLimitedChats.mjs';
export { injectChatEvent } from './injectChatEvent.mjs';
export {
  armClaudeQueryPrelude,
  readClaudeQueryPreludeState,
  resetClaudeQueryPreludes,
} from './claudeQueryPrelude.mjs';
export { seedTrackedPlans } from './seedTrackedPlans.mjs';
export {
  agentComment,
  assertSeedableTrackedPlan,
  buildLargePlanFixture,
  buildPlanCommentThread,
  buildTrackedPlan,
  dataModelDiffFor,
  diagramNodeAnchor,
  documentAnchor,
  generalAnchor,
  LARGE_PLAN_SENTINEL,
  logicDiffFor,
  readyDiagramArtifacts,
  remoteComment,
  SEEDED_SHARED_PLAN_SNAPSHOT_HASH,
  sequenceGraphFor,
  SHARED_PLAN_FIXTURE_TIME,
  SHARED_PLAN_SERVER_ID,
  SHARED_PLAN_TEAMMATES,
  sharedPlanServerSeed,
  teamShareState,
  toWireCommentThreads,
  userComment,
} from './trackedPlanFixtures.mjs';
export {
  addSharedPlanReply,
  addSharedPlanThread,
  emitSharedPlanSignal,
  readSharedPlanDetail,
  readSharedPlanRequests,
  registerSharedPlanScenario,
  setSharedPlanThreadStatus,
  sharedPlanScenario,
} from './sharedPlanCloud.mjs';
export {
  closeHostedSettingsFeedStreams,
  expireHostedSettingsSessions,
  HOSTED_SETTINGS_LIVE_FEED_ITEM_ID,
  HOSTED_SETTINGS_SCENARIO_NAMES,
  HOSTED_SETTINGS_SCENARIOS,
  hostedSettingsScenario,
  pushHostedSettingsFeedItems,
  readHostedSettingsRequests,
  readHostedSettingsState,
  registerHostedSettingsScenario,
} from './hostedSettingsCloud.mjs';
export { seedCodeReviewState } from './seedCodeReviewState.mjs';
export { seedUsageEvents } from './seedUsageEvents.mjs';
export { seedObservabilityAudit } from './seedObservabilityAudit.mjs';
export { seedCostInsights } from './seedCostInsights.mjs';
export { seedAutomations } from './seedAutomations.mjs';
export { seedMcpServers } from './seedMcpServers.mjs';
export {
  DEFERRED_ECHO_TOOL_NAME,
  seedDeferredEchoServer,
} from './deferredToolsReloadFixture.mjs';
export { seedPipelineExecution } from './seedPipelineExecution.mjs';
export { seedStoredPipeline } from './seedStoredPipeline.mjs';
export {
  clearPipelineShareSecurityAndFrontmatterProblems,
  seedPipelineShareUnresolvedInvocations,
  TRANSITIVE_UNRESOLVED_TOKEN,
  UNRESOLVED_INVOCATION_PIPELINE_ID,
  UNRESOLVED_TOKEN,
  IGNORED_PATH_TOKEN,
} from './seedPipelineShareUnresolvedInvocations.mjs';
export { seedScriptRun } from './seedScriptRun.mjs';
export { seedWatchers } from './seedWatchers.mjs';
export {
  injectResourceSnapshot,
  buildResourceSnapshot,
} from './seedResourceSnapshot.mjs';
export {
  injectBrowserSnapshot,
  buildBrowserSnapshot,
} from './seedBrowserSnapshot.mjs';
export {
  injectGithubPrStatus,
  buildPrStatusEvent,
  buildPrStatusData,
} from './injectGithubPrStatus.mjs';
export {
  injectScriptRunEvent,
  injectScriptOutputEvent,
  injectScriptCompleteEvent,
  buildScriptDescriptor,
} from './injectScriptRunEvent.mjs';
export { injectCodeGraphBuildStatusEvent } from './injectCodeGraphBuildStatusEvent.mjs';
export {
  injectTerminalRunningChanged,
  injectTerminalExit,
} from './injectTerminalActivityEvent.mjs';
export {
  registerScenario,
  clearScenario,
  getScenarioActivity,
  resetScenarios,
  DEFAULT_MOCK_BASE_URL,
} from './registerScenario.mjs';
export { seedPluginsCache } from './seedPluginsCache.mjs';
export { seedCuratedPlugins } from './seedCuratedPlugins.mjs';
export { seedCuratedPipelinesCapture } from './seedCuratedPipelinesCapture.mjs';
export { seedGlobalInstructionsPreferences } from './seedGlobalInstructionsPreferences.mjs';
export {
  seedSharedContainerRecipientReplicas,
  seedSharedContainerRecipientCoworkRevision,
  sharedContainerRecipientScenario,
  SHARED_CONTAINER_RECIPIENT_CODE_ID,
  SHARED_CONTAINER_RECIPIENT_COWORK_ID,
  SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_ID,
  SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_FILE,
  SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_MESSAGE,
  SHARED_CONTAINER_RECIPIENT_COWORK_REVISION_2_NOTE,
  SHARED_CONTAINER_RECIPIENT_COWORK_SECOND_CHAT_ID,
  SHARED_CONTAINER_RECIPIENT_ORGANIZATION_ID,
  SHARED_CONTAINER_BACKSLASH_TRACKING_IMAGE_URL,
  SHARED_CONTAINER_TRACKING_IMAGE_URL,
} from './seedSharedContainerRecipientReplicas.mjs';
export {
  seedWorkspaceApprovals,
  buildApprovalRule,
} from './seedWorkspaceApprovals.mjs';
export { injectApprovalRequestEvent } from './injectApprovalRequestEvent.mjs';
export { injectApprovalAutoResolvedEvent } from './injectApprovalAutoResolvedEvent.mjs';
export { initializeIsolatedCodexState } from './initializeIsolatedCodexState.mjs';
export { connectMockCloudAccount } from './connectMockCloudAccount.mjs';
export {
  seedSplitPrPreferences,
  buildSplitPrStatusData,
  seedWorktreeLastKnownPrStatus,
  seedSplitPrOpenPrStatus,
  seedInterruptedSplitMap,
} from './seedSplitPr.mjs';
export {
  seedOrgContextScoping,
  ORG_CONTEXT_A,
  ORG_CONTEXT_B,
  ORG_CONTEXT_ENV,
  ORG_CONTEXT_ORGANIZATIONS,
  PERSONAL_CONTEXT_WORKSPACE,
  ORG_CONTEXT_WORKSPACE,
  ORG_CONTEXT_B_WORKSPACE,
} from './seedOrgContextScoping.mjs';
export { markWorkspaceOrganizationOwned } from './markWorkspaceOrganizationOwned.mjs';
export {
  registerShareMembership,
  SHARE_MEMBERSHIP_ORGANIZATION,
  SHARE_MEMBERSHIP_TEAM,
} from './shareMembership.mjs';

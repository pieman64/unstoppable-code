/**
 * Mirrors `inputSettingsKey` in `packages/desktop-shared/src/chat-input-delivery.ts`
 * so seeded delivery rows match their chat's settings; Resend refuses a row
 * whose key differs. shortcut: no model alias resolution, so seed canonical
 * model ids; update this list when the desktop-shared key changes.
 */
export function inputSettingsKeyFor(tab) {
  return JSON.stringify([
    tab.model,
    tab.providerType,
    tab.planMode,
    tab.approvalMode,
    tab.sessionApprovalRules ?? [],
    tab.thinkingLevel,
    tab.modelConfig,
    tab.pluginSelections,
    tab.deferredToolsAllowed,
    tab.interfaceMode,
    tab.subscriptionBillingOverride,
    tab.aiCreditsRouted,
    tab.aiCreditsRouting,
    tab.executionHarness,
    tab.selectedRepoId,
    tab.globalInstructionsSnapshot,
    tab.disabledGlobalPluginSelections,
    tab.codexFastModeEnabled,
    tab.proposalMode,
  ]);
}

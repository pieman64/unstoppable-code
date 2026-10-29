import {
  parseChatAgentSentInfo,
  parseChatWatcherFiredInfo,
} from '@canopy/protocol/portal';
import type {
  ChatInputDeliveryView,
  ChatSteeringCapabilities,
} from '@canopy/protocol/portal';
import {
  getExecutionHarnessForModel,
  resolveModelAlias,
  type ChatSendMessageRequest,
  type PersistedChatTab,
} from './types';
import { DEFAULT_CODEX_SPEED, readCodexSpeedRecord } from './lib/codex-speed';
import type { ChatInputDeliveryLedger } from '@canopy/protocol/portal';

export type InputLedger = ChatInputDeliveryLedger<ChatSendMessageRequest>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function optionalStrings(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  return keys.every(
    (key) => value[key] === undefined || typeof value[key] === 'string',
  );
}

/** Stored provenance is evidence, not authority; unsupported facts stay inert. */
function isAgentSenderProvenance(value: unknown): boolean {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    typeof value.acceptedInputId !== 'string' ||
    !value.acceptedInputId.trim() ||
    !record(value.owner)
  )
    return false;
  const sender = parseChatAgentSentInfo({
    sender: value.sender,
    chatTitle: 'Sender',
    projectLabel: 'Project',
  })?.sender;
  if (sender?.kind === 'bot') return value.owner.kind === 'none';
  if (sender?.kind !== 'project') return false;
  return (
    value.owner.kind === 'personal' ||
    (value.owner.kind === 'organization' &&
      typeof value.owner.organizationId === 'string' &&
      value.owner.organizationId.trim().length > 0)
  );
}

function isChatSendMessagePayload(
  value: unknown,
): value is Record<string, unknown> {
  if (!record(value)) return false;
  return (
    ['projectId', 'worktreeId', 'chatId', 'userMessageId', 'text'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    (value.agentSenderProvenance === undefined ||
      isAgentSenderProvenance(value.agentSenderProvenance)) &&
    (!record(value.hiddenContext) ||
      value.hiddenContext.kind !== 'agent-sender-context' ||
      typeof value.hiddenContext.text === 'string') &&
    (value.inputMode === undefined ||
      value.inputMode === 'typed' ||
      value.inputMode === 'voice') &&
    (value.attachmentPaths === undefined ||
      (Array.isArray(value.attachmentPaths) &&
        value.attachmentPaths.every(
          (path: unknown) => typeof path === 'string',
        ))) &&
    (value.fileReferences === undefined ||
      (Array.isArray(value.fileReferences) &&
        value.fileReferences.every(
          (file: unknown) =>
            record(file) &&
            typeof file.absolutePath === 'string' &&
            typeof file.displayPath === 'string',
        ))) &&
    (value.attachmentPromptContexts === undefined ||
      (Array.isArray(value.attachmentPromptContexts) &&
        value.attachmentPromptContexts.every(
          (context: unknown) =>
            record(context) &&
            typeof context.attachmentPath === 'string' &&
            ['in-app-browser-resource', 'linear-ticket'].includes(
              String(context.promptKind),
            ),
        )))
  );
}

/** Unknown versions and malformed identities survive storage but remain inert. */
export function isInputLedger(value: unknown): value is InputLedger {
  if (
    !record(value) ||
    value.version !== 1 ||
    !nonnegativeInteger(value.epoch) ||
    !Array.isArray(value.rows)
  )
    return false;
  const rowIds = new Set<string>();
  const attemptIds = new Set<string>();
  return value.rows.every((row: unknown) => {
    if (
      !record(row) ||
      typeof row.id !== 'string' ||
      !row.id ||
      rowIds.has(row.id) ||
      !nonnegativeInteger(row.revision) ||
      row.revision === 0 ||
      !nonnegativeInteger(row.createdAt) ||
      typeof row.text !== 'string' ||
      typeof row.settingsKey !== 'string' ||
      ![
        'sending',
        'pending',
        'cancelling',
        'editing',
        'cancelled',
        'picked-up',
        'uncertain',
        'queued',
      ].includes(String(row.state)) ||
      !optionalStrings(row, ['currentAttemptId', 'draft', 'reason']) ||
      (row.dismissedAt !== undefined && !nonnegativeInteger(row.dismissedAt)) ||
      (row.editResubmits !== undefined &&
        typeof row.editResubmits !== 'boolean') ||
      (row.queueIntent !== undefined &&
        (!record(row.queueIntent) ||
          typeof row.queueIntent.commandId !== 'string' ||
          !row.queueIntent.commandId ||
          (row.queueIntent.epoch !== undefined &&
            !nonnegativeInteger(row.queueIntent.epoch)))) ||
      (row.origin !== undefined &&
        row.origin !== 'desktop' &&
        row.origin !== 'portal') ||
      !record(row.payload) ||
      !Array.isArray(row.attempts)
    )
      return false;
    rowIds.add(row.id);
    if (!isChatSendMessagePayload(row.payload)) return false;
    const ownAttemptIds = new Set<string>();
    if (
      !row.attempts.every((attempt: unknown) => {
        if (
          !record(attempt) ||
          typeof attempt.id !== 'string' ||
          !attempt.id ||
          attemptIds.has(attempt.id) ||
          typeof attempt.generation !== 'string' ||
          !attempt.generation ||
          (attempt.provider !== 'claude' && attempt.provider !== 'codex') ||
          !nonnegativeInteger(attempt.createdAt) ||
          !optionalStrings(attempt, [
            'submittedText',
            'displayText',
            'providerTurnId',
            'itemId',
            'rootUserMessageId',
          ]) ||
          ![
            'admittedAt',
            'pickedUpAt',
            'withdrawnAt',
            'completedAt',
            'uncertainAt',
            'turnSettledAt',
          ].every(
            (key) =>
              attempt[key] === undefined || nonnegativeInteger(attempt[key]),
          ) ||
          (attempt.turnOutcome !== undefined &&
            (typeof attempt.turnOutcome !== 'string' ||
              !['completed', 'failed', 'cancelled', 'interrupted'].includes(
                attempt.turnOutcome,
              ))) ||
          (attempt.payloadSnapshot !== undefined &&
            !isChatSendMessagePayload(attempt.payloadSnapshot))
        )
          return false;
        attemptIds.add(attempt.id);
        ownAttemptIds.add(attempt.id);
        return true;
      })
    )
      return false;
    const currentAttemptId = row.currentAttemptId;
    if (currentAttemptId !== undefined && typeof currentAttemptId !== 'string')
      return false;
    return (
      currentAttemptId === undefined || ownAttemptIds.has(currentAttemptId)
    );
  });
}

/** Explicit settings that can change which session consumes a message. */
export function inputSettingsKey(tab: PersistedChatTab): string {
  return JSON.stringify([
    tab.model ? resolveModelAlias(tab.model) : tab.model,
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

/** UI projections never expose provider payloads or session identities. */
export function inputDeliveryViews(
  value: unknown,
  capabilities?: ChatSteeringCapabilities,
): ChatInputDeliveryView[] {
  if (!isInputLedger(value)) return [];
  return value.rows
    .filter(
      (row) =>
        row.dismissedAt === undefined &&
        // A delegate's message to its root chat is host-owned and hidden, as
        // it is in the chat queue.
        row.payload.managedDelegationDeliveryId === undefined,
    )
    .map((row) => {
      const agentSent = parseChatAgentSentInfo(row.payload.agentSent);
      return {
        id: row.id,
        revision: row.revision,
        state: row.state,
        text: row.text,
        draft: row.draft,
        editResubmits: row.editResubmits,
        reason: row.reason,
        watcherFired: parseChatWatcherFiredInfo(row.payload.watcherFired),
        ...(agentSent !== undefined ? { agentSent } : {}),
        attachmentCount: row.payload.attachmentPaths?.length ?? 0,
        canWithdraw:
          capabilities?.withdraw === true &&
          capabilities.generation ===
            row.attempts.find((a) => a.id === row.currentAttemptId)?.generation,
      };
    });
}

/** Explicit per-message settings must match the active session selection. */
export function inputRequestMatchesSettings(
  request: ChatSendMessageRequest,
  tab: PersistedChatTab,
): boolean {
  const requestExecutionHarness =
    request.executionHarness ??
    (request.model ? getExecutionHarnessForModel(request.model) : undefined) ??
    (request.providerType === 'codex' ? 'codex' : 'claude');
  const requestSignature = [
    request.model ? resolveModelAlias(request.model) : undefined,
    request.providerType,
    requestExecutionHarness,
    request.planMode ?? false,
    request.approvalMode ?? 'ask',
    request.sessionApprovalRules ?? [],
    request.modelConfig?.thinkingLevel ?? request.thinkingLevel ?? 'high',
    // The exact requested speed, not its `fastMode` projection: Ultra fast
    // and Regular both project `false` but run different service tiers.
    readCodexSpeedRecord(request.modelConfig, request.codexFastModeEnabled) ??
      DEFAULT_CODEX_SPEED,
    request.pluginSelections,
    request.deferredToolsAllowed ?? true,
    // Native Codex tabs omit this renderer-only preference even when their
    // canonical record explicitly says 'canopy'. Both mean the native UI.
    request.interfaceMode ?? 'canopy',
    request.selectedRepoId,
    request.globalInstructionsSnapshot ?? '',
    request.subscriptionBillingOverride ?? false,
    request.aiCreditsRouting,
    request.codexProposalMode ?? 'optional',
  ];
  const tabSignature = [
    tab.model ? resolveModelAlias(tab.model) : undefined,
    tab.providerType,
    tab.executionHarness ??
      (tab.model ? getExecutionHarnessForModel(tab.model) : undefined) ??
      (tab.providerType === 'codex' ? 'codex' : 'claude'),
    tab.planMode ?? false,
    tab.approvalMode ?? 'ask',
    tab.sessionApprovalRules ?? [],
    tab.modelConfig?.thinkingLevel ?? tab.thinkingLevel ?? 'high',
    readCodexSpeedRecord(tab.modelConfig, tab.codexFastModeEnabled) ??
      DEFAULT_CODEX_SPEED,
    tab.pluginSelections,
    tab.deferredToolsAllowed ?? true,
    tab.interfaceMode ?? 'canopy',
    tab.selectedRepoId,
    tab.globalInstructionsSnapshot ?? '',
    tab.subscriptionBillingOverride ?? false,
    tab.aiCreditsRouting,
    tab.proposalMode ?? 'optional',
  ];
  return JSON.stringify(requestSignature) === JSON.stringify(tabSignature);
}

/** Detach destination identities and runtime grants while keeping source evidence. */
export function detachInputDelivery(
  tab: PersistedChatTab,
  target: { projectId: string; worktreeId: string; chatId: string },
  createId: () => string,
): PersistedChatTab['inputDelivery'] {
  if (!isInputLedger(tab.inputDelivery)) return tab.inputDelivery;
  return {
    ...tab.inputDelivery,
    epoch: tab.inputDelivery.epoch + 1,
    rows: tab.inputDelivery.rows.map((row) => {
      const id = createId();
      const payload: ChatSendMessageRequest = {
        ...row.payload,
        ...target,
        userMessageId: id,
      };
      delete payload.clientUserMessageId;
      delete payload.sdkSessionId;
      delete payload.claudeForkSession;
      delete payload.codexReconstructionSeedId;
      delete payload.sessionApprovalRules;
      delete payload.approvalMode;
      delete payload.pluginSelections;
      delete payload.pendingSystemInstructions;
      // Plan ids are scoped to the source worktree.
      delete payload.activePlan;
      delete payload.aiCreditsRouting;
      delete payload.appAdvisorContext;
      delete payload.hiddenContext;
      // Only unconsumed inputs become new user resubmissions. Picked-up rows
      // and the tab's historical transcript retain their captured attribution.
      if (row.state !== 'picked-up') {
        delete payload.agentSent;
        delete payload.agentSenderProvenance;
      }
      delete payload.asyncQuestionId;
      delete payload.watcherFired;
      delete payload.consolidatedWatcherUserMessageIds;
      delete payload.deferredToolsReloadEnabledResources;
      delete payload.startsNewTrackedChat;
      const state = ['pending', 'sending', 'cancelling', 'uncertain'].includes(
        row.state,
      )
        ? ('uncertain' as const)
        : row.state === 'picked-up'
          ? ('picked-up' as const)
          : ('cancelled' as const);
      const attempts = row.attempts.map((attempt) => {
        const detached = { ...attempt };
        delete detached.submittedText;
        delete detached.payloadSnapshot;
        return detached;
      });
      return {
        ...row,
        id,
        revision: 1,
        state,
        payload,
        attempts,
        currentAttemptId: undefined,
        editResubmits: false,
        queueIntent: undefined,
        reason:
          state === 'uncertain'
            ? 'Copied message history. Delivery in the source chat was not confirmed.'
            : row.reason,
      };
    }),
  };
}

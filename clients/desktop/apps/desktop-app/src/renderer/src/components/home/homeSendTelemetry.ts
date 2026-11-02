import { getProviderForChatModel } from '@canopy/desktop-shared/types';
import {
  HOME_COMPOSER_KEY,
  trackChatMessageSend,
} from '@/lib/chatMessageSendTelemetry';
import { isCoworkChatTarget } from '@/lib/cowork';
import {
  resolveHomeAiCreditsRouted,
  resolveHomeEffectiveModelSettings,
  useHomeComposerStore,
} from '@/stores/homeComposerStore';

/**
 * Records a Home chat-mode send (CAN-4630) from the draft as submitted: the
 * model Home displays and sends, its provider, and the billing route the
 * created chat starts on. Call before dispatch resets the draft.
 */
export function trackHomeChatSend(): void {
  const {
    workspaceId,
    model,
    thinkingLevel,
    executionHarness,
    modelSelectionMode,
    text,
    attachments,
    scheduledSendDraft,
    planMode,
  } = useHomeComposerStore.getState();
  // Blank submits only open a work area; scheduled drafts do not send now.
  // Neither consumes the install's first-message or suggested-prompt state.
  if (scheduledSendDraft || (!text.trim() && attachments.length === 0)) return;
  const effectiveModel = resolveHomeEffectiveModelSettings(
    workspaceId,
    model,
    thinkingLevel,
    executionHarness,
  ).model;
  trackChatMessageSend({
    surface: 'home',
    composerKey: HOME_COMPOSER_KEY,
    // The same provider resolution Home's model controls use.
    provider:
      executionHarness ?? getProviderForChatModel(effectiveModel) ?? 'claude',
    model: effectiveModel,
    isAutoModel: modelSelectionMode === 'auto',
    isAiCreditsBilled: resolveHomeAiCreditsRouted(workspaceId, effectiveModel),
    // The stored toggle survives a switch to a cowork target, where Home's
    // plan control is unavailable, so those sends report `default`.
    isPlanMode:
      planMode && workspaceId !== null && !isCoworkChatTarget(workspaceId),
  });
}

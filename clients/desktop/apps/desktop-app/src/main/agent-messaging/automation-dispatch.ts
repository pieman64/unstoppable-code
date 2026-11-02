import type {
  ChatSendAutomationDispatch,
  ChatSendMessageRequest,
} from '@canopy/desktop-shared/types';

/**
 * The native-path request fields an automation's own send keeps (CAN-4549):
 * the banner and usage source, the package overlay and, for a scheduled run,
 * the scope's active tab. Both the admitted project send and the retained
 * Orchestrator send apply it, so a field added to the block lands on both.
 */
export function automationDispatchRequestFields(
  block: ChatSendAutomationDispatch | undefined,
): Partial<ChatSendMessageRequest> {
  if (!block) return {};
  return {
    automationDispatch: block,
    initiationSource: 'automation',
    automationName: block.automationName,
    ...(block.packageOverlay ? { packageOverlay: block.packageOverlay } : {}),
    ...(block.presentation === 'background' ? { preserveActiveTab: true } : {}),
  };
}

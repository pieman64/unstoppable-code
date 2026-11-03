import type { Descendant } from 'slate';
import {
  composerRecoveryTranscriptHead,
  createComposerRecoveryStore,
  type ComposerRecoveryTranscriptHead,
  type ComposerRecoveryTranscriptMessage,
} from '@canopy/ui-app/composer-recovery';
import type { AttachmentMeta } from '@canopy/desktop-shared/types';
import { messageHasAgentActivity } from '@canopy/desktop-shared/lib/usage-limit-resume-prompt';
import type { EditorSelectionContext } from '@/lib/editorSelectionContext';
import { chatBannerKey } from '@/stores/aiCreditsBannerStore';
import type { ChatMessage } from '@/stores/chat/types';

/** Composer inputs a send reserves, returned with the editor value. */
export interface DesktopComposerReservedInputs {
  attachments: readonly AttachmentMeta[];
  selections: readonly EditorSelectionContext[];
  revertAttachmentPath?: string;
}

/**
 * Desktop binding of the shared composer recovery lifecycle (CAN-5348). The
 * chat event subscription records no-billing refusals; `ChatInput` records
 * submissions and restores them. Both key by {@link chatBannerKey}.
 */
export const composerRecoveryStore = createComposerRecoveryStore<
  Descendant[],
  DesktopComposerReservedInputs
>();

export const composerRecoveryKey = chatBannerKey;

/** Reservation rollback belongs to its send even after recovery is superseded. */
export function restoreRejectedComposerInputs(
  key: string,
  generation: number,
  restore: () => void,
): void {
  if (composerRecoveryStore.get(key)?.generation !== generation) {
    restore();
    return;
  }
  if (!composerRecoveryStore.claim(key, generation)) return;
  try {
    restore();
    composerRecoveryStore.settle(key, generation, 'reserved-inputs-restored');
  } finally {
    composerRecoveryStore.unclaim(key, generation);
  }
}

/** Project a desktop transcript for recovery decisions. */
export function composerRecoveryTranscript(
  messages: readonly ChatMessage[],
): ComposerRecoveryTranscriptMessage[] {
  return messages.map((message) => ({
    id: message.id,
    isUser: message.role === 'user',
    hasAgentActivity: messageHasAgentActivity(message),
  }));
}

/** Newest committed user message, for binding a refusal to its turn. */
export function composerRecoveryHead(
  messages: readonly ChatMessage[],
): ComposerRecoveryTranscriptHead {
  return composerRecoveryTranscriptHead(composerRecoveryTranscript(messages));
}

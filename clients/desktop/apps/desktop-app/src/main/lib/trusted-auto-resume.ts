import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import type { UsageLimitResumePrompt } from '@canopy/desktop-shared/lib/usage-limit-resume-prompt';
import type {
  AutoResumeReason,
  AutoResumeMetadata,
} from '@canopy/agent-transcript/types';
import { isRootUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import { computeUsageLimitResumePrompt } from '@canopy/desktop-shared/lib/usage-limit-resume-prompt';
import { getModelCatalogProviderLabel } from '@canopy/protocol/models';

/** Resolve one exact interrupted turn for both dispatch provenance and succession. */
export function buildTrustedAutoResume(
  tab: Pick<PersistedChatTab, 'messages' | 'interruptedTurns' | 'providerType'>,
  reason: AutoResumeReason,
  detectedAt?: number,
  interruptedUserMessageId?: string,
): UsageLimitResumePrompt & { autoResume: AutoResumeMetadata } {
  const boundary = [...tab.messages].reverse().find(isRootUserTurnBoundary);
  const openInterrupted = Object.entries(tab.interruptedTurns ?? {}).filter(
    ([, state]) => !state.resumedBy && !state.abandoned,
  );
  const anchor =
    interruptedUserMessageId ??
    openInterrupted.find(([id]) => id === boundary?.id)?.[0] ??
    boundary?.id;
  if (anchor && boundary?.id !== anchor)
    throw new Error('A newer user turn superseded this interruption.');
  if (
    boundary?.userMessageSource === 'auto_resume' &&
    !interruptedUserMessageId &&
    !openInterrupted.some(([id]) => id === boundary.id)
  )
    throw new Error('This automatic resume has no current interruption.');
  if (boundary && detectedAt !== undefined && boundary.timestamp > detectedAt)
    throw new Error('A newer user turn superseded this interruption.');
  const interruption = anchor ? tab.interruptedTurns?.[anchor] : undefined;
  if (interruption?.resumedBy || interruption?.abandoned)
    throw new Error('This interrupted turn has already been resumed.');
  const prompt = computeUsageLimitResumePrompt(
    tab.messages.filter(
      (message) => !message.parentBlockId && !message.parentToolUseId,
    ),
  );
  return {
    ...prompt,
    autoResume: {
      reason,
      ...(tab.providerType
        ? { providerName: getModelCatalogProviderLabel(tab.providerType) }
        : {}),
      ...(anchor ? { resumesUserMessageId: anchor } : {}),
      resendsUserMessage: prompt.resendsUserMessage,
    },
  };
}

const resumingChats = new Set<string>();

/** Shared by Home/banner/queue/scheduler and authentication recovery. */
export function claimTrustedChatResume(target: {
  projectId: string;
  worktreeId: string;
  chatId: string;
}): (() => void) | undefined {
  const key = `${target.projectId}\0${target.worktreeId}\0${target.chatId}`;
  if (resumingChats.has(key)) return undefined;
  resumingChats.add(key);
  return () => {
    resumingChats.delete(key);
  };
}

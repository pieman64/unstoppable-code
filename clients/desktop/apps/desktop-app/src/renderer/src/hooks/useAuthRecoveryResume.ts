import { useCallback, useMemo, useState } from 'react';
import { computeUsageLimitResumePrompt } from '@canopy/execution-engine/lib/usage-limit-resume-prompt';
import { useChatStore, useChatTabRenderState } from '@/stores/chatStore';
import type { ChatTab } from '@/stores/chat/types';

interface RecoveryTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

function resolveTarget(chatId: string | undefined): RecoveryTarget | null {
  if (!chatId) return null;
  for (const [key, scope] of Object.entries(
    useChatStore.getState().worktreeChats,
  )) {
    if (!scope.tabs.some((tab) => tab.id === chatId)) continue;
    const separator = key.indexOf('/');
    if (separator <= 0) continue;
    return {
      projectId: key.slice(0, separator),
      worktreeId: key.slice(separator + 1),
      chatId,
    };
  }
  return null;
}

// One dispatch per chat even when the same dependency appears in multiple
// transcript cards.
const dispatching = new Set<string>();
// A failed dispatch keeps its user message in the transcript beside the error.
// That message is not a resumed turn, so it must not retire the card and take
// the retry with it.
const failedResumeMessageIds = new Set<string>();

function hasMovedPastFailure(
  tab: ChatTab | undefined,
  messageId: string | undefined,
): boolean {
  if (!tab || !messageId) return false;
  const index = tab.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return false;
  return tab.messages
    .slice(index + 1)
    .some(
      (message) =>
        message.role === 'user' &&
        !failedResumeMessageIds.has(message.id) &&
        message.blocks.some((block) => block.type === 'text'),
    );
}

function findTab(key: string, chatId: string): ChatTab | undefined {
  return useChatStore
    .getState()
    .worktreeChats[key]?.tabs.find((candidate) => candidate.id === chatId);
}

interface AuthRecoveryResume {
  retired: boolean;
  canResume: boolean;
  resuming: boolean;
  error: string | null;
  resume: () => Promise<void>;
}

export function useAuthRecoveryResume(
  chatId: string | undefined,
  messageId: string | undefined,
): AuthRecoveryResume {
  const target = useMemo(() => resolveTarget(chatId), [chatId]);
  const key = target ? `${target.projectId}/${target.worktreeId}` : '';
  const tab = useChatTabRenderState(target, (entry) => entry.tab);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retired = hasMovedPastFailure(tab, messageId);
  const canResume = Boolean(
    target &&
    messageId &&
    tab &&
    !retired &&
    tab.messages.some((message) => message.id === messageId) &&
    tab.status !== 'streaming' &&
    !tab.readOnly &&
    !tab.queuedMessages.length,
  );

  const resume = useCallback(async (): Promise<void> => {
    if (!target || !messageId || dispatching.has(key + '/' + target.chatId))
      return;
    const current = findTab(key, target.chatId);
    if (
      !current ||
      current.readOnly ||
      current.status === 'streaming' ||
      current.queuedMessages.length ||
      !current.messages.some((message) => message.id === messageId) ||
      hasMovedPastFailure(current, messageId)
    )
      return;
    const lock = key + '/' + target.chatId;
    dispatching.add(lock);
    setResuming(true);
    setError(null);
    const previousMessageIds = new Set(
      current.messages.map((message) => message.id),
    );
    try {
      const prompt = computeUsageLimitResumePrompt(current.messages);
      await useChatStore
        .getState()
        .sendMessage(
          prompt.text,
          prompt.fileReferences,
          target,
          prompt.inputMode ?? 'typed',
          {
            attachmentPaths: prompt.attachmentPaths,
            attachmentPromptContexts: prompt.attachmentPromptContexts,
            throwOnDispatchFailure: true,
          },
        );
    } catch {
      for (const message of findTab(key, target.chatId)?.messages ?? []) {
        if (message.role === 'user' && !previousMessageIds.has(message.id))
          failedResumeMessageIds.add(message.id);
      }
      setError('Could not resume. Try again.');
    } finally {
      dispatching.delete(lock);
      setResuming(false);
    }
  }, [key, messageId, target]);
  return {
    retired,
    canResume,
    resuming,
    error,
    resume,
  };
}

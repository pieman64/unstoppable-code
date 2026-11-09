import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { computeUsageLimitResumePrompt } from '@canopy/execution-engine/lib/usage-limit-resume-prompt';
import { findPendingUsageLimitResume } from '@/lib/scheduledUsageLimitResume';
import {
  chatBannerKey,
  useAiCreditsBannerStore,
  type ChatBannerTarget,
  type UsageLimitBannerInfo,
} from '@/stores/aiCreditsBannerStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { clearResumedChatUsageLimitBanner } from '@/stores/chat/tab-utils';
import { useChatStore } from '@/stores/chatStore';

const CONTINUE_FAILED_COPY = 'Could not continue this chat. Try again.';

// One send per chat. `ChatInput` can mount more than once for the same chat,
// so the lock and the `busy` it reports live outside any one component.
const sending = new Set<string>();
const listeners = new Set<() => void>();

function setSending(key: string, value: boolean): void {
  if (value) sending.add(key);
  else sending.delete(key);
  listeners.forEach((listener) => listener());
}

function subscribeSending(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/**
 * Retires this chat's scheduled usage-limit resume after the interrupted turn
 * was sent. A failure is swallowed: the send cleared main's usage-limit
 * registry entry, so the scheduled run refuses itself at fire time.
 */
async function retireScheduledResume(target: ChatBannerTarget): Promise<void> {
  const automations = useAutomationsStore.getState();
  const pending = findPendingUsageLimitResume(
    automations.activities,
    {
      workspaceId: target.projectId,
      worktreeId: target.worktreeId,
      chatId: target.chatId,
    },
    Date.now(),
  );
  if (!pending) return;
  try {
    const deleted = await automations.deleteActivity(pending.id);
    if (deleted.ok) return;
    await automations.updateActivity({ id: pending.id, enabled: false });
  } catch {
    // See above: main refuses the stale run.
  }
}

/**
 * A usage-limit record a turn reached and nothing has answered yet. A limit
 * restored by switching back to the subscription interrupted no turn.
 */
function interruptedTurnRecord(key: string): UsageLimitBannerInfo | undefined {
  const record = useAiCreditsBannerStore.getState().usageLimitByChat[key];
  return record?.restoredBySwitch ? undefined : record;
}

interface ResumeInterruptedTurnOnAiCredits {
  /** Sends the interrupted turn again; a no-op when nothing is waiting. */
  resume: () => Promise<void>;
  /** True while a send for this chat is in flight, from any instance. */
  busy: boolean;
  /** Feedback from the last failed send. */
  error: string | null;
  /** True while the chat has an unanswered usage-limit interruption. */
  pending: boolean;
}

/**
 * Continues a chat whose turn a usage limit interrupted, once the user chose
 * AI Credits (CAN-4756). Sends the same prompt Resume at reset would, through
 * the renderer send path so the routing the click just applied to the tab is
 * read at send time, then retires any scheduled resume.
 */
export function useResumeInterruptedTurnOnAiCredits(
  target: ChatBannerTarget | null,
): ResumeInterruptedTurnOnAiCredits {
  const key = target ? chatBannerKey(target) : null;
  const pending = useAiCreditsBannerStore((state) => {
    const record = key !== null ? state.usageLimitByChat[key] : undefined;
    return record !== undefined && record.restoredBySwitch !== true;
  });
  const busy = useSyncExternalStore(
    subscribeSending,
    () => (key !== null ? sending.has(key) : false),
    // Static markup renders (render health tests) have no send in flight.
    () => false,
  );
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);

  // An answered interruption, or another chat, starts without old feedback.
  useEffect(() => {
    setError(null);
  }, [key, pending]);

  const resume = useCallback(async (): Promise<void> => {
    if (!target || key === null || sending.has(key)) return;
    const tab = useChatStore
      .getState()
      .worktreeChats[
        `${target.projectId}/${target.worktreeId}`
      ]?.tabs.find((candidate) => candidate.id === target.chatId);
    if (
      !tab ||
      tab.readOnly ||
      tab.status === 'streaming' ||
      tab.queuedMessages.length > 0
    )
      return;
    const recordBefore = interruptedTurnRecord(key);
    if (recordBefore === undefined) return;
    // Set before the first await so `busy` lands in the same render as the
    // routing the click applied.
    setSending(key, true);
    if (mounted.current) setError(null);
    let rejected = false;
    const markRejected = (): void => {
      rejected = true;
    };
    let accepted = false;
    try {
      // The live transcript, never render-time props.
      const prompt = computeUsageLimitResumePrompt(tab.messages);
      await useChatStore
        .getState()
        .sendMessage(
          prompt.text,
          prompt.fileReferences,
          target,
          prompt.inputMode ?? 'typed',
          {
            ...(prompt.attachmentPaths?.length
              ? { attachmentPaths: prompt.attachmentPaths }
              : {}),
            ...(prompt.attachmentPromptContexts?.length
              ? { attachmentPromptContexts: prompt.attachmentPromptContexts }
              : {}),
            throwOnDispatchFailure: true,
            onDispatchRejected: markRejected,
            onPreDispatchRejected: markRejected,
          },
        );
      accepted = !rejected;
    } catch {
      accepted = false;
    }
    try {
      if (!accepted) {
        // Routing stays on and the record stays, so the card's Continue
        // retries. A scheduled resume stays too.
        if (mounted.current) setError(CONTINUE_FAILED_COPY);
        return;
      }
      // The dispatch normally clears the record already. Clear it here only
      // when it is still the one this send answered, never a newer limit the
      // resent turn hit.
      if (
        useAiCreditsBannerStore.getState().usageLimitByChat[key] ===
        recordBefore
      ) {
        clearResumedChatUsageLimitBanner(target);
      }
    } finally {
      setSending(key, false);
    }
    await retireScheduledResume(target);
  }, [key, target]);

  return { resume, busy, error, pending };
}

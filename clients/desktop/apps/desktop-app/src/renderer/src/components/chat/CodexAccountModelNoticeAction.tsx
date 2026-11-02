import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type { CodexAccountModelAccessFailure } from '@canopy/protocol/auth-recovery';
import { computeUsageLimitResumePrompt } from '@canopy/desktop-shared/lib/usage-limit-resume-prompt';
import { CodexAccountModelNotice } from '@canopy/ui-shared/components';
import {
  useChatStore,
  useChatTabRenderState,
  type ChatMessage,
} from '@/stores/chatStore';
import { resolveChat } from './resolve-chat-target';

/**
 * Is the failed row still the chat's last message? Identity is the raw block
 * text, as in `CanopyProxyErrorNotice`: once a resend or any later message
 * exists, the notice is history and its action goes read-only.
 */
function isLatestModelAccessFailure(
  messages: readonly ChatMessage[],
  sourceText: string,
): boolean {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return false;
  return lastMessage.blocks.some(
    (block) =>
      block.type === 'text' &&
      block.modelAccessFailure !== undefined &&
      block.text === sourceText,
  );
}

export interface CodexAccountModelNoticeActionProps {
  failure: CodexAccountModelAccessFailure;
  /** Tab this block was rendered from, used to target the switch and resend. */
  originChatTabId?: string;
  /** Raw text of the failed row, identifying it in the transcript. */
  sourceText: string;
}

/**
 * Desktop host for the shared {@link CodexAccountModelNotice} (CAN-4716).
 * "Use <model>" switches the chat to the fallback as an explicit pick, so the
 * pristine default re-stamp never undoes it, then resends the failed turn
 * through the same resume prompt the proxy retry uses (attachments included).
 */
export const CodexAccountModelNoticeAction = memo(
  function CodexAccountModelNoticeAction({
    failure,
    originChatTabId,
    sourceText,
  }: CodexAccountModelNoticeActionProps): JSX.Element {
    // One-shot read, as in `CanopyProxyErrorNotice`: the tab is registered
    // whenever this block renders, and a subscription here would re-walk every
    // tab on each streaming delta.
    const target = useMemo(
      () => resolveChat(originChatTabId)?.target ?? null,
      [originChatTabId],
    );
    const isStreaming = useChatTabRenderState(
      target,
      ({ tab }) => target !== null && tab?.status === 'streaming',
    );
    const isLatest = useChatTabRenderState(
      target,
      ({ tab }) =>
        target !== null &&
        isLatestModelAccessFailure(tab?.messages ?? [], sourceText),
    );
    const [busy, setBusy] = useState(false);
    const mountedRef = useRef(true);
    useEffect(() => {
      mountedRef.current = true;
      return (): void => {
        mountedRef.current = false;
      };
    }, []);

    const fallbackModel = failure.fallbackModel;
    const handleUseFallback = useCallback((): void => {
      if (fallbackModel === undefined) return;
      const resolved = resolveChat(originChatTabId);
      if (!resolved) return;
      // Re-check live state rather than trusting the render-time `disabled`:
      // a turn can start between that render and this click, and the resend
      // is a billed, non-idempotent turn.
      const liveTab = useChatStore
        .getState()
        .worktreeChats[
          `${resolved.target.projectId}/${resolved.target.worktreeId}`
        ]?.tabs.find((tab) => tab.id === resolved.target.chatId);
      if (liveTab?.status === 'streaming') return;
      if (!isLatestModelAccessFailure(liveTab?.messages ?? [], sourceText)) {
        return;
      }
      setBusy(true);
      void (async (): Promise<void> => {
        try {
          const switched = await useChatStore
            .getState()
            .setModelAndWait(fallbackModel, resolved.target);
          if (!switched) return;
          const prompt = computeUsageLimitResumePrompt(resolved.messages);
          await useChatStore
            .getState()
            .sendMessage(
              prompt.text,
              prompt.fileReferences,
              resolved.target,
              prompt.inputMode ?? 'typed',
              {
                ...(prompt.attachmentPaths?.length
                  ? { attachmentPaths: prompt.attachmentPaths }
                  : {}),
                ...(prompt.attachmentPromptContexts?.length
                  ? {
                      attachmentPromptContexts: prompt.attachmentPromptContexts,
                    }
                  : {}),
              },
            );
        } catch {
          // `setModelAndWait` and `sendMessage` surface their own failures;
          // swallow so a rejection is not an unhandled renderer rejection.
        } finally {
          if (mountedRef.current) setBusy(false);
        }
      })();
    }, [fallbackModel, originChatTabId, sourceText]);

    return (
      <CodexAccountModelNotice
        failure={failure}
        {...(target !== null ? { onUseFallback: handleUseFallback } : {})}
        busy={busy}
        disabled={!isLatest || isStreaming}
      />
    );
  },
);

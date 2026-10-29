import { useLayoutEffect, useRef, type JSX } from 'react';
import { useOnboardingSuggestionSurfaces } from '@/stores/onboardingSuggestionSurfacesStore';

/**
 * Center slot for the same checklist runtime shown on Home and the sidebar.
 * A seeded project's template context is published by the chat surface
 * (`useChatBlueprintPublication`), not here: this slot mounts only while the
 * shared queue has rows, and the template rows are what give a queue a
 * finished user already exhausted its rows.
 */
export function ChatOnboardingChecklistHost({
  chatTabId,
  projectId,
  worktreeId,
}: {
  chatTabId: string;
  projectId: string;
  worktreeId: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    useOnboardingSuggestionSurfaces.setState({
      chat: node,
      chatPromptTargetId: chatTabId,
      chatBrowserTarget: { projectId, worktreeId, chatId: chatTabId },
    });
    return (): void => {
      useOnboardingSuggestionSurfaces.setState((current) =>
        current.chat === node
          ? {
              chat: null,
              chatPromptTargetId: null,
              chatBrowserTarget: null,
            }
          : current,
      );
    };
  }, [chatTabId, projectId, worktreeId]);

  return (
    <div
      ref={ref}
      data-testid="chat-onboarding-checklist-host"
      className="mx-auto w-full max-w-[var(--chat-reading-width)] chat-width-transition"
    />
  );
}

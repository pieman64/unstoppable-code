import { useEffect, useLayoutEffect } from 'react';
import {
  useOnboardingSuggestionSurfaces,
  type OnboardingChatBlueprintContext,
} from '@/stores/onboardingSuggestionSurfacesStore';

/**
 * How long the checklist waits for a seeded project's template to be read
 * before the general rows take over: the read is a cached IPC call, so
 * anything slower is a failure the user should not sit behind.
 */
export const BLUEPRINT_PENDING_TIMEOUT_MS = 3_000;

export interface ChatBlueprintPublicationInput {
  chatTabId: string;
  /**
   * Whether this chat is the active empty chat of a seeded project. Must be
   * exclusive across surfaces (the surface's active-panel flag): the
   * publication is keyed on `chatTabId`, and two active publishers would
   * take turns overwriting each other.
   */
  active: boolean;
  blueprint: OnboardingChatBlueprintContext | null;
  /**
   * The template is still being read; hold the rows until it settles. Only
   * ever true while `blueprint` is null: a known template means the read has
   * settled, and the bounded wait below does not arm for a known one.
   */
  pending: boolean;
}

/**
 * Publishes a seeded project's template context to the shared checklist
 * runtime for as long as `active` holds (CAN-3032), and withdraws it when
 * this chat stops being the active empty chat or unmounts. Lives on the
 * chat surface, not the centered checklist host: the host mounts only while
 * the shared queue has rows, and a general queue a finished user already
 * exhausted would otherwise never learn about the template rows that would
 * give it some. Withdrawal is keyed on this tab so a stale cleanup never
 * takes down what another tab published.
 *
 * Returns whether this tab's publication is what the runtime currently
 * holds, so the caller can keep both the checklist and the prompt chips
 * from drawing against the general queue's status in the meantime.
 */
export function useChatBlueprintPublication({
  chatTabId,
  active,
  blueprint,
  pending,
}: ChatBlueprintPublicationInput): boolean {
  useLayoutEffect(() => {
    if (!active) return;
    useOnboardingSuggestionSurfaces.setState({
      chatBlueprint: blueprint,
      chatBlueprintPending: pending,
      chatBlueprintOwner: chatTabId,
    });
    return (): void => {
      useOnboardingSuggestionSurfaces.setState((current) =>
        current.chatBlueprintOwner === chatTabId
          ? {
              chatBlueprint: null,
              chatBlueprintPending: false,
              chatBlueprintOwner: null,
            }
          : current,
      );
    };
  }, [active, blueprint, chatTabId, pending]);
  // A bounded wait: a template read that never settles must not hide the
  // checklist for good. The general rows take over when the wait expires;
  // a read that settles later still republishes the tailored context.
  useEffect(() => {
    // Keyed on the published value too, so a republish after the wait
    // expired arms a fresh wait rather than holding for good.
    if (!active || !pending || blueprint !== null) return;
    const timer = window.setTimeout(() => {
      useOnboardingSuggestionSurfaces.setState((current) =>
        current.chatBlueprintOwner === chatTabId && current.chatBlueprintPending
          ? { chatBlueprintPending: false }
          : current,
      );
    }, BLUEPRINT_PENDING_TIMEOUT_MS);
    return (): void => window.clearTimeout(timer);
  }, [active, blueprint, chatTabId, pending]);
  return useOnboardingSuggestionSurfaces(
    (state) => state.chatBlueprintOwner === chatTabId,
  );
}

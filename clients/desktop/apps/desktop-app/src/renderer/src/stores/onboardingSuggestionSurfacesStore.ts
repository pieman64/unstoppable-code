import { create } from 'zustand';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type {
  ShareablePluginRef,
  WorkspaceTemplateStarterPrompt,
} from '@canopy/protocol';

export type OnboardingSuggestionQueueStatus =
  | 'loading'
  | 'has-rows'
  | 'exhausted';

/**
 * The curated project template behind the active empty new chat's project
 * (CAN-3032). Published by `ChatOnboardingChecklistHost` while mounted so the
 * shared checklist runtime can lead with that template's own setup; null on
 * Home, in plain projects, and in code chats.
 */
export interface OnboardingChatBlueprintContext {
  projectId: string;
  externalId: string;
  /** Template display name, for headings and sidebar labels. */
  name: string;
  /** Plugin refs the template bundles (skill refs excluded), sources intact. */
  pluginRefs: readonly ShareablePluginRef[];
  /** The project's starter prompts (its own, else the template's). */
  starterPrompts: readonly WorkspaceTemplateStarterPrompt[];
  /** The project's default selections, where the template's refs landed. */
  projectSelections: ChatTabPluginSelections | null;
}

/** Hosts share one runtime and one queue across Home, sidebar, and new chats. */
export const useOnboardingSuggestionSurfaces = create<{
  home: HTMLElement | null;
  chat: HTMLElement | null;
  /** Active empty chat whose composer receives checklist example prompts. */
  chatPromptTargetId: string | null;
  /** Active empty chat whose adjacent browser panel receives provider OAuth. */
  chatBrowserTarget: {
    projectId: string;
    worktreeId: string;
    chatId: string;
  } | null;
  /** Active empty chat's project template, when it has one. */
  chatBlueprint: OnboardingChatBlueprintContext | null;
  /**
   * The chat tab whose host published `chatBlueprint` and
   * `chatBlueprintPending`, so only that host's unmount withdraws them.
   */
  chatBlueprintOwner: string | null;
  /**
   * The active empty chat belongs to a seeded project whose template is
   * still being read: hold the rows rather than draw the general checklist
   * and then swap it for the tailored one.
   */
  chatBlueprintPending: boolean;
  sidebar: HTMLElement | null;
  sidebarHasRows: boolean;
  queueStatus: OnboardingSuggestionQueueStatus;
  /**
   * Whether the Home card has anything to show (rows, or the inputs that
   * can hide a row still loading). False once the queue is genuinely empty,
   * so Home hands the prompt chips and readiness block back.
   */
  homeHasRows: boolean;
  /**
   * Page Home is rendering the startup resume row (CAN-4746), not merely
   * holding an offer. While true, Home's portal shows only the lead
   * suggestion so Continue stays directly below the composer; the queue and
   * the chat surface keep their full window. Published only by the
   * page-variant `HomeContinueSection` (HomePage mounts the one instance).
   */
  homeResumePending: boolean;
  visible: boolean;
  focusEntry: string | null;
  /** Keeps the Home plan-mode toggle highlighted until the user uses it. */
  planModeHighlight: boolean;
  /** Identifies the composer model picker currently being taught. */
  modelPickerHighlightTarget:
    | { scope: 'home' }
    | { scope: 'chat'; chatId: string }
    | null;
}>(() => ({
  home: null,
  chat: null,
  chatPromptTargetId: null,
  chatBrowserTarget: null,
  chatBlueprint: null,
  chatBlueprintPending: false,
  chatBlueprintOwner: null,
  sidebar: null,
  sidebarHasRows: false,
  queueStatus: 'loading',
  homeHasRows: false,
  homeResumePending: false,
  visible: false,
  focusEntry: null,
  planModeHighlight: false,
  modelPickerHighlightTarget: null,
}));

export function setOnboardingHomeHost(home: HTMLDivElement | null): void {
  useOnboardingSuggestionSurfaces.setState({ home });
}

export function setOnboardingHomeResumePending(
  homeResumePending: boolean,
): void {
  useOnboardingSuggestionSurfaces.setState({ homeResumePending });
}

export function setOnboardingSidebarHost(sidebar: HTMLDivElement | null): void {
  useOnboardingSuggestionSurfaces.setState({ sidebar });
}

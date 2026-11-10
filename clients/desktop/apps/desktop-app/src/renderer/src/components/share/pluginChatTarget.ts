import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  SHARE_INSTALL_TURNING_ON_LABEL,
  shareInstallTurnOnInChatFailureCopy,
} from '@canopy/ui-app/sharing/share-install-copy';
import { unionPluginSelections } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  CHAT_PLUGINS_BUSY_MESSAGE,
  editChatPlugins,
} from '@/lib/chatPluginEditing';
import { getChatTabLabel } from '@/lib/chatTabLabel';
import { navigateToWorktreeChat, useChatStore } from '@/stores/chatStore';
import type { ChatTab } from '@/stores/chat/types';
import { worktreeKey } from '@/stores/chat/utils';
import { useGitHubStore } from '@/stores/githubStore';
import {
  useNavigationStore,
  type NavigationPage,
} from '@/stores/navigationStore';
import {
  activeChatTarget,
  isSameChatTarget,
  offerChatAction,
  watchChatTarget,
  type ShareChatTarget,
} from './shareChatTarget';
import { renderTurnOnInChatLabel } from './TurnOnInChatLabel';

/**
 * The chat a shared plugin install returns to (CAN-5219). Plugins are
 * installed from Customize, and the chat store keeps the selected worktree's
 * chat while the user is there, so that chat qualifies from either page.
 * Turning the plugin on goes through IPC rather than the composer, so no
 * visible composer is required. Settings and the portal still exclude it.
 */
const PLUGIN_CHAT_PAGES: ReadonlySet<NavigationPage> = new Set([
  'main',
  'plugins',
]);

/** The chat a plugin install opened over, or null. Identity only. */
export function capturePluginChatTarget(): ShareChatTarget | null {
  return activeChatTarget(PLUGIN_CHAT_PAGES);
}

/**
 * The captured chat is still the selected worktree's active chat. Moving
 * between the chat page and Customize keeps it current.
 */
export function isPluginChatTargetCurrent(target: ShareChatTarget): boolean {
  return isSameChatTarget(activeChatTarget(PLUGIN_CHAT_PAGES), target);
}

/** Calls `onInvalid` once the captured chat stops qualifying. */
export function watchPluginChatTarget(
  target: ShareChatTarget,
  onInvalid: () => void,
): () => void {
  return watchChatTarget(() => isPluginChatTargetCurrent(target), onInvalid);
}

function pluginChatTargetTab(target: ShareChatTarget): ChatTab | undefined {
  return useChatStore
    .getState()
    .worktreeChats[
      worktreeKey(target)
    ]?.tabs.find((tab) => tab.id === target.tabId);
}

/** The name a label quotes for a chat tab; `''` when it only has its id. */
export function pluginChatTabTitle(tab: ChatTab | undefined): string {
  if (tab === undefined) return '';
  const label = getChatTabLabel(tab);
  return label === tab.id ? '' : label;
}

/** The captured chat's name, or `''` when it is gone or untitled. */
export function pluginChatTargetTitle(target: ShareChatTarget): string {
  return pluginChatTabTitle(pluginChatTargetTab(target));
}

export type PluginChatEnableOutcome =
  /** The plugin is on in the captured chat. */
  | 'enabled'
  /** The captured chat is no longer the selected one. */
  | 'stale'
  /** The chat cannot take a plugin change yet (streaming, read-only, new). */
  | 'busy'
  /** The write failed. */
  | 'failed';

/**
 * Turns an installed plugin on in the captured chat, keeping every plugin
 * already effective there. Idempotent: a plugin already on stays on once.
 */
export async function enablePluginInChat(
  target: ShareChatTarget,
  plugin: { readonly marketplaceId: string; readonly pluginName: string },
): Promise<PluginChatEnableOutcome> {
  if (!isPluginChatTargetCurrent(target)) return 'stale';
  const tab = pluginChatTargetTab(target);
  if (tab === undefined) return 'stale';
  if (
    tab.readOnly ||
    tab.pendingInitialCreation ||
    tab.status === 'streaming'
  ) {
    return 'busy';
  }
  const added = {
    ...normalizePluginSelections(undefined),
    pluginRefs: [
      { marketplaceId: plugin.marketplaceId, pluginName: plugin.pluginName },
    ],
  };
  try {
    // `current` is the chat's effective set, inherited defaults included;
    // the editor derives local selections and tombstones from the result.
    await editChatPlugins(
      useChatStore.getState,
      {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.tabId,
      },
      (current) => unionPluginSelections(current, added),
    );
  } catch (error) {
    // The editor's own refusal: the chat started a turn while queued.
    if (error instanceof Error && error.message === CHAT_PLUGINS_BUSY_MESSAGE) {
      return 'busy';
    }
    reportClientAppError(error);
    return 'failed';
  }
  return 'enabled';
}

/**
 * Says why Turn on in the chat did not happen. It answers a click, so it
 * shows with in-app notifications off and raises no native banner.
 */
export function notifyTurnOnInChatFailure(
  outcome: Exclude<PluginChatEnableOutcome, 'enabled'>,
): void {
  useGitHubStore
    .getState()
    .addToast(
      shareInstallTurnOnInChatFailureCopy(outcome),
      'warning',
      undefined,
      {
        forceInApp: true,
        suppressOsNotification: true,
      },
    );
}

const FOCUS_ATTEMPTS = 120;

/** One frame's targeted focus request; true when a composer took it. */
function requestTargetComposerFocus(tabId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    requestAnimationFrame(() => {
      let handled = false;
      document.dispatchEvent(
        new CustomEvent('canopy:focus-chat-input', {
          detail: {
            targetTabId: tabId,
            markHandled: (): void => {
              handled = true;
            },
          },
        }),
      );
      resolve(handled);
    });
  });
}

/**
 * Takes the user back to the captured chat and focuses its composer once it
 * mounts. Best-effort and never throws: nothing happens once the chat stops
 * being the selected one, and focus gives up when the user leaves the page.
 */
export async function returnToPluginChat(
  target: ShareChatTarget,
): Promise<void> {
  try {
    if (!isPluginChatTargetCurrent(target)) return;
    const isCurrent = (): boolean => isPluginChatTargetCurrent(target);
    await navigateToWorktreeChat(
      {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.tabId,
      },
      isCurrent,
    );
    for (let attempt = 0; attempt < FOCUS_ATTEMPTS; attempt += 1) {
      if (useNavigationStore.getState().activePage !== 'main' || !isCurrent()) {
        return;
      }
      if (await requestTargetComposerFocus(target.tabId)) return;
    }
  } catch (error) {
    // Navigation and focus are a convenience; the plugin is already on.
    reportClientAppError(error);
  }
}

export interface TurnOnInChatOffer {
  /** The installation notice the action rides on. */
  message: string;
  target: ShareChatTarget;
  /** The chat's name when offered; the notice does not follow renames. */
  title: string;
  /** Turns the plugin on in the target chat; see `enablePluginInChat`. */
  stage: () => Promise<PluginChatEnableOutcome>;
}

/**
 * Shows the installation notice with **Turn on in “<chat>”** as its one
 * action. On success it returns to the chat before the button settles.
 */
export function offerTurnOnInChat({
  message,
  target,
  title,
  stage,
}: TurnOnInChatOffer): void {
  offerChatAction({
    message,
    label: renderTurnOnInChatLabel(title),
    busyLabel: SHARE_INSTALL_TURNING_ON_LABEL,
    target,
    watch: watchPluginChatTarget,
    stage: async (): Promise<PluginChatEnableOutcome> => {
      const outcome = await stage();
      if (outcome === 'enabled') await returnToPluginChat(target);
      return outcome;
    },
    succeeded: 'enabled',
    onFailure: notifyTurnOnInChatFailure,
  });
}

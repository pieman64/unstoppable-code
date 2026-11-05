/**
 * Desktop side of two panel layout store policies early access turns on:
 *
 * - Chats live only in the main chat group (`setPanelLayoutChatGroup`):
 *   never in the Side Panel, the bottom drawer, or a split. The store
 *   redirects new chats there and refuses to move one out.
 * - Activity is not a panel (`setPanelLayoutExcludedKinds`): it has its own
 *   card beside the chat, so the store refuses Activity tabs. A shared-
 *   container viewer has no card (it is not the selected worktree), so its
 *   layout keeps them as its way into Activity.
 *
 * Both rules govern only placements made from now on. A layout the user
 * already has keeps its chats and Activity tabs where they are, on load and
 * when the switch turns on or off, so turning early access off returns it
 * unchanged.
 */
import { DEFAULT_CHAT_GROUP_ID } from '@/lib/panels/panel-group-ids';
import { isSharedContainerViewerLayout } from '@/lib/panels/shared-container-viewer-layout';
import {
  setPanelLayoutChatGroup,
  setPanelLayoutExcludedKinds,
} from '@/stores/panelLayoutStore';
import {
  ensureLabsExperimentsSubscription,
  getLabsFeatureEnabled,
  subscribeLabsFeature,
} from '@/stores/labsExperimentsStore';

let unsubscribe: (() => void) | null = null;

function applyEarlyAccessPanelRules(earlyAccess: boolean): void {
  setPanelLayoutChatGroup(earlyAccess ? DEFAULT_CHAT_GROUP_ID : null);
  setPanelLayoutExcludedKinds(
    earlyAccess ? ['activity-section'] : [],
    isSharedContainerViewerLayout,
  );
}

/**
 * Keeps the early-access panel rules in force while the switch is on,
 * following it from any window. Idempotent.
 */
export function ensureEarlyAccessPanelRulesSync(): void {
  if (unsubscribe !== null) return;
  ensureLabsExperimentsSubscription();
  applyEarlyAccessPanelRules(getLabsFeatureEnabled('activity-card'));
  unsubscribe = subscribeLabsFeature('activity-card', (enabled, previous) => {
    if (enabled !== previous) {
      applyEarlyAccessPanelRules(enabled);
    }
  });
}

import type { CanopyCapabilities } from '@canopy/app-core';
import type {
  SidebarActivityEntry,
  SidebarActivityInventory,
  SidebarActivityLoader,
} from '@canopy/app-state';
import { sidebarRowLabel } from './worktree-status';

/** What one complete Activity load returns from the host. */
export interface SidebarActivityHostInventory {
  readonly inventory: SidebarActivityInventory;
  /** Chat keys unread when the inventory completed. */
  readonly unreadKeys?: ReadonlySet<string>;
  /** Chat keys with an unsent draft. Read only under `chatDrafts`. */
  readonly draftKeys?: ReadonlySet<string>;
}

/**
 * Host wiring for the sidebar Activity mode (CAN-390). Transport, drafts,
 * unread projection, and navigation stay in the host; the shared surface
 * classifies, freezes, and renders.
 */
export interface SidebarActivityHost {
  /**
   * The host session the inventory belongs to. A change ends the current
   * Activity cycle, so a reconnect never revives a stale frozen list.
   */
  readonly sessionKey: string;
  /** Resolves only with a complete inventory; rejects on a partial one. */
  readonly loadInventory: () => Promise<SidebarActivityHostInventory>;
  /** Live unread chat keys; dots update in place from this set. */
  readonly unreadKeys: ReadonlySet<string>;
  /** Key of the chat on screen, or `null` when the host cannot tell. */
  readonly activeChatKey: string | null;
  /** Opens exactly this chat through the host's existing navigation. */
  readonly onOpenChat: (entry: SidebarActivityEntry) => void;
}

/** Whether Activity can be offered for this host and capability set. */
export function isSidebarActivityAvailable(
  capabilities: CanopyCapabilities,
  host: SidebarActivityHost | undefined,
): host is SidebarActivityHost {
  return host !== undefined && capabilities.sidebarActivityMode === true;
}

/**
 * The single loader both enable and retry use: it injects the shared row
 * label and drops drafts a host cannot vouch for.
 */
export function prepareSidebarActivityLoader(
  host: SidebarActivityHost,
  capabilities: CanopyCapabilities,
): SidebarActivityLoader {
  const drafts = capabilities.chatDrafts === true;
  return async () => {
    const loaded = await host.loadInventory();
    return {
      inventory: loaded.inventory,
      unreadKeys: loaded.unreadKeys,
      draftKeys: drafts ? loaded.draftKeys : undefined,
      worktreeLabel: sidebarRowLabel,
    };
  };
}

import type { CanopyCapabilities } from '@canopy/app-core';
import type {
  SidebarActivityEntry,
  SidebarActivityInventory,
  SidebarActivityLoader,
  SidebarActivitySpaceMuted,
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
  /**
   * Live: whether a space's acknowledged notification choice is Mute. Its
   * chats never classify as unread and show no dot (CAN-4378). Attached with
   * {@link withSidebarActivitySpaceMute} from the rail's own lookup.
   */
  readonly isSpaceMuted?: SidebarActivitySpaceMuted;
}

/**
 * Attaches the rail's mute lookup to a host, so every Activity build and row
 * agrees with the tree's dots. Returns `host` itself without a lookup.
 */
export function withSidebarActivitySpaceMute(
  host: SidebarActivityHost | undefined,
  isSpaceMuted: SidebarActivitySpaceMuted | undefined,
): SidebarActivityHost | undefined {
  if (host === undefined || isSpaceMuted === undefined) return host;
  return { ...host, isSpaceMuted };
}

/** Whether an Activity row's space is muted right now. */
export function isSidebarActivityEntryMuted(
  host: SidebarActivityHost,
  entry: SidebarActivityEntry,
): boolean {
  const { isSpaceMuted } = host;
  if (isSpaceMuted === undefined) return false;
  if (entry.kind === 'worktree-chat')
    return isSpaceMuted(entry.workspaceLocalId, entry.worktreeLocalId);
  return (
    entry.workEntryId !== undefined &&
    isSpaceMuted(entry.projectLocalId, entry.workEntryId)
  );
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
      isSpaceMuted: host.isSpaceMuted,
    };
  };
}

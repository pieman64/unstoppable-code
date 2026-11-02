import type { PanelKind } from '@canopy/protocol';
import {
  usePanelLayoutStore,
  type WorktreePanelLayout,
} from './panel-layout-store';

// VS Code's serialized-grid Orientation enum uses HORIZONTAL = 1.
const HORIZONTAL_GRID_ORIENTATION = 1;
const DEFAULT_CHAT_GROUP_ID = 'group-chat';

export interface CreatedChatSiblingGroup {
  readonly groupId: string;
  /** A pre-existing outer-right group collapsed to make room for the sibling. */
  readonly collapsedGroupId: string | null;
  /** The group that was maximized before sibling placement began. */
  readonly previouslyMaximizedGroupId: string | null;
}

/**
 * Panel kinds that open beside a chat and share one reusable side group.
 * Content kinds that should join that group are added here. A group holding
 * plan content or a pipeline run is reusable just like one holding a file,
 * browser, or Change Diagram.
 */
export const CHAT_SIBLING_CONTENT_KINDS: ReadonlySet<PanelKind> =
  new Set<PanelKind>([
    'file-diff',
    'browser',
    'change-diagram',
    'pipeline-execution',
    'plan',
    'plan-diagram',
    'chat-visuals',
    'subagents',
    'subagent-chat',
  ]);

/**
 * Finds the most-recently-used non-chat group that already hosts sibling
 * content opened from chat (any of `contentKinds`). File, browser, pipeline
 * run, and other content panels intentionally share this group so repeated
 * opens from different chat tabs (or of different runs) add tabs instead of
 * creating another side-by-side split.
 */
export function pickReusableChatSiblingGroupId(
  layout: WorktreePanelLayout,
  originGroupId: string,
  contentKinds: ReadonlySet<PanelKind> = CHAT_SIBLING_CONTENT_KINDS,
): string | null {
  for (const groupId of new Set([
    ...layout.mruGroupIds,
    ...Object.keys(layout.groups),
  ])) {
    if (groupId === originGroupId) continue;
    const group = layout.groups[groupId];
    if (
      group !== undefined &&
      group.tabs.some((tab) => contentKinds.has(tab.kind)) &&
      !group.tabs.some((tab) => tab.kind === 'chat')
    ) {
      return groupId;
    }
  }
  return null;
}

/**
 * Target group for content opened with no origin chat or file (a changed
 * file from the Activity list, a pipeline run, a script's dev server): the
 * most-recently-used group that already holds a chat-kind panel, else the
 * default chat group when it exists (the default layout may seed it EMPTY
 * before chats hydrate), else the active group, else the first group.
 */
export function pickContentTargetGroupId(
  layout: WorktreePanelLayout,
): string | null {
  for (const groupId of layout.mruGroupIds) {
    const group = layout.groups[groupId];
    if (group?.tabs.some((tab) => tab.kind === 'chat')) {
      return groupId;
    }
  }
  if (layout.groups[DEFAULT_CHAT_GROUP_ID] !== undefined) {
    return DEFAULT_CHAT_GROUP_ID;
  }
  return layout.activeGroupId ?? Object.keys(layout.groups)[0] ?? null;
}

/**
 * Where a host opens files that arrive without a usable placement hint:
 * - `chat-group`: the most recently used chat group (Code worktrees);
 * - `documents-group`: one reusable documents group beside the anchor chat,
 *   never the chat group itself (Cowork), so the conversation and composer
 *   stay visible while files open beside them.
 * The host maps its surfaces to a policy; shared code never inspects the host.
 */
export type FilePanelPlacementPolicy = 'chat-group' | 'documents-group';

/** The chat panel that a documents group opens beside. */
export interface ChatPanelAnchor {
  readonly groupId: string;
  readonly panelId: string;
  readonly chatTabId: string;
}

/**
 * Groups in most-recently-used order, followed by groups MRU does not list
 * yet in their stable layout order, so every group is considered exactly once.
 */
function groupIdsInMruOrder(layout: WorktreePanelLayout): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const groupId of [
    ...layout.mruGroupIds,
    ...Object.keys(layout.groups),
  ]) {
    if (!seen.has(groupId) && layout.groups[groupId] !== undefined) {
      seen.add(groupId);
      ordered.push(groupId);
    }
  }
  return ordered;
}

function chatAnchorFor(
  groupId: string,
  tab: WorktreePanelLayout['groups'][string]['tabs'][number],
): ChatPanelAnchor | null {
  const chatTabId = tab.kind === 'chat' ? tab.instance?.chatTabId : undefined;
  return chatTabId === undefined
    ? null
    : { groupId, panelId: tab.panelId, chatTabId };
}

/** Every chat panel's anchor, group by group in `groupIds` order. */
function chatAnchors(
  layout: WorktreePanelLayout,
  groupIds: readonly string[],
): ChatPanelAnchor[] {
  return groupIds.flatMap((groupId) =>
    (layout.groups[groupId]?.tabs ?? []).flatMap((tab) => {
      const anchor = chatAnchorFor(groupId, tab);
      return anchor === null ? [] : [anchor];
    }),
  );
}

/**
 * Resolves the chat a documents group opens beside, within one layout:
 * the first of `preferredChatTabIds` (an explicit origin, then the last
 * active chat) bound to a chat panel here; else the selected chat panel of
 * the most recently used group; else the first chat panel in that order.
 * Ids that no chat panel in this layout binds (stale or from another
 * worktree) are skipped. Only chat-kind panels qualify, so a just-opened
 * file can never become its own anchor. `null` when the layout has no chat.
 */
export function resolveChatPanelAnchor(
  layout: WorktreePanelLayout,
  preferredChatTabIds: readonly (string | null | undefined)[],
): ChatPanelAnchor | null {
  const anchors = chatAnchors(layout, groupIdsInMruOrder(layout));
  for (const chatTabId of preferredChatTabIds) {
    const preferred = anchors.find((anchor) => anchor.chatTabId === chatTabId);
    if (preferred !== undefined) {
      return preferred;
    }
  }
  return (
    anchors.find(
      (anchor) =>
        layout.groups[anchor.groupId]?.activePanelId === anchor.panelId,
    ) ??
    anchors[0] ??
    null
  );
}

/**
 * Returns the group occupying the grid's full-height right edge. A leaf only
 * has that geometry when it is the final direct child of a horizontal root;
 * a branch there contains vertically stacked groups instead.
 */
function fullHeightRightmostGroupId(layoutKey: string): string | null {
  const serialized = usePanelLayoutStore.getState().serializeLayout(layoutKey);
  const root = serialized?.grid.root;
  if (
    serialized?.grid.orientation !== HORIZONTAL_GRID_ORIENTATION ||
    root?.type !== 'branch' ||
    root.children.length < 2
  ) {
    return null;
  }
  const rightmost = root.children[root.children.length - 1];
  return rightmost?.type === 'leaf' ? rightmost.groupId : null;
}

/**
 * Creates the side group used for content opened from chat. Before splitting,
 * collapse an existing full-height right rail so the new sibling gets useful
 * horizontal space. Reusable sibling groups never pass through this path.
 */
export function createChatSiblingGroupToRight(
  layoutKey: string,
  originGroupId: string,
  options: { readonly activate?: boolean } = {},
): CreatedChatSiblingGroup | null {
  const store = usePanelLayoutStore.getState();
  const activate = options.activate !== false;
  const previouslyMaximizedGroupId =
    store.layouts[layoutKey]?.maximizedGroupId ?? null;
  const rightmostGroupId = fullHeightRightmostGroupId(layoutKey);
  const rightmostGroup =
    rightmostGroupId === null
      ? undefined
      : store.layouts[layoutKey]?.groups[rightmostGroupId];

  // collapseGroup intentionally refuses to mutate a maximized layout, while
  // splitGroup exits maximize implicitly. Exit explicitly so the right rail
  // can be collapsed first, and retain enough state to restore on rollback.
  if (activate && previouslyMaximizedGroupId !== null) {
    store.maximizeGroup(layoutKey, previouslyMaximizedGroupId, false);
  }
  const collapsedGroupId =
    activate &&
    rightmostGroupId !== null &&
    rightmostGroupId !== originGroupId &&
    !rightmostGroup?.tabs.some((tab) => tab.kind === 'chat') &&
    store.collapseGroup(layoutKey, rightmostGroupId)
      ? rightmostGroupId
      : null;

  const groupId = activate
    ? store.splitGroup(layoutKey, originGroupId, 'right')
    : store.splitGroup(layoutKey, originGroupId, 'right', undefined, {
        activate: false,
      });
  if (groupId !== null) {
    return {
      groupId,
      collapsedGroupId,
      previouslyMaximizedGroupId,
    };
  }

  // A failed split must not leave behind the preparatory collapse.
  if (collapsedGroupId !== null) {
    usePanelLayoutStore
      .getState()
      .expandGroup(layoutKey, collapsedGroupId, { focus: false });
  }
  if (previouslyMaximizedGroupId !== null) {
    usePanelLayoutStore
      .getState()
      .maximizeGroup(layoutKey, previouslyMaximizedGroupId, true);
  }
  return null;
}

/** Rolls back a newly-created sibling group and its preparatory collapse. */
export function rollbackCreatedChatSiblingGroup(
  layoutKey: string,
  created: CreatedChatSiblingGroup,
): void {
  const store = usePanelLayoutStore.getState();
  store.closeGroup(layoutKey, created.groupId);
  if (created.collapsedGroupId !== null) {
    usePanelLayoutStore
      .getState()
      .expandGroup(layoutKey, created.collapsedGroupId, { focus: false });
  }
  if (created.previouslyMaximizedGroupId !== null) {
    usePanelLayoutStore
      .getState()
      .maximizeGroup(layoutKey, created.previouslyMaximizedGroupId, true);
  }
}

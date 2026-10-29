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
  for (const groupId of layout.mruGroupIds) {
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
): CreatedChatSiblingGroup | null {
  const store = usePanelLayoutStore.getState();
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
  if (previouslyMaximizedGroupId !== null) {
    store.maximizeGroup(layoutKey, previouslyMaximizedGroupId, false);
  }
  const collapsedGroupId =
    rightmostGroupId !== null &&
    rightmostGroupId !== originGroupId &&
    !rightmostGroup?.tabs.some((tab) => tab.kind === 'chat') &&
    store.collapseGroup(layoutKey, rightmostGroupId)
      ? rightmostGroupId
      : null;

  const groupId = store.splitGroup(layoutKey, originGroupId, 'right');
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

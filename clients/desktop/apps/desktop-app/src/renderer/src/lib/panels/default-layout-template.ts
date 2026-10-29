/**
 * Pure transforms between a captured `SerializablePanelLayoutFile` and the
 * global default-layout template.
 *
 * A captured layout can bind content to worktree-local entities (chat →
 * `{ chatTabId }`, file-diff → `{ fileTabId }`) that cannot be reproduced in
 * another worktree. `templatizeLayoutForDefault` genericizes it: it drops
 * `file-diff`, Browser, plan, and subagent-chat panels, removes chat panels
 * (a single chat is re-added per worktree at apply time), converts one bound
 * terminal into the portable unbound placeholder understood by terminal
 * materialization, normalizes the
 * chat host group id to `DEFAULT_CHAT_GROUP_ID`, strips `poppedOut`, and
 * preserves portable panels plus ALL geometry (sizes, nesting, orientation)
 * and collapsed state — re-keyed as the user's own, since `collapsed.auto`
 * (Canopy's seeded default collapse) must not ride into a saved default.
 * `retargetTemplateForWorktree` re-binds the chat host to a target worktree's
 * active chat (or leaves it empty when no chat is hydrated yet — the
 * chat⇄panel sync bridge materializes it later, keyed on the `group-chat` id).
 *
 * Store-free by design (imports only protocol types + group-id constants +
 * the ChatTabPanelSeed type), so it is unit-testable without the panel store.
 */
import {
  PANEL_LAYOUT_FILE_VERSION,
  type ISerializedPanelEntry,
  type ISerializedPanelLeafNode,
  type ISerializedPanelNode,
  type PanelCollapsedState,
  type PanelKind,
  type SerializablePanelLayoutFile,
} from '@canopy/protocol';
import { DEFAULT_CHAT_GROUP_ID } from './panel-group-ids';
import type { ChatTabPanelSeed } from './chat-panel-binding';

/**
 * Instance-bound kinds that cannot carry over to a new worktree verbatim.
 * `browser` is included because a Browser panel binds one concrete persisted
 * session id that cannot be retargeted to another worktree — saved default
 * templates therefore omit concrete Browser tabs (surrounding mixed-content
 * group geometry is preserved; normalization removes emptied leaves).
 * `plan` and `plan-diagram` are included because a tracked plan is
 * worktree-local: another worktree has no plan with that id.
 * Activity cards remain portable because their section bindings are stable.
 * A terminal session id is worktree-local too, but the terminal panel itself
 * is portable: the target worktree replaces one unbound placeholder with its
 * first session. Only one placeholder can exist in a layout family, so a
 * captured layout with multiple bound terminals retains the first slot.
 * `pipeline-execution` and `subagent-chat` are omitted for the same reason as
 * `browser`: they bind a concrete run or chat/subagent pair of the captured
 * worktree, which no other worktree has. Unbound `subagents` stays portable.
 * `chat-visuals` is omitted too: it binds one chat of the captured worktree.
 */
const INSTANCE_BOUND_KINDS: ReadonlySet<PanelKind> = new Set<PanelKind>([
  'chat',
  'file-diff',
  'browser',
  'pipeline-execution',
  'subagent-chat',
  'plan',
  'plan-diagram',
  'chat-visuals',
]);

function isWorktreeBoundPanel(panel: ISerializedPanelEntry): boolean {
  return INSTANCE_BOUND_KINDS.has(panel.kind);
}

interface TemplatizeContext {
  preferredTerminalPlaceholderPanelId: string | null;
  terminalPlaceholderRetained: boolean;
}

function collectLeaves(
  node: ISerializedPanelNode,
  out: ISerializedPanelLeafNode[],
): void {
  if (node.type === 'leaf') {
    out.push(node);
    return;
  }
  for (const child of node.children) {
    collectLeaves(child, out);
  }
}

/**
 * The group id that hosts the chat, or `null` when the layout has no chat.
 *
 * When the chat-bearing leaf's group id is NOT already `DEFAULT_CHAT_GROUP_ID`
 * AND a separate leaf already uses `DEFAULT_CHAT_GROUP_ID`, remapping the
 * chat-bearing leaf onto `DEFAULT_CHAT_GROUP_ID` (the normal path below) would
 * produce TWO leaves sharing that group id — a duplicate `migratePanelLayout`
 * accepts but `restoreLayout` rejects at apply time. In that case the
 * existing `group-chat` leaf is reported as the host instead, so
 * `templatizeLeaf` performs no remap and the chat panel is later re-injected
 * (by `retargetTemplateForWorktree`) into the leaf that already owns
 * `group-chat`.
 */
interface ChatHostMapping {
  templateHostGroupId: string | null;
  capturedChatGroupId: string | null;
}

function isUnboundTerminal(panel: ISerializedPanelEntry): boolean {
  return (
    panel.kind === 'terminal' &&
    (typeof panel.instance?.terminalId !== 'string' ||
      panel.instance.terminalId.trim().length === 0)
  );
}

function findChatHostMapping(root: ISerializedPanelNode): ChatHostMapping {
  const leaves: ISerializedPanelLeafNode[] = [];
  collectLeaves(root, leaves);
  const withChat = leaves.find((leaf) =>
    leaf.panels.some((panel) => panel.kind === 'chat'),
  );
  const existingChatGroup = leaves.find(
    (leaf) => leaf.groupId === DEFAULT_CHAT_GROUP_ID,
  );
  if (
    withChat !== undefined &&
    withChat.groupId !== DEFAULT_CHAT_GROUP_ID &&
    existingChatGroup !== undefined
  ) {
    return {
      templateHostGroupId: DEFAULT_CHAT_GROUP_ID,
      capturedChatGroupId: withChat.groupId,
    };
  }
  if (withChat !== undefined) {
    return {
      templateHostGroupId: withChat.groupId,
      capturedChatGroupId: withChat.groupId,
    };
  }
  return {
    templateHostGroupId:
      existingChatGroup !== undefined ? existingChatGroup.groupId : null,
    capturedChatGroupId: null,
  };
}

function recomputeActivePanelId(
  panels: readonly ISerializedPanelEntry[],
  previous: string | null,
): string | null {
  if (previous !== null && panels.some((p) => p.panelId === previous)) {
    return previous;
  }
  return panels[0]?.panelId ?? null;
}

/**
 * Re-keys a captured collapse as the USER's own by dropping `auto`.
 *
 * `PanelCollapsedState.auto` marks a collapse Canopy seeded on a fresh
 * worktree so it may be reopened once the rail gains work content
 * (CAN-2836). Saving a layout as the global default is by definition a
 * deliberate user decision about that collapsed state, so the flag must not
 * ride along: a default carrying `auto: true` would make every worktree that
 * later adopts it auto-expand its rail once, contradicting the invariant that
 * a layout the user chose wins.
 *
 * Returns a partial so the caller can spread it: an uncollapsed leaf yields
 * `{}` and keeps `collapsed` absent rather than writing an explicit
 * `undefined`.
 */
function userOwnedCollapse(
  collapsed: PanelCollapsedState | undefined,
): Pick<ISerializedPanelLeafNode, 'collapsed'> | Record<string, never> {
  if (collapsed === undefined) {
    return {};
  }
  // Strip exactly one field rather than allowlisting two: a field added to
  // `PanelCollapsedState` later should be carried into saved defaults by
  // default, not silently dropped by an allowlist nobody remembers to update.
  const { auto, ...userOwned } = collapsed;
  void auto; // Deliberately discarded — this is the whole point of the helper.
  return { collapsed: userOwned };
}

function templatizeLeaf(
  leaf: ISerializedPanelLeafNode,
  chatHostGroupId: string | null,
  context: TemplatizeContext,
): ISerializedPanelLeafNode {
  const panels = leaf.panels.flatMap((panel): ISerializedPanelEntry[] => {
    if (isWorktreeBoundPanel(panel)) {
      return [];
    }
    if (panel.kind !== 'terminal') {
      return [panel];
    }
    if (context.terminalPlaceholderRetained) {
      return [];
    }
    if (
      context.preferredTerminalPlaceholderPanelId !== null &&
      panel.panelId !== context.preferredTerminalPlaceholderPanelId
    ) {
      return [];
    }
    context.terminalPlaceholderRetained = true;
    const placeholder = { ...panel };
    delete placeholder.instance;
    return [placeholder];
  });
  const groupId =
    chatHostGroupId !== null && leaf.groupId === chatHostGroupId
      ? DEFAULT_CHAT_GROUP_ID
      : leaf.groupId;
  return {
    ...leaf,
    groupId,
    panels,
    activePanelId: recomputeActivePanelId(panels, leaf.activePanelId),
    ...userOwnedCollapse(leaf.collapsed),
  };
}

function templatizeNode(
  node: ISerializedPanelNode,
  chatHostGroupId: string | null,
  context: TemplatizeContext,
): ISerializedPanelNode {
  if (node.type === 'leaf') {
    return templatizeLeaf(node, chatHostGroupId, context);
  }
  return {
    ...node,
    children: node.children.map((child) =>
      templatizeNode(child, chatHostGroupId, context),
    ),
  };
}

function findUnboundTerminalPanelId(root: ISerializedPanelNode): string | null {
  const leaves: ISerializedPanelLeafNode[] = [];
  collectLeaves(root, leaves);
  for (const leaf of leaves) {
    const placeholder = leaf.panels.find(isUnboundTerminal);
    if (placeholder !== undefined) {
      return placeholder.panelId;
    }
  }
  return null;
}

function findLeafByGroupId(
  root: ISerializedPanelNode,
  groupId: string,
): ISerializedPanelLeafNode | undefined {
  const leaves: ISerializedPanelLeafNode[] = [];
  collectLeaves(root, leaves);
  return leaves.find((leaf) => leaf.groupId === groupId);
}

/**
 * True iff `template` has a leaf hosting `DEFAULT_CHAT_GROUP_ID` — the group
 * a saved default must carry so `retargetTemplateForWorktree` can re-inject a
 * worktree's chat into it at apply time. A templatized layout captured from a
 * chat-less state (no chat panel and no pre-existing `group-chat` leaf) has no
 * such host and can never apply; callers should refuse to persist it as the
 * default.
 */
export function templateHasChatHost(
  template: SerializablePanelLayoutFile,
): boolean {
  const leaves: ISerializedPanelLeafNode[] = [];
  collectLeaves(template.grid.root, leaves);
  return leaves.some((leaf) => leaf.groupId === DEFAULT_CHAT_GROUP_ID);
}

export function templatizeLayoutForDefault(
  file: SerializablePanelLayoutFile,
): SerializablePanelLayoutFile {
  const { templateHostGroupId, capturedChatGroupId } = findChatHostMapping(
    file.grid.root,
  );
  const context: TemplatizeContext = {
    preferredTerminalPlaceholderPanelId: findUnboundTerminalPanelId(
      file.grid.root,
    ),
    terminalPlaceholderRetained: false,
  };
  const root = templatizeNode(file.grid.root, templateHostGroupId, context);
  const activeGroupIdRemapSource =
    capturedChatGroupId !== null &&
    capturedChatGroupId !== templateHostGroupId &&
    findLeafByGroupId(root, capturedChatGroupId)?.panels.length === 0
      ? capturedChatGroupId
      : null;
  const remap = (id: string): string =>
    (templateHostGroupId !== null && id === templateHostGroupId) ||
    (activeGroupIdRemapSource !== null && id === activeGroupIdRemapSource)
      ? DEFAULT_CHAT_GROUP_ID
      : id;
  return {
    version: PANEL_LAYOUT_FILE_VERSION,
    grid: {
      ...file.grid,
      root,
    },
    activeGroupId: remap(file.activeGroupId),
    mostRecentActiveGroupIds: file.mostRecentActiveGroupIds.map(remap),
  };
}

function applyLeaf(
  leaf: ISerializedPanelLeafNode,
  chatSeed: ChatTabPanelSeed | null,
): ISerializedPanelLeafNode {
  if (leaf.groupId !== DEFAULT_CHAT_GROUP_ID || chatSeed === null) {
    return leaf;
  }
  const chatEntry: ISerializedPanelEntry = {
    panelId: chatSeed.panelId,
    kind: chatSeed.kind,
    title: chatSeed.title,
    instance: chatSeed.instance,
  };
  const panels: ISerializedPanelEntry[] = [
    ...leaf.panels.filter((panel) => panel.panelId !== chatEntry.panelId),
    chatEntry,
  ];
  return { ...leaf, panels, activePanelId: chatEntry.panelId };
}

function applyNode(
  node: ISerializedPanelNode,
  chatSeed: ChatTabPanelSeed | null,
): ISerializedPanelNode {
  if (node.type === 'leaf') {
    return applyLeaf(node, chatSeed);
  }
  return {
    ...node,
    children: node.children.map((child) => applyNode(child, chatSeed)),
  };
}

export function retargetTemplateForWorktree(
  template: SerializablePanelLayoutFile,
  chatSeed: ChatTabPanelSeed | null,
): SerializablePanelLayoutFile | null {
  const leaves: ISerializedPanelLeafNode[] = [];
  collectLeaves(template.grid.root, leaves);
  const hasChatHost = leaves.some(
    (leaf) => leaf.groupId === DEFAULT_CHAT_GROUP_ID,
  );
  if (!hasChatHost) {
    return null;
  }
  return {
    version: PANEL_LAYOUT_FILE_VERSION,
    grid: {
      ...template.grid,
      root: applyNode(template.grid.root, chatSeed),
    },
    activeGroupId: template.activeGroupId,
    mostRecentActiveGroupIds: template.mostRecentActiveGroupIds,
  };
}

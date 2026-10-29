/**
 * Terminal-panel activation bridge.
 *
 * Terminal panels mirror Browser panels: each bound panel owns exactly one
 * terminal session (`instance.terminalId`). A single unbound `terminal:`
 * placeholder is still accepted for legacy/default layouts and is replaced
 * in place when the first session starts.
 */
import {
  findPanelByInstanceKey,
  getAuxPanelLayoutOwnerKey,
  usePanelLayoutStore,
  type PanelInstanceLocation,
  type PanelTabDescriptor,
} from '@/stores/panelLayoutStore';
import { requestTerminalFocus } from '@/lib/terminal-focus-intent';
import { requestTerminalSpawn } from '@/lib/terminalSpawnRequests';
import { DEFAULT_CHAT_GROUP_ID } from './panel-group-ids';
import { terminalPanelIdFor } from './terminal-panel-identity';
import { revealPanel } from './panel-reveal';
import { getWorkspaceLayoutMode } from '@/stores/workspaceLayoutModeStore';
import {
  ensureMinimalDestination,
  removeMinimalDestinationProbe,
} from './minimal-layout';

export interface TerminalPanelActivationSource {
  readonly layoutKey: string;
  readonly groupId: string;
}

export interface TerminalPanelActivationOptions {
  readonly terminalId?: string;
  readonly title?: string;
  readonly focus?: boolean;
  /** Explicit launch/reveal gesture that may request the terminal caret. */
  readonly focusOwnerDocument?: Document;
}

function isFamilyLayout(ownerKey: string, layoutKey: string): boolean {
  return (
    layoutKey === ownerKey || getAuxPanelLayoutOwnerKey(layoutKey) === ownerKey
  );
}

function findAnyTerminalPanel(
  worktreeKey: string,
  targetLayoutKey?: string,
): PanelInstanceLocation | null {
  const layouts = usePanelLayoutStore.getState().layouts;
  for (const [layoutKey, layout] of Object.entries(layouts)) {
    if (!isFamilyLayout(worktreeKey, layoutKey)) continue;
    if (targetLayoutKey !== undefined && layoutKey !== targetLayoutKey) {
      continue;
    }
    const groups = Object.entries(layout.groups);
    const activeGroup = groups.find(
      ([groupId]) => groupId === layout.activeGroupId,
    );
    const orderedGroups = activeGroup
      ? [
          activeGroup,
          ...groups.filter(([groupId]) => groupId !== layout.activeGroupId),
        ]
      : groups;
    for (const [groupId, group] of orderedGroups) {
      const activeTab = group.tabs?.find(
        (candidate) =>
          candidate.panelId === group.activePanelId &&
          candidate.kind === 'terminal',
      );
      const tab =
        activeTab ??
        group.tabs?.find((candidate) => candidate.kind === 'terminal');
      if (tab) return { layoutKey, groupId, panelId: tab.panelId };
    }
  }
  return null;
}

function findTerminalPanelInGroup(
  layoutKey: string,
  groupId: string,
): PanelInstanceLocation | null {
  const group =
    usePanelLayoutStore.getState().layouts[layoutKey]?.groups[groupId];
  if (!group) return null;
  const panel =
    group.tabs?.find(
      (candidate) =>
        candidate.panelId === group.activePanelId &&
        candidate.kind === 'terminal',
    ) ?? group.tabs?.find((candidate) => candidate.kind === 'terminal');
  return panel ? { layoutKey, groupId, panelId: panel.panelId } : null;
}

/** Resolve the exact layout/group hosting a terminal surface by panel id. */
export function findTerminalPanelSource(
  worktreeKey: string,
  panelId: string,
): TerminalPanelActivationSource | null {
  const layouts = usePanelLayoutStore.getState().layouts;
  for (const [layoutKey, layout] of Object.entries(layouts)) {
    if (!isFamilyLayout(worktreeKey, layoutKey)) continue;
    for (const [groupId, group] of Object.entries(layout.groups)) {
      if (group.tabs?.some((tab) => tab.panelId === panelId)) {
        return { layoutKey, groupId };
      }
    }
  }
  return null;
}

/**
 * Resolve a tab descriptor by panel id inside one group. `panelId` falls back
 * to the group's active panel, which is what a group-level reveal gesture
 * (expanding a collapsed bar) actually exposes.
 */
function findGroupTab(
  layoutKey: string,
  groupId: string,
  panelId?: string,
): PanelTabDescriptor | undefined {
  const group =
    usePanelLayoutStore.getState().layouts[layoutKey]?.groups[groupId];
  if (!group) return undefined;
  const targetPanelId = panelId ?? group.activePanelId;
  if (!targetPanelId) return undefined;
  return group.tabs?.find((candidate) => candidate.panelId === targetPanelId);
}

/** The terminal session id bound to a tab, if it is a bound terminal tab. */
function terminalBindingOf(
  tab: PanelTabDescriptor | undefined,
): string | undefined {
  return tab?.kind === 'terminal' ? tab.instance?.terminalId : undefined;
}

/**
 * Translate an explicit panel-tab selection/reveal into a one-shot terminal
 * caret request. Passive store changes (workspace restore, maximize, layout
 * hydration) deliberately never call this helper (CAN-2309).
 *
 * `ownerDocument` must be the document of the window whose chrome produced the
 * gesture, not the renderer-global `document`: a request recorded against the
 * wrong document is never consumed by the pane that is actually mounted there.
 * Main-window chrome passes `document`; `AuxPanelWindow` passes its
 * `childWindow.document`.
 */
export function requestSelectedTerminalPanelFocus(
  layoutKey: string,
  groupId: string,
  panelId: string,
  ownerDocument: Document,
): void {
  const terminalId = terminalBindingOf(
    findGroupTab(layoutKey, groupId, panelId),
  );
  if (terminalId) requestTerminalFocus(terminalId, ownerDocument);
}

/**
 * The terminal session currently bound to a panel, if any.
 *
 * Read live from the store rather than from a captured prop: a restored
 * session can bind a placeholder panel part-way through an async spawn, and a
 * stale read there spawns a duplicate PTY beside the one that just appeared.
 */
export function getTerminalPanelBinding(
  worktreeKey: string,
  panelId: string,
): string | undefined {
  const source = findTerminalPanelSource(worktreeKey, panelId);
  if (!source) return undefined;
  return terminalBindingOf(
    findGroupTab(source.layoutKey, source.groupId, panelId),
  );
}

/**
 * An explicit user reveal gesture — expanding a collapsed group, or selecting
 * a tab — on an UNBOUND terminal placeholder is itself the request for a
 * terminal: the second click on "Start terminal" carried no information.
 *
 * Gesture-only by design. Passive expands — `expandStaleCollapsesInWork`'s
 * repair after a topology edit, workspace restore, layout hydration —
 * deliberately never call this, so they can neither spawn a PTY nor take the
 * caret (CAN-2309). Bound panels are ignored for the same reason, which also
 * leaves an exited session's scrollback and Restart affordance intact.
 *
 * The spawn itself stays component-local: this only records a coalesced
 * `ensure` request that the mounted `TerminalPanelSurface` claims, because
 * only the mounted pane can measure spawn dimensions.
 *
 * The request carries the resolved `panelId`, so only the surface for the
 * panel the user actually revealed can claim it. Worktree+layout scoping
 * alone was not enough: a second, already-bound terminal panel in the same
 * layout is also an active claimant, and it would satisfy the request by
 * re-focusing itself — leaving the revealed tab unbound and the caret on an
 * unrelated terminal, non-deterministically by mount order.
 */
export function requestRevealedTerminalPanelSpawn(
  projectId: string,
  worktreeId: string,
  layoutKey: string,
  groupId: string,
  panelId?: string,
): void {
  const tab = findGroupTab(layoutKey, groupId, panelId);
  if (!tab || tab.kind !== 'terminal') return;
  if (tab.instance?.terminalId) return;
  requestTerminalSpawn({
    projectId,
    worktreeId,
    layoutKey,
    panelId: tab.panelId,
    mode: 'ensure',
    requestedAt: Date.now(),
  });
}

function validSourceLayoutKey(
  worktreeKey: string,
  source: TerminalPanelActivationSource | null | undefined,
): string | null {
  if (!source) return null;
  return isFamilyLayout(worktreeKey, source.layoutKey)
    ? source.layoutKey
    : null;
}

/**
 * Ensure a terminal panel is present. When `terminalId` is supplied, the
 * exact session is bound; otherwise the existing/unbound terminal panel is
 * merely revealed so its mounted surface can satisfy a shortcut spawn.
 */
export function ensureTerminalPanelVisible(
  worktreeKey: string,
  source?: TerminalPanelActivationSource | null,
  options: TerminalPanelActivationOptions = {},
): PanelInstanceLocation | null {
  const store = usePanelLayoutStore.getState();
  const focus = options.focus !== false;
  const terminalId = options.terminalId?.trim();
  const finalizeLocation = (
    location: PanelInstanceLocation,
  ): PanelInstanceLocation => {
    if (focus && terminalId && options.focusOwnerDocument) {
      requestTerminalFocus(terminalId, options.focusOwnerDocument);
    }
    return location;
  };
  const sourceLayoutKey = validSourceLayoutKey(worktreeKey, source);
  const sourceLayout = sourceLayoutKey
    ? store.layouts[sourceLayoutKey]
    : undefined;
  const sourceGroupId =
    sourceLayoutKey !== null && source && sourceLayout?.groups[source.groupId]
      ? source.groupId
      : null;
  const minimal = getWorkspaceLayoutMode(worktreeKey) === 'minimal';
  let minimalTargetGroupId: string | null = null;

  if (minimal && !terminalId) {
    minimalTargetGroupId = ensureMinimalDestination(worktreeKey, 'terminal');
  }
  if (terminalId) {
    const existing = findPanelByInstanceKey(
      worktreeKey,
      `terminal:${terminalId}`,
    );
    if (existing) {
      revealPanel(existing, { focus });
      return finalizeLocation(existing);
    }

    // Migrate the default/legacy placeholder in place. This keeps its group
    // geometry, collapsed edge, panel id, and saved-layout position.
    const placeholder = findPanelByInstanceKey(worktreeKey, 'terminal:');
    if (placeholder) {
      const replaced = store.replaceTab(
        placeholder.layoutKey,
        placeholder.groupId,
        placeholder.panelId,
        {
          panelId: placeholder.panelId,
          kind: 'terminal',
          ...(options.title ? { title: options.title } : {}),
          instance: { terminalId },
        },
      );
      if (replaced) {
        revealPanel(placeholder, { focus });
        return finalizeLocation(placeholder);
      }
    }
  } else {
    const existing = minimal
      ? minimalTargetGroupId === null
        ? null
        : findTerminalPanelInGroup(worktreeKey, minimalTargetGroupId)
      : ((sourceLayoutKey
          ? findAnyTerminalPanel(worktreeKey, sourceLayoutKey)
          : findPanelByInstanceKey(worktreeKey, 'terminal:')) ??
        (sourceLayoutKey ? null : findAnyTerminalPanel(worktreeKey)));
    if (existing) {
      revealPanel(existing, { focus });
      return existing;
    }
  }

  const existingTerminal = sourceLayoutKey
    ? findAnyTerminalPanel(worktreeKey, sourceLayoutKey)
    : findAnyTerminalPanel(worktreeKey);
  const layoutKey =
    existingTerminal?.layoutKey ?? sourceLayoutKey ?? worktreeKey;
  const layout = store.layouts[layoutKey];
  if (!layout) return null;

  if (minimal && minimalTargetGroupId === null) {
    minimalTargetGroupId = ensureMinimalDestination(worktreeKey, 'terminal');
  }

  // A user may close the final Bottom Drawer tab, which removes its leaf.
  // Reasserting the fixed Minimal topology recreates an unbound Terminal
  // placeholder; reuse (or bind) it instead of attempting to add a duplicate.
  if (minimalTargetGroupId !== null) {
    const placeholder = findPanelByInstanceKey(worktreeKey, 'terminal:');
    if (placeholder) {
      if (!terminalId) {
        revealPanel(placeholder, { focus });
        return placeholder;
      }
      const replaced = store.replaceTab(
        placeholder.layoutKey,
        placeholder.groupId,
        placeholder.panelId,
        {
          panelId: placeholder.panelId,
          kind: 'terminal',
          ...(options.title ? { title: options.title } : {}),
          instance: { terminalId },
        },
      );
      if (replaced) {
        revealPanel(placeholder, { focus });
        return finalizeLocation(placeholder);
      }
    }
  }

  const targetGroupId =
    (minimal ? minimalTargetGroupId : existingTerminal?.groupId) ??
    (sourceLayoutKey === layoutKey ? sourceGroupId : null) ??
    (layout.groups[DEFAULT_CHAT_GROUP_ID]
      ? DEFAULT_CHAT_GROUP_ID
      : layout.activeGroupId);
  if (targetGroupId === null) return null;

  const instance = terminalId ? { terminalId } : undefined;
  const panelId = terminalId ? terminalPanelIdFor(terminalId) : undefined;
  if (!minimal && focus && existingTerminal === null) {
    const newGroupId = store.splitGroup(layoutKey, targetGroupId, 'down', {
      kind: 'terminal',
      ...(panelId ? { panelId } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(instance ? { instance } : {}),
    });
    if (!newGroupId) return null;
    const createdPanelId =
      panelId ??
      usePanelLayoutStore.getState().layouts[layoutKey]?.groups[newGroupId]
        ?.activePanelId;
    return createdPanelId
      ? finalizeLocation({
          layoutKey,
          groupId: newGroupId,
          panelId: createdPanelId,
        })
      : null;
  }
  const added = store.addTab(layoutKey, targetGroupId, 'terminal', {
    ...(panelId ? { panelId } : {}),
    ...(options.title ? { title: options.title } : {}),
    ...(instance ? { instance } : {}),
    activate: focus,
  });
  if (!added) return null;
  const location = { layoutKey, groupId: targetGroupId, panelId: added };
  if (minimal) {
    removeMinimalDestinationProbe(worktreeKey, 'bottom');
    revealPanel(location, { focus });
  }
  return finalizeLocation(location);
}

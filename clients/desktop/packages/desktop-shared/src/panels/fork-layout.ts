import {
  migratePanelLayout,
  type ISerializedPanelEntry,
  type ISerializedPanelGrid,
  type ISerializedPanelNode,
  type SerializablePanelLayoutFile,
  type SerializedPoppedPanelWindow,
} from '@canopy/protocol/panels';

/** Destination tab data keyed by the source chat-store tab id. */
export interface ForkedPanelTabBinding {
  readonly destinationTabId: string;
  /** Present for file tabs, including files outside the source worktree. */
  readonly destinationFilePath?: string;
}

export interface ForkPanelLayoutOptions {
  /** Supplies collision-free ids for copied auxiliary panel windows. */
  readonly nextAuxWindowId?: (sourceWindowId: string) => string;
}

function remapPanel(
  panel: ISerializedPanelEntry,
  tabBindings: ReadonlyMap<string, ForkedPanelTabBinding>,
): ISerializedPanelEntry | null {
  if (panel.kind === 'chat') {
    const sourceTabId = panel.instance?.chatTabId;
    const binding = sourceTabId ? tabBindings.get(sourceTabId) : undefined;
    if (!binding) return null;
    return {
      ...panel,
      panelId: `panel-chat-${binding.destinationTabId}`,
      instance: {
        ...panel.instance,
        chatTabId: binding.destinationTabId,
      },
    };
  }

  if (panel.kind === 'file-diff') {
    const sourceTabId = panel.instance?.fileTabId;
    const binding = sourceTabId ? tabBindings.get(sourceTabId) : undefined;
    if (!binding) return null;
    return {
      ...panel,
      panelId: `panel-file-${binding.destinationTabId}`,
      instance: {
        ...panel.instance,
        fileTabId: binding.destinationTabId,
        ...(binding.destinationFilePath
          ? { filePath: binding.destinationFilePath }
          : {}),
      },
    };
  }

  // Browser sessions are persisted per worktree, so copying their panel
  // binding would point the destination at a session that only exists in the
  // source worktree.
  if (panel.kind === 'browser') return null;

  // A pipeline run belongs to the worktree that executed it; a fork starts
  // with no runs, so carrying the tab would show another worktree's run.
  if (panel.kind === 'pipeline-execution') return null;

  // A subagent chat binds a root chat and subagent from the source worktree;
  // the destination has neither binding. The unbound Subagents singleton
  // remains portable like File Explorer.
  if (panel.kind === 'subagent-chat') return null;

  // Tracked plans are worktree-local and a fork does not copy them, so a plan
  // panel would bind the destination to a plan it does not have.
  if (panel.kind === 'plan' || panel.kind === 'plan-diagram') return null;

  return structuredClone(panel);
}

function remapNode(
  node: ISerializedPanelNode,
  tabBindings: ReadonlyMap<string, ForkedPanelTabBinding>,
): ISerializedPanelNode {
  if (node.type === 'branch') {
    return {
      ...node,
      children: node.children.map((child) => remapNode(child, tabBindings)),
    };
  }

  const panelIdMap = new Map<string, string>();
  const panels = node.panels.flatMap((panel) => {
    const remapped = remapPanel(panel, tabBindings);
    if (!remapped) return [];
    panelIdMap.set(panel.panelId, remapped.panelId);
    return [remapped];
  });
  return {
    ...node,
    panels,
    activePanelId:
      (node.activePanelId ? panelIdMap.get(node.activePanelId) : undefined) ??
      panels[0]?.panelId ??
      null,
  };
}

function remapGrid(
  grid: ISerializedPanelGrid,
  tabBindings: ReadonlyMap<string, ForkedPanelTabBinding>,
): ISerializedPanelGrid {
  return {
    ...grid,
    root: remapNode(grid.root, tabBindings),
  };
}

function nodeHasPanels(node: ISerializedPanelNode): boolean {
  return node.type === 'leaf'
    ? node.panels.length > 0
    : node.children.some(nodeHasPanels);
}

function remapPoppedOut(
  poppedOut: readonly SerializedPoppedPanelWindow[],
  tabBindings: ReadonlyMap<string, ForkedPanelTabBinding>,
  options: ForkPanelLayoutOptions,
): SerializedPoppedPanelWindow[] {
  return poppedOut.flatMap((entry) => {
    const grid = remapGrid(entry.grid, tabBindings);
    // Restoring a window left without panels would open an empty OS window.
    if (!nodeHasPanels(grid.root)) return [];
    return [
      {
        ...entry,
        windowId: options.nextAuxWindowId?.(entry.windowId) ?? entry.windowId,
        grid,
      },
    ];
  });
}

/**
 * Copies a persisted panel layout while rebinding chat/file panels to the
 * freshly forked destination tabs. Grid topology, group ids/sizes, group tab
 * order, active selections, collapse/maximize state, and MRU order are kept.
 * Bound panels whose source tab is no longer live are omitted, as are Browser,
 * plan, and subagent-chat panels (their bindings stay with the source
 * worktree). The unbound Subagents panel carries over.
 * A popped-out window left without panels is omitted too, and `poppedOut` is
 * dropped when no window remains.
 */
export function forkPanelLayoutForTabs(
  source: unknown,
  tabBindings: ReadonlyMap<string, ForkedPanelTabBinding>,
  options: ForkPanelLayoutOptions = {},
): SerializablePanelLayoutFile | null {
  const migrated = migratePanelLayout(source);
  if (!migrated) return null;

  const { poppedOut: sourcePoppedOut, ...rest } = migrated;
  const poppedOut = sourcePoppedOut
    ? remapPoppedOut(sourcePoppedOut, tabBindings, options)
    : [];
  return {
    ...rest,
    grid: remapGrid(migrated.grid, tabBindings),
    ...(poppedOut.length > 0 ? { poppedOut } : {}),
  };
}

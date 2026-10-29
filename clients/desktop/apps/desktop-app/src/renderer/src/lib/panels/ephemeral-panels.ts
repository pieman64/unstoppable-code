import type {
  ISerializedPanelGrid,
  ISerializedPanelNode,
  SerializablePanelLayoutFile,
  SerializedPoppedPanelWindow,
} from '@canopy/protocol';

/**
 * A New tab is only a picker, so it is never saved: a saved layout holding a
 * kind an older build does not know fails to load there, and that build
 * would fall back to its default layout. Under early access, an emptied Side
 * Panel gets a fresh New tab again when the layout loads.
 */
function isEphemeralPanelKind(kind: string): boolean {
  return kind === 'new-tab';
}

function stripNode(node: ISerializedPanelNode): ISerializedPanelNode {
  if (node.type === 'branch') {
    const children = node.children.map(stripNode);
    return children.every((child, index) => child === node.children[index])
      ? node
      : { ...node, children };
  }
  const panels = node.panels.filter(
    (panel) => !isEphemeralPanelKind(panel.kind),
  );
  if (panels.length === node.panels.length) return node;
  const activePanelId = panels.some(
    (panel) => panel.panelId === node.activePanelId,
  )
    ? node.activePanelId
    : (panels[0]?.panelId ?? null);
  return { ...node, panels, activePanelId };
}

function stripGrid(grid: ISerializedPanelGrid): ISerializedPanelGrid {
  const root = stripNode(grid.root);
  return root === grid.root ? grid : { ...grid, root };
}

function nodeHasPanels(node: ISerializedPanelNode): boolean {
  return node.type === 'leaf'
    ? node.panels.length > 0
    : node.children.some(nodeHasPanels);
}

/**
 * Returns `file` without its New tab panels (main grid and popped-out
 * windows). A leaf whose active tab was a New tab activates its first
 * remaining tab; a popped-out window left with no panels is dropped. Returns
 * the same reference when there was nothing to strip.
 */
export function withoutEphemeralPanels(
  file: SerializablePanelLayoutFile,
): SerializablePanelLayoutFile {
  const grid = stripGrid(file.grid);
  let poppedOut = file.poppedOut;
  if (poppedOut !== undefined) {
    const windows: SerializedPoppedPanelWindow[] = [];
    let changed = false;
    for (const entry of poppedOut) {
      const entryGrid = stripGrid(entry.grid);
      if (entryGrid === entry.grid) {
        windows.push(entry);
        continue;
      }
      changed = true;
      if (nodeHasPanels(entryGrid.root)) {
        windows.push({ ...entry, grid: entryGrid });
      }
    }
    if (changed) poppedOut = windows;
  }
  if (grid === file.grid && poppedOut === file.poppedOut) return file;
  return {
    ...file,
    grid,
    ...(poppedOut !== undefined ? { poppedOut } : {}),
  };
}

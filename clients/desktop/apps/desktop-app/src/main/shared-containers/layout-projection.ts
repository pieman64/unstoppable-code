import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type BrowserSessionSnapshot,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  migratePanelLayout,
  type ISerializedPanelEntry,
  type ISerializedPanelNode,
  type SerializablePanelLayoutFile,
} from '@canopy/protocol/panels';
import type {
  SharedContainerPublishedLayout,
  SharedContainerPublishedPanel,
  SharedContainerStartPage,
} from '@canopy/protocol/shared-containers';
import {
  loadWorktreeBrowserState,
  saveWorktreeBrowserState,
} from '../browser/browser-persistence';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { panelLayoutPersistenceStore } from '../panels/persistence';
import type { SharedContainerViewerReadRoot } from './read/viewer-root';

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function stableUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

interface ProjectionContext {
  containerId: string;
  roots: ReadonlyMap<string, SharedContainerViewerReadRoot>;
  publishedPathsByRepo: ReadonlyMap<string, ReadonlySet<string>>;
  chatIds: ReadonlySet<string>;
  fileTabs: Map<string, PersistedChatTab>;
  browsers: Map<string, BrowserSessionSnapshot>;
  activeBrowserIds: string[];
  nextPanel: number;
  nextGroup: number;
  nextBrowser: number;
}

type SharedContainerViewerPublishedPanelNode =
  | {
      type: 'leaf';
      size: number;
      tabs: SharedContainerPublishedPanel[];
      activeTabIndex: number;
    }
  | {
      type: 'branch';
      size: number;
      children: SharedContainerViewerPublishedPanelNode[];
    };

export interface SharedContainerViewerPublishedLayout {
  orientation: 0 | 1;
  root: SharedContainerViewerPublishedPanelNode;
}

export function createSharedContainerStartPageLayout(
  startPage: SharedContainerStartPage,
): SharedContainerViewerPublishedLayout {
  const panel: SharedContainerPublishedPanel =
    startPage.kind === 'url'
      ? { kind: 'browser', url: startPage.url }
      : /\.html?$/i.test(startPage.relativePath)
        ? {
            kind: 'browser',
            repoId: startPage.repoId,
            relativePath: startPage.relativePath,
          }
        : {
            kind: 'file',
            repoId: startPage.repoId,
            relativePath: startPage.relativePath,
            viewMode: 'rich',
          };
  return {
    orientation: 0,
    root: {
      type: 'leaf',
      size: 1,
      tabs: [panel],
      activeTabIndex: 0,
    },
  };
}

function absolutePublishedPath(
  panel: { repoId: string; relativePath: string },
  context: ProjectionContext,
): string | null {
  const root = context.roots.get(panel.repoId);
  return root &&
    context.publishedPathsByRepo.get(panel.repoId)?.has(panel.relativePath)
    ? resolve(root.absolutePath, panel.relativePath)
    : null;
}

function fileTabFor(
  panel: Extract<SharedContainerPublishedPanel, { kind: 'file' | 'file-diff' }>,
  context: ProjectionContext,
): PersistedChatTab | null {
  const filePath = absolutePublishedPath(panel, context);
  if (!filePath) return null;
  const key = `${panel.repoId}\0${panel.relativePath}\0${panel.kind}`;
  const existing = context.fileTabs.get(key);
  if (existing) return existing;
  const tab: PersistedChatTab = {
    id: stableId('shared-file', `${context.containerId}\0${key}`),
    title: basename(panel.relativePath),
    messages: [],
    createdAt: new Date(0).toISOString(),
    kind: 'file',
    filePath,
    fileViewMode:
      panel.kind === 'file-diff'
        ? 'diff'
        : panel.viewMode === 'rich'
          ? 'preview'
          : 'raw',
    ...(panel.kind === 'file-diff'
      ? {
          fileDiffContext: {
            path: panel.relativePath,
            repoId: panel.repoId,
            source: 'combined' as const,
          },
        }
      : {}),
    readOnly: true,
  };
  context.fileTabs.set(key, tab);
  return tab;
}

function localPanel(
  panel: SharedContainerPublishedPanel,
  context: ProjectionContext,
): ISerializedPanelEntry | null {
  const panelId = stableId(
    'shared-panel',
    `${context.containerId}\0${context.nextPanel++}`,
  );
  if (panel.kind === 'chat') {
    return context.chatIds.has(panel.chatId)
      ? { panelId, kind: 'chat', instance: { chatTabId: panel.chatId } }
      : null;
  }
  if (panel.kind === 'file' || panel.kind === 'file-diff') {
    const tab = fileTabFor(panel, context);
    if (!tab) return null;
    // The renderer binds every file tab, diff or not, through a `file-diff`
    // panel (`chat-panel-binding.ts`); the tab's own view mode decides what it
    // shows. A `chat` panel here would render the file as a stray chat tab
    // beside the file panel the renderer adds for it.
    return {
      panelId,
      kind: 'file-diff',
      instance: { fileTabId: tab.id, filePath: tab.filePath ?? '' },
    };
  }
  if (panel.kind === 'browser') {
    if ('url' in panel) {
      const browserId = stableUuid(
        `${context.containerId}\0${context.nextBrowser++}\0${panel.url}`,
      );
      context.browsers.set(browserId, {
        id: browserId,
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: context.containerId,
        createdAt: 0,
        updatedAt: 0,
        url: panel.url,
        title: panel.url,
        status: 'idle',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        themeMode: 'light',
        pickMode: false,
        recording: false,
      });
      return { panelId, kind: 'browser', instance: { browserId } };
    }
    const filePath = absolutePublishedPath(panel, context);
    if (!filePath) return null;
    // Each publisher browser tab is its own session, even when two show the
    // same file. A path-derived id would bind both tabs to one session, and
    // the renderer keeps one panel per session, dropping the other tab.
    const browserId = stableUuid(
      `${context.containerId}\0${context.nextBrowser++}\0${panel.repoId}\0${panel.relativePath}`,
    );
    context.browsers.set(browserId, {
      id: browserId,
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: context.containerId,
      createdAt: 0,
      updatedAt: 0,
      url: pathToFileURL(filePath).href,
      title: basename(panel.relativePath),
      status: 'idle',
      canGoBack: false,
      canGoForward: false,
      loading: false,
      themeMode: 'light',
      pickMode: false,
      recording: false,
    });
    return { panelId, kind: 'browser', instance: { browserId } };
  }
  if (panel.kind === 'activity-card') {
    return {
      panelId,
      kind: 'activity-card',
      instance: { sectionId: panel.sectionId },
    };
  }
  // The recipient panel allowlist (renderer `panel-allowlist.ts`) does not
  // mount the change diagram, which reads live git state the replica lacks.
  // Dropping it here keeps the applied layout free of a tab the renderer
  // would immediately refuse and close.
  if (panel.kind === 'change-diagram') return null;
  return { panelId, kind: panel.kind };
}

function localNode(
  node: SharedContainerViewerPublishedPanelNode,
  context: ProjectionContext,
): ISerializedPanelNode | null {
  if (node.type === 'branch') {
    const children = node.children
      .map((child) => localNode(child, context))
      .filter((child): child is ISerializedPanelNode => !!child);
    return children.length > 0
      ? { type: 'branch', size: node.size, children }
      : null;
  }
  const projected = node.tabs.map((panel) => localPanel(panel, context));
  const panels = projected.filter(
    (panel): panel is ISerializedPanelEntry => !!panel,
  );
  const firstPanel = panels[0];
  if (!firstPanel) return null;
  // `activeTabIndex` indexes the publisher's tabs, so resolve it before
  // dropped tabs shift the list. A dropped active tab falls back to the
  // nearest earlier survivor, then the first.
  const activeIndex = Math.min(node.activeTabIndex, projected.length - 1);
  const activePanel =
    projected
      .slice(0, activeIndex + 1)
      .reverse()
      .find((panel): panel is ISerializedPanelEntry => !!panel) ?? firstPanel;
  const activePanelId = activePanel.panelId;
  if (activePanel.kind === 'browser' && activePanel.instance?.browserId) {
    context.activeBrowserIds.push(activePanel.instance.browserId);
  }
  return {
    type: 'leaf',
    groupId: stableId(
      'shared-group',
      `${context.containerId}\0${context.nextGroup++}`,
    ),
    panels,
    activePanelId,
    size: node.size,
  };
}

/** Every repository file a published layout names, in layout order. */
export function listSharedContainerPublishedLayoutFiles(
  layout:
    | SharedContainerPublishedLayout
    | SharedContainerViewerPublishedLayout
    | undefined,
): Array<{ repoId: string; relativePath: string }> {
  const files: Array<{ repoId: string; relativePath: string }> = [];
  const visit = (node: SharedContainerViewerPublishedPanelNode): void => {
    if (node.type === 'branch') {
      node.children.forEach(visit);
      return;
    }
    for (const panel of node.tabs) {
      if (
        panel.kind === 'file' ||
        panel.kind === 'file-diff' ||
        (panel.kind === 'browser' && !('url' in panel))
      ) {
        files.push({ repoId: panel.repoId, relativePath: panel.relativePath });
      }
    }
  };
  if (layout) visit(layout.root);
  return files;
}

/**
 * `seed` applies a layout only when the viewer has none, so recipient-local
 * changes win thereafter. `reset` replaces the viewer's layout and browser
 * state with the projected one; it is used when the recipient opens a share
 * whose revision carries the publisher's preferred layout.
 */
export type SharedContainerViewerLayoutMode = 'seed' | 'reset';

interface AppliedSharedContainerViewerLayout {
  fileTabs: PersistedChatTab[];
  applied: boolean;
  /** The chat or file tab behind the applied layout's active panel, if any. */
  activeTabId?: string;
  rollback: () => Promise<void>;
}

const EMPTY_APPLIED_LAYOUT: AppliedSharedContainerViewerLayout = {
  fileTabs: [],
  applied: false,
  rollback: () => Promise.resolve(),
};

function findLeaf(
  node: ISerializedPanelNode,
  groupId: string,
): Extract<ISerializedPanelNode, { type: 'leaf' }> | null {
  if (node.type === 'leaf') return node.groupId === groupId ? node : null;
  for (const child of node.children) {
    const leaf = findLeaf(child, groupId);
    if (leaf) return leaf;
  }
  return null;
}

/**
 * Apply a published layout to the viewer.
 *
 * In `seed` mode (the default) an existing recipient layout is left alone. In
 * `reset` mode the projected layout replaces it, and browser state is always
 * rewritten so the recipient's own browser sessions do not survive. A layout
 * that projects to no panels applies nothing in either mode.
 */
export async function applyInitialSharedContainerViewerLayout(input: {
  containerId: string;
  mode?: SharedContainerViewerLayoutMode;
  layout:
    | SharedContainerPublishedLayout
    | SharedContainerViewerPublishedLayout
    | undefined;
  roots: readonly SharedContainerViewerReadRoot[];
  publishedPathsByRepo: ReadonlyMap<string, ReadonlySet<string>>;
  chatIds: ReadonlySet<string>;
  /**
   * Stops the viewer's live browser sessions before a reset writes its
   * browser state. Without it the browser service merges the recipient's own
   * sessions back in on the next load, and they survive the reset.
   */
  stopViewerBrowsers?: (containerId: string) => Promise<void>;
}): Promise<AppliedSharedContainerViewerLayout> {
  const reset = input.mode === 'reset';
  const localLayoutFile = panelLayoutPersistenceStore.loadWorktreeLayout(
    SHARED_CONTAINER_VIEWER_PROJECT_ID,
    input.containerId,
  );
  if (!input.layout || (!reset && localLayoutFile !== null)) {
    return EMPTY_APPLIED_LAYOUT;
  }
  const previousLayout = reset ? migratePanelLayout(localLayoutFile) : null;
  const context: ProjectionContext = {
    containerId: input.containerId,
    roots: new Map(input.roots.map((root) => [root.repoId, root])),
    publishedPathsByRepo: input.publishedPathsByRepo,
    chatIds: input.chatIds,
    fileTabs: new Map(),
    browsers: new Map(),
    activeBrowserIds: [],
    nextPanel: 0,
    nextGroup: 0,
    nextBrowser: 0,
  };
  const root = localNode(input.layout.root, context);
  if (!root) return EMPTY_APPLIED_LAYOUT;
  const firstLeaf = (node: ISerializedPanelNode): string =>
    node.type === 'leaf' ? node.groupId : firstLeaf(node.children[0]);
  const activeGroupId = firstLeaf(root);
  const localLayout: SerializablePanelLayoutFile = {
    version: 1,
    grid: {
      orientation: input.layout.orientation,
      root,
      width: 1200,
      height: 800,
    },
    activeGroupId,
    mostRecentActiveGroupIds: [activeGroupId],
  };
  // Captured before any write: a failed reset restores what the recipient
  // had rather than leaving them with no layout.
  const previousBrowserState = reset
    ? loadWorktreeBrowserState(
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
        input.containerId,
      ).state
    : null;
  const restoreLayout = (): void => {
    if (previousLayout) {
      panelLayoutPersistenceStore.saveWorktreeLayout(
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
        input.containerId,
        previousLayout,
      );
      return;
    }
    panelLayoutPersistenceStore.deleteWorktreeLayout(
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
      input.containerId,
    );
  };
  const rollback = async (): Promise<void> => {
    restoreLayout();
    if (!reset) return;
    await saveWorktreeBrowserState({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: input.containerId,
      state: previousBrowserState ?? {
        version: 2,
        browsers: [],
        browserOrder: [],
        activeBrowserId: null,
      },
    });
  };
  // Preserve the established first-open timing: the renderer can ask for its
  // layout as soon as replica open settles. This save is provisional until
  // browser state and canonical chat projection both succeed.
  panelLayoutPersistenceStore.saveWorktreeLayout(
    SHARED_CONTAINER_VIEWER_PROJECT_ID,
    input.containerId,
    localLayout,
  );
  try {
    if (reset && input.stopViewerBrowsers) {
      // Best effort: a browser that will not stop must not fail the open. The
      // live sessions it does stop are not brought back by a rollback, which
      // restores only the persisted browser state.
      await input
        .stopViewerBrowsers(input.containerId)
        .catch((error: unknown) =>
          logMainProcessWarn(
            '[shared-containers] failed to stop the viewer browsers',
            error,
          ),
        );
    }
    if (reset || context.browsers.size > 0) {
      await saveWorktreeBrowserState({
        projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: input.containerId,
        state: {
          version: 2,
          browsers: Array.from(context.browsers.values()),
          browserOrder: Array.from(context.browsers.keys()),
          activeBrowserId:
            context.activeBrowserIds[0] ??
            context.browsers.keys().next().value ??
            null,
        },
      });
    }
  } catch (error) {
    // Stopping the viewer's browsers may already have emptied the browser
    // state, so a reset restores it along with the provisional layout.
    await rollback().catch((rollbackError: unknown) =>
      logMainProcessWarn(
        '[shared-containers] failed to restore the viewer layout',
        rollbackError,
      ),
    );
    throw error;
  }
  const activeLeaf = findLeaf(root, activeGroupId);
  const activePanel = activeLeaf?.panels.find(
    (panel) => panel.panelId === activeLeaf.activePanelId,
  );
  const activeTabId =
    activePanel?.kind === 'chat'
      ? activePanel.instance?.chatTabId
      : activePanel?.kind === 'file-diff'
        ? activePanel.instance?.fileTabId
        : undefined;
  return {
    fileTabs: Array.from(context.fileTabs.values()),
    applied: true,
    ...(activeTabId ? { activeTabId } : {}),
    rollback,
  };
}

/** Keep local file-diff bindings pointed at the promoted replica revision. */
export function repointSharedContainerViewerLayoutFileBindings(
  containerId: string,
  tabs: readonly PersistedChatTab[],
): void {
  const layout = migratePanelLayout(
    panelLayoutPersistenceStore.loadWorktreeLayout(
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
      containerId,
    ),
  );
  if (!layout) return;
  const filePathByTabId = new Map(
    tabs.flatMap((tab) =>
      tab.kind === 'file' && tab.filePath ? [[tab.id, tab.filePath]] : [],
    ),
  );
  let changed = false;
  const repointNode = (node: ISerializedPanelNode): ISerializedPanelNode => {
    if (node.type === 'branch') {
      return { ...node, children: node.children.map(repointNode) };
    }
    return {
      ...node,
      panels: node.panels.map((panel) => {
        if (panel.kind !== 'file-diff' || !panel.instance?.fileTabId) {
          return panel;
        }
        const filePath = filePathByTabId.get(panel.instance.fileTabId);
        if (!filePath || panel.instance.filePath === filePath) return panel;
        changed = true;
        return { ...panel, instance: { ...panel.instance, filePath } };
      }),
    };
  };
  const root = repointNode(layout.grid.root);
  if (!changed) return;
  panelLayoutPersistenceStore.saveWorktreeLayout(
    SHARED_CONTAINER_VIEWER_PROJECT_ID,
    containerId,
    { ...layout, grid: { ...layout.grid, root } },
  );
}

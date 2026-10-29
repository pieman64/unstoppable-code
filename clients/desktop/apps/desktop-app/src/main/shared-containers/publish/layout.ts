import type {
  BrowserSessionSnapshot,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  migratePanelLayout,
  type ISerializedPanelEntry,
  type ISerializedPanelNode,
} from '@canopy/protocol/panels';
import {
  isSharedContainerWebPageUrl,
  type SharedContainerPublishedLayout,
  type SharedContainerPublishedPanel,
  type SharedContainerPublishedPanelNode,
} from '@canopy/protocol/shared-containers';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import {
  pinSharedContainerPreferredLayoutIfMissing,
  readSharedContainerPreferredLayoutSnapshot,
} from '../file-scope-store';

/** The part of a browser session the sanitizer reads. */
type PublishedLayoutBrowser = Pick<BrowserSessionSnapshot, 'id' | 'url'>;

export interface PublishedLayoutRoot {
  repoId: string;
  absolutePath: string;
  publishedPaths: ReadonlySet<string>;
}

function publishedFile(
  absolutePath: string,
  roots: readonly PublishedLayoutRoot[],
): { repoId: string; relativePath: string } | null {
  if (!isAbsolute(absolutePath)) return null;
  const target = resolve(absolutePath);
  for (const root of roots) {
    const candidate = relative(resolve(root.absolutePath), target);
    if (
      candidate === '..' ||
      candidate.startsWith(`..${sep}`) ||
      isAbsolute(candidate)
    ) {
      continue;
    }
    const relativePath = candidate.split(sep).join('/');
    if (root.publishedPaths.has(relativePath)) {
      return { repoId: root.repoId, relativePath };
    }
  }
  return null;
}

function panelForFileTab(
  tab: PersistedChatTab,
  roots: readonly PublishedLayoutRoot[],
): SharedContainerPublishedPanel | null {
  const file = tab.filePath ? publishedFile(tab.filePath, roots) : null;
  if (!file) return null;
  const kind =
    tab.fileDiffContext || tab.fileViewMode === 'diff' ? 'file-diff' : 'file';
  const viewMode =
    kind === 'file-diff'
      ? 'diff'
      : tab.fileViewMode === 'preview' || tab.fileViewMode === 'table'
        ? 'rich'
        : 'raw';
  return { kind, ...file, viewMode };
}

function panelForEntry(
  entry: ISerializedPanelEntry,
  tabsById: ReadonlyMap<string, PersistedChatTab>,
  publishedChatIds: ReadonlySet<string>,
  roots: readonly PublishedLayoutRoot[],
  browsersById: ReadonlyMap<string, PublishedLayoutBrowser>,
): SharedContainerPublishedPanel | null {
  if (entry.kind === 'chat') {
    const tabId = entry.instance?.chatTabId;
    const tab = tabId ? tabsById.get(tabId) : undefined;
    if (!tab) return null;
    if (tab.kind !== 'file') {
      return publishedChatIds.has(tab.id)
        ? { kind: 'chat', chatId: tab.id }
        : null;
    }
    return panelForFileTab(tab, roots);
  }
  if (entry.kind === 'file-diff') {
    // Every file tab, diff or not, is bound through a `file-diff` panel, so
    // the bound tab says whether the publisher was reading or diffing it.
    const fileTabId = entry.instance?.fileTabId;
    const tab = fileTabId ? tabsById.get(fileTabId) : undefined;
    if (tab?.kind === 'file') return panelForFileTab(tab, roots);
    const filePath = entry.instance?.filePath;
    const file = filePath ? publishedFile(filePath, roots) : null;
    return file ? { kind: 'file-diff', ...file, viewMode: 'diff' } : null;
  }
  if (entry.kind === 'browser') {
    const browserId = entry.instance?.browserId;
    const browser = browserId ? browsersById.get(browserId) : undefined;
    if (!browser) return null;
    // Web pages, including localhost, ship as their URL. Receivers open the
    // same address, so a local dev server shows only on their own machine.
    if (isSharedContainerWebPageUrl(browser.url)) {
      return { kind: 'browser', url: browser.url };
    }
    if (!browser.url.startsWith('file:')) return null;
    let filePath: string;
    try {
      filePath = fileURLToPath(browser.url);
    } catch {
      return null;
    }
    const file = publishedFile(filePath, roots);
    return file ? { kind: 'browser', ...file } : null;
  }
  if (entry.kind === 'activity-card') {
    const sectionId = entry.instance?.sectionId;
    return sectionId ? { kind: 'activity-card', sectionId } : null;
  }
  if (
    entry.kind === 'file-explorer' ||
    entry.kind === 'activity-section' ||
    entry.kind === 'change-diagram'
  ) {
    return { kind: entry.kind };
  }
  return null;
}

function sanitizeNode(
  node: ISerializedPanelNode,
  tabsById: ReadonlyMap<string, PersistedChatTab>,
  publishedChatIds: ReadonlySet<string>,
  roots: readonly PublishedLayoutRoot[],
  browsersById: ReadonlyMap<string, PublishedLayoutBrowser>,
): SharedContainerPublishedPanelNode | null {
  if (node.type === 'branch') {
    const children = node.children
      .map((child) =>
        sanitizeNode(child, tabsById, publishedChatIds, roots, browsersById),
      )
      .filter((child): child is SharedContainerPublishedPanelNode => !!child);
    return children.length > 0
      ? { type: 'branch', size: node.size, children }
      : null;
  }
  const retained = node.panels
    .map((entry) => ({
      panelId: entry.panelId,
      panel: panelForEntry(
        entry,
        tabsById,
        publishedChatIds,
        roots,
        browsersById,
      ),
    }))
    .filter(
      (
        entry,
      ): entry is { panelId: string; panel: SharedContainerPublishedPanel } =>
        !!entry.panel,
    );
  if (retained.length === 0) return null;
  const activePanelIndex = retained.findIndex(
    ({ panelId }) => panelId === node.activePanelId,
  );
  return {
    type: 'leaf',
    size: node.size,
    tabs: retained.map(({ panel }) => panel),
    activeTabIndex: activePanelIndex < 0 ? 0 : activePanelIndex,
  };
}

export function sanitizeSharedContainerPublishedLayout(input: {
  layout: unknown;
  tabs: readonly PersistedChatTab[];
  publishedChatIds: ReadonlySet<string>;
  roots: readonly PublishedLayoutRoot[];
  browsers?: readonly PublishedLayoutBrowser[];
}): SharedContainerPublishedLayout | undefined {
  const layout = migratePanelLayout(input.layout);
  if (!layout) return undefined;
  const root = sanitizeNode(
    layout.grid.root,
    new Map(input.tabs.map((tab) => [tab.id, tab])),
    input.publishedChatIds,
    input.roots,
    new Map((input.browsers ?? []).map((browser) => [browser.id, browser])),
  );
  return root ? { orientation: layout.grid.orientation, root } : undefined;
}

/**
 * The layout a revision ships: the publisher's pinned preferred layout,
 * sanitized against what this revision publishes. Never the live layout.
 *
 * Returns `undefined`, so the revision ships without `layout`, when the
 * preferred layout is off, when there is no local layout to pin, or when
 * every pinned panel has left the published set. Sanitizing at each publish
 * keeps the pin valid as chats and files leave the published set; the pin
 * itself stays in place.
 */
export async function readSanitizedSharedContainerPublishedLayout(input: {
  projectId: string;
  worktreeId: string;
  tabs: readonly PersistedChatTab[];
  publishedChatIds: ReadonlySet<string>;
  roots: readonly PublishedLayoutRoot[];
}): Promise<SharedContainerPublishedLayout | undefined> {
  // Pin first (a no-op when off or already pinned), which covers a share at
  // its first publish after the upgrade. Then read the snapshot back: a scope
  // save that turned the layout off after the pin wins, because the snapshot
  // read returns nothing once the scope is off.
  // The layout is optional, so a failed pin must not fail the publish: ship
  // whatever snapshot is already there.
  try {
    await pinSharedContainerPreferredLayoutIfMissing(
      input.projectId,
      input.worktreeId,
    );
  } catch (error) {
    logMainProcessWarn(
      '[shared-containers] failed to pin the preferred layout',
      error,
    );
  }
  // An unreadable scope file does fail the publish here, as it does for the
  // scope read that decides what the revision shares.
  const snapshot = await readSharedContainerPreferredLayoutSnapshot(
    input.projectId,
    input.worktreeId,
  );
  if (!snapshot) return undefined;
  return sanitizeSharedContainerPublishedLayout({
    ...input,
    layout: snapshot.layout,
    browsers: snapshot.browsers,
  });
}

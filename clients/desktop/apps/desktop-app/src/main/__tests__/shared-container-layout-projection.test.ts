import type {
  ISerializedPanelEntry,
  ISerializedPanelNode,
  SerializablePanelLayoutFile,
} from '@canopy/protocol/panels';
import type { SharedContainerPublishedLayout } from '@canopy/protocol/shared-containers';
import type { PersistedWorktreeBrowserStateFile } from '@canopy/desktop-shared/types';

const savedLayouts = new Map<string, SerializablePanelLayoutFile>();
const savedBrowserStates: PersistedWorktreeBrowserStateFile[] = [];

jest.mock('../panels/persistence', () => ({
  panelLayoutPersistenceStore: {
    loadWorktreeLayout: (_projectId: string, worktreeId: string): unknown =>
      savedLayouts.get(worktreeId) ?? null,
    saveWorktreeLayout: (
      _projectId: string,
      worktreeId: string,
      layout: SerializablePanelLayoutFile,
    ): void => {
      savedLayouts.set(worktreeId, layout);
    },
    deleteWorktreeLayout: (_projectId: string, worktreeId: string): void => {
      savedLayouts.delete(worktreeId);
    },
  },
}));

let failNextBrowserSave = false;

jest.mock('../browser/browser-persistence', () => ({
  loadWorktreeBrowserState: (): {
    state: PersistedWorktreeBrowserStateFile | null;
  } => ({ state: savedBrowserStates[savedBrowserStates.length - 1] ?? null }),
  saveWorktreeBrowserState: (input: {
    state: PersistedWorktreeBrowserStateFile;
  }): Promise<void> => {
    if (failNextBrowserSave) {
      failNextBrowserSave = false;
      return Promise.reject(new Error('browser save failed'));
    }
    savedBrowserStates.push(input.state);
    return Promise.resolve();
  },
}));

import {
  applyInitialSharedContainerViewerLayout,
  createSharedContainerStartPageLayout,
} from '../shared-containers/layout-projection';

const CONTAINER_ID = 'container-1';
const PAGE = 'site/index.html';

function onlyLeaf(
  layout: SerializablePanelLayoutFile | undefined,
): Extract<ISerializedPanelNode, { type: 'leaf' }> {
  const root = layout?.grid.root;
  if (root?.type !== 'leaf') throw new Error('expected a single leaf');
  return root;
}

function activePanel(
  leaf: Extract<ISerializedPanelNode, { type: 'leaf' }>,
): ISerializedPanelEntry | undefined {
  return leaf.panels.find((panel) => panel.panelId === leaf.activePanelId);
}

async function apply(layout: SharedContainerPublishedLayout): Promise<void> {
  await applyInitialSharedContainerViewerLayout({
    containerId: CONTAINER_ID,
    layout,
    roots: [
      {
        repoId: 'workspace',
        repoName: 'Workspace',
        absolutePath: '/replica/content',
        revisionRoot: '/replica',
        revisionId: 'revision-1',
      },
    ],
    publishedPathsByRepo: new Map([['workspace', new Set([PAGE])]]),
    chatIds: new Set(['chat-1']),
  });
}

describe('shared-container recipient layout projection', () => {
  beforeEach(() => {
    savedLayouts.clear();
    savedBrowserStates.length = 0;
    failNextBrowserSave = false;
  });

  it('keeps each publisher browser tab and opens on the one left active', async () => {
    await apply({
      orientation: 0,
      root: {
        type: 'leaf',
        size: 1,
        tabs: [
          { kind: 'chat', chatId: 'chat-1' },
          { kind: 'browser', repoId: 'workspace', relativePath: PAGE },
          {
            kind: 'file-diff',
            repoId: 'workspace',
            relativePath: PAGE,
            viewMode: 'diff',
          },
          { kind: 'browser', repoId: 'workspace', relativePath: PAGE },
        ],
        activeTabIndex: 3,
      },
    });

    const leaf = onlyLeaf(savedLayouts.get(CONTAINER_ID));
    const browserIds = leaf.panels.flatMap((panel) =>
      panel.kind === 'browser' && panel.instance?.browserId
        ? [panel.instance.browserId]
        : [],
    );
    expect(browserIds).toHaveLength(2);
    expect(new Set(browserIds).size).toBe(2);
    expect(activePanel(leaf)).toMatchObject({
      kind: 'browser',
      instance: { browserId: browserIds[1] },
    });

    const [browserState] = savedBrowserStates;
    expect(browserState?.browserOrder).toEqual(browserIds);
    expect(browserState?.activeBrowserId).toBe(browserIds[1]);
    expect(browserState?.browsers.map((browser) => browser.url)).toEqual([
      'file:///replica/content/site/index.html',
      'file:///replica/content/site/index.html',
    ]);
  });

  it('binds a published file to one file panel, never a chat panel', async () => {
    await apply({
      orientation: 0,
      root: {
        type: 'leaf',
        size: 1,
        tabs: [
          { kind: 'chat', chatId: 'chat-1' },
          {
            kind: 'file',
            repoId: 'workspace',
            relativePath: PAGE,
            viewMode: 'raw',
          },
        ],
        activeTabIndex: 1,
      },
    });

    const leaf = onlyLeaf(savedLayouts.get(CONTAINER_ID));
    expect(leaf.panels.map((panel) => panel.kind)).toEqual([
      'chat',
      'file-diff',
    ]);
    expect(leaf.panels[1]?.instance).toMatchObject({
      filePath: '/replica/content/site/index.html',
    });
    expect(activePanel(leaf)?.kind).toBe('file-diff');
  });

  it('keeps the active publisher tab when earlier tabs are dropped', async () => {
    await apply({
      orientation: 0,
      root: {
        type: 'leaf',
        size: 1,
        tabs: [
          { kind: 'chat', chatId: 'unpublished-chat' },
          { kind: 'chat', chatId: 'chat-1' },
          { kind: 'browser', repoId: 'workspace', relativePath: PAGE },
          {
            kind: 'file',
            repoId: 'workspace',
            relativePath: PAGE,
            viewMode: 'raw',
          },
        ],
        activeTabIndex: 2,
      },
    });

    expect(activePanel(onlyLeaf(savedLayouts.get(CONTAINER_ID)))).toMatchObject(
      { kind: 'browser' },
    );
  });

  it('falls back to the nearest earlier tab when the active tab is dropped', async () => {
    await apply({
      orientation: 0,
      root: {
        type: 'leaf',
        size: 1,
        tabs: [
          { kind: 'chat', chatId: 'chat-1' },
          { kind: 'browser', repoId: 'workspace', relativePath: PAGE },
          { kind: 'chat', chatId: 'unpublished-chat' },
          {
            kind: 'file',
            repoId: 'workspace',
            relativePath: PAGE,
            viewMode: 'raw',
          },
        ],
        activeTabIndex: 2,
      },
    });

    expect(activePanel(onlyLeaf(savedLayouts.get(CONTAINER_ID)))).toMatchObject(
      { kind: 'browser' },
    );
  });

  it('creates an active network browser for a URL start page', async () => {
    await applyInitialSharedContainerViewerLayout({
      containerId: CONTAINER_ID,
      layout: createSharedContainerStartPageLayout({
        kind: 'url',
        url: 'https://example.com/start',
      }),
      roots: [],
      publishedPathsByRepo: new Map(),
      chatIds: new Set(),
    });

    expect(activePanel(onlyLeaf(savedLayouts.get(CONTAINER_ID)))).toMatchObject(
      {
        kind: 'browser',
      },
    );
    expect(savedBrowserStates[0]?.browsers[0]?.url).toBe(
      'https://example.com/start',
    );
  });

  it('opens the publisher web pages, including localhost, beside published files', async () => {
    await apply({
      orientation: 0,
      root: {
        type: 'leaf',
        size: 1,
        tabs: [
          { kind: 'browser', url: 'https://example.com/docs' },
          { kind: 'browser', repoId: 'workspace', relativePath: PAGE },
          { kind: 'browser', url: 'http://localhost:5173/' },
        ],
        activeTabIndex: 2,
      },
    });

    const leaf = onlyLeaf(savedLayouts.get(CONTAINER_ID));
    expect(leaf.panels.map((panel) => panel.kind)).toEqual([
      'browser',
      'browser',
      'browser',
    ]);
    const [browserState] = savedBrowserStates;
    expect(browserState?.browsers.map((browser) => browser.url)).toEqual([
      'https://example.com/docs',
      'file:///replica/content/site/index.html',
      'http://localhost:5173/',
    ]);
    expect(activePanel(leaf)).toMatchObject({
      kind: 'browser',
      instance: { browserId: browserState?.browserOrder[2] },
    });
    expect(browserState?.activeBrowserId).toBe(browserState?.browserOrder[2]);
  });

  const LOCAL_LAYOUT: SerializablePanelLayoutFile = {
    version: 1,
    grid: {
      orientation: 0,
      root: {
        type: 'leaf',
        groupId: 'local-group',
        panels: [{ panelId: 'local-panel', kind: 'file-explorer' }],
        activePanelId: 'local-panel',
        size: 1,
      },
      width: 1200,
      height: 800,
    },
    activeGroupId: 'local-group',
    mostRecentActiveGroupIds: ['local-group'],
  };
  const LOCAL_BROWSER_STATE: PersistedWorktreeBrowserStateFile = {
    version: 2,
    browsers: [],
    browserOrder: ['recipient-browser'],
    activeBrowserId: 'recipient-browser',
  };
  const roots = [
    {
      repoId: 'workspace',
      repoName: 'Workspace',
      absolutePath: '/replica/content',
      revisionRoot: '/replica',
      revisionId: 'revision-1',
    },
  ];
  const CHAT_LAYOUT: SharedContainerPublishedLayout = {
    orientation: 0,
    root: {
      type: 'leaf',
      size: 1,
      tabs: [{ kind: 'file-explorer' }, { kind: 'chat', chatId: 'chat-1' }],
      activeTabIndex: 1,
    },
  };

  it('leaves an existing recipient layout untouched in seed mode', async () => {
    savedLayouts.set(CONTAINER_ID, LOCAL_LAYOUT);

    const result = await applyInitialSharedContainerViewerLayout({
      containerId: CONTAINER_ID,
      mode: 'seed',
      layout: createSharedContainerStartPageLayout({
        kind: 'url',
        url: 'https://example.com/start',
      }),
      roots: [],
      publishedPathsByRepo: new Map(),
      chatIds: new Set(),
    });

    expect(result.applied).toBe(false);
    expect(onlyLeaf(savedLayouts.get(CONTAINER_ID)).activePanelId).toBe(
      'local-panel',
    );
    expect(savedBrowserStates).toHaveLength(0);
  });

  it('replaces an existing recipient layout and browser state in reset mode', async () => {
    savedLayouts.set(CONTAINER_ID, LOCAL_LAYOUT);
    savedBrowserStates.push(LOCAL_BROWSER_STATE);

    const result = await applyInitialSharedContainerViewerLayout({
      containerId: CONTAINER_ID,
      mode: 'reset',
      layout: {
        orientation: 0,
        root: {
          type: 'leaf',
          size: 1,
          tabs: [{ kind: 'browser', repoId: 'workspace', relativePath: PAGE }],
          activeTabIndex: 0,
        },
      },
      roots,
      publishedPathsByRepo: new Map([['workspace', new Set([PAGE])]]),
      chatIds: new Set(['chat-1']),
    });

    expect(result.applied).toBe(true);
    expect(activePanel(onlyLeaf(savedLayouts.get(CONTAINER_ID)))).toMatchObject(
      { kind: 'browser' },
    );
    const browserState = savedBrowserStates[savedBrowserStates.length - 1];
    expect(browserState?.browsers).toHaveLength(1);
    expect(browserState?.browserOrder).not.toContain('recipient-browser');
  });

  it('stops the viewer browsers before a reset writes its browser state, and never on a seed', async () => {
    savedLayouts.set(CONTAINER_ID, LOCAL_LAYOUT);
    savedBrowserStates.push(LOCAL_BROWSER_STATE);
    const statesWhenStopped: number[] = [];
    const stopViewerBrowsers = jest.fn((): Promise<void> => {
      statesWhenStopped.push(savedBrowserStates.length);
      return Promise.resolve();
    });

    await applyInitialSharedContainerViewerLayout({
      containerId: CONTAINER_ID,
      layout: CHAT_LAYOUT,
      roots,
      publishedPathsByRepo: new Map(),
      chatIds: new Set(['chat-1']),
      stopViewerBrowsers,
    });
    expect(stopViewerBrowsers).not.toHaveBeenCalled();

    await applyInitialSharedContainerViewerLayout({
      containerId: CONTAINER_ID,
      mode: 'reset',
      layout: CHAT_LAYOUT,
      roots,
      publishedPathsByRepo: new Map(),
      chatIds: new Set(['chat-1']),
      stopViewerBrowsers,
    });

    expect(stopViewerBrowsers).toHaveBeenCalledWith(CONTAINER_ID);
    // Stopped while only the recipient's state existed, before the reset's.
    expect(statesWhenStopped).toEqual([1]);
    expect(savedBrowserStates).toHaveLength(2);
  });

  it('still resets when the viewer browsers cannot be stopped', async () => {
    savedLayouts.set(CONTAINER_ID, LOCAL_LAYOUT);
    savedBrowserStates.push(LOCAL_BROWSER_STATE);

    const result = await applyInitialSharedContainerViewerLayout({
      containerId: CONTAINER_ID,
      mode: 'reset',
      layout: CHAT_LAYOUT,
      roots,
      publishedPathsByRepo: new Map(),
      chatIds: new Set(['chat-1']),
      stopViewerBrowsers: () => Promise.reject(new Error('cleanup failed')),
    });

    expect(result.applied).toBe(true);
    expect(
      savedBrowserStates[savedBrowserStates.length - 1]?.browsers,
    ).toHaveLength(0);
  });

  it('writes an empty browser state when a reset layout has no browsers', async () => {
    savedLayouts.set(CONTAINER_ID, LOCAL_LAYOUT);
    savedBrowserStates.push(LOCAL_BROWSER_STATE);

    const result = await applyInitialSharedContainerViewerLayout({
      containerId: CONTAINER_ID,
      mode: 'reset',
      layout: CHAT_LAYOUT,
      roots,
      publishedPathsByRepo: new Map(),
      chatIds: new Set(['chat-1']),
    });

    expect(result.applied).toBe(true);
    expect(result.activeTabId).toBe('chat-1');
    expect(onlyLeaf(savedLayouts.get(CONTAINER_ID)).panels).toHaveLength(2);
    expect(savedBrowserStates[savedBrowserStates.length - 1]).toEqual({
      version: 2,
      browsers: [],
      browserOrder: [],
      activeBrowserId: null,
    });
  });

  it('restores the recipient layout and browser state when a reset is rolled back', async () => {
    savedLayouts.set(CONTAINER_ID, LOCAL_LAYOUT);
    savedBrowserStates.push(LOCAL_BROWSER_STATE);

    const result = await applyInitialSharedContainerViewerLayout({
      containerId: CONTAINER_ID,
      mode: 'reset',
      layout: CHAT_LAYOUT,
      roots,
      publishedPathsByRepo: new Map(),
      chatIds: new Set(['chat-1']),
    });
    await result.rollback();

    expect(savedLayouts.get(CONTAINER_ID)).toEqual(LOCAL_LAYOUT);
    expect(savedBrowserStates[savedBrowserStates.length - 1]).toEqual(
      LOCAL_BROWSER_STATE,
    );
  });

  it('restores the recipient layout when the reset browser write fails', async () => {
    savedLayouts.set(CONTAINER_ID, LOCAL_LAYOUT);
    savedBrowserStates.push(LOCAL_BROWSER_STATE);
    failNextBrowserSave = true;

    await expect(
      applyInitialSharedContainerViewerLayout({
        containerId: CONTAINER_ID,
        mode: 'reset',
        layout: CHAT_LAYOUT,
        roots,
        publishedPathsByRepo: new Map(),
        chatIds: new Set(['chat-1']),
      }),
    ).rejects.toThrow('browser save failed');

    expect(savedLayouts.get(CONTAINER_ID)).toEqual(LOCAL_LAYOUT);
    // Stopping the viewer's browsers can empty the state before the write
    // fails, so the recipient's state is written back rather than assumed.
    expect(savedBrowserStates[savedBrowserStates.length - 1]).toEqual(
      LOCAL_BROWSER_STATE,
    );
  });

  it('leaves the recipient layout alone when a reset layout projects to nothing', async () => {
    savedLayouts.set(CONTAINER_ID, LOCAL_LAYOUT);

    const result = await applyInitialSharedContainerViewerLayout({
      containerId: CONTAINER_ID,
      mode: 'reset',
      layout: {
        orientation: 0,
        root: {
          type: 'leaf',
          size: 1,
          tabs: [{ kind: 'chat', chatId: 'unpublished-chat' }],
          activeTabIndex: 0,
        },
      },
      roots,
      publishedPathsByRepo: new Map(),
      chatIds: new Set(['chat-1']),
    });

    expect(result.applied).toBe(false);
    expect(savedLayouts.get(CONTAINER_ID)).toEqual(LOCAL_LAYOUT);
    expect(savedBrowserStates).toHaveLength(0);
  });
});

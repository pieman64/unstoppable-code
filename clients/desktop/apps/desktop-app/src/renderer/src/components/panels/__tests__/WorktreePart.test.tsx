/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  BrowserCreateRequest,
  BrowserSessionSnapshot,
  SaveWorktreePanelLayoutRequest,
} from '@canopy/desktop-shared/types';
import type {
  SerializablePanelLayoutFile,
  SerializedPanelNode,
} from '@canopy/protocol';
import { WorktreePart } from '../WorktreePart';
import {
  getPanelLayoutViewModel,
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import {
  DEFAULT_ACTIVITY_GROUP_ID,
  DEFAULT_CHAT_GROUP_ID,
  DEFAULT_TERMINAL_GROUP_ID,
} from '@/lib/panels/default-layout';
import { resetPanelLayoutPersistenceBridgeForTests } from '@/lib/panels/persistence-bridge';
import { resetChatPanelSyncForTests } from '@/lib/panels/chat-panel-sync';
import { resetPanelContentContainersForTests } from '@/components/panels/PanelContentRoot';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useBrowserStore } from '@/stores/browserStore';

// Isolate the grid host from the heavy real panel surfaces (Slate, xterm,
// native browser panes): the registry is stubbed with light per-kind divs,
// mirroring the sibling registry.test.tsx isolation posture.
// The top bar mounts PrStatusBar + chat controls (heavy store/IPC graphs);
// stub it — WorktreeTopBar has its own concerns and this suite covers the
// grid shell.
jest.mock('@/components/panels/WorktreeTopBar', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    WorktreeTopBar: jest.fn((): unknown =>
      react.createElement('div', { 'data-testid': 'stub-worktree-top-bar' }),
    ),
  };
});
// Script pins and shortcuts need the CanopyClient provider; they have their
// own coverage (`useWorktreeScriptActions.test.tsx`).
jest.mock('@/components/panels/useWorktreeScriptActions', () => ({
  useWorktreeScriptActions: (): readonly unknown[] => [],
}));
jest.mock('@/components/shared-containers/ForkedContainerNotice', () => ({
  ForkedContainerNotice: (): null => null,
}));
jest.mock('@/lib/panels/registry', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    renderPanelContent: (props: { kind: string; panelId: string }): unknown =>
      react.createElement('div', {
        'data-testid': `stub-panel-${props.kind}`,
      }),
    getPanelDefinition: (kind: string): unknown => ({
      kind,
      title: kind,
      icon: null,
      canPopOut: kind !== 'browser',
      isWindowBound: kind === 'browser',
      render: (): null => null,
    }),
  };
});
// The no-worktree empty state renders the Home surface, which mounts a Slate
// editor and pulls in `structuredClone` (unavailable in jsdom) plus a wide
// hook/store graph unrelated to this suite's panel-grid concerns. Stub it,
// matching `App.feature-flags.test.tsx`'s treatment of `HomePage`.
jest.mock('@/components/home/HomeSurface', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    HomeSurface: (): unknown =>
      react.createElement('div', { 'data-testid': 'stub-home-surface' }),
  };
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function setE2eFlag(value: boolean): void {
  Object.defineProperty(globalThis, '__CANOPY_E2E__', {
    configurable: true,
    writable: true,
    value,
  });
}

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const KEY = makeWorktreePanelKey(PROJECT_ID, WORKTREE_ID);

// Preload bridge mock: the persistence bridge (Phase 5) loads/saves layouts
// through `window.api.panelLayout`. Default: no persisted layout (`null`), so
// specs exercise the default-layout fallback unless they stub a file.
// `layout` is typed `unknown` here (wider than the transport's
// `SerializablePanelLayoutFile | null`) so corrupt-file specs can feed
// invalid payloads without casting.
const loadWorktreeLayout = jest.fn<Promise<{ layout: unknown }>, [unknown]>();
const saveWorktreeLayout = jest.fn<
  Promise<void>,
  [SaveWorktreePanelLayoutRequest]
>();
const deleteWorktreeLayout = jest.fn<Promise<void>, [unknown]>();
const loadBrowserState = jest.fn<
  Promise<{ state: null }>,
  [{ projectId: string; worktreeId: string }]
>();
const saveBrowserState = jest.fn<Promise<void>, [unknown]>();
const createBrowser = jest.fn<
  Promise<BrowserSessionSnapshot>,
  [BrowserCreateRequest]
>();

/** A persisted two-group layout with non-default ids (restore-path marker). */
function makePersistedLayout(): SerializablePanelLayoutFile {
  return {
    version: 1,
    grid: {
      root: {
        type: 'branch',
        size: 800,
        children: [
          {
            type: 'leaf',
            groupId: 'group-restored-left',
            // Entity-bound kinds need their instance binding to restore
            // (instance-less chat entries are the legacy fallback trigger).
            panels: [
              {
                panelId: 'panel-restored-chat',
                kind: 'chat',
                instance: { chatTabId: 'chat-restored' },
              },
            ],
            activePanelId: 'panel-restored-chat',
            size: 700,
          },
          {
            type: 'leaf',
            groupId: 'group-restored-right',
            panels: [{ panelId: 'panel-restored-terminal', kind: 'terminal' }],
            activePanelId: 'panel-restored-terminal',
            size: 500,
          },
        ],
      },
      orientation: 1,
      width: 1200,
      height: 800,
    },
    activeGroupId: 'group-restored-right',
    mostRecentActiveGroupIds: ['group-restored-right', 'group-restored-left'],
  };
}

describe('WorktreePart', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    setE2eFlag(false);
    loadWorktreeLayout.mockResolvedValue({ layout: null });
    saveWorktreeLayout.mockResolvedValue(undefined);
    deleteWorktreeLayout.mockResolvedValue(undefined);
    loadBrowserState.mockResolvedValue({ status: 'missing', state: null });
    saveBrowserState.mockResolvedValue(undefined);
    createBrowser.mockReset();
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        getFileTreeRoots: jest.fn().mockResolvedValue({ roots: [] }),
        resolveProjectStartPage: jest.fn().mockResolvedValue(null),
        panelLayout: {
          loadWorktreeLayout,
          saveWorktreeLayout,
          deleteWorktreeLayout,
        },
        // Browser migration runs before every panel-layout restore. This
        // layout-focused suite has no sessions, but still supplies the real
        // preload contract so "no state" is not mistaken for corrupt state.
        browser: {
          loadWorktreeState: loadBrowserState,
          saveWorktreeState: saveBrowserState,
          create: createBrowser,
        },
        // The 'terminal' panel tab's trailing running dot (tab-display)
        // subscribes to terminal running state on mount.
        terminal: {
          onRunningChanged: (): (() => void) => (): void => {},
          onExit: (): (() => void) => (): void => {},
          list: (): Promise<unknown[]> => Promise.resolve([]),
        },
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    resetPanelLayoutPersistenceBridgeForTests();
    resetChatPanelSyncForTests();
    resetPanelContentContainersForTests();
    useChatStore.setState({ selectedWorktree: null, worktreeChats: {} });
    useBrowserStore.setState({ worktrees: {} });
    const store = usePanelLayoutStore.getState();
    for (const key of Object.keys(store.layouts)) {
      store.disposeLayout(key);
    }
    setE2eFlag(false);
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  async function renderPart(
    props: Partial<Parameters<typeof WorktreePart>[0]> = {},
  ): Promise<void> {
    // Async act: the ensure-layout effect awaits the persisted-layout load
    // (mock microtask) before committing either the restored or default
    // layout into the store.
    await act(async () => {
      root.render(
        <WorktreePart
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
          viewMode="list"
          viewModeReady
          {...props}
        />,
      );
      await Promise.resolve();
    });
  }

  test('renders the panel grid with the three default groups', async () => {
    await renderPart();
    expect(loadWorktreeLayout).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });

    expect(
      container.querySelector('[data-testid="worktree-part"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="panel-grid-root"]'),
    ).not.toBeNull();

    const viewModel = getPanelLayoutViewModel(KEY);
    expect(viewModel).not.toBeNull();
    expect(viewModel?.groups.map((group) => group.groupId).sort()).toEqual(
      [
        DEFAULT_ACTIVITY_GROUP_ID,
        DEFAULT_CHAT_GROUP_ID,
        DEFAULT_TERMINAL_GROUP_ID,
      ].sort(),
    );
    expect(
      viewModel?.groups.flatMap((group) => group.tabs.map((tab) => tab.kind)),
    ).toEqual(expect.arrayContaining(['terminal', 'activity-section']));
    expect(
      viewModel?.groups.find(
        (group) => group.groupId === DEFAULT_TERMINAL_GROUP_ID,
      )?.collapsed,
    ).toEqual({ edge: 'bottom' });
    // Chat store not hydrated in this test → the chat group seeds EMPTY (the
    // sync bridge materializes bound tabs once the chat list loads).
    expect(
      viewModel?.groups.find((group) => group.groupId === DEFAULT_CHAT_GROUP_ID)
        ?.tabs,
    ).toEqual([]);
    expect(viewModel?.activeGroupId).toBe(DEFAULT_CHAT_GROUP_ID);

    // The persistent worktree top bar mounts above the grid.
    expect(
      container.querySelector('[data-testid="stub-worktree-top-bar"]'),
    ).not.toBeNull();

    // Each default panel's stubbed content is mounted through the portals.
    for (const kind of ['terminal', 'activity-section']) {
      expect(
        document.querySelector(`[data-testid="stub-panel-${kind}"]`),
      ).not.toBeNull();
    }
  });

  test('seeds the chat group with the ACTIVE chat tab when the chat store is hydrated', async () => {
    const tab: ChatTab = {
      id: 'main',
      title: 'Chat',
      messages: [],
      status: 'idle',
      error: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: { thinkingLevel: 'high', fastMode: false },
      fastModeExplicit: false,
      model: 'claude-sonnet-4-5-20250514',
      providerType: 'claude',
    };
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
      worktreeChats: { [KEY]: { activeTabId: 'main', tabs: [tab] } },
    });

    await renderPart();

    const viewModel = getPanelLayoutViewModel(KEY);
    const chatGroup = viewModel?.groups.find(
      (group) => group.groupId === DEFAULT_CHAT_GROUP_ID,
    );
    expect(chatGroup?.tabs).toEqual([
      {
        panelId: 'panel-chat-main',
        kind: 'chat',
        title: 'Chat',
        instance: { chatTabId: 'main' },
      },
    ]);
    expect(chatGroup?.activePanelId).toBe('panel-chat-main');
  });

  test('panel content DOM survives a cross-group move (adoption wiring)', async () => {
    await renderPart();

    const stub = document.querySelector('[data-testid="stub-panel-terminal"]');
    const host = document.querySelector(
      '[data-panel-content-host="panel-terminal"]',
    );
    expect(stub).not.toBeNull();
    expect(host).not.toBeNull();
    expect(host?.contains(stub)).toBe(true);
    // Grid hosts run in adoption mode: content mounts inside the stable
    // container, which is adopted into a group body tab wrapper.
    expect(
      host?.parentElement?.classList.contains('canopy-panel-content'),
    ).toBe(true);

    // Cross-group move (center dock closes the emptied terminal group): the
    // SAME container and content nodes re-parent under the chat group body.
    act(() => {
      usePanelLayoutStore
        .getState()
        .movePanel(KEY, 'panel-terminal', DEFAULT_CHAT_GROUP_ID, 'center');
    });

    expect(
      document.querySelector('[data-panel-content-host="panel-terminal"]'),
    ).toBe(host);
    expect(document.querySelector('[data-testid="stub-panel-terminal"]')).toBe(
      stub,
    );
    expect(
      host?.closest(
        `[data-testid="panel-group-body-${DEFAULT_CHAT_GROUP_ID}"]`,
      ),
    ).not.toBeNull();
  });

  test('layout initialization is idempotent across re-renders', async () => {
    await renderPart();
    const layoutBefore = usePanelLayoutStore.getState().layouts[KEY];
    expect(layoutBefore).toBeDefined();

    await renderPart({ viewMode: 'kanban' });

    const layoutAfter = usePanelLayoutStore.getState().layouts[KEY];
    expect(layoutAfter.revision).toBe(layoutBefore.revision);
    expect(layoutAfter.viewModel).toBe(layoutBefore.viewModel);
    expect(layoutAfter.viewModel.groups).toHaveLength(3);
  });

  test('renders the no-worktree empty state without touching the layout store', async () => {
    await renderPart({ projectId: null, worktreeId: null });
    expect(loadWorktreeLayout).not.toHaveBeenCalled();

    expect(
      container.querySelector('[data-testid="worktree-part"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="panel-grid-root"]'),
    ).toBeNull();
    // The null-selection state is the embedded HomeSurface (stubbed). Task I1
    // removed the transient pending-worktree panel entirely: the Home send now
    // does a single transition straight to the created worktree's real chat.
    expect(
      container.querySelector('[data-testid="stub-home-surface"]'),
    ).not.toBeNull();
    expect(Object.keys(usePanelLayoutStore.getState().layouts)).toHaveLength(0);
  });

  test('installs the panel test API only in E2E builds', async () => {
    setE2eFlag(true);
    await renderPart();

    expect(window.__canopyPanelTestApi).toBeDefined();
    expect(window.__canopyPanelTestApi?.getActiveGroupId()).toBe(
      DEFAULT_CHAT_GROUP_ID,
    );

    const serialized = window.__canopyPanelTestApi?.getSerializedLayout();
    expect(serialized?.activeGroupId).toBe(DEFAULT_CHAT_GROUP_ID);
    expect(serialized?.root.type).toBe('branch');

    // The projection exposes collapse PROVENANCE, not just the edge
    // (CAN-2836). `collapsed` is flattened to a `PanelCollapseEdge` string, so
    // without `collapsedAuto` a spec probing `collapsed.auto` silently reads
    // `undefined` and asserts nothing — which is exactly the vacuous-assertion
    // bug this field was added to make impossible. Pin it here so the E2E
    // suite is not the only thing covering it.
    const leaves: SerializedPanelNode[] = [];
    const collect = (node: SerializedPanelNode): void => {
      if (node.type === 'leaf') {
        leaves.push(node);
        return;
      }
      for (const child of node.children) collect(child);
    };
    if (serialized !== undefined) collect(serialized.root);
    const activityLeaf = leaves.find(
      (leaf) =>
        leaf.type === 'leaf' && leaf.groupId === DEFAULT_ACTIVITY_GROUP_ID,
    );
    expect(activityLeaf).toBeDefined();
    if (activityLeaf?.type === 'leaf') {
      // The default seed collapses the rail on Canopy's behalf.
      expect(activityLeaf.collapsed).not.toBeNull();
      expect(activityLeaf.collapsedAuto).toBe(true);
    }

    act(() => {
      root.unmount();
    });
    expect(window.__canopyPanelTestApi).toBeUndefined();

    // Recreate the root so afterEach's unmount stays valid.
    root = createRoot(container);
  });

  test('E2E pipeline run fixture drives the real store, placement, and readback', async () => {
    setE2eFlag(true);
    await renderPart();
    const api = window.__canopyPanelTestApi;
    if (api === undefined) throw new Error('panel test API not installed');
    // Store commits re-render the mounted grid, so every call runs in act.
    const add = async (
      request: Parameters<typeof api.addPipelineExecutionPanel>[0],
    ): ReturnType<typeof api.addPipelineExecutionPanel> => {
      let result: Awaited<ReturnType<typeof api.addPipelineExecutionPanel>> = {
        outcome: 'unavailable',
      };
      await act(async () => {
        result = await api.addPipelineExecutionPanel(request);
      });
      return result;
    };

    const placed = await add({ executionId: 'run-1' });
    expect(placed.outcome).toBe('placed');
    const location = placed.outcome === 'placed' ? placed.location : null;
    expect(location?.panelId).toBe('panel-pipeline-run-1');
    expect(api.findPipelineExecutionPanel('run-1')).toEqual(location);

    // Read back through the serialized-layout projection.
    const runPanels: Array<{ panelId: string; instance?: unknown }> = [];
    const collect = (node: SerializedPanelNode): void => {
      if (node.type === 'leaf') {
        runPanels.push(
          ...node.panels.filter((panel) => panel.kind === 'pipeline-execution'),
        );
        return;
      }
      for (const child of node.children) collect(child);
    };
    collect(api.getSerializedLayout().root);
    expect(runPanels).toEqual([
      {
        panelId: 'panel-pipeline-run-1',
        kind: 'pipeline-execution',
        instance: { executionId: 'run-1' },
      },
    ]);

    // A second open of the same run reveals it; it never duplicates.
    await expect(add({ executionId: 'run-1' })).resolves.toEqual({
      outcome: 'revealed',
      location,
    });

    // A direct group add goes straight through `addTab`.
    await expect(
      add({ executionId: 'run-2', groupId: DEFAULT_CHAT_GROUP_ID }),
    ).resolves.toEqual({
      outcome: 'placed',
      location: {
        layoutKey: KEY,
        groupId: DEFAULT_CHAT_GROUP_ID,
        panelId: 'panel-pipeline-run-2',
      },
    });
    await expect(
      add({ executionId: 'run-2', groupId: DEFAULT_CHAT_GROUP_ID }),
    ).resolves.toEqual({ outcome: 'unavailable' });
  });

  test('E2E browser create forwards the exact request and registers only its real result', async () => {
    setE2eFlag(true);
    await renderPart();

    const request: BrowserCreateRequest = {
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      url: 'https://fixture.test/named',
      themeMode: 'dark',
      selection: { kind: 'named', profileId: 'profile-named' },
      browserId: 'browser-fixture',
      expectedRuntimeGeneration: 7,
    };
    const snapshot: BrowserSessionSnapshot = {
      id: 'browser-fixture',
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      createdAt: 1,
      updatedAt: 2,
      url: 'https://fixture.test/named',
      title: 'Named fixture',
      status: 'ready',
      canGoBack: false,
      canGoForward: false,
      loading: false,
      themeMode: 'dark',
      pickMode: false,
      recording: false,
      profile: {
        selection: { kind: 'named', profileId: 'profile-named' },
        resolvedProfileId: 'profile-named',
        storageGeneration: 3,
        runtimeGeneration: 7,
        taskIncarnationId: 'incarnation-1',
      },
    };
    createBrowser.mockResolvedValueOnce(snapshot);
    const api = window.__canopyPanelTestApi as NonNullable<
      typeof window.__canopyPanelTestApi
    > & {
      createBrowser(
        createRequest: BrowserCreateRequest,
      ): Promise<BrowserSessionSnapshot>;
    };

    await expect(api.createBrowser(request)).resolves.toBe(snapshot);
    expect(createBrowser).toHaveBeenCalledTimes(1);
    expect(createBrowser).toHaveBeenCalledWith(request);
    let bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.browsers[snapshot.id]).toBe(snapshot);
    expect(bucket.browserOrder).toEqual([snapshot.id]);
    expect(bucket.live).toEqual(new Set([snapshot.id]));

    createBrowser.mockClear();
    await expect(
      api.createBrowser({ ...request, worktreeId: 'other-worktree' }),
    ).rejects.toThrow('does not own browser request');
    expect(createBrowser).not.toHaveBeenCalled();
    bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.browserOrder).toEqual([snapshot.id]);
    expect(bucket.live).toEqual(new Set([snapshot.id]));

    createBrowser.mockRejectedValueOnce(new Error('create rejected'));
    await expect(
      api.createBrowser({ ...request, browserId: 'browser-rejected' }),
    ).rejects.toThrow('create rejected');
    bucket = useBrowserStore.getState().worktrees[KEY];
    expect(bucket.browsers['browser-rejected']).toBeUndefined();
    expect(bucket.browserOrder).toEqual([snapshot.id]);
    expect(bucket.live).toEqual(new Set([snapshot.id]));
  });

  test('E2E browser lifecycle reads bounded state from only the bound worktree without mutation', async () => {
    setE2eFlag(true);
    await renderPart();
    const api = window.__canopyPanelTestApi as NonNullable<
      typeof window.__canopyPanelTestApi
    > & {
      getBrowserLifecycle(browserId: string): {
        hydrated: boolean;
        hydrationErrorPresent: boolean;
        known: boolean;
        live: boolean;
        active: boolean;
        status: BrowserSessionSnapshot['status'] | null;
        loading: boolean;
        lastErrorPresent: boolean;
      };
    };
    useBrowserStore.setState({ worktrees: {} });
    expect(api.getBrowserLifecycle('browser-observed')).toEqual({
      hydrated: false,
      hydrationErrorPresent: false,
      known: false,
      live: false,
      active: false,
      status: null,
      loading: false,
      lastErrorPresent: false,
    });

    const snapshot: BrowserSessionSnapshot = {
      id: 'browser-observed',
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      createdAt: 1,
      updatedAt: 2,
      url: 'https://private.example/restored',
      title: 'Private restored page',
      status: 'idle',
      canGoBack: false,
      canGoForward: false,
      loading: false,
      themeMode: 'light',
      pickMode: false,
      recording: false,
    };
    const inertBucket = {
      browserOrder: [snapshot.id],
      activeBrowserId: null,
      browsers: { [snapshot.id]: snapshot },
      live: new Set<string>(),
      hydrated: true,
    };
    useBrowserStore.setState({ worktrees: { [KEY]: inertBucket } });
    expect(api.getBrowserLifecycle(snapshot.id)).toEqual({
      hydrated: true,
      hydrationErrorPresent: false,
      known: true,
      live: false,
      active: false,
      status: 'idle',
      loading: false,
      lastErrorPresent: false,
    });
    expect(useBrowserStore.getState().worktrees[KEY]).toBe(inertBucket);

    const loadingSnapshot: BrowserSessionSnapshot = {
      ...snapshot,
      status: 'loading',
      loading: true,
    };
    const liveBucket = {
      ...inertBucket,
      activeBrowserId: snapshot.id,
      browsers: { [snapshot.id]: loadingSnapshot },
      live: new Set([snapshot.id]),
    };
    useBrowserStore.setState({ worktrees: { [KEY]: liveBucket } });
    expect(api.getBrowserLifecycle(snapshot.id)).toEqual({
      hydrated: true,
      hydrationErrorPresent: false,
      known: true,
      live: true,
      active: true,
      status: 'loading',
      loading: true,
      lastErrorPresent: false,
    });
    expect(useBrowserStore.getState().worktrees[KEY]).toBe(liveBucket);

    const failedSnapshot: BrowserSessionSnapshot = {
      ...snapshot,
      status: 'failed',
      lastError: 'private failure text',
    };
    const failedBucket = {
      ...inertBucket,
      browsers: { [snapshot.id]: failedSnapshot },
      hydrationError: 'private hydration error',
    };
    useBrowserStore.setState({ worktrees: { [KEY]: failedBucket } });
    expect(api.getBrowserLifecycle(snapshot.id)).toEqual({
      hydrated: true,
      hydrationErrorPresent: true,
      known: true,
      live: false,
      active: false,
      status: 'failed',
      loading: false,
      lastErrorPresent: true,
    });
    expect(useBrowserStore.getState().worktrees[KEY]).toBe(failedBucket);

    loadBrowserState.mockClear();
    saveBrowserState.mockClear();
    createBrowser.mockClear();
    api.getBrowserLifecycle(snapshot.id);
    expect(loadBrowserState).not.toHaveBeenCalled();
    expect(saveBrowserState).not.toHaveBeenCalled();
    expect(createBrowser).not.toHaveBeenCalled();
  });

  test('does not install the panel test API outside E2E builds', async () => {
    setE2eFlag(false);
    await renderPart();

    expect(window.__canopyPanelTestApi).toBeUndefined();
  });

  test('restores a persisted layout instead of building the default', async () => {
    loadWorktreeLayout.mockResolvedValue({ layout: makePersistedLayout() });

    await renderPart();

    const viewModel = getPanelLayoutViewModel(KEY);
    expect(viewModel).not.toBeNull();
    expect(viewModel?.groups.map((group) => group.groupId)).toEqual([
      'group-restored-left',
      'group-restored-right',
    ]);
    expect(viewModel?.activeGroupId).toBe('group-restored-right');
    // The default builder was skipped entirely — none of its stable ids.
    expect(viewModel?.groups.map((group) => group.groupId)).not.toContain(
      DEFAULT_CHAT_GROUP_ID,
    );
    // Restored content mounts through the portals like any other layout.
    for (const kind of ['chat', 'terminal']) {
      expect(
        document.querySelector(`[data-testid="stub-panel-${kind}"]`),
      ).not.toBeNull();
    }
  });

  test('falls back to the default layout when the persisted file is corrupt', async () => {
    // migratePanelLayout rejects the shape → restoreLayout returns false.
    const corrupt: unknown = { version: 1, grid: { nope: true } };
    loadWorktreeLayout.mockResolvedValue({ layout: corrupt });

    await renderPart();

    const viewModel = getPanelLayoutViewModel(KEY);
    expect(viewModel?.groups.map((group) => group.groupId).sort()).toEqual(
      [
        DEFAULT_ACTIVITY_GROUP_ID,
        DEFAULT_CHAT_GROUP_ID,
        DEFAULT_TERMINAL_GROUP_ID,
      ].sort(),
    );
  });

  test('falls back to the default layout when the layout load rejects', async () => {
    loadWorktreeLayout.mockRejectedValue(new Error('ipc unavailable'));

    await renderPart();

    const viewModel = getPanelLayoutViewModel(KEY);
    expect(viewModel).not.toBeNull();
    expect(viewModel?.groups).toHaveLength(3);
  });

  test('schedules a debounced save after a topology mutation, not during hydration', async () => {
    jest.useFakeTimers();
    await renderPart();

    // Hydration (default build) must not echo a save.
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(saveWorktreeLayout).not.toHaveBeenCalled();

    act(() => {
      usePanelLayoutStore
        .getState()
        .splitGroup(KEY, DEFAULT_CHAT_GROUP_ID, 'right');
    });
    expect(saveWorktreeLayout).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
    const request = saveWorktreeLayout.mock.calls[0][0];
    expect(request.projectId).toBe(PROJECT_ID);
    expect(request.worktreeId).toBe(WORKTREE_ID);
    expect(request.layout.version).toBe(1);
    // Four leaves after the split: chat, split clone, terminal, activity.
    expect(request.layout.mostRecentActiveGroupIds.length).toBe(4);
  });

  test('coalesces rapid mutations into one debounced save', async () => {
    jest.useFakeTimers();
    await renderPart();

    act(() => {
      const store = usePanelLayoutStore.getState();
      store.focusGroup(KEY, DEFAULT_TERMINAL_GROUP_ID);
      store.focusGroup(KEY, DEFAULT_CHAT_GROUP_ID);
    });
    await act(async () => {
      jest.advanceTimersByTime(499);
      await Promise.resolve();
    });
    expect(saveWorktreeLayout).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(saveWorktreeLayout).toHaveBeenCalledTimes(1);
  });

  test('disposing a layout cancels its pending save', async () => {
    jest.useFakeTimers();
    await renderPart();

    act(() => {
      usePanelLayoutStore.getState().focusGroup(KEY, DEFAULT_TERMINAL_GROUP_ID);
    });
    act(() => {
      usePanelLayoutStore.getState().disposeLayout(KEY);
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(saveWorktreeLayout).not.toHaveBeenCalled();
  });
});

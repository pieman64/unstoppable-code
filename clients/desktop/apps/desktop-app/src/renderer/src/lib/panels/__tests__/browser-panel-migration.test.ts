/** @jest-environment jsdom */

/**
 * Legacy Browser panel-layout migration tests: placeholder flattening in
 * binding order, deterministic panel ids, pinned/active preservation,
 * missing/corrupt layout behavior, blank-session creation, no-placeholder
 * semantics, hydration-failure recovery (no file rewrite + suspended
 * persistence), and Retry completion.
 */
import { migratePanelLayout } from '@canopy/protocol';
import type {
  BrowserSessionSnapshot,
  PersistedWorktreeBrowserStateFile,
} from '@canopy/desktop-shared/types';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import { useBrowserStore } from '@/stores/browserStore';

const suspendPanelLayoutPersistence = jest.fn();
const resumePanelLayoutPersistence = jest.fn();
const schedulePanelLayoutSave = jest.fn();
jest.mock('../persistence-bridge', () => ({
  suspendPanelLayoutPersistence: (key: string): void => {
    suspendPanelLayoutPersistence(key);
  },
  resumePanelLayoutPersistence: (key: string): void => {
    resumePanelLayoutPersistence(key);
  },
  schedulePanelLayoutSave: (
    key: string,
    options?: { userInitiated?: boolean },
  ): void => {
    schedulePanelLayoutSave(key, options);
  },
}));

const addToast = jest.fn();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: { getState: (): unknown => ({ addToast }) },
}));

jest.mock('../browser-panel-activation', () => ({
  isBrowserActivationPending: (): boolean => false,
}));

import {
  completeBrowserMigrationRecovery,
  hasPendingBrowserMigrationRecovery,
  prepareBrowserPanelMigration,
  RECOVERY_BROWSER_ID,
  resetBrowserPanelMigrationForTests,
  STALE_BROWSER_PANEL_TOAST,
} from '../browser-panel-migration';

interface MockBrowserApi {
  loadWorktreeState: jest.Mock;
  saveWorktreeState: jest.Mock;
  create: jest.Mock;
  destroy: jest.Mock;
  setVisible: jest.Mock;
  setActive: jest.Mock;
  navigate: jest.Mock;
}

let browserApi: MockBrowserApi;
let keyCounter = 100;

const PROJECT_ID = 'project';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nextWorktree(): { worktreeId: string; key: string } {
  keyCounter += 1;
  const worktreeId = `mig-worktree-${keyCounter}`;
  return { worktreeId, key: makeWorktreePanelKey(PROJECT_ID, worktreeId) };
}

function snapshotFor(
  browserId: string,
  worktreeId: string,
  overrides: Partial<BrowserSessionSnapshot> = {},
): BrowserSessionSnapshot {
  return {
    id: browserId,
    projectId: PROJECT_ID,
    worktreeId,
    createdAt: 1,
    updatedAt: 2,
    url: `http://localhost:3000/${browserId}`,
    title: browserId,
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
    ...overrides,
  };
}

function persistedState(
  worktreeId: string,
  browserIds: string[],
  activeBrowserId: string | null,
): PersistedWorktreeBrowserStateFile {
  return {
    version: 1,
    browserOrder: browserIds,
    activeBrowserId,
    browsers: browserIds.map((browserId) => snapshotFor(browserId, worktreeId)),
  };
}

/**
 * Builds a REAL serialized layout via the layout store, then rewrites its
 * Browser entry into the legacy unbound-placeholder shape (`kind: 'browser'`
 * with no instance) — exactly what a pre-refactor `panel-layout.json` holds.
 */
function legacyLayoutFile(
  key: string,
  options: { pinned?: boolean; browserActive?: boolean } = {},
): Record<string, unknown> {
  const descriptor: DefaultLayoutDescriptor = {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-chat',
        panelId: 'panel-chat',
        instance: { chatTabId: 'chat-a' },
      },
      {
        kind: 'browser',
        groupId: 'group-main',
        panelId: 'panel-legacy-browser',
        instance: { browserId: 'placeholder-scaffold' },
      },
    ],
    containerSize: { width: 1200, height: 700 },
  };
  usePanelLayoutStore.getState().initializeLayout(key, descriptor);
  if (options.pinned) {
    usePanelLayoutStore
      .getState()
      .setTabPinned(key, 'group-main', 'panel-legacy-browser', true);
  }
  // Merge the browser tab into the chat group? No — keep groups as built.
  usePanelLayoutStore
    .getState()
    .selectTab(key, 'group-main', 'panel-legacy-browser', {
      focus: options.browserActive !== false,
    });
  if (options.browserActive === false) {
    usePanelLayoutStore.getState().focusGroup(key, 'group-chat');
  }
  const file = usePanelLayoutStore.getState().serializeLayout(key);
  usePanelLayoutStore.getState().disposeLayout(key);
  if (file === null) {
    throw new Error('expected serialized layout');
  }
  // Strip the instance to produce the legacy unbound placeholder.
  const raw: unknown = JSON.parse(JSON.stringify(file));
  const stripInstance = (node: unknown): void => {
    if (!isRecord(node)) {
      return;
    }
    if (node.type === 'leaf' && Array.isArray(node.panels)) {
      for (const panel of node.panels) {
        if (isRecord(panel) && panel.kind === 'browser') {
          delete panel.instance;
        }
      }
      return;
    }
    if (node.type === 'branch' && Array.isArray(node.children)) {
      for (const child of node.children) {
        stripInstance(child);
      }
    }
  };
  if (!isRecord(raw) || !isRecord(raw.grid)) {
    throw new Error('expected serialized layout object');
  }
  stripInstance(raw.grid.root);
  return raw;
}

function collectBrowserPanels(
  layout: unknown,
): Array<{ panelId: string; browserId?: string; pinned?: boolean }> {
  const found: Array<{
    panelId: string;
    browserId?: string;
    pinned?: boolean;
  }> = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (record.type === 'branch' && Array.isArray(record.children)) {
      for (const child of record.children) walk(child);
      return;
    }
    if (record.type === 'leaf' && Array.isArray(record.panels)) {
      for (const panel of record.panels as Array<Record<string, unknown>>) {
        if (panel.kind === 'browser') {
          found.push({
            panelId: panel.panelId as string,
            browserId: (panel.instance as Record<string, string> | undefined)
              ?.browserId,
            ...(panel.pinned === true ? { pinned: true } : {}),
          });
        }
      }
    }
  };
  walk(
    ((layout as Record<string, unknown>).grid as Record<string, unknown>).root,
  );
  return found;
}

function findLeafActivePanelId(
  layout: unknown,
  groupId: string,
): string | null {
  let result: string | null = null;
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    if (record.type === 'branch' && Array.isArray(record.children)) {
      for (const child of record.children) walk(child);
      return;
    }
    if (record.type === 'leaf' && record.groupId === groupId) {
      result = (record.activePanelId as string | null) ?? null;
    }
  };
  walk(
    ((layout as Record<string, unknown>).grid as Record<string, unknown>).root,
  );
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetBrowserPanelMigrationForTests();
  browserApi = {
    loadWorktreeState: jest.fn(),
    saveWorktreeState: jest.fn().mockResolvedValue(undefined),
    create: jest.fn(),
    destroy: jest.fn().mockResolvedValue(undefined),
    setVisible: jest.fn().mockResolvedValue(undefined),
    setActive: jest.fn().mockResolvedValue(undefined),
    navigate: jest.fn(),
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { browser: browserApi },
  });
  useBrowserStore.setState({ worktrees: {} });
});

describe('prepareBrowserPanelMigration', () => {
  it('replaces the placeholder with bound panels in browserOrder with deterministic ids', async () => {
    const { worktreeId, key } = nextWorktree();
    browserApi.loadWorktreeState.mockResolvedValue({
      state: persistedState(worktreeId, ['b1', 'b2'], 'b2'),
    });
    const raw = legacyLayoutFile(key, { browserActive: true });

    const plan = await prepareBrowserPanelMigration(key, raw);

    expect(plan.recovery).toBe(false);
    expect(plan.migrated).toBe(true);
    const panels = collectBrowserPanels(plan.layout);
    // Flattened in browserOrder; the FIRST keeps the placeholder's panel id,
    // later ids derive deterministically from their browser ids.
    expect(panels).toEqual([
      { panelId: 'panel-legacy-browser', browserId: 'b1' },
      { panelId: 'panel-browser-b2', browserId: 'b2' },
    ]);
    // The placeholder was the group's active tab → the panel bound to the
    // normalized activeBrowserId (b2) becomes active.
    expect(findLeafActivePanelId(plan.layout, 'group-main')).toBe(
      'panel-browser-b2',
    );
    // The transformed layout passes protocol validation.
    expect(migratePanelLayout(plan.layout)).not.toBeNull();
  });

  it('is idempotent: repeating migration produces the same layout', async () => {
    const { worktreeId, key } = nextWorktree();
    browserApi.loadWorktreeState.mockResolvedValue({
      state: persistedState(worktreeId, ['b1', 'b2'], 'b1'),
    });
    const raw = legacyLayoutFile(key);

    const first = await prepareBrowserPanelMigration(key, raw);
    const second = await prepareBrowserPanelMigration(key, raw);

    expect(JSON.stringify(second.layout)).toBe(JSON.stringify(first.layout));
  });

  it('preserves the placeholder pinned state on every migrated tab', async () => {
    const { worktreeId, key } = nextWorktree();
    browserApi.loadWorktreeState.mockResolvedValue({
      state: persistedState(worktreeId, ['b1', 'b2'], 'b1'),
    });
    const raw = legacyLayoutFile(key, { pinned: true });

    const plan = await prepareBrowserPanelMigration(key, raw);

    const panels = collectBrowserPanels(plan.layout);
    expect(panels).toHaveLength(2);
    for (const panel of panels) {
      expect(panel.pinned).toBe(true);
    }
  });

  it('creates and binds one blank browser for a placeholder with no sessions', async () => {
    const { worktreeId, key } = nextWorktree();
    browserApi.loadWorktreeState.mockResolvedValue({
      state: persistedState(worktreeId, [], null),
    });
    browserApi.create.mockResolvedValue(snapshotFor('b-new', worktreeId));
    const raw = legacyLayoutFile(key);

    const plan = await prepareBrowserPanelMigration(key, raw);

    expect(browserApi.create).toHaveBeenCalledTimes(1);
    expect(collectBrowserPanels(plan.layout)).toEqual([
      { panelId: 'panel-legacy-browser', browserId: 'b-new' },
    ]);
  });

  it('passes non-legacy layouts through untouched', async () => {
    const { worktreeId, key } = nextWorktree();
    browserApi.loadWorktreeState.mockResolvedValue({
      state: persistedState(worktreeId, [], null),
    });
    const raw = { version: 1, grid: { root: { type: 'leaf', panels: [] } } };

    const plan = await prepareBrowserPanelMigration(key, raw);

    expect(plan.layout).toBe(raw);
    expect(plan.migrated).toBe(false);
  });
});

describe('post-restore reconciliation (finalize)', () => {
  it('preserves sessions when a valid legacy layout has no Browser panel', async () => {
    const { worktreeId, key } = nextWorktree();
    browserApi.loadWorktreeState.mockResolvedValue({
      state: persistedState(worktreeId, ['b-hidden'], null),
    });
    // A valid layout WITHOUT any browser panel.
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat',
          instance: { chatTabId: 'chat-a' },
        },
      ],
      containerSize: { width: 900, height: 600 },
    });

    const plan = await prepareBrowserPanelMigration(key, {
      version: 1,
      grid: {},
    });
    await plan.finalize('restored');

    expect(browserApi.destroy).not.toHaveBeenCalled();
    expect(
      useBrowserStore.getState().worktrees[key].browsers['b-hidden'],
    ).toBeDefined();
    const rebound = Object.values(
      usePanelLayoutStore.getState().layouts[key].groups,
    )
      .flatMap((group) => group.tabs)
      .find((tab) => tab.instance?.browserId === 'b-hidden');
    expect(rebound).toBeDefined();
    // The preserved binding is saved only after restore succeeds.
    expect(browserApi.saveWorktreeState).toHaveBeenCalled();
    expect(schedulePanelLayoutSave).toHaveBeenCalledWith(key, {
      userInitiated: false,
    });
    usePanelLayoutStore.getState().disposeLayout(key);
  });

  it('removes conclusively stale bound panels with a toast after successful hydration', async () => {
    const { worktreeId, key } = nextWorktree();
    browserApi.loadWorktreeState.mockResolvedValue({
      state: persistedState(worktreeId, [], null),
    });
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat',
          instance: { chatTabId: 'chat-a' },
        },
        {
          kind: 'browser',
          groupId: 'group-b',
          panelId: 'panel-browser-stale',
          instance: { browserId: 'b-stale' },
        },
      ],
      containerSize: { width: 900, height: 600 },
    });

    const plan = await prepareBrowserPanelMigration(key, {
      version: 1,
      grid: {},
    });
    await plan.finalize('restored');

    const layout = usePanelLayoutStore.getState().layouts[key];
    const stillBound = Object.values(layout.groups).some((group) =>
      group.tabs.some((tab) => tab.instance?.browserId === 'b-stale'),
    );
    expect(stillBound).toBe(false);
    expect(addToast).toHaveBeenCalledWith(
      STALE_BROWSER_PANEL_TOAST,
      'warning',
      undefined,
      expect.objectContaining({ worktreeId }),
    );
    usePanelLayoutStore.getState().disposeLayout(key);
  });

  it('appends preserved Browser tabs to the default layout for missing/corrupt files', async () => {
    const { worktreeId, key } = nextWorktree();
    browserApi.loadWorktreeState.mockResolvedValue({
      state: persistedState(worktreeId, ['b1', 'b2'], 'b1'),
    });

    const plan = await prepareBrowserPanelMigration(key, null);
    // The caller failed restore and built the default layout instead.
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat',
          instance: { chatTabId: 'chat-a' },
        },
      ],
      containerSize: { width: 900, height: 600 },
    });
    await plan.finalize('default');

    const layout = usePanelLayoutStore.getState().layouts[key];
    const bound = Object.values(layout.groups)
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.kind === 'browser')
      .map((tab) => tab.instance?.browserId);
    expect(bound.sort()).toEqual(['b1', 'b2']);
    // Sessions were NOT destroyed (a corrupt layout is not an intentional
    // close).
    expect(browserApi.destroy).not.toHaveBeenCalled();
    expect(browserApi.saveWorktreeState).toHaveBeenCalled();
    expect(schedulePanelLayoutSave).toHaveBeenCalledWith(key, {
      userInitiated: false,
    });
    usePanelLayoutStore.getState().disposeLayout(key);
  });
});

describe('hydration-failure recovery', () => {
  it('binds the recovery placeholder, suspends persistence, and rewrites nothing', async () => {
    const { key } = nextWorktree();
    browserApi.loadWorktreeState.mockRejectedValue(
      new Error('corrupt/future browser state'),
    );
    const raw = legacyLayoutFile(key);

    const plan = await prepareBrowserPanelMigration(key, raw);

    expect(plan.recovery).toBe(true);
    expect(hasPendingBrowserMigrationRecovery(key)).toBe(true);
    expect(suspendPanelLayoutPersistence).toHaveBeenCalledWith(key);
    expect(collectBrowserPanels(plan.layout)).toEqual([
      { panelId: 'panel-legacy-browser', browserId: RECOVERY_BROWSER_ID },
    ]);
    // The recovery layout still satisfies the renderer instance contract.
    expect(migratePanelLayout(plan.layout)).not.toBeNull();

    await plan.finalize('restored');
    // Neither file is rewritten and nothing is destroyed.
    expect(browserApi.saveWorktreeState).not.toHaveBeenCalled();
    expect(browserApi.destroy).not.toHaveBeenCalled();
    expect(schedulePanelLayoutSave).not.toHaveBeenCalled();
  });

  it('never removes bound panels as stale during failed hydration', async () => {
    const { key } = nextWorktree();
    browserApi.loadWorktreeState.mockRejectedValue(new Error('corrupt'));
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'browser',
          groupId: 'group-b',
          panelId: 'panel-browser-b1',
          instance: { browserId: 'b1' },
        },
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat',
          instance: { chatTabId: 'chat-a' },
        },
      ],
      containerSize: { width: 900, height: 600 },
    });

    const plan = await prepareBrowserPanelMigration(key, {
      version: 1,
      grid: {},
    });
    await plan.finalize('restored');

    expect(plan.recovery).toBe(true);
    expect(hasPendingBrowserMigrationRecovery(key)).toBe(true);
    expect(suspendPanelLayoutPersistence).toHaveBeenCalledWith(key);

    const layout = usePanelLayoutStore.getState().layouts[key];
    const stillBound = Object.values(layout.groups).some((group) =>
      group.tabs.some((tab) => tab.instance?.browserId === 'b1'),
    );
    expect(stillBound).toBe(true);
    expect(addToast).not.toHaveBeenCalled();
    usePanelLayoutStore.getState().disposeLayout(key);
  });

  it('adds a reachable recovery panel when corrupt state has no Browser panel yet', async () => {
    const { key } = nextWorktree();
    browserApi.loadWorktreeState.mockRejectedValue(new Error('corrupt'));

    const plan = await prepareBrowserPanelMigration(key, null);
    expect(plan.recovery).toBe(true);

    // A missing/corrupt panel-layout file makes the bridge build its normal
    // default before finalization. Recovery must still be reachable from that
    // default layout instead of leaving future Browser creation stuck forever.
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat',
          instance: { chatTabId: 'chat-a' },
        },
      ],
      containerSize: { width: 900, height: 600 },
    });
    await plan.finalize('default');

    const recovery = Object.values(
      usePanelLayoutStore.getState().layouts[key].groups,
    )
      .flatMap((group) => group.tabs)
      .find((tab) => tab.instance?.browserId === RECOVERY_BROWSER_ID);
    expect(recovery).toBeDefined();
    expect(browserApi.saveWorktreeState).not.toHaveBeenCalled();
    expect(schedulePanelLayoutSave).not.toHaveBeenCalled();
    usePanelLayoutStore.getState().disposeLayout(key);
  });

  it('resumes an already-bound layout after hydration succeeds on Retry', async () => {
    const { worktreeId, key } = nextWorktree();
    browserApi.loadWorktreeState.mockRejectedValueOnce(new Error('corrupt'));
    usePanelLayoutStore.getState().initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'browser',
          groupId: 'group-browser',
          panelId: 'panel-browser-b1',
          instance: { browserId: 'b1' },
        },
      ],
      containerSize: { width: 900, height: 600 },
    });
    const raw = usePanelLayoutStore.getState().serializeLayout(key);
    usePanelLayoutStore.getState().disposeLayout(key);
    const plan = await prepareBrowserPanelMigration(key, raw);
    const migrated = migratePanelLayout(plan.layout);
    expect(migrated).not.toBeNull();
    expect(usePanelLayoutStore.getState().restoreLayout(key, migrated)).toBe(
      true,
    );
    await plan.finalize('restored');

    browserApi.loadWorktreeState.mockResolvedValue({
      state: persistedState(worktreeId, ['b1'], 'b1'),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, worktreeId);
    await completeBrowserMigrationRecovery(PROJECT_ID, worktreeId);

    const bound = Object.values(
      usePanelLayoutStore.getState().layouts[key].groups,
    )
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.kind === 'browser')
      .map((tab) => tab.instance?.browserId);
    expect(bound).toEqual(['b1']);
    expect(hasPendingBrowserMigrationRecovery(key)).toBe(false);
    expect(resumePanelLayoutPersistence).toHaveBeenCalledWith(key);
    expect(browserApi.saveWorktreeState).toHaveBeenCalled();
    usePanelLayoutStore.getState().disposeLayout(key);
  });

  it('completes migration on successful Retry: rebinds panels and resumes persistence', async () => {
    const { worktreeId, key } = nextWorktree();
    browserApi.loadWorktreeState.mockRejectedValueOnce(new Error('corrupt'));
    const raw = legacyLayoutFile(key, { pinned: false });
    const plan = await prepareBrowserPanelMigration(key, raw);
    expect(plan.recovery).toBe(true);

    // Restore the recovery layout into the live store (what the persistence
    // bridge does with plan.layout).
    const migrated = migratePanelLayout(plan.layout);
    expect(migrated).not.toBeNull();
    expect(usePanelLayoutStore.getState().restoreLayout(key, migrated)).toBe(
      true,
    );

    // Hydration now succeeds (Retry).
    browserApi.loadWorktreeState.mockResolvedValue({
      state: persistedState(worktreeId, ['b1', 'b2'], 'b2'),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, worktreeId);
    await completeBrowserMigrationRecovery(PROJECT_ID, worktreeId);

    const layout = usePanelLayoutStore.getState().layouts[key];
    const bound = Object.values(layout.groups)
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.kind === 'browser')
      .map((tab) => ({
        panelId: tab.panelId,
        browserId: tab.instance?.browserId,
      }));
    // First browser keeps the recovery panel's slot (original placeholder
    // panel id); the second inserts after it deterministically.
    expect(bound).toEqual([
      { panelId: 'panel-legacy-browser', browserId: 'b1' },
      { panelId: 'panel-browser-b2', browserId: 'b2' },
    ]);
    expect(hasPendingBrowserMigrationRecovery(key)).toBe(false);
    expect(resumePanelLayoutPersistence).toHaveBeenCalledWith(key);
    expect(browserApi.saveWorktreeState).toHaveBeenCalled();
    expect(schedulePanelLayoutSave).toHaveBeenCalledWith(key, {
      userInitiated: false,
    });
    usePanelLayoutStore.getState().disposeLayout(key);
  });

  it('a closed recovery panel destroys nothing and stays pending for next launch', async () => {
    const { worktreeId, key } = nextWorktree();
    browserApi.loadWorktreeState.mockRejectedValueOnce(new Error('corrupt'));
    const raw = legacyLayoutFile(key);
    const plan = await prepareBrowserPanelMigration(key, raw);
    const migrated = migratePanelLayout(plan.layout);
    usePanelLayoutStore.getState().restoreLayout(key, migrated);

    // The user closes the recovery panel.
    usePanelLayoutStore
      .getState()
      .closeTab(key, 'group-main', 'panel-legacy-browser');

    browserApi.loadWorktreeState.mockResolvedValue({
      state: persistedState(worktreeId, ['b1'], 'b1'),
    });
    await useBrowserStore.getState().hydrateWorktree(PROJECT_ID, worktreeId);
    await completeBrowserMigrationRecovery(PROJECT_ID, worktreeId);

    // No panel to rebind: the untouched files re-enter recovery next launch.
    expect(browserApi.destroy).not.toHaveBeenCalled();
    expect(browserApi.saveWorktreeState).not.toHaveBeenCalled();
    expect(resumePanelLayoutPersistence).not.toHaveBeenCalled();
    expect(hasPendingBrowserMigrationRecovery(key)).toBe(true);
    usePanelLayoutStore.getState().disposeLayout(key);
  });
});

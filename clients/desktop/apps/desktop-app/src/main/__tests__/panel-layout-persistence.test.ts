// Panel-layout persistence (Phase 5) — mirrors the terminal persistence test
// posture: real fs under a temp CANOPY_DATA_DIR, versioned file shape,
// debounced sync writes, raw parsed loads for renderer-side migration. The final block
// proves worktree-data cleanup removes both panel persistence files (they live
// inside the `worktree-data/{worktreeId}` tree that
// `cleanupPersistedWorktreeData`'s "worktree metadata" task deletes
// recursively).
jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupWorktreeChatPluginDirs: jest.fn(),
}));
jest.mock('../observability/worktree-cleanup', () => ({
  purgePersistedWorktreeObservabilityData: jest.fn(() => Promise.resolve()),
}));
jest.mock('../browser/browser-service-registry', () => ({
  getBrowserService: jest.fn(() => null),
}));
jest.mock('../lib/plan-persistence', () => ({
  deleteTrackedPlansForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/detected-plan-persistence', () => ({
  deleteDetectedPlansForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/script-log-store', () => ({
  deleteScriptRunLogsForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/hook-log-store', () => ({
  deleteHookRunLogsForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
  })),
}));

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SerializablePanelLayoutFile } from '@canopy/protocol/panels';
import { initializePanelLayoutModeFile } from '@canopy/desktop-shared/node/lib/panel-layout-mode';
import {
  getWorktreeDataDir,
  getWorktreePanelLayoutModeFilePath,
  getWorktreePanelLayoutFilePath,
} from '../lib/paths';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import { PanelLayoutPersistenceStore } from '../panels/persistence';

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'wt-1';

function makeLayoutFile(): SerializablePanelLayoutFile {
  return {
    version: 1,
    grid: {
      root: {
        type: 'branch',
        size: 800,
        children: [
          {
            type: 'leaf',
            groupId: 'group-chat',
            panels: [{ panelId: 'panel-chat', kind: 'chat' }],
            activePanelId: 'panel-chat',
            size: 860,
          },
          {
            type: 'leaf',
            groupId: 'group-activity',
            panels: [{ panelId: 'panel-activity', kind: 'activity-section' }],
            activePanelId: 'panel-activity',
            size: 340,
          },
        ],
      },
      orientation: 1,
      width: 1200,
      height: 800,
    },
    activeGroupId: 'group-chat',
    mostRecentActiveGroupIds: ['group-chat', 'group-activity'],
  };
}

describe('PanelLayoutPersistenceStore', () => {
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  let tempDataDir = '';

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), 'canopy-panel-layout-persist-'));
    process.env.CANOPY_DATA_DIR = tempDataDir;
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('persists the layout under worktree-data as a version-1 file', () => {
    const store = new PanelLayoutPersistenceStore();
    const layout = makeLayoutFile();

    store.saveWorktreeLayout(PROJECT_ID, WORKTREE_ID, layout);
    store.flushAllSync();

    const filePath = getWorktreePanelLayoutFilePath(PROJECT_ID, WORKTREE_ID);
    expect(filePath).toBe(
      join(getWorktreeDataDir(PROJECT_ID, WORKTREE_ID), 'panel-layout.json'),
    );
    expect(existsSync(filePath)).toBe(true);

    const persisted: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(persisted).toEqual({ ...layout, hasUserChanges: true });
    expect(store.loadWorktreeLayout(PROJECT_ID, WORKTREE_ID)).toEqual({
      ...layout,
      hasUserChanges: true,
    });
  });

  it('debounces writes and flushes on the 100ms timer', () => {
    jest.useFakeTimers();
    const store = new PanelLayoutPersistenceStore();
    const filePath = getWorktreePanelLayoutFilePath(PROJECT_ID, WORKTREE_ID);

    store.saveWorktreeLayout(PROJECT_ID, WORKTREE_ID, makeLayoutFile());
    expect(existsSync(filePath)).toBe(false);

    // A save inside the debounce window replaces the pending payload; only
    // the latest layout lands on disk.
    const updated: SerializablePanelLayoutFile = {
      ...makeLayoutFile(),
      activeGroupId: 'group-activity',
    };
    store.saveWorktreeLayout(PROJECT_ID, WORKTREE_ID, updated);
    expect(existsSync(filePath)).toBe(false);

    // Load-before-flush returns the pending payload, not stale disk state.
    expect(store.loadWorktreeLayout(PROJECT_ID, WORKTREE_ID)).toEqual({
      ...updated,
      hasUserChanges: true,
    });

    jest.advanceTimersByTime(100);
    expect(existsSync(filePath)).toBe(true);
    const persisted: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(persisted).toEqual({ ...updated, hasUserChanges: true });
  });

  it('returns null for a missing file', () => {
    const store = new PanelLayoutPersistenceStore();
    expect(store.loadWorktreeLayout(PROJECT_ID, WORKTREE_ID)).toBeNull();
  });

  it('returns null for invalid JSON and raw parsed data before validation', () => {
    const store = new PanelLayoutPersistenceStore();
    const filePath = getWorktreePanelLayoutFilePath(PROJECT_ID, WORKTREE_ID);
    mkdirSync(dirname(filePath), { recursive: true });

    writeFileSync(filePath, 'not json {', 'utf8');
    expect(store.loadWorktreeLayout(PROJECT_ID, WORKTREE_ID)).toBeNull();

    // Forward-versioned and structurally invalid files must reach the renderer
    // unchanged so its pre-validation migration can inspect historical shapes.
    const forward = { ...makeLayoutFile(), version: 999 };
    writeFileSync(filePath, JSON.stringify(forward), 'utf8');
    expect(store.loadWorktreeLayout(PROJECT_ID, WORKTREE_ID)).toEqual(forward);

    const invalid = { version: 1 };
    writeFileSync(filePath, JSON.stringify(invalid), 'utf8');
    expect(store.loadWorktreeLayout(PROJECT_ID, WORKTREE_ID)).toEqual(invalid);
  });

  it('returns a legacy unbound Browser layout for renderer migration', () => {
    const store = new PanelLayoutPersistenceStore();
    const filePath = getWorktreePanelLayoutFilePath(PROJECT_ID, WORKTREE_ID);
    mkdirSync(dirname(filePath), { recursive: true });
    const legacyLayout = {
      ...makeLayoutFile(),
      grid: {
        ...makeLayoutFile().grid,
        root: {
          type: 'leaf',
          groupId: 'group-browser',
          panels: [{ panelId: 'panel-browser', kind: 'browser' }],
          activePanelId: 'panel-browser',
          size: 800,
        },
      },
      activeGroupId: 'group-browser',
      mostRecentActiveGroupIds: ['group-browser'],
    };
    writeFileSync(filePath, JSON.stringify(legacyLayout), 'utf8');

    expect(store.loadWorktreeLayout(PROJECT_ID, WORKTREE_ID)).toEqual(
      legacyLayout,
    );
  });

  it('drops saves that fail migratePanelLayout validation', () => {
    const store = new PanelLayoutPersistenceStore();
    // Type-valid but semantically invalid: empty groupId fails the protocol
    // validator's non-empty-string check.
    const invalid: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        root: {
          type: 'leaf',
          groupId: '',
          panels: [],
          activePanelId: null,
          size: 100,
        },
        orientation: 1,
        width: 100,
        height: 100,
      },
      activeGroupId: 'group-chat',
      mostRecentActiveGroupIds: [],
    };

    store.saveWorktreeLayout(PROJECT_ID, WORKTREE_ID, invalid);
    store.flushAllSync();

    expect(
      existsSync(getWorktreePanelLayoutFilePath(PROJECT_ID, WORKTREE_ID)),
    ).toBe(false);
  });

  it('deleteWorktreeLayout removes the file and cancels pending writes', () => {
    jest.useFakeTimers();
    const store = new PanelLayoutPersistenceStore();
    const filePath = getWorktreePanelLayoutFilePath(PROJECT_ID, WORKTREE_ID);

    // Flushed file is removed.
    store.saveWorktreeLayout(PROJECT_ID, WORKTREE_ID, makeLayoutFile());
    store.flushAllSync();
    expect(existsSync(filePath)).toBe(true);
    store.deleteWorktreeLayout(PROJECT_ID, WORKTREE_ID);
    expect(existsSync(filePath)).toBe(false);

    // A pending debounced write is cancelled, not resurrected by the timer.
    store.saveWorktreeLayout(PROJECT_ID, WORKTREE_ID, makeLayoutFile());
    store.deleteWorktreeLayout(PROJECT_ID, WORKTREE_ID);
    jest.advanceTimersByTime(1000);
    expect(existsSync(filePath)).toBe(false);
    expect(store.loadWorktreeLayout(PROJECT_ID, WORKTREE_ID)).toBeNull();
  });

  it('worktree-data cleanup removes the persisted panel layout and mode', async () => {
    const store = new PanelLayoutPersistenceStore();
    store.saveWorktreeLayout(PROJECT_ID, WORKTREE_ID, makeLayoutFile());
    store.flushAllSync();

    const filePath = getWorktreePanelLayoutFilePath(PROJECT_ID, WORKTREE_ID);
    const modeFilePath = getWorktreePanelLayoutModeFilePath(
      PROJECT_ID,
      WORKTREE_ID,
    );
    await initializePanelLayoutModeFile(
      {
        workspaceId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        filePath: modeFilePath,
      },
      'minimal',
    );
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(modeFilePath)).toBe(true);

    const warnings = await cleanupPersistedWorktreeData(
      PROJECT_ID,
      WORKTREE_ID,
    );

    expect(warnings).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(modeFilePath)).toBe(false);
    expect(store.loadWorktreeLayout(PROJECT_ID, WORKTREE_ID)).toBeNull();
  });
});

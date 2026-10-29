// CAN-3807: a manifest-only metadata change (sort mode, Always show, start
// page) must stale the desktop session snapshot like an index commit does,
// even with no portal session. Runs the real structural sync and snapshot
// invalidation against a temporary data dir; only the portal is mocked off.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  isCanopyPortalActive: jest.fn(() => false),
  notifyPortalStructureChanged: jest.fn(),
  pushPortalOverviewSnapshot: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MultiRepoSidebarItem,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { pushPortalOverviewSnapshot } from '../../portal/portal-event-bus';
import { cancelPortalStructuralSync } from '../../portal/portal-structural-sync';
import {
  cancelDesktopSessionSnapshotInvalidation,
  subscribeDesktopSessionSnapshotInvalidation,
} from '../../services/desktop-session-snapshot-invalidation';
import {
  __resetSidebarItemsStateForTests,
  writeAllSidebarItems,
} from '../sidebar-items';
import {
  updateWorkspaceMetadata,
  type WorkspaceMetadataPatch,
} from '../workspace-metadata';

/** Well past the 50 ms invalidation delay, short enough to fail fast. */
const STALE_TIMEOUT_MS = 1_000;

function multiRepoItem(id: string): MultiRepoSidebarItem {
  return {
    id,
    name: `Project ${id}`,
    type: 'multi-repo',
    color: '#0EA5E9',
    collapsed: false,
    order: 0,
    repos: [],
    worktrees: [],
  };
}

const SEEDED: SidebarItem[] = [multiRepoItem('gamma')];

describe('workspace metadata snapshot invalidation (real fs, no portal)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let staleCount: number;
  let notifyStale: () => void;

  /** Resolves once the next snapshot invalidation reaches subscribers. */
  function nextStale(): Promise<boolean> {
    const before = staleCount;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), STALE_TIMEOUT_MS);
      notifyStale = (): void => {
        if (staleCount > before) {
          clearTimeout(timeout);
          resolve(true);
        }
      };
    });
  }

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-metadata-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems(SEEDED);
    // Drop the seed write's pending invalidation so only the update counts.
    cancelDesktopSessionSnapshotInvalidation();
    cancelPortalStructuralSync();
    staleCount = 0;
    notifyStale = (): void => {};
    subscribeDesktopSessionSnapshotInvalidation((): void => {
      staleCount += 1;
      notifyStale();
    });
    jest.clearAllMocks();
  });

  afterEach(async () => {
    cancelDesktopSessionSnapshotInvalidation();
    cancelPortalStructuralSync();
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it.each<[string, WorkspaceMetadataPatch]>([
    ['the sort mode', { itemSortMode: 'last-updated' }],
    ['Always show', { alwaysShow: false }],
    [
      'the start page',
      { startPage: { kind: 'set', startPage: { kind: 'file', path: 'a.md' } } },
    ],
    ['an inherited start page', { startPage: { kind: 'inherit' } }],
  ])(
    'stales the snapshot after a manifest-only change of %s',
    async (_label, patch) => {
      const stale = nextStale();

      const outcome = await updateWorkspaceMetadata({
        workspaceId: 'gamma',
        patch,
        source: 'desktop_canopy_client',
      });

      expect(outcome).toEqual({
        workspaceId: 'gamma',
        indexWritten: false,
        manifestWritten: true,
      });
      expect(await stale).toBe(true);
      // No portal session: nothing is pushed, the snapshot is still staled.
      expect(pushPortalOverviewSnapshot).not.toHaveBeenCalled();
    },
  );

  it('stales the snapshot once for an index and manifest change', async () => {
    const stale = nextStale();

    await updateWorkspaceMetadata({
      workspaceId: 'gamma',
      patch: { name: 'Gamma', itemSortMode: 'last-updated' },
      source: 'desktop_canopy_client',
    });

    expect(await stale).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(staleCount).toBe(1);
  });

  it('does not stale the snapshot for an update that writes nothing', async () => {
    const stale = nextStale();

    await updateWorkspaceMetadata({
      workspaceId: 'gamma',
      patch: {},
      source: 'desktop_canopy_client',
    });

    expect(await stale).toBe(false);
  });
});

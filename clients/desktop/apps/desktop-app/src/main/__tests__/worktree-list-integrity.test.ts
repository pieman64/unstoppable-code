import '../../__tests__/worktree-replica-compatibility';
// CAN-3803: the worktree list repository keeps data this version cannot read
// and refuses every write over an unreadable `worktrees.json`, whether or not
// the sidebar-group reconciler is installed. Runs the real workspace
// persistence module against a temporary data dir.
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
// Lets a test fail the next worktree list write at the checked writer.
let mockFailNextListWrite = false;
jest.mock('../lib/atomic-file', () => {
  const actual =
    jest.requireActual<typeof AtomicFileModule>('../lib/atomic-file');
  return {
    ...actual,
    writeFileAtomically: jest.fn(
      (...args: Parameters<typeof actual.writeFileAtomically>) => {
        if (
          mockFailNextListWrite &&
          String(args[0]).endsWith('worktrees.json')
        ) {
          mockFailNextListWrite = false;
          return Promise.reject(new Error('ENOSPC: no space left on device'));
        }
        return actual.writeFileAtomically(...args);
      },
    ),
  };
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import type * as AtomicFileModule from '../lib/atomic-file';
import {
  getSidebarItemGroupsFilePath,
  getWorkspaceWorktreesFilePath,
} from '../lib/paths';
import {
  clearWorktreesSelfWriteTracking,
  readWorkspaceWorktreesDetailed,
  removeWorkspaceWorktrees,
  restoreWorkspaceWorktrees,
  setWorktreeRegistryReconciler,
  updateWorkspaceWorktree,
  updateWorkspaceWorktrees,
  wasRecentWorktreesSelfWrite,
  writeWorkspaceWorktrees,
  WorktreeRegistryUnreadableError,
} from '../lib/workspace-persistence';
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import { initializeSidebarItemGroups } from '../services/sidebar-item-groups-service';

const WORKSPACE_ID = 'project';
const TRUNCATED = '{"version":1,"worktrees":[';

function row(id: string, extra: Record<string, unknown> = {}): WorktreeData {
  return {
    id,
    branchName: `branch-${id}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

describe('worktree list integrity (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let listPath: string;

  async function writeList(document: unknown): Promise<void> {
    await mkdir(path.dirname(listPath), { recursive: true });
    await writeFile(listPath, JSON.stringify(document, null, 2));
  }

  async function readList(): Promise<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(await readFile(listPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Expected a worktree list object');
    }
    return { ...parsed };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFailNextListWrite = false;
    clearWorktreesSelfWriteTracking(WORKSPACE_ID);
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-worktree-list-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    listPath = getWorkspaceWorktreesFilePath(WORKSPACE_ID);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('unknown data', () => {
    beforeEach(async () => {
      await writeList({
        version: 1,
        futureTopLevel: { enabled: true },
        worktrees: [row('otter', { futureRowField: 'kept' }), row('heron')],
      });
    });

    it('keeps unknown file and row fields through a targeted update', async () => {
      expect(
        await updateWorkspaceWorktree(WORKSPACE_ID, 'heron', (worktree) => ({
          ...worktree,
          label: 'Heron',
        })),
      ).toBe(true);

      const list = await readList();
      expect(list.futureTopLevel).toEqual({ enabled: true });
      expect(list.worktrees).toEqual([
        row('otter', { futureRowField: 'kept' }),
        row('heron', { label: 'Heron' }),
      ]);
    });

    it('keeps unknown row fields a whole-list save does not carry', async () => {
      await writeWorkspaceWorktrees(WORKSPACE_ID, [
        row('otter', { label: 'Otter' }),
        row('heron'),
      ]);

      const list = await readList();
      expect(list.futureTopLevel).toEqual({ enabled: true });
      expect(list.worktrees).toEqual([
        row('otter', { futureRowField: 'kept' }),
        row('heron'),
      ]);
    });
  });

  describe('an unreadable worktree list', () => {
    beforeEach(async () => {
      await mkdir(path.dirname(listPath), { recursive: true });
      await writeFile(listPath, TRUNCATED);
    });

    async function expectRefused(write: () => Promise<unknown>): Promise<void> {
      await expect(write()).rejects.toBeInstanceOf(
        WorktreeRegistryUnreadableError,
      );
      expect(await readFile(listPath, 'utf8')).toBe(TRUNCATED);
    }

    it('reads as unreadable, never as an empty list', async () => {
      expect(await readWorkspaceWorktreesDetailed(WORKSPACE_ID)).toEqual({
        worktrees: [],
        authority: 'unreadable',
      });
    });

    it('refuses a whole-list save', async () => {
      await expectRefused(() =>
        writeWorkspaceWorktrees(WORKSPACE_ID, [row('otter')]),
      );
    });

    it('refuses a targeted update that adds a row', async () => {
      await expectRefused(() =>
        updateWorkspaceWorktrees(WORKSPACE_ID, (worktrees) => [
          row('otter'),
          ...worktrees,
        ]),
      );
    });

    it('refuses a restore', async () => {
      await expectRefused(() =>
        restoreWorkspaceWorktrees(WORKSPACE_ID, [row('otter')]),
      );
    });
  });

  it('reports a list with a row it cannot read as partial, and keeps the row', async () => {
    const partialRow = { id: 'partial', branchName: 'branch-partial' };
    await writeList({ version: 1, worktrees: [row('otter'), partialRow] });

    expect(await readWorkspaceWorktreesDetailed(WORKSPACE_ID)).toEqual({
      worktrees: [row('otter')],
      authority: 'partial',
    });
    await updateWorkspaceWorktree(WORKSPACE_ID, 'otter', (worktree) => ({
      ...worktree,
      label: 'Otter',
    }));
    expect((await readList()).worktrees).toEqual([
      row('otter', { label: 'Otter' }),
      partialRow,
    ]);
  });

  it('creates a missing worktree list on the first write', async () => {
    await updateWorkspaceWorktrees(WORKSPACE_ID, () => [row('otter')]);

    expect(await readList()).toEqual({ version: 1, worktrees: [row('otter')] });
  });

  it('keeps both a targeted update and a removal over a racing stale whole-list save', async () => {
    await writeList({ version: 1, worktrees: [row('otter'), row('heron')] });
    const stale = [row('otter'), row('heron')];

    await Promise.all([
      updateWorkspaceWorktree(WORKSPACE_ID, 'otter', (worktree) => ({
        ...worktree,
        pinned: true,
      })),
      removeWorkspaceWorktrees(
        WORKSPACE_ID,
        (worktree) => worktree.id === 'heron',
      ),
      writeWorkspaceWorktrees(WORKSPACE_ID, stale),
    ]);

    expect((await readList()).worktrees).toEqual([
      row('otter', { pinned: true }),
    ]);
  });

  describe('sidebar-group reconciliation', () => {
    const beforeWrite = jest.fn((): Promise<void> => Promise.resolve());
    const rollback = jest.fn((): Promise<void> => Promise.resolve());
    const afterWrite = jest.fn((): Promise<void> => Promise.resolve());

    beforeEach(async () => {
      await writeList({ version: 1, worktrees: [row('otter')] });
      setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
        Promise.resolve({ rows: next, beforeWrite, rollback, afterWrite }),
      );
    });

    afterEach(() => {
      setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
        Promise.resolve({ rows: next }),
      );
    });

    it('rolls back the group pre-write when the list write fails and announces nothing', async () => {
      const before = await readFile(listPath, 'utf8');
      mockFailNextListWrite = true;

      await expect(
        updateWorkspaceWorktrees(WORKSPACE_ID, (worktrees) => [
          ...worktrees,
          row('swift'),
        ]),
      ).rejects.toThrow('ENOSPC');

      expect(await readFile(listPath, 'utf8')).toBe(before);
      expect(beforeWrite).toHaveBeenCalledTimes(1);
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(afterWrite).not.toHaveBeenCalled();
      expect(schedulePortalStructuralSync).not.toHaveBeenCalled();
      expect(wasRecentWorktreesSelfWrite(WORKSPACE_ID)).toBe(false);
    });

    it('still invalidates readers when membership fails after the list commits', async () => {
      afterWrite.mockRejectedValueOnce(new Error('membership write failed'));

      await expect(
        updateWorkspaceWorktrees(WORKSPACE_ID, (worktrees) => [
          ...worktrees,
          row('swift'),
        ]),
      ).rejects.toThrow('membership write failed');

      expect((await readList()).worktrees).toEqual([
        row('otter'),
        row('swift'),
      ]);
      expect(rollback).not.toHaveBeenCalled();
      expect(schedulePortalStructuralSync).toHaveBeenCalled();
      expect(notifyPortalStructureChanged).toHaveBeenCalled();
      expect(wasRecentWorktreesSelfWrite(WORKSPACE_ID)).toBe(true);
    });
  });

  describe('sidebar groups on a partial list', () => {
    const partialRow = { id: 'partial', branchName: 'branch-partial' };

    function group(id: string, memberIds: string[]): Record<string, unknown> {
      return { id, name: id, color: 'neutral', collapsed: false, memberIds };
    }

    beforeEach(async () => {
      initializeSidebarItemGroups();
      await writeList({
        version: 1,
        worktrees: [row('otter'), row('swan'), partialRow],
      });
      await writeFile(
        getSidebarItemGroupsFilePath(WORKSPACE_ID),
        JSON.stringify({
          version: 1,
          groups: [
            group('grp-hidden', ['partial']),
            group('grp-otter', ['otter']),
          ],
        }),
      );
    });

    afterEach(() => {
      setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
        Promise.resolve({ rows: next }),
      );
    });

    it('keeps the group membership of a row it cannot read', async () => {
      await updateWorkspaceWorktree(WORKSPACE_ID, 'swan', (worktree) => ({
        ...worktree,
        label: 'Swan',
      }));

      const groups: unknown = JSON.parse(
        await readFile(getSidebarItemGroupsFilePath(WORKSPACE_ID), 'utf8'),
      );
      // Reconciliation saves navigation order while retaining unreadable members.
      expect(groups).toEqual({
        version: 1,
        groups: [
          group('grp-otter', ['otter']),
          group('grp-hidden', ['partial']),
        ],
      });
      expect((await readList()).worktrees).toContainEqual(partialRow);
    });

    it('refuses a write that requires an authoritative read', async () => {
      await expect(
        updateWorkspaceWorktrees(WORKSPACE_ID, (worktrees) => worktrees, {
          requireAuthoritativeRead: true,
        }),
      ).rejects.toBeInstanceOf(WorktreeRegistryUnreadableError);
    });
  });
});

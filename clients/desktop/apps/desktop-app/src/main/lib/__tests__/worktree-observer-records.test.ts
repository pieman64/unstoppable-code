import '../../../__tests__/worktree-replica-compatibility';
// CAN-3821: the typed in-process observer commands for worktree activity,
// chat badges and seen pipeline results. Runs the real workspace persistence
// module against a temporary data dir and counts the W5 file store's reads
// and writes, because activity recording is a hot path.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../../services/foreign-activity-sources', () => ({
  markForeignPipelineResultsSeen: jest.fn(),
}));

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  type WorktreeChatBadgesSummary,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { markForeignPipelineResultsSeen } from '../../services/foreign-activity-sources';
import { getWorkspaceWorktreesFilePath } from '../paths';
import { nodeW5FileStore } from '../w5-file-store';
import {
  clearWorktreesSelfWriteTracking,
  readWorkspaceWorktrees,
  writeWorkspaceWorktrees,
} from '../workspace-persistence';
import { registerWorkspaceTypes } from '../workspace-registry';
import {
  chatBadgesSummariesEquivalent,
  recordWorktreeActivity,
  recordWorktreeChatBadges,
  WorktreeObserverRecordRefusedError,
} from '../worktree-observer-records';

const WORKSPACE_ID = 'project';
const CREATED_AT = '2026-10-01T00:00:00.000Z';

function row(id: string, extra: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id,
    branchName: `branch-${id}`,
    createdAt: CREATED_AT,
    ...extra,
  };
}

function badges(
  overrides: Partial<WorktreeChatBadgesSummary> = {},
): WorktreeChatBadgesSummary {
  return {
    version: 2,
    unreadChats: [],
    approvalChats: [],
    needsHydration: false,
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('worktree observer records (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;
  let listPath: string;

  async function writeList(worktrees: unknown[]): Promise<void> {
    await mkdir(path.dirname(listPath), { recursive: true });
    await writeFile(
      listPath,
      JSON.stringify({ version: 1, worktrees }, null, 2),
    );
  }

  async function readRow(id: string): Promise<WorktreeData | undefined> {
    const worktrees = await readWorkspaceWorktrees(WORKSPACE_ID);
    return worktrees.find((worktree) => worktree.id === id);
  }

  function countFileStore(): { reads: () => number; writes: () => number } {
    const read = jest.spyOn(nodeW5FileStore, 'read');
    const replace = jest.spyOn(nodeW5FileStore, 'replace');
    const forList = (calls: unknown[][]): number =>
      calls.filter((call) => call[0] === listPath).length;
    return {
      reads: () => forList(read.mock.calls),
      writes: () => forList(replace.mock.calls),
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    registerWorkspaceTypes(new Map([[WORKSPACE_ID, 'single-repo']]));
    clearWorktreesSelfWriteTracking(WORKSPACE_ID);
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-observer-records-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    listPath = getWorkspaceWorktreesFilePath(WORKSPACE_ID);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    registerWorkspaceTypes(new Map());
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('internal.worktree.activity.record', () => {
    it('advances the watermark with one read and one write, and returns the committed row', async () => {
      await writeList([
        row('a', { lastTouchedAt: '2026-10-01T00:00:00.000Z' }),
        row('b'),
      ]);
      const counts = countFileStore();

      const outcome = await recordWorktreeActivity({
        source: 'activity_watermark',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'a',
        touchedAt: '2026-10-05T12:00:00.000Z',
      });

      expect(outcome.changed).toBe(true);
      expect(outcome.worktrees).toEqual([
        row('a', { lastTouchedAt: '2026-10-05T12:00:00.000Z' }),
      ]);
      expect(counts.reads()).toBe(1);
      expect(counts.writes()).toBe(1);
      expect((await readRow('a'))?.lastTouchedAt).toBe(
        '2026-10-05T12:00:00.000Z',
      );
      expect((await readRow('b'))?.lastTouchedAt).toBeUndefined();
    });

    it('never moves the watermark backward and writes nothing for an older or equal touch', async () => {
      await writeList([
        row('a', { lastTouchedAt: '2026-10-05T12:00:00.000Z' }),
      ]);
      const counts = countFileStore();

      for (const touchedAt of [
        '2026-10-05T12:00:00.000Z',
        '2026-10-04T00:00:00.000Z',
      ]) {
        const outcome = await recordWorktreeActivity({
          source: 'activity_watermark',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'a',
          touchedAt,
        });
        expect(outcome.changed).toBe(false);
        expect(outcome.worktrees[0]?.lastTouchedAt).toBe(
          '2026-10-05T12:00:00.000Z',
        );
      }
      expect(counts.writes()).toBe(0);
    });

    it('is a no-op for an unknown worktree and never creates a list or row', async () => {
      const counts = countFileStore();
      const absent = await recordWorktreeActivity({
        source: 'activity_watermark',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'missing',
        touchedAt: '2026-10-05T12:00:00.000Z',
      });
      expect(absent).toEqual({ worktrees: [], changed: false });
      await expect(readFile(listPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      await writeList([row('a')]);
      const unknown = await recordWorktreeActivity({
        source: 'activity_watermark',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'missing',
        touchedAt: '2026-10-05T12:00:00.000Z',
      });
      expect(unknown).toEqual({ worktrees: [], changed: false });
      expect(counts.writes()).toBe(0);
      expect(await readWorkspaceWorktrees(WORKSPACE_ID)).toEqual([row('a')]);
    });

    it('refuses Cowork and app-managed workspaces before reading, since they have no worktree list', async () => {
      registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
      const counts = countFileStore();
      for (const workspaceId of ['cowork-1', APP_ADVISOR_PROJECT_ID]) {
        await expect(
          recordWorktreeActivity({
            source: 'activity_watermark',
            workspaceId,
            worktreeId: 'entry',
            touchedAt: '2026-10-05T12:00:00.000Z',
          }),
        ).rejects.toMatchObject({
          name: 'WorktreeObserverRecordRefusedError',
          reason: 'work-entry-workspace',
        });
        await expect(
          recordWorktreeActivity({
            source: 'auto_delete_baseline',
            workspaceId,
            touchedAt: '2026-10-05T12:00:00.000Z',
          }),
        ).rejects.toBeInstanceOf(WorktreeObserverRecordRefusedError);
      }
      expect(counts.reads()).toBe(0);
    });

    it('refuses an invalid timestamp before reading', async () => {
      await writeList([row('a')]);
      const counts = countFileStore();
      await expect(
        recordWorktreeActivity({
          source: 'activity_watermark',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'a',
          touchedAt: 'not a time',
        }),
      ).rejects.toMatchObject({ reason: 'invalid-timestamp' });
      expect(counts.reads()).toBe(0);
    });

    it('records an Auto Delete baseline for every row in one write without moving a newer watermark back', async () => {
      await writeList([
        row('legacy'),
        row('older', { lastTouchedAt: '2026-10-01T00:00:00.000Z' }),
        row('newer', { lastTouchedAt: '2026-10-09T00:00:00.000Z' }),
      ]);
      const counts = countFileStore();

      const outcome = await recordWorktreeActivity({
        source: 'auto_delete_baseline',
        workspaceId: WORKSPACE_ID,
        touchedAt: '2026-10-05T00:00:00.000Z',
      });

      expect(outcome.changed).toBe(true);
      expect(
        outcome.worktrees.map((worktree) => worktree.lastTouchedAt),
      ).toEqual([
        '2026-10-05T00:00:00.000Z',
        '2026-10-05T00:00:00.000Z',
        '2026-10-09T00:00:00.000Z',
      ]);
      expect(counts.writes()).toBe(1);

      const repeat = await recordWorktreeActivity({
        source: 'auto_delete_baseline',
        workspaceId: WORKSPACE_ID,
        touchedAt: '2026-10-05T00:00:00.000Z',
      });
      expect(repeat.changed).toBe(false);
      expect(counts.writes()).toBe(1);
    });

    it('reports a failed write instead of a projection that was never committed', async () => {
      await writeList([row('a')]);
      jest
        .spyOn(nodeW5FileStore, 'replace')
        .mockRejectedValueOnce(new Error('disk full'));

      await expect(
        recordWorktreeActivity({
          source: 'activity_watermark',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'a',
          touchedAt: '2026-10-05T12:00:00.000Z',
        }),
      ).rejects.toThrow('disk full');
      expect((await readRow('a'))?.lastTouchedAt).toBeUndefined();
    });
  });

  describe('internal.worktree.chatBadges.record', () => {
    it('records a changed summary from a chat commit and skips an equivalent one', async () => {
      await writeList([row('a')]);
      const counts = countFileStore();
      const unread = badges({ unreadChats: [{ chatId: 'chat-1' }] });

      const recorded = await recordWorktreeChatBadges({
        source: 'chat_commit',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'a',
        summary: unread,
      });
      expect(recorded).toEqual({ status: 'recorded' });
      expect((await readRow('a'))?.chatBadges).toEqual(unread);

      const repeat = await recordWorktreeChatBadges({
        source: 'chat_commit',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'a',
        summary: { ...unread, updatedAt: '2026-10-03T00:00:00.000Z' },
      });
      expect(repeat).toEqual({ status: 'unchanged' });
      expect(counts.writes()).toBe(1);
    });

    it('keeps a deliberate clear, and does not write an empty summary into a row that has none', async () => {
      await writeList([
        row('cleared', {
          chatBadges: badges({ unreadChats: [{ chatId: 'chat-1' }] }),
        }),
        row('legacy'),
      ]);

      expect(
        await recordWorktreeChatBadges({
          source: 'chat_commit',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'cleared',
          summary: badges(),
        }),
      ).toEqual({ status: 'recorded' });
      expect((await readRow('cleared'))?.chatBadges).toEqual(badges());

      expect(
        await recordWorktreeChatBadges({
          source: 'chat_commit',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'legacy',
          summary: badges(),
        }),
      ).toEqual({ status: 'unchanged' });
      expect((await readRow('legacy'))?.chatBadges).toBeUndefined();
    });

    it('fills a missing summary at launch, upgrades an older one without replacing its badges, and leaves a current one', async () => {
      const older = badges({
        version: 1,
        unreadChats: [{ chatId: 'live-unread' }],
      });
      const current = badges({ unreadChats: [{ chatId: 'current' }] });
      await writeList([
        row('missing'),
        row('older', { chatBadges: older }),
        row('current', { chatBadges: current }),
      ]);
      const derived = badges({ chatName: 'Add dark mode' });

      for (const [worktreeId, status] of [
        ['missing', 'recorded'],
        ['older', 'recorded'],
        ['current', 'unchanged'],
      ] as const) {
        expect(
          await recordWorktreeChatBadges({
            source: 'launch_backfill',
            workspaceId: WORKSPACE_ID,
            worktreeId,
            summary: derived,
          }),
        ).toEqual({ status });
      }

      expect((await readRow('missing'))?.chatBadges).toEqual(derived);
      expect((await readRow('older'))?.chatBadges).toEqual({
        ...older,
        version: 2,
        chatName: 'Add dark mode',
      });
      expect((await readRow('current'))?.chatBadges).toEqual(current);
    });

    it('is a no-op for an unknown worktree and refuses Cowork and app-managed workspaces', async () => {
      await writeList([row('a')]);
      const counts = countFileStore();
      expect(
        await recordWorktreeChatBadges({
          source: 'chat_commit',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'missing',
          summary: badges({ unreadChats: [{ chatId: 'chat-1' }] }),
        }),
      ).toEqual({ status: 'not-found' });
      expect(counts.writes()).toBe(0);

      registerWorkspaceTypes(new Map([['cowork-1', 'cowork']]));
      for (const workspaceId of ['cowork-1', APP_ADVISOR_PROJECT_ID]) {
        await expect(
          recordWorktreeChatBadges({
            source: 'chat_commit',
            workspaceId,
            worktreeId: 'entry',
            summary: badges(),
          }),
        ).rejects.toMatchObject({ reason: 'work-entry-workspace' });
      }
    });

    it('treats an absent summary as empty when comparing', () => {
      expect(chatBadgesSummariesEquivalent(undefined, badges())).toBe(true);
      expect(
        chatBadgesSummariesEquivalent(
          undefined,
          badges({ unreadChats: [{ chatId: 'chat-1' }] }),
        ),
      ).toBe(false);
    });
  });

  describe('internal.worktree.pipelineResults.markSeen through a sidebar save', () => {
    it('applies the seen and unseen executions of a save and announces only the newly seen ones after the commit', async () => {
      await writeList([
        row('a', { seenPipelineExecutionIds: ['run-1', 'run-2'] }),
        row('b'),
      ]);

      await writeWorkspaceWorktrees(WORKSPACE_ID, [
        row('a', { seenPipelineExecutionIds: ['run-2', 'run-3'] }),
        row('b', { seenPipelineExecutionIds: ['run-9'] }),
      ]);

      expect((await readRow('a'))?.seenPipelineExecutionIds).toEqual([
        'run-2',
        'run-3',
      ]);
      expect((await readRow('b'))?.seenPipelineExecutionIds).toEqual(['run-9']);
      expect(jest.mocked(markForeignPipelineResultsSeen).mock.calls).toEqual([
        [WORKSPACE_ID, 'a', ['run-3']],
        [WORKSPACE_ID, 'b', ['run-9']],
      ]);
    });

    it('drops the field when every execution is unseen', async () => {
      await writeList([row('a', { seenPipelineExecutionIds: ['run-1'] })]);
      await writeWorkspaceWorktrees(WORKSPACE_ID, [row('a')]);
      const persisted = await readRow('a');
      expect(persisted).toEqual(row('a'));
      expect(markForeignPipelineResultsSeen).not.toHaveBeenCalled();
    });

    it('announces nothing when the save is not committed', async () => {
      await writeList([row('a')]);
      jest
        .spyOn(nodeW5FileStore, 'replace')
        .mockRejectedValueOnce(new Error('disk full'));
      await expect(
        writeWorkspaceWorktrees(WORKSPACE_ID, [
          row('a', { seenPipelineExecutionIds: ['run-1'] }),
        ]),
      ).rejects.toThrow('disk full');
      expect(markForeignPipelineResultsSeen).not.toHaveBeenCalled();
    });
  });

  describe('against stale sidebar saves and each other', () => {
    it('keeps recorded activity and badges, including a deliberate badge clear, across a stale whole-list save', async () => {
      const staleBadges = badges({ unreadChats: [{ chatId: 'chat-1' }] });
      await writeList([
        row('a', {
          lastTouchedAt: '2026-10-01T00:00:00.000Z',
          chatBadges: staleBadges,
        }),
      ]);
      const staleSnapshot = await readWorkspaceWorktrees(WORKSPACE_ID);

      await recordWorktreeActivity({
        source: 'activity_watermark',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'a',
        touchedAt: '2026-10-05T12:00:00.000Z',
      });
      await recordWorktreeChatBadges({
        source: 'chat_commit',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'a',
        summary: badges(),
      });
      await writeWorkspaceWorktrees(
        WORKSPACE_ID,
        staleSnapshot.map((worktree) => ({
          ...worktree,
          seenPipelineExecutionIds: ['run-1'],
        })),
      );

      const persisted = await readRow('a');
      expect(persisted?.seenPipelineExecutionIds).toEqual(['run-1']);
      expect(persisted?.lastTouchedAt).toBe('2026-10-05T12:00:00.000Z');
      expect(persisted?.chatBadges).toEqual(badges());
    });

    it('keeps every one of several simultaneous independent records', async () => {
      await writeList([row('a'), row('b')]);
      const unreadA = badges({ unreadChats: [{ chatId: 'chat-a' }] });
      const unreadB = badges({ unreadChats: [{ chatId: 'chat-b' }] });

      await Promise.all([
        recordWorktreeActivity({
          source: 'activity_watermark',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'a',
          touchedAt: '2026-10-05T12:00:00.000Z',
        }),
        recordWorktreeChatBadges({
          source: 'chat_commit',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'a',
          summary: unreadA,
        }),
        recordWorktreeActivity({
          source: 'activity_watermark',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'b',
          touchedAt: '2026-10-06T12:00:00.000Z',
        }),
        recordWorktreeChatBadges({
          source: 'chat_commit',
          workspaceId: WORKSPACE_ID,
          worktreeId: 'b',
          summary: unreadB,
        }),
      ]);

      expect(await readWorkspaceWorktrees(WORKSPACE_ID)).toEqual([
        row('a', {
          lastTouchedAt: '2026-10-05T12:00:00.000Z',
          chatBadges: unreadA,
        }),
        row('b', {
          lastTouchedAt: '2026-10-06T12:00:00.000Z',
          chatBadges: unreadB,
        }),
      ]);
    });
  });
});

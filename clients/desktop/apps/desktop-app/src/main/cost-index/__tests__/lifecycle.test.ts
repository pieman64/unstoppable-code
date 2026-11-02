/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await -- Jest host fixtures use deliberately minimal async mocks. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchivedContainerManifestV1 } from '@canopy/desktop-shared/types';
import {
  archivedContainerSummaryWithCost,
  prepareEntryCostArchive,
  finishEntryCostArchive,
  removeEntryCost,
  restoreEntryCostArchive,
} from '../lifecycle';

let root: string;
const refreshInternal = jest.fn(() => Promise.resolve());
const sealScope = jest.fn(() => Promise.resolve());
const retireScope = jest.fn(() => Promise.resolve());
const restoreScope = jest.fn(() => Promise.resolve());
const resumeScope = jest.fn(() => Promise.resolve());
jest.mock('../service', () => ({
  CostServiceError: class extends Error {},
  getDesktopCostIndexStore: () => ({
    refreshInternal,
    sealScope,
    retireScope,
    restoreScope,
    resumeScope,
  }),
}));
jest.mock('../../lib/paths', () => ({
  getEntryCostDir: (projectId: string, scopeId: string) =>
    join(
      root,
      projectId === 'app-advisor' ? 'app-workspaces' : 'workspaces',
      projectId,
      'cost',
      scopeId,
    ),
  getArchivedContainerCostDir: (projectId: string, scopeId: string) =>
    join(
      root,
      projectId === 'app-advisor' ? 'app-workspaces' : 'workspaces',
      projectId,
      'archived-containers',
      scopeId,
      'cost',
    ),
}));
import { getArchivedContainerCostDir, getEntryCostDir } from '../../lib/paths';

describe.each([
  ['Code worktree', 'code-project', 'worktree'],
  ['Cowork Work Entry', 'cowork-project', 'work-entry'],
  ['App Advisor Work Entry', 'app-advisor', 'work-entry'],
] as const)('%s cost lifecycle seam', (_label, projectId, kind) => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cost-lifecycle-'));
    jest.clearAllMocks();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function manifest(): ArchivedContainerManifestV1 {
    return {
      version: 1,
      id: 'entry-1',
      projectId,
      kind,
      name: 'Entry',
      createdAt: '2026-10-01T00:00:00.000Z',
      archivedAt: '2026-10-08T00:00:00.000Z',
      expiresAt: '2026-10-15T00:00:00.000Z',
      retentionDays: 7,
      chatCount: 1,
      archivedChatCount: 0,
      executionCount: 0,
    };
  }

  it('flush/catch-up finishes before every record is sealed for capture', async () => {
    const order: string[] = [];
    refreshInternal.mockImplementationOnce(async () => {
      order.push('flush-and-ingest');
    });
    sealScope.mockImplementationOnce(async () => {
      order.push('seal');
    });
    await prepareEntryCostArchive(projectId, 'entry-1');
    expect(order).toEqual(['flush-and-ingest', 'seal']);
    expect(refreshInternal).toHaveBeenCalledWith('archive', {
      kind: 'entry',
      projectId,
      worktreeId: 'entry-1',
    });
  });

  it('reopens only the canonical live scope after capture, including rollback', async () => {
    await finishEntryCostArchive(projectId, 'entry-1');
    expect(resumeScope).toHaveBeenCalledWith({
      kind: 'entry',
      projectId,
      worktreeId: 'entry-1',
    });
  });

  it('restores retained bytes under the destination identity before resuming refresh', async () => {
    const directory = getArchivedContainerCostDir(projectId, 'entry-1');
    await mkdir(join(directory, 'chats'), { recursive: true });
    const bytes = '{"version":1,"chatId":"chat-1","records":{}}\n';
    await writeFile(join(directory, 'chats', 'chat-1.json'), bytes);
    await restoreEntryCostArchive(
      projectId,
      'entry-1',
      'restored-1',
      '2026-10-09T00:00:00.000Z',
    );
    expect(
      await readFile(
        join(getEntryCostDir(projectId, 'restored-1'), 'chats', 'chat-1.json'),
        'utf8',
      ),
    ).toBe(bytes);
    expect(restoreScope).toHaveBeenCalledWith(
      getEntryCostDir(projectId, 'restored-1'),
      { kind: 'entry', projectId, worktreeId: 'restored-1' },
      '2026-10-09T00:00:00.000Z',
    );
    expect(
      await readFile(join(directory, 'chats', 'chat-1.json'), 'utf8'),
    ).toBe(bytes);
    await removeEntryCost(projectId, 'restored-1');
    expect(retireScope).toHaveBeenCalledWith({
      kind: 'entry',
      projectId,
      worktreeId: 'restored-1',
    });
    await expect(
      readFile(
        join(getEntryCostDir(projectId, 'restored-1'), 'chats', 'chat-1.json'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('joins the sealed total for either archived or deleted without modifying payload bytes', async () => {
    const directory = getArchivedContainerCostDir(projectId, 'entry-1');
    await mkdir(directory, { recursive: true });
    const bytes = JSON.stringify({
      version: 1,
      incarnation: manifest().createdAt,
      sealedAt: manifest().archivedAt,
      totals: { usd: 2.5 },
      chats: [{ chatId: 'chat-1' }],
      pipelineRuns: [],
    });
    await writeFile(join(directory, 'summary.json'), bytes);
    expect(
      (await archivedContainerSummaryWithCost(manifest())).observedCostUsd,
    ).toBe(2.5);
    expect(
      (
        await archivedContainerSummaryWithCost({
          ...manifest(),
          lockedAt: manifest().archivedAt,
        })
      ).observedCostUsd,
    ).toBe(2.5);
    expect(await readFile(join(directory, 'summary.json'), 'utf8')).toBe(bytes);
    expect(
      (
        await archivedContainerSummaryWithCost({
          ...manifest(),
          createdAt: '2026-10-09T00:00:00.000Z',
        })
      ).observedCostUsd,
    ).toBeUndefined();
  });

  describe('a cost failure never blocks the entry lifecycle', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it('lets an archive proceed when the catch-up or the seal fails', async () => {
      refreshInternal.mockRejectedValueOnce(new Error('audit flush failed'));
      await expect(
        prepareEntryCostArchive(projectId, 'entry-1'),
      ).resolves.toBeUndefined();
      expect(sealScope).not.toHaveBeenCalled();

      sealScope.mockRejectedValueOnce(new Error('disk full'));
      await expect(
        prepareEntryCostArchive(projectId, 'entry-1'),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('lets an archive finish when the live scope cannot be reopened', async () => {
      resumeScope.mockRejectedValueOnce(new Error('store is down'));
      await expect(
        finishEntryCostArchive(projectId, 'entry-1'),
      ).resolves.toBeUndefined();
    });

    it('lets a restore proceed when the retained cost cannot be adopted', async () => {
      const directory = getArchivedContainerCostDir(projectId, 'entry-1');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'summary.json'), '{}');
      restoreScope.mockRejectedValueOnce(new Error('bad incarnation'));

      await expect(
        restoreEntryCostArchive(
          projectId,
          'entry-1',
          'restored-1',
          '2026-10-09T00:00:00.000Z',
        ),
      ).resolves.toBeUndefined();
    });

    it('still removes the live cost files when the store cannot retire the scope', async () => {
      const directory = getEntryCostDir(projectId, 'entry-1');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'summary.json'), '{}');
      retireScope.mockRejectedValueOnce(new Error('store is down'));

      await removeEntryCost(projectId, 'entry-1');

      await expect(
        readFile(join(directory, 'summary.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('lists an archived entry without a cost when its cost file cannot be read', async () => {
      // A directory where the summary file should be: a read error that is
      // not "missing".
      await mkdir(
        join(getArchivedContainerCostDir(projectId, 'entry-1'), 'summary.json'),
        { recursive: true },
      );

      const summary = await archivedContainerSummaryWithCost(manifest());

      expect(summary.id).toBe('entry-1');
      expect(summary.observedCostUsd).toBeUndefined();
    });
  });

  it('keeps absent cost absent and does not create a directory on reads', async () => {
    expect(
      (await archivedContainerSummaryWithCost(manifest())).observedCostUsd,
    ).toBeUndefined();
    await expect(
      readFile(
        join(getArchivedContainerCostDir(projectId, 'entry-1'), 'summary.json'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

jest.mock('node:fs/promises');

jest.mock('../lib/resolve-worktree', () => ({
  resolveDetectedPlansFilePath: jest.fn(),
}));

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type {
  DetectedPlanEntry,
  DetectedPlansFile,
} from '@canopy/desktop-shared/types';
import { resolveDetectedPlansFilePath } from '../lib/resolve-worktree';
import {
  readDetectedPlans,
  appendDetectedPlans,
  updateDetectedPlan,
  markBannerSeenForChat,
  deleteDetectedPlansForWorktree,
} from '../lib/detected-plan-persistence';

const mockedMkdir = jest.mocked(mkdir);
const mockedReadFile = jest.mocked(readFile);
const mockedRm = jest.mocked(rm);
const mockedWriteFile = jest.mocked(writeFile);
const mockedResolveDetectedPlansFilePath = jest.mocked(
  resolveDetectedPlansFilePath,
);

function makeEntry(
  overrides: Partial<DetectedPlanEntry> = {},
): DetectedPlanEntry {
  return {
    id: 'entry-1',
    sourceRepoId: 'repo-a',
    sourceFilePath: 'plans/my-plan.md',
    status: 'detected',
    bannerSeen: false,
    detectedInChatId: 'chat-1',
    detectedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDetectedPlansFile(
  entries: DetectedPlanEntry[],
): DetectedPlansFile {
  return { version: 1, entries };
}

describe('detected plan persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveDetectedPlansFilePath.mockReturnValue(
      '/tmp/project-a/detected-plans/wt-1.json',
    );
    mockedMkdir.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
  });

  it('dedupes by sourceRepoId+sourceFilePath on append', async () => {
    const existing = makeEntry({ id: 'entry-1', status: 'detected' });
    const file = makeDetectedPlansFile([existing]);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const duplicate = makeEntry({ id: 'entry-2', status: 'dismissed' });
    const result = await appendDetectedPlans('project-a', 'wt-1', [duplicate]);

    // The second append with same repo+path is a no-op: entry-1 is kept
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('entry-1');
    expect(result[0]?.status).toBe('detected');
  });

  it('updateDetectedPlan patches status, bannerSeen, and importedPlanId', async () => {
    const entry = makeEntry({ id: 'entry-1' });
    const file = makeDetectedPlansFile([entry]);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const result = await updateDetectedPlan('project-a', 'wt-1', 'entry-1', {
      status: 'imported',
      bannerSeen: true,
      importedPlanId: 'plan-xyz',
    });

    const updated = result.find((e) => e.id === 'entry-1');
    expect(updated?.status).toBe('imported');
    expect(updated?.bannerSeen).toBe(true);
    expect(updated?.importedPlanId).toBe('plan-xyz');
    expect(mockedWriteFile).toHaveBeenCalled();
  });

  it('markBannerSeenForChat sets bannerSeen only for matching chat+status=detected', async () => {
    const match = makeEntry({
      id: 'entry-match',
      detectedInChatId: 'chat-1',
      status: 'detected',
      bannerSeen: false,
    });
    const dismissed = makeEntry({
      id: 'entry-dismissed',
      detectedInChatId: 'chat-1',
      status: 'dismissed',
      bannerSeen: false,
    });
    const otherChat = makeEntry({
      id: 'entry-other',
      detectedInChatId: 'chat-2',
      status: 'detected',
      bannerSeen: false,
    });
    const file = makeDetectedPlansFile([match, dismissed, otherChat]);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const result = await markBannerSeenForChat('project-a', 'wt-1', 'chat-1');

    const matchResult = result.find((e) => e.id === 'entry-match');
    const dismissedResult = result.find((e) => e.id === 'entry-dismissed');
    const otherResult = result.find((e) => e.id === 'entry-other');

    // Only the detected+chat-1 entry gets bannerSeen:true
    expect(matchResult?.bannerSeen).toBe(true);
    // dismissed entry is unaffected
    expect(dismissedResult?.bannerSeen).toBe(false);
    // other chat is unaffected
    expect(otherResult?.bannerSeen).toBe(false);
  });

  it('round-trips detected plan entries through read', async () => {
    const entry = makeEntry({
      id: 'entry-roundtrip',
      importedPlanId: 'plan-abc',
    });
    const file = makeDetectedPlansFile([entry]);
    mockedReadFile.mockResolvedValue(JSON.stringify(file));

    const result = await readDetectedPlans('project-a', 'wt-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'entry-roundtrip',
      sourceRepoId: 'repo-a',
      sourceFilePath: 'plans/my-plan.md',
      importedPlanId: 'plan-abc',
    });
  });

  it('deletes the file when the entry list becomes empty', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    // appendDetectedPlans with no new entries and empty on-disk state → rm
    await appendDetectedPlans('project-a', 'wt-1', []);

    expect(mockedRm).toHaveBeenCalledWith(
      '/tmp/project-a/detected-plans/wt-1.json',
      { force: true },
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('deleteDetectedPlansForWorktree removes the file unconditionally', async () => {
    await deleteDetectedPlansForWorktree('project-a', 'wt-1');

    expect(mockedRm).toHaveBeenCalledWith(
      '/tmp/project-a/detected-plans/wt-1.json',
      { force: true },
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedMkdir).not.toHaveBeenCalled();
  });
});

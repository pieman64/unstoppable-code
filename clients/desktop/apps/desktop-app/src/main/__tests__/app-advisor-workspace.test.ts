import { mkdtempSync, readlinkSync, rmSync } from 'node:fs';
jest.mock('../lib/archived-containers', () => ({
  withArchivedWorkspaceOperationLock: jest.fn(
    (_workspaceId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));
jest.mock('../lib/workspace-activity', () => ({
  touchAllWorkspaceTargets: jest.fn().mockResolvedValue(undefined),
}));

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import {
  applyAppAdvisorArchiveRetention,
  ensureAppAdvisorHomeScaffold,
  loadAppAdvisorWorkspaceSettings,
  readAppAdvisorClaudeMd,
  readAppAdvisorWorkspaceSettings,
  saveAppAdvisorClaudeMd,
  saveAppAdvisorWorkspaceSettings,
} from '../lib/app-advisor-workspace';
import { createWorkEntry, listWorkEntryIds } from '../lib/cowork-work-entries';
import {
  getAppAdvisorHomeDir,
  getAppAdvisorSettingsFilePath,
  getAppManagedChatWorkspaceDir,
  getWorkspaceChatArchivesFilePath,
  getWorkspaceConfigPath,
} from '../lib/paths';
import { readChatArchivesFile } from '../lib/chat-archives';
import { withArchivedWorkspaceOperationLock } from '../lib/archived-containers';
import { touchAllWorkspaceTargets } from '../lib/workspace-activity';
import {
  getChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';

const originalDataDir = process.env.CANOPY_DATA_DIR;
const mockedWithArchivedWorkspaceOperationLock = jest.mocked(
  withArchivedWorkspaceOperationLock,
);
const mockedTouchAllWorkspaceTargets = jest.mocked(touchAllWorkspaceTargets);
let tempDataDir = '';

beforeEach(() => {
  resetChatStateServiceForTests();
  tempDataDir = mkdtempSync(join(tmpdir(), 'app-advisor-workspace-'));
  process.env.CANOPY_DATA_DIR = tempDataDir;
});

afterEach(async () => {
  await getChatStateService().drain();
  resetChatStateServiceForTests();
  rmSync(tempDataDir, { recursive: true, force: true });
});

afterAll(() => {
  if (originalDataDir === undefined) {
    delete process.env.CANOPY_DATA_DIR;
  } else {
    process.env.CANOPY_DATA_DIR = originalDataDir;
  }
});

async function writeArchives(
  entryId: string,
  archivedAt: string[],
): Promise<void> {
  const filePath = getWorkspaceChatArchivesFilePath(
    APP_ADVISOR_PROJECT_ID,
    entryId,
  );
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      archived: archivedAt.map((date, index) => ({
        tab: {
          id: `${entryId}-chat-${String(index)}`,
          title: 'Archived',
          createdAt: date,
          messages: [],
        },
        archivedAt: date,
        turnCount: 0,
      })),
    }),
    'utf8',
  );
  resetChatStateServiceForTests();
}

describe('App Advisor project persistence', () => {
  it('scaffolds the shared home idempotently without creating workspace.json', async () => {
    await ensureAppAdvisorHomeScaffold();
    const home = getAppAdvisorHomeDir();
    await writeFile(join(home, 'CLAUDE.md'), 'custom instructions', 'utf8');
    await ensureAppAdvisorHomeScaffold();

    await expect(readFile(join(home, 'CLAUDE.md'), 'utf8')).resolves.toBe(
      'custom instructions',
    );
    expect(readlinkSync(join(home, 'AGENTS.md'))).toBe('CLAUDE.md');
    for (const subdir of ['notes', 'prompts', 'attachments'] as const) {
      expect(
        (await stat(getCoworkManagedSubdir(home, subdir))).isDirectory(),
      ).toBe(true);
    }
    await expect(
      readFile(getWorkspaceConfigPath(APP_ADVISOR_PROJECT_ID), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('defaults missing and malformed settings and round-trips normalized values', async () => {
    expect(dirname(getAppAdvisorSettingsFilePath())).toBe(
      getAppManagedChatWorkspaceDir(APP_ADVISOR_PROJECT_ID),
    );
    expect(dirname(getAppAdvisorSettingsFilePath())).not.toBe(
      getAppAdvisorHomeDir(),
    );
    await expect(readAppAdvisorWorkspaceSettings()).resolves.toEqual({
      version: 1,
      archiveRetentionDays: null,
      autoArchiveDays: null,
    });
    await mkdir(dirname(getAppAdvisorSettingsFilePath()), { recursive: true });
    await writeFile(getAppAdvisorSettingsFilePath(), 'not json', 'utf8');
    await expect(readAppAdvisorWorkspaceSettings()).resolves.toEqual({
      version: 1,
      archiveRetentionDays: null,
      autoArchiveDays: null,
    });
    await writeFile(
      getAppAdvisorSettingsFilePath(),
      JSON.stringify({ version: 1, archiveRetentionDays: 0.5 }),
      'utf8',
    );
    await expect(readAppAdvisorWorkspaceSettings()).resolves.toEqual({
      version: 1,
      archiveRetentionDays: null,
      autoArchiveDays: null,
    });

    await expect(
      saveAppAdvisorWorkspaceSettings({
        description: 'Project description',
        archiveRetentionDays: 14,
      }),
    ).resolves.toEqual({
      version: 1,
      description: 'Project description',
      archiveRetentionDays: 14,
      autoArchiveDays: null,
    });
    await expect(readAppAdvisorWorkspaceSettings()).resolves.toEqual({
      version: 1,
      description: 'Project description',
      archiveRetentionDays: 14,
      autoArchiveDays: null,
    });

    await expect(
      saveAppAdvisorWorkspaceSettings({ archiveRetentionDays: 30 }),
    ).resolves.toEqual({
      version: 1,
      description: 'Project description',
      archiveRetentionDays: 30,
      autoArchiveDays: null,
    });
    await expect(
      saveAppAdvisorWorkspaceSettings({ description: 'Updated description' }),
    ).resolves.toEqual({
      version: 1,
      description: 'Updated description',
      archiveRetentionDays: 30,
      autoArchiveDays: null,
    });
  });

  it('serializes enabling Auto Delete and its activity baseline', async () => {
    await saveAppAdvisorWorkspaceSettings({ autoArchiveDays: 7 });

    expect(mockedWithArchivedWorkspaceOperationLock).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      expect.any(Function),
    );
    expect(mockedTouchAllWorkspaceTargets).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
    );
  });

  it('preserves overlapping partial settings updates', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      mockedWithArchivedWorkspaceOperationLock.mockImplementationOnce(
        async (_workspaceId, operation) => {
          resolve();
          await new Promise<void>((release) => {
            releaseFirst = release;
          });
          return operation();
        },
      );
    });
    const descriptionSave = saveAppAdvisorWorkspaceSettings({
      description: 'Concurrent description',
    });
    await firstEntered;
    const retentionSave = saveAppAdvisorWorkspaceSettings({
      archiveRetentionDays: 30,
    });
    await retentionSave;
    releaseFirst?.();
    await descriptionSave;

    await expect(readAppAdvisorWorkspaceSettings()).resolves.toMatchObject({
      description: 'Concurrent description',
      archiveRetentionDays: 30,
    });
  });

  it('does not publish App Advisor Auto Delete enablement when baseline seeding fails', async () => {
    mockedTouchAllWorkspaceTargets.mockRejectedValueOnce(
      new Error('baseline failed'),
    );

    await expect(
      saveAppAdvisorWorkspaceSettings({ autoArchiveDays: 7 }),
    ).rejects.toThrow('baseline failed');

    await expect(readAppAdvisorWorkspaceSettings()).resolves.toEqual({
      version: 1,
      archiveRetentionDays: null,
      autoArchiveDays: null,
    });
  });

  it('loads and saves CLAUDE.md while repairing the AGENTS.md link', async () => {
    await ensureAppAdvisorHomeScaffold();
    rmSync(join(getAppAdvisorHomeDir(), 'AGENTS.md'), { force: true });
    await saveAppAdvisorClaudeMd('replacement');

    await expect(readAppAdvisorClaudeMd()).resolves.toBe('replacement');
    expect(readlinkSync(join(getAppAdvisorHomeDir(), 'AGENTS.md'))).toBe(
      'CLAUDE.md',
    );
  });

  it('applies deletion retention to every entry and the legacy global slot on load', async () => {
    await createWorkEntry(APP_ADVISOR_PROJECT_ID, {
      id: 'entry-one',
      createdAt: new Date().toISOString(),
    });
    const oldDate = new Date(
      Date.now() - 5 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const recentDate = new Date().toISOString();
    await Promise.all([
      writeArchives('entry-one', [oldDate, recentDate]),
      writeArchives(APP_ADVISOR_WORKTREE_ID, [oldDate, recentDate]),
    ]);
    await expect(listWorkEntryIds(APP_ADVISOR_PROJECT_ID)).resolves.toEqual([
      'entry-one',
    ]);
    await saveAppAdvisorWorkspaceSettings({ archiveRetentionDays: 1 });

    await loadAppAdvisorWorkspaceSettings();

    await expect(
      readChatArchivesFile(APP_ADVISOR_PROJECT_ID, 'entry-one'),
    ).resolves.toMatchObject({ archived: [{ archivedAt: recentDate }] });
    await expect(
      readChatArchivesFile(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID),
    ).resolves.toMatchObject({ archived: [{ archivedAt: recentDate }] });
  });

  it('does not prune archives when retention is disabled', async () => {
    await writeArchives(APP_ADVISOR_WORKTREE_ID, [new Date(0).toISOString()]);
    await saveAppAdvisorWorkspaceSettings({ archiveRetentionDays: null });
    await applyAppAdvisorArchiveRetention();

    await expect(
      readChatArchivesFile(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID),
    ).resolves.toMatchObject({
      archived: [{ archivedAt: new Date(0).toISOString() }],
    });
  });
});

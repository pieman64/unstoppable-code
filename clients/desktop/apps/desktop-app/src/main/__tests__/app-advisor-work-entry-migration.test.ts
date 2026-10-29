import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { readChatArchivesFile } from '../lib/chat-archives';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  type ChatTabsFile,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_WORK_ENTRIES_MIGRATION_KEY,
  migrateAppAdvisorChatsToWorkEntries,
} from '../lib/app-advisor-work-entry-migration';
import { splitFlatChatTabsIntoEntries } from '../lib/cowork-work-entry-migration';
import {
  listWorkEntryIds,
  readWorkEntriesFile,
} from '../lib/cowork-work-entries';
import { hasMigrationRun } from '../lib/migrations';
import {
  getChatPluginsRootDir,
  getWorkspaceChatArchivesFilePath,
  getWorkspaceChatTabsFilePath,
  getWorkspaceWorkEntriesFilePath,
} from '../lib/paths';

const originalDataDir = process.env.CANOPY_DATA_DIR;
let tempDataDir = '';

function tab(id: string, kind: 'chat' | 'file' = 'chat'): PersistedChatTab {
  return {
    id,
    title: id,
    kind,
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: [],
  };
}

async function writeLegacyTabs(tabs: PersistedChatTab[]): Promise<void> {
  const filePath = getWorkspaceChatTabsFilePath(
    APP_ADVISOR_PROJECT_ID,
    APP_ADVISOR_WORKTREE_ID,
  );
  await mkdir(dirname(filePath), { recursive: true });
  const file: ChatTabsFile = {
    version: 1,
    tabs,
    activeTabId: tabs[0]?.id ?? '',
  };
  await writeFile(filePath, JSON.stringify(file), 'utf8');
}

beforeEach(() => {
  tempDataDir = mkdtempSync(join(tmpdir(), 'app-advisor-entry-migration-'));
  process.env.CANOPY_DATA_DIR = tempDataDir;
});

afterEach(() => {
  rmSync(tempDataDir, { recursive: true, force: true });
});

afterAll(() => {
  if (originalDataDir === undefined) {
    delete process.env.CANOPY_DATA_DIR;
  } else {
    process.env.CANOPY_DATA_DIR = originalDataDir;
  }
});

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('App Advisor Work Entry migration', () => {
  it('splits legacy chats, handles duplicate and global ids, and preserves legacy stores', async () => {
    await writeLegacyTabs([
      tab('chat-a'),
      tab('chat-a'),
      tab(APP_ADVISOR_WORKTREE_ID),
      tab('file-view', 'file'),
    ]);
    const legacyArchive = getWorkspaceChatArchivesFilePath(
      APP_ADVISOR_PROJECT_ID,
      APP_ADVISOR_WORKTREE_ID,
    );
    const legacyWorktreeData = join(
      tempDataDir,
      'app-workspaces/app-advisor/worktree-data/global/keep.txt',
    );
    const legacyAttachment = join(
      tempDataDir,
      'app-workspaces/app-advisor/attachments/global/keep.txt',
    );
    await Promise.all([
      mkdir(dirname(legacyArchive), { recursive: true }).then(() =>
        writeFile(legacyArchive, '{"version":1,"archived":[]}', 'utf8'),
      ),
      mkdir(dirname(legacyWorktreeData), { recursive: true }).then(() =>
        writeFile(legacyWorktreeData, 'keep', 'utf8'),
      ),
      mkdir(dirname(legacyAttachment), { recursive: true }).then(() =>
        writeFile(legacyAttachment, 'keep', 'utf8'),
      ),
    ]);

    await migrateAppAdvisorChatsToWorkEntries();

    const ids = await listWorkEntryIds(APP_ADVISOR_PROJECT_ID);
    expect(ids.filter((id) => id === 'chat-a')).toHaveLength(1);
    const collisionId = ids.find((id) => id.startsWith('migrated-global-'));
    expect(collisionId).toBeDefined();
    expect(ids).toHaveLength(2);
    expect(
      (await readChatTabsFile(APP_ADVISOR_PROJECT_ID, 'chat-a')).tabs.map(
        (tab) => tab.id,
      ),
    ).toContain('chat-a');
    expect(
      (
        await readChatArchivesFile(
          APP_ADVISOR_PROJECT_ID,
          APP_ADVISOR_WORKTREE_ID,
        )
      ).archived.map((entry) => entry.tab.id),
    ).toEqual([]);
    await expect(readFile(legacyArchive)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(legacyWorktreeData, 'utf8')).resolves.toBe('keep');
    await expect(readFile(legacyAttachment, 'utf8')).resolves.toBe('keep');
    await expect(
      readFile(
        getWorkspaceChatTabsFilePath(
          APP_ADVISOR_PROJECT_ID,
          APP_ADVISOR_WORKTREE_ID,
        ),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      hasMigrationRun(APP_ADVISOR_WORK_ENTRIES_MIGRATION_KEY),
    ).resolves.toBe(true);
  });

  it('writes registry rows before source removal and resumes after a crash', async () => {
    await writeLegacyTabs([tab('chat-crash')]);
    const removeLegacySource = jest.fn(async (): Promise<void> => {
      await expect(
        readWorkEntriesFile(APP_ADVISOR_PROJECT_ID),
      ).resolves.toMatchObject({ entries: [{ id: 'chat-crash' }] });
      throw new Error('simulated crash');
    });

    await expect(
      splitFlatChatTabsIntoEntries(
        APP_ADVISOR_PROJECT_ID,
        APP_ADVISOR_WORKTREE_ID,
        { removeLegacySource },
      ),
    ).rejects.toThrow('simulated crash');

    await migrateAppAdvisorChatsToWorkEntries();
    await expect(listWorkEntryIds(APP_ADVISOR_PROJECT_ID)).resolves.toEqual([
      'chat-crash',
    ]);
  });

  it('treats plugin movement failures as best effort', async () => {
    await writeLegacyTabs([tab('chat-plugin')]);
    const pluginDir = join(
      getChatPluginsRootDir(),
      APP_ADVISOR_PROJECT_ID,
      APP_ADVISOR_WORKTREE_ID,
      'chat-plugin',
    );
    await mkdir(pluginDir, { recursive: true });

    await expect(
      splitFlatChatTabsIntoEntries(
        APP_ADVISOR_PROJECT_ID,
        APP_ADVISOR_WORKTREE_ID,
        { renamePath: jest.fn().mockRejectedValue(new Error('move failed')) },
      ),
    ).resolves.toBeUndefined();
    await expect(listWorkEntryIds(APP_ADVISOR_PROJECT_ID)).resolves.toEqual([
      'chat-plugin',
    ]);
  });

  it('marks a fresh install without creating a registry or entry', async () => {
    await migrateAppAdvisorChatsToWorkEntries();

    await expect(listWorkEntryIds(APP_ADVISOR_PROJECT_ID)).resolves.toEqual([]);
    await expect(
      readFile(getWorkspaceWorkEntriesFilePath(APP_ADVISOR_PROJECT_ID), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await migrateAppAdvisorChatsToWorkEntries();
    await expect(listWorkEntryIds(APP_ADVISOR_PROJECT_ID)).resolves.toEqual([]);
  });
});

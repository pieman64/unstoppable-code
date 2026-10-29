// The `cowork_work_entries` startup migration runs before the first window
// opens, so it must not wait on a full sidebar projection. Projecting a
// source-backed multi-repo project resolves its repo scripts, which can
// create a default-branch checkout and wait up to 30s per call on
// `git ls-remote` against the project's remote. On hosts where that remote
// call hangs, no window appeared at all. The migration only needs the cowork
// project ids, which the workspace index already lists.

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  COWORK_HOME_WORKTREE_ID,
  type ChatTabsFile,
} from '@canopy/desktop-shared/types';
import type * as SidebarItems from '../lib/sidebar-items';

const readAllSidebarItemsCalls = { count: 0 };

jest.mock('../lib/sidebar-items', () => {
  const actual: typeof SidebarItems = jest.requireActual(
    '../lib/sidebar-items',
  );
  return {
    ...actual,
    // Stands in for a projection stuck on a remote git call.
    readAllSidebarItems: (): Promise<never> => {
      readAllSidebarItemsCalls.count += 1;
      return new Promise<never>(() => undefined);
    },
  };
});

let tempDataDir = '';
const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;

beforeAll(() => {
  tempDataDir = mkdtempSync(join(tmpdir(), 'canopy-cowork-migration-'));
  process.env.CANOPY_DATA_DIR = tempDataDir;
});

afterAll(() => {
  if (originalCanopyDataDir === undefined) {
    delete process.env.CANOPY_DATA_DIR;
  } else {
    process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
  }
  rmSync(tempDataDir, { recursive: true, force: true });
});

// Imported after the mock and CANOPY_DATA_DIR are in place.
import {
  COWORK_WORK_ENTRIES_MIGRATION_KEY,
  migrateCoworkChatsToWorkEntries,
} from '../lib/cowork-work-entry-migration';
import { listWorkEntryIds } from '../lib/cowork-work-entries';
import { hasMigrationRun } from '../lib/migrations';
import {
  getWorkspaceChatTabsFilePath,
  getWorkspaceIndexFilePath,
} from '../lib/paths';
import { isCoworkWorkspace } from '../lib/workspace-registry';

// Generous for a cold module load; a stuck projection never settles.
const SETTLE_TIMEOUT_MS = 10_000;

function settlesWithin<T>(promise: Promise<T>): Promise<T | 'timed-out'> {
  return Promise.race([
    promise,
    new Promise<'timed-out'>((resolve) => {
      setTimeout(() => resolve('timed-out'), SETTLE_TIMEOUT_MS);
    }),
  ]);
}

async function writeWorkspaceIndex(): Promise<void> {
  const indexPath = getWorkspaceIndexFilePath();
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(
    indexPath,
    JSON.stringify({
      version: 1,
      workspaces: [
        {
          id: 'cowork-ws',
          name: 'Chats',
          type: 'cowork',
          color: '#000000',
          order: 0,
        },
        {
          id: 'multi-repo-ws',
          name: 'Full stack',
          type: 'multi-repo',
          color: '#000000',
          order: 1,
        },
      ],
    }),
    'utf8',
  );
}

async function writeLegacyHomeChats(workspaceId: string): Promise<void> {
  const filePath = getWorkspaceChatTabsFilePath(
    workspaceId,
    COWORK_HOME_WORKTREE_ID,
  );
  await mkdir(dirname(filePath), { recursive: true });
  const file: ChatTabsFile = {
    version: 1,
    activeTabId: 'chat-a',
    tabs: [
      {
        id: 'chat-a',
        title: 'New Chat',
        createdAt: new Date(1_000).toISOString(),
        messages: [
          {
            id: 'chat-a-m1',
            role: 'user',
            timestamp: 1_000,
            blocks: [{ type: 'text', text: 'hello' }],
          },
        ],
      },
    ],
  };
  await writeFile(filePath, JSON.stringify(file), 'utf8');
}

it('splits cowork chats from the workspace index without projecting the sidebar', async () => {
  await writeWorkspaceIndex();
  await writeLegacyHomeChats('cowork-ws');

  await expect(settlesWithin(migrateCoworkChatsToWorkEntries())).resolves.toBe(
    undefined,
  );

  expect(readAllSidebarItemsCalls.count).toBe(0);
  await expect(listWorkEntryIds('cowork-ws')).resolves.toEqual(['chat-a']);
  await expect(
    hasMigrationRun(COWORK_WORK_ENTRIES_MIGRATION_KEY),
  ).resolves.toBe(true);
  // Workspace types still come from the index, as a sidebar read registers.
  expect(isCoworkWorkspace('cowork-ws')).toBe(true);
}, 30_000);

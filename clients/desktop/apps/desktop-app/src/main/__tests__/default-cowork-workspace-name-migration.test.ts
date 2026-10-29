import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { migrateDefaultCoworkWorkspaceName } from '../lib/default-cowork-workspace-name-migration';
import { hasMigrationRun } from '../lib/migrations';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { getWorkspaceIndexFilePath } from '../lib/paths';

const originalDataDir = process.env.CANOPY_DATA_DIR;
let tempDataDir = '';

function singleRepoItem(id: string, name: string, order: number): SidebarItem {
  return {
    id,
    name,
    type: 'single-repo',
    repoPath: `/repos/${id}`,
    color: '#123456',
    collapsed: false,
    order,
    worktrees: [],
  };
}

function coworkItem(id: string, name: string, order: number): SidebarItem {
  return {
    id,
    name,
    type: 'cowork',
    color: '#654321',
    collapsed: false,
    order,
  };
}

async function writeIndex(items: SidebarItem[]): Promise<void> {
  const filePath = getWorkspaceIndexFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({ version: 1, workspaces: items }),
    'utf8',
  );
}

/** Fields the `SidebarItem -> WorkspaceConfigFile` projection does not carry. */
async function writeCoworkConfig(id: string): Promise<void> {
  const dir = join(tempDataDir, 'workspaces', id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'cowork',
      repos: [],
      cowork: {
        createdAt: '2025-01-01T00:00:00.000Z',
        archiveRetentionDays: 7,
      },
      disabledGlobalPluginSelections: [{ key: 'plugin-a', kind: 'plugin' }],
      recommendedPluginOptOutKeys: ['rec-a'],
      planDetection: { mode: 'off' },
    }),
    'utf8',
  );
}

async function readCoworkConfig(id: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    await readFile(
      join(tempDataDir, 'workspaces', id, 'workspace.json'),
      'utf8',
    ),
  );
  return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
}

/** Ids exactly as persisted, bypassing the projection under test. */
async function readRawWorkspaceIds(): Promise<string[]> {
  const parsed: unknown = JSON.parse(
    await readFile(getWorkspaceIndexFilePath(), 'utf8'),
  );
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('workspaces' in parsed)
  )
    return [];
  const { workspaces } = parsed;
  if (!Array.isArray(workspaces)) return [];
  const ids: string[] = [];
  for (const entry of workspaces) {
    if (typeof entry !== 'object' || entry === null || !('id' in entry))
      continue;
    const id: unknown = Reflect.get(entry, 'id');
    if (typeof id === 'string') ids.push(id);
  }
  return ids;
}

async function readNames(): Promise<Record<string, string>> {
  const { items } = await readAllSidebarItems();
  return Object.fromEntries(items.map((item) => [item.id, item.name]));
}

beforeEach(() => {
  tempDataDir = mkdtempSync(join(tmpdir(), 'default-cowork-name-migration-'));
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

describe('default cowork workspace name migration', () => {
  it.each(['Personal', 'Default'])(
    'renames the auto-assigned %s name to Chats',
    async (legacyName) => {
      await writeIndex([
        coworkItem(DEFAULT_COWORK_WORKSPACE_ID, legacyName, 0),
        coworkItem('research', 'Research', 1),
      ]);

      await migrateDefaultCoworkWorkspaceName();

      const names = await readNames();
      expect(names[DEFAULT_COWORK_WORKSPACE_ID]).toBe('Chats');
      // Every other workspace is untouched — this migration owns one row.
      expect(names.research).toBe('Research');
      expect(await hasMigrationRun('default_cowork_workspace_chats_name')).toBe(
        true,
      );
    },
  );

  it('leaves a user-chosen name alone', async () => {
    await writeIndex([
      coworkItem(DEFAULT_COWORK_WORKSPACE_ID, 'Scratchpad', 0),
    ]);

    await migrateDefaultCoworkWorkspaceName();

    expect((await readNames())[DEFAULT_COWORK_WORKSPACE_ID]).toBe('Scratchpad');
  });

  it('does not overrule a rename back to the legacy name on a later launch', async () => {
    await writeIndex([coworkItem(DEFAULT_COWORK_WORKSPACE_ID, 'Personal', 0)]);
    await migrateDefaultCoworkWorkspaceName();
    expect((await readNames())[DEFAULT_COWORK_WORKSPACE_ID]).toBe('Chats');

    // The user renames it back; the marker means the migration is spent.
    await writeIndex([coworkItem(DEFAULT_COWORK_WORKSPACE_ID, 'Personal', 0)]);
    await migrateDefaultCoworkWorkspaceName();

    expect((await readNames())[DEFAULT_COWORK_WORKSPACE_ID]).toBe('Personal');
  });

  it('still marks itself run when the default workspace does not exist yet', async () => {
    // Fresh install: creation already uses the new name, so there is nothing
    // to rewrite and the migration must not re-read the index every launch.
    await writeIndex([coworkItem('research', 'Research', 0)]);

    await migrateDefaultCoworkWorkspaceName();

    expect((await readNames())[DEFAULT_COWORK_WORKSPACE_ID]).toBeUndefined();
    expect(await hasMigrationRun('default_cowork_workspace_chats_name')).toBe(
      true,
    );
  });

  it('never drops a workspace it could not project', async () => {
    // `readAllSidebarItems` silently omits a workspace whose `workspace.json`
    // is unreadable — with no warning, so it is not in the preserve list
    // either — and the default full-list write drops any current entry that is
    // neither incoming nor preserved. This migration runs once on every
    // upgrading install, so without `preserveUnmentionedWorkspaceIds` that
    // workspace would be deleted from the sidebar index permanently.
    await writeIndex([
      coworkItem(DEFAULT_COWORK_WORKSPACE_ID, 'Personal', 0),
      singleRepoItem('broken-repo', 'Broken Repo', 1),
    ]);

    await migrateDefaultCoworkWorkspaceName();

    // Read the raw index, not `readAllSidebarItems` — the projection is
    // exactly what drops the unreadable entry we are asserting survives.
    const ids = await readRawWorkspaceIds();

    expect(ids).toContain('broken-repo');
    expect(ids).toContain(DEFAULT_COWORK_WORKSPACE_ID);
  });

  it('leaves every workspace.json untouched', async () => {
    // A full sidebar write round-trips each config through a projection that
    // drops disabledGlobalPluginSelections, recommendedPluginOptOutKeys and
    // planDetection. This migration changes only the index entry's name, so
    // no config may be rewritten at all.
    await writeIndex([coworkItem(DEFAULT_COWORK_WORKSPACE_ID, 'Personal', 0)]);
    await writeCoworkConfig(DEFAULT_COWORK_WORKSPACE_ID);

    await migrateDefaultCoworkWorkspaceName();

    expect((await readNames())[DEFAULT_COWORK_WORKSPACE_ID]).toBe('Chats');
    const config = await readCoworkConfig(DEFAULT_COWORK_WORKSPACE_ID);
    expect(config.disabledGlobalPluginSelections).toEqual([
      { key: 'plugin-a', kind: 'plugin' },
    ]);
    expect(config.recommendedPluginOptOutKeys).toEqual(['rec-a']);
    expect(config.planDetection).toEqual({ mode: 'off' });
  });

  it('does not burn its one shot when the index is unreadable', async () => {
    // A corrupt index reads as zero entries, indistinguishable from a fresh
    // install. Marking here would leave that install stuck on the old name.
    const filePath = getWorkspaceIndexFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{ not json', 'utf8');

    await migrateDefaultCoworkWorkspaceName();

    expect(await hasMigrationRun('default_cowork_workspace_chats_name')).toBe(
      false,
    );
  });
});

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type * as NodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '@canopy/brand/current';

const mockGetCanopyDataDir = jest.fn<string, []>();

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: (): string => mockGetCanopyDataDir(),
}));

// `node:fs/promises`'s named exports are non-configurable, so they cannot be
// `jest.spyOn`-ed directly. Instead this mocks the whole module through to
// the real implementation, except `rename`, which is routed through a
// controllable mock so a single test can simulate an interrupted atomic
// rename without affecting any other test in this file (the default
// implementation below simply forwards to the real `rename`).
const mockRename = jest.fn<
  ReturnType<typeof NodeFsPromises.rename>,
  Parameters<typeof NodeFsPromises.rename>
>();

jest.mock('node:fs/promises', () => {
  const actual: typeof NodeFsPromises = jest.requireActual('node:fs/promises');
  return {
    ...actual,
    rename: (
      ...args: Parameters<typeof actual.rename>
    ): ReturnType<typeof actual.rename> => mockRename(...args),
  };
});

import { migrateStandaloneChatToCowork } from '../lib/cowork-migration';
import {
  coworkMigrationMapTestExports,
  getCoworkWorkspaceIdForLegacyChatProject,
} from '../lib/cowork-migration-map';
import { hasMigrationRun } from '../lib/migrations';
import { writeAllSidebarItems } from '../lib/sidebar-items';
import { isErrnoException, isRecord } from '../lib/type-guards';

const BRAND_DIR = BRAND.storage.projectConfigDirNames[0];
const UUID_ONE = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const UUID_TWO = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2';

async function writeTextFixture(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

async function writeJsonFixture(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeTextFixture(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Expected a JSON object');
  }
  return value;
}

describe('cowork project migration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'canopy-cowork-migration-'));
    mockGetCanopyDataDir.mockReturnValue(tempDir);
    coworkMigrationMapTestExports.resetCache();
    // Default `rename` to the real implementation for every test; a single
    // test overrides this for exactly one call via `mockImplementationOnce`
    // to simulate an interrupted atomic rename.
    const actual: typeof NodeFsPromises =
      jest.requireActual('node:fs/promises');
    mockRename.mockReset();
    mockRename.mockImplementation(actual.rename);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    mockGetCanopyDataDir.mockReset();
  });

  async function seedFullFixture(): Promise<{
    standaloneDir: string;
    defaultDir: string;
    attachmentAbsolutePath: string;
    noteAbsolutePath: string;
  }> {
    const standaloneDir = join(tempDir, 'standalone-chat');
    const defaultDir = join(standaloneDir, 'default');
    const attachmentAbsolutePath = join(
      defaultDir,
      'workspace',
      'attachments',
      'x.png',
    );
    const noteAbsolutePath = join(defaultDir, 'workspace', 'notes', 'note1.md');

    await writeJsonFixture(join(defaultDir, 'project.json'), {
      version: 1,
      id: 'default',
      name: 'Default',
      createdAt: '2026-01-01T00:00:00.000Z',
      color: 'blue',
      description: 'General purpose chats',
      defaultModel: 'claude-sonnet-4-5',
      defaultPresetId: 'preset-1',
      presets: [
        {
          id: 'preset-1',
          name: 'Preset One',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
        },
      ],
      projectPinnedContext: [
        {
          id: 'pin-1',
          kind: 'file',
          path: noteAbsolutePath,
          label: 'Note One',
          scope: 'project',
        },
      ],
      ui: { preferredViewMode: 'full' },
      settings: { searchIndexingEnabled: true, archiveRetentionDays: 30 },
    });

    await writeJsonFixture(join(defaultDir, 'chat-tabs.json'), {
      version: 1,
      tabs: [
        {
          id: 'tab-1',
          title: 'Chat One',
          messages: [
            {
              id: 'msg-1',
              role: 'user',
              blocks: [],
              timestamp: 1700000000000,
              attachmentPaths: [attachmentAbsolutePath],
            },
          ],
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      activeTabId: 'tab-1',
    });

    await writeTextFixture(
      join(defaultDir, 'workspace', 'notes', 'note1.md'),
      '# Note',
    );
    await writeTextFixture(
      join(defaultDir, 'workspace', 'prompts', 'prompt1.md'),
      'Prompt body',
    );
    await writeTextFixture(attachmentAbsolutePath, 'PNGDATA');
    await writeTextFixture(
      join(defaultDir, 'workspace', 'artifacts', 'main.ts'),
      'export const x = 1;',
    );
    await writeJsonFixture(join(defaultDir, 'artifacts-index.json'), {
      version: 1,
      items: {
        main: {
          id: 'main',
          relativePath: 'main.ts',
          title: 'main.ts',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });

    await writeJsonFixture(join(defaultDir, 'history', 'chat-1', 'meta.json'), {
      version: 1,
      id: 'chat-1',
      description: 'Archived chat',
      createdAt: '2026-01-03T00:00:00.000Z',
      pinnedContext: [
        {
          id: 'pin-2',
          kind: 'file',
          path: noteAbsolutePath,
          label: 'Note',
          scope: 'chat',
        },
      ],
    });
    await writeJsonFixture(
      join(defaultDir, 'history', 'chat-1', 'conversation.json'),
      {
        version: 1,
        projectId: 'default',
        chatId: 'chat-1',
        archivedAt: '2026-01-04T00:00:00.000Z',
        tab: {
          id: 'chat-1',
          title: 'Archived Chat',
          messages: [
            {
              id: 'msg-2',
              role: 'assistant',
              blocks: [],
              timestamp: 1700000100000,
              attachmentPaths: [attachmentAbsolutePath],
            },
          ],
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      },
    );
    await writeTextFixture(
      join(defaultDir, 'history', 'chat-1', 'summary.md'),
      '# Summary\nHello world',
    );

    await writeTextFixture(
      join(defaultDir, '.git', 'HEAD'),
      'ref: refs/heads/main',
    );
    await writeTextFixture(
      join(defaultDir, 'CLAUDE.md'),
      'Default project instructions',
    );
    await writeTextFixture(
      join(defaultDir, 'derived', 'search-index.sqlite'),
      'sqlite-bytes',
    );

    await writeJsonFixture(join(standaloneDir, 'projects.json'), {
      version: 1,
      projects: [{ id: UUID_ONE, name: 'Project One' }],
    });

    await writeJsonFixture(
      join(standaloneDir, 'projects', UUID_ONE, 'project.json'),
      {
        version: 1,
        id: UUID_ONE,
        name: 'Project One',
        createdAt: '2026-01-05T00:00:00.000Z',
        color: 'green',
      },
    );
    await writeTextFixture(
      join(standaloneDir, 'projects', UUID_ONE, 'CLAUDE.md'),
      'Project One instructions',
    );

    // Orphan project: a directory under `projects/` with no entry in
    // `projects.json`.
    await writeTextFixture(
      join(standaloneDir, 'projects', UUID_TWO, 'CLAUDE.md'),
      'Orphan instructions',
    );

    return {
      standaloneDir,
      defaultDir,
      attachmentAbsolutePath,
      noteAbsolutePath,
    };
  }

  it('migrates the full standalone-chat tree into cowork projects', async () => {
    const { standaloneDir } = await seedFullFixture();

    await migrateStandaloneChatToCowork();

    const indexFile = asRecord(
      await readJson(join(tempDir, 'workspaces', 'index.json')),
    );
    const workspaces = indexFile.workspaces;
    if (!Array.isArray(workspaces)) {
      throw new Error('Expected projects array');
    }
    const byName = new Map<string, Record<string, unknown>>();
    for (const entry of workspaces) {
      const record = asRecord(entry);
      if (typeof record.id === 'string') {
        byName.set(record.id, record);
      }
    }

    expect(byName.has('cowork-default')).toBe(true);
    expect(byName.get('cowork-default')?.type).toBe('cowork');
    expect(byName.has(UUID_ONE)).toBe(true);
    expect(byName.get(UUID_ONE)?.type).toBe('cowork');
    expect(byName.get(UUID_ONE)?.name).toBe('Project One');
    expect(byName.has(UUID_TWO)).toBe(true);
    expect(byName.get(UUID_TWO)?.type).toBe('cowork');
    // Orphan project has no project.json/projects.json entry, so it falls
    // back to the legacy directory (id) as its display name.
    expect(byName.get(UUID_TWO)?.name).toBe(UUID_TWO);

    // workspace.json carries cowork settings forward.
    const defaultConfig = asRecord(
      await readJson(
        join(tempDir, 'workspaces', 'cowork-default', 'workspace.json'),
      ),
    );
    expect(defaultConfig.type).toBe('cowork');
    const coworkSettings = asRecord(defaultConfig.cowork);
    expect(coworkSettings.defaultModel).toBe('claude-sonnet-4-5');
    expect(coworkSettings.defaultPresetId).toBe('preset-1');
    expect(coworkSettings.archiveRetentionDays).toBe(30);
    expect(coworkSettings.description).toBe('General purpose chats');
    // Legacy pinned-context/ui/search fields are intentionally dropped by
    // the migration now that those features no longer exist.
    expect(coworkSettings.projectPinnedContext).toBeUndefined();
    expect(coworkSettings.ui).toBeUndefined();
    expect(coworkSettings.searchIndexingEnabled).toBeUndefined();
    const homeDir = join(tempDir, 'workspaces', 'cowork-default', 'home');

    // home/ layout.
    await expect(readFile(join(homeDir, 'CLAUDE.md'), 'utf8')).resolves.toBe(
      'Default project instructions',
    );
    await expect(readFile(join(homeDir, 'main.ts'), 'utf8')).resolves.toBe(
      'export const x = 1;',
    );
    await expect(
      readFile(join(homeDir, BRAND_DIR, 'notes', 'note1.md'), 'utf8'),
    ).resolves.toBe('# Note');
    await expect(
      readFile(join(homeDir, BRAND_DIR, 'prompts', 'prompt1.md'), 'utf8'),
    ).resolves.toBe('Prompt body');
    await expect(
      readFile(join(homeDir, BRAND_DIR, 'attachments', 'x.png'), 'utf8'),
    ).resolves.toBe('PNGDATA');
    await expect(pathExists(join(homeDir, '.git'))).resolves.toBe(false);
    await expect(pathExists(join(homeDir, 'workspace'))).resolves.toBe(false);
    await expect(pathExists(join(homeDir, 'derived'))).resolves.toBe(false);
    await expect(pathExists(join(homeDir, 'project.json'))).resolves.toBe(
      false,
    );

    const artifactsIndex = asRecord(
      await readJson(join(homeDir, BRAND_DIR, 'artifacts-index.json')),
    );
    expect(asRecord(asRecord(artifactsIndex.items).main).relativePath).toBe(
      'main.ts',
    );

    // Live chat tabs move + attachment path rewrite.
    const chatTabs = asRecord(
      await readJson(
        join(tempDir, 'workspaces', 'cowork-default', 'chats', 'home.json'),
      ),
    );
    const tabs = chatTabs.tabs;
    if (!Array.isArray(tabs)) {
      throw new Error('Expected tabs array');
    }
    const messages = asRecord(tabs[0]).messages;
    if (!Array.isArray(messages)) {
      throw new Error('Expected messages array');
    }
    const attachmentPaths = asRecord(messages[0]).attachmentPaths;
    if (!Array.isArray(attachmentPaths)) {
      throw new Error('Expected attachmentPaths array');
    }
    expect(attachmentPaths[0]).toBe(
      join(homeDir, BRAND_DIR, 'attachments', 'x.png'),
    );

    // Archived chat history moves + rewrites.
    const chatHistoryDir = join(
      tempDir,
      'workspaces',
      'cowork-default',
      'chat-history',
      'chat-1',
    );
    await expect(pathExists(join(chatHistoryDir, 'meta.json'))).resolves.toBe(
      true,
    );
    const meta = asRecord(await readJson(join(chatHistoryDir, 'meta.json')));
    const metaPinnedContext = meta.pinnedContext;
    if (!Array.isArray(metaPinnedContext)) {
      throw new Error('Expected pinnedContext array');
    }
    expect(asRecord(metaPinnedContext[0]).path).toBe(
      join(homeDir, BRAND_DIR, 'notes', 'note1.md'),
    );
    const conversation = asRecord(
      await readJson(join(chatHistoryDir, 'conversation.json')),
    );
    const conversationMessages = asRecord(conversation.tab).messages;
    if (!Array.isArray(conversationMessages)) {
      throw new Error('Expected conversation messages array');
    }
    const conversationAttachmentPaths = asRecord(
      conversationMessages[0],
    ).attachmentPaths;
    if (!Array.isArray(conversationAttachmentPaths)) {
      throw new Error('Expected conversation attachmentPaths array');
    }
    expect(conversationAttachmentPaths[0]).toBe(
      join(homeDir, BRAND_DIR, 'attachments', 'x.png'),
    );
    await expect(
      readFile(join(chatHistoryDir, 'summary.md'), 'utf8'),
    ).resolves.toBe('# Summary\nHello world');

    // Legacy tree fully removed.
    await expect(pathExists(standaloneDir)).resolves.toBe(false);

    // Id-map file + cache.
    const idMapFile = asRecord(
      await readJson(join(tempDir, 'cowork-migration.json')),
    );
    expect(idMapFile.idMap).toEqual({
      default: 'cowork-default',
      [UUID_ONE]: UUID_ONE,
      [UUID_TWO]: UUID_TWO,
    });
    expect(getCoworkWorkspaceIdForLegacyChatProject('default')).toBe(
      'cowork-default',
    );

    await expect(hasMigrationRun('cowork_workspaces')).resolves.toBe(true);
  });

  it('seeds null retention for the default project when the legacy setting is absent', async () => {
    // Migrated workspaces carry legacy archives; an explicit day count here
    // would arm applyArchiveRetention retroactively over them. The container
    // layer still resolves null to the 7-day default.
    const { defaultDir } = await seedFullFixture();
    const projectPath = join(defaultDir, 'project.json');
    const project = asRecord(await readJson(projectPath));
    await writeJsonFixture(projectPath, { ...project, settings: {} });

    await migrateStandaloneChatToCowork();

    const config = asRecord(
      await readJson(
        join(tempDir, 'workspaces', 'cowork-default', 'workspace.json'),
      ),
    );
    const cowork = asRecord(config.cowork);
    expect(cowork.archiveRetentionDays).toBeNull();
  });

  it('preserves explicit null retention during legacy cowork migration', async () => {
    const { defaultDir } = await seedFullFixture();
    const projectPath = join(defaultDir, 'project.json');
    const project = asRecord(await readJson(projectPath));
    await writeJsonFixture(projectPath, {
      ...project,
      settings: { archiveRetentionDays: null },
    });

    await migrateStandaloneChatToCowork();

    const config = asRecord(
      await readJson(
        join(tempDir, 'workspaces', 'cowork-default', 'workspace.json'),
      ),
    );
    const cowork = asRecord(config.cowork);
    expect(cowork.archiveRetentionDays).toBeNull();
  });

  it('is a no-op the second time it runs', async () => {
    await seedFullFixture();

    await migrateStandaloneChatToCowork();
    const firstIndex = await readFile(
      join(tempDir, 'workspaces', 'index.json'),
      'utf8',
    );

    await migrateStandaloneChatToCowork();
    const secondIndex = await readFile(
      join(tempDir, 'workspaces', 'index.json'),
      'utf8',
    );

    expect(secondIndex).toBe(firstIndex);
    const indexFile = asRecord(JSON.parse(secondIndex));
    const workspaces = indexFile.workspaces;
    if (!Array.isArray(workspaces)) {
      throw new Error('Expected projects array');
    }
    expect(workspaces).toHaveLength(3);
  });

  it('recovers from a fault mid-migration and converges on retry', async () => {
    const standaloneDir = join(tempDir, 'standalone-chat');
    const defaultDir = join(standaloneDir, 'default');
    await writeTextFixture(
      join(defaultDir, 'CLAUDE.md'),
      'Default project instructions',
    );

    const secondProjectId = 'proj-two';
    await writeJsonFixture(join(standaloneDir, 'projects.json'), {
      version: 1,
      projects: [{ id: secondProjectId, name: 'Project Two' }],
    });
    await writeTextFixture(
      join(standaloneDir, 'projects', secondProjectId, 'CLAUDE.md'),
      'Project Two instructions',
    );

    // Pre-create a conflicting plain FILE at the destination `home/` path for
    // the second project, so its folder move genuinely throws partway
    // through the run (default, sorted first, has already fully migrated by
    // the time this happens).
    const blockedHomePath = join(
      tempDir,
      'workspaces',
      secondProjectId,
      'home',
    );
    await writeTextFixture(blockedHomePath, 'blocking file');

    // A single project failing no longer aborts the whole migration (it is
    // now isolated per-project), so this resolves normally instead of
    // rejecting.
    await migrateStandaloneChatToCowork();

    // Marker not set (the run never reached completion).
    await expect(hasMigrationRun('cowork_workspaces')).resolves.toBe(false);
    // The id-map is persisted incrementally per completed project (so a
    // project that finishes just before a crash is never silently
    // forgotten), so it already records `default` at this point even though
    // the overall migration has not finished.
    const midRunIdMapFile = asRecord(
      await readJson(join(tempDir, 'cowork-migration.json')),
    );
    expect(midRunIdMapFile.idMap).toEqual({ default: 'cowork-default' });

    // `default` fully migrated before the fault.
    await expect(pathExists(defaultDir)).resolves.toBe(false);
    await expect(
      readFile(
        join(tempDir, 'workspaces', 'cowork-default', 'home', 'CLAUDE.md'),
        'utf8',
      ),
    ).resolves.toBe('Default project instructions');

    // `proj-two` got an index entry (written before the fault) but its
    // folder never moved.
    const midRunIndex = asRecord(
      await readJson(join(tempDir, 'workspaces', 'index.json')),
    );
    const midRunWorkspaces = midRunIndex.workspaces;
    if (!Array.isArray(midRunWorkspaces)) {
      throw new Error('Expected projects array');
    }
    expect(
      midRunWorkspaces.some((entry) => asRecord(entry).id === secondProjectId),
    ).toBe(true);
    await expect(
      pathExists(join(standaloneDir, 'projects', secondProjectId)),
    ).resolves.toBe(true);

    // Remove the fault and retry.
    await rm(blockedHomePath, { force: true });
    await migrateStandaloneChatToCowork();

    await expect(hasMigrationRun('cowork_workspaces')).resolves.toBe(true);
    await expect(
      readFile(
        join(tempDir, 'workspaces', secondProjectId, 'home', 'CLAUDE.md'),
        'utf8',
      ),
    ).resolves.toBe('Project Two instructions');
    await expect(pathExists(standaloneDir)).resolves.toBe(false);

    const finalIndex = asRecord(
      await readJson(join(tempDir, 'workspaces', 'index.json')),
    );
    const finalWorkspaces = finalIndex.workspaces;
    if (!Array.isArray(finalWorkspaces)) {
      throw new Error('Expected projects array');
    }
    expect(finalWorkspaces).toHaveLength(2);

    const idMapFile = asRecord(
      await readJson(join(tempDir, 'cowork-migration.json')),
    );
    expect(idMapFile.idMap).toEqual({
      default: 'cowork-default',
      [secondProjectId]: secondProjectId,
    });
  });

  it('does not delete the source or corrupt the destination when the atomic write is interrupted, and recovers on rerun', async () => {
    const standaloneDir = join(tempDir, 'standalone-chat');
    const defaultDir = join(standaloneDir, 'default');
    await writeTextFixture(
      join(defaultDir, 'CLAUDE.md'),
      'Default project instructions',
    );
    const chatTabsSource = join(defaultDir, 'chat-tabs.json');
    await writeJsonFixture(chatTabsSource, {
      version: 1,
      tabs: [
        {
          id: 'tab-1',
          title: 'Chat One',
          messages: [],
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      activeTabId: 'tab-1',
    });

    const chatTabsDestination = join(
      tempDir,
      'workspaces',
      'cowork-default',
      'chats',
      'home.json',
    );

    // Simulate a crash during the atomic rename that finalizes the
    // rewritten chat-tabs file: the temp file gets written, but the final
    // rename over the destination path never completes. Only the first
    // `rename` call in the whole run is affected; every later call (e.g.
    // during the retry below) behaves normally.
    mockRename.mockImplementationOnce(() => {
      throw new Error('simulated crash during atomic rename');
    });

    await migrateStandaloneChatToCowork();

    // The interrupted write must not have deleted the source, and must not
    // have left a partially-written file at the destination path.
    await expect(pathExists(chatTabsSource)).resolves.toBe(true);
    await expect(pathExists(chatTabsDestination)).resolves.toBe(false);
    const sourceAfterCrash = asRecord(await readJson(chatTabsSource));
    const sourceTabs = sourceAfterCrash.tabs;
    if (!Array.isArray(sourceTabs)) {
      throw new Error('Expected tabs array');
    }
    expect(sourceTabs).toHaveLength(1);
    await expect(hasMigrationRun('cowork_workspaces')).resolves.toBe(false);

    // Rerun with the fault gone (the mock's default implementation forwards
    // to the real `rename`): the chat-tab data must be fully recovered,
    // not lost or corrupted.
    await migrateStandaloneChatToCowork();

    await expect(hasMigrationRun('cowork_workspaces')).resolves.toBe(true);
    await expect(pathExists(chatTabsSource)).resolves.toBe(false);
    const destination = asRecord(await readJson(chatTabsDestination));
    const destinationTabs = destination.tabs;
    if (!Array.isArray(destinationTabs)) {
      throw new Error('Expected tabs array');
    }
    expect(asRecord(destinationTabs[0]).id).toBe('tab-1');
  });

  it('does not write or delete a parseable but invalid legacy chat-tabs file', async () => {
    const standaloneDir = join(tempDir, 'standalone-chat');
    const defaultDir = join(standaloneDir, 'default');
    await writeTextFixture(
      join(defaultDir, 'CLAUDE.md'),
      'Default project instructions',
    );
    const chatTabsSource = join(defaultDir, 'chat-tabs.json');
    await writeJsonFixture(chatTabsSource, {
      version: 1,
      tabs: [],
    });

    const chatTabsDestination = join(
      tempDir,
      'workspaces',
      'cowork-default',
      'chats',
      'home.json',
    );

    await migrateStandaloneChatToCowork();

    await expect(hasMigrationRun('cowork_workspaces')).resolves.toBe(false);
    await expect(pathExists(chatTabsSource)).resolves.toBe(true);
    await expect(pathExists(chatTabsDestination)).resolves.toBe(false);
  });

  it('merges legacy chat tabs into a pre-existing destination home.json instead of discarding them', async () => {
    const standaloneDir = join(tempDir, 'standalone-chat');
    const defaultDir = join(standaloneDir, 'default');
    await writeTextFixture(
      join(defaultDir, 'CLAUDE.md'),
      'Default project instructions',
    );

    // Legacy live conversations for the default project.
    const chatTabsSource = join(defaultDir, 'chat-tabs.json');
    await writeJsonFixture(chatTabsSource, {
      version: 1,
      tabs: [
        {
          id: 'legacy-tab-1',
          title: 'Legacy Chat One',
          messages: [
            { id: 'm1', role: 'user', blocks: [], timestamp: 1700000000000 },
          ],
          createdAt: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 'legacy-tab-2',
          title: 'Legacy Chat Two',
          messages: [
            { id: 'm2', role: 'user', blocks: [], timestamp: 1700000001000 },
          ],
          createdAt: '2026-01-03T00:00:00.000Z',
        },
      ],
      activeTabId: 'legacy-tab-1',
      pendingQuestions: [
        {
          requestId: 'legacy-question',
          chatId: 'legacy-tab-1',
          questions: [],
        },
        {
          requestId: 'duplicate-question',
          chatId: 'legacy-tab-2',
          questions: [],
        },
        {
          requestId: 'stale-source-question',
          chatId: 'missing-tab',
          questions: [],
        },
      ],
    });

    // The always-present default cowork workspace already wrote a starter
    // `home.json` before the migration ran — the exact condition under which
    // the old skip-and-delete branch silently dropped legacy conversations.
    const chatTabsDestination = join(
      tempDir,
      'workspaces',
      'cowork-default',
      'chats',
      'home.json',
    );
    await writeJsonFixture(chatTabsDestination, {
      version: 1,
      tabs: [
        {
          id: 'starter-tab',
          title: 'New Chat',
          messages: [],
          createdAt: '2026-07-06T00:00:00.000Z',
        },
      ],
      activeTabId: 'starter-tab',
      pendingQuestions: [
        {
          requestId: 'starter-question',
          chatId: 'starter-tab',
          questions: [],
        },
        {
          requestId: 'duplicate-question',
          chatId: 'starter-tab',
          questions: [],
          answeredAt: 123,
        },
        {
          requestId: 'stale-destination-question',
          chatId: 'missing-tab',
          questions: [],
        },
      ],
    });

    await migrateStandaloneChatToCowork();

    await expect(hasMigrationRun('cowork_workspaces')).resolves.toBe(true);
    // The legacy source is consumed only after its tabs are represented in the
    // destination.
    await expect(pathExists(chatTabsSource)).resolves.toBe(false);

    const destination = asRecord(await readJson(chatTabsDestination));
    const destinationTabs = destination.tabs;
    if (!Array.isArray(destinationTabs)) {
      throw new Error('Expected tabs array');
    }
    const ids = destinationTabs.map((tab) => asRecord(tab).id);
    // Starter tab preserved AND both legacy conversations carried over.
    expect(ids).toEqual(['starter-tab', 'legacy-tab-1', 'legacy-tab-2']);
    // The live/current tab remains active.
    expect(destination.activeTabId).toBe('starter-tab');
    const pendingQuestions = destination.pendingQuestions;
    if (!Array.isArray(pendingQuestions)) {
      throw new Error('Expected pendingQuestions array');
    }
    expect(
      pendingQuestions.map((question) => asRecord(question).requestId),
    ).toEqual(['starter-question', 'duplicate-question', 'legacy-question']);
    expect(asRecord(pendingQuestions[1]).chatId).toBe('starter-tab');
  });

  it('allocates a suffixed project id when the legacy project id collides with an existing non-cowork project', async () => {
    const standaloneDir = join(tempDir, 'standalone-chat');
    const collidingId = 'proj-collide';
    await writeJsonFixture(join(standaloneDir, 'projects.json'), {
      version: 1,
      projects: [{ id: collidingId, name: 'Colliding Project' }],
    });
    await writeTextFixture(
      join(standaloneDir, 'projects', collidingId, 'CLAUDE.md'),
      'Colliding project instructions',
    );

    // Pre-existing, unrelated non-cowork workspace already occupying the id
    // the legacy project would otherwise map to verbatim.
    const existingRepoPath = join(tempDir, 'existing-repo');
    await mkdir(existingRepoPath, { recursive: true });
    await writeAllSidebarItems([
      {
        type: 'single-repo',
        id: collidingId,
        name: 'Existing Repo',
        repoPath: existingRepoPath,
        color: 'red',
        worktrees: [],
        collapsed: false,
        order: 0,
      },
    ]);

    await migrateStandaloneChatToCowork();

    const idMapFile = asRecord(
      await readJson(join(tempDir, 'cowork-migration.json')),
    );
    expect(idMapFile.idMap).toEqual({
      [collidingId]: `${collidingId}-2`,
    });

    const indexFile = asRecord(
      await readJson(join(tempDir, 'workspaces', 'index.json')),
    );
    const workspaces = indexFile.workspaces;
    if (!Array.isArray(workspaces)) {
      throw new Error('Expected projects array');
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const entry of workspaces) {
      const record = asRecord(entry);
      if (typeof record.id === 'string') {
        byId.set(record.id, record);
      }
    }

    // The original workspace at the colliding id is untouched.
    expect(byId.get(collidingId)?.type).toBe('single-repo');
    // The migrated project got a suffixed id instead of colliding.
    expect(byId.get(`${collidingId}-2`)?.type).toBe('cowork');
    expect(byId.get(`${collidingId}-2`)?.name).toBe('Colliding Project');
  });

  it('isolates a failing project so other projects still migrate, and a rerun completes the rest', async () => {
    const standaloneDir = join(tempDir, 'standalone-chat');
    const ids = ['proj-a', 'proj-b', 'proj-c'];
    await writeJsonFixture(join(standaloneDir, 'projects.json'), {
      version: 1,
      projects: ids.map((id) => ({ id, name: `Project ${id}` })),
    });
    for (const id of ids) {
      await writeTextFixture(
        join(standaloneDir, 'projects', id, 'CLAUDE.md'),
        `${id} instructions`,
      );
    }

    // Block the MIDDLE project's home destination with a plain file so its
    // migration throws partway through, proving the loop still reaches
    // `proj-c`, which sorts after it.
    const blockedHomePath = join(tempDir, 'workspaces', 'proj-b', 'home');
    await writeTextFixture(blockedHomePath, 'blocking file');

    await migrateStandaloneChatToCowork();

    // Marker not set: the run did not fully succeed.
    await expect(hasMigrationRun('cowork_workspaces')).resolves.toBe(false);

    // proj-a and proj-c (before and after the failing project) still
    // migrated successfully.
    await expect(
      readFile(
        join(tempDir, 'workspaces', 'proj-a', 'home', 'CLAUDE.md'),
        'utf8',
      ),
    ).resolves.toBe('proj-a instructions');
    await expect(
      readFile(
        join(tempDir, 'workspaces', 'proj-c', 'home', 'CLAUDE.md'),
        'utf8',
      ),
    ).resolves.toBe('proj-c instructions');

    // proj-b's legacy directory is left in place for the next retry.
    await expect(
      pathExists(join(standaloneDir, 'projects', 'proj-b')),
    ).resolves.toBe(true);

    const midRunIdMapFile = asRecord(
      await readJson(join(tempDir, 'cowork-migration.json')),
    );
    expect(midRunIdMapFile.idMap).toEqual({
      'proj-a': 'proj-a',
      'proj-c': 'proj-c',
    });

    // Remove the fault and retry: the whole migration converges.
    await rm(blockedHomePath, { force: true });
    await migrateStandaloneChatToCowork();

    await expect(hasMigrationRun('cowork_workspaces')).resolves.toBe(true);
    await expect(
      readFile(
        join(tempDir, 'workspaces', 'proj-b', 'home', 'CLAUDE.md'),
        'utf8',
      ),
    ).resolves.toBe('proj-b instructions');
    await expect(pathExists(standaloneDir)).resolves.toBe(false);

    const finalIdMapFile = asRecord(
      await readJson(join(tempDir, 'cowork-migration.json')),
    );
    expect(finalIdMapFile.idMap).toEqual({
      'proj-a': 'proj-a',
      'proj-b': 'proj-b',
      'proj-c': 'proj-c',
    });
  });
});

// Integration-style coverage for the cowork Work Entry registry and the
// `cowork_work_entries` startup migration, using real fs under a temp
// CANOPY_DATA_DIR (same posture as workspace-items.test.ts). Covers registry
// round-trip + lenient reads, meta derivation from per-entry tab files
// (title/provider/lastMessageAt/manual ordering), empty-entry reuse on
// create, rename override, chat→entry resolution across live tabs and
// archives, and the home.json split migration (per-chat entry files,
// registry rows, file-tab exclusion, home deletion, idempotent rerun,
// chat-plugins move).

import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
  truncate,
} from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  type ChatTabsFile,
  type CoworkWorkEntriesFile,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';

let tempDataDir = '';
const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;

beforeAll(() => {
  tempDataDir = mkdtempSync(join(tmpdir(), 'canopy-work-entries-'));
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

// Imported lazily so CANOPY_DATA_DIR is set before paths.ts caches anything.
import {
  activateWorkEntryWorkspace,
  appendWorkEntryRows,
  clearWorkEntrySummariesForWorkspace,
  createWorkEntry,
  deriveWorkEntrySummary,
  listWorkEntryChatSummaries,
  listWorkEntries,
  listWorkEntryIds,
  onWorkEntryListChanged,
  parseWorkEntryCount,
  parseWorkEntrySidebarSummary,
  readWorkEntriesFile,
  readWorkEntryChatCatalog,
  parseWorkEntriesFile,
  summarySourcePath,
  removeWorkEntryRow,
  reorderWorkEntries,
  resolveWorkEntryForChat,
  syncWorkEntrySummaryFromWrite,
  updateWorkEntry,
  updateWorkEntryRegistry,
  updateWorkEntryTitle,
} from '../lib/cowork-work-entries';
import {
  migrateWorkspaceChatsToWorkEntries,
  splitFlatChatTabsIntoEntries,
} from '../lib/cowork-work-entry-migration';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { createChatTabsAuxiliaryProjectionObserver } from '../lib/chat-tabs-auxiliary-projection';
import { panelLayoutPersistenceStore } from '../panels/persistence';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  getChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import {
  getChatPluginsRootDir,
  getWorkspaceChatArchivesFilePath,
  getWorkspaceChatTabsFilePath,
  getWorkspaceChatJournalFilePath,
  getWorkspaceIndexFilePath,
  getWorkspaceWorkEntriesFilePath,
  getWorktreePanelLayoutModeFilePath,
} from '../lib/paths';

async function writeWorkspaceDefaultLayoutMode(
  mode: 'minimal' | 'advanced',
): Promise<void> {
  await writeFile(
    join(tempDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { workspaceDefaultLayoutMode: mode },
    }),
    'utf8',
  );
}

function chatTab(input: {
  id: string;
  description?: string;
  timestamp?: number;
  kind?: 'chat' | 'file';
  providerType?: 'claude' | 'codex';
  executionHarness?: 'claude' | 'codex';
}): PersistedChatTab {
  return {
    id: input.id,
    title: 'New Chat',
    ...(input.description ? { description: input.description } : {}),
    createdAt: new Date(input.timestamp ?? 1000).toISOString(),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.providerType ? { providerType: input.providerType } : {}),
    ...(input.executionHarness
      ? { executionHarness: input.executionHarness }
      : {}),
    messages: input.timestamp
      ? [
          {
            id: `${input.id}-m1`,
            role: 'user',
            timestamp: input.timestamp,
            blocks: [{ type: 'text', text: 'hello' }],
          },
        ]
      : [],
  };
}

async function readRegistryFile(
  filePath: string,
): Promise<CoworkWorkEntriesFile> {
  const raw = await readFile(filePath);
  return parseWorkEntriesFile(raw.toString('utf8'));
}

async function writeTabsFile(
  workspaceId: string,
  worktreeId: string,
  tabs: PersistedChatTab[],
  options?: { syncSummary?: boolean },
): Promise<void> {
  const filePath = getWorkspaceChatTabsFilePath(workspaceId, worktreeId);
  await mkdir(dirname(filePath), { recursive: true });
  const file: ChatTabsFile = {
    version: 1,
    tabs,
    activeTabId: tabs[0]?.id ?? '',
  };
  const store = new ChatStorageV2(dirname(dirname(filePath)), worktreeId);
  if ((await store.authority()) === 'v2') {
    await getChatStateService().replaceCompatibilityTabs(
      { projectId: workspaceId, worktreeId },
      file,
      { authoritative: true },
    );
  } else {
    await writeFile(filePath, JSON.stringify(file, null, 2), 'utf8');
    resetChatStateServiceForTests();
  }
  if (options?.syncSummary === false) return;
  const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
  try {
    const registry = await readRegistryFile(registryPath);
    const entry = registry.entries.find(
      (candidate) => candidate.id === worktreeId,
    );
    if (!entry) return;
    const fileStats = await stat(filePath, { bigint: true });
    entry.summary = deriveWorkEntrySummary(file, fileStats.mtimeNs.toString());
    await writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');
  } catch {
    // Migration fixtures intentionally write chat files before the registry.
  }
}

describe('cowork work entry registry', () => {
  it.each(['before-install', 'after-install'])(
    'does not retain a new entry when authorization is revoked %s',
    async (stage) => {
      const workspaceId = `revoked-${stage}`;
      const original = { id: 'original', createdAt: new Date().toISOString() };
      await appendWorkEntryRows(workspaceId, [original]);
      const filePath = getWorkspaceWorkEntriesFilePath(workspaceId);
      const before = await readFile(filePath, 'utf8');
      let authorized = true;
      const denied = new Error('Creation authorization revoked');
      const guardedOptions = {
        id: 'unauthorized',
        assertCanCommit: (): void => {
          if (!authorized) throw denied;
        },
      };
      const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
      const originalWrite = fs.writeFile;
      const originalRename = fs.rename;
      const write = jest.spyOn(fs, 'writeFile');
      const rename = jest.spyOn(fs, 'rename');
      if (stage === 'before-install') {
        write.mockImplementationOnce(async (...args) => {
          await originalWrite(...args);
          authorized = false;
        });
      } else {
        rename.mockImplementationOnce(async (...args) => {
          await originalRename(...args);
          authorized = false;
        });
      }
      try {
        await expect(createWorkEntry(workspaceId, guardedOptions)).rejects.toBe(
          denied,
        );
        expect(await readFile(filePath, 'utf8')).toBe(before);
        expect((await readWorkEntriesFile(workspaceId)).entries).toEqual([
          original,
        ]);
        expect(
          readdirSync(dirname(filePath)).filter((name) =>
            name.endsWith('.tmp'),
          ),
        ).toEqual([]);
        expect(
          existsSync(
            getWorktreePanelLayoutModeFilePath(workspaceId, guardedOptions.id),
          ),
        ).toBe(false);
      } finally {
        write.mockRestore();
        rename.mockRestore();
      }
    },
  );

  it('retries a sharing violation without losing the existing registry', async () => {
    const workspaceId = 'retry-registry-ws';
    const row = { id: 'original', createdAt: new Date().toISOString() };
    await appendWorkEntryRows(workspaceId, [row]);
    const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
    const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
    const originalRename = fs.rename;
    let registryRenameAttempts = 0;
    // Other async work may rename files while this spy is installed.
    const rename = jest
      .spyOn(fs, 'rename')
      .mockImplementation(async (from, to) => {
        if (to === registryPath) {
          registryRenameAttempts += 1;
          if (registryRenameAttempts === 1) {
            throw Object.assign(new Error('sharing violation'), {
              code: 'EPERM',
            });
          }
        }
        await originalRename(from, to);
      });
    try {
      await expect(
        appendWorkEntryRows(workspaceId, [{ ...row, id: 'added' }]),
      ).resolves.toBeUndefined();
      expect(
        (await readWorkEntriesFile(workspaceId)).entries.map(
          (entry) => entry.id,
        ),
      ).toEqual(['original', 'added']);
      expect(registryRenameAttempts).toBe(2);
    } finally {
      rename.mockRestore();
    }
  });

  it('preserves the registry and removes its temporary file after persistent rename failure', async () => {
    const workspaceId = 'locked-registry-ws';
    const row = { id: 'original', createdAt: new Date().toISOString() };
    await appendWorkEntryRows(workspaceId, [row]);
    const filePath = getWorkspaceWorkEntriesFilePath(workspaceId);
    const before = await readFile(filePath, 'utf8');
    const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
    const error = Object.assign(new Error('sharing violation'), {
      code: 'EPERM',
    });
    const rename = jest.spyOn(fs, 'rename').mockRejectedValue(error);
    try {
      await expect(
        appendWorkEntryRows(workspaceId, [{ ...row, id: 'added' }]),
      ).rejects.toBe(error);
      expect(await readFile(filePath, 'utf8')).toBe(before);
      expect(
        readdirSync(dirname(filePath)).filter((name) => name.endsWith('.tmp')),
      ).toEqual([]);
    } finally {
      rename.mockRestore();
    }
  });

  const WS = 'registry-ws';

  it('uses a compact persisted summary without decoding the full chat file', async () => {
    const workspaceId = 'compact-summary-ws';
    const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'entry-with-summary',
            createdAt: '2026-08-17T10:00:00.000Z',
            summary: {
              version: 1,
              title: 'Investigate customer import',
              lastMessageAt: '2026-08-17T10:05:00.000Z',
              providerType: 'codex',
              chatCount: 1,
              chats: [
                {
                  id: 'investigation-chat',
                  title: 'Customer import details',
                  createdAt: '2026-08-17T10:00:00.000Z',
                  lastMessageAt: '2026-08-17T10:05:00.000Z',
                  providerType: 'codex',
                },
              ],
            },
          },
        ],
      }),
      'utf8',
    );

    // A list operation must not touch this file once the registry owns a
    // compact summary. Keeping it malformed makes an accidental fallback read
    // observable without allocating a large transcript in the unit suite.
    const tabsPath = getWorkspaceChatTabsFilePath(
      workspaceId,
      'entry-with-summary',
    );
    await mkdir(dirname(tabsPath), { recursive: true });
    await writeFile(tabsPath, '{"version":1,"tabs":[', 'utf8');
    const tabsStats = await stat(tabsPath, { bigint: true });
    const registry = await readRegistryFile(registryPath);
    const summary = registry.entries[0]?.summary;
    if (!summary) throw new Error('Expected compact summary fixture');
    summary.sourceMtimeNs = tabsStats.mtimeNs.toString();
    await writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');

    await expect(listWorkEntries(workspaceId)).resolves.toEqual([
      {
        id: 'entry-with-summary',
        title: 'Investigate customer import',
        createdAt: '2026-08-17T10:00:00.000Z',
        lastMessageAt: '2026-08-17T10:05:00.000Z',
        providerType: 'codex',
        chatCount: 1,
      },
    ]);
    await expect(listWorkEntryChatSummaries(workspaceId)).resolves.toEqual([
      {
        entryId: 'entry-with-summary',
        title: 'Investigate customer import',
        order: 0,
        createdAt: '2026-08-17T10:00:00.000Z',
        lastMessageAt: '2026-08-17T10:05:00.000Z',
        chats: [
          {
            id: 'investigation-chat',
            title: 'Customer import details',
            createdAt: '2026-08-17T10:00:00.000Z',
            lastMessageAt: '2026-08-17T10:05:00.000Z',
            providerType: 'codex',
          },
        ],
      },
    ]);
  });

  it("projects each Work Entry's registry order, pin, status and activity for the shell", async () => {
    const workspaceId = 'compact-summary-order-ws';
    const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
    await mkdir(dirname(registryPath), { recursive: true });
    // Pin each compact summary to its (unreadable) chat file's mtime so the
    // listing trusts the registry projection instead of re-deriving it.
    const sourceMtimeNs = async (entryId: string): Promise<string> => {
      const tabsPath = getWorkspaceChatTabsFilePath(workspaceId, entryId);
      await mkdir(dirname(tabsPath), { recursive: true });
      await writeFile(tabsPath, '{"version":1,"tabs":[', 'utf8');
      return (await stat(tabsPath, { bigint: true })).mtimeNs.toString();
    };
    const emptySummary = {
      version: 1,
      title: 'Derived title',
      chatCount: 0,
      chats: [],
    };
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'first-row',
            createdAt: '2026-08-17T10:00:00.000Z',
            summary: {
              ...emptySummary,
              sourceMtimeNs: await sourceMtimeNs('first-row'),
            },
          },
          {
            id: 'second-row',
            title: 'Renamed',
            pinned: true,
            status: 'done',
            createdAt: '2026-08-16T10:00:00.000Z',
            lastTouchedAt: '2026-08-18T10:00:00.000Z',
            summary: {
              ...emptySummary,
              sourceMtimeNs: await sourceMtimeNs('second-row'),
              lastMessageAt: '2026-08-17T12:00:00.000Z',
            },
          },
        ],
      }),
      'utf8',
    );

    await expect(listWorkEntryChatSummaries(workspaceId)).resolves.toEqual([
      {
        entryId: 'first-row',
        title: 'Derived title',
        order: 0,
        createdAt: '2026-08-17T10:00:00.000Z',
        chats: [],
      },
      {
        entryId: 'second-row',
        title: 'Renamed',
        order: 1,
        pinned: true,
        status: 'done',
        createdAt: '2026-08-16T10:00:00.000Z',
        lastMessageAt: '2026-08-17T12:00:00.000Z',
        lastTouchedAt: '2026-08-18T10:00:00.000Z',
        chats: [],
      },
    ]);
    // Defaults stay absent rather than projecting `false` / `'active'`.
    const [first] = await listWorkEntryChatSummaries(workspaceId);
    expect(first).not.toHaveProperty('pinned');
    expect(first).not.toHaveProperty('status');
    expect(first).not.toHaveProperty('lastMessageAt');
    expect(first).not.toHaveProperty('lastTouchedAt');

    await reorderWorkEntries(workspaceId, ['second-row', 'first-row']);
    expect(
      (await listWorkEntryChatSummaries(workspaceId)).map((entry) => [
        entry.entryId,
        entry.order,
      ]),
    ).toEqual([
      ['second-row', 0],
      ['first-row', 1],
    ]);
  });

  it('notifies list observers after every entry add, remove and move, never on field edits', async () => {
    const workspaceId = 'list-change-ws';
    // Fired after the write lands, so each observer read sees the new list.
    const reads: Array<Promise<string>> = [];
    const stop = onWorkEntryListChanged((changed) => {
      if (changed !== workspaceId) return;
      reads.push(
        readWorkEntriesFile(changed).then((file) =>
          file.entries.map((entry) => entry.id).join(','),
        ),
      );
    });
    const settle = (): Promise<string[]> => Promise.all(reads);
    try {
      const first = await createWorkEntry(workspaceId, {
        id: 'first',
        title: 'First',
      });
      await settle();
      await createWorkEntry(workspaceId, { id: 'second', title: 'Second' });
      await expect(settle()).resolves.toEqual(['first', 'second,first']);

      // Re-resolving an existing id changes nothing, so nothing is emitted.
      await createWorkEntry(workspaceId, { id: 'first', title: 'First' });
      await updateWorkEntry(workspaceId, first.entry.id, {
        pinned: true,
        status: 'done',
        title: 'Renamed',
      });
      await appendWorkEntryRows(workspaceId, [
        { id: 'first', createdAt: new Date().toISOString() },
      ]);
      expect(reads).toHaveLength(2);

      await reorderWorkEntries(workspaceId, ['first', 'second']);
      // Settle each read before the next write so it observes its own list.
      await settle();
      await appendWorkEntryRows(workspaceId, [
        { id: 'restored', createdAt: new Date().toISOString() },
      ]);
      await settle();
      await removeWorkEntryRow(workspaceId, 'first');
      await expect(settle()).resolves.toEqual([
        'first',
        'second,first',
        'first,second',
        'first,second,restored',
        'second,restored',
      ]);
    } finally {
      stop();
    }

    await removeWorkEntryRow(workspaceId, 'second');
    expect(reads).toHaveLength(5);
  });

  it('projects the latest conversational role without altering source tabs', () => {
    const tab = chatTab({ id: 'role-chat', timestamp: 100 });
    tab.messages.push(
      { id: 'assistant', role: 'assistant', timestamp: 200, blocks: [] },
      { id: 'system', role: 'system', timestamp: 300, blocks: [] },
    );
    const before = JSON.stringify(tab);
    const summary = deriveWorkEntrySummary({
      version: 1,
      activeTabId: tab.id,
      tabs: [tab],
    });
    expect(summary.chats[0]).toMatchObject({
      lastMessageRole: 'assistant',
      lastMessageAt: new Date(300).toISOString(),
    });
    expect(JSON.stringify(tab)).toBe(before);
    tab.transcript = {
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 1,
      committedByteLength: 10,
      transcriptRevision: 1,
      hasActiveSidecar: false,
      lastMessageRole: 'user',
    };
    expect(
      deriveWorkEntrySummary({ version: 1, activeTabId: tab.id, tabs: [tab] })
        .chats[0]?.lastMessageRole,
    ).toBe('user');
  });

  it('rejects corrupt registries for complete inventories while preserving lenient reads', async () => {
    const workspaceId = 'strict-inventory';
    const file = getWorkspaceWorkEntriesFilePath(workspaceId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{broken');
    await expect(
      listWorkEntryChatSummaries(workspaceId, { strict: true }),
    ).rejects.toThrow();
    await expect(listWorkEntryChatSummaries(workspaceId)).resolves.toEqual([]);
  });

  it('rejects an unreadable registry for strict projection reads', async () => {
    const workspaceId = 'strict-projection-read';
    const file = getWorkspaceWorkEntriesFilePath(workspaceId);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{broken');
    // A lenient empty registry would let the projection report success.
    await expect(
      listWorkEntryChatSummaries(workspaceId, { strictRead: true }),
    ).rejects.toThrow();
    await rm(file, { force: true });
    await expect(
      listWorkEntryChatSummaries(workspaceId, { strictRead: true }),
    ).resolves.toEqual([]);
  });

  it('persists the captured harness in compact per-chat summaries', () => {
    const tabs = [
      chatTab({
        id: 'captured-harness-chat',
        providerType: 'codex',
        executionHarness: 'codex',
      }),
    ];
    const summary = deriveWorkEntrySummary({
      version: 1,
      tabs,
      activeTabId: tabs[0]?.id ?? '',
    });

    expect(summary.chats[0]?.executionHarness).toBe('codex');
  });

  it('keeps custom titles in compact chat summaries and derives the entry name from them', () => {
    const summary = deriveWorkEntrySummary({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'Original',
          description: 'Generated',
          customTitle: 'My chat',
          createdAt: '2026-09-05T00:00:00Z',
          messages: [],
        },
      ],
    });
    expect(summary.title).toBe('My chat');
    expect(summary.chats[0]).toMatchObject({
      title: 'Original',
      customTitle: 'My chat',
      description: 'Generated',
    });
  });

  it('persists normalized plugin selections in compact per-chat summaries', () => {
    const selected: PersistedChatTab = {
      ...chatTab({ id: 'selected-chat' }),
      pluginSelections: {
        collectionIds: [],
        bundleIds: ['legacy-collection'],
        skillRefs: [{ sourceId: 'local', skillName: 'review' }],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'helper' }],
        mcpServerRefs: [{ serverId: 'server', configId: 'config' }],
      },
    };
    const summary = deriveWorkEntrySummary({
      version: 1,
      tabs: [selected, chatTab({ id: 'unselected-chat' })],
      activeTabId: 'selected-chat',
    });

    expect(summary.chats[0]?.pluginSelections).toEqual({
      collectionIds: ['legacy-collection'],
      skillRefs: [{ sourceId: 'local', skillName: 'review' }],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'helper' }],
      mcpServerRefs: [{ serverId: 'server', configId: 'config' }],
    });
    // An explicit empty set separates "nothing selected" from a summary
    // written before selections were projected.
    expect(summary.chats[1]?.pluginSelections).toEqual({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
    });
  });

  it('rebuilds a compact summary whose source-file marker is stale', async () => {
    const workspaceId = 'stale-summary-ws';
    const entryId = 'stale-entry';
    const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: entryId,
            createdAt: '2026-08-17T10:00:00.000Z',
            summary: {
              version: 1,
              sourceMtimeNs: '0',
              title: 'Stale title',
              chatCount: 0,
              chats: [],
            },
          },
        ],
      }),
      'utf8',
    );
    await writeTabsFile(
      workspaceId,
      entryId,
      [
        chatTab({
          id: 'fresh-chat',
          description: 'Fresh title',
          timestamp: 5_000,
        }),
      ],
      { syncSummary: false },
    );

    await expect(listWorkEntries(workspaceId)).resolves.toMatchObject([
      { id: entryId, title: 'Fresh title', chatCount: 1 },
    ]);
    const persisted = await readRegistryFile(registryPath);
    expect(persisted.entries[0]?.summary).toMatchObject({
      title: 'Fresh title',
      chatCount: 1,
    });
    expect(persisted.entries[0]?.summary?.sourceMtimeNs).not.toBe('0');
  });

  describe('a source-matching summary written before chats carried selections', () => {
    const selections = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'local', skillName: 'review' }],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'helper' }],
      mcpServerRefs: [{ serverId: 'docs', configId: 'docs-config' }],
      mcpHttpAuthPreferences: [
        {
          target: {
            kind: 'standalone' as const,
            serverId: 'docs',
            configId: 'docs-config',
          },
          handler: 'provider' as const,
        },
      ],
    };

    /** Seed a version 1 chat file whose tab has nonempty selections. */
    async function seedLegacyScope(
      workspaceId: string,
      entryId: string,
    ): Promise<void> {
      const tabsPath = getWorkspaceChatTabsFilePath(workspaceId, entryId);
      await mkdir(dirname(tabsPath), { recursive: true });
      const tab = chatTab({ id: 'chat-a', timestamp: 2000 });
      await writeFile(
        tabsPath,
        JSON.stringify({
          version: 1,
          activeTabId: 'chat-a',
          tabs: [{ ...tab, pluginSelections: selections }],
        }),
        'utf8',
      );
      resetChatStateServiceForTests();
    }

    /** A matching registry summary written by a build without selections. */
    async function writeLegacyRegistry(
      workspaceId: string,
      entryId: string,
    ): Promise<{ registryPath: string; sourceMtimeNs: string }> {
      const sourceMtimeNs = (
        await stat(await summarySourcePath(workspaceId, entryId), {
          bigint: true,
        })
      ).mtimeNs.toString();
      const summary = deriveWorkEntrySummary(
        {
          version: 1,
          activeTabId: 'chat-a',
          tabs: [chatTab({ id: 'chat-a', timestamp: 2000 })],
        },
        sourceMtimeNs,
      );
      const legacyChats = summary.chats.map((chat) => {
        const legacyChat = { ...chat };
        delete legacyChat.pluginSelections;
        return legacyChat;
      });
      const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
      await mkdir(dirname(registryPath), { recursive: true });
      await writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          entries: [
            {
              id: entryId,
              createdAt: '2026-08-17T10:00:00.000Z',
              summary: { ...summary, chats: legacyChats },
            },
          ],
        }),
        'utf8',
      );
      return { registryPath, sourceMtimeNs };
    }

    it('recovers the selections once from the scope indexes after a restart', async () => {
      const workspaceId = 'legacy-selections-ws';
      const entryId = 'legacy-selections-entry';
      await seedLegacyScope(workspaceId, entryId);
      // Admission migrates the scope; its indexes hold the canonical tab.
      await readChatTabsFile(workspaceId, entryId);
      const tabsPath = getWorkspaceChatTabsFilePath(workspaceId, entryId);
      const store = new ChatStorageV2(dirname(dirname(tabsPath)), entryId);
      expect(await store.authority()).toBe('v2');
      const { registryPath, sourceMtimeNs } = await writeLegacyRegistry(
        workspaceId,
        entryId,
      );
      // Restart: nothing about this scope is cached in memory.
      resetChatStateServiceForTests();

      const [listed] = await listWorkEntryChatSummaries(workspaceId);
      expect(listed?.chats[0]?.pluginSelections).toEqual(selections);
      const persisted = await readRegistryFile(registryPath);
      expect(persisted.entries[0]?.summary?.chats[0]?.pluginSelections).toEqual(
        selections,
      );
      // Only the missing field was filled; the source marker still matches.
      expect(persisted.entries[0]?.summary?.sourceMtimeNs).toBe(sourceMtimeNs);

      // Once recovered, a later listing does not rewrite the registry.
      const recovered = await stat(registryPath, { bigint: true });
      await listWorkEntryChatSummaries(workspaceId);
      expect((await stat(registryPath, { bigint: true })).mtimeNs).toBe(
        recovered.mtimeNs,
      );
    }, 15_000);

    it('leaves an unopened legacy scope unknown without reading or rewriting it', async () => {
      const workspaceId = 'legacy-v1-selections-ws';
      const entryId = 'legacy-v1-selections-entry';
      await seedLegacyScope(workspaceId, entryId);
      const { registryPath } = await writeLegacyRegistry(workspaceId, entryId);
      const written = await stat(registryPath, { bigint: true });

      const [listed] = await listWorkEntryChatSummaries(workspaceId);
      // Version 1 files embed transcripts, so listing never decodes them;
      // opening the chat migrates the scope and refreshes its summary.
      expect(listed?.chats[0]).not.toHaveProperty('pluginSelections');
      expect((await stat(registryPath, { bigint: true })).mtimeNs).toBe(
        written.mtimeNs,
      );
      const tabsPath = getWorkspaceChatTabsFilePath(workspaceId, entryId);
      expect(
        await new ChatStorageV2(
          dirname(dirname(tabsPath)),
          entryId,
        ).authority(),
      ).toBe('v1');
    });
  });

  it('releases a live summary after it is persisted to the registry', async () => {
    const workspaceId = APP_ADVISOR_PROJECT_ID;
    const created = await createWorkEntry(workspaceId);
    try {
      const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
      const liveFile: ChatTabsFile = {
        version: 1,
        tabs: [
          chatTab({
            id: 'live-summary-chat',
            description: 'Summary retained only while persistence is pending',
            timestamp: 500,
          }),
        ],
        activeTabId: 'live-summary-chat',
      };

      await writeTabsFile(workspaceId, created.entry.id, liveFile.tabs, {
        syncSummary: false,
      });

      await syncWorkEntrySummaryFromWrite(
        workspaceId,
        created.entry.id,
        liveFile,
      );
      // This mutation shares the registry queue, so its completion proves the
      // fire-and-forget summary write has settled.
      await updateWorkEntry(workspaceId, created.entry.id, { status: 'done' });
      const persisted = await readRegistryFile(registryPath);
      const persistedEntry = persisted.entries.find(
        (entry) => entry.id === created.entry.id,
      );
      expect(persistedEntry?.summary?.title).toBe(
        'Summary retained only while persistence is pending',
      );

      delete persistedEntry?.summary;
      await writeFile(registryPath, JSON.stringify(persisted, null, 2), 'utf8');
      await rm(getWorkspaceChatTabsFilePath(workspaceId, created.entry.id), {
        force: true,
      });

      const listed = (await listWorkEntries(workspaceId)).find(
        (entry) => entry.id === created.entry.id,
      );
      expect(listed?.title).toBe('New Chat');
    } finally {
      await removeWorkEntryRow(workspaceId, created.entry.id);
    }
  });

  it('projects canonical chat state before its compatibility snapshot exists', async () => {
    const workspaceId = APP_ADVISOR_PROJECT_ID;
    const created = await createWorkEntry(workspaceId, {
      title: 'Restored entry',
    });
    const tabsFile: ChatTabsFile = {
      version: 1,
      tabs: [
        chatTab({
          id: 'canonical-only-chat',
          description: 'Canonical restore summary',
          timestamp: 750,
        }),
      ],
      activeTabId: 'canonical-only-chat',
    };

    try {
      expect(
        existsSync(getWorkspaceChatTabsFilePath(workspaceId, created.entry.id)),
      ).toBe(false);

      await syncWorkEntrySummaryFromWrite(
        workspaceId,
        created.entry.id,
        tabsFile,
      );

      await expect(listWorkEntries(workspaceId)).resolves.toEqual([
        expect.objectContaining({
          id: created.entry.id,
          title: 'Restored entry',
          lastMessageAt: new Date(750).toISOString(),
          chatCount: 1,
        }),
      ]);
      const persisted = await readRegistryFile(
        getWorkspaceWorkEntriesFilePath(workspaceId),
      );
      expect(persisted.entries[0]?.summary).toMatchObject({
        title: 'Canonical restore summary',
        sourceMtimeNs: 'missing',
      });
    } finally {
      await removeWorkEntryRow(workspaceId, created.entry.id);
    }
  });

  it.each(['rename', 'delete'] as const)(
    'preserves a concurrent Work Entry %s while a two-chat summary waits for the registry',
    async (change) => {
      const workspaceId = APP_ADVISOR_PROJECT_ID;
      const created = await createWorkEntry(workspaceId);
      const entryId = created.entry.id;
      const tabs: ChatTabsFile = {
        version: 1,
        activeTabId: 'first-chat',
        tabs: [
          chatTab({ id: 'first-chat', description: 'First', timestamp: 1000 }),
          chatTab({
            id: 'second-chat',
            description: 'Second',
            timestamp: 2000,
          }),
        ],
      };
      await writeTabsFile(workspaceId, entryId, tabs.tabs, {
        syncSummary: false,
      });
      let lockEntered: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        lockEntered = resolve;
      });
      let releaseLock: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const blocker = updateWorkEntryRegistry(workspaceId, async (entries) => {
        lockEntered?.();
        await held;
        return entries;
      });
      try {
        await entered;
        const projection = syncWorkEntrySummaryFromWrite(
          workspaceId,
          entryId,
          tabs,
        );
        const mutation =
          change === 'rename'
            ? updateWorkEntryTitle(workspaceId, entryId, 'Manual title')
            : removeWorkEntryRow(workspaceId, entryId);
        releaseLock?.();
        await Promise.all([blocker, projection, mutation]);
        const registry = await readRegistryFile(
          getWorkspaceWorkEntriesFilePath(workspaceId),
        );
        const row = registry.entries.find((entry) => entry.id === entryId);
        if (change === 'rename') {
          expect(row?.title).toBe('Manual title');
          expect(row?.summary?.chats.map((chat) => chat.id)).toEqual([
            'first-chat',
            'second-chat',
          ]);
        } else {
          expect(row).toBeUndefined();
          expect(
            (await listWorkEntries(workspaceId)).some(
              (entry) => entry.id === entryId,
            ),
          ).toBe(false);
        }
      } finally {
        releaseLock?.();
        await blocker;
        await removeWorkEntryRow(workspaceId, entryId);
      }
    },
  );

  it('rebuilds a failed summary from the latest two-chat file on startup read', async () => {
    const workspaceId = APP_ADVISOR_PROJECT_ID;
    const created = await createWorkEntry(workspaceId);
    const entryId = created.entry.id;
    const oldTabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'first-chat',
      tabs: [
        chatTab({ id: 'first-chat', description: 'Old', timestamp: 1000 }),
      ],
    };
    const latestTabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'second-chat',
      tabs: [
        chatTab({ id: 'first-chat', description: 'Old', timestamp: 1000 }),
        chatTab({ id: 'second-chat', description: 'Latest', timestamp: 2000 }),
      ],
    };
    try {
      await getChatStateService().replaceCompatibilityTabs(
        { projectId: workspaceId, worktreeId: entryId },
        oldTabs,
        { authoritative: true },
      );
      await syncWorkEntrySummaryFromWrite(workspaceId, entryId, oldTabs);
      await getChatStateService().replaceCompatibilityTabs(
        { projectId: workspaceId, worktreeId: entryId },
        latestTabs,
        { authoritative: true },
      );
      const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
      const originalWrite = fs.writeFile;
      let fail = true;
      const write = jest
        .spyOn(fs, 'writeFile')
        .mockImplementation(async (...args) => {
          if (
            fail &&
            typeof args[0] === 'string' &&
            args[0].includes('.work-entries-')
          ) {
            fail = false;
            throw new Error('summary write failed');
          }
          await originalWrite(...args);
        });
      try {
        await expect(
          syncWorkEntrySummaryFromWrite(workspaceId, entryId, latestTabs),
        ).rejects.toThrow('summary write failed');
      } finally {
        write.mockRestore();
      }
      const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
      expect(
        (await readRegistryFile(registryPath)).entries[0]?.summary?.chatCount,
      ).toBe(1);

      // A fresh process has no live summary cache; the startup list read
      // rebuilds a stale persisted summary from canonical chat storage.
      await clearWorkEntrySummariesForWorkspace(workspaceId);
      activateWorkEntryWorkspace(workspaceId);
      const listed = (await listWorkEntryChatSummaries(workspaceId)).find(
        (item) => item.entryId === entryId,
      );
      expect(listed?.chats.map((chat) => chat.id)).toEqual([
        'first-chat',
        'second-chat',
      ]);
      expect(
        (await readRegistryFile(registryPath)).entries[0]?.summary?.chatCount,
      ).toBe(2);
    } finally {
      activateWorkEntryWorkspace(workspaceId);
      await removeWorkEntryRow(workspaceId, entryId);
    }
  });

  it('does not let an older summary finish over a newer committed summary', async () => {
    const workspaceId = APP_ADVISOR_PROJECT_ID;
    const created = await createWorkEntry(workspaceId);
    const entryId = created.entry.id;
    const oldTabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'first-chat',
      tabs: [
        chatTab({ id: 'first-chat', description: 'Old', timestamp: 1000 }),
      ],
    };
    const latestTabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'second-chat',
      tabs: [
        chatTab({ id: 'first-chat', description: 'Old', timestamp: 1000 }),
        chatTab({ id: 'second-chat', description: 'Latest', timestamp: 2000 }),
      ],
    };
    await writeTabsFile(workspaceId, entryId, oldTabs.tabs, {
      syncSummary: false,
    });
    const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
    const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
    const originalRead = fs.readFile;
    let readEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      readEntered = resolve;
    });
    let releaseRead: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let heldOnce = false;
    const read = jest
      .spyOn(fs, 'readFile')
      .mockImplementation(async (...args) => {
        if (!heldOnce && args[0] === registryPath) {
          heldOnce = true;
          readEntered?.();
          await held;
        }
        return originalRead(...args);
      });
    let currentRevision = 1;
    try {
      const older = syncWorkEntrySummaryFromWrite(
        workspaceId,
        entryId,
        oldTabs,
        () => currentRevision === 1,
      );
      await entered;
      await writeTabsFile(workspaceId, entryId, latestTabs.tabs, {
        syncSummary: false,
      });
      currentRevision = 2;
      const newer = syncWorkEntrySummaryFromWrite(
        workspaceId,
        entryId,
        latestTabs,
        () => currentRevision === 2,
      );
      releaseRead?.();
      await Promise.all([older, newer]);
      const registry = await readRegistryFile(registryPath);
      const row = registry.entries.find((entry) => entry.id === entryId);
      expect(row?.summary?.title).toBe('Latest');
      expect(row?.summary?.chats.map((chat) => chat.id)).toEqual([
        'first-chat',
        'second-chat',
      ]);
    } finally {
      releaseRead?.();
      read.mockRestore();
      await removeWorkEntryRow(workspaceId, entryId);
    }
  });

  it('does not install an older summary superseded while its registry file is prepared', async () => {
    const workspaceId = APP_ADVISOR_PROJECT_ID;
    const created = await createWorkEntry(workspaceId);
    const entryId = created.entry.id;
    const oldTabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'first-chat',
      tabs: [
        chatTab({ id: 'first-chat', description: 'Old', timestamp: 1000 }),
      ],
    };
    const latestTabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'second-chat',
      tabs: [
        chatTab({ id: 'first-chat', description: 'Old', timestamp: 1000 }),
        chatTab({ id: 'second-chat', description: 'Latest', timestamp: 2000 }),
      ],
    };
    await writeTabsFile(workspaceId, entryId, oldTabs.tabs, {
      syncSummary: false,
    });
    const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
    const before = await readFile(registryPath, 'utf8');
    const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
    const originalWrite = fs.writeFile;
    let currentRevision = 1;
    // The newer revision publishes after every pre-write currency check,
    // while the older summary's temporary registry file is being written.
    const write = jest
      .spyOn(fs, 'writeFile')
      .mockImplementationOnce(async (...args) => {
        await originalWrite(...args);
        currentRevision = 2;
      });
    const sidebarGroups = await import('../lib/sidebar-item-groups');
    const invalidated = jest.spyOn(
      sidebarGroups,
      'publishSidebarItemGroupsChanged',
    );
    const logging = await import('../lib/main-process-logging');
    const warning = jest.spyOn(logging, 'logMainProcessWarn');
    try {
      await expect(
        syncWorkEntrySummaryFromWrite(
          workspaceId,
          entryId,
          oldTabs,
          () => currentRevision === 1,
        ),
      ).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledWith(
        expect.stringContaining('.work-entries-'),
        expect.any(String),
        'utf8',
      );
      expect(currentRevision).toBe(2);
      expect(await readFile(registryPath, 'utf8')).toBe(before);
      expect(
        readdirSync(dirname(registryPath)).filter((name) =>
          name.endsWith('.tmp'),
        ),
      ).toEqual([]);
      expect(invalidated).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();

      await writeTabsFile(workspaceId, entryId, latestTabs.tabs, {
        syncSummary: false,
      });
      await syncWorkEntrySummaryFromWrite(
        workspaceId,
        entryId,
        latestTabs,
        () => currentRevision === 2,
      );
      const row = (await readRegistryFile(registryPath)).entries.find(
        (entry) => entry.id === entryId,
      );
      expect(row?.summary?.title).toBe('Latest');
      expect(invalidated).toHaveBeenCalledWith(workspaceId);
    } finally {
      write.mockRestore();
      invalidated.mockRestore();
      warning.mockRestore();
      await removeWorkEntryRow(workspaceId, entryId);
    }
  });

  it.each([1, 2])(
    'does not install an older summary superseded during registry rename retry %i',
    async (heldRetry) => {
      const workspaceId = APP_ADVISOR_PROJECT_ID;
      const created = await createWorkEntry(workspaceId);
      const entryId = created.entry.id;
      const oldTabs: ChatTabsFile = {
        version: 1,
        activeTabId: 'first-chat',
        tabs: [
          chatTab({ id: 'first-chat', description: 'Old', timestamp: 1000 }),
        ],
      };
      const latestTabs: ChatTabsFile = {
        version: 1,
        activeTabId: 'second-chat',
        tabs: [
          chatTab({ id: 'first-chat', description: 'Old', timestamp: 1000 }),
          chatTab({
            id: 'second-chat',
            description: 'Latest',
            timestamp: 2000,
          }),
        ],
      };
      await writeTabsFile(workspaceId, entryId, oldTabs.tabs, {
        syncSummary: false,
      });
      const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
      const before = await readFile(registryPath, 'utf8');
      const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
      let currentRevision = 1;
      let registryRenames = 0;
      const originalRename = fs.rename;
      // Every currency check before the first attempt passes. Each attempt
      // up to the held retry hits a sharing violation, and the newer revision
      // commits during the backoff before that retry.
      const rename = jest
        .spyOn(fs, 'rename')
        .mockImplementation(async (from, to) => {
          if (String(from).includes('.work-entries-')) {
            registryRenames += 1;
            if (registryRenames <= heldRetry) {
              if (registryRenames === heldRetry)
                setImmediate(() => {
                  currentRevision = 2;
                });
              throw Object.assign(new Error('sharing violation'), {
                code: 'EBUSY',
              });
            }
          }
          return originalRename(from, to);
        });
      const sidebarGroups = await import('../lib/sidebar-item-groups');
      const invalidated = jest.spyOn(
        sidebarGroups,
        'publishSidebarItemGroupsChanged',
      );
      const logging = await import('../lib/main-process-logging');
      const warning = jest.spyOn(logging, 'logMainProcessWarn');
      try {
        await expect(
          syncWorkEntrySummaryFromWrite(
            workspaceId,
            entryId,
            oldTabs,
            () => currentRevision === 1,
          ),
        ).resolves.toBeUndefined();
        expect(currentRevision).toBe(2);
        expect(await readFile(registryPath, 'utf8')).toBe(before);
        expect(registryRenames).toBe(heldRetry);
        expect(
          readdirSync(dirname(registryPath)).filter((name) =>
            name.endsWith('.tmp'),
          ),
        ).toEqual([]);
        expect(invalidated).not.toHaveBeenCalled();
        expect(warning).not.toHaveBeenCalled();

        // The skipped older summary leaves no state that blocks the newer one.
        await writeTabsFile(workspaceId, entryId, latestTabs.tabs, {
          syncSummary: false,
        });
        await syncWorkEntrySummaryFromWrite(
          workspaceId,
          entryId,
          latestTabs,
          () => currentRevision === 2,
        );
        const row = (await readRegistryFile(registryPath)).entries.find(
          (entry) => entry.id === entryId,
        );
        expect(row?.summary?.title).toBe('Latest');
        expect(invalidated).toHaveBeenCalledWith(workspaceId);
      } finally {
        rename.mockRestore();
        invalidated.mockRestore();
        warning.mockRestore();
        await removeWorkEntryRow(workspaceId, entryId);
      }
    },
  );

  it('publishes scope projections while the registry is unreadable and persists the summary on retry', async () => {
    const workspaceId = APP_ADVISOR_PROJECT_ID;
    const created = await createWorkEntry(workspaceId);
    const entryId = created.entry.id;
    const tabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'retry-chat',
      tabs: [
        chatTab({
          id: 'retry-chat',
          description: 'Persisted on retry',
          timestamp: 3000,
        }),
      ],
    };
    await writeTabsFile(workspaceId, entryId, tabs.tabs, {
      syncSummary: false,
    });
    const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
    const registry = await readFile(registryPath, 'utf8');
    await writeFile(registryPath, 'not json', 'utf8');
    const retries: Array<() => void> = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let summary: Promise<void> = Promise.resolve();
    const publishScope = jest.fn();
    const nudgeSummary = jest.fn();
    const observer = createChatTabsAuxiliaryProjectionObserver({
      indexSearch: () => undefined,
      syncBadges: () => undefined,
      syncWorkEntrySummary: (...args) => {
        summary = syncWorkEntrySummaryFromWrite(...args);
        return summary;
      },
      publishRuntimeStatus: () => undefined,
      publishScope,
      nudgeSummary,
      logRetry: () => undefined,
      schedule: (retry) => {
        retries.push(retry);
        const timer = setTimeout(() => undefined, 60_000);
        timers.push(timer);
        return timer;
      },
    });
    try {
      await observer(workspaceId, entryId, tabs, undefined, 1, () => true);
      await expect(summary).rejects.toThrow();
      expect(publishScope).toHaveBeenCalledTimes(1);
      expect(retries).toHaveLength(1);

      await writeFile(registryPath, registry, 'utf8');
      retries[0]?.();
      await summary;
      const row = (await readRegistryFile(registryPath)).entries.find(
        (entry) => entry.id === entryId,
      );
      expect(row?.summary?.title).toBe('Persisted on retry');
      expect(retries).toHaveLength(1);
      expect(publishScope).toHaveBeenCalledTimes(1);
      expect(nudgeSummary).toHaveBeenCalledTimes(1);
    } finally {
      timers.forEach(clearTimeout);
      if ((await readFile(registryPath, 'utf8')) === 'not json') {
        await writeFile(registryPath, registry, 'utf8');
      }
      await removeWorkEntryRow(workspaceId, entryId);
    }
  });

  it('nudges the sidebar once a summary that failed before projecting lands on retry', async () => {
    const workspaceId = APP_ADVISOR_PROJECT_ID;
    const created = await createWorkEntry(workspaceId);
    const entryId = created.entry.id;
    const tabs: ChatTabsFile = {
      version: 1,
      activeTabId: 'stat-chat',
      tabs: [
        chatTab({
          id: 'stat-chat',
          description: 'Listed after retry',
          timestamp: 4000,
        }),
      ],
    };
    await writeTabsFile(workspaceId, entryId, tabs.tabs, {
      syncSummary: false,
    });
    const sourcePath = await summarySourcePath(workspaceId, entryId);
    const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
    const originalStat = fs.stat;
    let statFailures = 1;
    const statSpy = jest
      .spyOn(fs, 'stat')
      .mockImplementation(async (...args) => {
        if (statFailures > 0 && args[0] === sourcePath) {
          statFailures -= 1;
          throw Object.assign(new Error('EACCES: permission denied'), {
            code: 'EACCES',
          });
        }
        return originalStat(...args);
      });
    const listedTitle = async (): Promise<string | undefined> =>
      (await listWorkEntries(workspaceId)).find((entry) => entry.id === entryId)
        ?.title;
    const retries: Array<() => void> = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let summary: Promise<void> = Promise.resolve();
    const events: string[] = [];
    const observer = createChatTabsAuxiliaryProjectionObserver({
      indexSearch: () => {
        events.push('search');
      },
      syncBadges: () => {
        events.push('badges');
      },
      syncWorkEntrySummary: (...args) => {
        summary = syncWorkEntrySummaryFromWrite(...args);
        return summary;
      },
      publishRuntimeStatus: () => undefined,
      publishScope: () => {
        events.push('publish');
      },
      nudgeSummary: (projectId, worktreeId) =>
        events.push(`nudge:${projectId}/${worktreeId}`),
      logRetry: () => undefined,
      schedule: (retry) => {
        retries.push(retry);
        const timer = setTimeout(() => undefined, 60_000);
        timers.push(timer);
        return timer;
      },
    });
    try {
      await observer(workspaceId, entryId, tabs, undefined, 1, () => true);
      await expect(summary).rejects.toThrow('EACCES');
      // The failure came before the live summary was cached.
      expect(events).toEqual(['search', 'badges', 'publish']);
      statSpy.mockRestore();
      const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
      expect(
        (await readRegistryFile(registryPath)).entries.find(
          (entry) => entry.id === entryId,
        )?.summary?.title,
      ).not.toBe('Listed after retry');

      retries[0]?.();
      await summary;
      for (let turn = 0; turn < 5 && events.length < 4; turn++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).toEqual([
        'search',
        'badges',
        'publish',
        `nudge:${workspaceId}/${entryId}`,
      ]);
      expect(retries).toHaveLength(1);
      expect(await listedTitle()).toBe('Listed after retry');
    } finally {
      statSpy.mockRestore();
      timers.forEach(clearTimeout);
      await removeWorkEntryRow(workspaceId, entryId);
    }
  });

  it('backfills a compact summary for a legacy registry row', async () => {
    const workspaceId = 'summary-backfill-ws';
    const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'legacy-entry',
            createdAt: '2026-08-17T09:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );
    await writeTabsFile(
      workspaceId,
      'legacy-entry',
      [
        chatTab({
          id: 'legacy-chat',
          description: 'Legacy transcript',
          timestamp: 5_000,
          providerType: 'claude',
        }),
      ],
      { syncSummary: false },
    );

    await listWorkEntries(workspaceId);

    // Catalog hydration must not run the destructive transcript cutover for
    // an unrelated entry before the user opens it.
    const legacyPath = getWorkspaceChatTabsFilePath(
      workspaceId,
      'legacy-entry',
    );
    expect(existsSync(legacyPath)).toBe(true);
    expect(
      await new ChatStorageV2(
        dirname(dirname(legacyPath)),
        'legacy-entry',
      ).authority(),
    ).toBe('v1');

    const persisted = await readRegistryFile(registryPath);
    expect(persisted.entries[0]?.summary).toMatchObject({
      version: 1,
      title: 'Legacy transcript',
      lastMessageAt: new Date(5_000).toISOString(),
      providerType: 'claude',
      chatCount: 1,
      chats: [
        {
          id: 'legacy-chat',
          title: 'New Chat',
          description: 'Legacy transcript',
          createdAt: new Date(5_000).toISOString(),
          lastMessageAt: new Date(5_000).toISOString(),
          providerType: 'claude',
        },
      ],
    });
    expect(typeof persisted.entries[0]?.summary?.sourceMtimeNs).toBe('string');
  });

  it('recovers a catalog summary from backup and journal without changing their evidence', async () => {
    const workspaceId = 'summary-recovery-no-cutover';
    const entryId = 'unopened-entry';
    await createWorkEntry(workspaceId, { id: entryId });
    await writeTabsFile(workspaceId, entryId, [chatTab({ id: 'old-chat' })], {
      syncSummary: false,
    });
    const legacyPath = getWorkspaceChatTabsFilePath(workspaceId, entryId);
    const backup = await readFile(legacyPath, 'utf8');
    await writeFile(legacyPath + '.bak', backup);
    const suspect = '{"version":1,"tabs":[';
    await writeFile(legacyPath, suspect);
    const journalPath = getWorkspaceChatJournalFilePath(workspaceId, entryId);
    await mkdir(dirname(journalPath), { recursive: true });
    const journal =
      JSON.stringify({
        v: 1,
        revision: 1,
        mutationId: 'summary-update',
        source: 'provider',
        occurredAt: '2026-09-05',
        mutations: [
          {
            type: 'tab.metadata_patched',
            tabId: 'old-chat',
            patch: { description: 'Recovered investigation', unread: true },
          },
          {
            type: 'message.upserted',
            chatId: 'old-chat',
            message: {
              id: 'last-answer',
              role: 'assistant',
              timestamp: 9000,
              blocks: [
                { type: 'text', text: 'Recovered response' },
                {
                  type: 'tool_result',
                  toolUseId: 'large',
                  toolName: 'Read',
                  output: 'x'.repeat(70000),
                  isError: false,
                },
              ],
            },
          },
        ],
      }) + '\n';
    await writeFile(journalPath, journal);
    await expect(listWorkEntries(workspaceId)).resolves.toMatchObject([
      {
        id: entryId,
        title: 'Recovered investigation',
        lastMessageAt: new Date(9000).toISOString(),
        unreadChats: [{ chatId: 'old-chat', preview: 'Recovered response' }],
      },
    ]);
    expect(await readFile(legacyPath, 'utf8')).toBe(suspect);
    expect(await readFile(legacyPath + '.bak', 'utf8')).toBe(backup);
    expect(await readFile(journalPath, 'utf8')).toBe(journal);
    expect(
      await new ChatStorageV2(
        dirname(dirname(legacyPath)),
        entryId,
      ).authority(),
    ).toBe('v1');
    const created = await createWorkEntry(workspaceId);
    expect(created.reusedExistingEmpty).toBe(false);
    expect(created.entry.id).not.toBe(entryId);
  });

  it('does not persist or reuse an oversized legacy entry as empty', async () => {
    const workspaceId = 'oversized-summary-backfill-ws';
    const entryId = 'oversized-legacy-entry';
    const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
    const tabsPath = getWorkspaceChatTabsFilePath(workspaceId, entryId);
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: entryId,
            createdAt: '2026-08-17T09:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );
    await mkdir(dirname(tabsPath), { recursive: true });
    await writeFile(tabsPath, '', 'utf8');
    await truncate(tabsPath, 256 * 1024 * 1024 + 1);

    await listWorkEntries(workspaceId);

    const persisted = await readRegistryFile(registryPath);
    expect(persisted.entries[0]?.summary).toBeUndefined();

    const created = await createWorkEntry(workspaceId);
    expect(created.reusedExistingEmpty).toBe(false);
    expect(created.entry.id).not.toBe(entryId);
  });

  it('does not persist a corrupt legacy chat file as an empty summary', async () => {
    const workspaceId = 'corrupt-summary-backfill-ws';
    const entryId = 'corrupt-legacy-entry';
    const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
    const tabsPath = getWorkspaceChatTabsFilePath(workspaceId, entryId);
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: entryId,
            createdAt: '2026-08-17T09:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );
    await mkdir(dirname(tabsPath), { recursive: true });
    await writeFile(tabsPath, '{"version":1,"tabs":[', 'utf8');

    await listWorkEntries(workspaceId);

    const persisted = await readRegistryFile(registryPath);
    expect(persisted.entries[0]?.summary).toBeUndefined();
  });

  it('drains an active legacy backfill before a project directory is removed', async () => {
    const workspaceId = 'summary-deletion-race-ws';
    const entryId = 'legacy-entry';
    const registryPath = getWorkspaceWorkEntriesFilePath(workspaceId);
    const tabsPath = getWorkspaceChatTabsFilePath(workspaceId, entryId);
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: entryId,
            createdAt: '2026-08-17T09:00:00.000Z',
          },
        ],
      }),
      'utf8',
    );
    await mkdir(dirname(tabsPath), { recursive: true });
    await writeFile(tabsPath, '', 'utf8');
    await truncate(tabsPath, 8 * 1024 * 1024);

    const listing = listWorkEntries(workspaceId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await clearWorkEntrySummariesForWorkspace(workspaceId);
    await rm(dirname(registryPath), { recursive: true, force: true });
    await listing;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(existsSync(registryPath)).toBe(false);

    activateWorkEntryWorkspace(workspaceId);
    await createWorkEntry(workspaceId, { title: 'Recreated safely' });
    expect(existsSync(registryPath)).toBe(true);
  });

  it('creates entries, derives display meta from tab files, and preserves registry order', async () => {
    const older = await createWorkEntry(WS, { title: 'Older entry' });
    const newer = await createWorkEntry(WS, { title: 'Newer entry' });
    expect(older.reusedExistingEmpty).toBe(false);
    expect(newer.reusedExistingEmpty).toBe(false);

    await writeTabsFile(WS, older.entry.id, [
      chatTab({
        id: 'chat-old',
        description: 'Ship the report',
        timestamp: 2_000,
        providerType: 'claude',
      }),
    ]);
    await writeTabsFile(WS, newer.entry.id, [
      chatTab({
        id: 'chat-new',
        description: 'Fix the deck',
        timestamp: 9_000,
        providerType: 'codex',
      }),
      chatTab({ id: 'file-tab', kind: 'file' }),
    ]);

    const entries = await listWorkEntries(WS);
    expect(entries.map((entry) => entry.id)).toEqual([
      newer.entry.id,
      older.entry.id,
    ]);
    // Rename overrides win; derived meta comes from the entry's chats.
    expect(entries[0]).toMatchObject({
      title: 'Newer entry',
      providerType: 'codex',
      chatCount: 1, // file tabs excluded
      lastMessageAt: new Date(9_000).toISOString(),
    });

    await updateWorkEntryTitle(WS, newer.entry.id, null);
    const untitled = await listWorkEntries(WS);
    expect(untitled[0]?.title).toBe('Fix the deck');
  });

  it('round-trips the done status through updateWorkEntry', async () => {
    const workspaceId = 'status-ws';
    const created = await createWorkEntry(workspaceId, { title: 'Refunds' });

    // Unset by default (absent key == active).
    expect(created.entry.status).toBeUndefined();

    await updateWorkEntry(workspaceId, created.entry.id, { status: 'done' });
    const done = await readWorkEntriesFile(workspaceId);
    expect(done.entries[0].status).toBe('done');
    expect((await listWorkEntries(workspaceId))[0]?.status).toBe('done');

    // `active` clears the persisted flag rather than writing the default.
    await updateWorkEntry(workspaceId, created.entry.id, { status: 'active' });
    const active = await readWorkEntriesFile(workspaceId);
    expect(active.entries[0]).not.toHaveProperty('status');
    expect((await listWorkEntries(workspaceId))[0]?.status).toBeUndefined();
  });

  it('round-trips pin state through updateWorkEntry and list projection', async () => {
    const workspaceId = 'pinned-ws';
    const created = await createWorkEntry(workspaceId, { title: 'Pinned' });

    expect(created.entry.pinned).toBeUndefined();

    await updateWorkEntry(workspaceId, created.entry.id, { pinned: true });
    expect((await readWorkEntriesFile(workspaceId)).entries[0]?.pinned).toBe(
      true,
    );
    expect((await listWorkEntries(workspaceId))[0]?.pinned).toBe(true);

    await updateWorkEntry(workspaceId, created.entry.id, { pinned: false });
    expect(
      (await readWorkEntriesFile(workspaceId)).entries[0],
    ).not.toHaveProperty('pinned');
    expect((await listWorkEntries(workspaceId))[0]?.pinned).toBeUndefined();
  });

  it('reports whether updateWorkEntry matched a registry row', async () => {
    const workspaceId = 'update-result-ws';
    const created = await createWorkEntry(workspaceId, { title: 'Existing' });

    await expect(
      updateWorkEntry(workspaceId, created.entry.id, { status: 'done' }),
    ).resolves.toBe(true);
    await expect(
      updateWorkEntry(workspaceId, 'missing-entry', { status: 'done' }),
    ).resolves.toBe(false);
  });

  it('applies a title and a status in one registry write', async () => {
    const workspaceId = 'status-title-ws';
    const created = await createWorkEntry(workspaceId, { title: 'Before' });

    await updateWorkEntry(workspaceId, created.entry.id, {
      title: 'SUP-9 After',
      status: 'done',
    });

    const file = await readWorkEntriesFile(workspaceId);
    expect(file.entries[0]).toMatchObject({
      title: 'SUP-9 After',
      status: 'done',
    });
  });

  it('leaves untouched fields alone for an omitted patch key', async () => {
    const workspaceId = 'status-partial-ws';
    const created = await createWorkEntry(workspaceId, { title: 'Keep me' });
    await updateWorkEntry(workspaceId, created.entry.id, { status: 'done' });

    // Title-only patch must not clear the status, and vice versa.
    await updateWorkEntry(workspaceId, created.entry.id, { title: 'Renamed' });
    expect((await readWorkEntriesFile(workspaceId)).entries[0]).toMatchObject({
      title: 'Renamed',
      status: 'done',
    });

    await updateWorkEntry(workspaceId, created.entry.id, { status: 'active' });
    expect((await readWorkEntriesFile(workspaceId)).entries[0]).toMatchObject({
      title: 'Renamed',
    });
  });

  it('normalizes an unknown status to active instead of hiding the project', () => {
    // Forward-compat both directions: `parseWorkEntriesFile` is all-or-nothing
    // and `readWorkEntriesFile` swallows a throw into an EMPTY registry, so
    // rejecting a status written by a NEWER build would make one row hide every
    // Work Entry in the workspace.
    const parsed = parseWorkEntriesFile(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'entry-a',
            createdAt: '2026-01-01T00:00:00.000Z',
            status: 'archived',
          },
          {
            id: 'entry-b',
            createdAt: '2026-01-02T00:00:00.000Z',
            status: 'done',
          },
        ],
      }),
    );

    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].status).toBeUndefined();
    // A recognized sibling on the same file is untouched.
    expect(parsed.entries[1].status).toBe('done');
  });

  it.each([{ title: 'Renamed' }, { status: 'done' as const }])(
    'counts entry edits as activity: %p',
    async (patch) => {
      const workspaceId = 'entry-edit-activity';
      const created = await createWorkEntry(workspaceId, {
        title: 'Old',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const before = Date.now();
      await updateWorkEntry(workspaceId, created.entry.id, patch);
      const file = await readRegistryFile(
        getWorkspaceWorkEntriesFilePath(workspaceId),
      );
      expect(
        Date.parse(file.entries[0].lastTouchedAt ?? ''),
      ).toBeGreaterThanOrEqual(before);
    },
  );

  it.each([
    [true, true],
    ['yes', false],
  ])(
    'validates the summary unread-chat markedUnread flag %p',
    (markedUnread, kept) => {
      const parsed = parseWorkEntriesFile(
        JSON.stringify({
          version: 1,
          entries: [
            {
              id: 'entry-a',
              createdAt: '2026-01-01T00:00:00.000Z',
              summary: {
                version: 1,
                title: 'Entry',
                chatCount: 1,
                chats: [],
                unreadChats: [{ chatId: 'chat-a', markedUnread }],
              },
            },
          ],
        }),
      );
      expect(parsed.entries[0].summary?.unreadChats).toEqual(
        kept ? [{ chatId: 'chat-a', markedUnread: true }] : undefined,
      );
    },
  );

  it('normalizes a non-string status too, rather than blanking the registry', () => {
    // Same failure mode as an unknown string: a bad `status` must never be able
    // to hide every Work Entry in the workspace.
    const parsed = parseWorkEntriesFile(
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'entry-a',
            createdAt: '2026-01-01T00:00:00.000Z',
            status: 42,
          },
        ],
      }),
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].status).toBeUndefined();
  });

  it('still rejects a registry that is structurally invalid', () => {
    // A missing/!string `createdAt` or a path-unsafe id is genuine corruption,
    // not a forward-compat value, and must still fail loudly.
    expect(() =>
      parseWorkEntriesFile(
        JSON.stringify({
          version: 1,
          entries: [{ id: 'entry-a', createdAt: 42 }],
        }),
      ),
    ).toThrow('Invalid work-entry registry');

    expect(() =>
      parseWorkEntriesFile(
        JSON.stringify({
          version: 1,
          entries: [{ id: '../escape', createdAt: '2026-01-01T00:00:00.000Z' }],
        }),
      ),
    ).toThrow('Invalid work-entry registry');

    expect(
      parseWorkEntriesFile(
        JSON.stringify({
          version: 1,
          entries: [
            {
              id: 'entry-a',
              createdAt: '2026-01-01T00:00:00.000Z',
              status: 'done',
            },
          ],
        }),
      ).entries[0].status,
    ).toBe('done');
  });

  it('persists manual entry order', async () => {
    const workspaceId = 'reorder-ws';
    const first = await createWorkEntry(workspaceId, { title: 'First' });
    const middle = await createWorkEntry(workspaceId, { title: 'Middle' });
    const last = await createWorkEntry(workspaceId, { title: 'Last' });

    await reorderWorkEntries(workspaceId, [
      last.entry.id,
      first.entry.id,
      middle.entry.id,
    ]);

    await expect(listWorkEntries(workspaceId)).resolves.toMatchObject([
      { id: last.entry.id },
      { id: first.entry.id },
      { id: middle.entry.id },
    ]);
    await expect(
      reorderWorkEntries(workspaceId, [first.entry.id]),
    ).rejects.toThrow('does not match entries');
  });

  it('derives unreadChats (with previews) and injected hasActiveChat', async () => {
    const badgeWs = 'badge-ws';
    const entry = await createWorkEntry(badgeWs, { title: 'Badged entry' });
    await writeTabsFile(badgeWs, entry.entry.id, [
      {
        ...chatTab({
          id: 'chat-unread',
          description: 'Needs attention',
          timestamp: 3_000,
          providerType: 'claude',
        }),
        title: 'Unread chat',
        unread: true,
        messages: [
          {
            id: 'chat-unread-m1',
            role: 'user',
            timestamp: 3_000,
            blocks: [{ type: 'text', text: 'hello' }],
          },
          {
            id: 'chat-unread-m2',
            role: 'assistant',
            timestamp: 3_500,
            blocks: [{ type: 'text', text: 'All done — report shipped.' }],
          },
        ],
      },
      chatTab({ id: 'chat-read', timestamp: 2_000 }),
    ]);

    // Without a live-session lookup: unread derives from the tab file,
    // hasActiveChat stays unset.
    const entries = await listWorkEntries(badgeWs);
    const meta = entries.find((candidate) => candidate.id === entry.entry.id);
    expect(meta?.hasActiveChat).toBeUndefined();
    expect(meta?.unreadChats).toEqual([
      {
        chatId: 'chat-unread',
        title: 'Unread chat',
        providerType: 'claude',
        preview: 'All done — report shipped.',
      },
    ]);

    // With the injected lookup reporting an in-flight turn for this entry.
    const active = await listWorkEntries(badgeWs, {
      getActiveChatIds: (workspaceId, entryId) =>
        workspaceId === badgeWs && entryId === entry.entry.id
          ? ['chat-unread']
          : [],
    });
    const activeMeta = active.find(
      (candidate) => candidate.id === entry.entry.id,
    );
    expect(activeMeta?.hasActiveChat).toBe(true);

    // No unread tabs → the field is omitted entirely.
    await writeTabsFile(badgeWs, entry.entry.id, [
      chatTab({ id: 'chat-read', timestamp: 2_000 }),
    ]);
    const cleared = await listWorkEntries(badgeWs);
    const clearedMeta = cleared.find(
      (candidate) => candidate.id === entry.entry.id,
    );
    expect(clearedMeta?.unreadChats).toBeUndefined();
  });

  it('reuses an existing empty entry instead of stacking duplicates', async () => {
    const first = await createWorkEntry('reuse-ws');
    const second = await createWorkEntry('reuse-ws');
    expect(second.reusedExistingEmpty).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);

    // Once the entry has a message it is no longer reusable.
    await writeTabsFile('reuse-ws', first.entry.id, [
      chatTab({ id: 'c1', timestamp: 500 }),
    ]);
    const third = await createWorkEntry('reuse-ws');
    expect(third.reusedExistingEmpty).toBe(false);
    expect(third.entry.id).not.toBe(first.entry.id);
  });

  it.each([
    { title: 'Research desk' },
    { pinned: true },
    { status: 'done' as const },
  ])(
    'preserves an empty entry with sidebar customization %j',
    async (patch) => {
      const workspaceId = `customized-${Object.keys(patch)[0]}-ws`;
      const first = await createWorkEntry(workspaceId);
      await updateWorkEntry(workspaceId, first.entry.id, patch);
      const fresh = await createWorkEntry(workspaceId);
      expect(fresh.reusedExistingEmpty).toBe(false);
      expect(fresh.entry.id).not.toBe(first.entry.id);
      expect((await readWorkEntriesFile(workspaceId)).entries).toContainEqual(
        expect.objectContaining({ id: first.entry.id, ...patch }),
      );
    },
  );

  it('preserves an empty entry with a saved panel layout, including pending writes', async () => {
    const workspaceId = 'customized-layout-ws';
    const first = await createWorkEntry(workspaceId);
    panelLayoutPersistenceStore.saveWorktreeLayout(
      workspaceId,
      first.entry.id,
      {
        version: 1,
        grid: {
          orientation: 0,
          width: 1200,
          height: 800,
          root: {
            type: 'leaf',
            groupId: 'research-files',
            size: 1200,
            panels: [{ kind: 'file-explorer', panelId: 'files' }],
            activePanelId: 'files',
          },
        },
        activeGroupId: 'research-files',
        mostRecentActiveGroupIds: ['research-files'],
      },
    );
    const fresh = await createWorkEntry(workspaceId);
    expect(fresh.reusedExistingEmpty).toBe(false);
    expect(fresh.entry.id).not.toBe(first.entry.id);
    panelLayoutPersistenceStore.flushAllSync();
    expect((await createWorkEntry(workspaceId)).entry.id).toBe(fresh.entry.id);
  });

  it('moves a reused empty entry to the top of the manual order as the most recent', async () => {
    const workspaceId = 'reuse-to-top-ws';
    const emptyCreatedAt = '2026-01-01T00:00:00.000Z';
    await createWorkEntry(workspaceId, {
      id: 'empty-entry',
      createdAt: emptyCreatedAt,
    });
    const busy = await createWorkEntry(workspaceId, {
      id: 'busy-entry',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    await writeTabsFile(workspaceId, busy.entry.id, [
      chatTab({ id: 'busy-chat', timestamp: Date.parse('2026-02-02') }),
    ]);
    expect(await listWorkEntryIds(workspaceId)).toEqual([
      'busy-entry',
      'empty-entry',
    ]);

    const changed: string[] = [];
    const stop = onWorkEntryListChanged((id) => {
      if (id === workspaceId) changed.push(id);
    });
    const before = Date.now();
    let reused: Awaited<ReturnType<typeof createWorkEntry>>;
    try {
      reused = await createWorkEntry(workspaceId);
    } finally {
      stop();
    }

    expect(reused.reusedExistingEmpty).toBe(true);
    expect(reused.entry.id).toBe('empty-entry');
    // The reused entry is the user's new chat: it leads the manual order...
    const registry = await readWorkEntriesFile(workspaceId);
    expect(registry.entries.map((entry) => entry.id)).toEqual([
      'empty-entry',
      'busy-entry',
    ]);
    // ...and its activity watermark makes it the newest in recency order,
    // while createdAt stays the archive generation fence.
    const row = registry.entries[0];
    expect(Date.parse(row?.lastTouchedAt ?? '')).toBeGreaterThanOrEqual(before);
    expect(row?.createdAt).toBe(emptyCreatedAt);
    expect(reused.entry.lastTouchedAt).toBe(row?.lastTouchedAt);
    // Moving a row shifts every sibling's index, so observers hear about it.
    expect(changed).toEqual([workspaceId]);
  });

  it('preserves a completed pinned empty entry when creating a fresh entry', async () => {
    const workspaceId = 'reuse-done-ws';
    await createWorkEntry(workspaceId, { id: 'done-entry' });
    await updateWorkEntry(workspaceId, 'done-entry', {
      status: 'done',
      pinned: true,
    });
    const fresh = await createWorkEntry(workspaceId);
    expect(fresh.reusedExistingEmpty).toBe(false);
    expect(fresh.entry.id).not.toBe('done-entry');
    expect((await readWorkEntriesFile(workspaceId)).entries).toContainEqual(
      expect.objectContaining({
        id: 'done-entry',
        status: 'done',
        pinned: true,
      }),
    );
  });

  it('seeds a new entry from the current default without overwriting a reused entry', async () => {
    const workspaceId = 'layout-mode-reuse-ws';
    await writeWorkspaceDefaultLayoutMode('minimal');
    const first = await createWorkEntry(workspaceId);
    const modePath = getWorktreePanelLayoutModeFilePath(
      workspaceId,
      first.entry.id,
    );
    await expect(readFile(modePath, 'utf8')).resolves.toContain(
      '"mode": "minimal"',
    );

    await writeWorkspaceDefaultLayoutMode('advanced');
    const reused = await createWorkEntry(workspaceId);
    expect(reused).toMatchObject({
      reusedExistingEmpty: true,
      entry: { id: first.entry.id },
    });
    await expect(readFile(modePath, 'utf8')).resolves.toContain(
      '"mode": "minimal"',
    );
  });

  it('logs a failed seed but still returns the newly registered entry', async () => {
    const workspaceId = 'layout-mode-failure-ws';
    const entryId = 'entry-with-blocked-mode-dir';
    const modePath = getWorktreePanelLayoutModeFilePath(workspaceId, entryId);
    await mkdir(dirname(dirname(modePath)), { recursive: true });
    await writeFile(dirname(modePath), 'blocks directory creation', 'utf8');
    const logging = await import('../lib/main-process-logging');
    const warning = jest.spyOn(logging, 'logMainProcessWarn');

    await expect(
      createWorkEntry(workspaceId, { id: entryId }),
    ).resolves.toMatchObject({
      reusedExistingEmpty: false,
      entry: { id: entryId },
    });
    expect(warning).toHaveBeenCalledWith(
      'Failed to seed cowork Work Entry panel layout mode',
      expect.objectContaining({ workspaceId, entryId }),
    );
    await expect(listWorkEntryIds(workspaceId)).resolves.toContain(entryId);
  });

  it('does not reuse an entry whose only conversation is archived', async () => {
    const used = await createWorkEntry('archived-reuse-ws');
    await writeTabsFile('archived-reuse-ws', used.entry.id, [
      chatTab({ id: 'fallback-chat' }),
    ]);

    const archivesPath = getWorkspaceChatArchivesFilePath(
      'archived-reuse-ws',
      used.entry.id,
    );
    await mkdir(dirname(archivesPath), { recursive: true });
    await writeFile(
      archivesPath,
      JSON.stringify({
        version: 1,
        archived: [
          {
            tab: chatTab({ id: 'archived-chat', timestamp: 500 }),
            archivedAt: new Date(600).toISOString(),
            turnCount: 1,
          },
        ],
      }),
      'utf8',
    );
    resetChatStateServiceForTests();

    const fresh = await createWorkEntry('archived-reuse-ws');
    expect(fresh.reusedExistingEmpty).toBe(false);
    expect(fresh.entry.id).not.toBe(used.entry.id);
    expect(
      await new ChatStorageV2(
        dirname(dirname(archivesPath)),
        used.entry.id,
      ).authority(),
    ).toBe('v1');
    expect(existsSync(archivesPath)).toBe(true);

    const reusedFresh = await createWorkEntry('archived-reuse-ws');
    expect(reusedFresh.reusedExistingEmpty).toBe(true);
    expect(reusedFresh.entry.id).toBe(fresh.entry.id);
  });

  it('resolves a chat to its entry across live tabs and unified archives', async () => {
    const entry = await createWorkEntry('resolve-ws', { title: 'A' });
    await writeTabsFile('resolve-ws', entry.entry.id, [
      chatTab({ id: 'live-chat', timestamp: 100 }),
    ]);
    const archivesPath = getWorkspaceChatArchivesFilePath(
      'resolve-ws',
      entry.entry.id,
    );
    await mkdir(dirname(archivesPath), { recursive: true });
    await writeFile(
      archivesPath,
      JSON.stringify({
        version: 1,
        archived: [
          {
            tab: chatTab({ id: 'archived-chat', timestamp: 50 }),
            archivedAt: new Date(60).toISOString(),
            turnCount: 1,
          },
        ],
      }),
      'utf8',
    );
    resetChatStateServiceForTests();

    await expect(
      resolveWorkEntryForChat('resolve-ws', 'live-chat'),
    ).resolves.toEqual({ entryId: entry.entry.id, archivedInEntryId: null });
    await expect(
      resolveWorkEntryForChat('resolve-ws', 'archived-chat'),
    ).resolves.toEqual({ entryId: null, archivedInEntryId: entry.entry.id });
    await expect(
      resolveWorkEntryForChat('resolve-ws', 'unknown-chat'),
    ).resolves.toEqual({ entryId: null, archivedInEntryId: null });
  }, 15_000);

  it('resolves a live chat from the compact registry index without reading sibling histories', async () => {
    const target = await createWorkEntry('indexed-resolve-ws', {
      title: 'Target',
    });
    const sibling = await createWorkEntry('indexed-resolve-ws', {
      title: 'Sibling',
    });
    await writeTabsFile('indexed-resolve-ws', target.entry.id, [
      chatTab({ id: 'indexed-target-chat', timestamp: 100 }),
    ]);
    await writeFile(
      getWorkspaceChatTabsFilePath('indexed-resolve-ws', sibling.entry.id),
      'corrupt sibling history that must not be read',
      'utf8',
    );

    await expect(
      resolveWorkEntryForChat('indexed-resolve-ws', 'indexed-target-chat'),
    ).resolves.toEqual({
      entryId: target.entry.id,
      archivedInEntryId: null,
    });
  });

  it('removes registry rows and tolerates a corrupt registry file', async () => {
    const entry = await createWorkEntry('remove-ws', { title: 'Doomed' });
    await removeWorkEntryRow('remove-ws', entry.entry.id);
    await expect(listWorkEntryIds('remove-ws')).resolves.toEqual([]);

    const filePath = getWorkspaceWorkEntriesFilePath('corrupt-ws');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, 'not json', 'utf8');
    await expect(readWorkEntriesFile('corrupt-ws')).resolves.toEqual({
      version: 1,
      entries: [],
    });
  });

  it('rejects unsafe ids in imported registries', () => {
    expect(() =>
      parseWorkEntriesFile(
        JSON.stringify({
          version: 1,
          entries: [{ id: '../../other-workspace', createdAt: '2026-01-01' }],
        }),
      ),
    ).toThrow('Invalid work-entry registry');
  });

  it('counts valid rows without walking derived summary payloads', () => {
    expect(
      parseWorkEntryCount(
        JSON.stringify({
          version: 1,
          entries: [
            {
              id: 'entry-1',
              createdAt: '2026-01-01T00:00:00.000Z',
              summary: { chats: 'not-an-array' },
            },
            {
              id: 'entry-2',
              createdAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        }),
      ),
    ).toBe(2);
  });

  it('projects the latest persisted workspace activity without hydrating chats', () => {
    expect(
      parseWorkEntrySidebarSummary(
        JSON.stringify({
          version: 1,
          entries: [
            {
              id: 'created-latest',
              createdAt: '2026-09-10T00:00:00.000Z',
            },
            {
              id: 'touched-latest',
              createdAt: '2026-01-01T00:00:00.000Z',
              lastTouchedAt: '2026-09-12T00:00:00.000Z',
            },
            {
              id: 'messaged-latest',
              createdAt: '2026-01-01T00:00:00.000Z',
              summary: {
                lastMessageAt: '2026-09-15T00:00:00.000Z',
              },
            },
          ],
        }),
      ),
    ).toEqual({
      count: 3,
      lastActivityAt: '2026-09-15T00:00:00.000Z',
    });
  });

  it('aborts every mutation without overwriting a corrupt registry', async () => {
    const filePath = getWorkspaceWorkEntriesFilePath('corrupt-mutation-ws');
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, 'not json', 'utf8');

    await expect(
      createWorkEntry('corrupt-mutation-ws', { title: 'Must not replace' }),
    ).rejects.toThrow();
    await expect(
      updateWorkEntryTitle('corrupt-mutation-ws', 'existing-entry', 'Renamed'),
    ).rejects.toThrow();
    await expect(
      removeWorkEntryRow('corrupt-mutation-ws', 'existing-entry'),
    ).rejects.toThrow();
    await expect(
      appendWorkEntryRows('corrupt-mutation-ws', [
        { id: 'new-entry', createdAt: new Date(0).toISOString() },
      ]),
    ).rejects.toThrow();
    await expect(readFile(filePath, 'utf8')).resolves.toBe('not json');
  });
});

describe('App Advisor work entry registry', () => {
  it('uses the app-managed registry, reuses an empty entry, and resolves its chat', async () => {
    const first = await createWorkEntry(APP_ADVISOR_PROJECT_ID, {
      id: 'advisor-entry',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    const reused = await createWorkEntry(APP_ADVISOR_PROJECT_ID);
    expect(reused).toMatchObject({
      reusedExistingEmpty: true,
      entry: { id: first.entry.id },
    });

    await writeTabsFile(APP_ADVISOR_PROJECT_ID, first.entry.id, [
      chatTab({ id: 'advisor-chat', timestamp: 1_000 }),
    ]);
    await expect(
      resolveWorkEntryForChat(APP_ADVISOR_PROJECT_ID, 'advisor-chat'),
    ).resolves.toEqual({
      entryId: 'advisor-entry',
      archivedInEntryId: null,
    });
    expect(getWorkspaceWorkEntriesFilePath(APP_ADVISOR_PROJECT_ID)).toContain(
      join('app-workspaces', APP_ADVISOR_PROJECT_ID),
    );
    expect(existsSync(getWorkspaceIndexFilePath())).toBe(false);
    expect(
      existsSync(
        getWorktreePanelLayoutModeFilePath(
          APP_ADVISOR_PROJECT_ID,
          first.entry.id,
        ),
      ),
    ).toBe(false);
  });
});

describe('cowork work entry migration (home.json split)', () => {
  const WS = 'migrate-ws';

  it('splits home.json into per-chat entries, moves chat plugins, and deletes the source', async () => {
    await writeTabsFile(WS, COWORK_HOME_WORKTREE_ID, [
      chatTab({ id: 'chat-a', description: 'Alpha', timestamp: 1_000 }),
      chatTab({ id: 'chat-b', description: 'Beta', timestamp: 2_000 }),
      chatTab({ id: 'file-tab', kind: 'file' }),
    ]);
    const legacyPluginsDir = join(
      getChatPluginsRootDir(),
      WS,
      COWORK_HOME_WORKTREE_ID,
      'chat-a',
    );
    mkdirSync(legacyPluginsDir, { recursive: true });

    await migrateWorkspaceChatsToWorkEntries(WS);

    const registry = await readWorkEntriesFile(WS);
    expect(registry.entries.map((entry) => entry.id).sort()).toEqual([
      'chat-a',
      'chat-b',
    ]);

    const entryA = await readChatTabsFile(WS, 'chat-a');
    expect(entryA.tabs.map((tab) => tab.id)).toEqual(['chat-a']);
    expect(entryA.activeTabId).toBe('chat-a');

    expect(
      existsSync(getWorkspaceChatTabsFilePath(WS, COWORK_HOME_WORKTREE_ID)),
    ).toBe(false);
    expect(
      existsSync(join(getChatPluginsRootDir(), WS, 'chat-a', 'chat-a')),
    ).toBe(true);
    expect(existsSync(legacyPluginsDir)).toBe(false);

    // Rerun is a no-op (idempotent): no home.json, registry unchanged.
    await migrateWorkspaceChatsToWorkEntries(WS);
    const after = await readWorkEntriesFile(WS);
    expect(after.entries).toHaveLength(2);
  }, 60_000);

  it('is a no-op for a project with no legacy home.json', async () => {
    await migrateWorkspaceChatsToWorkEntries('fresh-ws');
    await expect(listWorkEntryIds('fresh-ws')).resolves.toEqual([]);
  });

  it('reuses the reserved-home entry id when migration is retried', async () => {
    const workspaceId = 'reserved-home-retry-ws';
    const legacyHomeTab = chatTab({
      id: COWORK_HOME_WORKTREE_ID,
      timestamp: 1_000,
    });
    await writeTabsFile(workspaceId, COWORK_HOME_WORKTREE_ID, [legacyHomeTab]);

    await expect(
      splitFlatChatTabsIntoEntries(workspaceId, COWORK_HOME_WORKTREE_ID, {
        removeLegacySource: (): Promise<void> => {
          throw new Error('interrupted before source removal');
        },
      }),
    ).rejects.toThrow('interrupted before source removal');
    const firstEntryIds = await listWorkEntryIds(workspaceId);
    expect(firstEntryIds).toHaveLength(1);
    expect(firstEntryIds[0]).not.toBe(COWORK_HOME_WORKTREE_ID);

    // Retry the actual interrupted migration without rewriting its source revision.
    await migrateWorkspaceChatsToWorkEntries(workspaceId);

    await expect(listWorkEntryIds(workspaceId)).resolves.toEqual(firstEntryIds);
  }, 30_000);

  it('rejects unsafe legacy chat ids before constructing entry paths', async () => {
    await writeTabsFile('unsafe-migrate-ws', COWORK_HOME_WORKTREE_ID, [
      chatTab({ id: '../escape', timestamp: 1_000 }),
    ]);
    await expect(
      migrateWorkspaceChatsToWorkEntries('unsafe-migrate-ws'),
    ).rejects.toThrow('Invalid transcript identity');
  });

  it('preserves a corrupt migration source and aborts the split', async () => {
    const workspaceId = 'corrupt-migrate-ws';
    const homeTabsPath = getWorkspaceChatTabsFilePath(
      workspaceId,
      COWORK_HOME_WORKTREE_ID,
    );
    await mkdir(dirname(homeTabsPath), { recursive: true });
    await writeFile(homeTabsPath, 'not json', 'utf8');

    await expect(
      migrateWorkspaceChatsToWorkEntries(workspaceId),
    ).rejects.toThrow();
    await expect(readFile(homeTabsPath, 'utf8')).resolves.toBe('not json');
    await expect(listWorkEntryIds(workspaceId)).resolves.toEqual([]);
  });
});

describe('readWorkEntryChatCatalog', () => {
  it('lists live chats and archives without admitting a legacy scope, then reads v2 indexes after migration', async () => {
    const workspaceId = 'catalog-ws';
    const entryId = 'entry-1';
    const tabsPath = getWorkspaceChatTabsFilePath(workspaceId, entryId);
    const archivesPath = getWorkspaceChatArchivesFilePath(workspaceId, entryId);
    await mkdir(dirname(tabsPath), { recursive: true });
    await mkdir(dirname(archivesPath), { recursive: true });
    const tabsJson = JSON.stringify({
      version: 1,
      activeTabId: 'chat-a',
      tabs: [
        chatTab({ id: 'chat-a', timestamp: 2000 }),
        chatTab({ id: 'chat-b' }),
        chatTab({ id: 'file-tab', kind: 'file' }),
      ],
    });
    const archivesJson = JSON.stringify({
      version: 1,
      archived: [
        {
          tab: chatTab({ id: 'chat-z', timestamp: 1000 }),
          archivedAt: '2026-08-01T00:00:00.000Z',
          turnCount: 1,
        },
      ],
    });
    await writeFile(tabsPath, tabsJson, 'utf8');
    await writeFile(archivesPath, archivesJson, 'utf8');
    resetChatStateServiceForTests();

    await expect(
      readWorkEntryChatCatalog(workspaceId, entryId),
    ).resolves.toEqual({
      liveChatIds: ['chat-a', 'chat-b'],
      archives: [{ chatId: 'chat-z', archivedAt: '2026-08-01T00:00:00.000Z' }],
    });
    const store = new ChatStorageV2(dirname(dirname(tabsPath)), entryId);
    expect(await store.authority()).toBe('v1');
    expect(existsSync(store.manifestPath)).toBe(false);
    expect(existsSync(store.directory)).toBe(false);
    expect(await readFile(tabsPath, 'utf8')).toBe(tabsJson);
    expect(await readFile(archivesPath, 'utf8')).toBe(archivesJson);

    // Explicit admission migrates; the catalog then answers from v2 indexes.
    await readChatTabsFile(workspaceId, entryId);
    expect(await store.authority()).toBe('v2');
    await expect(
      readWorkEntryChatCatalog(workspaceId, entryId),
    ).resolves.toEqual({
      liveChatIds: ['chat-a', 'chat-b'],
      archives: [{ chatId: 'chat-z', archivedAt: '2026-08-01T00:00:00.000Z' }],
    });
  }, 30_000);

  it('returns an empty catalog for an entry with no chat files', async () => {
    await expect(
      readWorkEntryChatCatalog('catalog-ws', 'missing-entry'),
    ).resolves.toEqual({ liveChatIds: [], archives: [] });
    expect(
      existsSync(
        new ChatStorageV2(
          dirname(dirname(getWorkspaceChatTabsFilePath('catalog-ws', 'x'))),
          'missing-entry',
        ).manifestPath,
      ),
    ).toBe(false);
  });
});

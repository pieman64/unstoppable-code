import type {
  ChatScopeKey,
  ScopePaths,
} from '../services/chat-state-contracts';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initClaudeModels,
  initModelAliases,
  type ArchivedChatEntry,
  type ArchivedChatsFile,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';

const mockGetCompatibilityArchives = jest.fn();
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    getCompatibilityArchives: typeof mockGetCompatibilityArchives;
  } => ({
    getCompatibilityArchives: mockGetCompatibilityArchives,
  }),
}));

import { ChatStateV2Repository } from '../services/chat-state-v2-repository';

jest.mock('../lib/resolve-worktree', () => ({
  resolveChatArchivesFilePath: jest.fn(),
}));

import {
  appendChatArchiveSnapshotForTests as appendChatArchive,
  markAllChatArchivesReadSnapshotForTests as markAllChatArchivesRead,
  markChatArchiveReadSnapshotForTests as markChatArchiveRead,
  readChatArchivesSnapshotForTests as readChatArchivesFile,
  readChatArchivesFileForIndex,
  removeChatArchiveSnapshotForTests as removeChatArchive,
  RESTORE_WINDOW_MS,
  toArchivedChatSummary,
  writeChatArchivesSnapshotForTests as writeChatArchivesFile,
} from '../lib/chat-archives';
import { resolveChatArchivesFilePath } from '../lib/resolve-worktree';

const mockedResolveChatArchivesFilePath = jest.mocked(
  resolveChatArchivesFilePath,
);

initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
initModelAliases({ 'claude-sonnet-4-6': 'sonnet' });

function makeTab(
  id: string,
  createdAt = '2026-06-01T00:00:00.000Z',
): PersistedChatTab {
  return {
    id,
    title: `Chat ${id}`,
    description: `Description ${id}`,
    createdAt,
    providerType: 'codex',
    model: 'gpt-5.5',
    sdkSessionId: `session-${id}`,
    messages: [],
  } satisfies PersistedChatTab;
}

function makeEntry(
  id: string,
  archivedAt = '2026-06-10T00:00:00.000Z',
): ArchivedChatEntry {
  return {
    tab: makeTab(id),
    archivedAt,
    turnCount: 1,
  };
}

describe('chat archives storage', () => {
  it('retains the user-owned title independently of generated metadata in archive summaries', () => {
    const entry = makeEntry('chat-1');
    entry.tab.customTitle = 'My chat';
    expect(
      toArchivedChatSummary(entry, Date.parse('2026-06-11')),
    ).toMatchObject({
      title: 'Chat chat-1',
      customTitle: 'My chat',
      description: 'Description chat-1',
    });
    delete entry.tab.customTitle;
    expect(
      toArchivedChatSummary(entry, Date.parse('2026-06-11')),
    ).not.toHaveProperty('customTitle');
  });
  let tempDir = '';
  let archivePath = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'canopy-chat-archives-'));
    archivePath = join(tempDir, 'workspace-a', 'chat-archives', 'wt-a.json');
    mockedResolveChatArchivesFilePath.mockReturnValue(archivePath);
    const repository = new ChatStateV2Repository({
      resolvePaths: (): ScopePaths => ({
        tabs: join(tempDir, 'workspace-a', 'chats', 'wt-a.json'),
        archives: archivePath,
        journal: join(tempDir, 'workspace-a', 'chat-journals', 'wt-a.jsonl'),
      }),
    });
    mockGetCompatibilityArchives.mockImplementation(
      async (scope: ChatScopeKey) =>
        (await repository.getState(scope)).archivesFile,
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('initializes only a missing archive file and rejects corruption', async () => {
    await expect(readChatArchivesFile('project-a', 'wt-a')).resolves.toEqual({
      version: 1,
      archived: [],
    });

    mkdirSync(join(tempDir, 'workspace-a', 'chat-archives'), {
      recursive: true,
    });
    writeFileSync(archivePath, '{bad json', 'utf8');

    await expect(readChatArchivesFile('project-a', 'wt-a')).rejects.toThrow();
  });

  it('writes and reads archive files', async () => {
    const file: ArchivedChatsFile = {
      version: 1,
      archived: [makeEntry('chat-a')],
    };

    await writeChatArchivesFile('project-a', 'wt-a', file);

    expect(JSON.parse(readFileSync(archivePath, 'utf8'))).toEqual(file);
    await expect(readChatArchivesFile('project-a', 'wt-a')).resolves.toEqual(
      file,
    );
  });

  it('rejects malformed entries in an existing index', async () => {
    mkdirSync(join(tempDir, 'workspace-a', 'chat-archives'), {
      recursive: true,
    });
    writeFileSync(
      archivePath,
      JSON.stringify({
        version: 1,
        archived: [makeEntry('valid'), null, { tab: null }],
      }),
      'utf8',
    );

    await expect(
      readChatArchivesFileForIndex('project-a', 'wt-a'),
    ).rejects.toThrow();
  });

  it('rejects malformed JSON in an existing index', async () => {
    mkdirSync(join(tempDir, 'workspace-a', 'chat-archives'), {
      recursive: true,
    });
    writeFileSync(archivePath, '{bad json', 'utf8');

    await expect(
      readChatArchivesFileForIndex('project-a', 'wt-a'),
    ).rejects.toThrow();
  });

  it('returns an empty default only when the index is missing', async () => {
    await expect(
      readChatArchivesFileForIndex('project-a', 'wt-a'),
    ).resolves.toEqual({ version: 1, revision: 0, archived: [] });
  });

  it('prepends archive entries and dedupes by tab id', async () => {
    await appendChatArchive('project-a', 'wt-a', makeEntry('chat-a'));
    await appendChatArchive('project-a', 'wt-a', makeEntry('chat-b'));

    const replacement = makeEntry('chat-a', '2026-06-11T00:00:00.000Z');
    replacement.turnCount = 3;
    const updated = await appendChatArchive('project-a', 'wt-a', replacement);

    expect(updated.archived.map((entry) => entry.tab.id)).toEqual([
      'chat-a',
      'chat-b',
    ]);
    expect(updated.archived[0]).toMatchObject({
      archivedAt: '2026-06-11T00:00:00.000Z',
      turnCount: 3,
    });
  });

  it('preserves concurrent archive appends for the same worktree', async () => {
    await Promise.all([
      appendChatArchive('project-a', 'wt-a', makeEntry('chat-a')),
      appendChatArchive('project-a', 'wt-a', makeEntry('chat-b')),
      appendChatArchive('project-a', 'wt-a', makeEntry('chat-c')),
    ]);

    const file = await readChatArchivesFile('project-a', 'wt-a');
    expect(new Set(file.archived.map((entry) => entry.tab.id))).toEqual(
      new Set(['chat-a', 'chat-b', 'chat-c']),
    );
  });

  it('removes one archive entry and returns it', async () => {
    await writeChatArchivesFile('project-a', 'wt-a', {
      version: 1,
      archived: [makeEntry('chat-b'), makeEntry('chat-a')],
    });

    const removed = await removeChatArchive('project-a', 'wt-a', 'chat-a');
    const remaining = await readChatArchivesFile('project-a', 'wt-a');

    expect(removed?.tab.id).toBe('chat-a');
    expect(remaining.archived.map((entry) => entry.tab.id)).toEqual(['chat-b']);
    await expect(
      removeChatArchive('project-a', 'wt-a', 'missing'),
    ).resolves.toBeNull();
  });

  it('computes restorable summaries from the seven day window boundary', () => {
    const now = Date.parse('2026-06-08T00:00:00.000Z');
    const inside = makeEntry('inside', '2026-06-08T00:00:00.000Z');
    inside.tab = makeTab(
      'inside',
      new Date(now - RESTORE_WINDOW_MS + 60_000).toISOString(),
    );

    const outside = makeEntry('outside', '2026-06-08T00:00:00.000Z');
    outside.tab = makeTab(
      'outside',
      new Date(now - RESTORE_WINDOW_MS - 60_000).toISOString(),
    );
    delete outside.tab.providerType;
    outside.tab.model = 'claude-sonnet-4-6';

    expect(toArchivedChatSummary(inside, now)).toMatchObject({
      chatId: 'inside',
      restorable: true,
      providerType: 'codex',
    });
    expect(toArchivedChatSummary(outside, now)).toMatchObject({
      chatId: 'outside',
      restorable: false,
      providerType: 'claude',
    });
  });

  it('leaves the provider unset for an unknown persisted model', () => {
    const stale = makeEntry('stale');
    delete stale.tab.providerType;
    stale.tab.model = 'gpt-6-sol';

    expect(
      toArchivedChatSummary(stale, Date.parse('2026-06-11')),
    ).not.toHaveProperty('providerType');
  });

  it('treats recent message activity as restorable even for old chats', () => {
    // Resumability tracks when the chat last talked to its provider, not
    // when the tab was created — a months-old chat used yesterday resumes.
    const now = Date.parse('2026-06-08T00:00:00.000Z');
    const activeOldChat = makeEntry('active-old', '2026-06-08T00:00:00.000Z');
    activeOldChat.tab = makeTab('active-old', '2026-01-01T00:00:00.000Z');
    activeOldChat.tab.messages = [
      {
        id: 'm1',
        role: 'user',
        blocks: [{ type: 'text', text: 'old' }],
        timestamp: Date.parse('2026-01-01T01:00:00.000Z'),
      },
      {
        id: 'm2',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'recent' }],
        timestamp: now - 60_000,
      },
    ];

    expect(toArchivedChatSummary(activeOldChat, now)).toMatchObject({
      chatId: 'active-old',
      restorable: true,
    });
  });

  it('surfaces the unread flag on summaries (absent treated as read)', () => {
    const now = Date.parse('2026-06-10T00:00:00.000Z');
    const unread: ArchivedChatEntry = { ...makeEntry('u'), unread: true };
    const read = makeEntry('r');
    expect(toArchivedChatSummary(unread, now).unread).toBe(true);
    expect(toArchivedChatSummary(read, now).unread).toBe(false);
  });

  it('marks a single archived chat read', async () => {
    await appendChatArchive('project-a', 'wt-a', {
      ...makeEntry('keep'),
      unread: true,
    });
    await appendChatArchive('project-a', 'wt-a', {
      ...makeEntry('clear'),
      unread: true,
    });

    const updated = await markChatArchiveRead('project-a', 'wt-a', 'clear');
    const byId = new Map(updated.archived.map((e) => [e.tab.id, e]));
    expect(byId.get('clear')?.unread).toBe(false);
    expect(byId.get('keep')?.unread).toBe(true);
  });

  it('marks every archived chat read', async () => {
    await appendChatArchive('project-a', 'wt-a', {
      ...makeEntry('a'),
      unread: true,
    });
    await appendChatArchive('project-a', 'wt-a', {
      ...makeEntry('b'),
      unread: true,
    });

    const updated = await markAllChatArchivesRead('project-a', 'wt-a');
    expect(updated.archived.every((e) => e.unread !== true)).toBe(true);
  });
});

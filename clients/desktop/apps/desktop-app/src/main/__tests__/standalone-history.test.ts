import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname as pathDir } from 'node:path';

jest.mock('../lib/paths', () => ({
  getWorkspaceChatHistoryConversationFilePath: jest.fn(),
  getWorkspaceChatHistoryMetaFilePath: jest.fn(),
  getWorkspaceChatHistoryRootDir: jest.fn(),
  getWorkspaceChatHistorySummaryFilePath: jest.fn(),
  getWorkspaceDerivedDir: jest.fn(),
}));

import {
  getWorkspaceChatHistoryConversationFilePath,
  getWorkspaceChatHistoryMetaFilePath,
  getWorkspaceChatHistoryRootDir,
  getWorkspaceChatHistorySummaryFilePath,
  getWorkspaceDerivedDir,
} from '../lib/paths';
import {
  readArchiveSnapshot,
  readArchiveSummary,
  getStandaloneHistoryStorage,
} from '../lib/standalone-history';
import { rebuildHistoryIndex } from '../lib/standalone-history-index';

const mockedConversationPath = jest.mocked(
  getWorkspaceChatHistoryConversationFilePath,
);
const mockedMetaPath = jest.mocked(getWorkspaceChatHistoryMetaFilePath);
const mockedHistoryRoot = jest.mocked(getWorkspaceChatHistoryRootDir);
const mockedSummaryPath = jest.mocked(getWorkspaceChatHistorySummaryFilePath);
const mockedDerivedDir = jest.mocked(getWorkspaceDerivedDir);

describe('standalone history helpers', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'canopy-standalone-history-'));
    mockedConversationPath.mockImplementation(
      (projectId: string, chatId: string) =>
        join(rootDir, projectId, 'history', chatId, 'conversation.json'),
    );
    mockedMetaPath.mockImplementation((projectId: string, chatId: string) =>
      join(rootDir, projectId, 'history', chatId, 'meta.json'),
    );
    mockedHistoryRoot.mockImplementation((projectId: string) =>
      join(rootDir, projectId, 'history'),
    );
    mockedSummaryPath.mockImplementation((projectId: string, chatId: string) =>
      join(rootDir, projectId, 'history', chatId, 'summary.md'),
    );
    mockedDerivedDir.mockImplementation((projectId: string) =>
      join(rootDir, projectId, 'derived'),
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('reads archive snapshots written by the legacy archive flow', async () => {
    const snapshot = {
      version: 1 as const,
      projectId: 'alpha',
      chatId: 'chat-1',
      archivedAt: '2026-04-09T12:00:00.000Z',
      tab: {
        id: 'chat-1',
        title: 'Archived Chat',
        messages: [],
        createdAt: '2026-04-09T11:00:00.000Z',
      },
    };

    const conversationPath = mockedConversationPath('alpha', 'chat-1');
    await mkdir(join(rootDir, 'alpha', 'history', 'chat-1'), {
      recursive: true,
    });
    await writeFile(conversationPath, JSON.stringify(snapshot), 'utf8');

    await expect(
      readArchiveSnapshot('alpha', 'chat-1', {
        chatIds: ['chat-1'],
        pageOnly: true,
      }),
    ).resolves.toMatchObject(snapshot);
  });

  it('migrates a large legacy archive without dropping old messages or full tool output', async () => {
    const file = mockedConversationPath('alpha', 'chat-1');
    await mkdir(pathDir(file), { recursive: true });
    const messages = Array.from({ length: 503 }, (_, i) => ({
      id: `m-${i}`,
      role: 'assistant',
      timestamp: i,
      blocks: [{ type: 'text', text: `Message ${i}` }],
    }));
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        projectId: 'alpha',
        chatId: 'chat-1',
        archivedAt: '2026-09-05',
        tab: {
          id: 'chat-1',
          title: 'History',
          createdAt: '2026-09-05',
          messages,
        },
      }),
    );
    const snapshot = await readArchiveSnapshot('alpha', 'chat-1', {
      chatIds: ['chat-1'],
      pageOnly: true,
    });
    expect(snapshot?.tab.messages).toHaveLength(503);
    expect(snapshot?.tab.transcriptWindow).toMatchObject({
      view: 'turns',
      totalMessages: 503,
    });
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    const store = await getStandaloneHistoryStorage('alpha', 'chat-1');
    if (!store) throw new Error('Archive missing');
    expect(
      (
        await readFile(
          join(store.directory, 'transcripts', 'chat-1.jsonl'),
          'utf8',
        )
      )
        .trim()
        .split('\n'),
    ).toHaveLength(503);
  });

  it('leaves no scratch directory beside a migrated archive', async () => {
    const file = mockedConversationPath('alpha', 'chat-1');
    await mkdir(pathDir(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        projectId: 'alpha',
        chatId: 'chat-1',
        archivedAt: '2026-09-05',
        tab: {
          id: 'chat-1',
          title: 'History',
          createdAt: '2026-09-05',
          messages: [],
        },
      }),
    );
    await readArchiveSnapshot('alpha', 'chat-1');
    // Migration scratch belongs in a temp location; the archive directory
    // holds only the canonical v2 closure afterwards.
    expect(await readdir(pathDir(file))).not.toContain('.migration');
  });

  it('rebuilds the history index without migrating legacy archives', async () => {
    const file = mockedConversationPath('alpha', 'chat-1');
    await mkdir(pathDir(file), { recursive: true });
    const legacy = JSON.stringify({
      version: 1,
      projectId: 'alpha',
      chatId: 'chat-1',
      archivedAt: '2026-09-05T00:00:00.000Z',
      tab: {
        id: 'chat-1',
        title: 'Listed without admission',
        providerType: 'codex',
        createdAt: '2026-09-04T00:00:00.000Z',
        messages: [
          {
            id: 'm-1',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'hello' }],
          },
          {
            id: 'm-2',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'hi' }],
          },
        ],
      },
    });
    await writeFile(file, legacy);

    await expect(rebuildHistoryIndex('alpha')).resolves.toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Listed without admission',
        providerType: 'codex',
        createdAt: '2026-09-04T00:00:00.000Z',
        archivedAt: '2026-09-05T00:00:00.000Z',
        messageCount: 2,
        hasConversationSnapshot: true,
        legacySummaryOnly: false,
      }),
    ]);
    // Listing is a catalog read, not scope admission: the legacy snapshot is
    // untouched and no v2 manifest/directory was created.
    expect(await readFile(file, 'utf8')).toBe(legacy);
    expect((await readdir(pathDir(file))).sort()).toEqual([
      'conversation.json',
    ]);

    // Once the explicit open path migrates the archive, the index reads the
    // same metadata from the v2 archive index.
    await readArchiveSnapshot('alpha', 'chat-1');
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(rebuildHistoryIndex('alpha')).resolves.toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Listed without admission',
        providerType: 'codex',
        archivedAt: '2026-09-05T00:00:00.000Z',
        messageCount: 2,
        hasConversationSnapshot: true,
      }),
    ]);
  });

  it('surfaces corrupt history rather than reporting a missing archive', async () => {
    const file = mockedConversationPath('alpha', 'broken');
    await mkdir(pathDir(file), { recursive: true });
    await writeFile(file, '{broken');
    await expect(readArchiveSnapshot('alpha', 'broken')).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });

  it('keeps rebuilding the history index when one archive is corrupt', async () => {
    const chatId = 'broken';
    const file = mockedConversationPath('alpha', chatId);
    await mkdir(pathDir(file), { recursive: true });
    await writeFile(file, '{broken');
    await writeFile(
      mockedMetaPath('alpha', chatId),
      JSON.stringify({
        version: 1,
        id: chatId,
        title: 'Recoverable metadata',
        description: 'Index this archive without its corrupt snapshot',
        createdAt: '2026-04-09T11:00:00.000Z',
        archived: true,
        archivedAt: '2026-04-09T12:00:00.000Z',
        messageCount: 3,
      }),
      'utf8',
    );

    await expect(rebuildHistoryIndex('alpha')).resolves.toEqual([
      expect.objectContaining({
        chatId,
        title: 'Recoverable metadata',
        hasConversationSnapshot: false,
        legacySummaryOnly: true,
      }),
    ]);
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });

  it('falls back when summary is missing', async () => {
    await expect(readArchiveSummary('alpha', 'missing')).resolves.toBe(
      'Summary not available.',
    );
  });

  it('reads archive summary content when present', async () => {
    const summaryPath = mockedSummaryPath('alpha', 'chat-2');
    await mkdir(join(rootDir, 'alpha', 'history', 'chat-2'), {
      recursive: true,
    });
    await writeFile(summaryPath, 'Summary body', 'utf8');

    await expect(readArchiveSummary('alpha', 'chat-2')).resolves.toBe(
      'Summary body',
    );
  });
});

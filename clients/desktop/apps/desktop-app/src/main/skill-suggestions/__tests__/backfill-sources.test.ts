import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ArchivedChatEntry,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  enumerateUserChats,
  listRecentChats,
  listRetainedChatIds,
  readChatTranscript,
  runBackfill,
  type BackfillChatRef,
} from '../backfill';
import { FingerprintStore } from '../fingerprint-store';
import type { SkillSuggestionPartition } from '../partition';
import { SkillSuggestionsRegistry } from '../registry';
import { TimeSlicer } from '../time-slicer';

const mockRoot = { dir: '' };
const mockService = {
  getCompatibilityTabs: jest.fn(),
  getCompatibilityArchives: jest.fn(),
  consumeTranscriptPreview: jest.fn(),
};
const mockReadArchiveMeta = jest.fn();
const mockStandaloneStorage = jest.fn();
const mockContainerManifest = jest.fn();
const mockContainerStorage = jest.fn();
const mockBackendState = jest.fn();
const mockBackendConsume = jest.fn();

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../../agents/work-owner', () => ({
  peekSessionWorkOwner: jest.fn(),
  resolveBackgroundWorkOwner: jest.fn(),
}));
jest.mock('../../memory/local/policy', () => ({
  resolveLocalMemoryPolicy: jest.fn(),
}));
jest.mock('../../lib/paths', () => ({
  getWorkspacesRootDir: (): string => mockRoot.dir,
  getWorkspaceChatTabsFilePath: (
    projectId: string,
    worktreeId: string,
  ): string => `${mockRoot.dir}/${projectId}/chat-tabs/${worktreeId}.json`,
  getWorkspaceChatArchivesFilePath: (
    projectId: string,
    worktreeId: string,
  ): string => `${mockRoot.dir}/${projectId}/chat-archives/${worktreeId}.json`,
  getWorkspaceChatHistoryRootDir: (projectId: string): string =>
    `${mockRoot.dir}/${projectId}/chat-history`,
  getArchivedContainersRootDir: (projectId: string): string =>
    `${mockRoot.dir}/${projectId}/archived-containers`,
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): typeof mockService => mockService,
}));
jest.mock('../../lib/standalone-history', () => ({
  readArchiveMetaForIndex: (...args: unknown[]): unknown =>
    mockReadArchiveMeta(...args),
  getStandaloneHistoryStorage: (...args: unknown[]): unknown =>
    mockStandaloneStorage(...args),
}));
jest.mock('../../lib/archived-containers', () => ({
  readArchivedContainerManifest: (...args: unknown[]): unknown =>
    mockContainerManifest(...args),
  getArchivedContainerChatStorage: (...args: unknown[]): unknown =>
    mockContainerStorage(...args),
}));
jest.mock('../../services/chat-state-v2-backend', () => ({
  ChatStateV2Backend: class {
    constructor(readonly store: unknown) {}
    state(): unknown {
      return mockBackendState(this.store);
    }
    consumeTranscript(...args: unknown[]): unknown {
      return mockBackendConsume(this.store, ...args);
    }
  },
}));

const NOW = Date.UTC(2026, 9, 16, 12);
const DAY = 24 * 60 * 60 * 1000;

async function* noRows(): AsyncGenerator<PersistedChatMessage> {
  // An empty transcript.
}

function tab(id: string, lastMessageAt: number): PersistedChatTab {
  return {
    id,
    title: id,
    messages: [],
    createdAt: new Date(NOW - 90 * DAY).toISOString(),
    transcript: {
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 0,
      committedByteLength: 0,
      transcriptRevision: 1,
      hasActiveSidecar: false,
      lastMessageAt,
    },
  };
}

function archived(id: string, archivedAt: number): ArchivedChatEntry {
  return {
    tab: {
      id,
      title: id,
      messages: [],
      createdAt: new Date(NOW - 90 * DAY).toISOString(),
    },
    archivedAt: new Date(archivedAt).toISOString(),
    turnCount: 1,
  };
}

async function touch(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '{}');
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockRoot.dir = await mkdtemp(join(tmpdir(), 'skill-backfill-sources-'));
  const ws = join(mockRoot.dir, 'ws');
  await touch(join(ws, 'chat-tabs', 'wt.json'));
  await touch(join(ws, 'chat-archives', 'wt.json'));
  await mkdir(join(ws, 'chat-history', 'cowork-old'), { recursive: true });
  await mkdir(join(ws, 'chat-history', 'cowork-live'), { recursive: true });
  await mkdir(join(ws, 'archived-containers', 'box'), { recursive: true });
  await mkdir(join(ws, 'archived-containers', 'stale-box'), {
    recursive: true,
  });
  mockService.getCompatibilityTabs.mockResolvedValue({
    version: 1,
    tabs: [
      tab('live-1', NOW - DAY),
      tab('live-old', NOW - 45 * DAY),
      { ...tab('file-tab', NOW), kind: 'file' },
      // Terminal chats are never recorded live, so backfill skips them too.
      { ...tab('terminal-tab', NOW), interfaceMode: 'claude-code' },
    ],
  });
  mockService.getCompatibilityArchives.mockResolvedValue({
    version: 1,
    archived: [
      archived('wt-archived', NOW - 2 * DAY),
      archived('live-1', NOW),
      {
        ...archived('terminal-archived', NOW),
        tab: {
          ...archived('terminal-archived', NOW).tab,
          interfaceMode: 'auto',
        },
      },
    ],
  });
  mockReadArchiveMeta.mockImplementation((_projectId: string, chatId: string) =>
    Promise.resolve(
      chatId === 'cowork-old'
        ? {
            version: 1,
            id: chatId,
            description: '',
            createdAt: new Date(NOW - 40 * DAY).toISOString(),
            lastMessageAt: new Date(NOW - 3 * DAY).toISOString(),
            archived: true,
          }
        : { version: 1, id: chatId, description: '', createdAt: '' },
    ),
  );
  mockContainerManifest.mockImplementation(
    (_projectId: string, containerId: string) =>
      Promise.resolve({
        id: containerId,
        archivedAt: new Date(
          containerId === 'box' ? NOW - 4 * DAY : NOW - 70 * DAY,
        ).toISOString(),
      }),
  );
  mockContainerStorage.mockImplementation(
    (_projectId: string, containerId: string) =>
      Promise.resolve({ containerId }),
  );
  mockBackendState.mockResolvedValue({
    tabsFile: { version: 1, tabs: [tab('box-chat', NOW - 5 * DAY)] },
    archivesFile: {
      version: 1,
      archived: [archived('box-archived', NOW - 6 * DAY)],
    },
  });
});

afterEach(async () => {
  await rm(mockRoot.dir, { recursive: true, force: true });
});

describe('backfill chat sources', () => {
  it('lists live and archived chats in the window, live copies first', async () => {
    const refs = await listRecentChats(NOW);
    expect(
      refs.map((ref) => [ref.chatId, ref.source ?? 'live', ref.worktreeId]),
    ).toEqual([
      ['live-1', 'live', 'wt'],
      ['wt-archived', 'worktree-archive', 'wt'],
      ['cowork-old', 'cowork-archive', 'home'],
      ['box-chat', 'archived-container', 'box'],
      ['box-archived', 'archived-container', 'box'],
    ]);
    // A worktree archived before the window is never opened.
    expect(mockContainerStorage).toHaveBeenCalledTimes(1);
  });

  it('reads each archived transcript from its own store', async () => {
    const consume = jest.fn<
      Promise<string>,
      [AsyncIterable<PersistedChatMessage>]
    >(() => Promise.resolve('read'));
    mockStandaloneStorage.mockResolvedValue({ cowork: true });
    mockBackendConsume.mockImplementation(
      (
        _store: unknown,
        _chatId: string,
        _full: boolean,
        fn: typeof consume,
      ): Promise<string> => fn(noRows()),
    );
    mockService.consumeTranscriptPreview.mockImplementation(
      (_scope: unknown, _chatId: string, fn: typeof consume): Promise<string> =>
        fn(noRows()),
    );
    const base = { projectId: 'ws', worktreeId: 'wt' };
    await readChatTranscript({ ...base, chatId: 'live-1' }, consume);
    await readChatTranscript(
      { ...base, chatId: 'wt-archived', source: 'worktree-archive' },
      consume,
    );
    expect(mockService.consumeTranscriptPreview).toHaveBeenCalledTimes(2);
    await readChatTranscript(
      {
        projectId: 'ws',
        worktreeId: 'home',
        chatId: 'cowork-old',
        source: 'cowork-archive',
      },
      consume,
    );
    expect(mockStandaloneStorage).toHaveBeenCalledWith('ws', 'cowork-old');
    await readChatTranscript(
      {
        projectId: 'ws',
        worktreeId: 'box',
        chatId: 'box-chat',
        source: 'archived-container',
      },
      consume,
    );
    expect(mockContainerStorage).toHaveBeenCalledWith('ws', 'box');
    expect(mockBackendConsume).toHaveBeenNthCalledWith(
      1,
      { cowork: true },
      'cowork-old',
      false,
      consume,
    );
    expect(mockBackendConsume).toHaveBeenNthCalledWith(
      2,
      { containerId: 'box' },
      'box-chat',
      false,
      consume,
    );
    expect(consume).toHaveBeenCalledTimes(4);
  });

  it('keeps every existing chat for pruning, and none when a read fails', async () => {
    const retained = await listRetainedChatIds(NOW);
    expect(retained && Array.from(retained).sort()).toEqual([
      'box-archived',
      'box-chat',
      'cowork-old',
      'live-1',
      'live-old',
      'wt-archived',
    ]);
    mockService.getCompatibilityArchives.mockRejectedValue(
      new Error('unreadable'),
    );
    expect(await listRetainedChatIds(NOW)).toBeNull();
    // The backfill listing still uses what it could read.
    const partial = await enumerateUserChats({
      activeSince: NOW - 30 * DAY,
      containersArchivedSince: NOW - 30 * DAY,
    });
    expect(partial.complete).toBe(false);
    expect(partial.refs.map((ref) => ref.chatId)).toContain('live-1');
  });

  it('resumes archived chats from the cursor with their source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skill-backfill-cursor-'));
    try {
      const registry = new SkillSuggestionsRegistry(() =>
        join(dir, 'state.json'),
      );
      const store = new FingerprintStore(() => join(dir, 'fp.jsonl'));
      const chats: BackfillChatRef[] = [
        {
          projectId: 'ws',
          worktreeId: 'wt',
          chatId: 'c1',
          lastActivityAt: NOW,
        },
        {
          projectId: 'ws',
          worktreeId: 'home',
          chatId: 'c2',
          lastActivityAt: NOW,
          source: 'cowork-archive',
        },
      ];
      // An older cursor entry without a source still reads as a live chat.
      await registry.update((draft) => {
        draft.backfill = {
          done: false,
          nextChatIndex: 0,
          chatIdsSnapshot: [
            JSON.stringify(['ws', 'wt', 'c1']),
            JSON.stringify(['ws', 'home', 'c2', 'cowork-archive']),
            JSON.stringify(['ws', 'home', 'c3', 'not-a-source']),
          ],
        };
        return true;
      });
      const reads: Array<Omit<BackfillChatRef, 'lastActivityAt'>> = [];
      const result = await runBackfill({
        store,
        registry,
        slicer: new TimeSlicer({
          yieldToEventLoop: (): Promise<void> => Promise.resolve(),
        }),
        now: () => NOW,
        isAllowed: () => true,
        listChats: () => Promise.resolve(chats),
        readTranscript: <T>(
          ref: Omit<BackfillChatRef, 'lastActivityAt'>,
          consume: (
            messages: AsyncIterable<PersistedChatMessage>,
          ) => Promise<T>,
        ): Promise<T> => {
          reads.push(ref);
          return consume(noRows());
        },
        resolvePartition: (): Promise<SkillSuggestionPartition> =>
          Promise.resolve({
            key: 'personal',
            owner: { kind: 'personal' },
            privateWorkspaceId: null,
          }),
      });
      expect(result).toBe('done');
      expect(reads).toEqual([
        { projectId: 'ws', worktreeId: 'wt', chatId: 'c1' },
        {
          projectId: 'ws',
          worktreeId: 'home',
          chatId: 'c2',
          source: 'cowork-archive',
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

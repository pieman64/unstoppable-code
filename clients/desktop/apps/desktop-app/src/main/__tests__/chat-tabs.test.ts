/// <reference lib="es2021.weakref" />
import type {
  ChatScopeKey,
  ScopePaths,
} from '../services/chat-state-contracts';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatTabsFile,
  PersistedChatBlock,
} from '@canopy/desktop-shared/types';

const mockResolveChatTabsFilePath = jest.fn();
const mockGetCompatibilityTabs = jest.fn();

jest.mock('../lib/resolve-worktree', () => ({
  resolveChatTabsFilePath: mockResolveChatTabsFilePath,
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    getCompatibilityTabs: typeof mockGetCompatibilityTabs;
  } => ({
    getCompatibilityTabs: mockGetCompatibilityTabs,
  }),
}));

import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import {
  chatTabsTestExports,
  notifyChatTabsMaterialized,
  setChatTabsWriteObserver,
  writeChatTabsSnapshotForTests as writeChatTabsFile,
} from '../lib/chat-tabs';
import {
  isChatTabsFile,
  isPersistedChatMessage,
  readChatTabsFile,
  readChatTabsFileForIndex,
} from '../lib/chat-tabs-reader';

describe('writeChatTabsFile', () => {
  it('releases materialized transcripts after their consumers release them', async () => {
    // WeakRef tests run GC in a separate VM context so no production GC flags
    // or memory thresholds are needed. Waiting a turn drops WeakRef's keepalive.
    // Full CI shards can spend more than Jest's default timeout in forced GC.
    setFlagsFromString('--expose-gc');
    const collect: unknown = runInNewContext('gc');
    if (typeof collect !== 'function') {
      throw new TypeError('Expected the VM context to expose gc()');
    }
    setFlagsFromString('--no-expose-gc');
    setChatTabsWriteObserver(null);
    const reference = await (async (): Promise<WeakRef<ChatTabsFile>> => {
      const data: ChatTabsFile = { version: 1, tabs: [], activeTabId: '' };
      await notifyChatTabsMaterialized(
        'released-workspace',
        'released-worktree',
        data,
      );
      return new WeakRef(data);
    })();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      Reflect.apply(collect, undefined, []);
    }
    expect(reference.deref()).toBeUndefined();
  }, 15_000);

  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'chat-tabs-'));
    mockResolveChatTabsFilePath.mockReset();
    mockGetCompatibilityTabs.mockReset();
    const repository = new ChatStateV2Repository({
      resolvePaths: (): ScopePaths => {
        const tabs: unknown = mockResolveChatTabsFilePath();
        if (typeof tabs !== 'string')
          throw new Error('Expected a resolved tabs path');
        return {
          tabs,
          archives: join(tempDir, 'chat-archives', 'worktree-1.json'),
          journal: join(tempDir, 'chat-journals', 'worktree-1.jsonl'),
        };
      },
    });
    mockGetCompatibilityTabs.mockImplementation(
      async (scope: ChatScopeKey) =>
        (await repository.getState(scope)).tabsFile,
    );
  });

  afterEach(async () => {
    setChatTabsWriteObserver(null);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('updates live search after every successful central chat-tabs write', async () => {
    const filePath = join(tempDir, 'chats', 'worktree-1.json');
    const data: ChatTabsFile = {
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Persisted chat',
          messages: [
            {
              id: 'message-1',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'Nested payload' }],
              timestamp: 1,
            },
          ],
          createdAt: '2026-07-29T00:00:00.000Z',
        },
      ],
      activeTabId: 'chat-1',
    };
    const observer = jest.fn();
    mockResolveChatTabsFilePath.mockReturnValue(filePath);
    setChatTabsWriteObserver(observer);

    await writeChatTabsFile('workspace-1', 'worktree-1', data);

    await expect(readFile(filePath, 'utf8')).resolves.toBe(
      JSON.stringify(data, null, 2),
    );
    expect(observer).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
      data,
      undefined,
    );
  });

  it('waits for asynchronous write observers before reporting persistence complete', async () => {
    const filePath = join(tempDir, 'chats', 'worktree-1.json');
    const data: ChatTabsFile = {
      version: 1,
      tabs: [],
      activeTabId: '',
    };
    let releaseObserver: (() => void) | undefined;
    let writeSettled = false;
    let markObserverStarted: (() => void) | undefined;
    const observerStarted = new Promise<void>((resolve) => {
      markObserverStarted = resolve;
    });
    mockResolveChatTabsFilePath.mockReturnValue(filePath);
    setChatTabsWriteObserver(
      () =>
        new Promise<void>((resolve) => {
          releaseObserver = resolve;
          markObserverStarted?.();
        }),
    );

    const writing = writeChatTabsFile('workspace-1', 'worktree-1', data).then(
      () => {
        writeSettled = true;
      },
    );
    await observerStarted;

    expect(writeSettled).toBe(false);
    releaseObserver?.();
    await writing;
    expect(writeSettled).toBe(true);
  });

  it('preserves JSON encoding for a single string larger than a write chunk', async () => {
    const filePath = join(tempDir, 'chats', 'worktree-1.json');
    const largeText = `${'x'.repeat(16 * 1024 - 1)}😀${'y'.repeat(
      64 * 1024,
    )}"\\\n\u0000`;
    const data: ChatTabsFile = {
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Large persisted chat',
          messages: [
            {
              id: 'message-1',
              role: 'assistant',
              blocks: [{ type: 'text', text: largeText }],
              timestamp: 1,
            },
          ],
          createdAt: '2026-07-29T00:00:00.000Z',
        },
      ],
      activeTabId: 'chat-1',
    };
    mockResolveChatTabsFilePath.mockReturnValue(filePath);

    await writeChatTabsFile('workspace-1', 'worktree-1', data);

    await expect(readFile(filePath, 'utf8')).resolves.toBe(
      JSON.stringify(data, null, 2),
    );
  });

  it('streams asynchronously supplied JSONL values without materializing the collection', async () => {
    const { writeJsonValuesCooperatively } =
      await import('../lib/cooperative-json');
    const path = join(tempDir, 'async-rows.jsonl');
    async function* rows(): AsyncGenerator<{ id: number; text: string }> {
      for (let i = 0; i < 3; i += 1)
        yield await Promise.resolve({ id: i, text: '🌲\n\ud800' });
    }
    await writeJsonValuesCooperatively(path, rows(), {
      pretty: false,
      separator: '\n',
      trailingSeparator: true,
    });
    expect(await readFile(path, 'utf8')).toBe(
      Array.from(
        { length: 3 },
        (_, id) => JSON.stringify({ id, text: '🌲\n\ud800' }) + '\n',
      ).join(''),
    );
  });

  it('retries short writes until the complete buffer is persisted', async () => {
    const pending = Buffer.from('multibyte 😀 transcript');
    const persistedChunks: Buffer[] = [];
    const writeChunk = jest.fn<Promise<number>, [Buffer, number, number]>(
      (buffer, offset, length) => {
        const bytesWritten = Math.min(length, 3);
        persistedChunks.push(buffer.subarray(offset, offset + bytesWritten));
        return Promise.resolve(bytesWritten);
      },
    );

    await chatTabsTestExports.writeBufferFully(pending, writeChunk);

    expect(Buffer.concat(persistedChunks)).toEqual(pending);
    expect(writeChunk).toHaveBeenCalledTimes(Math.ceil(pending.byteLength / 3));
  });

  it('fails when a short write makes no progress', async () => {
    await expect(
      chatTabsTestExports.writeBufferFully(Buffer.from('transcript'), () =>
        Promise.resolve(0),
      ),
    ).rejects.toThrow('Unable to make progress writing chat tabs');
  });

  it('rejects malformed tabs in an existing index', async () => {
    const filePath = join(tempDir, 'chats', 'worktree-1.json');
    mockResolveChatTabsFilePath.mockReturnValue(filePath);
    await mkdir(join(tempDir, 'chats'), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        activeTabId: 'valid',
        tabs: [
          {
            id: 'valid',
            title: 'Valid',
            messages: [],
            createdAt: '2026-07-24T00:00:00.000Z',
          },
          null,
          {
            id: 'bad-message',
            title: 'Bad message',
            messages: [null],
            createdAt: '2026-07-24T00:00:00.000Z',
          },
        ],
      }),
    );

    await expect(
      readChatTabsFileForIndex('workspace-1', 'worktree-1'),
    ).rejects.toThrow();
  });

  it('rejects malformed JSON in an existing index', async () => {
    const filePath = join(tempDir, 'chats', 'worktree-1.json');
    mockResolveChatTabsFilePath.mockReturnValue(filePath);
    await mkdir(join(tempDir, 'chats'), { recursive: true });
    await writeFile(filePath, '{bad json');

    await expect(
      readChatTabsFileForIndex('workspace-1', 'worktree-1'),
    ).rejects.toThrow();
  });

  it('returns an empty default only when the index is missing', async () => {
    mockResolveChatTabsFilePath.mockReturnValue(
      join(tempDir, 'chats', 'missing.json'),
    );

    await expect(
      readChatTabsFileForIndex('workspace-1', 'worktree-1'),
    ).resolves.toEqual({ version: 1, revision: 0, activeTabId: '', tabs: [] });
  });

  it('rejects traversal scope ids before canonical recovery can touch disk', async () => {
    await expect(readChatTabsFile('../outside', 'worktree-1')).rejects.toThrow(
      'Invalid projectId',
    );
    expect(mockGetCompatibilityTabs).not.toHaveBeenCalled();
  });

  it('canonicalizes legacy bundleIds while reading persisted chat tabs', async () => {
    const filePath = join(tempDir, 'chats', 'worktree-1.json');
    mockResolveChatTabsFilePath.mockReturnValue(filePath);
    await mkdir(join(tempDir, 'chats'), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        activeTabId: 'legacy-selections',
        tabs: [
          {
            id: 'legacy-selections',
            title: 'Legacy selections',
            messages: [],
            createdAt: '2026-08-21T00:00:00.000Z',
            pluginSelections: {
              bundleIds: ['legacy-collection', 'shared-collection'],
              collectionIds: ['shared-collection', 'canonical-collection'],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        ],
      }),
    );

    const file = await readChatTabsFileForIndex('workspace-1', 'worktree-1');

    expect(file.tabs[0]?.pluginSelections).toEqual({
      collectionIds: [
        'shared-collection',
        'canonical-collection',
        'legacy-collection',
      ],
      skillRefs: [],
      pluginRefs: [],
    });
    expect(file.tabs[0]?.pluginSelections).not.toHaveProperty('bundleIds');
  });

  it('drops a stale captured harness from an empty preallocated session', async () => {
    const filePath = join(tempDir, 'chats', 'worktree-1.json');
    mockResolveChatTabsFilePath.mockReturnValue(filePath);
    await mkdir(join(tempDir, 'chats'), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        activeTabId: 'fresh',
        tabs: [
          {
            id: 'fresh',
            title: 'Fresh',
            messages: [],
            createdAt: '2026-08-05T00:00:00.000Z',
            providerType: 'claude',
            sdkSessionId: 'preallocated-session',
            executionHarness: 'claude',
          },
        ],
      }),
    );

    const file = await readChatTabsFileForIndex('workspace-1', 'worktree-1');
    expect(file.tabs[0]?.sdkSessionId).toBe('preallocated-session');
    expect(file.tabs[0]?.executionHarness).toBeUndefined();
  });

  it('preserves an explicit empty-chat harness from disk', async () => {
    const filePath = join(tempDir, 'chats', 'worktree-1.json');
    mockResolveChatTabsFilePath.mockReturnValue(filePath);
    await mkdir(join(tempDir, 'chats'), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        activeTabId: 'fresh',
        tabs: [
          {
            id: 'fresh',
            title: 'Fresh',
            messages: [],
            createdAt: '2026-08-05T00:00:00.000Z',
            model: 'ollama-qwen3',
            providerType: 'ollama',
            executionHarness: 'claude',
            executionHarnessExplicitlyChosen: true,
          },
        ],
      }),
    );
    const file = await readChatTabsFileForIndex('workspace-1', 'worktree-1');
    expect(file.tabs[0]?.executionHarness).toBe('claude');
  });

  it('validates every persisted chat block variant', () => {
    const blocks: PersistedChatBlock[] = [
      { type: 'text', text: 'Text' },
      {
        type: 'file_references',
        references: [{ displayPath: 'a.ts', absolutePath: '/tmp/a.ts' }],
      },
      { type: 'thinking', text: 'Thinking' },
      {
        type: 'tool_use',
        toolUseId: 'tool-1',
        toolName: 'Read',
        input: '{}',
      },
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        toolName: 'Read',
        output: 'Done',
        isError: false,
      },
      {
        type: 'image',
        path: '/tmp/generated-images/art.png',
        alt: 'Generated artwork',
      },
      {
        type: 'image',
        path: '',
        dataUrl: 'data:image/png;base64,aGVsbG8=',
        alt: 'Tool output image',
      },
      { type: 'turn_timer', completedAt: null },
      { type: 'hook_info', triggerName: 'pre-commit', timestamp: 1 },
      { type: 'automation_info', timestamp: 1 },
      {
        type: 'compaction_info',
        timestamp: 1,
        provider: 'codex',
        interfaceMode: 'canopy',
      },
      { type: 'claude_terminal_sync_warning', timestamp: 1 },
      {
        type: 'account_proxy_switch',
        timestamp: 1,
        account: 'sam@example.com',
        previousAccount: 'ops@example.com',
        previousAtLimit: true,
        sourceEventId: 'switch-1',
      },
      {
        type: 'rebase_resolution_info',
        kind: 'rebase_conflict',
        repoName: 'canopy',
        branchName: 'feature',
        timestamp: 1,
      },
      {
        type: 'builtin_gh_chat_info',
        kind: 'review_comment_triage',
        timestamp: 1,
      },
      {
        type: 'builtin_gh_chat_info',
        kind: 'merge_queue',
        timestamp: 1,
      },
      { type: 'pending_setup_info', timestamp: 1 },
      {
        type: 'approval_resolution_info',
        timestamp: 1,
        resolvedBy: 'mode-change',
        mode: 'full-access',
        previousMode: 'ask',
        titles: ['ls apps/web/src/app/'],
      },
      {
        type: 'revert_info',
        timestamp: 1,
        revertedFromMessageId: 'message-1',
        revertedFromTimestamp: 1,
        files: [
          {
            path: 'a.ts',
            status: 'modified',
            insertions: 1,
            deletions: 1,
          },
        ],
        totalInsertions: 1,
        totalDeletions: 1,
      },
      {
        type: 'codex_agent_call',
        agentBlockId: 'codex-agent-call-1',
        callId: 'call-1',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: 'thread-1',
        receiverThreadIds: ['thread-2'],
        prompt: 'Review',
        agentsStates: { 'thread-2': { status: 'completed' } },
      },
    ];

    expect(
      isChatTabsFile({
        version: 1,
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            title: 'All blocks',
            messages: [
              {
                id: 'message-1',
                role: 'assistant',
                blocks,
                timestamp: 1,
              },
            ],
            createdAt: '2026-07-24T00:00:00.000Z',
          },
        ],
      }),
    ).toBe(true);
    expect(
      isChatTabsFile({
        version: 1,
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            title: 'Malformed block',
            messages: [
              {
                id: 'message-1',
                role: 'assistant',
                blocks: [null],
                timestamp: 1,
              },
            ],
            createdAt: '2026-07-24T00:00:00.000Z',
          },
        ],
      }),
    ).toBe(false);
  });

  it.each([
    'merge_conflict',
    'review_comment_triage',
    'ci_check_fix',
    'merge_queue',
    'unknown',
  ])('validates persisted GitHub chat kind %s', (kind) => {
    expect(
      isPersistedChatMessage({
        id: 'message-1',
        role: 'system',
        timestamp: 1,
        blocks: [{ type: 'builtin_gh_chat_info', kind, timestamp: 1 }],
      }),
    ).toBe(kind !== 'unknown');
  });

  it.each(['agentPath', 'model', 'reasoningEffort'] as const)(
    'rejects a non-string persisted receiver-agent %s',
    (field) => {
      const receiver = {
        nickname: 'Scout',
        role: 'explorer',
        agentPath: '/root/review',
        model: 'gpt-6-astra',
        reasoningEffort: 'high',
        [field]: 42,
      };

      expect(
        isChatTabsFile({
          version: 1,
          activeTabId: 'chat-1',
          tabs: [
            {
              id: 'chat-1',
              title: 'Malformed receiver metadata',
              messages: [
                {
                  id: 'message-1',
                  role: 'assistant',
                  blocks: [
                    {
                      type: 'codex_agent_call',
                      agentBlockId: 'codex-agent-call-1',
                      callId: 'call-1',
                      tool: 'spawnAgent',
                      status: 'completed',
                      senderThreadId: 'thread-1',
                      receiverThreadIds: ['thread-2'],
                      prompt: 'Review',
                      agentsStates: {
                        'thread-2': { status: 'completed' },
                      },
                      receiverAgents: { 'thread-2': receiver },
                    },
                  ],
                  timestamp: 1,
                },
              ],
              createdAt: '2026-07-24T00:00:00.000Z',
            },
          ],
        }),
      ).toBe(false);
    },
  );
});

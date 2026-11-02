/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-member-access */
import type { McpActivationRecord } from '@canopy/protocol/mcp-servers';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ChatJournalRecord,
  ChatTabsFile,
  PersistedChatTab,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import * as chatStateJournal from '../../lib/chat-state-journal';
import { ChatStorageV2 } from '../../lib/chat-storage-v2';
import { ChatStateV2Repository } from '../chat-state-v2-repository';
import {
  ChatStateRepository,
  ChatStateRepositoryLoadError,
  type ChatStateCommit,
  type ChatStateRepositoryOptions,
} from '../chat-state-repository';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fsPromises>('node:fs/promises');
  return { ...actual, readFile: jest.fn(actual.readFile) };
});

jest.mock('../../lib/chat-state-journal', () => {
  const actual = jest.requireActual<typeof chatStateJournal>(
    '../../lib/chat-state-journal',
  );
  const writeSyncedJsonTemp = jest.fn(
    (...args: Parameters<typeof actual.writeSyncedJsonTemp>) =>
      actual.writeSyncedJsonTemp(...args),
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      writeSyncedJsonTemp: { value: writeSyncedJsonTemp, enumerable: true },
    },
  );
});

const actualChatStateJournal = jest.requireActual<typeof chatStateJournal>(
  '../../lib/chat-state-journal',
);

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };

function tab(id = 'chat-1'): PersistedChatTab {
  return {
    id,
    title: id,
    createdAt: '2026-08-07T12:00:00.000Z',
    messages: [],
  };
}

function journalRecord(
  revision: number,
  mutation: ChatJournalRecord['mutations'][number],
): ChatJournalRecord {
  return {
    v: 1,
    revision,
    mutationId: `mutation-${revision}`,
    occurredAt: '2026-08-07T12:00:00.000Z',
    source: 'provider',
    mutations: [mutation],
  };
}

describe('chat state repository', () => {
  let tempDir: string;
  let paths: { tabs: string; archives: string; journal: string };
  let repositories: ChatStateRepository[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'canopy-chat-repository-'));
    paths = {
      tabs: join(tempDir, 'chats', 'worktree-1.json'),
      archives: join(tempDir, 'chat-archives', 'worktree-1.json'),
      journal: join(tempDir, 'chat-journals', 'worktree-1.jsonl'),
    };
    repositories = [];
  });

  afterEach(async () => {
    await Promise.all(repositories.map((repository) => repository.drainAll()));
    jest
      .mocked(chatStateJournal.writeSyncedJsonTemp)
      .mockImplementation(actualChatStateJournal.writeSyncedJsonTemp);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function repository(
    options: Omit<ChatStateRepositoryOptions, 'resolvePaths'> = {},
  ): ChatStateRepository {
    // Capture this test's paths by value. Some repository work completes on a
    // scheduled checkpoint; closing over the mutable suite-level `paths`
    // variable lets a late callback from the preceding test write into the
    // next test's freshly assigned directory.
    const repositoryPaths = paths;
    const result = new ChatStateRepository({
      ...options,
      resolvePaths: () => repositoryPaths,
    });
    repositories.push(result);
    return result;
  }

  function writeJson(filePath: string, value: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(value, null, 2));
  }

  it('preserves the canonical MCP row when a legacy compatibility save is stale', async () => {
    const connecting: McpActivationRecord = {
      version: 1,
      ownerId: 'owner',
      activationId: 'activation',
      attemptId: 'attempt',
      originatingMessageId: 'user',
      providerSessionId: 'session',
      provider: 'claude',
      trigger: 'selection',
      requiredTargets: [
        { kind: 'standalone', serverId: 'server', configId: 'config' },
      ],
      desiredGeneration: 1,
      phase: 'connecting',
      cancelled: false,
      admission: 'not_sent',
      retryEligible: false,
    };
    const row: PersistedChatMessage = {
      id: `mcp-activation-${createHash('sha256').update('user').digest('hex').slice(0, 24)}`,
      role: 'system',
      timestamp: 1,
      blocks: [{ type: 'mcp_activation', record: connecting }],
    };
    writeJson(paths.tabs, {
      version: 1,
      tabs: [{ ...tab(), mcpActivation: connecting, messages: [row] }],
      activeTabId: 'chat-1',
    } satisfies ChatTabsFile);
    const target = repository();
    const stale = (await target.getState(SCOPE)).tabsFile;
    const completed: McpActivationRecord = {
      ...connecting,
      phase: 'completed',
      admission: 'accepted',
    };
    const completedRow: PersistedChatMessage = {
      ...row,
      blocks: [{ type: 'mcp_activation', record: completed }],
    };
    await target.transact(
      SCOPE,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: { mcpActivation: completed },
        },
        { type: 'message.upserted', chatId: 'chat-1', message: completedRow },
      ],
      { source: 'migration' },
    );
    await target.replaceCompatibilityTabs(SCOPE, stale, {
      changedTabIds: ['chat-1'],
    });
    await target.drainAll();
    const saved = (await repository().getState(SCOPE)).tabsFile.tabs[0];
    expect(saved.mcpActivation).toEqual(completed);
    expect(saved.messages).toEqual([completedRow]);
  });

  it('loads revisionless version-1 files as revision zero', async () => {
    writeJson(paths.tabs, {
      version: 1,
      tabs: [tab()],
      activeTabId: 'chat-1',
    } satisfies ChatTabsFile);
    writeJson(paths.archives, { version: 1, archived: [] });

    const state = await repository().getState(SCOPE);
    expect(state.tabsFile.revision).toBeUndefined();
    expect(state.tabsFile.tabs).toHaveLength(1);
  });

  it('canonicalizes pre-rename usage-limit banner keys on load', async () => {
    writeJson(paths.tabs, {
      version: 1,
      tabs: [
        {
          ...tab(),
          claudeUsageLimitBanner: {
            provider: 'claude',
            message: 'Usage limit reached',
            detectedAt: 1,
            dismissKey: 'usage-limit:claude:test',
          },
          dismissedClaudeUsageLimitBannerKey: 'usage-limit:claude:older',
        },
      ],
      activeTabId: 'chat-1',
    } satisfies ChatTabsFile);

    const state = await repository().getState(SCOPE);
    const loaded = state.tabsFile.tabs[0];
    expect(loaded?.llmProviderUsageLimitBanner).toEqual({
      provider: 'claude',
      message: 'Usage limit reached',
      detectedAt: 1,
      dismissKey: 'usage-limit:claude:test',
    });
    expect(loaded?.dismissedLlmProviderUsageLimitBannerKey).toBe(
      'usage-limit:claude:older',
    );
    expect(loaded?.claudeUsageLimitBanner).toBeUndefined();
    expect(loaded?.dismissedClaudeUsageLimitBannerKey).toBeUndefined();
  });

  it('repairs semantic invariant violations in legacy snapshots on load', async () => {
    const duplicateMessage = {
      id: 'duplicate-message',
      role: 'assistant' as const,
      timestamp: 1,
      blocks: [{ type: 'text' as const, text: 'first' }],
    };
    writeJson(paths.tabs, {
      version: 1,
      tabs: [
        {
          ...tab('live-chat'),
          messages: [
            duplicateMessage,
            {
              ...duplicateMessage,
              timestamp: 2,
              blocks: [{ type: 'text', text: 'latest' }],
            },
          ],
        },
      ],
      activeTabId: 'missing-chat',
      lastActiveEditableChatId: 'missing-chat',
      pendingQuestions: [
        {
          requestId: 'missing-question',
          chatId: 'missing-chat',
          questions: [{ question: 'Continue?', options: ['Yes'] }],
        },
      ],
    });
    writeJson(paths.archives, {
      version: 1,
      archived: [
        {
          tab: tab('live-chat'),
          archivedAt: '2026-08-07T13:00:00.000Z',
          turnCount: 0,
        },
      ],
    });

    const repo = repository();
    await expect(repo.getState(SCOPE)).resolves.toMatchObject({
      tabsFile: {
        activeTabId: 'live-chat',
        tabs: [
          {
            id: 'live-chat',
            messages: [
              {
                id: 'duplicate-message',
                timestamp: 2,
                blocks: [{ type: 'text', text: 'latest' }],
              },
            ],
          },
        ],
        pendingQuestions: [],
      },
      archivesFile: { archived: [] },
    });
    expect(repo.getLifecycle(SCOPE)).toBe('ready');
  });

  it('initializes only missing files as an empty scope', async () => {
    const state = await repository().getState(SCOPE);
    expect(state.tabsFile).toEqual({ version: 1, tabs: [], activeTabId: '' });
    expect(state.archivesFile).toEqual({ version: 1, archived: [] });
  });

  it('rebuilds a missing snapshot from a journal beginning at revision one', async () => {
    await chatStateJournal.appendChatJournalRecord(
      paths.journal,
      journalRecord(1, { type: 'tab.created', tab: tab() }),
    );
    await chatStateJournal.appendChatJournalRecord(
      paths.journal,
      journalRecord(2, {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'replayed' }],
        },
      }),
    );

    const onCommit = jest.fn<void, [ChatStateCommit]>();
    const recoveredRepository = new ChatStateRepository({
      resolvePaths: () => paths,
      onCommit,
    });
    repositories.push(recoveredRepository);
    const state = await recoveredRepository.getState(SCOPE);
    expect(state.tabsFile.revision).toBe(2);
    expect(state.tabsFile.tabs[0]?.messages[0]).toMatchObject({
      id: 'assistant-1',
    });
    expect(JSON.parse(readFileSync(paths.tabs, 'utf8'))).toMatchObject({
      revision: 2,
      tabs: [
        expect.objectContaining({
          messages: [expect.objectContaining({ id: 'assistant-1' })],
        }),
      ],
    });
    const recoveryCommit = onCommit.mock.calls[0]?.[0];
    expect(recoveryCommit?.revision).toBe(2);
    expect(recoveryCommit?.record.mutations).toContainEqual(
      expect.objectContaining({
        type: 'message.upserted',
        chatId: 'chat-1',
      }),
    );
  });

  it('fails closed for a journal revision gap', async () => {
    await chatStateJournal.appendChatJournalRecord(
      paths.journal,
      journalRecord(2, { type: 'tab.created', tab: tab() }),
    );
    const repo = repository();
    await expect(repo.getState(SCOPE)).rejects.toBeInstanceOf(
      ChatStateRepositoryLoadError,
    );
    expect(repo.getLifecycle(SCOPE)).toBe('recovery_error');
    expect(repo.getDiagnostics(SCOPE)).toContainEqual(
      expect.objectContaining({ kind: 'unrecoverable_journal' }),
    );
    await expect(
      repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
        source: 'renderer-command',
      }),
    ).rejects.toBeInstanceOf(ChatStateRepositoryLoadError);
  });

  it('fails closed for semantically invalid journal replay', async () => {
    await chatStateJournal.appendChatJournalRecord(
      paths.journal,
      journalRecord(1, {
        type: 'message.upserted',
        chatId: 'missing-chat',
        message: {
          id: 'orphan-message',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'orphaned' }],
        },
      }),
    );

    const repo = repository();
    await expect(repo.getState(SCOPE)).rejects.toBeInstanceOf(
      ChatStateRepositoryLoadError,
    );
    expect(repo.getLifecycle(SCOPE)).toBe('recovery_error');
    expect(repo.getDiagnostics(SCOPE)).toContainEqual(
      expect.objectContaining({ kind: 'unrecoverable_journal' }),
    );
  });

  it('fails closed for conflicting duplicate revisions', async () => {
    await chatStateJournal.appendChatJournalRecord(
      paths.journal,
      journalRecord(1, { type: 'tab.created', tab: tab('chat-a') }),
    );
    await chatStateJournal.appendChatJournalRecord(paths.journal, {
      ...journalRecord(1, { type: 'tab.created', tab: tab('chat-b') }),
      mutationId: 'conflicting-mutation',
    });

    const repo = repository();
    await expect(repo.getState(SCOPE)).rejects.toBeInstanceOf(
      ChatStateRepositoryLoadError,
    );
    expect(repo.getLifecycle(SCOPE)).toBe('recovery_error');
    expect(repo.getDiagnostics(SCOPE)).toContainEqual(
      expect.objectContaining({ kind: 'unrecoverable_journal' }),
    );
  });

  it('fails closed for corrupt snapshots without a valid backup', async () => {
    writeJson(paths.tabs, { invalid: true });
    writeJson(paths.archives, { version: 1, archived: [] });

    const repo = repository();
    await expect(repo.getState(SCOPE)).rejects.toBeInstanceOf(
      ChatStateRepositoryLoadError,
    );
    expect(repo.getLifecycle(SCOPE)).toBe('recovery_error');
    expect(repo.getDiagnostics(SCOPE)).toContainEqual(
      expect.objectContaining({ kind: 'unrecoverable_snapshot' }),
    );
    await expect(
      repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
        source: 'renderer-command',
      }),
    ).rejects.toBeInstanceOf(ChatStateRepositoryLoadError);
    expect(JSON.parse(readFileSync(paths.tabs, 'utf8'))).toEqual({
      invalid: true,
    });
  });

  it('retries a repaired snapshot read without restarting the repository', async () => {
    writeJson(paths.tabs, { invalid: true });
    writeJson(paths.archives, { version: 1, archived: [] });
    const repo = repository();

    await expect(repo.getState(SCOPE)).rejects.toBeInstanceOf(
      ChatStateRepositoryLoadError,
    );
    expect(repo.getLifecycle(SCOPE)).toBe('recovery_error');

    writeJson(paths.tabs, { version: 1, tabs: [], activeTabId: '' });
    await expect(repo.getState(SCOPE)).resolves.toMatchObject({
      tabsFile: { tabs: [], activeTabId: '' },
    });
    expect(repo.getLifecycle(SCOPE)).toBe('ready');
  });

  it('fails closed for a corrupt archive snapshot without a valid backup', async () => {
    writeJson(paths.tabs, { version: 1, tabs: [], activeTabId: '' });
    writeJson(paths.archives, { invalid: true });

    const repo = repository();
    await expect(repo.getState(SCOPE)).rejects.toBeInstanceOf(
      ChatStateRepositoryLoadError,
    );
    expect(repo.getLifecycle(SCOPE)).toBe('recovery_error');
    expect(repo.getDiagnostics(SCOPE)).toContainEqual(
      expect.objectContaining({ kind: 'unrecoverable_snapshot' }),
    );
    expect(JSON.parse(readFileSync(paths.archives, 'utf8'))).toEqual({
      invalid: true,
    });
  });

  it('replays runtime mutations in the same record as the first tab create', async () => {
    mkdirSync(dirname(paths.journal), { recursive: true });
    writeFileSync(
      paths.journal,
      `${JSON.stringify({
        ...journalRecord(1, { type: 'tab.created', tab: tab() }),
        mutations: [
          { type: 'tab.created', tab: tab() },
          {
            type: 'runtime.patched',
            chatId: 'chat-1',
            runtime: { status: 'queued', queuedMessageIds: ['queued-1'] },
          },
        ],
      })}\n`,
    );

    await expect(repository().getState(SCOPE)).resolves.toMatchObject({
      runtimeByChatId: {
        'chat-1': { status: 'queued', queuedMessageIds: ['queued-1'] },
      },
    });
  });

  it('recovers a corrupt primary component from its valid backup', async () => {
    writeJson(paths.tabs, { invalid: true });
    writeJson(`${paths.tabs}.bak`, {
      version: 1,
      revision: 4,
      tabs: [tab()],
      activeTabId: 'chat-1',
    });
    writeJson(paths.archives, { version: 1, revision: 4, archived: [] });

    const state = await repository().getState(SCOPE);
    expect(state.tabsFile.revision).toBe(4);
    expect(state.tabsFile.tabs[0]?.id).toBe('chat-1');
  });

  it('preserves and repairs a primary snapshot whose revision moved backward', async () => {
    writeJson(paths.tabs, {
      version: 1,
      revision: 1,
      tabs: [{ ...tab(), title: 'regressed' }],
      activeTabId: 'chat-1',
    });
    writeJson(`${paths.tabs}.bak`, {
      version: 1,
      revision: 2,
      tabs: [{ ...tab(), title: 'known good' }],
      activeTabId: 'chat-1',
    });
    writeJson(paths.archives, { version: 1, revision: 2, archived: [] });
    await chatStateJournal.appendChatJournalRecord(
      paths.journal,
      journalRecord(2, {
        type: 'tab.metadata_patched',
        tabId: 'chat-1',
        patch: { planMode: true },
      }),
    );

    const recovered = await repository().getState(SCOPE);
    expect(recovered.tabsFile.tabs[0]?.title).toBe('known good');
    expect(JSON.parse(readFileSync(paths.tabs, 'utf8')).revision).toBe(2);
    expect(
      readdirSync(dirname(paths.tabs)).some((name) =>
        name.startsWith('worktree-1.json.conflict-'),
      ),
    ).toBe(true);
  });

  it('serializes provider and settings changes without lost updates', async () => {
    writeJson(paths.tabs, {
      version: 1,
      tabs: [tab()],
      activeTabId: 'chat-1',
    });
    const repo = repository();
    await Promise.all([
      repo.transact(
        SCOPE,
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat-1',
            patch: { planMode: true },
          },
        ],
        { source: 'renderer-command', mutationId: 'settings' },
      ),
      repo.transact(
        SCOPE,
        [
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: {
              id: 'assistant-1',
              role: 'assistant',
              timestamp: 2,
              blocks: [{ type: 'text', text: 'provider' }],
            },
          },
        ],
        { source: 'provider', mutationId: 'provider' },
      ),
    ]);

    const state = await repo.getState(SCOPE);
    expect(state.tabsFile.tabs[0]).toMatchObject({ planMode: true });
    expect(state.tabsFile.tabs[0]?.messages).toHaveLength(1);
    expect(state.tabsFile.revision).toBe(2);
  });

  it('journals a small sibling settings change without the large sibling transcript', async () => {
    const largeText = 'large sibling transcript '.repeat(100_000);
    const largeTab: PersistedChatTab = {
      ...tab('large-chat'),
      messages: [
        {
          id: 'large-message',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: largeText }],
        },
      ],
    };
    const smallTab = tab('small-chat');
    const repo = repository();
    await repo.transact(
      SCOPE,
      [
        { type: 'tab.created', tab: largeTab },
        { type: 'tab.created', tab: smallTab },
      ],
      {
        source: 'renderer-command',
        mutationId: 'create-sibling-tabs',
        checkpoint: true,
      },
    );
    await repo.flushScope(SCOPE);

    await repo.replaceCompatibilityTabs(
      SCOPE,
      {
        version: 1,
        revision: await repo.getRevision(SCOPE),
        tabs: [largeTab, { ...smallTab, planMode: true }],
        activeTabId: smallTab.id,
      },
      {
        changedTabIds: [smallTab.id],
        source: 'renderer-command',
        mutationId: 'settings-without-transcript',
      },
    );

    const journalLines = readFileSync(paths.journal, 'utf8')
      .trimEnd()
      .split('\n');
    const lastRecordValue: unknown = JSON.parse(
      journalLines[journalLines.length - 1] ?? 'null',
    );
    expect(chatStateJournal.isChatJournalRecord(lastRecordValue)).toBe(true);
    if (!chatStateJournal.isChatJournalRecord(lastRecordValue)) {
      throw new Error('Expected a valid chat journal record');
    }
    const lastRecord = lastRecordValue;
    expect(lastRecord.mutations).toEqual([
      {
        type: 'tab.metadata_patched',
        tabId: smallTab.id,
        patch: { planMode: true },
      },
    ]);
    expect(JSON.stringify(lastRecord)).not.toContain(largeText);
    expect(Buffer.byteLength(JSON.stringify(lastRecord))).toBeLessThan(10_000);
  });

  it('journals a description change without the existing transcript', async () => {
    const largeText = 'existing transcript '.repeat(100_000);
    const existingTab: PersistedChatTab = {
      ...tab('described-chat'),
      messages: [
        {
          id: 'existing-message',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: largeText }],
        },
      ],
    };
    const repo = repository();
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: existingTab }], {
      source: 'renderer-command',
      mutationId: 'create-described-chat',
      checkpoint: true,
    });
    await repo.flushScope(SCOPE);

    await repo.replaceCompatibilityTabs(
      SCOPE,
      {
        version: 1,
        revision: await repo.getRevision(SCOPE),
        tabs: [{ ...existingTab, description: 'Generated description' }],
        activeTabId: existingTab.id,
      },
      {
        changedTabIds: [existingTab.id],
        source: 'renderer-command',
        mutationId: 'description-without-transcript',
      },
    );

    const recovered = await repository().getState(SCOPE);
    expect(
      recovered.tabsFile.tabs.find((tab) => tab.id === existingTab.id)
        ?.description,
    ).toBe('Generated description');

    const journalLines = readFileSync(paths.journal, 'utf8')
      .trimEnd()
      .split('\n');
    const lastRecordValue: unknown = JSON.parse(
      journalLines[journalLines.length - 1] ?? 'null',
    );
    expect(chatStateJournal.isChatJournalRecord(lastRecordValue)).toBe(true);
    if (!chatStateJournal.isChatJournalRecord(lastRecordValue)) {
      throw new Error('Expected a valid chat journal record');
    }
    expect(lastRecordValue.mutations).toEqual([
      {
        type: 'tab.metadata_patched',
        tabId: existingTab.id,
        patch: { description: 'Generated description' },
      },
    ]);
    expect(JSON.stringify(lastRecordValue)).not.toContain(largeText);
  });

  it('falls back to a legal replacement for file-tab metadata changes', async () => {
    const fileTab: PersistedChatTab = {
      ...tab('file-tab'),
      kind: 'file',
      filePath: '/tmp/notes.md',
    };
    const repo = repository();
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: fileTab }], {
      source: 'renderer-command',
      mutationId: 'create-file-tab',
      checkpoint: true,
    });
    await repo.flushScope(SCOPE);

    await expect(
      repo.replaceCompatibilityTabs(
        SCOPE,
        {
          version: 1,
          revision: await repo.getRevision(SCOPE),
          tabs: [{ ...fileTab, description: 'File description' }],
          activeTabId: fileTab.id,
        },
        {
          changedTabIds: [fileTab.id],
          source: 'renderer-command',
          mutationId: 'describe-file-tab',
        },
      ),
    ).resolves.toMatchObject({
      tabsFile: {
        tabs: [expect.objectContaining({ description: 'File description' })],
      },
    });

    expect((await repo.getState(SCOPE)).tabsFile.tabs[0]?.description).toBe(
      'File description',
    );
  });

  it('does not preserve modelConfig keys removed by compatibility state', async () => {
    const existingTab: PersistedChatTab = {
      ...tab('model-config-chat'),
      modelConfig: { thinkingLevel: 'high', fastMode: true },
    };
    const repo = repository();
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: existingTab }], {
      source: 'renderer-command',
      mutationId: 'create-model-config-chat',
      checkpoint: true,
    });
    await repo.flushScope(SCOPE);

    await repo.replaceCompatibilityTabs(
      SCOPE,
      {
        version: 1,
        revision: await repo.getRevision(SCOPE),
        tabs: [{ ...existingTab, modelConfig: { thinkingLevel: 'high' } }],
        activeTabId: existingTab.id,
      },
      {
        changedTabIds: [existingTab.id],
        source: 'renderer-command',
        mutationId: 'remove-fast-mode',
      },
    );

    expect((await repo.getState(SCOPE)).tabsFile.tabs[0]?.modelConfig).toEqual({
      thinkingLevel: 'high',
    });
  });

  describe('Codex speed snapshots', () => {
    async function hydrateModelConfig(
      current: NonNullable<PersistedChatTab['modelConfig']>,
      snapshot: NonNullable<PersistedChatTab['modelConfig']>,
    ): Promise<{
      modelConfig: PersistedChatTab['modelConfig'];
      mutationTypes: string[];
    }> {
      const existingTab: PersistedChatTab = {
        ...tab('speed-chat'),
        modelConfig: current,
      };
      const repo = repository();
      await repo.transact(SCOPE, [{ type: 'tab.created', tab: existingTab }], {
        source: 'renderer-command',
        mutationId: 'create-speed-chat',
        checkpoint: true,
      });
      await repo.flushScope(SCOPE);
      await repo.replaceCompatibilityTabs(
        SCOPE,
        {
          version: 1,
          revision: await repo.getRevision(SCOPE),
          tabs: [{ ...existingTab, modelConfig: snapshot }],
          activeTabId: existingTab.id,
        },
        {
          changedTabIds: [existingTab.id],
          source: 'renderer-command',
          mutationId: 'hydrate-speed-snapshot',
        },
      );
      const journalLines = readFileSync(paths.journal, 'utf8')
        .trimEnd()
        .split('\n');
      const lastRecord: unknown = JSON.parse(
        journalLines[journalLines.length - 1] ?? 'null',
      );
      if (!chatStateJournal.isChatJournalRecord(lastRecord)) {
        throw new Error('Expected a valid chat journal record');
      }
      return {
        modelConfig: (await repository().getState(SCOPE)).tabsFile.tabs[0]
          ?.modelConfig,
        mutationTypes: lastRecord.mutations.map((mutation) => mutation.type),
      };
    }

    it('round-trips an exact Ultra fast snapshot over a Fast record', async () => {
      // Hydration reads the authoritative record speed-first. Its projected
      // `fastMode: false` is not a legacy Regular command.
      await expect(
        hydrateModelConfig(
          { thinkingLevel: 'high', speed: 'fast', fastMode: true },
          { thinkingLevel: 'high', speed: 'ultrafast', fastMode: false },
        ),
      ).resolves.toEqual({
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'ultrafast',
          fastMode: false,
        },
        mutationTypes: ['tab.metadata_patched'],
      });
    });

    it('keeps Ultra fast when a snapshot changes only the thinking level', async () => {
      await expect(
        hydrateModelConfig(
          { thinkingLevel: 'high', speed: 'ultrafast', fastMode: false },
          { thinkingLevel: 'low', speed: 'ultrafast', fastMode: false },
        ),
      ).resolves.toEqual({
        modelConfig: {
          thinkingLevel: 'low',
          speed: 'ultrafast',
          fastMode: false,
        },
        mutationTypes: ['tab.metadata_patched'],
      });
    });

    it('never persists a Fast projection beside an Ultra fast snapshot speed', async () => {
      await expect(
        hydrateModelConfig(
          { thinkingLevel: 'high', speed: 'fast', fastMode: true },
          { thinkingLevel: 'high', speed: 'ultrafast', fastMode: true },
        ),
      ).resolves.toEqual({
        modelConfig: {
          thinkingLevel: 'high',
          speed: 'ultrafast',
          fastMode: false,
        },
        mutationTypes: ['tab.metadata_patched'],
      });
    });

    it.each([
      ['a legacy boolean', { thinkingLevel: 'high', fastMode: false }],
      ['no speed', { thinkingLevel: 'high' }],
    ] as const)(
      'replaces the whole tab when a snapshot with %s drops the recorded speed',
      async (_label, snapshot) => {
        // The reducer merges partial settings patches, so a snapshot that
        // removes `speed` must not be merged over the Ultra fast record.
        await expect(
          hydrateModelConfig(
            { thinkingLevel: 'high', speed: 'ultrafast', fastMode: false },
            snapshot,
          ),
        ).resolves.toEqual({
          modelConfig: snapshot,
          mutationTypes: ['tab.created'],
        });
      },
    );
  });

  it('reports journal growth, record size, transcript-bearing mutations, and checkpoint duration', async () => {
    const diagnostics: Array<{
      kind: string;
      storageAuthority: string;
      journalBytes: number;
      recordBytes?: number;
      maxRecordBytes?: number;
      checkpointDurationMs?: number;
    }> = [];
    const repo = repository({
      onStorageDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await repo.getState(SCOPE);
    await repo.transact(
      SCOPE,
      [
        {
          type: 'tab.created',
          tab: {
            ...tab(),
            messages: [
              {
                id: 'legacy-transcript-message',
                role: 'assistant',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'legacy transcript' }],
              },
            ],
          },
        },
      ],
      { source: 'renderer-command', mutationId: 'transcript-bearing-create' },
    );
    await repo.flushScope(SCOPE);

    expect(
      diagnostics.find((diagnostic) => diagnostic.kind === 'journal_loaded'),
    ).toMatchObject({
      storageAuthority: 'v1',
      journalBytes: 0,
      maxRecordBytes: 0,
    });
    expect(
      typeof diagnostics.find(
        (diagnostic) => diagnostic.kind === 'journal_growth',
      )?.recordBytes,
    ).toBe('number');
    expect(
      typeof diagnostics.find(
        (diagnostic) => diagnostic.kind === 'transcript_bearing_mutation',
      )?.recordBytes,
    ).toBe('number');
    expect(
      typeof diagnostics.find(
        (diagnostic) => diagnostic.kind === 'checkpoint_completed',
      )?.checkpointDurationMs,
    ).toBe('number');
    expect(
      diagnostics.every((diagnostic) => diagnostic.storageAuthority === 'v1'),
    ).toBe(true);
  });

  it('keeps the initial rollout fully readable by the legacy v1 disk contract', async () => {
    const repo = repository();
    await repo.transact(
      SCOPE,
      [
        {
          type: 'tab.created',
          tab: {
            ...tab(),
            messages: [
              {
                id: 'rollback-message',
                role: 'user',
                timestamp: 1,
                blocks: [{ type: 'text', text: 'survives rollback' }],
              },
            ],
          },
        },
      ],
      { source: 'renderer-command', mutationId: 'rollback-compatible-create' },
    );
    await repo.flushScope(SCOPE);

    const writtenTabs: unknown = JSON.parse(readFileSync(paths.tabs, 'utf8'));
    const writtenArchives: unknown = JSON.parse(
      readFileSync(paths.archives, 'utf8'),
    );
    const writtenRecords: unknown[] = readFileSync(paths.journal, 'utf8')
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((line): unknown => {
        const record: unknown = JSON.parse(line);
        return record;
      });

    expect(writtenTabs).toMatchObject({
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          messages: [
            {
              id: 'rollback-message',
              blocks: [{ type: 'text', text: 'survives rollback' }],
            },
          ],
        },
      ],
    });
    expect(writtenArchives).toMatchObject({ version: 1 });
    expect(writtenRecords.every(chatStateJournal.isChatJournalRecord)).toBe(
      true,
    );
    expect(existsSync(join(tempDir, 'chat-transcripts'))).toBe(false);
    expect(existsSync(join(tempDir, 'chat-storage-manifests'))).toBe(false);
  });

  it('enforces expected revisions inside the serialized mutation queue', async () => {
    const repo = repository();
    const results = await Promise.allSettled([
      repo.transact(SCOPE, [{ type: 'tab.created', tab: tab('chat-a') }], {
        source: 'renderer-command',
        mutationId: 'expected-a',
        expectedRevision: 0,
      }),
      repo.transact(SCOPE, [{ type: 'tab.created', tab: tab('chat-b') }], {
        source: 'renderer-command',
        mutationId: 'expected-b',
        expectedRevision: 0,
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect((await repo.getState(SCOPE)).tabsFile.tabs).toHaveLength(1);
  });

  it('recognizes a concurrent duplicate before applying its stale revision guard', async () => {
    const repo = repository();
    const mutation = { type: 'tab.created', tab: tab('chat-a') } as const;

    const [first, retry] = await Promise.all([
      repo.transact(SCOPE, [mutation], {
        source: 'renderer-command',
        mutationId: 'same-command',
        expectedRevision: 0,
      }),
      repo.transact(SCOPE, [mutation], {
        source: 'renderer-command',
        mutationId: 'same-command',
        expectedRevision: 0,
      }),
    ]);

    expect([first.applied, retry.applied].sort()).toEqual([false, true]);
    expect(first.revision).toBe(1);
    expect(retry.revision).toBe(1);
    expect((await repo.getState(SCOPE)).tabsFile.tabs).toHaveLength(1);
  });

  it('reports whether a durable mutation has already been applied', async () => {
    const repo = repository();
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'provider',
      mutationId: 'accepted-prompt',
    });

    await expect(repo.hasMutation(SCOPE, 'accepted-prompt')).resolves.toBe(
      true,
    );
    await expect(repo.hasMutation(SCOPE, 'missing-prompt')).resolves.toBe(
      false,
    );
  });

  it('validates expected revision before invoking an async transaction effect', async () => {
    const repo = repository();
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'provider',
      mutationId: 'create-before-effect',
    });
    const effect = jest.fn(() => Promise.resolve([]));

    await expect(
      repo.transactWith(SCOPE, effect, {
        source: 'renderer-command',
        mutationId: 'stale-effect',
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ actualRevision: 1 });
    expect(effect).not.toHaveBeenCalled();
  });

  it('checkpoints both components and retains command receipts across restart', async () => {
    const first = repository();
    await first.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'renderer-command',
      mutationId: 'create-tab',
      commandResult: {
        commandId: 'command-1',
        outcome: 'applied',
        entityId: 'chat-1',
      },
      checkpoint: true,
    });
    await first.flushScope(SCOPE);
    expect(JSON.parse(readFileSync(paths.tabs, 'utf8')).revision).toBe(1);
    expect(JSON.parse(readFileSync(paths.archives, 'utf8')).revision).toBe(1);

    const second = repository();
    await expect(second.getReceipt(SCOPE, 'command-1')).resolves.toMatchObject({
      revision: 1,
      outcome: 'applied',
    });
  });

  it('does not publish or rewrite a clean checkpoint on restart', async () => {
    const first = repository();
    await first.transact(
      SCOPE,
      [
        { type: 'tab.created', tab: tab() },
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'completed',
            queuedMessageIds: [],
            lastActivityAt: 1,
          },
        },
      ],
      {
        source: 'provider',
        mutationId: 'checkpoint-with-runtime',
        checkpoint: true,
      },
    );
    await first.flushScope(SCOPE);
    jest.mocked(chatStateJournal.writeSyncedJsonTemp).mockClear();
    const onCommit = jest.fn<void, [ChatStateCommit]>();
    const second = new ChatStateRepository({
      resolvePaths: () => paths,
      onCommit,
    });
    repositories.push(second);

    await second.getState(SCOPE);

    expect(onCommit).not.toHaveBeenCalled();
    expect(chatStateJournal.writeSyncedJsonTemp).not.toHaveBeenCalled();
  });

  it('commits transactions accepted before drain begins', async () => {
    const repo = repository();
    await repo.getState(SCOPE);
    let releaseFirst = (): void => undefined;
    let firstBuildStarted = (): void => undefined;
    const firstBuildEntered = new Promise<void>((resolve) => {
      firstBuildStarted = resolve;
    });
    const first = repo.transactWith(
      SCOPE,
      async () => {
        firstBuildStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return [{ type: 'tab.created', tab: tab() }];
      },
      { source: 'provider', mutationId: 'before-drain-1' },
    );
    await firstBuildEntered;
    const second = repo.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ],
      { source: 'provider', mutationId: 'before-drain-2' },
    );
    await Promise.resolve();

    const draining = repo.drainAll();
    releaseFirst();

    await expect(first).resolves.toMatchObject({ revision: 1 });
    await expect(second).resolves.toMatchObject({ revision: 2 });
    await draining;
    expect(JSON.parse(readFileSync(paths.tabs, 'utf8')).revision).toBe(2);
  });

  it('rejects new scopes once repository draining begins', async () => {
    const repo = repository();
    await repo.drainAll();

    await expect(repo.getState(SCOPE)).rejects.toThrow(
      'Chat state repository is draining',
    );
  });

  it('checkpoints from loaded revision metadata without reparsing materialized snapshots', async () => {
    writeJson(paths.tabs, {
      version: 1,
      revision: 4,
      tabs: [tab()],
      activeTabId: 'chat-1',
    } satisfies ChatTabsFile);
    writeJson(paths.archives, { version: 1, revision: 4, archived: [] });
    const repo = repository();
    await repo.getState(SCOPE);
    const readFileMock = jest.mocked(fsPromises.readFile);
    readFileMock.mockClear();

    await repo.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ],
      { source: 'provider', mutationId: 'runtime-after-load' },
    );
    await repo.flushScope(SCOPE);

    expect(readFileMock).not.toHaveBeenCalledWith(paths.tabs, 'utf8');
    expect(readFileMock).not.toHaveBeenCalledWith(paths.archives, 'utf8');
  });

  it('keeps terminal checkpoints behind the idle window so follow-up commands stay unblocked', async () => {
    const repo = repository();
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'renderer-command',
      mutationId: 'create-before-terminal',
    });
    await repo.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      ],
      { source: 'provider', mutationId: 'terminal-before-follow-up' },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(existsSync(paths.tabs)).toBe(false);

    await repo.flushScope(SCOPE);
    expect(existsSync(paths.tabs)).toBe(true);
  });

  it('preempts a scheduled checkpoint when a follow-up mutation is accepted', async () => {
    let releaseWriter = false;
    let markWriterStarted: (() => void) | undefined;
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    const checkpointWriter = jest.fn(
      async (
        targetPath: string,
        value: unknown,
        options?: { shouldAbort?: () => boolean },
      ) => {
        markWriterStarted?.();
        while (!releaseWriter) {
          if (options?.shouldAbort?.()) {
            const error = new Error('scheduled checkpoint was preempted');
            error.name = 'CooperativeJsonWriteAbortedError';
            throw error;
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return actualChatStateJournal.writeSyncedJsonTemp(targetPath, value);
      },
    );

    const repo = repository({ writeSyncedJsonTemp: checkpointWriter });
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'renderer-command',
      mutationId: 'create-before-preemptible-checkpoint',
    });
    await repo.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      ],
      { source: 'provider', mutationId: 'terminal-before-preemption' },
    );
    await writerStarted;

    const followUp = repo.transact(
      SCOPE,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: { planMode: true },
        },
      ],
      { source: 'renderer-command', mutationId: 'follow-up-after-terminal' },
    );
    // Preemption must let the follow-up commit while the checkpoint writer is
    // still blocked. A watchdog (rather than a short wall-clock race, which
    // flakes under full-suite load) releases the writer only if preemption
    // never happened, so a regression fails on the flag instead of hanging.
    let hadToReleaseWriter = false;
    const watchdog = setTimeout(() => {
      hadToReleaseWriter = true;
      releaseWriter = true;
    }, 10_000);
    await followUp;
    clearTimeout(watchdog);
    releaseWriter = true;

    expect(hadToReleaseWriter).toBe(false);
  });

  it('forces a checkpoint after repeated cooperative preemption', async () => {
    const diagnostics: Array<{ kind: string }> = [];
    let writerCall = 0;
    let markWriterStarted: (() => void) | undefined;
    const writerStarted = new Promise<void>((resolve) => {
      markWriterStarted = resolve;
    });
    const checkpointWriter: NonNullable<
      ChatStateRepositoryOptions['writeSyncedJsonTemp']
    > = async (targetPath, value, options) => {
      writerCall += 1;
      if (writerCall <= 2) {
        markWriterStarted?.();
        while (!options?.shouldAbort?.()) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const error = new Error('scheduled checkpoint was preempted');
        error.name = 'CooperativeJsonWriteAbortedError';
        throw error;
      }
      expect(options?.shouldAbort).toBeUndefined();
      return actualChatStateJournal.writeSyncedJsonTemp(targetPath, value);
    };
    const repo = repository({
      writeSyncedJsonTemp: checkpointWriter,
      checkpointBoundaryDelayMs: 1,
      checkpointIdleMs: 1,
      maxCheckpointAborts: 1,
      onStorageDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'renderer-command',
      mutationId: 'create-before-forced-checkpoint',
      checkpoint: true,
    });
    await writerStarted;

    await repo.transact(
      SCOPE,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: { planMode: true },
        },
      ],
      { source: 'renderer-command', mutationId: 'preempt-first-checkpoint' },
    );

    const deadline = Date.now() + 5_000;
    while (
      !diagnostics.some(
        (diagnostic) => diagnostic.kind === 'checkpoint_completed',
      ) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'checkpoint_aborted' }),
        expect.objectContaining({ kind: 'checkpoint_forced' }),
        expect.objectContaining({ kind: 'checkpoint_completed' }),
      ]),
    );
    expect(existsSync(paths.tabs)).toBe(true);
  });

  it('retains removal tombstones across checkpoint and restart', async () => {
    const first = repository();
    await first.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'renderer-command',
      mutationId: 'create-before-remove',
    });
    await first.transact(SCOPE, [{ type: 'tab.removed', tabId: 'chat-1' }], {
      source: 'renderer-command',
      mutationId: 'remove-tab',
      checkpoint: true,
    });
    await first.flushScope(SCOPE);

    const second = repository();
    await expect(second.hasRemovedTab(SCOPE, 'chat-1')).resolves.toBe(true);
  });

  it('retains chat-scoped removal fences without changing legacy lookups', async () => {
    const first = repository();
    await first.transact(
      SCOPE,
      [
        { type: 'tab.created', tab: tab('chat-1') },
        { type: 'tab.created', tab: tab('chat-2') },
        {
          type: 'message.removed',
          chatId: 'chat-1',
          messageId: 'shared-message',
        },
      ],
      { source: 'migration', checkpoint: true },
    );
    await first.flushScope(SCOPE);
    const second = repository();
    await second.transactWith(
      SCOPE,
      (_state, _revision, context) => {
        expect(context.hasRemovedMessage('shared-message')).toBe(true);
        expect(context.hasRemovedMessage('shared-message', 'chat-1')).toBe(
          true,
        );
        expect(context.hasRemovedMessage('shared-message', 'chat-2')).toBe(
          false,
        );
        return [];
      },
      { source: 'migration' },
    );
  });

  it('does not replay or indefinitely retain runtime state for a removed chat', async () => {
    const first = repository();
    await first.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'renderer-command',
      mutationId: 'create-before-runtime-remove',
    });
    await first.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
      ],
      { source: 'provider', mutationId: 'runtime-before-remove' },
    );
    await first.transact(SCOPE, [{ type: 'tab.removed', tabId: 'chat-1' }], {
      source: 'renderer-command',
      mutationId: 'remove-after-runtime',
      checkpoint: true,
    });
    await first.flushScope(SCOPE);

    const second = repository();
    await expect(second.getState(SCOPE)).resolves.toMatchObject({
      tabsFile: { tabs: [] },
      runtimeByChatId: {},
    });

    // Advance the backup-recovery floor so compaction no longer needs the
    // original create/remove sequence. The removed chat's runtime record must
    // then disappear instead of surviving as the per-chat "latest" forever.
    await second.transact(
      SCOPE,
      [{ type: 'tab.created', tab: tab('chat-2') }],
      {
        source: 'renderer-command',
        mutationId: 'advance-after-removed-runtime',
        checkpoint: true,
      },
    );
    await second.flushScope(SCOPE);
    expect(readFileSync(paths.journal, 'utf8')).not.toContain(
      'runtime-before-remove',
    );
  });

  it('preserves canonical provider messages during stale compatibility merges', async () => {
    const repo = repository();
    await repo.transact(
      SCOPE,
      [
        {
          type: 'tab.created',
          tab: { ...tab(), providerType: 'codex', model: 'gpt-6-sol' },
        },
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'assistant-newer',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'newer output' }],
          },
        },
      ],
      { source: 'provider', mutationId: 'provider-output' },
    );
    const merged = await repo.replaceCompatibilityTabs(SCOPE, {
      version: 1,
      revision: 0,
      tabs: [
        {
          ...tab(),
          providerType: 'claude',
          model: 'claude-sonnet-4-6',
          messages: [
            {
              id: 'assistant-newer',
              role: 'assistant',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'stale partial output' }],
            },
          ],
        },
      ],
      activeTabId: 'chat-1',
    });
    expect(merged.tabsFile.tabs[0]?.messages).toEqual([
      expect.objectContaining({
        id: 'assistant-newer',
        blocks: [{ type: 'text', text: 'newer output' }],
      }),
    ]);
    expect(merged.tabsFile.tabs[0]).toMatchObject({
      providerType: 'codex',
      model: 'gpt-6-sol',
    });
  });

  it('does not resurrect tombstoned messages from a stale compatibility snapshot', async () => {
    const removedMessage = {
      id: 'removed-message',
      role: 'user' as const,
      timestamp: 1,
      blocks: [{ type: 'text' as const, text: 'remove me' }],
    };
    const repo = repository();
    await repo.transact(
      SCOPE,
      [
        {
          type: 'tab.created',
          tab: { ...tab(), messages: [removedMessage] },
        },
      ],
      { source: 'provider', mutationId: 'message-before-stale-snapshot' },
    );
    const stale = (await repo.getState(SCOPE)).tabsFile;
    await repo.transact(
      SCOPE,
      [
        {
          type: 'messages.replaced',
          chatId: 'chat-1',
          messages: [],
          removedMessageIds: [removedMessage.id],
        },
      ],
      { source: 'renderer-command', mutationId: 'remove-before-stale-merge' },
    );

    const merged = await repo.replaceCompatibilityTabs(SCOPE, stale);

    expect(merged.tabsFile.tabs[0]?.messages).toEqual([]);
  });

  it('persists an answered question exactly once across V2 reopen without changing committed JSONL bytes', async () => {
    const pendingQuestion = {
      requestId: 'durable-question',
      toolUseId: 'question-tool',
      chatId: 'chat-1',
      questions: [{ id: 'choice', question: 'Pick', options: ['A', 'B'] }],
    };
    const answeredQuestion = {
      ...pendingQuestion,
      answers: [
        { questionId: 'choice', question: 'Pick', selectedOptions: ['B'] },
      ],
      answeredAt: 123,
    };
    const repositoryPaths = paths;
    const repo = new ChatStateV2Repository({
      resolvePaths: () => repositoryPaths,
    });
    let reopened: ChatStateV2Repository | undefined;
    try {
      await repo.transact(
        SCOPE,
        [
          { type: 'tab.created', tab: tab() },
          {
            type: 'message.upserted',
            chatId: 'chat-1',
            message: {
              id: 'committed-question',
              role: 'assistant',
              timestamp: 1,
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: 'question-tool',
                  toolName: 'AskUserQuestion',
                  input: JSON.stringify({
                    questions: pendingQuestion.questions,
                  }),
                },
              ],
            },
          },
          { type: 'pending_question.upserted', question: pendingQuestion },
        ],
        {
          source: 'provider',
          mutationId: 'commit-question-row',
          fullTranscript: true,
        },
      );
      const storage = ChatStorageV2.fromLegacyPaths(paths);
      expect(await storage.format()).toBe('v3');
      const transcriptPath = join(
        storage.directory,
        'transcripts',
        'chat-1.jsonl',
      );
      const before = readFileSync(transcriptPath);
      const size = statSync(transcriptPath).size;
      const hash = createHash('sha256').update(before).digest('hex');
      expect(size).toBeGreaterThan(0);
      expect(before.toString('utf8')).toContain('AskUserQuestion');
      const commit = await repo.transact(
        SCOPE,
        [
          {
            type: 'pending_question.upserted',
            question: answeredQuestion,
          },
        ],
        { source: 'renderer-command', mutationId: 'answer-durable-question' },
      );
      expect(commit.record.mutations.map(({ type }) => type)).toEqual([
        'pending_question.upserted',
      ]);
      expect((await repo.getState(SCOPE)).tabsFile.pendingQuestions).toEqual([
        answeredQuestion,
      ]);
      expect(statSync(transcriptPath).size).toBe(size);
      expect(
        createHash('sha256').update(readFileSync(transcriptPath)).digest('hex'),
      ).toBe(hash);
      expect(readFileSync(transcriptPath)).toEqual(before);

      await repo.drainAll();
      reopened = new ChatStateV2Repository({
        resolvePaths: () => repositoryPaths,
      });
      const recovered = await reopened.getState(SCOPE, {
        chatIds: ['chat-1'],
        fullTranscript: true,
      });
      expect(recovered.tabsFile.pendingQuestions).toEqual([answeredQuestion]);
      expect(recovered.tabsFile.tabs[0].messages).toHaveLength(1);
      expect(recovered.tabsFile.tabs[0].messages[0].id).toBe(
        'committed-question',
      );
      expect(statSync(transcriptPath).size).toBe(size);
      expect(
        createHash('sha256').update(readFileSync(transcriptPath)).digest('hex'),
      ).toBe(hash);
      expect(readFileSync(transcriptPath)).toEqual(before);
    } finally {
      await repo.drainAll();
      await reopened?.drainAll();
    }
  });

  it('preserves answered questions during stale compatibility merges', async () => {
    const pendingQuestion = {
      requestId: 'question-1',
      chatId: 'chat-1',
      questions: [{ question: 'Pick', options: ['A'] }],
    };
    const repo = repository();
    await repo.transact(
      SCOPE,
      [
        { type: 'tab.created', tab: tab() },
        { type: 'pending_question.upserted', question: pendingQuestion },
      ],
      { source: 'provider', mutationId: 'question-before-stale-snapshot' },
    );
    const stale = (await repo.getState(SCOPE)).tabsFile;
    await repo.transact(
      SCOPE,
      [
        {
          type: 'pending_question.upserted',
          question: {
            ...pendingQuestion,
            answers: [{ question: 'Pick', selectedOptions: ['A'] }],
            answeredAt: 123,
          },
        },
      ],
      { source: 'renderer-command', mutationId: 'answer-before-stale-merge' },
    );

    const merged = await repo.replaceCompatibilityTabs(SCOPE, stale);

    expect(merged.tabsFile.pendingQuestions).toEqual([
      expect.objectContaining({
        requestId: 'question-1',
        answers: [{ question: 'Pick', selectedOptions: ['A'] }],
        answeredAt: 123,
      }),
    ]);
  });

  it('removes tabs omitted from a fresh full compatibility snapshot', async () => {
    const repo = repository();
    await repo.transact(
      SCOPE,
      [
        { type: 'tab.created', tab: tab('chat-1') },
        { type: 'tab.created', tab: tab('chat-2') },
      ],
      { source: 'provider', mutationId: 'two-tabs' },
    );
    const current = await repo.getState(SCOPE);
    const firstTab = current.tabsFile.tabs[0];
    if (!firstTab) throw new Error('Expected first canonical tab');

    const replaced = await repo.replaceCompatibilityTabs(SCOPE, {
      ...current.tabsFile,
      tabs: [firstTab],
      activeTabId: firstTab.id,
    });

    expect(replaced.tabsFile.tabs.map((candidate) => candidate.id)).toEqual([
      'chat-1',
    ]);
  });

  it('applies explicit split removals without losing journal-ahead tabs', async () => {
    const repo = repository();
    await repo.transact(
      SCOPE,
      [{ type: 'tab.created', tab: tab('source-chat') }],
      { source: 'provider', mutationId: 'source-checkpoint' },
    );
    await repo.flushScope(SCOPE);
    const staleCheckpoint = (await repo.getState(SCOPE)).tabsFile;
    await repo.transact(
      SCOPE,
      [{ type: 'tab.created', tab: tab('journal-ahead-chat') }],
      { source: 'provider', mutationId: 'journal-ahead' },
    );

    const migrated = await repo.replaceCompatibilityTabs(
      SCOPE,
      { ...staleCheckpoint, tabs: [], activeTabId: '' },
      { changedTabIds: [], removedTabIds: ['source-chat'] },
    );

    expect(migrated.tabsFile.tabs.map(({ id }) => id)).toEqual([
      'journal-ahead-chat',
    ]);
  });

  it('does not recreate a removed tab from a stale compatibility snapshot', async () => {
    const repo = repository();
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'provider',
      mutationId: 'create-before-stale-snapshot',
    });
    const stale = (await repo.getState(SCOPE)).tabsFile;
    await repo.transact(SCOPE, [{ type: 'tab.removed', tabId: 'chat-1' }], {
      source: 'renderer-command',
      mutationId: 'remove-before-stale-snapshot',
    });

    const merged = await repo.replaceCompatibilityTabs(SCOPE, stale);

    expect(merged.tabsFile.tabs).toEqual([]);
  });

  it('allows an authoritative rollback to restore a tombstoned tab id', async () => {
    const repo = repository();
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'provider',
      mutationId: 'create-before-authoritative-rollback',
    });
    const rollbackSnapshot = (await repo.getState(SCOPE)).tabsFile;
    await repo.transact(SCOPE, [{ type: 'tab.removed', tabId: 'chat-1' }], {
      source: 'migration',
      mutationId: 'remove-before-authoritative-rollback',
    });

    const restored = await repo.replaceCompatibilityTabs(
      SCOPE,
      rollbackSnapshot,
      {
        changedTabIds: ['chat-1'],
        removedTabIds: [],
        authoritative: true,
      },
    );

    expect(restored.tabsFile.tabs).toEqual([
      expect.objectContaining({ id: 'chat-1' }),
    ]);
  });

  it('preserves unchanged tabs during an authoritative subset rollback', async () => {
    const repo = repository();
    await repo.transact(
      SCOPE,
      [
        { type: 'tab.created', tab: tab('root-chat') },
        { type: 'tab.created', tab: tab('moved-chat') },
      ],
      { source: 'provider', mutationId: 'create-split-tabs' },
    );
    const rollbackSnapshot = (await repo.getState(SCOPE)).tabsFile;
    await repo.transact(SCOPE, [{ type: 'tab.removed', tabId: 'moved-chat' }], {
      source: 'migration',
      mutationId: 'move-chat-away',
    });

    const restored = await repo.replaceCompatibilityTabs(
      SCOPE,
      rollbackSnapshot,
      {
        changedTabIds: ['moved-chat'],
        removedTabIds: [],
        authoritative: true,
      },
    );

    expect(restored.tabsFile.tabs.map(({ id }) => id)).toEqual([
      'root-chat',
      'moved-chat',
    ]);
  });

  it('honors field removal from a fresh compatibility snapshot', async () => {
    const repo = repository();
    await repo.transact(
      SCOPE,
      [
        {
          type: 'tab.created',
          tab: { ...tab(), claudeForkSessionOnNextSend: true },
        },
      ],
      { source: 'provider', mutationId: 'fork-marker' },
    );
    const current = await repo.getState(SCOPE);
    const incomingTab = { ...current.tabsFile.tabs[0] };
    delete incomingTab.claudeForkSessionOnNextSend;

    const merged = await repo.replaceCompatibilityTabs(SCOPE, {
      ...current.tabsFile,
      tabs: [incomingTab],
    });

    expect(merged.tabsFile.tabs[0]).not.toHaveProperty(
      'claudeForkSessionOnNextSend',
    );
  });

  it('limits delta compatibility writes to explicitly changed tabs', async () => {
    const repo = repository();
    await repo.transact(
      SCOPE,
      [
        { type: 'tab.created', tab: tab('chat-1') },
        { type: 'tab.created', tab: { ...tab('chat-2'), title: 'canonical' } },
      ],
      { source: 'provider', mutationId: 'canonical-tabs' },
    );

    const merged = await repo.replaceCompatibilityTabs(
      SCOPE,
      {
        version: 1,
        revision: 0,
        tabs: [
          { ...tab('chat-1'), title: 'changed' },
          { ...tab('chat-2'), title: 'stale snapshot' },
        ],
        activeTabId: 'chat-2',
      },
      { changedTabIds: ['chat-1'] },
    );

    expect(merged.tabsFile.tabs).toEqual([
      expect.objectContaining({ id: 'chat-1', title: 'changed' }),
      expect.objectContaining({ id: 'chat-2', title: 'canonical' }),
    ]);
    expect(merged.tabsFile.activeTabId).toBe('chat-1');
  });

  it('keeps runtime across later compatibility tab upserts after restart', async () => {
    const first = repository();
    await first.transact(
      SCOPE,
      [
        { type: 'tab.created', tab: tab() },
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: { status: 'queued', queuedMessageIds: ['queued-1'] },
        },
      ],
      { source: 'provider', mutationId: 'runtime-before-upsert' },
    );
    await first.transact(
      SCOPE,
      [{ type: 'tab.created', tab: { ...tab(), title: 'metadata upsert' } }],
      { source: 'migration', mutationId: 'compatibility-upsert' },
    );
    await first.flushScope(SCOPE);

    // Advance the backup-recovery floor past the runtime record so the next
    // checkpoint must retain it explicitly rather than incidentally keeping
    // every record newer than the previous snapshot.
    await first.transact(
      SCOPE,
      [{ type: 'tab.created', tab: { ...tab(), title: 'later upsert' } }],
      { source: 'migration', mutationId: 'later-compatibility-upsert' },
    );
    await first.flushScope(SCOPE);

    const recovered = await repository().getState(SCOPE);
    expect(recovered.runtimeByChatId['chat-1']).toEqual({
      status: 'queued',
      queuedMessageIds: ['queued-1'],
    });
  });

  it('durably reconciles an orphaned streaming turn as interrupted on restart', async () => {
    const userMessage = {
      id: 'user-1',
      role: 'user' as const,
      timestamp: 10,
      blocks: [{ type: 'text' as const, text: 'Finish this turn' }],
    };
    const timerMessage = {
      id: 'timer-1',
      role: 'system' as const,
      timestamp: 10,
      blocks: [
        { type: 'turn_timer' as const, startedAt: 10, completedAt: null },
      ],
    };
    const first = repository({ now: () => 20 });
    await first.transact(
      SCOPE,
      [
        {
          type: 'tab.created',
          tab: { ...tab(), messages: [userMessage, timerMessage] },
        },
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurn: { userMessageId: 'user-1', startedAt: 10 },
          },
        },
      ],
      { source: 'provider', mutationId: 'streaming' },
    );
    await first.flushScope(SCOPE);

    const second = repository({ now: () => 20 });
    const recovered = await second.getState(SCOPE);
    expect(recovered.runtimeByChatId['chat-1']).toMatchObject({
      status: 'interrupted',
      error: { code: 'interrupted', retryable: true },
    });
    expect(recovered.runtimeByChatId['chat-1']).not.toHaveProperty(
      'activeTurn',
    );
    expect(recovered.tabsFile.tabs[0]?.messages[1]).toMatchObject({
      id: 'timer-1',
      blocks: [{ type: 'turn_timer', startedAt: 10, completedAt: 10 }],
    });
    expect(recovered.tabsFile.tabs[0]?.interruptedTurns).toEqual({
      'user-1': {},
    });
    expect(recovered.tabsFile.revision).toBe(2);
    await second.flushScope(SCOPE);
    const reopened = await repository({ now: () => 1000 }).getState(SCOPE);
    expect(reopened.tabsFile.tabs[0]?.messages).toEqual(
      recovered.tabsFile.tabs[0]?.messages,
    );
    expect(reopened.runtimeByChatId['chat-1']?.lastActivityAt).toBe(10);
    expect(reopened.tabsFile.tabs[0]?.interruptedTurns).toEqual({
      'user-1': {},
    });
    expect(readFileSync(paths.journal, 'utf8')).toContain('startup-reconcile');
  });

  it('keeps host-owned queued runtime queued during restart reconciliation', async () => {
    const first = repository();
    await first.transact(
      SCOPE,
      [
        { type: 'tab.created', tab: tab() },
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: { status: 'queued', queuedMessageIds: ['queued-1'] },
        },
      ],
      { source: 'automation', mutationId: 'queued' },
    );
    await first.flushScope(SCOPE);

    const recovered = await repository().getState(SCOPE);
    expect(recovered.runtimeByChatId['chat-1']).toEqual({
      status: 'queued',
      queuedMessageIds: ['queued-1'],
    });
    expect(recovered.tabsFile.revision).toBe(1);
  });

  it('replays only the lagging component after a crash between snapshot renames', async () => {
    const assistant = {
      id: 'assistant-1',
      role: 'assistant' as const,
      timestamp: 2,
      blocks: [{ type: 'text' as const, text: 'once' }],
    };
    writeJson(paths.tabs, {
      version: 1,
      revision: 2,
      tabs: [{ ...tab(), messages: [assistant] }],
      activeTabId: 'chat-1',
    });
    writeJson(paths.archives, { version: 1, revision: 1, archived: [] });
    await chatStateJournal.appendChatJournalRecord(
      paths.journal,
      journalRecord(2, {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: assistant,
      }),
    );

    const recovered = await repository().getState(SCOPE);
    expect(recovered.tabsFile.tabs[0]?.messages).toEqual([assistant]);
    expect(recovered.tabsFile.revision).toBe(2);
    expect(recovered.archivesFile.revision).toBe(2);
  });

  it('does not double-apply retained journal records after both snapshots are durable', async () => {
    const assistant = {
      id: 'assistant-1',
      role: 'assistant' as const,
      timestamp: 2,
      blocks: [{ type: 'text' as const, text: 'once' }],
    };
    writeJson(paths.tabs, {
      version: 1,
      revision: 2,
      tabs: [{ ...tab(), messages: [assistant] }],
      activeTabId: 'chat-1',
    });
    writeJson(paths.archives, { version: 1, revision: 2, archived: [] });
    await chatStateJournal.appendChatJournalRecord(
      paths.journal,
      journalRecord(1, { type: 'tab.created', tab: tab() }),
    );
    await chatStateJournal.appendChatJournalRecord(
      paths.journal,
      journalRecord(2, {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: assistant,
      }),
    );

    const recovered = await repository().getState(SCOPE);
    expect(recovered.tabsFile.tabs[0]?.messages).toEqual([assistant]);
    expect(recovered.tabsFile.revision).toBe(2);
  });

  it('keeps live-process mutation retries idempotent after their journal record is compacted', async () => {
    const repo = repository();
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'provider',
      mutationId: 'provider-event-1',
    });
    await repo.flushScope(SCOPE);
    await repo.transact(
      SCOPE,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: { planMode: true },
        },
      ],
      { source: 'renderer-command', mutationId: 'settings-1' },
    );
    await repo.flushScope(SCOPE);
    expect(readFileSync(paths.journal, 'utf8')).not.toContain(
      'provider-event-1',
    );

    const duplicate = await repo.transact(
      SCOPE,
      [
        {
          type: 'message.upserted',
          chatId: 'chat-1',
          message: {
            id: 'must-not-appear',
            role: 'assistant',
            timestamp: 3,
            blocks: [{ type: 'text', text: 'duplicate' }],
          },
        },
      ],
      { source: 'provider', mutationId: 'provider-event-1' },
    );

    expect(duplicate.revision).toBe(2);
    expect((await repo.getState(SCOPE)).tabsFile.tabs[0]?.messages).toEqual([]);
  });

  it('flushes before eviction and refuses eviction while runtime depends on the scope', async () => {
    const repo = repository();
    await repo.transact(
      SCOPE,
      [
        { type: 'tab.created', tab: tab() },
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurn: { userMessageId: 'user-1', startedAt: 1 },
          },
        },
      ],
      { source: 'provider', mutationId: 'live-runtime' },
    );
    await expect(repo.evictScope(SCOPE)).resolves.toBe(false);
    await repo.transact(
      SCOPE,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      ],
      { source: 'provider', mutationId: 'terminal-runtime' },
    );
    await expect(repo.evictScope(SCOPE)).resolves.toBe(true);
    expect(repo.getLifecycle(SCOPE)).toBe('unloaded');
    expect(JSON.parse(readFileSync(paths.tabs, 'utf8')).revision).toBe(2);
  });

  it('deletes a drained empty scope without a scheduled checkpoint resurrecting its files', async () => {
    const repo = repository();
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'migration',
      mutationId: 'create-before-delete',
    });
    await repo.transact(SCOPE, [{ type: 'tab.removed', tabId: 'chat-1' }], {
      source: 'migration',
      mutationId: 'durable-delete',
      checkpoint: true,
    });

    await repo.deleteEmptyScope(SCOPE);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(repo.getLifecycle(SCOPE)).toBe('unloaded');
    expect(readdirSync(dirname(paths.tabs))).not.toContain('worktree-1.json');
    expect(readdirSync(dirname(paths.archives))).not.toContain(
      'worktree-1.json',
    );
    expect(readdirSync(dirname(paths.journal))).not.toContain(
      'worktree-1.jsonl',
    );
  });

  it('does not let a flush queued during scope deletion recreate sidecars', async () => {
    const repo = repository();
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'migration',
      mutationId: 'create-before-concurrent-delete',
    });
    await repo.transact(SCOPE, [{ type: 'tab.removed', tabId: 'chat-1' }], {
      source: 'migration',
      mutationId: 'durable-concurrent-delete',
      checkpoint: true,
    });

    await repo.runWithScopeDeletion(SCOPE, async () => {
      const deletion = repo.deleteEmptyScope(SCOPE);
      const flush = repo.flushScope(SCOPE);
      await Promise.all([deletion, flush]);
    });

    expect(repo.getLifecycle(SCOPE)).toBe('unloaded');
    expect(readdirSync(dirname(paths.tabs))).not.toContain('worktree-1.json');
    expect(readdirSync(dirname(paths.archives))).not.toContain(
      'worktree-1.json',
    );
    expect(readdirSync(dirname(paths.journal))).not.toContain(
      'worktree-1.jsonl',
    );
  });

  it('allows only an explicitly authorized archive flush during scope deletion', async () => {
    const repo = repository();
    await repo.transact(SCOPE, [{ type: 'tab.created', tab: tab() }], {
      source: 'provider',
      mutationId: 'provider-event-before-archive',
    });

    await repo.runWithScopeDeletion(SCOPE, async () => {
      await repo.flushScope(SCOPE);
      expect(existsSync(paths.tabs)).toBe(false);

      await repo.flushScope(SCOPE, { allowDuringScopeDeletion: true });
    });

    expect(JSON.parse(readFileSync(paths.tabs, 'utf8')).tabs).toEqual([
      expect.objectContaining({ id: 'chat-1' }),
    ]);
  });

  it('isolates identical worktree ids in different project scopes', async () => {
    const scoped = new ChatStateRepository({
      resolvePaths: (scope) => ({
        tabs: join(
          tempDir,
          scope.projectId,
          'chats',
          `${scope.worktreeId}.json`,
        ),
        archives: join(
          tempDir,
          scope.projectId,
          'chat-archives',
          `${scope.worktreeId}.json`,
        ),
        journal: join(
          tempDir,
          scope.projectId,
          'chat-journals',
          `${scope.worktreeId}.jsonl`,
        ),
      }),
    });
    repositories.push(scoped);
    const other = { projectId: 'app-advisor', worktreeId: 'worktree-1' };
    await scoped.transact(
      SCOPE,
      [{ type: 'tab.created', tab: tab('workspace-chat') }],
      { source: 'renderer-command' },
    );
    await scoped.transact(
      other,
      [{ type: 'tab.created', tab: tab('advisor-chat') }],
      { source: 'renderer-command' },
    );

    await expect(scoped.getState(SCOPE)).resolves.toMatchObject({
      tabsFile: { tabs: [{ id: 'workspace-chat' }] },
    });
    await expect(scoped.getState(other)).resolves.toMatchObject({
      tabsFile: { tabs: [{ id: 'advisor-chat' }] },
    });
  });
});

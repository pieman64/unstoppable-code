import type {
  ArchivedChatEntry,
  ChatTabMetadataPatch,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  ChatStateInvariantError,
  reduceChatState,
  type CanonicalChatState,
} from '../chat-state-reducer';

function tab(
  id: string,
  messages: PersistedChatTab['messages'] = [],
): PersistedChatTab {
  return {
    id,
    title: id,
    createdAt: '2026-08-07T12:00:00.000Z',
    providerType: 'claude',
    model: 'claude-opus-4-6',
    messages,
  };
}

function state(tabs = [tab('chat-1')]): CanonicalChatState {
  return {
    tabsFile: { version: 1, tabs, activeTabId: tabs[0]?.id ?? '' },
    archivesFile: { version: 1, archived: [] },
    runtimeByChatId: {},
  };
}

describe('chat state reducer', () => {
  it('retains terminal implementation evidence after end eviction, ignores duplicate outcomes, and clears mismatched identity', () => {
    const link = {
      planId: 'plan-1',
      revisionNumber: 2,
      userMessageId: 'implement-1',
      startedAt: '2026-08-07T12:00:00.000Z',
    };
    let current = state([
      {
        ...tab('chat-1'),
        trackedPlanId: link.planId,
        trackedPlanImplementation: link,
      },
    ]);
    const patch = (value: ChatTabMetadataPatch): void => {
      current = reduceChatState(current, [
        { type: 'tab.metadata_patched', tabId: 'chat-1', patch: value },
      ]);
    };
    patch({
      turnEnds: {
        'implement-1': { outcome: 'completed', endedAt: 1786104000000 },
      },
    });
    const settled = current.tabsFile.tabs[0]?.trackedPlanImplementation;
    expect(settled).toMatchObject({
      ...link,
      outcome: 'completed',
      endedAt: new Date(1786104000000).toISOString(),
    });
    patch({
      turnEnds: {
        'implement-1': { outcome: 'failed', endedAt: 1786104000010 },
      },
    });
    patch({ turnEnds: null, trackedPlanImplementation: link });
    expect(current.tabsFile.tabs[0]?.trackedPlanImplementation).toEqual(
      settled,
    );
    patch({ trackedPlanId: 'another-plan' });
    expect(current.tabsFile.tabs[0]?.trackedPlanImplementation).toBeUndefined();
  });

  it('sets, replaces, omits, and deletes a custom title without changing other metadata', () => {
    let current = state([
      { ...tab('chat-1'), description: 'Generated name', pinned: true },
    ]);
    for (const customTitle of ['My chat', 'Replacement']) {
      current = reduceChatState(current, [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: { customTitle },
        },
      ]);
      expect(current.tabsFile.tabs[0]).toMatchObject({
        customTitle,
        description: 'Generated name',
        pinned: true,
      });
    }
    current = reduceChatState(current, [
      {
        type: 'tab.metadata_patched',
        tabId: 'chat-1',
        patch: { unread: true },
      },
    ]);
    expect(current.tabsFile.tabs[0]).toMatchObject({
      customTitle: 'Replacement',
      unread: true,
    });
    current = reduceChatState(current, [
      {
        type: 'tab.metadata_patched',
        tabId: 'chat-1',
        patch: { customTitle: null },
      },
    ]);
    expect(current.tabsFile.tabs[0]).not.toHaveProperty('customTitle');
    expect(current.tabsFile.tabs[0]).toMatchObject({
      description: 'Generated name',
      pinned: true,
      unread: true,
    });
  });

  it('rejects custom-title patches on file tabs', () => {
    expect(() =>
      reduceChatState(state([{ ...tab('file-1'), kind: 'file' }]), [
        {
          type: 'tab.metadata_patched',
          tabId: 'file-1',
          patch: { customTitle: 'File rename' },
        },
      ]),
    ).toThrow('cannot patch a file tab');
  });
  it('ignores prototype-mutating metadata patch keys', () => {
    const patch: ChatTabMetadataPatch = { title: 'Safe title' };
    Object.defineProperty(patch, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { polluted: true },
      writable: true,
    });
    Object.defineProperty(patch, 'constructor', {
      configurable: true,
      enumerable: true,
      value: { polluted: true },
      writable: true,
    });

    const next = reduceChatState(state(), [
      { type: 'tab.metadata_patched', tabId: 'chat-1', patch },
    ]);
    const nextTab = next.tabsFile.tabs[0];

    expect(nextTab?.title).toBe('Safe title');
    expect(Object.getPrototypeOf(nextTab)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(nextTab, 'constructor')).toBe(
      false,
    );
  });

  it('merges partial modelConfig patches field-wise instead of replacing', () => {
    const initial = state([
      {
        ...tab('chat-1'),
        modelConfig: { thinkingLevel: 'low', fastMode: true },
      },
    ]);

    const next = reduceChatState(initial, [
      {
        type: 'tab.metadata_patched',
        tabId: 'chat-1',
        patch: { modelConfig: { thinkingLevel: 'high' } },
      },
    ]);

    // A partial patch (e.g. the portal thinking setter) must not clobber
    // sibling modelConfig fields like fastMode. The canonical write also
    // records the legacy boolean's exact speed beside it.
    expect(next.tabsFile.tabs[0]?.modelConfig).toEqual({
      thinkingLevel: 'high',
      speed: 'fast',
      fastMode: true,
    });
  });

  describe('Codex speed patches', () => {
    function patchModelConfig(
      modelConfig: NonNullable<PersistedChatTab['modelConfig']> | undefined,
      patch: NonNullable<ChatTabMetadataPatch['modelConfig']>,
    ): PersistedChatTab['modelConfig'] {
      const initial = state([
        { ...tab('chat-1'), ...(modelConfig ? { modelConfig } : {}) },
      ]);
      return reduceChatState(initial, [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: { modelConfig: patch },
        },
      ]).tabsFile.tabs[0]?.modelConfig;
    }

    it('preserves Ultra fast across an unrelated thinking patch', () => {
      expect(
        patchModelConfig(
          { thinkingLevel: 'low', speed: 'ultrafast', fastMode: false },
          { thinkingLevel: 'high' },
        ),
      ).toEqual({ thinkingLevel: 'high', speed: 'ultrafast', fastMode: false });
    });

    it('replaces Ultra fast with Regular for an explicit legacy false', () => {
      // Ultra fast already projects `fastMode: false`; the boolean command is
      // still an explicit Regular choice, never an equality no-op.
      expect(
        patchModelConfig(
          { thinkingLevel: 'low', speed: 'ultrafast', fastMode: false },
          { fastMode: false },
        ),
      ).toEqual({ thinkingLevel: 'low', speed: 'standard', fastMode: false });
    });

    it('replaces Ultra fast with Fast for an explicit legacy true', () => {
      expect(
        patchModelConfig(
          { thinkingLevel: 'low', speed: 'ultrafast', fastMode: false },
          { fastMode: true },
        ),
      ).toEqual({ thinkingLevel: 'low', speed: 'fast', fastMode: true });
    });

    it('derives fastMode from an exact speed and never writes true for Ultra fast', () => {
      expect(
        patchModelConfig(
          { thinkingLevel: 'low', fastMode: true },
          { speed: 'ultrafast' },
        ),
      ).toEqual({ thinkingLevel: 'low', speed: 'ultrafast', fastMode: false });
      expect(
        patchModelConfig(
          { thinkingLevel: 'low', speed: 'fast', fastMode: true },
          { speed: 'ultrafast', fastMode: true },
        ),
      ).toEqual({ thinkingLevel: 'low', speed: 'ultrafast', fastMode: false });
      expect(
        patchModelConfig(
          { thinkingLevel: 'low', speed: 'ultrafast', fastMode: false },
          { speed: 'fast' },
        ),
      ).toEqual({ thinkingLevel: 'low', speed: 'fast', fastMode: true });
    });

    it.each([
      [true, { thinkingLevel: 'high', speed: 'fast', fastMode: true }],
      [false, { thinkingLevel: 'high', speed: 'standard', fastMode: false }],
      [undefined, { thinkingLevel: 'high' }],
    ] as const)(
      'records the exact speed of a legacy fastMode %s record on a thinking patch',
      (fastMode, expected) => {
        expect(
          patchModelConfig(
            {
              thinkingLevel: 'low',
              ...(fastMode === undefined ? {} : { fastMode }),
            },
            { thinkingLevel: 'high' },
          ),
        ).toEqual(expected);
      },
    );
  });

  it('applies provider-owned metadata without replacing transcript messages', () => {
    const existingMessage = {
      id: 'user-1',
      role: 'user' as const,
      timestamp: 1,
      blocks: [{ type: 'text' as const, text: 'Keep me' }],
    };
    const initial = state([tab('chat-1', [existingMessage])]);

    const next = reduceChatState(initial, [
      {
        type: 'tab.metadata_patched',
        tabId: 'chat-1',
        patch: {
          sdkSessionId: 'session-1',
          usage: {
            contextTokens: 10,
            contextWindow: 100,
            maxOutputTokens: 20,
            totalCostUsd: 0.01,
            inputTokens: 8,
            outputTokens: 2,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            durationMs: 50,
            durationApiMs: 40,
            numTurns: 1,
            model: 'claude-opus-4-6',
          },
        },
      },
    ]);

    expect(next.tabsFile.tabs[0]?.sdkSessionId).toBe('session-1');
    expect(next.tabsFile.tabs[0]?.usage?.contextTokens).toBe(10);
    expect(next.tabsFile.tabs[0]?.messages).toEqual([existingMessage]);
  });

  it('persists file-tab pin and view-mode patches while rejecting chat-only settings', () => {
    const fileTab: PersistedChatTab = {
      id: 'file-1',
      kind: 'file',
      title: 'notes.md',
      filePath: '/tmp/notes.md',
      createdAt: '2026-08-07T12:00:00.000Z',
      messages: [],
    };
    const next = reduceChatState(state([fileTab]), [
      {
        type: 'tab.metadata_patched',
        tabId: 'file-1',
        patch: { pinned: true, fileViewMode: 'preview' },
      },
    ]);

    expect(next.tabsFile.tabs[0]).toMatchObject({
      pinned: true,
      fileViewMode: 'preview',
    });
    expect(() =>
      reduceChatState(state([fileTab]), [
        {
          type: 'tab.metadata_patched',
          tabId: 'file-1',
          patch: { planMode: true },
        },
      ]),
    ).toThrow(ChatStateInvariantError);
  });

  it('assigns a file into an empty file tab via filePath/title patches', () => {
    const emptyFileTab: PersistedChatTab = {
      id: 'file-empty',
      kind: 'file',
      title: 'New file',
      filePath: '',
      createdAt: '2026-08-07T12:00:00.000Z',
      messages: [],
    };
    const next = reduceChatState(state([emptyFileTab]), [
      {
        type: 'tab.metadata_patched',
        tabId: 'file-empty',
        patch: { filePath: '/tmp/notes.md', title: 'notes.md' },
      },
    ]);

    expect(next.tabsFile.tabs[0]).toMatchObject({
      filePath: '/tmp/notes.md',
      title: 'notes.md',
    });

    // Chat tabs must reject the file-tab-only path field. Titles remain
    // canonical metadata for both chat and file tabs.
    expect(() =>
      reduceChatState(state(), [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat-1',
          patch: { filePath: '/tmp/notes.md' },
        },
      ]),
    ).toThrow(ChatStateInvariantError);
  });

  it('upserts provider messages without erasing a concurrent settings patch', () => {
    const patched = reduceChatState(state(), [
      {
        type: 'tab.metadata_patched',
        tabId: 'chat-1',
        patch: { planMode: true, proposalMode: 'required' },
      },
    ]);
    const next = reduceChatState(patched, [
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'durable' }],
        },
      },
    ]);

    expect(next.tabsFile.tabs[0]).toMatchObject({
      planMode: true,
      proposalMode: 'required',
      model: 'claude-opus-4-6',
    });
    expect(next.tabsFile.tabs[0]?.messages).toHaveLength(1);
    expect(state().tabsFile.tabs[0]?.messages).toEqual([]);
  });

  it('uses stable ids to replace a streaming message in place', () => {
    const initial = state([
      tab('chat-1', [
        {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'partial' }],
        },
      ]),
    ]);
    const next = reduceChatState(initial, [
      {
        type: 'message.upserted',
        chatId: 'chat-1',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'complete' }],
        },
      },
    ]);
    expect(next.tabsFile.tabs[0]?.messages).toEqual([
      expect.objectContaining({
        id: 'assistant-1',
        blocks: [{ type: 'text', text: 'complete' }],
      }),
    ]);
  });

  it('archives and restores atomically in one reducer transaction', () => {
    const source = tab('chat-1');
    const entry: ArchivedChatEntry = {
      tab: source,
      archivedAt: '2026-08-07T12:01:00.000Z',
      turnCount: 0,
    };
    const archived = reduceChatState(state([source]), [
      { type: 'tab.removed', tabId: source.id },
      { type: 'archive.upserted', entry },
    ]);
    expect(archived.tabsFile.tabs).toEqual([]);
    expect(archived.archivesFile.archived).toEqual([entry]);

    const restored = reduceChatState(archived, [
      {
        type: 'archive.removed',
        archiveEntryId: source.id,
        chatId: source.id,
      },
      { type: 'tab.created', tab: source },
    ]);
    expect(restored.tabsFile.tabs).toEqual([source]);
    expect(restored.archivesFile.archived).toEqual([]);
  });

  it('replaces an existing archive without changing its position', () => {
    const newest: ArchivedChatEntry = {
      tab: tab('archive-newest'),
      archivedAt: '2026-08-11T03:00:00.000Z',
      turnCount: 1,
    };
    const older: ArchivedChatEntry = {
      tab: tab('archive-older'),
      archivedAt: '2026-08-11T01:00:00.000Z',
      turnCount: 1,
    };
    const initial = {
      ...state([]),
      archivesFile: { version: 1 as const, archived: [newest, older] },
    };

    const next = reduceChatState(initial, [
      {
        type: 'archive.upserted',
        entry: { ...older, turnCount: 2 },
      },
    ]);

    expect(
      next.archivesFile.archived.map(({ tab: entryTab }) => entryTab.id),
    ).toEqual(['archive-newest', 'archive-older']);
    expect(next.archivesFile.archived[1]?.turnCount).toBe(2);
  });

  it('rejects invalid reorder and live/archive overlap', () => {
    const current = state([tab('chat-1'), tab('chat-2')]);
    expect(() =>
      reduceChatState(current, [
        { type: 'tab.order_changed', tabIds: ['chat-1'] },
      ]),
    ).toThrow(ChatStateInvariantError);
    expect(() =>
      reduceChatState(current, [
        {
          type: 'archive.upserted',
          entry: {
            tab: current.tabsFile.tabs[0],
            archivedAt: '2026-08-07T12:01:00.000Z',
            turnCount: 0,
          },
        },
      ]),
    ).toThrow(ChatStateInvariantError);
  });

  it('keeps runtime separate from compatibility tab snapshots', () => {
    const next = reduceChatState(state(), [
      {
        type: 'runtime.patched',
        chatId: 'chat-1',
        runtime: {
          status: 'streaming',
          queuedMessageIds: [],
          activeTurn: { userMessageId: 'user-1', startedAt: 10 },
        },
      },
    ]);
    expect(next.runtimeByChatId['chat-1']?.status).toBe('streaming');
    expect(next.tabsFile.tabs[0]).not.toHaveProperty('status');
  });

  it('does not rescan unchanged transcripts for a runtime-only mutation', () => {
    const unchangedMessages: PersistedChatTab['messages'] = [];
    Object.defineProperty(unchangedMessages, 'map', {
      configurable: true,
      get(): never {
        throw new Error('unchanged transcript was rescanned');
      },
    });
    const current = state([tab('chat-1', unchangedMessages)]);

    expect(() =>
      reduceChatState(current, [
        {
          type: 'runtime.patched',
          chatId: 'chat-1',
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
          },
        },
      ]),
    ).not.toThrow();
  });
});

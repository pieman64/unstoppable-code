import type {
  CodexSpeed,
  PersistedChatMessage,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  initClaudeModels,
  initCodexModels,
  normalizeThinkingForUi,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  hydratePersistedChatTab,
  clonePersistedChatTabForResume,
} from '../chatTabPersistence';
import { toPersistedMessage } from '../../stores/chat/persisted-tabs';

// ---------------------------------------------------------------------------
// Seed model registries so ALL_MODELS validation works
// ---------------------------------------------------------------------------
beforeAll(() => {
  initClaudeModels([
    {
      id: 'opus[1m]',
      label: 'Opus 4.8 1M',
      contextWindow: 1_000_000,
    },
    {
      id: 'claude-sonnet-4-6',
      label: 'Sonnet 4.6',
      contextWindow: 200_000,
    },
  ]);
  initCodexModels([{ id: 'codex-mini-latest', label: 'Codex Mini' }]);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makePersistedTab = (
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab => ({
  id: 'tab-1',
  title: 'Test Tab',
  messages: [
    {
      id: 'msg-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      timestamp: 1000,
    },
  ],
  createdAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('reference-only row preservation (phase 14 R)', () => {
  const row: PersistedChatMessage & {
    futureBodyRef: { version: number; key: string };
  } = {
    id: 'referenced-row',
    role: 'assistant',
    timestamp: 1234,
    blocks: [],
    blocksRef: {
      version: 1,
      blockCount: 1,
      manifest: {
        version: 1,
        artifactId: `sha256-v1-${'a'.repeat(64)}`,
        sha256: 'a'.repeat(64),
        byteLength: 256,
        encoding: 'utf-8',
        mediaType: 'text/plain',
      },
    },
    futureBodyRef: { version: 2, key: 'opaque-reference' },
  };

  it('keeps a reference-only assistant row during hydrate', () => {
    const hydrated = hydratePersistedChatTab(
      makePersistedTab({ messages: [row] }),
    );
    expect(hydrated.messages).toEqual([row]);
    expect(hydrated.messages.map(toPersistedMessage)).toEqual([row]);
  });

  it('keeps references on hydrate then persist independently of empty-assistant filtering', () => {
    const userRow: typeof row = { ...row, role: 'user' };
    const hydrated = hydratePersistedChatTab(
      makePersistedTab({ messages: [userRow] }),
    );
    expect(hydrated.messages.map(toPersistedMessage)).toEqual([userRow]);
  });

  it('keeps delegation child metadata and the stream card marker without renderer state', () => {
    const child = {
      id: 'child',
      role: 'assistant' as const,
      timestamp: 4,
      blocks: [{ type: 'text' as const, text: 'child text' }],
      parentBlockId: 'delegated-agent-child',
      delegationSequence: 2,
      delegationSegment: 'segment',
      delegationDelivery: 'steer' as const,
      delegationAuthor: { kind: 'user' as const },
      truncated: true as const,
      itemRevision: 3,
      final: true,
      futureBodyRef: { key: 'opaque-child' },
    };
    const card = {
      id: 'card',
      role: 'assistant' as const,
      timestamp: 3,
      blocks: [
        {
          type: 'delegated_agent_call' as const,
          agentBlockId: 'delegated-agent-child',
          delegationId: 'child',
          runGeneration: 1,
          sequence: 1,
          status: 'running' as const,
          outputTruncated: false,
          selectedModelId: '',
          runtimeModelId: '',
          targetHarnessId: '',
          description: 'Task',
          prompt: 'Prompt',
          executionMode: 'background' as const,
          parentHarnessId: 'claude',
          parentTurnId: 'turn',
          parentToolCallId: 'tool',
          createdAt: 3,
          transcriptStore: 'chat-stream-v2' as const,
        },
      ],
      futureBodyRef: { key: 'opaque-card' },
    };
    const hydrated = hydratePersistedChatTab(
      makePersistedTab({ messages: [card, child] }),
    );
    expect(hydrated.messages.map(toPersistedMessage)).toEqual([card, child]);
    const runtime = {
      ...card,
      isStreaming: true,
      selected: true,
      error: 'transient',
      pending: {},
    };
    expect(toPersistedMessage(runtime)).toEqual(card);
  });
});

// ---------------------------------------------------------------------------
// hydratePersistedChatTab
// ---------------------------------------------------------------------------
describe('hydratePersistedChatTab', () => {
  it('retains an explicit OpenCode choice when an empty chat reloads', () => {
    const tab = hydratePersistedChatTab(
      makePersistedTab({
        messages: [],
        model: 'claude-sonnet-4-6',
        providerType: 'opencode',
        executionHarness: 'opencode',
        executionHarnessExplicitlyChosen: true,
      }),
    );
    expect(tab).toMatchObject({
      model: 'claude-sonnet-4-6',
      providerType: 'opencode',
      executionHarness: 'opencode',
      executionHarnessExplicitlyChosen: true,
    });
  });

  it('retains hidden delivery messages through the alternate tab hydrator', () => {
    const tab = hydratePersistedChatTab(
      makePersistedTab({
        messages: [
          {
            id: 'managed-delivery',
            role: 'user',
            hidden: true,
            blocks: [{ type: 'text', text: 'private orchestration payload' }],
            timestamp: 1000,
          },
        ],
      }),
    );

    expect(tab.messages[0]?.hidden).toBe(true);
  });

  it('preserves transcript paging metadata for archive viewers', () => {
    const persisted = makePersistedTab({
      transcriptLoaded: true,
      transcript: {
        format: 'complete-message-jsonl-v1',
        committedMessageCount: 600,
        committedByteLength: 90_000,
        transcriptRevision: 4,
        hasActiveSidecar: false,
      },
      transcriptWindow: {
        before: 100,
        totalMessages: 600,
        transcriptRevision: 4,
      },
    });

    const tab = hydratePersistedChatTab(persisted);

    expect(tab).toMatchObject({
      transcriptLoaded: true,
      transcript: persisted.transcript,
      transcriptWindow: persisted.transcriptWindow,
    });
  });

  it('restores watcher attribution on persisted user messages', () => {
    const tab = hydratePersistedChatTab(
      makePersistedTab({
        messages: [
          {
            id: 'watcher-message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Pipeline finished' }],
            timestamp: 1000,
            watcherFired: { kind: 'Pipeline completion (Deploy)' },
          },
        ],
      }),
    );

    expect(tab.messages[0]?.watcherFired).toEqual({
      kind: 'Pipeline completion (Deploy)',
    });
  });

  it('restores external agent attribution on persisted user messages', () => {
    const agentSent = {
      kind: 'external_agent' as const,
      connectionId: '11111111-1111-4111-8111-111111111111',
      clientName: 'Cursor',
      verified: false,
      userId: '22222222-2222-4222-8222-222222222222',
    };
    const tab = hydratePersistedChatTab(
      makePersistedTab({
        messages: [
          {
            id: 'agent-message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Sent from an agent' }],
            timestamp: 1000,
            agentSent,
          },
        ],
      }),
    );

    expect(tab.messages[0]?.agentSent).toEqual(agentSent);
  });

  it('restores pending Claude Terminal watcher correlations', () => {
    const pendingClaudeTerminalWatcherMessages = [
      {
        text: 'Pipeline finished',
        submittedText:
          '<system_instruction>context</system_instruction>\n\nPipeline finished',
        deliveryId: 'delivery-1',
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
    ];
    const tab = hydratePersistedChatTab(
      makePersistedTab({ pendingClaudeTerminalWatcherMessages }),
    );

    expect(tab.pendingClaudeTerminalWatcherMessages).toEqual(
      pendingClaudeTerminalWatcherMessages,
    );
  });

  it('canonicalizes legacy bundle selections while hydrating a tab', () => {
    const tab = hydratePersistedChatTab(
      makePersistedTab({
        pluginSelections: {
          collectionIds: [],
          bundleIds: ['legacy-collection'],
          skillRefs: [],
          pluginRefs: [
            { marketplaceId: 'marketplace', pluginName: 'legacy-plugin' },
          ],
          mcpServerRefs: [],
        },
      }),
    );

    expect(tab.pluginSelections).toEqual({
      collectionIds: ['legacy-collection'],
      skillRefs: [],
      pluginRefs: [
        { marketplaceId: 'marketplace', pluginName: 'legacy-plugin' },
      ],
      mcpServerRefs: [],
    });
    expect(tab.pluginSelections?.bundleIds).toBeUndefined();
  });

  it('preserves an explicit disabled deferred-tools permission', () => {
    const tab = hydratePersistedChatTab({
      ...makePersistedTab(),
      deferredToolsAllowed: false,
    });

    expect(tab.deferredToolsAllowed).toBe(false);
  });

  it('hydrates a basic tab with all fields', () => {
    const pt = makePersistedTab({
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'high',
      planMode: true,
      proposalMode: 'required',
      sdkSessionId: 'sess-1',
      readOnly: true,
      description: 'A test chat',
      executionHarness: 'codex',
    });

    const tab = hydratePersistedChatTab(pt);

    expect(tab.id).toBe('tab-1');
    expect(tab.title).toBe('Test Tab');
    expect(tab.description).toBe('A test chat');
    expect(tab.createdAt).toBe('2024-01-01T00:00:00Z');
    expect(tab.model).toBe('claude-sonnet-4-6');
    expect(tab.thinkingLevel).toBe('high');
    expect(tab.planMode).toBe(true);
    expect(tab.proposalMode).toBe('required');
    expect(tab.sdkSessionId).toBe('sess-1');
    expect(tab.readOnly).toBe(true);
    expect(tab.executionHarness).toBe('codex');
    expect(tab.messages).toHaveLength(1);
    expect(tab.messages[0]).toEqual({
      id: 'msg-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      timestamp: 1000,
    });
  });

  it('sets status to idle and error to null', () => {
    const tab = hydratePersistedChatTab(makePersistedTab());

    expect(tab.status).toBe('idle');
    expect(tab.error).toBeNull();
  });

  it('does not capture a harness from a preallocated SDK session on an empty tab', () => {
    const tab = hydratePersistedChatTab(
      makePersistedTab({
        messages: [],
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        sdkSessionId: 'preallocated-session',
        executionHarness: 'claude',
      }),
    );

    expect(tab.sdkSessionId).toBe('preallocated-session');
    expect(tab.executionHarness).toBeUndefined();
  });

  it('hydrates the Claude usage-limit banner fields when present', () => {
    const pt = makePersistedTab({
      llmProviderUsageLimitBanner: {
        provider: 'claude',
        message: 'Claude usage limit reached.',
        detectedAt: 1234,
        dismissKey: 'req-1',
      },
      dismissedLlmProviderUsageLimitBannerKey: 'req-0',
    });

    const tab = hydratePersistedChatTab(pt);

    expect(tab.llmProviderUsageLimitBanner).toEqual({
      provider: 'claude',
      message: 'Claude usage limit reached.',
      detectedAt: 1234,
      dismissKey: 'req-1',
    });
    expect(tab.dismissedLlmProviderUsageLimitBannerKey).toBe('req-0');
  });

  it('omits the usage-limit banner fields for older tabs without them (back-compat)', () => {
    const tab = hydratePersistedChatTab(makePersistedTab());

    expect(tab.llmProviderUsageLimitBanner).toBeUndefined();
    expect(tab.dismissedLlmProviderUsageLimitBannerKey).toBeUndefined();
  });

  it('hydrates scheduled-send draft metadata when present', () => {
    const tab = hydratePersistedChatTab(
      makePersistedTab({
        scheduledSendDraft: { runAt: '2099-01-01T12:30:00.000Z' },
      }),
    );

    expect(tab.scheduledSendDraft).toEqual({
      runAt: '2099-01-01T12:30:00.000Z',
    });
  });

  it('omits scheduled-send draft metadata for older tabs without it', () => {
    const tab = hydratePersistedChatTab(makePersistedTab());

    expect(tab.scheduledSendDraft).toBeUndefined();
  });

  it('creates an empty queuedMessages array', () => {
    const tab = hydratePersistedChatTab(makePersistedTab());

    expect(tab.queuedMessages).toEqual([]);
  });

  it('preserves a persisted model that is not in the registry instead of rewriting it to the default', () => {
    // Flag-gated models (e.g. LaunchDarkly-gated entries) hydrate before the
    // registry is flag-initialized, so an unresolved id must survive hydration:
    // display falls back to the raw id and send-time resolveKnownModel gating
    // still protects the agent invocation.
    const pt = makePersistedTab({ model: 'fable[1m]', providerType: 'claude' });
    const defaults = { model: 'claude-sonnet-4-6' };

    const tab = hydratePersistedChatTab(pt, defaults);

    expect(tab.model).toBe('fable[1m]');
    expect(tab.providerType).toBe('claude');
  });

  it('keeps a valid model from the persisted tab', () => {
    const pt = makePersistedTab({ model: 'claude-sonnet-4-6' });

    const tab = hydratePersistedChatTab(pt);

    expect(tab.model).toBe('claude-sonnet-4-6');
  });

  it('derives providerType from model when providerType is absent', () => {
    const pt = makePersistedTab({ model: 'codex-mini-latest' });

    const tab = hydratePersistedChatTab(pt);

    expect(tab.providerType).toBe('codex');
  });

  it('hydrates Codex fast mode from explicit persisted values before defaults', () => {
    const explicitFalse = hydratePersistedChatTab(
      makePersistedTab({
        model: 'codex-mini-latest',
        codexFastModeEnabled: false,
      }),
      { codexFastModeEnabled: true },
    );
    const explicitTrue = hydratePersistedChatTab(
      makePersistedTab({
        model: 'codex-mini-latest',
        codexFastModeEnabled: true,
      }),
      { codexFastModeEnabled: false },
    );

    expect(explicitFalse.codexFastModeEnabled).toBe(false);
    expect(explicitTrue.codexFastModeEnabled).toBe(true);
  });

  it('hydrates missing Codex fast mode from defaults and omits it for non-Codex tabs', () => {
    const codexTab = hydratePersistedChatTab(
      makePersistedTab({ model: 'codex-mini-latest' }),
      { codexFastModeEnabled: true },
    );
    const claudeTab = hydratePersistedChatTab(
      makePersistedTab({ model: 'claude-sonnet-4-6' }),
      { codexFastModeEnabled: true },
    );

    expect(codexTab.codexFastModeEnabled).toBe(true);
    expect(claudeTab.codexFastModeEnabled).toBeUndefined();
  });

  it.each<[string, Partial<PersistedChatTab>, CodexSpeed, boolean]>([
    [
      'an Ultra fast record',
      { modelConfig: { speed: 'ultrafast', fastMode: false } },
      'ultrafast',
      true,
    ],
    [
      'a Fast record',
      { modelConfig: { speed: 'fast', fastMode: true } },
      'fast',
      true,
    ],
    [
      'a Regular record',
      { modelConfig: { speed: 'standard', fastMode: false } },
      'standard',
      true,
    ],
    ['a legacy true record', { modelConfig: { fastMode: true } }, 'fast', true],
    [
      'a legacy false record',
      { modelConfig: { fastMode: false } },
      'standard',
      true,
    ],
    ['a legacy true tab alias', { codexFastModeEnabled: true }, 'fast', true],
    ['no recorded speed', {}, 'standard', false],
  ])(
    'hydrates Codex speed from %s speed-first',
    (_label, overrides, speed, explicit) => {
      const tab = hydratePersistedChatTab(
        makePersistedTab({ model: 'codex-mini-latest', ...overrides }),
      );

      expect(tab.modelConfig).toMatchObject({
        speed,
        fastMode: speed === 'fast',
      });
      expect(tab.fastModeExplicit).toBe(explicit);
      expect(tab.codexFastModeEnabled).toBe(speed === 'fast');
    },
  );

  it('resolves the selected tab record before an Ultra fast default record', () => {
    const ultraDefault = {
      modelConfig: { speed: 'ultrafast' as const, fastMode: false },
    };

    expect(
      hydratePersistedChatTab(
        makePersistedTab({ model: 'codex-mini-latest' }),
        ultraDefault,
      ).modelConfig.speed,
    ).toBe('ultrafast');
    expect(
      hydratePersistedChatTab(
        makePersistedTab({
          model: 'codex-mini-latest',
          modelConfig: { fastMode: false },
        }),
        ultraDefault,
      ).modelConfig,
    ).toMatchObject({ speed: 'standard', fastMode: false });
    expect(
      hydratePersistedChatTab(
        makePersistedTab({
          model: 'codex-mini-latest',
          codexFastModeEnabled: true,
        }),
        ultraDefault,
      ).modelConfig,
    ).toMatchObject({ speed: 'fast', fastMode: true });
    // Inside the default record, its speed beats the deprecated default alias.
    expect(
      hydratePersistedChatTab(
        makePersistedTab({ model: 'codex-mini-latest' }),
        { ...ultraDefault, codexFastModeEnabled: true },
      ).modelConfig.speed,
    ).toBe('ultrafast');
  });

  it('keeps the main-owned retained Codex speed on a hydrated tab', () => {
    const tab = hydratePersistedChatTab(
      makePersistedTab({
        model: 'claude-sonnet-4-6',
        retainedCodexSpeed: 'ultrafast',
      }),
    );

    expect(tab.retainedCodexSpeed).toBe('ultrafast');
    expect(tab.modelConfig.speed).toBe('standard');
  });

  it('derives providerType as claude for claude models', () => {
    const pt = makePersistedTab({ model: 'claude-sonnet-4-6' });

    const tab = hydratePersistedChatTab(pt);

    expect(tab.providerType).toBe('claude');
  });

  it('preserves explicitly set providerType', () => {
    const pt = makePersistedTab({
      model: 'claude-sonnet-4-6',
      providerType: 'codex',
    });

    const tab = hydratePersistedChatTab(pt);

    expect(tab.providerType).toBe('codex');
  });

  it("migrates persisted 'auto' thinking to 'high' uniformly across providers", () => {
    const codexPt = makePersistedTab({
      model: 'codex-mini-latest',
      thinkingLevel: 'auto' as never,
    });
    expect(hydratePersistedChatTab(codexPt).thinkingLevel).toBe('high');

    const claudePt = makePersistedTab({
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'auto' as never,
    });
    expect(hydratePersistedChatTab(claudePt).thinkingLevel).toBe('high');
  });

  it("preserves persisted canonical 'low' but normalizes it for UI display", () => {
    // Canonical `low` is still valid on disk for pipelines/config; it's the
    // UI cycle/dropdown that hides it. Hydration preserves the level so
    // pipelines see `low`, while components apply `normalizeThinkingForUi`
    // when rendering — surfacing it as `medium`.
    const pt = makePersistedTab({
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'low',
    });

    const tab = hydratePersistedChatTab(pt);

    expect(tab.thinkingLevel).toBe('low');
    expect(normalizeThinkingForUi(tab.thinkingLevel)).toBe('medium');
  });

  it('falls back to default model when model is missing', () => {
    const pt = makePersistedTab();
    const defaults = { model: 'claude-sonnet-4-6' };

    const tab = hydratePersistedChatTab(pt, defaults);

    expect(tab.model).toBe('claude-sonnet-4-6');
  });

  it('falls back to default thinkingLevel when thinkingLevel is missing', () => {
    const pt = makePersistedTab();
    const defaults = { thinkingLevel: 'medium' as const };

    const tab = hydratePersistedChatTab(pt, defaults);

    expect(tab.thinkingLevel).toBe('medium');
  });

  it("falls back to 'high' when thinkingLevel is missing and no default provided", () => {
    const pt = makePersistedTab();

    const tab = hydratePersistedChatTab(pt);

    expect(tab.thinkingLevel).toBe('high');
  });

  it('falls back to default pluginSelections when pluginSelections is missing', () => {
    const pt = makePersistedTab();
    const defaultPlugins: ChatTabPluginSelections = {
      collectionIds: ['plugin-a'],
      skillRefs: [],
      pluginRefs: [],
    };
    const defaults = { pluginSelections: defaultPlugins };

    const tab = hydratePersistedChatTab(pt, defaults);

    expect(tab.pluginSelections).toEqual(defaultPlugins);
  });

  it('preserves persisted pluginSelections over defaults', () => {
    const persistedPlugins: ChatTabPluginSelections = {
      collectionIds: ['plugin-b'],
      skillRefs: [],
      pluginRefs: [],
    };
    const pt = makePersistedTab({ pluginSelections: persistedPlugins });
    const defaults = {
      pluginSelections: {
        collectionIds: ['plugin-a'],
        skillRefs: [],
        pluginRefs: [],
      } satisfies ChatTabPluginSelections,
    };

    const tab = hydratePersistedChatTab(pt, defaults);

    expect(tab.pluginSelections).toEqual(persistedPlugins);
  });

  it('preserves Codex parentBlockId, codexThreadId, codexTurnId on hydrate', () => {
    const pt = makePersistedTab({
      messages: [
        {
          id: 'sub-msg',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'subagent reply' }],
          timestamp: 100,
          parentBlockId: 'codex-agent-call-1',
          codexThreadId: 'sub-thread',
          codexTurnId: 'turn-1',
        },
      ],
    });

    const tab = hydratePersistedChatTab(pt);
    expect(tab.messages).toHaveLength(1);
    expect(tab.messages[0].parentBlockId).toBe('codex-agent-call-1');
    expect(tab.messages[0].codexThreadId).toBe('sub-thread');
    expect(tab.messages[0].codexTurnId).toBe('turn-1');
  });

  it('drops empty assistant text and thinking rows on hydrate', () => {
    const pt = makePersistedTab({
      messages: [
        {
          id: 'empty-thinking',
          role: 'assistant',
          blocks: [{ type: 'thinking', text: '' }],
          timestamp: 100,
        },
        {
          id: 'empty-text',
          role: 'assistant',
          blocks: [{ type: 'text', text: '   ' }],
          timestamp: 101,
        },
        {
          id: 'empty-blocks',
          role: 'assistant',
          blocks: [],
          timestamp: 102,
        },
        {
          id: 'timer',
          role: 'system',
          blocks: [{ type: 'turn_timer', startedAt: 100, completedAt: 200 }],
          timestamp: 103,
        },
        {
          id: 'visible',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Visible response' }],
          timestamp: 104,
        },
      ],
    });

    const tab = hydratePersistedChatTab(pt);

    expect(tab.messages.map((message) => message.id)).toEqual([
      'timer',
      'visible',
    ]);
  });

  it('preserves a codex_agent_call block on hydrate (round-trip safe)', () => {
    const pt = makePersistedTab({
      messages: [
        {
          id: 'spawn',
          role: 'assistant',
          blocks: [
            {
              type: 'codex_agent_call',
              agentBlockId: 'codex-agent-call-1',
              callId: 'call-1',
              tool: 'spawnAgent',
              status: 'inProgress',
              senderThreadId: 'root',
              receiverThreadIds: ['sub-1'],
              prompt: 'work',
              agentsStates: {
                'sub-1': { status: 'running', message: null },
              },
              receiverAgents: { 'sub-1': { nickname: 'Explorer' } },
            },
          ],
          timestamp: 100,
        },
      ],
    });

    const tab = hydratePersistedChatTab(pt);
    expect(tab.messages).toHaveLength(1);
    const block = tab.messages[0].blocks[0];
    expect(block.type).toBe('codex_agent_call');
    if (block.type !== 'codex_agent_call') return;
    expect(block.agentBlockId).toBe('codex-agent-call-1');
    expect(block.receiverThreadIds).toEqual(['sub-1']);
    expect(block.agentsStates['sub-1']).toEqual({
      status: 'running',
      message: null,
    });
    expect(block.receiverAgents).toEqual({
      'sub-1': { nickname: 'Explorer' },
    });
  });

  it('normalizes stale persisted context window from selected model metadata', () => {
    const pt = makePersistedTab({
      model: 'opus[1m]',
      usage: {
        contextTokens: 120_000,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        totalCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        durationMs: 0,
        durationApiMs: 0,
        numTurns: 1,
        model: 'claude-opus-4-7',
      },
    });

    const tab = hydratePersistedChatTab(pt);

    expect(tab.usage?.contextWindow).toBe(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// clonePersistedChatTabForResume
// ---------------------------------------------------------------------------
describe('clonePersistedChatTabForResume', () => {
  it('preserves the captured execution harness', () => {
    const cloned = clonePersistedChatTabForResume(
      makePersistedTab({ executionHarness: 'claude' }),
    );
    expect(cloned.executionHarness).toBe('claude');
  });
  const mockUUID = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    jest.spyOn(crypto, 'randomUUID').mockReturnValue(mockUUID);
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('creates a new ID different from the original', () => {
    const pt = makePersistedTab();

    const cloned = clonePersistedChatTabForResume(pt);

    expect(cloned.id).toBe(mockUUID);
    expect(cloned.id).not.toBe(pt.id);
  });

  it('sets a new createdAt timestamp', () => {
    const pt = makePersistedTab();

    const cloned = clonePersistedChatTabForResume(pt);

    expect(cloned.createdAt).toBe('2025-06-15T12:00:00.000Z');
    expect(cloned.createdAt).not.toBe(pt.createdAt);
  });

  it('preserves all other fields by default', () => {
    const pt = makePersistedTab({
      title: 'My Chat',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'high',
      planMode: true,
      proposalMode: 'required',
      sdkSessionId: 'sess-1',
      claudeForkSessionOnNextSend: true,
      readOnly: true,
      staleSessionDetected: {
        droppedMessageText: 'dropped',
      },
      pendingPlanExit: { foo: 'bar' },
      pluginSelections: {
        collectionIds: ['plugin-a'],
        skillRefs: [],
        pluginRefs: [],
      },
    });

    const cloned = clonePersistedChatTabForResume(pt);

    expect(cloned.title).toBe('My Chat');
    expect(cloned.model).toBe('claude-sonnet-4-6');
    expect(cloned.thinkingLevel).toBe('high');
    expect(cloned.planMode).toBe(true);
    expect(cloned.proposalMode).toBe('required');
    expect(cloned.sdkSessionId).toBe('sess-1');
    expect(cloned.claudeForkSessionOnNextSend).toBe(true);
    expect(cloned.readOnly).toBe(true);
    expect(cloned.staleSessionDetected).toEqual({
      droppedMessageText: 'dropped',
    });
    expect(cloned.pendingPlanExit).toEqual({ foo: 'bar' });
    expect(cloned.pluginSelections).toEqual({
      collectionIds: ['plugin-a'],
      skillRefs: [],
      pluginRefs: [],
    });
    expect(cloned.messages).toHaveLength(1);
  });

  it('clearMessages removes the messages array', () => {
    const pt = makePersistedTab();

    const cloned = clonePersistedChatTabForResume(pt, {
      clearMessages: true,
    });

    expect(cloned.messages).toEqual([]);
  });

  it('clearSession removes provider continuity and recovery state', () => {
    const pt = makePersistedTab({
      sdkSessionId: 'sess-1',
      claudeForkSessionOnNextSend: true,
      staleSessionDetected: { droppedMessageText: 'dropped' },
      pendingPlanExit: { foo: 'bar' },
      readOnly: true,
    });

    const cloned = clonePersistedChatTabForResume(pt, {
      clearSession: true,
    });

    expect(cloned.sdkSessionId).toBeUndefined();
    expect(cloned.claudeForkSessionOnNextSend).toBeUndefined();
    expect(cloned.staleSessionDetected).toBeUndefined();
    expect(cloned.pendingPlanExit).toBeUndefined();
    expect(cloned.readOnly).toBeUndefined();
  });

  it('supports both clearMessages and clearSession together', () => {
    const pt = makePersistedTab({
      sdkSessionId: 'sess-1',
      staleSessionDetected: { droppedMessageText: 'dropped' },
      pendingPlanExit: { foo: 'bar' },
      readOnly: true,
    });

    const cloned = clonePersistedChatTabForResume(pt, {
      clearMessages: true,
      clearSession: true,
    });

    expect(cloned.messages).toEqual([]);
    expect(cloned.sdkSessionId).toBeUndefined();
    expect(cloned.staleSessionDetected).toBeUndefined();
    expect(cloned.pendingPlanExit).toBeUndefined();
    expect(cloned.readOnly).toBeUndefined();
    // Other fields still present
    expect(cloned.title).toBe('Test Tab');
  });
});

import type {
  CodexSpeed,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  initAiGatewayModels,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { createAgentArtifactDedupeKey } from '@canopy/desktop-shared/lib/agent-artifacts';
import { fromPersistedTab, toPersistedTab } from '../persisted-tabs';
import { createEmptyTab } from '../tab-utils';

// Seed the model registries WITHOUT any flag-gated entries so hydration runs
// against the same registry state as a cold desktop startup, where chat tabs
// hydrate before LaunchDarkly returns live flags.
beforeAll(() => {
  initClaudeModels([
    { id: 'opus[1m]', label: 'Opus 4.8 1M', contextWindow: 1_000_000 },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
    {
      id: 'native-with-gateway',
      label: 'Native with gateway',
      contextWindow: 200_000,
    },
  ]);
  initCodexModels([{ id: 'codex-mini-latest', label: 'Codex Mini' }]);
  initAiGatewayModels(
    [],
    [
      {
        modelId: 'native-with-gateway',
        gatewayId: 'anthropic/native-with-gateway',
        family: 'anthropic',
        recommendedHarness: 'claude',
        gatewayOnly: false,
        contextWindow: 100_000,
        supportsPromptCaching: true,
        supportedThinkingLevels: [],
        toolSchemaProfile: 'standard',
      },
    ],
  );
});

const makePersistedTab = (
  overrides: Partial<PersistedChatTab> = {},
): PersistedChatTab => ({
  id: 'tab-1',
  title: 'Test Tab',
  messages: [],
  createdAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('Claude Terminal watcher correlation persistence', () => {
  it('keeps the canonical accepted-turn anchor when hydrating completion evidence (CAN-4958)', () => {
    const persisted = makePersistedTab({
      lastAcceptedUserMessageId: 'finished',
      turnEnds: { finished: { outcome: 'completed', endedAt: 1000 } },
    });
    expect(fromPersistedTab(persisted).lastAcceptedUserMessageId).toBe(
      'finished',
    );
    expect(
      fromPersistedTab(makePersistedTab()).lastAcceptedUserMessageId,
    ).toBeUndefined();
  });
  it('retains main-owned terminal outcomes across hydration and compatibility projection', () => {
    const persisted = makePersistedTab({
      turnEnds: { finished: { outcome: 'failed', endedAt: 1000 } },
      unacceptedTurnEnds: { unaccepted: 'cancelled' },
    });
    const hydrated = fromPersistedTab(persisted);
    expect(hydrated.turnEnds).toEqual(persisted.turnEnds);
    expect(hydrated.unacceptedTurnEnds).toEqual(persisted.unacceptedTurnEnds);
    expect(toPersistedTab(hydrated).turnEnds).toEqual(persisted.turnEnds);
    expect(toPersistedTab(hydrated).unacceptedTurnEnds).toEqual(
      persisted.unacceptedTurnEnds,
    );
  });
  it('hydrates main-owned restart evidence so an interrupted turn never reads as completed (CAN-5178)', () => {
    const persisted = makePersistedTab({
      interruptedTurns: { cut: {}, resumed: { resumedBy: 'next' } },
    });
    expect(fromPersistedTab(persisted).interruptedTurns).toEqual(
      persisted.interruptedTurns,
    );
    expect(
      fromPersistedTab(makePersistedTab()).interruptedTurns,
    ).toBeUndefined();
  });
  it('round-trips outstanding watcher correlations across renderer hydration', () => {
    const persisted = makePersistedTab();
    const pending = [
      {
        text: 'Watcher prompt',
        submittedText:
          '<system_instruction>context</system_instruction>\n\nWatcher prompt',
        deliveryId: 'delivery-1',
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
    ];
    persisted.pendingClaudeTerminalWatcherMessages = pending;

    const hydrated = fromPersistedTab(persisted);

    expect(hydrated.pendingClaudeTerminalWatcherMessages).toEqual(pending);
    expect(
      toPersistedTab(hydrated).pendingClaudeTerminalWatcherMessages,
    ).toEqual(pending);
  });
});

describe('external agent attribution persistence', () => {
  it('round-trips agentSent through renderer hydration and persistence', () => {
    const agentSent = {
      kind: 'external_agent' as const,
      connectionId: '11111111-1111-4111-8111-111111111111',
      clientName: 'Cursor',
      verified: true,
      userId: '22222222-2222-4222-8222-222222222222',
    };
    const persisted = makePersistedTab({
      messages: [
        {
          id: 'agent-message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Sent from an agent' }],
          timestamp: 1000,
          agentSent,
        },
      ],
    });

    const hydrated = fromPersistedTab(persisted);

    expect(hydrated.messages[0]?.agentSent).toEqual(agentSent);
    expect(toPersistedTab(hydrated).messages[0]?.agentSent).toEqual(agentSent);
  });
});

describe('Claude chain uuid persistence', () => {
  it('round-trips claudeUuid so a fork can resolve its resume anchor', () => {
    // `toPersistedMessage` runs on the way IN from main as well as out, so
    // dropping this field would leave a forked tab with no chain entry to
    // resume at on the one send that needs it.
    const persisted = makePersistedTab({
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Answer' }],
          claudeUuid: '11111111-1111-4111-8111-111111111111',
        },
      ],
    });

    const hydrated = fromPersistedTab(persisted);
    expect(hydrated.messages[0]?.claudeUuid).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(toPersistedTab(hydrated).messages[0]?.claudeUuid).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });
});

describe('global instructions snapshot persistence', () => {
  it('round-trips the exact provider-session snapshot, including an empty block', () => {
    for (const globalInstructionsSnapshot of [
      '# User Overall Preferences\n\nOriginal snapshot.',
      '',
    ]) {
      const hydrated = fromPersistedTab(
        makePersistedTab({ globalInstructionsSnapshot }),
      );

      expect(hydrated.globalInstructionsSnapshot).toBe(
        globalInstructionsSnapshot,
      );
      expect(toPersistedTab(hydrated).globalInstructionsSnapshot).toBe(
        globalInstructionsSnapshot,
      );
    }
  });
});

describe('fromPersistedTab model hydration', () => {
  it('keeps a registered persisted model', () => {
    const tab = fromPersistedTab(
      makePersistedTab({ model: 'claude-sonnet-4-6' }),
    );

    expect(tab.model).toBe('claude-sonnet-4-6');
  });

  it('preserves a persisted model that is not yet in the registry instead of dropping it', () => {
    // A flag-gated model (registered only once LaunchDarkly returns live
    // flags) must survive hydration; dropping it to undefined here would
    // permanently rewrite the tab to the provider default on relaunch.
    const tab = fromPersistedTab(
      makePersistedTab({ model: 'fable[1m]', providerType: 'claude' }),
    );

    expect(tab.model).toBe('fable[1m]');
    expect(tab.providerType).toBe('claude');
  });

  it('drops and does not repersist a stale harness on an empty preallocated session', () => {
    const hydrated = fromPersistedTab(
      makePersistedTab({
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        sdkSessionId: 'preallocated-session',
        executionHarness: 'claude',
      }),
    );

    expect(hydrated.executionHarness).toBeUndefined();
    expect(
      toPersistedTab({ ...hydrated, executionHarness: 'claude' })
        .executionHarness,
    ).toBeUndefined();
  });

  it.each(['false', 1, {}])(
    'ignores a malformed explicit harness marker %p',
    (marker) => {
      const persisted = makePersistedTab({
        model: 'codex-mini-latest',
        executionHarness: 'claude',
      });
      Object.assign(persisted, { executionHarnessExplicitlyChosen: marker });
      const hydrated = fromPersistedTab(persisted);
      expect(hydrated.executionHarness).toBeUndefined();
      expect(
        toPersistedTab(hydrated).executionHarnessExplicitlyChosen,
      ).toBeUndefined();
    },
  );

  it('preserves an explicit empty-chat harness across a reload', () => {
    const hydrated = fromPersistedTab(
      makePersistedTab({
        model: 'codex-mini-latest',
        executionHarness: 'codex',
        ...{ executionHarnessExplicitlyChosen: true },
      }),
    );
    expect(hydrated.executionHarness).toBe('codex');
    expect(toPersistedTab(hydrated)).toMatchObject({
      executionHarness: 'codex',
      executionHarnessExplicitlyChosen: true,
    });
  });

  it('restores Codex model settings while retaining the Ollama provider identity', () => {
    const hydrated = fromPersistedTab(
      makePersistedTab({
        model: 'ollama-local',
        providerType: 'ollama',
        executionHarness: 'codex',
        executionHarnessExplicitlyChosen: true,
        modelConfig: { thinkingLevel: 'xhigh', fastMode: true },
      }),
    );
    expect(hydrated.providerType).toBe('ollama');
    expect(hydrated.modelConfig).toMatchObject({
      thinkingLevel: 'xhigh',
      fastMode: true,
    });
  });

  it('persists a captured harness while a user message is queued', () => {
    const hydrated = fromPersistedTab(
      makePersistedTab({
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
      }),
    );

    expect(
      toPersistedTab({
        ...hydrated,
        queuedMessages: [{ text: 'queued message' }],
        executionHarness: 'claude',
      }).executionHarness,
    ).toBe('claude');
  });
});

describe('Codex speed hydration and persistence', () => {
  const codexTab = (
    overrides: Partial<PersistedChatTab> = {},
  ): PersistedChatTab =>
    makePersistedTab({
      model: 'codex-mini-latest',
      providerType: 'codex',
      ...overrides,
    });
  const ULTRA_DEFAULT = {
    modelConfig: { speed: 'ultrafast' as const, fastMode: false },
  };

  const hydrationCases: Array<{
    label: string;
    overrides: Partial<PersistedChatTab>;
    speed: CodexSpeed;
    explicit: boolean;
  }> = [
    {
      label: 'an Ultra fast record',
      overrides: { modelConfig: { speed: 'ultrafast', fastMode: false } },
      speed: 'ultrafast',
      explicit: true,
    },
    {
      label: 'a Fast record',
      overrides: { modelConfig: { speed: 'fast', fastMode: true } },
      speed: 'fast',
      explicit: true,
    },
    {
      label: 'a Regular record',
      overrides: { modelConfig: { speed: 'standard', fastMode: false } },
      speed: 'standard',
      explicit: true,
    },
    {
      label: 'a legacy fastMode true record',
      overrides: { modelConfig: { fastMode: true } },
      speed: 'fast',
      explicit: true,
    },
    {
      label: 'a legacy fastMode false record',
      overrides: { modelConfig: { fastMode: false } },
      speed: 'standard',
      explicit: true,
    },
    {
      label: 'a legacy codexFastModeEnabled true alias',
      overrides: { codexFastModeEnabled: true },
      speed: 'fast',
      explicit: true,
    },
    {
      label: 'a legacy codexFastModeEnabled false alias',
      overrides: { codexFastModeEnabled: false },
      speed: 'standard',
      explicit: true,
    },
    {
      label: 'a tab without any recorded speed',
      overrides: {},
      speed: 'standard',
      explicit: false,
    },
  ];

  it.each(hydrationCases)(
    'hydrates $label speed-first',
    ({ overrides, speed, explicit }) => {
      const hydrated = fromPersistedTab(codexTab(overrides));

      expect(hydrated.modelConfig).toMatchObject({
        speed,
        fastMode: speed === 'fast',
      });
      expect(hydrated.fastModeExplicit).toBe(explicit);
      expect(hydrated.codexFastModeEnabled).toBe(speed === 'fast');
    },
  );

  it('never projects fastMode true for an Ultra fast record', () => {
    const hydrated = fromPersistedTab(
      codexTab({ modelConfig: { speed: 'ultrafast', fastMode: true } }),
    );

    expect(hydrated.modelConfig).toMatchObject({
      speed: 'ultrafast',
      fastMode: false,
    });
    expect(hydrated.codexFastModeEnabled).toBe(false);
  });

  it('ignores an invalid persisted speed and reads the legacy boolean', () => {
    const persisted = codexTab({ modelConfig: { fastMode: true } });
    Object.assign(persisted.modelConfig ?? {}, { speed: 'warp' });

    expect(fromPersistedTab(persisted).modelConfig).toMatchObject({
      speed: 'fast',
      fastMode: true,
    });
  });

  it('uses an Ultra fast default only when the tab records no speed', () => {
    const inherited = fromPersistedTab(codexTab(), ULTRA_DEFAULT);
    expect(inherited.modelConfig.speed).toBe('ultrafast');
    expect(inherited.fastModeExplicit).toBe(false);

    // An explicit legacy choice on the selected record beats a newer Ultra
    // fast default, whether it is the record's boolean or the tab alias.
    expect(
      fromPersistedTab(
        codexTab({ modelConfig: { fastMode: false } }),
        ULTRA_DEFAULT,
      ).modelConfig,
    ).toMatchObject({ speed: 'standard', fastMode: false });
    expect(
      fromPersistedTab(codexTab({ codexFastModeEnabled: true }), ULTRA_DEFAULT)
        .modelConfig,
    ).toMatchObject({ speed: 'fast', fastMode: true });
  });

  it('keeps non-Codex tabs on Regular without inventing a Codex alias', () => {
    const hydrated = fromPersistedTab(
      makePersistedTab({
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        modelConfig: { speed: 'ultrafast', fastMode: false },
      }),
    );

    expect(hydrated.modelConfig).toMatchObject({
      speed: 'standard',
      fastMode: false,
    });
    expect(hydrated.codexFastModeEnabled).toBeUndefined();
  });

  it.each<[CodexSpeed, boolean]>([
    ['ultrafast', false],
    ['fast', true],
    ['standard', false],
  ])(
    'persists an explicit %s choice with its derived boolean',
    (speed, fastMode) => {
      const hydrated = fromPersistedTab(
        codexTab({ modelConfig: { speed, fastMode } }),
      );

      expect(toPersistedTab(hydrated).modelConfig).toEqual({
        speed,
        fastMode,
      });
    },
  );

  it('re-derives the persisted boolean from the runtime speed', () => {
    const hydrated = fromPersistedTab(
      codexTab({ modelConfig: { speed: 'ultrafast', fastMode: false } }),
    );
    // A stale compatibility boolean on the runtime tab must never be written
    // back as `fastMode: true` beside Ultra fast.
    const persisted = toPersistedTab({
      ...hydrated,
      modelConfig: { ...hydrated.modelConfig, fastMode: true },
    });

    expect(persisted.modelConfig).toEqual({
      speed: 'ultrafast',
      fastMode: false,
    });
  });

  it('does not persist an inherited speed', () => {
    const hydrated = fromPersistedTab(codexTab(), ULTRA_DEFAULT);

    expect(toPersistedTab(hydrated).modelConfig).toBeUndefined();
  });

  it('mirrors the main-owned retained Codex speed through a compatibility round trip', () => {
    const hydrated = fromPersistedTab(
      makePersistedTab({
        model: 'claude-sonnet-4-6',
        providerType: 'claude',
        retainedCodexSpeed: 'ultrafast',
      }),
    );

    expect(hydrated.retainedCodexSpeed).toBe('ultrafast');
    expect(toPersistedTab(hydrated).retainedCodexSpeed).toBe('ultrafast');
  });

  it('drops an invalid retained Codex speed', () => {
    const persisted = makePersistedTab({
      model: 'claude-sonnet-4-6',
      providerType: 'claude',
    });
    Object.assign(persisted, { retainedCodexSpeed: 'warp' });

    const hydrated = fromPersistedTab(persisted);

    expect(hydrated.retainedCodexSpeed).toBeUndefined();
    expect(toPersistedTab(hydrated)).not.toHaveProperty('retainedCodexSpeed');
  });
});

describe('plugin selection hydration', () => {
  it('canonicalizes legacy bundleIds before the tab enters live state', () => {
    const hydrated = fromPersistedTab(
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

    expect(hydrated.pluginSelections).toEqual({
      collectionIds: ['legacy-collection'],
      skillRefs: [],
      pluginRefs: [
        { marketplaceId: 'marketplace', pluginName: 'legacy-plugin' },
      ],
      mcpServerRefs: [],
    });
    expect(toPersistedTab(hydrated).pluginSelections).toEqual(
      hydrated.pluginSelections,
    );
  });

  it('round-trips the inherited-defaults tombstones and layering version', () => {
    const disabledGlobalPluginSelections = {
      pluginRefs: [{ marketplaceId: 'marketplace', pluginName: 'default' }],
    };
    const hydrated = fromPersistedTab(
      makePersistedTab({
        disabledGlobalPluginSelections,
        inheritedPluginDefaultsVersion: 1,
      }),
    );

    expect(hydrated.inheritedPluginDefaultsVersion).toBe(1);
    const persisted = toPersistedTab(hydrated);
    expect(persisted.inheritedPluginDefaultsVersion).toBe(1);
    expect(persisted.disabledGlobalPluginSelections).toEqual(
      disabledGlobalPluginSelections,
    );
    expect(
      toPersistedTab(fromPersistedTab(makePersistedTab())),
    ).not.toHaveProperty('inheritedPluginDefaultsVersion');
  });
});

describe('AI Credits route outcome persistence', () => {
  const usage = {
    contextTokens: 10,
    contextWindow: 50_000,
    maxOutputTokens: 4_000,
    totalCostUsd: 0,
    inputTokens: 10,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    durationMs: 0,
    durationApiMs: 0,
    numTurns: 1,
    model: 'native-with-gateway',
  };

  it('restores a globally routed session from the authoritative outcome', () => {
    const hydrated = fromPersistedTab(
      makePersistedTab({
        model: 'native-with-gateway',
        aiCreditsRouted: true,
        usage,
      }),
    );

    expect(hydrated.aiCreditsRouting).toBeUndefined();
    expect(hydrated.aiCreditsRouted).toBe(true);
    expect(hydrated.usage?.contextWindow).toBe(100_000);
    expect(toPersistedTab(hydrated).aiCreditsRouted).toBe(true);
  });

  it('restores a native fallback even when AI Credits routing was requested', () => {
    const hydrated = fromPersistedTab(
      makePersistedTab({
        model: 'native-with-gateway',
        aiCreditsRouting: {
          active: true,
          scope: 'session',
          activatedAt: Date.parse('2026-08-04T12:00:00Z'),
        },
        aiCreditsRouted: false,
        usage,
      }),
    );

    expect(hydrated.aiCreditsRouting?.active).toBe(true);
    expect(hydrated.aiCreditsRouted).toBe(false);
    expect(hydrated.usage?.contextWindow).toBe(200_000);
    expect(toPersistedTab(hydrated).aiCreditsRouted).toBe(false);
  });
});

describe('organization memory persistence', () => {
  it('round-trips memory facts only for messages that still exist', () => {
    const persisted: PersistedChatTab = {
      ...makePersistedTab({
        messages: [
          {
            id: 'message-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'question' }],
            timestamp: 1,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'answer' }],
            timestamp: 2,
          },
        ],
      }),
      memoryByMessageId: {
        'message-1': {
          facts: [
            {
              factText: 'Use the shared organization convention.',
              validAt: null,
              sourceTurnIds: ['turn-1'],
            },
          ],
        },
        missing: {
          facts: [
            {
              factText: 'This entry no longer has a matching message.',
              validAt: null,
              sourceTurnIds: ['turn-2'],
            },
          ],
        },
        'assistant-1': {
          facts: [
            {
              factText: 'Memory metadata belongs only to user turns.',
              validAt: null,
              sourceTurnIds: ['turn-3'],
            },
          ],
        },
      },
    };

    const hydrated = fromPersistedTab(persisted);
    expect(
      hydrated.memoryByMessageId?.['message-1']?.facts[0]?.sourceTurnIds,
    ).toEqual(['turn-1']);
    expect(hydrated.memoryByMessageId?.missing).toBeUndefined();
    expect(hydrated.memoryByMessageId?.['assistant-1']).toBeUndefined();

    const roundTripped = toPersistedTab(hydrated);
    expect('memoryByMessageId' in roundTripped).toBe(true);
    if (!('memoryByMessageId' in roundTripped)) {
      throw new Error('Memory metadata was not persisted');
    }
    expect(roundTripped.memoryByMessageId).toEqual({
      'message-1': persisted.memoryByMessageId?.['message-1'],
    });
  });
});

describe('approval policy hydration', () => {
  it('drops malformed approval modes and rules while preserving valid rules', () => {
    const persisted = makePersistedTab({
      sessionApprovalRules: [
        {
          id: 'valid',
          behavior: 'deny',
          target: { kind: 'file-write', path: '/private/**' },
          createdAt: '2026-07-29T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });
    Object.assign(persisted, {
      approvalMode: 'unrestricted',
      sessionApprovalRules: [
        ...(persisted.sessionApprovalRules ?? []),
        { id: 'invalid', behavior: 'allow', target: {} },
      ],
    });

    const hydrated = fromPersistedTab(persisted);

    expect(hydrated.approvalMode).toBeUndefined();
    expect(hydrated.sessionApprovalRules).toEqual([
      expect.objectContaining({ id: 'valid', behavior: 'deny' }),
    ]);
  });
});

describe('agent artifact carry persistence', () => {
  const receipt = {
    version: 1 as const,
    kind: 'pipeline_run' as const,
    operation: 'pipeline.run',
    dedupeKey: createAgentArtifactDedupeKey(
      'pipeline_run',
      'worktree',
      'execution-1',
    ),
    createdAt: '2026-08-04T20:00:00.000Z',
    executionId: 'execution-1',
    pipelineId: 'pipeline-1',
    pipelineName: 'Build',
    initialStatus: 'pending' as const,
    queuedAt: '2026-08-04T20:00:00.000Z',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    navigationTarget: {
      kind: 'pipeline_execution' as const,
      executionId: 'execution-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    },
  };

  it('round-trips valid carry and ignores malformed, duplicate, and orphaned data', () => {
    const persisted = makePersistedTab({
      messages: [
        {
          id: 'message-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'run it' }],
          timestamp: 1,
        },
      ],
    });
    Object.defineProperty(persisted, 'agentArtifactCarryByTurn', {
      configurable: true,
      enumerable: true,
      value: {
        'message-1': [receipt, receipt, { ...receipt, version: 2 }],
        orphan: [{ ...receipt, executionId: 'execution-orphan' }],
      },
    });

    const hydrated = fromPersistedTab(persisted);
    expect(hydrated.agentArtifactCarryByTurn).toEqual({
      'message-1': [receipt],
    });
    expect(toPersistedTab(hydrated).agentArtifactCarryByTurn).toEqual({
      'message-1': [receipt],
    });
  });

  it('keeps old tabs without carry metadata unchanged', () => {
    const hydrated = fromPersistedTab(makePersistedTab());
    expect(hydrated.agentArtifactCarryByTurn).toBeUndefined();
    expect(toPersistedTab(hydrated).agentArtifactCarryByTurn).toBeUndefined();
  });
});

describe('CAN-1929 lane-aware default stamp persistence', () => {
  it('round-trips the pristine-gate fields so a reload cannot revert a manual pick', () => {
    const persisted = makePersistedTab({
      model: 'codex-mini-latest',
      providerType: 'codex',
      modelExplicitlyChosen: true,
      billingExplicitlyChosen: true,
      defaultStampModel: 'opus[1m]',
    });

    const hydrated = fromPersistedTab(persisted);
    expect(hydrated.modelExplicitlyChosen).toBe(true);
    expect(hydrated.billingExplicitlyChosen).toBe(true);
    expect(hydrated.defaultStampModel).toBe('opus[1m]');

    const rewritten = toPersistedTab(hydrated);
    expect(rewritten.modelExplicitlyChosen).toBe(true);
    expect(rewritten.billingExplicitlyChosen).toBe(true);
    expect(rewritten.defaultStampModel).toBe('opus[1m]');
  });

  it('leaves the fields absent for tabs persisted before CAN-1929', () => {
    const hydrated = fromPersistedTab(makePersistedTab({ model: 'opus[1m]' }));
    expect(hydrated.modelExplicitlyChosen).toBeUndefined();
    expect(hydrated.billingExplicitlyChosen).toBeUndefined();
    expect(hydrated.defaultStampModel).toBeUndefined();
    expect(toPersistedTab(hydrated).defaultStampModel).toBeUndefined();
  });

  it('carries an ABSENT stamp across a rebuild (round-2 finding 4)', () => {
    // `stale-session.ts` rebuilds a tab with `defaultStampModel:
    // sourceTab.defaultStampModel`. With a destructuring default of `model`,
    // an absent stamp silently became "ours" on the replacement tab, so the
    // next lane re-stamp could overwrite a legacy manual pick.
    const rebuilt = createEmptyTab({
      model: 'opus[1m]',
      defaultStampModel: undefined,
    });
    expect(rebuilt.model).toBe('opus[1m]');
    expect(rebuilt.defaultStampModel).toBeUndefined();

    // A genuine seed path still stamps.
    expect(
      createEmptyTab({
        model: 'opus[1m]',
        defaultStampModel: 'opus[1m]',
      }).defaultStampModel,
    ).toBe('opus[1m]');
  });
});

describe('paged transcript hydration', () => {
  it('preserves continuation provenance across reload and compatibility serialization', () => {
    const persisted = makePersistedTab({
      messages: [
        {
          id: 'resume',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Continue' }],
          userMessageSource: 'immediate_turn_restart',
        },
      ],
    });
    expect(toPersistedTab(fromPersistedTab(persisted)).messages).toEqual(
      persisted.messages,
    );
  });
  it('preserves validated agent attribution and agent source across reload', () => {
    const agentSent: NonNullable<
      PersistedChatTab['messages'][number]['agentSent']
    > = {
      sender: {
        kind: 'project',
        projectType: 'code',
        projectId: 'sender-project',
        taskId: 'sender-task',
        chatId: 'sender-chat',
      },
      chatTitle: 'Sender chat',
      projectLabel: 'Sender project',
    };
    const persisted = makePersistedTab({
      messages: [
        {
          id: 'agent-message',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Continue' }],
          userMessageSource: 'agent',
          agentSent,
        },
      ],
    });

    const hydrated = fromPersistedTab(persisted);

    expect(hydrated.messages[0]).toMatchObject({
      userMessageSource: 'agent',
      agentSent,
    });
    expect(toPersistedTab(hydrated).messages).toEqual(persisted.messages);
  });
  it('omits malformed agent attribution without dropping agent source', () => {
    const persisted = makePersistedTab({
      messages: [
        {
          id: 'agent-message',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Continue' }],
          userMessageSource: 'agent',
          agentSent: {
            sender: {
              kind: 'project',
              projectType: 'code',
              projectId: 'sender-project',
              taskId: 'sender-task',
              chatId: 'sender-chat',
            },
            chatTitle: 'Sender chat',
            projectLabel: 'Sender project',
          },
        },
      ],
    });
    const message = persisted.messages[0];
    if (!message) throw new Error('Expected a persisted user message');
    expect(
      Reflect.set(message, 'agentSent', {
        sender: {
          kind: 'project',
          projectType: 'invalid',
          projectId: 'sender-project',
          taskId: 'sender-task',
          chatId: 'sender-chat',
        },
        chatTitle: 'Sender chat',
        projectLabel: 'Sender project',
      }),
    ).toBe(true);

    const hydrated = fromPersistedTab(persisted);

    expect(hydrated.messages[0]?.userMessageSource).toBe('agent');
    expect(hydrated.messages[0]).not.toHaveProperty('agentSent');
  });
  it('retains metadata belonging to user messages outside the loaded page', () => {
    const persisted = makePersistedTab({
      transcriptLoaded: false,
      transcript: {
        format: 'complete-message-jsonl-v1',
        committedMessageCount: 600,
        committedByteLength: 90000,
        transcriptRevision: 4,
        hasActiveSidecar: false,
      },
      memoryByMessageId: {
        'old-human': {
          facts: [{ factText: 'Keep me', validAt: null, sourceTurnIds: [] }],
        },
      },
    });
    const hydrated = fromPersistedTab(persisted);
    expect(hydrated.transcriptLoaded).toBe(false);
    expect(hydrated.transcript).toEqual(persisted.transcript);
    expect(hydrated.memoryByMessageId).toEqual(persisted.memoryByMessageId);
    expect(toPersistedTab(hydrated).memoryByMessageId).toEqual(
      persisted.memoryByMessageId,
    );
  });
});

describe('custom chat title persistence', () => {
  it('round-trips a custom title next to the generated description', () => {
    const tab = fromPersistedTab(
      makePersistedTab({ customTitle: 'Mine', description: 'Generated' }),
    );
    expect(tab.customTitle).toBe('Mine');
    const persisted = toPersistedTab(tab);
    expect(persisted.customTitle).toBe('Mine');
    expect(persisted.description).toBe('Generated');
  });

  it('keeps records without a custom title valid', () => {
    const tab = fromPersistedTab(makePersistedTab());
    expect('customTitle' in tab).toBe(false);
    expect('customTitle' in toPersistedTab(tab)).toBe(false);
  });

  it('round-trips the automatic title lifecycle so snapshots keep eligibility', () => {
    for (const automaticTitleState of ['pending', 'closed'] as const) {
      const tab = fromPersistedTab(makePersistedTab({ automaticTitleState }));
      expect(tab.automaticTitleState).toBe(automaticTitleState);
      expect(toPersistedTab(tab).automaticTitleState).toBe(automaticTitleState);
    }
    const legacy = fromPersistedTab(makePersistedTab());
    expect('automaticTitleState' in legacy).toBe(false);
    expect('automaticTitleState' in toPersistedTab(legacy)).toBe(false);
  });
});

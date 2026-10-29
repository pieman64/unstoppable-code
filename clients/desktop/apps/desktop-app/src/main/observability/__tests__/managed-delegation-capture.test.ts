import type {
  AgentDelegationSnapshot,
  AgentDelegationTranscript,
  AgentDelegationUsage,
  PersistedAgentRouteSnapshot,
} from '@canopy/protocol/delegation';
import type { AgentAuditEntry } from '@canopy/desktop-shared/types/observability';
import type { OpenAiPricingResponseV1 } from '@canopy/protocol/openai-pricing';
import {
  ManagedDelegationCapture,
  type ManagedDelegationAuditScope,
} from '../managed-delegation-capture';
import type { OpenAiPricingCacheState } from '../../openai-pricing/pricing-client';

const route: PersistedAgentRouteSnapshot = {
  selectedModelId: 'codex-route',
  selectedModelLabel: 'Configured delegate',
  runtimeModelLabel: 'Codex model',
  runtimeModelId: 'gpt-6.1-sol',
  harnessId: 'codex',
  runtimeKind: 'codex-app-server',
  runnerRegistrationId: 'local-delegation-codex-v1',
  runtimeVersion: '1',
  adapterVersion: '1',
  modelSource: 'codex-managed',
  providerType: 'codex',
  assignmentRevision: 'revision-1',
  billingAuthority: 'ai-credits',
  aiCreditsRouted: true,
  capabilities: [],
  supportedThinkingLevels: ['low', 'medium', 'high'],
  capabilitySnapshotHash: 'capability-hash',
  capabilityGeneration: 1,
  policyRevision: 'policy-1',
};

const scope: ManagedDelegationAuditScope = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
  userMessageId: 'parent-turn-1',
  parentPipelineExecutionId: 'child-pipeline-1',
  rootPipelineExecutionId: 'root-pipeline-1',
};

const codexPricingPayload: OpenAiPricingResponseV1 = {
  version: 1,
  currency: 'usd',
  tokenUnit: 'per_1m_tokens',
  source: {
    pricingUrl: 'https://developers.openai.com/api/docs/pricing',
    codexPricingUrl: 'https://developers.openai.com/codex/pricing',
    codexSpeedUrl: 'https://developers.openai.com/codex/speed',
    fetchedAt: '2026-06-18T00:00:00.000Z',
    generatedBy: 'test',
  },
  cache: { maxAgeSeconds: 3600, staleWhileRevalidateSeconds: 86400 },
  basis: {
    tokenPricing: 'openai_api_standard',
    fastModePricing: 'codex_credit_adjusted_standard_equivalent',
    notes: ['test pricing'],
  },
  serviceTierAliases: { default: 'standard', priority: 'fast' },
  models: {
    'gpt-6.1-sol': {
      model: 'gpt-6.1-sol',
      displayName: 'GPT-6.1 Sol',
      standard: { input: 10, cachedInput: 1, output: 40 },
      codexFast: {
        supported: true,
        standardCostMultiplier: 2.5,
        appliesTo: ['tokens'],
      },
    },
  },
  unpricedModels: {},
  billableTools: {},
};

function pricingState(includePayload = true): OpenAiPricingCacheState {
  return {
    ...(includePayload ? { payload: codexPricingPayload } : {}),
    fetchedAt: '2026-06-18T00:00:00.000Z',
    loadedFrom: includePayload ? 'memory' : 'none',
    stale: false,
  };
}

type ManagedDelegationCaptureWithPricing = ConstructorParameters<
  typeof ManagedDelegationCapture
>[0] & { codexPricing: () => OpenAiPricingCacheState };

function captureWithPricing(
  onUpsert: (entry: AgentAuditEntry) => void,
  state: OpenAiPricingCacheState = pricingState(),
): ManagedDelegationCapture {
  const options: ManagedDelegationCaptureWithPricing = {
    onUpsert,
    codexPricing: () => state,
  };
  return new ManagedDelegationCapture(options);
}

function createTranscript(
  options: {
    delegationId?: string;
    runGeneration?: number;
    sequence?: number;
    status?: AgentDelegationSnapshot['status'];
    usage?: AgentDelegationUsage;
    routeSnapshot?: PersistedAgentRouteSnapshot;
    parentTurnId?: string;
    createdAt?: number;
    task?: { description: string; prompt: string; fastMode?: boolean };
    /** When each transcript item occurred. */
    itemTimes?: readonly number[];
  } = {},
): AgentDelegationTranscript {
  const delegationId = options.delegationId ?? 'delegation-1';
  const snapshot: AgentDelegationSnapshot = {
    delegationId,
    status: options.status ?? 'running',
    outputTruncated: false,
    ...(options.routeSnapshot === undefined
      ? { routeSnapshot: route }
      : { routeSnapshot: options.routeSnapshot }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  };
  return {
    delegationId,
    runGeneration: options.runGeneration ?? 1,
    sequence: options.sequence ?? 1,
    parentHarnessId: 'claude',
    parentTurnId: options.parentTurnId ?? 'parent-turn-1',
    parentToolCallId: 'tool-call-1',
    createdAt: options.createdAt ?? Date.parse('2026-10-01T23:59:59.000Z'),
    task: {
      description: options.task?.description ?? 'private task description',
      prompt: options.task?.prompt ?? 'private task prompt',
      executionMode: 'foreground',
      ...(options.task?.fastMode === undefined
        ? {}
        : { fastMode: options.task.fastMode }),
    },
    snapshot,
    transcript: (options.itemTimes ?? []).map((occurredAt, index) => ({
      id: `item-${String(index)}`,
      sequence: index,
      occurredAt,
      type: 'text' as const,
      text: 'private delegate text',
    })),
  };
}

describe('ManagedDelegationCapture', () => {
  let entries: AgentAuditEntry[];
  let capture: ManagedDelegationCapture;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
    entries = [];
    capture = new ManagedDelegationCapture({
      onUpsert: (entry): void => {
        entries.push(entry);
      },
      codexPricing: (): OpenAiPricingCacheState => pricingState(false),
    });
  });

  afterEach(() => {
    capture.dispose();
    jest.useRealTimers();
  });

  it('captures content-free cumulative usage, route, scope, and parent lineage', () => {
    capture.observe(
      scope,
      createTranscript({
        task: {
          description: 'Review package ownership',
          prompt: 'private task prompt',
        },
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cachedInputTokens: 40,
          cacheCreationInputTokens: 5,
          costUsd: 0.42,
        },
      }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'managed_delegation:delegation-1:1',
      eventType: 'managed_delegation',
      status: 'running',
      provider: 'codex',
      model: 'gpt-6.1-sol',
      modelSource: 'codex-managed',
      executionHarness: 'codex',
      billingBasis: 'ai_credits',
      aiCreditsRouted: true,
      totalCostUsd: 0.42,
      startedAt: '2026-10-01T23:59:59.000Z',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      rootPipelineExecutionId: 'root-pipeline-1',
      delegation: {
        delegationId: 'delegation-1',
        runGeneration: 1,
        parentChatId: 'chat-1',
        parentUserMessageId: 'parent-turn-1',
        parentPipelineExecutionId: 'child-pipeline-1',
        harness: 'codex',
        label: 'Review package ownership',
      },
      tokens: {
        input: 120,
        output: 30,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 5,
      },
    });
    expect(JSON.stringify(entries[0])).not.toContain('private task prompt');
  });

  it.each([
    ['native without an account response', 'native', false, 'unknown'],
    ['user credential', 'user-credential', false, 'api_key'],
    ['AI Credits', 'ai-credits', true, 'ai_credits'],
    ['account proxy', 'account-proxy', false, 'account_proxy'],
    [
      'organization gateway with AI Credits',
      'org_gateway',
      true,
      'org_gateway',
    ],
    ['local provider', 'unknown', false, 'local'],
    ['unknown authority', 'unknown', false, 'unknown'],
  ])(
    'classifies %s billing authority',
    (_name, billingAuthority, aiCreditsRouted, expected) => {
      const billingRoute: PersistedAgentRouteSnapshot = {
        ...route,
        billingAuthority,
        aiCreditsRouted,
        ...(expected === 'local'
          ? {
              providerType: 'ollama',
              harnessId: 'ollama',
              modelSource: 'ollama',
            }
          : {}),
      };
      capture.observe(scope, createTranscript({ routeSnapshot: billingRoute }));

      expect(entries[0]?.billingBasis).toBe(expected);
    },
  );

  it('prices Codex managed delegation token usage from supplied pricing', () => {
    const pricingCapture = captureWithPricing((entry): void => {
      entries.push(entry);
    });
    pricingCapture.observe(
      scope,
      createTranscript({ usage: { inputTokens: 1000, outputTokens: 500 } }),
    );

    expect(entries[0]?.observedCost?.status).toBe('priced');
    expect(entries[0]?.totalCostUsd).toBeGreaterThan(0);
    pricingCapture.dispose();
  });

  it('records unpriced Codex usage when the pricing payload is missing', () => {
    const pricingCapture = captureWithPricing((entry): void => {
      entries.push(entry);
    }, pricingState(false));
    pricingCapture.observe(
      scope,
      createTranscript({ usage: { inputTokens: 1000, outputTokens: 500 } }),
    );

    expect(entries[0]?.observedCost).toMatchObject({ status: 'unpriced' });
    expect(entries[0]).not.toHaveProperty('totalCostUsd');
    pricingCapture.dispose();
  });

  it.each([
    [
      'organization gateway',
      { ...route, billingAuthority: 'org_gateway', aiCreditsRouted: false },
    ],
    [
      'local',
      {
        ...route,
        harnessId: 'ollama',
        modelSource: 'ollama',
        providerType: 'ollama',
        billingAuthority: 'unknown',
        aiCreditsRouted: false,
      },
    ],
  ])(
    'does not estimate a Codex delegation on %s routes',
    (_name, billingRoute) => {
      const pricingCapture = captureWithPricing((entry): void => {
        entries.push(entry);
      });
      pricingCapture.observe(
        scope,
        createTranscript({
          routeSnapshot: billingRoute,
          usage: { inputTokens: 1000, outputTokens: 500 },
        }),
      );

      expect(entries[0]?.observedCost).toBeUndefined();
      expect(entries[0]?.totalCostUsd).toBeUndefined();
      pricingCapture.dispose();
    },
  );

  it('prices Codex fast mode with the fast tier and multiplier', () => {
    const usage = { inputTokens: 1000, outputTokens: 500 };
    const regularCapture = captureWithPricing((entry): void => {
      entries.push(entry);
    });
    regularCapture.observe(scope, createTranscript({ usage }));
    const regularCost = entries[0]?.totalCostUsd;
    regularCapture.dispose();

    entries = [];
    const fastCapture = captureWithPricing((entry): void => {
      entries.push(entry);
    });
    fastCapture.observe(
      scope,
      createTranscript({
        usage,
        task: { description: 'fast', prompt: 'private', fastMode: true },
      }),
    );

    expect(entries[0]?.serviceTier).toBe('priority');
    expect(entries[0]?.observedCost?.serviceTier).toBe('priority');
    expect(entries[0]?.totalCostUsd).toBeGreaterThan(regularCost ?? 0);
    fastCapture.dispose();
  });

  it('keeps a reported Codex cost instead of replacing it with a price estimate', () => {
    const pricingCapture = captureWithPricing((entry): void => {
      entries.push(entry);
    });
    pricingCapture.observe(
      scope,
      createTranscript({
        usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.42 },
      }),
    );

    expect(entries[0]?.totalCostUsd).toBe(0.42);
    expect(entries[0]?.observedCost).toBeUndefined();
    pricingCapture.dispose();
  });

  it('does not assume an unanswered native account kind is a subscription', () => {
    const nativeRoute: PersistedAgentRouteSnapshot = {
      ...route,
      billingAuthority: 'native',
      aiCreditsRouted: false,
    };
    const noAccountKindCapture = new ManagedDelegationCapture({
      onUpsert: (entry): void => {
        entries.push(entry);
      },
      nativeAccountKind: (): undefined => undefined,
      codexPricing: (): OpenAiPricingCacheState => pricingState(false),
    });
    noAccountKindCapture.observe(
      scope,
      createTranscript({ routeSnapshot: nativeRoute }),
    );
    noAccountKindCapture.dispose();

    expect(entries[0]?.billingBasis).toBe('unknown');
  });

  it.each([
    ['a subscription account', 'subscription', 'subscription'],
    ['an API key account', 'api_key', 'api_key'],
    ['a Bedrock account', 'bedrock', 'api_key'],
    ['an account kind not known yet', 'unknown', 'unknown'],
  ] as const)(
    'bills a native route to %s from the provider account, not the route',
    (_name, accountKind, expected) => {
      const nativeAccountKind = jest.fn(() => accountKind);
      const accountCapture = new ManagedDelegationCapture({
        onUpsert: (entry): void => {
          entries.push(entry);
        },
        nativeAccountKind,
        codexPricing: (): OpenAiPricingCacheState => pricingState(false),
      });
      const nativeRoute: PersistedAgentRouteSnapshot = {
        ...route,
        billingAuthority: 'native',
        aiCreditsRouted: false,
      };
      accountCapture.observe(
        scope,
        createTranscript({ routeSnapshot: nativeRoute }),
      );
      accountCapture.dispose();

      expect(nativeAccountKind).toHaveBeenCalledWith('codex');
      expect(entries[0]?.billingBasis).toBe(expected);
    },
  );

  it("stores a Cursor run's input without the cache tokens Cursor counts inside it", () => {
    // Cursor's input count includes cache reads and writes; the audit's
    // counters are additive, as the main Cursor chat path stores them.
    const cursorRoute: PersistedAgentRouteSnapshot = {
      ...route,
      selectedModelId: 'cursor-route',
      runtimeModelId: 'composer-2',
      harnessId: 'cursor',
      runtimeKind: 'cursor-acp',
      modelSource: 'cursor-managed',
      providerType: 'cursor',
      billingAuthority: 'native',
      aiCreditsRouted: false,
    };
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 30,
      cacheCreationInputTokens: 10,
    };
    capture.observe(
      scope,
      createTranscript({ routeSnapshot: cursorRoute, usage }),
    );
    capture.observe(
      scope,
      createTranscript({
        delegationId: 'claude-delegation',
        routeSnapshot: {
          ...route,
          harnessId: 'claude',
          providerType: 'claude',
          modelSource: 'claude-managed',
        },
        usage,
      }),
    );

    const cursorTokens = entries.find(
      (entry) => entry.id === 'managed_delegation:delegation-1:1',
    )?.tokens;
    expect(cursorTokens).toEqual({
      input: 60,
      output: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 10,
    });
    // Claude's input excludes its cache counters, so it is stored as reported.
    expect(
      entries.find(
        (entry) => entry.id === 'managed_delegation:claude-delegation:1',
      )?.tokens,
    ).toEqual({
      input: 100,
      output: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 10,
    });
  });

  it('never stores a negative Cursor input when the cache counters exceed it', () => {
    capture.observe(
      scope,
      createTranscript({
        routeSnapshot: {
          ...route,
          harnessId: 'cursor',
          modelSource: 'cursor-managed',
          providerType: 'cursor',
        },
        usage: {
          inputTokens: 10,
          outputTokens: 1,
          cachedInputTokens: 30,
          cacheCreationInputTokens: 0,
        },
      }),
    );

    expect(entries[0]?.tokens.input).toBe(0);
  });

  it('coalesces cumulative progress for 30 seconds and flushes a settled snapshot', () => {
    capture.observe(
      scope,
      createTranscript({
        usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
      }),
    );
    capture.observe(
      scope,
      createTranscript({
        sequence: 2,
        usage: { inputTokens: 20, outputTokens: 4, costUsd: 0.02 },
      }),
    );

    expect(entries).toHaveLength(1);
    jest.advanceTimersByTime(29_999);
    expect(entries).toHaveLength(1);
    jest.advanceTimersByTime(1);

    expect(entries).toHaveLength(2);
    expect(entries[1]?.tokens).toMatchObject({ input: 20, output: 4 });
    expect(entries[1]?.totalCostUsd).toBe(0.02);

    jest.advanceTimersByTime(5_000);
    capture.observe(
      scope,
      createTranscript({
        sequence: 3,
        status: 'completed',
        usage: { inputTokens: 25, outputTokens: 6, costUsd: 0.03 },
      }),
    );

    expect(entries).toHaveLength(3);
    expect(entries[2]).toMatchObject({
      id: 'managed_delegation:delegation-1:1',
      status: 'success',
      completedAt: '2026-10-08T12:00:35.000Z',
      durationMs: 561_636_000,
      tokens: { input: 25, output: 6 },
      totalCostUsd: 0.03,
    });
    jest.advanceTimersByTime(60_000);
    expect(entries).toHaveLength(3);
  });

  it('keeps a resumed run generation distinct and ignores duplicate snapshots', () => {
    const firstRun = createTranscript({
      sequence: 2,
      status: 'completed',
      usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.01 },
    });
    capture.observe(scope, createTranscript({ sequence: 1 }));
    capture.observe(scope, firstRun);
    capture.observe(scope, firstRun);
    capture.observe(
      scope,
      createTranscript({
        runGeneration: 2,
        sequence: 1,
        createdAt: Date.parse('2026-10-08T11:59:00.000Z'),
        usage: { inputTokens: 50, outputTokens: 5, costUsd: 0.05 },
      }),
    );

    expect(entries).toHaveLength(3);
    expect(entries[0]?.id).toBe('managed_delegation:delegation-1:1');
    expect(entries[1]).toMatchObject({
      id: 'managed_delegation:delegation-1:1',
      status: 'success',
    });
    expect(entries[2]).toMatchObject({
      id: 'managed_delegation:delegation-1:2',
      status: 'running',
      startedAt: '2026-10-08T11:59:00.000Z',
      delegation: { runGeneration: 2 },
    });
  });

  it('does not let an audit sink failure escape and retries the latest snapshot', () => {
    const persisted: AgentAuditEntry[] = [];
    let failuresRemaining = 2;
    const retryingCapture = new ManagedDelegationCapture({
      onUpsert: (entry): void => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error('audit sink unavailable');
        }
        persisted.push(entry);
      },
      codexPricing: (): OpenAiPricingCacheState => pricingState(false),
    });

    expect(() =>
      retryingCapture.observe(
        scope,
        createTranscript({ usage: { inputTokens: 10, outputTokens: 2 } }),
      ),
    ).not.toThrow();
    expect(() =>
      retryingCapture.observe(
        scope,
        createTranscript({
          sequence: 2,
          usage: { inputTokens: 20, outputTokens: 4 },
        }),
      ),
    ).not.toThrow();
    expect(persisted).toHaveLength(0);

    expect(() => jest.advanceTimersByTime(30_000)).not.toThrow();
    expect(persisted).toHaveLength(0);
    expect(() => jest.advanceTimersByTime(30_000)).not.toThrow();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.tokens).toMatchObject({ input: 20, output: 4 });
    retryingCapture.dispose();
  });

  it('retains failed terminal upserts through completed-run pruning', () => {
    const pendingId = 'managed_delegation:pending-terminal:1';
    const persistedIds: string[] = [];
    let failPendingOnce = true;
    const retainingCapture = new ManagedDelegationCapture({
      onUpsert: (entry): void => {
        if (entry.id === pendingId && failPendingOnce) {
          failPendingOnce = false;
          throw new Error('audit sink unavailable');
        }
        persistedIds.push(entry.id);
      },
      codexPricing: (): OpenAiPricingCacheState => pricingState(false),
    });

    // Runs of this process whose first published snapshot is the settled one.
    const createdAt = Date.now();
    retainingCapture.observe(
      scope,
      createTranscript({
        delegationId: 'pending-terminal',
        status: 'completed',
        createdAt,
      }),
    );
    for (let index = 0; index < 257; index += 1) {
      retainingCapture.observe(
        scope,
        createTranscript({
          delegationId: `completed-${index}`,
          status: 'completed',
          createdAt,
        }),
      );
    }

    retainingCapture.dispose();

    expect(persistedIds).toContain(pendingId);
    expect(jest.getTimerCount()).toBe(0);
  });

  describe('a run first seen already finished', () => {
    const START = Date.parse('2026-10-01T23:59:59.000Z');
    const LAST_ITEM = START + 60_000;
    const completed = (): AgentDelegationTranscript =>
      createTranscript({
        sequence: 3,
        status: 'completed',
        usage: { inputTokens: 25, outputTokens: 6, costUsd: 0.03 },
        itemTimes: [START + 1_000, LAST_ITEM],
      });

    function restartedCapture(recorded: readonly AgentAuditEntry[]): {
      readonly restarted: ManagedDelegationCapture;
      readonly upserts: AgentAuditEntry[];
    } {
      const upserts: AgentAuditEntry[] = [];
      const restarted = new ManagedDelegationCapture({
        onUpsert: (entry): void => {
          upserts.push(entry);
        },
        recordedEntry: (id): AgentAuditEntry | undefined =>
          recorded.find((entry) => entry.id === id),
      });
      return { restarted, upserts };
    }

    it('keeps the recorded completion when a restarted app replays the transcript', () => {
      // The process that ran the delegate saw it finish after one minute.
      jest.setSystemTime(new Date(START));
      capture.observe(scope, createTranscript({ sequence: 1 }));
      jest.setSystemTime(new Date(LAST_ITEM));
      capture.observe(scope, completed());
      const recorded = entries[entries.length - 1];
      expect(recorded).toMatchObject({
        status: 'success',
        completedAt: '2026-10-02T00:00:59.000Z',
        durationMs: 60_000,
      });

      // A week later a new process replays the retained transcript.
      jest.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
      const { restarted, upserts } = restartedCapture(
        recorded === undefined ? [] : [recorded],
      );
      restarted.observe(scope, completed());
      restarted.observe(scope, completed());
      restarted.dispose();

      expect(upserts).toEqual([]);
    });

    it('records nothing for a run an earlier process finished and the recent audit no longer lists', () => {
      const { restarted, upserts } = restartedCapture([]);
      restarted.observe(scope, completed());
      restarted.dispose();

      expect(upserts).toEqual([]);
    });

    it('settles a run the audit still lists as running, at its last item and not at the clock', () => {
      jest.setSystemTime(new Date(START));
      capture.observe(
        scope,
        createTranscript({
          sequence: 1,
          usage: { inputTokens: 20, outputTokens: 4, costUsd: 0.02 },
        }),
      );
      const running = entries[entries.length - 1];
      expect(running?.status).toBe('running');

      jest.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
      const { restarted, upserts } = restartedCapture(
        running === undefined ? [] : [running],
      );
      restarted.observe(
        scope,
        createTranscript({
          sequence: 2,
          status: 'interrupted',
          itemTimes: [START + 1_000, LAST_ITEM],
        }),
      );
      restarted.dispose();

      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({
        id: 'managed_delegation:delegation-1:1',
        status: 'interrupted',
        startedAt: '2026-10-01T23:59:59.000Z',
        completedAt: '2026-10-02T00:00:59.000Z',
        durationMs: 60_000,
        // The recovered snapshot reports no usage; the recorded usage stays.
        tokens: { input: 20, output: 4 },
        totalCostUsd: 0.02,
        billingBasis: 'ai_credits',
      });
    });

    it('records a run of this process whose first published snapshot is the settled one', () => {
      const createdAt = Date.now() + 1_000;
      jest.setSystemTime(new Date(createdAt + 90_000));
      capture.observe(
        scope,
        createTranscript({
          delegationId: 'fast-run',
          status: 'completed',
          createdAt,
          usage: { inputTokens: 25, outputTokens: 6, costUsd: 0.03 },
          itemTimes: [createdAt + 500, createdAt + 2_000],
        }),
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: 'managed_delegation:fast-run:1',
        status: 'success',
        durationMs: 2_000,
        totalCostUsd: 0.03,
      });
    });
  });
});

import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  CURSOR_APPROVAL_CHECK_PROJECT_ID,
  DEFAULT_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type AgentAuditModelUsage,
  type AgentAuditEntry,
} from '@canopy/desktop-shared/types';
import { COST_BILLING_BASES } from '@canopy/protocol/cost-view';
import { normalizeAuditEntry } from '@canopy/core-runtime/observability';
import { classifyAuditEntry } from '../classifier';
import { classifyAuditEntry as classifyFromReadModel } from '../read-model';

const EMPTY_TOOL_COUNTS: AgentAuditEntry['toolCounts'] = {
  thinking: 0,
  bash: 0,
  read: 0,
  readLines: 0,
  writeEdit: 0,
  plan: 0,
  fileEdit: 0,
  fileAdd: 0,
  fileDelete: 0,
  search: 0,
  grep: 0,
  web: 0,
  agent: 0,
  workflow: 0,
  tasks: 0,
  taskStop: 0,
  skills: 0,
  monitor: 0,
  claude: 0,
  scheduleWakeup: 0,
  askUser: 0,
  scriptOutput: 0,
  watcher: 0,
  canopy: 0,
  graph: 0,
  appAdvisor: 0,
  pipelineEditor: 0,
  mcp: 0,
  other: 0,
};

function auditEntry(overrides: Partial<AgentAuditEntry> = {}): AgentAuditEntry {
  return {
    id: 'turn-1',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'PRIVATE transcript label',
    startedAt: '2026-10-08T10:00:00.000Z',
    tokens: {
      input: 120,
      output: 30,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      reasoningOutputTokens: 4,
    },
    messageCount: 2,
    assistantMessageCount: 1,
    toolUseCount: 0,
    subAgentCount: 0,
    toolCounts: EMPTY_TOOL_COUNTS,
    hasTranscript: true,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    ...overrides,
  };
}

function modelUsageRow(
  model: string,
  costUsd: number,
  overrides: Partial<AgentAuditModelUsage> = {},
): AgentAuditModelUsage {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd,
    ...overrides,
  };
}

describe('classifyAuditEntry', () => {
  it('keeps the dollars of work the account proxy served', () => {
    const result = classifyAuditEntry(
      auditEntry({ billingBasis: 'account_proxy', totalCostUsd: 0.42 }),
    );
    expect(result).toMatchObject({
      billingBasis: 'account_proxy',
      costUsd: 0.42,
      costStatus: 'reported',
    });
  });

  it('is also exported from the read-model entry point used by the store', () => {
    expect(classifyFromReadModel(auditEntry())).toEqual(
      classifyAuditEntry(auditEntry()),
    );
  });

  it.each(COST_BILLING_BASES)(
    'preserves the explicit %s billing basis ahead of routing fallbacks',
    (billingBasis) => {
      const result = classifyAuditEntry(
        auditEntry({
          billingBasis,
          modelGatewayRouted: true,
          aiCreditsRouted: true,
          provider: 'ollama',
          providerAccountKey: 'account-secret',
        }),
      );

      expect(result?.billingBasis).toBe(billingBasis);
    },
  );

  it.each([
    [
      'organization gateway wins first',
      {
        modelGatewayRouted: true,
        aiCreditsRouted: true,
        provider: 'ollama',
        providerAccountKey: 'account',
      },
      'org_gateway',
    ],
    [
      'AI Credits wins over provider/account fallbacks',
      {
        aiCreditsRouted: true,
        provider: 'ollama',
        providerAccountKey: 'account',
      },
      'ai_credits',
    ],
    [
      'Ollama is local before account fallback',
      { provider: 'ollama' },
      'local',
    ],
    [
      'a non-empty provider account means subscription',
      { providerAccountKey: 'account' },
      'subscription',
    ],
    ['no evidence remains unknown', {}, 'unknown'],
  ] as const)(
    'applies the legacy fallback table: %s',
    (_description, overrides, expected) => {
      expect(classifyAuditEntry(auditEntry(overrides))?.billingBasis).toBe(
        expected,
      );
    },
  );

  it('never prices organization-gateway or local work even if an audit line has dollars', () => {
    for (const billingBasis of ['org_gateway', 'local'] as const) {
      const result = classifyAuditEntry(
        auditEntry({
          billingBasis,
          totalCostUsd: 9.25,
          observedCost: {
            status: 'priced',
            reason: 'priced',
            currency: 'usd',
            totalUsd: 9.25,
            components: [],
          },
          subagents: [
            {
              id: 'subagent-1',
              kind: 'claude_task',
              tokens: {
                input: 2,
                output: 1,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
              },
              costUsd: 4.5,
              inclusion: 'additional',
            },
          ],
        }),
      );

      expect(result?.costUsd).toBeUndefined();
      expect(result?.costStatus).toBe('not_priced');
      expect(result?.tokens.input).toBe(120);
      expect(result?.subagents?.[0]).not.toHaveProperty('usd');
      expect(result?.subagents?.[0]?.costStatus).toBe('not_priced');
    }
  });

  it('marks Codex reported amounts as estimates and retains partial/unpriced status', () => {
    const estimated = classifyAuditEntry(
      auditEntry({ provider: 'codex', totalCostUsd: 0.04 }),
    );
    const partial = classifyAuditEntry(
      auditEntry({
        provider: 'codex',
        observedCost: {
          status: 'partially_priced',
          reason: 'billable_tool_pricing_unavailable',
          currency: 'usd',
          totalUsd: 0.02,
          components: [],
        },
      }),
    );
    const unpriced = classifyAuditEntry(
      auditEntry({
        totalCostUsd: 0.02,
        observedCost: {
          status: 'unpriced',
          reason: 'model_not_priced',
          currency: 'usd',
          components: [],
        },
      }),
    );

    expect(estimated).toMatchObject({ costUsd: 0.04, costStatus: 'estimated' });
    expect(partial).toMatchObject({ costUsd: 0.02, costStatus: 'partial' });
    expect(unpriced).toMatchObject({ costStatus: 'not_priced' });
    expect(unpriced).not.toHaveProperty('costUsd');
  });

  it.each([
    ['Codex provider', { provider: 'codex' as const }],
    ['Codex chat harness', { executionHarness: 'codex' as const }],
  ])('marks a priced %s turn as estimated', (_label, overrides) => {
    expect(
      classifyAuditEntry(auditEntry({ ...overrides, totalCostUsd: 0.04 })),
    ).toMatchObject({ costUsd: 0.04, costStatus: 'estimated' });
  });

  it('marks a Codex-harness delegation as estimated without changing its additive attribution', () => {
    const result = classifyAuditEntry(
      auditEntry({
        provider: 'claude',
        eventType: 'managed_delegation',
        delegation: {
          delegationId: 'codex-delegate',
          runGeneration: 1,
          harness: 'codex',
        },
        totalCostUsd: 0.04,
      }),
    );

    expect(result).toMatchObject({ costUsd: 0.04, costStatus: 'estimated' });
    expect(result?.delegation).toMatchObject({
      harness: 'codex',
      inclusion: 'additional',
      costStatus: 'estimated',
      usd: 0.04,
    });
  });

  it('keeps Codex-agent inclusion as captured and marks its reported amount estimated', () => {
    const result = classifyAuditEntry(
      auditEntry({
        subagents: [
          {
            id: 'codex-agent',
            kind: 'codex_agent',
            tokens: {
              input: 3,
              output: 2,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
            costUsd: 0.02,
            inclusion: 'additional',
          },
        ],
      }),
    );

    expect(result?.subagents?.[0]).toMatchObject({
      id: 'codex-agent',
      inclusion: 'additional',
      costStatus: 'estimated',
      usd: 0.02,
    });
  });

  it('subtracts cache tokens from Codex input totals across provider and harness routes', () => {
    const provider = classifyAuditEntry(
      auditEntry({
        provider: 'codex',
        tokens: {
          input: 120,
          output: 12,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 10,
        },
      }),
    );
    const harness = classifyAuditEntry(
      auditEntry({
        executionHarness: 'codex',
        tokens: {
          input: 120,
          output: 12,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 10,
        },
      }),
    );

    expect(provider?.tokens).toMatchObject({ input: 90, output: 12 });
    expect(harness?.tokens).toMatchObject({ input: 90, output: 12 });
  });

  it('normalizes Codex pipeline input and clamps it at zero', () => {
    const result = classifyAuditEntry(
      auditEntry({
        eventType: 'pipeline_agent_turn',
        executionHarness: 'codex',
        pipelineExecutionId: 'run-1',
        jobId: 'job-1',
        stepId: 'step-1',
        tokens: {
          input: 10,
          output: 12,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 10,
        },
      }),
    );

    expect(result?.source).toBe('pipeline');
    expect(result?.tokens).toMatchObject({ input: 0, output: 12 });
  });

  it.each(['claude', 'cursor'] as const)(
    'does not normalize non-Codex %s input totals',
    (executionHarness) => {
      const result = classifyAuditEntry(
        auditEntry({
          executionHarness,
          tokens: {
            input: 120,
            output: 12,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 10,
          },
        }),
      );

      expect(result?.tokens).toMatchObject({ input: 120, output: 12 });
    },
  );

  it('normalizes Codex delegation and subagent tokens without changing inclusion', () => {
    const result = classifyAuditEntry(
      auditEntry({
        provider: 'claude',
        eventType: 'managed_delegation',
        delegation: {
          delegationId: 'codex-delegate',
          runGeneration: 1,
          harness: 'codex',
        },
        tokens: {
          input: 100,
          output: 10,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 5,
        },
        subagents: [
          {
            id: 'codex-agent',
            kind: 'codex_agent',
            tokens: {
              input: 60,
              output: 4,
              cacheReadInputTokens: 20,
              cacheCreationInputTokens: 5,
            },
            inclusion: 'included',
          },
          {
            id: 'claude-task',
            kind: 'claude_task',
            tokens: {
              input: 60,
              output: 4,
              cacheReadInputTokens: 20,
              cacheCreationInputTokens: 5,
            },
            inclusion: 'included',
          },
        ],
      }),
    );

    expect(result?.tokens.input).toBe(75);
    expect(result?.delegation).toMatchObject({
      tokens: { input: 75, output: 10 },
      inclusion: 'additional',
    });
    expect(result?.subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'codex-agent',
          inclusion: 'included',
          tokens: {
            input: 35,
            output: 4,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 5,
            reasoningOutputTokens: 0,
          },
        }),
        expect.objectContaining({
          id: 'claude-task',
          inclusion: 'included',
          tokens: {
            input: 60,
            output: 4,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 5,
            reasoningOutputTokens: 0,
          },
        }),
      ]),
    );
  });

  it('marks unknown-baseline Claude cost as estimated', () => {
    expect(
      classifyAuditEntry(
        auditEntry({
          provider: 'claude',
          costDerivation: 'estimated_unknown_baseline',
          totalCostUsd: 0.25,
        }),
      ),
    ).toMatchObject({ costUsd: 0.25, costStatus: 'estimated' });
  });

  describe('empty background observations', () => {
    const noBillableTokens = {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    };

    it('drops a successful background run with no usage, messages or cost', () => {
      expect(
        classifyAuditEntry(
          auditEntry({
            eventType: 'chat_summary',
            tokens: noBillableTokens,
            messageCount: 0,
            assistantMessageCount: 0,
            totalCostUsd: undefined,
            observedCost: undefined,
          }),
        ),
      ).toBeNull();
    });

    it.each([
      ['tokens', { tokens: { ...noBillableTokens, input: 1 } }],
      ['user messages', { messageCount: 1 }],
      ['assistant messages', { assistantMessageCount: 1 }],
      ['reported cost', { totalCostUsd: 0 }],
      ['failure status', { status: 'failure' as const }],
    ])(
      'retains a background observation with %s',
      (_description, overrides) => {
        expect(
          classifyAuditEntry(
            auditEntry({
              eventType: 'chat_summary',
              tokens: noBillableTokens,
              messageCount: 0,
              assistantMessageCount: 0,
              ...overrides,
            }),
          ),
        ).not.toBeNull();
      },
    );
  });

  it.each([
    ['worktree_chat', 'chat'],
    ['standalone_chat', 'chat'],
    ['app_advisor', 'chat'],
    ['worktree_plan_chat', 'chat'],
    ['pipeline_agent_turn', 'pipeline'],
    ['pipeline_advisor', 'background'],
    ['managed_delegation', 'delegation'],
    ['chat_summary', 'background'],
    ['branch_naming', 'background'],
    ['chat_handoff_summary', 'background'],
    ['commit_message_generation', 'background'],
    ['worktree_summary', 'background'],
    ['pr_generation', 'background'],
    ['pr_split_planning', 'background'],
    ['cron_generation', 'background'],
    ['automation_if_command_generation', 'background'],
    ['archive_summary', 'background'],
    ['worktree_plan_diagram', 'background'],
    ['code_review_annotations', 'background'],
    ['code_review_diagram', 'background'],
    ['local_memory_consolidation', 'background'],
    ['local_memory_chat_profile', 'background'],
    ['skill_suggestion_scan', 'background'],
  ] as const)('classifies %s as %s', (eventType, source) => {
    const result = classifyAuditEntry(
      auditEntry({
        eventType,
        pipelineExecutionId:
          eventType === 'pipeline_agent_turn' ||
          eventType === 'pipeline_advisor'
            ? 'run-1'
            : undefined,
        jobId: eventType === 'pipeline_agent_turn' ? 'job-1' : undefined,
        stepId: eventType === 'pipeline_agent_turn' ? 'step-1' : undefined,
        chatId:
          eventType === 'worktree_summary' || eventType === 'archive_summary'
            ? undefined
            : 'chat-1',
        delegation:
          eventType === 'managed_delegation'
            ? { delegationId: 'delegation-1', runGeneration: 1 }
            : undefined,
      }),
    );

    expect(result?.source).toBe(source);
    if (eventType === 'pipeline_advisor') {
      expect(result?.helperKind).toBe('pipeline_advisor');
      expect(result?.pipeline?.rootExecutionId).toBe('run-1');
    }
  });

  it('attributes legacy delegation lines by parent chat lineage when no top-level chat is present', () => {
    const result = classifyAuditEntry(
      auditEntry({
        eventType: 'managed_delegation',
        chatId: undefined,
        delegation: {
          delegationId: 'delegate-1',
          runGeneration: 1,
          parentChatId: 'parent-chat',
        },
      }),
    );
    expect(result?.chatId).toBe('parent-chat');
    expect(result?.source).toBe('delegation');
  });

  it('keeps included and additional subagent attribution and sanitized labels', () => {
    const result = classifyAuditEntry(
      auditEntry({
        subagents: [
          {
            id: 'included-1',
            kind: 'claude_task',
            label: 'Write focused tests',
            model: 'claude-sonnet-4',
            tokens: {
              input: 20,
              output: 10,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
            costUsd: 0.01,
            inclusion: 'included',
          },
          {
            id: 'additional-1',
            kind: 'codex_agent',
            label: '/Users/private/worktree/secret-task',
            tokens: {
              input: 3,
              output: 2,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
            costUsd: 0.02,
            inclusion: 'additional',
          },
        ],
      }),
    );

    expect(result?.subagents).toEqual([
      expect.objectContaining({
        id: 'additional-1',
        inclusion: 'additional',
        label: 'Codex agent',
        costStatus: 'estimated',
        usd: 0.02,
      }),
      expect.objectContaining({
        id: 'included-1',
        inclusion: 'included',
        label: 'Write focused tests',
        model: 'claude-sonnet-4',
        costStatus: 'reported',
        usd: 0.01,
      }),
    ]);
  });

  it.each([
    STANDALONE_CHAT_PROJECT_ID,
    DEFAULT_CHAT_PROJECT_ID,
    PLAN_EXPLORE_CHAT_PROJECT_ID,
    CODE_REVIEW_CHAT_PROJECT_ID,
    CURSOR_APPROVAL_CHECK_PROJECT_ID,
    SHARED_CONTAINER_VIEWER_PROJECT_ID,
    PIPELINE_EDITOR_PROJECT_ID,
  ])('ignores synthetic project scope %s', (projectId) => {
    expect(classifyAuditEntry(auditEntry({ projectId }))).toBeNull();
  });

  it.each([
    APP_ADVISOR_WORKTREE_ID,
    COWORK_HOME_WORKTREE_ID,
    PIPELINE_EDITOR_WORKTREE_ID,
  ])('ignores synthetic worktree scope %s', (worktreeId) => {
    expect(classifyAuditEntry(auditEntry({ worktreeId }))).toBeNull();
  });

  it('allows an App Advisor Work Entry but rejects its global synthetic scope', () => {
    expect(
      classifyAuditEntry(
        auditEntry({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-42',
        }),
      ),
    ).not.toBeNull();
    expect(
      classifyAuditEntry(
        auditEntry({
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: APP_ADVISOR_WORKTREE_ID,
        }),
      ),
    ).toBeNull();
  });

  it.each([
    { projectId: undefined, worktreeId: undefined },
    { projectId: '' },
    { projectId: 'project-1', worktreeId: undefined },
    { projectId: '../private', worktreeId: 'worktree-1' },
    { projectId: 'project-1', worktreeId: '/private/worktree' },
  ])('requires a real, complete project and worktree identity: %o', (scope) => {
    expect(classifyAuditEntry(auditEntry(scope))).toBeNull();
  });

  it('does not retain transcript, errors, provider account, repository, path or audit-only fields', () => {
    const result = classifyAuditEntry(
      auditEntry({
        label: 'PRIVATE top-level label',
        error: 'PRIVATE error response',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        contextWorkspaceId: 'workspace-secret',
        repoId: 'repository-secret',
        repoLabel: '/Users/private/secret-repository',
        providerAccountKey: 'person@example.com',
        providerAccountEmail: 'person@example.com',
        providerPlanType: 'enterprise-plan-secret',
        userMessageId: 'user-message-secret',
        sdkSessionId: 'session-secret',
        hasTranscript: true,
        subagents: [
          {
            id: 'subagent-1',
            kind: 'claude_task',
            label: '/Users/private/secret-task',
            tokens: {
              input: 1,
              output: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
            inclusion: 'additional',
          },
        ],
      }),
    );
    const serialized = JSON.stringify(result);

    expect(result).not.toBeNull();
    for (const privateValue of [
      'PRIVATE top-level label',
      'PRIVATE error response',
      'workspace-secret',
      'repository-secret',
      'person@example.com',
      'enterprise-plan-secret',
      'user-message-secret',
      'session-secret',
      '/Users/private',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(result?.subagents?.[0]?.label).toBe('Claude task');
  });

  describe('included subagents without a reported cost', () => {
    const noTokens = { cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

    it('estimates each share of the turn so the parts add up to it', () => {
      const result = classifyAuditEntry(
        auditEntry({
          model: 'claude-opus-5-5',
          totalCostUsd: 1,
          // The turn's totals already hold the subagents' tokens.
          tokens: { input: 1000, output: 100, ...noTokens },
          subagents: [
            {
              id: 'task-a',
              kind: 'claude_task',
              tokens: { input: 300, output: 40, ...noTokens },
              inclusion: 'included',
            },
            {
              id: 'task-b',
              kind: 'claude_task',
              tokens: { input: 200, output: 10, ...noTokens },
              inclusion: 'included',
            },
          ],
        }),
      );

      // Price-weighted tokens (output counts five times an input token):
      // the turn 1500, task-a 500, task-b 250, the chat's own turns 750.
      const [taskA, taskB] = result?.subagents ?? [];
      expect(taskA).toMatchObject({ id: 'task-a', costStatus: 'estimated' });
      expect(taskA?.usd).toBeCloseTo(1 / 3, 6);
      expect(taskB).toMatchObject({ id: 'task-b', costStatus: 'estimated' });
      expect(taskB?.usd).toBeCloseTo(1 / 6, 6);
      expect(result?.costUsd).toBe(1);
    });

    it("weighs a cheaper model family below the turn's own model", () => {
      const result = classifyAuditEntry(
        auditEntry({
          model: 'claude-opus-5-5',
          totalCostUsd: 1,
          tokens: { input: 2000, output: 0, ...noTokens },
          subagents: [
            {
              id: 'explore',
              kind: 'claude_task',
              model: 'claude-haiku-4-5-20251001',
              tokens: { input: 1000, output: 0, ...noTokens },
              inclusion: 'included',
            },
          ],
        }),
      );

      // Equal tokens, but Haiku costs a fifth of Opus: 1000 against 5000.
      expect(result?.subagents?.[0]?.usd).toBeCloseTo(1 / 6, 6);
    });

    it('never estimates more than the turn cost', () => {
      const result = classifyAuditEntry(
        auditEntry({
          totalCostUsd: 0.5,
          // A subagent reporting more tokens than its turn leaves no room.
          tokens: { input: 10, output: 0, ...noTokens },
          subagents: [
            {
              id: 'task-a',
              kind: 'claude_task',
              tokens: { input: 500, output: 0, ...noTokens },
              inclusion: 'included',
            },
          ],
        }),
      );

      expect(result?.subagents?.[0]?.usd).toBeCloseTo(0.5, 6);
    });

    it('never lets rounded shares add up to more than the turn', () => {
      const result = classifyAuditEntry(
        auditEntry({
          // Half a micro-dollar each would round up to a whole one apiece.
          totalCostUsd: 0.000001,
          tokens: { input: 200, output: 0, ...noTokens },
          subagents: ['task-a', 'task-b'].map((id) => ({
            id,
            kind: 'claude_task' as const,
            tokens: { input: 100, output: 0, ...noTokens },
            inclusion: 'included' as const,
          })),
        }),
      );

      const shares = (result?.subagents ?? []).map((item) => item.usd ?? 0);
      expect(shares).toHaveLength(2);
      expect(shares.reduce((sum, usd) => sum + usd, 0)).toBeLessThanOrEqual(
        0.000001,
      );
    });

    it('splits only what reported subagents leave of the turn', () => {
      const result = classifyAuditEntry(
        auditEntry({
          totalCostUsd: 1,
          tokens: { input: 1000, output: 0, ...noTokens },
          subagents: [
            {
              id: 'reported',
              kind: 'claude_task',
              tokens: { input: 400, output: 0, ...noTokens },
              costUsd: 0.4,
              inclusion: 'included',
            },
            {
              id: 'unreported',
              kind: 'claude_task',
              tokens: { input: 300, output: 0, ...noTokens },
              inclusion: 'included',
            },
          ],
        }),
      );

      const reported = result?.subagents?.find(
        (item) => item.id === 'reported',
      );
      const unreported = result?.subagents?.find(
        (item) => item.id === 'unreported',
      );
      expect(reported).toMatchObject({ usd: 0.4, costStatus: 'reported' });
      // 0.6 remains for 300 subagent tokens and 300 of the chat's own.
      expect(unreported?.usd).toBeCloseTo(0.3, 6);
      expect(unreported?.costStatus).toBe('estimated');
    });

    it('estimates nothing for a turn that was not priced', () => {
      const unpriced = classifyAuditEntry(
        auditEntry({
          tokens: { input: 1000, output: 0, ...noTokens },
          subagents: [
            {
              id: 'task-a',
              kind: 'claude_task',
              tokens: { input: 300, output: 0, ...noTokens },
              inclusion: 'included',
            },
          ],
        }),
      );
      const gateway = classifyAuditEntry(
        auditEntry({
          modelGatewayRouted: true,
          totalCostUsd: 1,
          tokens: { input: 1000, output: 0, ...noTokens },
          subagents: [
            {
              id: 'task-a',
              kind: 'claude_task',
              tokens: { input: 300, output: 0, ...noTokens },
              inclusion: 'included',
            },
          ],
        }),
      );

      for (const result of [unpriced, gateway]) {
        expect(result?.subagents?.[0]).not.toHaveProperty('usd');
        expect(result?.subagents?.[0]?.costStatus).toBe('not_priced');
      }
    });

    it('marks a subagent of a turn that is still running, and clears it when the turn ends', () => {
      const subagents = [
        {
          id: 'task-a',
          kind: 'claude_task' as const,
          tokens: { input: 300, output: 0, ...noTokens },
          inclusion: 'included' as const,
        },
      ];
      const running = classifyAuditEntry(
        auditEntry({
          status: 'running',
          completedAt: undefined,
          totalCostUsd: undefined,
          subagents,
        }),
      );
      // The turn's cost is not known yet, so the share is pending, not unpriced.
      expect(running?.subagents?.[0]).toMatchObject({
        costStatus: 'not_priced',
        status: 'running',
      });
      expect(running?.subagents?.[0]).not.toHaveProperty('usd');

      const ended = classifyAuditEntry(
        auditEntry({
          totalCostUsd: 1,
          tokens: { input: 1000, output: 0, ...noTokens },
          subagents,
        }),
      );
      expect(ended?.subagents?.[0]).not.toHaveProperty('status');
      expect(ended?.subagents?.[0]?.usd).toBeGreaterThan(0);
    });

    it('leaves an additional subagent without a cost unestimated', () => {
      const result = classifyAuditEntry(
        auditEntry({
          provider: 'codex',
          totalCostUsd: 1,
          tokens: { input: 1000, output: 0, ...noTokens },
          subagents: [
            {
              id: 'agent-a',
              kind: 'codex_agent',
              tokens: { input: 300, output: 0, ...noTokens },
              inclusion: 'additional',
            },
          ],
        }),
      );

      expect(result?.subagents?.[0]).not.toHaveProperty('usd');
    });
  });

  describe('Claude modelUsage attribution', () => {
    const noSplit = {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const mainRowCases: ReadonlyArray<{
      description: string;
      model: string;
      mainRow: AgentAuditModelUsage;
    }> = [
      {
        description: 'no matching main model row',
        model: 'claude-unknown-model',
        mainRow: modelUsageRow('claude-sonnet-4-5', 0.4, {
          inputTokens: 10,
        }),
      },
      {
        description: 'a matching main model row with no weighted tokens',
        model: 'claude-sonnet-4-5',
        mainRow: modelUsageRow('claude-sonnet-4-5', 0.4),
      },
    ];

    it('uses the matching model row for main-loop cost and allocates the other-work pool to Claude tasks', () => {
      const result = classifyAuditEntry(
        auditEntry({
          provider: 'claude',
          model: 'claude-sonnet-4-5',
          // Main-loop use is half of this modelUsage row's weighted tokens.
          tokens: {
            input: 50,
            output: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          totalCostUsd: 1,
          modelUsage: [
            modelUsageRow('sonnet[1m]', 0.4, {
              inputTokens: 100,
              outputTokens: 20,
            }),
            modelUsageRow('claude-opus-4-1', 0.3, { inputTokens: 100 }),
            modelUsageRow('claude-haiku-4-5-20251001', 0.3, {
              inputTokens: 50,
            }),
          ],
          subagents: [
            {
              id: 'unique-opus',
              kind: 'claude_task',
              model: 'claude-opus-4-1',
              tokens: noSplit,
              totalTokens: 100,
              inclusion: 'included',
            },
            {
              id: 'other-a',
              kind: 'claude_task',
              tokens: noSplit,
              totalTokens: 3,
              inclusion: 'included',
            },
            {
              id: 'other-b',
              kind: 'claude_task',
              tokens: noSplit,
              totalTokens: 1,
              inclusion: 'included',
            },
          ],
        }),
      );
      const items = result?.subagents ?? [];
      const byId = new Map(items.map((item) => [item.id, item]));

      expect(result?.tokens).toEqual({
        input: 250,
        output: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
      });
      expect(byId.get('unique-opus')).toMatchObject({
        model: 'claude-opus-4-1',
        totalTokens: 100,
        tokens: {
          input: 0,
          output: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        usd: 0.3,
        costStatus: 'estimated',
      });
      expect(byId.get('other-a')?.usd).toBe(0.375);
      expect(byId.get('other-b')?.usd).toBe(0.125);
      const allocated = items.reduce((sum, item) => sum + (item.usd ?? 0), 0);
      expect(allocated).toBe(0.8);
      const turnCost = result?.costUsd ?? 0;
      const parentRemainder = turnCost - allocated;
      expect(parentRemainder).toBeCloseTo(0.2, 10);
      expect(allocated + parentRemainder).toBe(turnCost);
    });

    it('prefers an exact context-suffixed model row over other rows in its family', () => {
      const result = classifyAuditEntry(
        auditEntry({
          provider: 'claude',
          model: 'claude-sonnet-4-5[1m]',
          tokens: {
            input: 5,
            output: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          modelUsage: [
            modelUsageRow('claude-sonnet-4-5[1m]', 0.2, { inputTokens: 10 }),
            modelUsageRow('claude-sonnet-4-5', 0.3, { inputTokens: 10 }),
            modelUsageRow('claude-opus-4-1', 0.5, { inputTokens: 10 }),
          ],
          subagents: [
            {
              id: 'task',
              kind: 'claude_task',
              model: 'claude-opus-4-1',
              tokens: noSplit,
              totalTokens: 10,
              inclusion: 'included',
            },
          ],
        }),
      );

      expect(result?.costUsd).toBe(1);
      expect(result?.subagents?.[0]?.usd).toBe(0.9);
    });

    it('gives the only Claude task the entire other-work pool, including internal work', () => {
      const result = classifyAuditEntry(
        auditEntry({
          provider: 'claude',
          model: 'claude-sonnet-4-5',
          tokens: {
            input: 50,
            output: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          totalCostUsd: 1,
          modelUsage: [
            modelUsageRow('claude-sonnet-4-5[1m]', 0.4, {
              inputTokens: 100,
              outputTokens: 20,
            }),
            modelUsageRow('claude-opus-4-1', 0.6, { inputTokens: 100 }),
          ],
          subagents: [
            {
              id: 'only-task',
              kind: 'claude_task',
              model: 'claude-opus-4-1',
              tokens: noSplit,
              totalTokens: 100,
              inclusion: 'included',
            },
          ],
        }),
      );

      expect(result?.subagents?.[0]).toMatchObject({
        totalTokens: 100,
        usd: 0.8,
        costStatus: 'estimated',
      });
      expect(
        (result?.costUsd ?? 0) - (result?.subagents?.[0]?.usd ?? 0),
      ).toBeCloseTo(0.2, 10);
    });

    it('leaves all cost on the chat when modelUsage has no Claude tasks', () => {
      const result = classifyAuditEntry(
        auditEntry({
          provider: 'claude',
          model: 'claude-sonnet-4-5',
          totalCostUsd: 0.9,
          modelUsage: [
            modelUsageRow('claude-sonnet-4-5', 0.3, { inputTokens: 100 }),
            modelUsageRow('claude-opus-4-1', 0.2, { inputTokens: 50 }),
          ],
        }),
      );

      expect(result?.costUsd).toBe(0.5);
      expect(result?.subagents).toBeUndefined();
      expect(result?.tokens.input).toBe(150);
    });

    it('uses the sum of modelUsage costs when top-level cost is absent', () => {
      const result = classifyAuditEntry(
        auditEntry({
          provider: 'claude',
          totalCostUsd: undefined,
          modelUsage: [
            modelUsageRow('claude-sonnet-4-5', 0.3, { inputTokens: 10 }),
            modelUsageRow('claude-opus-4-1', 0.2, { inputTokens: 5 }),
          ],
        }),
      );

      expect(result?.costUsd).toBe(0.5);
      expect(result?.tokens.input).toBe(15);
    });

    it('treats an empty modelUsage array as authoritative zero usage and cost', () => {
      // The store normalizes each persisted line before classifying it.
      const persisted = normalizeAuditEntry(
        JSON.parse(
          JSON.stringify(
            auditEntry({
              provider: 'claude',
              totalCostUsd: 0.5,
              modelUsage: [],
            }),
          ),
        ),
      );
      if (persisted === null) throw new Error('Expected a valid audit entry');
      const result = classifyAuditEntry(persisted);

      expect(result?.costUsd).toBe(0);
      expect(result?.tokens).toEqual({
        input: 0,
        output: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 0,
      });
    });

    it('records estimated zero-dollar task attribution when the other-work pool is zero', () => {
      const result = classifyAuditEntry(
        auditEntry({
          provider: 'claude',
          model: 'claude-sonnet-4-5',
          tokens: {
            input: 1,
            output: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          modelUsage: [
            modelUsageRow('claude-sonnet-4-5', 0.000001, { inputTokens: 1 }),
          ],
          subagents: [
            {
              id: 'task',
              kind: 'claude_task',
              tokens: noSplit,
              totalTokens: 10,
              inclusion: 'included',
            },
          ],
        }),
      );

      expect(result?.subagents?.[0]).toMatchObject({
        totalTokens: 10,
        usd: 0,
        costStatus: 'estimated',
      });
    });

    it('does not reserve multiple known differing-model task rows ahead of the pool split', () => {
      const result = classifyAuditEntry(
        auditEntry({
          provider: 'claude',
          model: 'claude-sonnet-4-5',
          tokens: {
            input: 5,
            output: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          modelUsage: [
            modelUsageRow('claude-sonnet-4-5', 0.2, { inputTokens: 10 }),
            modelUsageRow('claude-opus-4-1', 0.3, { inputTokens: 10 }),
            modelUsageRow('claude-haiku-4-5', 0.5, { inputTokens: 10 }),
          ],
          subagents: [
            {
              id: 'opus-task',
              kind: 'claude_task',
              model: 'claude-opus-4-1',
              tokens: noSplit,
              totalTokens: 1,
              inclusion: 'included',
            },
            {
              id: 'haiku-task',
              kind: 'claude_task',
              model: 'claude-haiku-4-5',
              tokens: noSplit,
              totalTokens: 3,
              inclusion: 'included',
            },
          ],
        }),
      );
      const shares = new Map(
        result?.subagents?.map((item) => [item.id, item.usd]),
      );

      expect(shares.get('opus-task')).toBe(0.225);
      expect(shares.get('haiku-task')).toBe(0.675);
    });

    it('does not reserve a unique model row when several tasks have different models from the main loop', () => {
      const result = classifyAuditEntry(
        auditEntry({
          model: 'sonnet',
          tokens: { ...noSplit, input: 5 },
          modelUsage: [
            modelUsageRow('sonnet', 0.2, { inputTokens: 10 }),
            modelUsageRow('opus', 0.3, { inputTokens: 10 }),
            modelUsageRow('haiku', 0.5, { inputTokens: 10 }),
          ],
          subagents: [
            {
              id: 'a-opus',
              kind: 'claude_task',
              model: 'opus',
              tokens: noSplit,
              totalTokens: 1,
              inclusion: 'included',
            },
            {
              id: 'b-haiku',
              kind: 'claude_task',
              model: 'haiku',
              tokens: noSplit,
              totalTokens: 3,
              inclusion: 'included',
            },
            {
              id: 'c-haiku',
              kind: 'claude_task',
              model: 'haiku',
              tokens: noSplit,
              totalTokens: 2,
              inclusion: 'included',
            },
          ],
        }),
      );
      expect(result?.subagents?.map((item) => item.usd)).toEqual([
        0.15, 0.45, 0.3,
      ]);
    });

    it('uses the modelUsage pool instead of a stale reported included-task cost', () => {
      const result = classifyAuditEntry(
        auditEntry({
          model: 'sonnet',
          tokens: { ...noSplit, input: 50 },
          modelUsage: [
            modelUsageRow('sonnet', 0.8, { inputTokens: 100 }),
            modelUsageRow('haiku', 0.2, { inputTokens: 10 }),
          ],
          subagents: [
            {
              id: 'task',
              kind: 'claude_task',
              tokens: noSplit,
              totalTokens: 10,
              costUsd: 9,
              inclusion: 'included',
            },
          ],
        }),
      );
      expect(result?.subagents?.[0]).toMatchObject({
        usd: 0.6,
        costStatus: 'estimated',
      });
    });

    it.each(mainRowCases)(
      'allocates the full other-work pool when there is $description',
      ({ model, mainRow }) => {
        const result = classifyAuditEntry(
          auditEntry({
            provider: 'claude',
            model,
            tokens: {
              input: 5,
              output: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
            totalCostUsd: 1,
            modelUsage: [
              mainRow,
              modelUsageRow('claude-opus-4-1', 0.6, { inputTokens: 10 }),
            ],
            subagents: [
              {
                id: 'only-task',
                kind: 'claude_task',
                model: 'claude-opus-4-1',
                tokens: noSplit,
                totalTokens: 20,
                inclusion: 'included',
              },
            ],
          }),
        );

        expect(result?.subagents?.[0]).toMatchObject({
          totalTokens: 20,
          usd: 1,
        });
      },
    );

    it('keeps modelUsage task shares in whole micro-dollars within the turn pool', () => {
      const result = classifyAuditEntry(
        auditEntry({
          provider: 'claude',
          model: 'claude-sonnet-4-5',
          tokens: {
            input: 1,
            output: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          totalCostUsd: 0.000002,
          modelUsage: [
            modelUsageRow('claude-sonnet-4-5', 0.000001, { inputTokens: 1 }),
            modelUsageRow('claude-haiku-4-5', 0.000001, { inputTokens: 1 }),
          ],
          subagents: ['task-a', 'task-b'].map((id) => ({
            id,
            kind: 'claude_task' as const,
            tokens: noSplit,
            totalTokens: 1,
            inclusion: 'included' as const,
          })),
        }),
      );
      const shares = (result?.subagents ?? []).map((item) => item.usd ?? 0);

      expect(shares).toEqual([0.000001, 0]);
      expect(shares.reduce((sum, usd) => sum + usd, 0)).toBe(0.000001);
      expect(shares.reduce((sum, usd) => sum + usd, 0)).toBeLessThanOrEqual(
        result?.costUsd ?? 0,
      );
      expect(
        (result?.costUsd ?? 0) - shares.reduce((sum, usd) => sum + usd, 0),
      ).toBe(0.000001);
    });

    it('marks modelUsage cost with an unknown starting baseline as estimated', () => {
      expect(
        classifyAuditEntry(
          auditEntry({
            provider: 'claude',
            costDerivation: 'estimated_unknown_baseline',
            totalCostUsd: 0.25,
            modelUsage: [
              modelUsageRow('claude-sonnet-4-5', 0.25, { inputTokens: 10 }),
            ],
          }),
        ),
      ).toMatchObject({ costUsd: 0.25, costStatus: 'estimated' });
    });
  });

  it('classifies the audit ids the observability service writes', () => {
    // Chat turns: `chat:<project>/<worktree>/<chat>:<startedAt>[:<uuid>]`.
    const chatId =
      'chat:project-1/worktree-1/chat-1:2026-10-08T10:00:00.000Z:3f2b6c1e-8a4d-4f0e-9c57-1d2e3f4a5b6c';
    expect(classifyAuditEntry(auditEntry({ id: chatId }))).toMatchObject({
      entryId: chatId,
      source: 'chat',
      chatId: 'chat-1',
    });

    // Pipeline steps: `pipeline:<run>/<job>/<step>/<attempt>[/i<n>]:<startedAt>`.
    const stepId =
      'pipeline:run-1/review/agent-review/0/i2:2026-10-08T10:00:00.000Z';
    expect(
      classifyAuditEntry(
        auditEntry({
          id: stepId,
          eventType: 'pipeline_agent_turn',
          chatId: undefined,
          pipelineExecutionId: 'run-1',
          jobId: 'review',
          stepId: 'agent-review',
        }),
      ),
    ).toMatchObject({ entryId: stepId, source: 'pipeline' });
  });

  it('rejects unsafe ids and invalid time while preserving normalized audit timestamps', () => {
    expect(
      classifyAuditEntry(auditEntry({ projectId: 'Invalid_Project' })),
    ).toBeNull();
    for (const id of [
      '/private/turn',
      'chat:a/../b',
      'chat:a\\b',
      'turn\u0000',
    ]) {
      expect(classifyAuditEntry(auditEntry({ id }))).toBeNull();
    }
    expect(
      classifyAuditEntry(auditEntry({ startedAt: 'not-a-date' })),
    ).toBeNull();
    expect(
      classifyAuditEntry(auditEntry({ startedAt: '2026-10-08T10:00:00-04:00' }))
        ?.startedAt,
    ).toBe('2026-10-08T14:00:00.000Z');
  });

  it('keeps the proxy accounts of work the proxy paid for, without labels', () => {
    const accountProxy = {
      connectionId: 'conn-1',
      accounts: [
        { authIndex: 'e2a8f640e2a8f640', requests: 1 },
        {
          authIndex: 'a1f3c2d4a1f3c2d4',
          label: 'sam@example.com',
          provider: 'claude',
          requests: 3,
        },
        { authIndex: 'a1f3c2d4a1f3c2d4', requests: 9 },
        { authIndex: '../escape', requests: 2 },
        { authIndex: 'b1b1b1b1b1b1b1b1', requests: 0 },
      ],
    };
    const result = classifyAuditEntry(
      auditEntry({
        billingBasis: 'account_proxy',
        accountProxy,
        subagents: [
          {
            id: 'task-1',
            kind: 'claude_task',
            tokens: {
              input: 1,
              output: 1,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
            inclusion: 'included',
          },
        ],
      }),
    );

    expect(result?.accountProxy).toEqual({
      connectionId: 'conn-1',
      accounts: [
        { authIndex: 'a1f3c2d4a1f3c2d4', provider: 'claude', requests: 3 },
        { authIndex: 'e2a8f640e2a8f640', requests: 1 },
      ],
    });
    expect(result?.subagents?.[0]?.proxyAccounts).toEqual([
      {
        accountKey: 'proxy:conn-1:a1f3c2d4a1f3c2d4',
        label: '',
        provider: 'claude',
      },
      { accountKey: 'proxy:conn-1:e2a8f640e2a8f640', label: '' },
    ]);
    expect(JSON.stringify(result)).not.toContain('sam@example.com');

    const delegation = classifyAuditEntry(
      auditEntry({
        eventType: 'managed_delegation',
        billingBasis: 'account_proxy',
        accountProxy,
        delegation: { delegationId: 'delegate-1', runGeneration: 1 },
      }),
    );
    expect(delegation?.delegation?.proxyAccounts).toEqual([
      expect.objectContaining({ accountKey: 'proxy:conn-1:a1f3c2d4a1f3c2d4' }),
      expect.objectContaining({ accountKey: 'proxy:conn-1:e2a8f640e2a8f640' }),
    ]);
  });

  it('keeps no proxy accounts on work the proxy did not pay for', () => {
    const result = classifyAuditEntry(
      auditEntry({
        billingBasis: 'subscription',
        accountProxy: {
          connectionId: 'conn-1',
          accounts: [{ authIndex: 'a1f3c2d4a1f3c2d4', requests: 1 }],
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('accountProxy');
  });
});

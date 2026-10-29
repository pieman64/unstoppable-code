import { normalizeAuditEntry } from '../audit-entry-parser';

function baseEntry(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: 'entry-1',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'Chat',
    startedAt: '2026-10-08T12:00:00.000Z',
    tokens: { input: 10, output: 2 },
    toolCounts: {},
    ...overrides,
  };
}

describe('audit entry cost fields', () => {
  it('round trips billing basis, context, compactions and subagents', () => {
    const entry = normalizeAuditEntry(
      baseEntry({
        billingBasis: 'ai_credits',
        context: {
          endTokens: 120_000,
          windowTokens: 200_000,
          peakTokens: 174_400,
          categories: [
            { name: 'Messages', tokens: 90_000, kind: 'used' },
            { name: 'Free space', tokens: 80_000, kind: 'free' },
            { name: 'Unknown kind', tokens: 1, kind: 'mystery' },
          ],
        },
        compactions: [
          {
            at: '2026-10-08T12:01:00.000Z',
            trigger: 'auto',
            preTokens: 190_000,
          },
          { at: '2026-10-08T12:02:00.000Z', trigger: 'by_hand' },
          { trigger: 'manual' },
        ],
        subagents: [
          {
            id: 'toolu_1',
            kind: 'claude_task',
            label: 'Explore the ledger',
            model: 'claude-haiku-4-5',
            tokens: { input: 5, output: 1 },
            costUsd: 0.02,
            inclusion: 'included',
          },
          { id: 'bad-kind', kind: 'other', tokens: {}, inclusion: 'included' },
          { id: 'bad-inclusion', kind: 'codex_agent', tokens: {} },
        ],
      }),
    );

    expect(entry?.billingBasis).toBe('ai_credits');
    expect(entry?.context).toEqual({
      endTokens: 120_000,
      windowTokens: 200_000,
      peakTokens: 174_400,
      categories: [
        { name: 'Messages', tokens: 90_000, kind: 'used' },
        { name: 'Free space', tokens: 80_000, kind: 'free' },
      ],
    });
    expect(entry?.compactions).toEqual([
      { at: '2026-10-08T12:01:00.000Z', trigger: 'auto', preTokens: 190_000 },
      { at: '2026-10-08T12:02:00.000Z', trigger: 'unknown' },
    ]);
    expect(entry?.subagents).toEqual([
      {
        id: 'toolu_1',
        kind: 'claude_task',
        label: 'Explore the ledger',
        model: 'claude-haiku-4-5',
        tokens: {
          input: 5,
          output: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
        costUsd: 0.02,
        inclusion: 'included',
      },
    ]);
  });

  it('omits the new fields on older entries', () => {
    const entry = normalizeAuditEntry(baseEntry({}));

    expect(entry).not.toBeNull();
    expect(entry).not.toHaveProperty('billingBasis');
    expect(entry).not.toHaveProperty('context');
    expect(entry).not.toHaveProperty('compactions');
    expect(entry).not.toHaveProperty('subagents');
    expect(entry).not.toHaveProperty('delegation');
    expect(entry).not.toHaveProperty('planEvents');
    expect(entry).not.toHaveProperty('rootPipelineExecutionId');
  });

  it('ignores an unknown billing basis and an incomplete context', () => {
    const entry = normalizeAuditEntry(
      baseEntry({ billingBasis: 'barter', context: { endTokens: 5 } }),
    );

    expect(entry).not.toHaveProperty('billingBasis');
    expect(entry).not.toHaveProperty('context');
  });

  it('parses a managed delegation entry with its lineage', () => {
    const entry = normalizeAuditEntry(
      baseEntry({
        id: 'delegation:d-1:2',
        eventType: 'managed_delegation',
        provider: 'codex',
        projectId: 'canopy',
        worktreeId: 'elephant',
        chatId: 'chat-1',
        delegation: {
          delegationId: 'd-1',
          runGeneration: 2,
          parentChatId: 'chat-1',
          parentUserMessageId: 'msg-3-1',
          harness: 'codex',
          label: 'plan-proof-reader',
        },
      }),
    );

    expect(entry?.eventType).toBe('managed_delegation');
    expect(entry?.delegation).toEqual({
      delegationId: 'd-1',
      runGeneration: 2,
      parentChatId: 'chat-1',
      parentUserMessageId: 'msg-3-1',
      harness: 'codex',
      label: 'plan-proof-reader',
    });
  });

  it('drops a delegation lineage without its identity', () => {
    const entry = normalizeAuditEntry(
      baseEntry({ delegation: { parentChatId: 'chat-1' } }),
    );

    expect(entry).not.toHaveProperty('delegation');
  });

  it('keeps plan lifecycle counts and drops empty ones', () => {
    expect(
      normalizeAuditEntry(baseEntry({ planEvents: { created: 1 } }))
        ?.planEvents,
    ).toEqual({ created: 1, approved: 0 });
    expect(
      normalizeAuditEntry(
        baseEntry({ planEvents: { created: 0, approved: 0 } }),
      ),
    ).not.toHaveProperty('planEvents');
  });

  it('keeps the root run of a nested pipeline execution', () => {
    const entry = normalizeAuditEntry(
      baseEntry({
        eventType: 'pipeline_agent_turn',
        pipelineExecutionId: 'child-run',
        rootPipelineExecutionId: 'root-run',
      }),
    );

    expect(entry?.pipelineExecutionId).toBe('child-run');
    expect(entry?.rootPipelineExecutionId).toBe('root-run');
  });

  it('keeps the proxy accounts that served the run', () => {
    const entry = normalizeAuditEntry(
      baseEntry({
        billingBasis: 'account_proxy',
        accountProxy: {
          connectionId: 'conn-1',
          accounts: [
            {
              authIndex: 'a1f3c2d4a1f3c2d4',
              label: 'sam@example.com',
              provider: 'claude',
              requests: 3,
            },
            { authIndex: 'e2a8f640e2a8f640', requests: 1 },
          ],
        },
      }),
    );

    expect(entry?.accountProxy).toEqual({
      connectionId: 'conn-1',
      accounts: [
        {
          authIndex: 'a1f3c2d4a1f3c2d4',
          label: 'sam@example.com',
          provider: 'claude',
          requests: 3,
        },
        { authIndex: 'e2a8f640e2a8f640', requests: 1 },
      ],
    });
  });

  it('drops proxy accounts it cannot trust', () => {
    expect(
      normalizeAuditEntry(
        baseEntry({
          accountProxy: { accounts: [{ authIndex: 'a', requests: 1 }] },
        }),
      ),
    ).not.toHaveProperty('accountProxy');
    const entry = normalizeAuditEntry(
      baseEntry({
        accountProxy: {
          connectionId: 'conn-1',
          accounts: [
            { authIndex: 'a', requests: 0 },
            { authIndex: 'b', requests: 1.5 },
            { authIndex: '', requests: 1 },
            { requests: 2 },
            { authIndex: 'c', requests: 2 },
            { authIndex: 'c', requests: 4 },
            'not-an-account',
          ],
        },
      }),
    );
    expect(entry?.accountProxy).toEqual({
      connectionId: 'conn-1',
      accounts: [{ authIndex: 'c', requests: 2 }],
    });
    expect(
      normalizeAuditEntry(
        baseEntry({
          accountProxy: {
            connectionId: 'conn-1',
            accounts: Array.from({ length: 20 }, (_, index) => ({
              authIndex: `account-${String(index)}`,
              requests: 1,
            })),
          },
        }),
      )?.accountProxy?.accounts,
    ).toHaveLength(16);
  });
});

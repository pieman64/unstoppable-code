import { normalizeAuditEntry } from '../observability/audit-entry-parser';

describe('audit-entry-parser', () => {
  it('drops legacy code-graph maintenance entries from agent audit history', () => {
    expect(
      normalizeAuditEntry({
        id: 'legacy-code-graph-build',
        eventType: 'code_graph_build',
        status: 'success',
        provider: 'ollama',
        label: 'Code Graph Build',
        startedAt: '2026-07-09T12:00:00.000Z',
        tokens: {},
        toolCounts: {},
      }),
    ).toBeNull();
  });

  it('normalizes persisted If Command generation audit entries', () => {
    const entry = normalizeAuditEntry({
      id: 'entry-1',
      eventType: 'automation_if_command_generation',
      status: 'success',
      provider: 'claude',
      label: 'If Command Generation',
      startedAt: '2026-06-19T12:00:00.000Z',
      tokens: {
        input: 12,
        output: 4,
      },
      toolCounts: {},
    });

    expect(entry).toMatchObject({
      id: 'entry-1',
      eventType: 'automation_if_command_generation',
      status: 'success',
      provider: 'claude',
      label: 'If Command Generation',
      tokens: {
        input: 12,
        output: 4,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
  });

  it('preserves persisted Pipeline Editor audit links', () => {
    const entry = normalizeAuditEntry({
      id: 'entry-2',
      eventType: 'pipeline_editor',
      status: 'success',
      provider: 'codex',
      label: 'Pipeline Editor',
      startedAt: '2026-06-24T12:00:00.000Z',
      tokens: {},
      toolCounts: {},
      linkTarget: {
        kind: 'pipeline-editor',
        page: 'pipelines',
        chatId: 'pipeline-editor-chat',
      },
    });

    expect(entry?.linkTarget).toEqual({
      kind: 'pipeline-editor',
      page: 'pipelines',
      chatId: 'pipeline-editor-chat',
    });
  });

  it('round-trips subscription attribution and aiCreditsRouted', () => {
    const entry = normalizeAuditEntry({
      id: 'entry-3',
      eventType: 'worktree_chat',
      status: 'success',
      provider: 'claude',
      label: 'Chat',
      startedAt: '2026-07-06T12:00:00.000Z',
      tokens: {},
      toolCounts: {},
      providerAccountKey: 'claude:dev@example.com',
      providerAccountEmail: 'dev@example.com',
      providerPlanType: 'max',
    });

    expect(entry).toMatchObject({
      providerAccountKey: 'claude:dev@example.com',
      providerAccountEmail: 'dev@example.com',
      providerPlanType: 'max',
    });
    expect(entry?.aiCreditsRouted).toBeUndefined();
  });

  it('reads aiCreditsRouted only when true', () => {
    const routed = normalizeAuditEntry({
      id: 'entry-4',
      eventType: 'worktree_chat',
      status: 'success',
      provider: 'claude',
      label: 'Chat',
      startedAt: '2026-07-06T12:00:00.000Z',
      tokens: {},
      toolCounts: {},
      aiCreditsRouted: true,
    });
    expect(routed?.aiCreditsRouted).toBe(true);

    const notRouted = normalizeAuditEntry({
      id: 'entry-5',
      eventType: 'worktree_chat',
      status: 'success',
      provider: 'claude',
      label: 'Chat',
      startedAt: '2026-07-06T12:00:00.000Z',
      tokens: {},
      toolCounts: {},
      aiCreditsRouted: false,
    });
    expect(notRouted?.aiCreditsRouted).toBeUndefined();
  });

  describe('requested service tiers without exact pricing', () => {
    const unsupportedTierCost = {
      status: 'unpriced',
      reason: 'unsupported_service_tier',
      currency: 'usd',
      model: 'gpt-6-astra',
      serviceTier: 'ultrafast',
      components: [
        {
          kind: 'unpriced_tokens',
          label: 'Codex token usage',
          reason: 'unsupported_service_tier',
        },
        {
          kind: 'unpriced_tool',
          label: 'OpenAI web search calls',
          quantity: 2,
          unit: 'calls',
          reason: 'unsupported_service_tier',
        },
      ],
    };

    function ultraFastEntry(): unknown {
      return {
        id: 'entry-6',
        eventType: 'worktree_chat',
        status: 'success',
        provider: 'codex',
        label: 'Chat',
        startedAt: '2026-09-30T12:00:00.000Z',
        model: 'gpt-6-astra',
        serviceTier: 'ultrafast',
        tokens: { input: 1000, output: 100 },
        toolCounts: {},
        observedCost: unsupportedTierCost,
      };
    }

    it('retains the unpriced cost and its exact unsupported-tier reason on reload', () => {
      const entry = normalizeAuditEntry(ultraFastEntry());

      expect(entry?.observedCost).toEqual(unsupportedTierCost);
      expect(entry?.totalCostUsd).toBeUndefined();
    });

    it('keeps the persisted tier as the requested tier without a served-tier field', () => {
      const entry = normalizeAuditEntry(ultraFastEntry());
      const tierFields = (record: object): string[] =>
        Object.keys(record).filter((key) => /tier/i.test(key));

      expect(entry?.serviceTier).toBe('ultrafast');
      expect(entry ? tierFields(entry) : []).toEqual(['serviceTier']);
      expect(entry?.observedCost ? tierFields(entry.observedCost) : []).toEqual(
        ['serviceTier'],
      );
    });
  });
});

import {
  CodexSubagentUsageTracker,
  MAX_CODEX_SUBAGENTS_PER_ENTRY,
} from '../codex-subagent-usage';

const NO_PRICING = { loadedFrom: 'none', stale: true } as const;

describe('CodexSubagentUsageTracker', () => {
  it('uses last for a first cumulative sighting, then deduplicates totals across turns', () => {
    const tracker = new CodexSubagentUsageTracker();
    tracker.beginEntry();

    const firstSnapshot = {
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'child-thread',
      turn_id: 'turn-1',
      total: { input_tokens: 900, output_tokens: 90 },
      last: { input_tokens: 12, output_tokens: 4 },
    };
    tracker.observeUsageEvent(firstSnapshot);
    tracker.observeUsageEvent(firstSnapshot);

    expect(
      tracker.toAuditUsages({
        pricingState: NO_PRICING,
        allowCost: false,
      }),
    ).toMatchObject([
      {
        id: 'child-thread',
        tokens: { input: 12, output: 4 },
      },
    ]);

    tracker.endEntry();
    tracker.observeUsageEvent({
      ...firstSnapshot,
      turn_id: 'turn-late',
      total: { input_tokens: 925, output_tokens: 100 },
      last: { input_tokens: 25, output_tokens: 10 },
    });
    tracker.beginEntry();
    tracker.observeUsageEvent({
      ...firstSnapshot,
      turn_id: 'turn-late',
      total: { input_tokens: 925, output_tokens: 100 },
      last: { input_tokens: 25, output_tokens: 10 },
    });

    expect(
      tracker.toAuditUsages({
        pricingState: NO_PRICING,
        allowCost: false,
      }),
    ).toMatchObject([
      {
        id: 'child-thread',
        tokens: { input: 25, output: 10 },
      },
    ]);
  });

  it('bounds children and sanitizes model and label metadata without retaining prompts', () => {
    const tracker = new CodexSubagentUsageTracker();
    tracker.beginEntry();
    const receiverThreadIds = Array.from(
      { length: MAX_CODEX_SUBAGENTS_PER_ENTRY + 1 },
      (_value, index) => `child-${String(index).padStart(2, '0')}`,
    );
    tracker.observeSpawnItem({
      type: 'collab_agent_tool_call',
      tool: 'spawnAgent',
      receiver_thread_ids: receiverThreadIds,
      model: ` model-${'x'.repeat(200)} `,
      prompt: 'private prompt that must not enter audit metadata',
    });
    tracker.observeThreadStarted({
      type: 'thread.started',
      thread_id: 'child-00',
      source: { subAgent: {} },
      agent_nickname: `\u0001${'Explorer'.repeat(15)}`,
    });

    for (const threadId of receiverThreadIds) {
      tracker.observeUsageEvent({
        type: 'thread.subagent_token_usage.updated',
        thread_id: threadId,
        turn_id: `turn-${threadId}`,
        total: { input_tokens: 5, output_tokens: 1 },
        last: { input_tokens: 5, output_tokens: 1 },
      });
    }

    const usages = tracker.toAuditUsages({
      pricingState: NO_PRICING,
      allowCost: false,
    });
    expect(usages).toHaveLength(MAX_CODEX_SUBAGENTS_PER_ENTRY);
    expect(usages[0]?.label).toHaveLength(80);
    expect(
      Array.from(usages[0]?.label ?? '').some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || (code >= 0x7f && code <= 0x9f);
      }),
    ).toBe(false);
    expect(usages[0]?.model).toHaveLength(160);
    expect(JSON.stringify(usages)).not.toContain(
      'private prompt that must not enter audit metadata',
    );
  });

  it('keeps attributing new children after more than 64 historical turns', () => {
    const tracker = new CodexSubagentUsageTracker();
    for (let index = 0; index < MAX_CODEX_SUBAGENTS_PER_ENTRY + 1; index += 1) {
      tracker.beginEntry();
      tracker.observeUsageEvent({
        type: 'thread.subagent_token_usage.updated',
        thread_id: `historical-child-${index}`,
        turn_id: `turn-${index}`,
        total: { input_tokens: 10, output_tokens: 2 },
        last: { input_tokens: 1, output_tokens: 1 },
      });
      expect(
        tracker.toAuditUsages({
          pricingState: NO_PRICING,
          allowCost: false,
        }),
      ).toHaveLength(1);
      tracker.endEntry();
    }

    tracker.beginEntry();
    tracker.observeUsageEvent({
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'child-after-history',
      turn_id: 'turn-after-history',
      total: { input_tokens: 10, output_tokens: 2 },
      last: { input_tokens: 1, output_tokens: 1 },
    });

    expect(
      tracker.toAuditUsages({
        pricingState: NO_PRICING,
        allowCost: false,
      }),
    ).toMatchObject([
      {
        id: 'child-after-history',
        tokens: { input: 1, output: 1 },
      },
    ]);
  });

  it('deduplicates fallback last-only snapshots across more than 64 turns', () => {
    const tracker = new CodexSubagentUsageTracker();
    for (let index = 0; index < MAX_CODEX_SUBAGENTS_PER_ENTRY + 1; index += 1) {
      tracker.beginEntry();
      tracker.observeUsageEvent({
        type: 'thread.subagent_token_usage.updated',
        thread_id: 'fallback-child',
        turn_id: `fallback-turn-${index}`,
        last: { input_tokens: 1, output_tokens: 1 },
      });
      tracker.endEntry();
    }

    tracker.beginEntry();
    tracker.observeUsageEvent({
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'fallback-child',
      turn_id: 'fallback-turn-0',
      last: { input_tokens: 1, output_tokens: 1 },
    });

    expect(
      tracker.toAuditUsages({
        pricingState: NO_PRICING,
        allowCost: false,
      }),
    ).toEqual([]);
  });

  it('does not use a parent model to price a child with no model metadata', () => {
    const tracker = new CodexSubagentUsageTracker();
    tracker.beginEntry();
    tracker.observeUsageEvent({
      type: 'thread.subagent_token_usage.updated',
      thread_id: 'child-without-model',
      turn_id: 'turn-1',
      total: { input_tokens: 5, output_tokens: 1 },
      last: { input_tokens: 5, output_tokens: 1 },
    });

    const [usage] = tracker.toAuditUsages({
      pricingState: NO_PRICING,
      allowCost: true,
      serviceTier: 'priority',
    });
    expect(usage?.model).toBeUndefined();
    expect(usage?.costUsd).toBeUndefined();
  });
});

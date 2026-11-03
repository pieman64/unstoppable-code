import type {
  AgentAuditEntry,
  PlanUsageEvent,
  UsageMetricEvent,
} from '@canopy/protocol/observability';
import { normalizeAuditEntry } from '../audit-entry-parser';
import { defaultToolCounts } from '../audit-records';
import { countPlanUsageEvent, upsertUsageEventById } from '../usage-identity';

function chatEntry(): AgentAuditEntry {
  return {
    id: 'chat:proj/wt/chat:2026-10-20T09:00:00.000Z',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'Chat',
    startedAt: '2026-10-20T09:00:00.000Z',
    projectId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat',
    tokens: {
      input: 0,
      output: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    messageCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    subAgentCount: 0,
    hasTranscript: false,
    toolCounts: defaultToolCounts(),
  };
}

function planEvent(
  type: PlanUsageEvent['type'],
  id: string,
  timestamp = '2026-10-20T09:00:01.000Z',
): PlanUsageEvent {
  return {
    version: 1,
    id,
    type,
    timestamp,
    workspaceId: 'proj',
    worktreeId: 'wt',
    chatId: 'chat',
    planId: 'plan-1',
  };
}

describe('usage identity', () => {
  it('counts a plan event once, including after the entry is stored and reloaded', () => {
    const entry = chatEntry();
    expect(countPlanUsageEvent(entry, planEvent('plan_created', 'c-1'))).toBe(
      true,
    );
    expect(countPlanUsageEvent(entry, planEvent('plan_approved', 'a-1'))).toBe(
      true,
    );
    expect(countPlanUsageEvent(entry, planEvent('plan_updated', 'u-1'))).toBe(
      false,
    );

    const reloaded = normalizeAuditEntry(JSON.parse(JSON.stringify(entry)));
    if (!reloaded) throw new Error('Expected the stored entry to reload');
    expect(
      countPlanUsageEvent(
        reloaded,
        planEvent('plan_created', 'c-1', '2026-10-21T08:00:00.000Z'),
      ),
    ).toBe(false);
    expect(reloaded.planEvents).toEqual({
      created: 1,
      approved: 1,
      eventIds: ['c-1', 'a-1'],
    });
  });

  it('adds identity to counts stored without event ids', () => {
    const entry = normalizeAuditEntry({
      ...chatEntry(),
      planEvents: { created: 1, approved: 0 },
    });
    if (!entry) throw new Error('Expected the stored entry to load');
    expect(entry.planEvents).toEqual({ created: 1, approved: 0 });

    countPlanUsageEvent(entry, planEvent('plan_approved', 'a-1'));
    expect(entry.planEvents).toEqual({
      created: 1,
      approved: 1,
      eventIds: ['a-1'],
    });
  });

  it('keeps one usage event per id, preferring the latest timestamp', () => {
    const eventsById = new Map<string, UsageMetricEvent>();
    const original = planEvent('plan_created', 'c-1');
    const replay = planEvent('plan_created', 'c-1', '2026-10-21T08:00:00.000Z');
    upsertUsageEventById(eventsById, replay);
    upsertUsageEventById(eventsById, original);
    expect(Array.from(eventsById.values())).toEqual([replay]);

    const tied = new Map<string, UsageMetricEvent>();
    const rewritten = { ...original, planVersion: 2 };
    upsertUsageEventById(tied, original);
    upsertUsageEventById(tied, rewritten);
    expect(Array.from(tied.values())).toEqual([rewritten]);
  });
});

import type {
  AgentAuditEntry,
  AgentAuditToolCounts,
} from '@canopy/desktop-shared/types/observability';
import { rollupFromEntries } from '../lib/shared-run-rollup';

function zeroToolCounts(): AgentAuditToolCounts {
  return {
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
}

function makeEntry(overrides: Partial<AgentAuditEntry>): AgentAuditEntry {
  return {
    id: 'entry-1',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'Turn',
    startedAt: '2026-07-09T00:00:00.000Z',
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
    toolCounts: zeroToolCounts(),
    hasTranscript: false,
    ...overrides,
  };
}

describe('rollupFromEntries', () => {
  it('sums tokens, cost, tools, and duration across a session', () => {
    const entries: AgentAuditEntry[] = [
      makeEntry({
        id: 'a',
        provider: 'claude',
        model: 'claude-sonnet-4',
        status: 'success',
        tokens: {
          input: 1000,
          output: 600,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 5,
        },
        totalCostUsd: 0.3,
        toolUseCount: 5,
        durationMs: 8000,
      }),
      makeEntry({
        id: 'b',
        provider: 'claude',
        model: 'claude-opus-4',
        status: 'failure',
        tokens: {
          input: 500,
          output: 300,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
        },
        totalCostUsd: 0.12,
        toolUseCount: 2,
        durationMs: 4000,
      }),
    ];

    const rollup = rollupFromEntries(entries);

    expect(rollup.inputTokens).toBe(1500);
    expect(rollup.outputTokens).toBe(900);
    expect(rollup.cacheReadInputTokens).toBe(12);
    expect(rollup.cacheCreationInputTokens).toBe(6);
    expect(rollup.totalCostUsd).toBeCloseTo(0.42, 5);
    expect(rollup.toolUseCount).toBe(7);
    expect(rollup.turnCount).toBe(2);
    expect(rollup.durationMs).toBe(12000);
    // provider/model/status come from the latest (last) turn.
    expect(rollup.provider).toBe('claude');
    expect(rollup.model).toBe('claude-opus-4');
    expect(rollup.status).toBe('failure');
  });

  it('omits durationMs when no entry recorded a duration', () => {
    const rollup = rollupFromEntries([makeEntry({ id: 'a', toolUseCount: 1 })]);
    expect(rollup.durationMs).toBeUndefined();
    expect(rollup.toolUseCount).toBe(1);
  });

  it('treats missing totalCostUsd as zero', () => {
    const rollup = rollupFromEntries([
      makeEntry({ id: 'a' }),
      makeEntry({ id: 'b', totalCostUsd: 1.5 }),
    ]);
    expect(rollup.totalCostUsd).toBeCloseTo(1.5, 5);
  });
});

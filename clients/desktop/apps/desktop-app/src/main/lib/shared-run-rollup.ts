import type { AgentAuditEntry } from '@canopy/execution-engine/types/observability';
import type { SharedRunRollup } from '@canopy/protocol/runs';

/**
 * Sum a finished chat session's audit entries into a run rollup snapshot
 * (CAN-395). Pure — no Electron/IO imports — so it can be unit-tested in
 * isolation. `provider`/`model`/`status` come from the latest (last) entry; the
 * caller passes entries in oldest-first order.
 */
export function rollupFromEntries(entries: AgentAuditEntry[]): SharedRunRollup {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let totalCostUsd = 0;
  let toolUseCount = 0;
  let durationMs = 0;
  let hasDuration = false;

  for (const entry of entries) {
    inputTokens += entry.tokens.input;
    outputTokens += entry.tokens.output;
    cacheReadInputTokens += entry.tokens.cacheReadInputTokens;
    cacheCreationInputTokens += entry.tokens.cacheCreationInputTokens;
    if (entry.totalCostUsd !== undefined) {
      totalCostUsd += entry.totalCostUsd;
    }
    toolUseCount += entry.toolUseCount;
    if (entry.durationMs !== undefined) {
      durationMs += entry.durationMs;
      hasDuration = true;
    }
  }

  const latest = entries[entries.length - 1];
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalCostUsd,
    toolUseCount,
    turnCount: entries.length,
    ...(hasDuration ? { durationMs } : {}),
    provider: latest.provider,
    ...(latest.model ? { model: latest.model } : {}),
    status: latest.status,
  };
}

import {
  AGENT_ACTION_LIMITS,
  createInMemoryAgentActionLimits,
  createInMemoryAgentActionReceipts,
  type AgentActionLimitsPort,
  type AgentActionReceiptStore,
} from '@canopy/agent-actions';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';

/** The single desktop user every limit counts against. */
export const DESKTOP_AGENT_ACTOR_KEY = 'local-desktop-user';

const MAX_LINEAGE_ENTRIES = 1000;

/**
 * Spawn depth of agent-started chats. Process-local: chat metadata has no
 * lineage field, so a chat started before a restart counts as depth 0.
 */
export interface DesktopAgentLineage {
  depthOf(chatId: string): number;
  record(chatId: string, depth: number): void;
}

export function createDesktopAgentLineage(): DesktopAgentLineage {
  const depths = new Map<string, number>();
  return {
    depthOf: (chatId): number => depths.get(chatId) ?? 0,
    record: (chatId, depth): void => {
      depths.delete(chatId);
      depths.set(chatId, depth);
      if (depths.size > MAX_LINEAGE_ENTRIES) {
        const oldest = depths.keys().next();
        if (!oldest.done) depths.delete(oldest.value);
      }
    },
  };
}

/**
 * Process-local caps; the desktop runs one main process per user.
 * Reservations are keyed by the write's idempotency key, so a retried tool
 * call keeps its original slot. There is no per-turn or hourly cap: the
 * user runs these agents on their own machine and accounts. The depth cap
 * still bounds how deep agent-started chats nest.
 */
export const DESKTOP_AGENT_ACTION_LIMITS = {
  ...AGENT_ACTION_LIMITS,
  perParentTurn: Number.POSITIVE_INFINITY,
  perUserPerHour: Number.POSITIVE_INFINITY,
};

export const desktopAgentActionLimits: AgentActionLimitsPort =
  createInMemoryAgentActionLimits({ limits: DESKTOP_AGENT_ACTION_LIMITS });

/**
 * Process-local results of agent writes, so a retried tool call returns the
 * original result. A retry after a restart, or past the oldest of the last
 * 500, runs as a new write.
 */
export const desktopAgentActionReceipts: AgentActionReceiptStore<CanopyInjectedToolRuntime> =
  createInMemoryAgentActionReceipts({ maxEntries: 500 });

export const desktopAgentLineage: DesktopAgentLineage =
  createDesktopAgentLineage();

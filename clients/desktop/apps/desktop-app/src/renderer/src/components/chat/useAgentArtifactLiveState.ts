import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  localArtifactAvailability,
  useAgentArtifactInventoryStore,
} from '@/stores/agentArtifactInventoryStore';
import { useMemo } from 'react';
import type {
  CapabilityTileLiveState,
  CapabilityTileReceipt,
} from '@canopy/ui-shared/components';
import type { ScheduledActivityRun } from '@canopy/desktop-shared/types';
import { useAgentsStore } from '@/stores/agentsStore';
import { useAutomationsStore } from '@/stores/automationsStore';

type Availability = NonNullable<CapabilityTileLiveState['availability']>;

interface AutomationInventory {
  hydrated: boolean;
  loading: boolean;
  error: string | null;
  activities: ReadonlyArray<{ id: string }>;
}

interface AgentInventory {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  agents: ReadonlyArray<{ id: string }>;
}

/** The local automation a receipt names, if any. */
export function automationIdentity(
  receipt: CapabilityTileReceipt,
): string | undefined {
  if (receipt.kind === 'automation' || receipt.kind === 'automation_run') {
    return receipt.activityId;
  }
  if (receipt.kind !== 'capability_reference') return undefined;
  const target = receipt.navigationTarget;
  if (target.kind === 'automation_editor') return target.activityId;
  if (target.kind === 'capability_entry' && target.entry.type === 'automation')
    return target.entry.activityId;
  return undefined;
}

/** The local agent a receipt names, if any. Shared agents stay snapshots. */
export function localAgentIdentity(
  receipt: CapabilityTileReceipt,
): string | undefined {
  if (receipt.kind === 'agent') {
    return receipt.source === 'local' ? receipt.agentId : undefined;
  }
  if (
    receipt.kind === 'capability_reference' &&
    receipt.navigationTarget.kind === 'agent_editor'
  ) {
    return receipt.navigationTarget.agentId;
  }
  return undefined;
}

/**
 * Only a settled, error-free inventory can prove a removal. A cold, loading or
 * failed store, or a context switch that cleared it, keeps the snapshot.
 */
export function automationAvailability(
  activityId: string | undefined,
  inventory: AutomationInventory,
): Availability {
  if (activityId === undefined) return 'unknown';
  if (!inventory.hydrated || inventory.loading || inventory.error !== null)
    return 'unknown';
  return inventory.activities.some((activity) => activity.id === activityId)
    ? 'available'
    : 'removed';
}

export function agentAvailability(
  agentId: string | undefined,
  inventory: AgentInventory,
  authoritative = true,
): Availability {
  if (agentId === undefined) return 'unknown';
  if (!inventory.loaded || inventory.loading || inventory.error !== null)
    return 'unknown';
  return inventory.agents.some((agent) => agent.id === agentId)
    ? 'available'
    : authoritative
      ? 'removed'
      : 'unknown';
}

/** Current availability, read once; used to recheck on activation. */
export function readAgentArtifactAvailability(
  receipt: CapabilityTileReceipt,
): Availability {
  const local = localArtifactAvailability(receipt);
  if (local !== 'unknown') return local;
  const automation = automationAvailability(
    automationIdentity(receipt),
    useAutomationsStore.getState(),
  );
  if (automation !== 'unknown') return automation;
  return agentAvailability(
    localAgentIdentity(receipt),
    useAgentsStore.getState(),
    !useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key) &&
      useAgentsStore.getState().inventoryComplete &&
      useAgentsStore.getState().inventoryGeneration ===
        useWorkspaceContextStore.getState().appliedGeneration,
  );
}

// Reuse indexes between tiles and renders; store snapshots replace these arrays.
const identityIndexes = new WeakMap<
  readonly { id: string }[],
  ReadonlySet<string>
>();
function hasInventoryIdentity(
  rows: readonly { id: string }[],
  id: string,
): boolean {
  let ids = identityIndexes.get(rows);
  if (!ids) {
    ids = new Set(rows.map((row) => row.id));
    identityIndexes.set(rows, ids);
  }
  return ids.has(id);
}
const runIndexes = new WeakMap<
  readonly ScheduledActivityRun[],
  ReadonlyMap<string, ScheduledActivityRun>
>();
function matchingRun(
  rows: readonly ScheduledActivityRun[],
  activityId: string | undefined,
  runId: string,
): ScheduledActivityRun | undefined {
  let index = runIndexes.get(rows);
  if (!index) {
    const built = new Map<string, ScheduledActivityRun>();
    for (const run of rows) {
      const key = JSON.stringify([run.activityId, run.id]);
      if (!built.has(key)) built.set(key, run);
    }
    index = built;
    runIndexes.set(rows, index);
  }
  return index.get(JSON.stringify([activityId, runId]));
}

/**
 * Conservative live state for one desktop tile, read from the stores the app
 * already keeps. It never fetches: a store nobody hydrated reports `unknown`
 * and the tile keeps its persisted snapshot. Missing runs in the bounded
 * recent-run history are not deletions.
 */
export function useAgentArtifactLiveState(
  receipt: CapabilityTileReceipt,
): CapabilityTileLiveState {
  const contextEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const generation = useWorkspaceContextStore(
    (state) => state.appliedGeneration,
  );
  const local = useAgentArtifactInventoryStore((state) =>
    localArtifactAvailability(receipt, state),
  );
  const activityId = automationIdentity(receipt);
  const agentId = localAgentIdentity(receipt);
  const runId = receipt.kind === 'automation_run' ? receipt.runId : undefined;
  const automation = useAutomationsStore((state) =>
    activityId === undefined ||
    !state.hydrated ||
    state.loading ||
    state.error !== null
      ? 'unknown'
      : hasInventoryIdentity(state.activities, activityId)
        ? 'available'
        : 'removed',
  );
  const agent = useAgentsStore((state) =>
    agentId === undefined ||
    !state.loaded ||
    state.loading ||
    state.error !== null
      ? 'unknown'
      : hasInventoryIdentity(state.agents, agentId)
        ? 'available'
        : !contextEnabled &&
            state.inventoryComplete &&
            state.inventoryGeneration === generation
          ? 'removed'
          : 'unknown',
  );
  const run = useAutomationsStore((state) =>
    runId === undefined
      ? undefined
      : matchingRun(state.recentRuns, activityId, runId),
  );
  const runStatus = run?.status;
  const runDurationMs = run?.durationMs;
  return useMemo(() => {
    const availability =
      local !== 'unknown'
        ? local
        : automation !== 'unknown'
          ? automation
          : agent;
    return {
      ...(availability !== 'unknown' ? { availability } : {}),
      ...(runStatus !== undefined ? { runStatus } : {}),
      ...(runDurationMs !== undefined ? { runDurationMs } : {}),
    };
  }, [agent, automation, local, runDurationMs, runStatus]);
}

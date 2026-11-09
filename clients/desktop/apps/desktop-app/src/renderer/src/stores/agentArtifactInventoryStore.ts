import { create } from 'zustand';
import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type {
  CapabilityTileLiveState,
  CapabilityTileReceipt,
} from '@canopy/ui-shared/components';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from './featureFlagsStore';
import { useWorkspaceContextStore } from './workspaceContextStore';

type Availability = NonNullable<CapabilityTileLiveState['availability']>;
interface InventorySnapshot {
  readonly generation: number;
  readonly complete: boolean;
  readonly keys: ReadonlySet<string>;
}
interface ArtifactInventories {
  pipelines: InventorySnapshot | null;
  skills: InventorySnapshot | null;
  projectPipelines: ReadonlyMap<string, InventorySnapshot>;
  removedAgents: ReadonlyMap<string, number>;
}

/** Observations of existing inventory loads only; this store never starts a fetch. */
export const useAgentArtifactInventoryStore = create<ArtifactInventories>(
  () => ({
    pipelines: null,
    skills: null,
    projectPipelines: new Map(),
    removedAgents: new Map(),
  }),
);

export function artifactInventoryScope(): {
  generation: number;
  complete: boolean;
} {
  return {
    generation: useWorkspaceContextStore.getState().appliedGeneration,
    // Filtered inventories cannot prove that another context's item was deleted.
    complete: !useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  };
}

export function observeArtifactPipelines(
  rows: readonly Pick<PipelineInfo, 'id' | 'source'>[] | null,
  scope = artifactInventoryScope(),
): void {
  useAgentArtifactInventoryStore.setState({
    pipelines: rows
      ? {
          ...scope,
          keys: new Set(
            rows
              .filter(
                (row) => row.source === 'user' || row.source === 'bundled',
              )
              .map((row) => JSON.stringify([row.source, row.id])),
          ),
        }
      : null,
  });
}

export interface ArtifactProjectIdentity {
  projectId: string;
  worktreeId: string;
  repoId?: string;
}
function projectKey(target: ArtifactProjectIdentity): string {
  return JSON.stringify([
    target.projectId,
    target.worktreeId,
    target.repoId ?? null,
  ]);
}

export function observeArtifactProjectPipelines(
  rows: readonly Pick<PipelineInfo, 'id'>[] | null,
  target: ArtifactProjectIdentity,
  scope = artifactInventoryScope(),
): void {
  const projectPipelines = new Map(
    useAgentArtifactInventoryStore.getState().projectPipelines,
  );
  const key = projectKey(target);
  if (rows)
    projectPipelines.set(key, {
      ...scope,
      keys: new Set(rows.map((row) => row.id)),
    });
  else projectPipelines.delete(key);
  useAgentArtifactInventoryStore.setState({ projectPipelines });
}

export function observeArtifactSkills(
  rows: readonly Pick<InstalledSkillInfo, 'sourceId' | 'name'>[] | null,
  scope = artifactInventoryScope(),
): void {
  useAgentArtifactInventoryStore.setState({
    skills: rows
      ? {
          ...scope,
          keys: new Set(
            rows.map((row) => JSON.stringify([row.sourceId, row.name])),
          ),
        }
      : null,
  });
}

export function recordArtifactAgentRemoval(agentId: string): void {
  const removedAgents = new Map(
    useAgentArtifactInventoryStore.getState().removedAgents,
  );
  removedAgents.set(agentId, artifactInventoryScope().generation);
  useAgentArtifactInventoryStore.setState({ removedAgents });
}

/** A later successful list can confirm that a previously removed id exists again. */
export function clearArtifactAgentRemovals(agentIds: readonly string[]): void {
  const previous = useAgentArtifactInventoryStore.getState().removedAgents;
  if (!agentIds.some((id) => previous.has(id))) return;
  const removedAgents = new Map(previous);
  for (const id of agentIds) removedAgents.delete(id);
  useAgentArtifactInventoryStore.setState({ removedAgents });
}

export function localArtifactAvailability(
  receipt: CapabilityTileReceipt,
  inventories = useAgentArtifactInventoryStore.getState(),
): Availability {
  const target = receipt.navigationTarget;
  let snapshot: InventorySnapshot | null = null;
  let key: string | undefined;
  if (
    target.kind === 'pipeline_editor' &&
    (target.source === 'user' || target.source === 'bundled')
  ) {
    snapshot = inventories.pipelines;
    key = JSON.stringify([target.source, target.pipelineId]);
  } else if (
    target.kind === 'pipeline_editor' &&
    target.source === 'project' &&
    target.projectId &&
    target.worktreeId
  ) {
    snapshot =
      inventories.projectPipelines.get(
        projectKey({
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          repoId: target.repoId,
        }),
      ) ?? null;
    key = target.pipelineId;
  } else if (target.kind === 'installed_skill') {
    snapshot = inventories.skills;
    key = JSON.stringify([target.sourceId, target.skillName]);
  } else if (
    target.kind === 'agent_editor' &&
    inventories.removedAgents.get(target.agentId) ===
      artifactInventoryScope().generation
  ) {
    return 'removed';
  }
  const scope = artifactInventoryScope();
  if (!snapshot || !key || snapshot.generation !== scope.generation)
    return 'unknown';
  if (snapshot.keys.has(key)) return 'available';
  return snapshot.complete && scope.complete ? 'removed' : 'unknown';
}

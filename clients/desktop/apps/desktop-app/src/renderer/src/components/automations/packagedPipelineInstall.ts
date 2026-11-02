import {
  SHARED_AUTOMATION_ACTION_PIPELINE_KEY,
  type SharedAutomationDocument,
} from '@canopy/protocol/automations';
import type { AutomationPipelineUpdatePlan } from '@canopy/desktop-shared/lib/automation-install';
import type {
  AutomationPipelineAssetChanges,
  InstallAutomationPipelinesResponse,
  PreviewAutomationPipelinesResponse,
} from '@canopy/desktop-shared/types';

/** One pipeline a shared automation document carries in its package. */
export interface SharedPackagedPipeline {
  key: string;
  name: string;
  pipelineContentHash: string;
  /** The `worktree_pipeline` action's own pipeline (key `action`). */
  isActionPipeline: boolean;
}

/**
 * The document's `packaged` pipeline refs: a `worktree_pipeline` action's
 * own pipeline, or a prompt action's `pipelineDependencies`. Their YAML is
 * in the capability package, so only Stage A can install them.
 */
export function sharedPackagedPipelines(
  automation: SharedAutomationDocument,
): SharedPackagedPipeline[] {
  const action = automation.action;
  if (action.type === 'worktree_pipeline') {
    return action.pipeline.source === 'packaged'
      ? [
          {
            key: action.pipeline.key,
            name: action.pipeline.name ?? 'Included pipeline',
            pipelineContentHash: action.pipeline.pipelineContentHash,
            isActionPipeline:
              action.pipeline.key === SHARED_AUTOMATION_ACTION_PIPELINE_KEY,
          },
        ]
      : [];
  }
  const pipelines: SharedPackagedPipeline[] = [];
  for (const dependency of action.pipelineDependencies ?? []) {
    if (dependency.pipeline.source !== 'packaged') continue;
    pipelines.push({
      key: dependency.key,
      name: dependency.pipeline.name ?? dependency.key,
      pipelineContentHash: dependency.pipeline.pipelineContentHash,
      isActionPipeline: false,
    });
  }
  return pipelines;
}

export type PackagedPipelineReviewStatus =
  | 'new'
  | 'reused'
  | 'update'
  | 'unchanged'
  | 'removed'
  | 'pending';

export interface PackagedPipelineReviewRow {
  key: string;
  name: string;
  status: PackagedPipelineReviewStatus;
  /** The shared YAML of a pipeline the update rewrites, from the preview. */
  rawPipeline?: string;
  /** What the update does to this pipeline's installed files, if anything. */
  fileChanges?: AutomationPipelineAssetChanges[];
}

export const PACKAGED_PIPELINE_STATUS_LABELS: Record<
  PackagedPipelineReviewStatus,
  string
> = {
  new: 'New',
  reused: 'Already on this computer',
  update: 'Update',
  unchanged: 'No changes',
  removed: 'No longer used',
  pending: 'Checking…',
};

function previewStatus(
  entry: PreviewAutomationPipelinesResponse['pipelines'][number],
): PackagedPipelineReviewStatus {
  switch (entry.outcome) {
    case 'created':
      return 'new';
    case 'kept':
      return 'unchanged';
    case 'reused':
      return entry.rewrites ? 'update' : 'reused';
  }
}

function hasFileChanges(change: AutomationPipelineAssetChanges): boolean {
  return (
    change.added.length > 0 ||
    change.updated.length > 0 ||
    change.overwritten.length > 0 ||
    change.kept.length > 0
  );
}

/**
 * Review rows for the packaged pipelines, from the preview (Stage A's dry
 * run) once it is in, because Stage A waits for the recipient to confirm.
 * Until then a fresh install shows each pipeline as being checked and an
 * update reports its plan. A recorded pipeline the update no longer lists
 * keeps its local copy and shows as no longer used.
 */
export function packagedPipelineReviewRows({
  pipelines,
  updatePlan,
  preview,
  localPipelineName,
}: {
  pipelines: readonly SharedPackagedPipeline[];
  updatePlan?: AutomationPipelineUpdatePlan | null;
  preview?: PreviewAutomationPipelinesResponse | null;
  /** Names a dropped pipeline by its local copy; the share no longer does. */
  localPipelineName?: (localPipelineId: string) => string | undefined;
}): PackagedPipelineReviewRow[] {
  const recorded = new Map(
    (updatePlan?.existingPipelines ?? []).map((entry) => [
      entry.key,
      entry.expectedContentHash,
    ]),
  );
  const previewed = new Map(
    (preview?.pipelines ?? []).map((entry) => [entry.key, entry]),
  );
  const rows: PackagedPipelineReviewRow[] = pipelines.map((pipeline) => {
    if (updatePlan) {
      const entry = previewed.get(pipeline.key);
      if (entry) {
        const status = previewStatus(entry);
        const fileChanges = entry.assetChanges.filter(hasFileChanges);
        return {
          key: pipeline.key,
          name: pipeline.name,
          status,
          ...(status === 'update' ? { rawPipeline: entry.rawPipeline } : {}),
          ...(fileChanges.length > 0 ? { fileChanges } : {}),
        };
      }
      const recordedHash = recorded.get(pipeline.key);
      return {
        key: pipeline.key,
        name: pipeline.name,
        status:
          recordedHash === undefined
            ? 'new'
            : recordedHash === pipeline.pipelineContentHash
              ? 'unchanged'
              : 'update',
      };
    }
    const outcome = previewed.get(pipeline.key)?.outcome;
    return {
      key: pipeline.key,
      name: pipeline.name,
      status:
        outcome === undefined
          ? 'pending'
          : outcome === 'created'
            ? 'new'
            : 'reused',
    };
  });
  for (const dropped of updatePlan?.dropped ?? []) {
    rows.push({
      key: dropped.key,
      name: localPipelineName?.(dropped.localPipelineId) ?? dropped.key,
      status: 'removed',
    });
  }
  return rows;
}

function fileCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'file' : 'files'}`;
}

export interface PackagedPipelineFileChangeLine {
  tone: 'warning' | 'secondary';
  text: string;
}

/**
 * Review copy for what an update does to one pipeline's installed files.
 * Under `replace` it warns how many files edited on this computer it
 * overwrites; under `seed` it lists the files it leaves as they are.
 */
export function packagedPipelineFileChangeLines(
  changes: readonly AutomationPipelineAssetChanges[],
): PackagedPipelineFileChangeLine[] {
  const lines: PackagedPipelineFileChangeLine[] = [];
  for (const change of changes) {
    const folder = `“${change.assetId}”`;
    if (change.overwritten.length > 0) {
      lines.push({
        tone: 'warning',
        text: `Overwrites ${fileCount(change.overwritten.length)} you changed in ${folder}: ${change.overwritten.join(', ')}`,
      });
    }
    if (change.updated.length > 0) {
      lines.push({
        tone: 'secondary',
        text: `Updates ${fileCount(change.updated.length)} in ${folder}`,
      });
    }
    if (change.added.length > 0) {
      lines.push({
        tone: 'secondary',
        text: `Adds ${fileCount(change.added.length)} to ${folder}`,
      });
    }
    if (change.kept.length > 0) {
      lines.push({
        tone: 'secondary',
        text: `Keeps ${fileCount(change.kept.length)} in ${folder} as they are on this computer: ${change.kept.join(', ')}`,
      });
    }
  }
  return lines;
}

/** Stage A's local pipeline for the `worktree_pipeline` action, if any. */
export function stagedActionPipelineId(
  stage: InstallAutomationPipelinesResponse,
): string | undefined {
  return stage.pipelines.find(
    (entry) => entry.key === SHARED_AUTOMATION_ACTION_PIPELINE_KEY,
  )?.localPipelineId;
}

import type { PlaneQualifiedName } from '../../names';

/**
 * Cloud pipeline runs (CAN-6085, plan CP-22): the operations a client needs
 * from the web core before it may offer "Run on: Cloud". Callers gate on
 * these operations being available in the web core's
 * `core.runtime.manifest.get`, never on runtime kind; a host whose manifest
 * does not report them (desktop alone, canopy-server) offers no cloud runs.
 *
 * The web core serves each of them behind its cloud pipelines rollout flag
 * (`apps/web/src/lib/web-core/cloud-pipeline-runs.ts`), from a map keyed by
 * this list. It is empty until the run operations land (CP-21), and an
 * empty group is never available.
 */
export const CORE_PIPELINE_CLOUD_RUN_OPERATIONS =
  [] as const satisfies readonly PlaneQualifiedName[];

export type CorePipelineCloudRunOperation =
  (typeof CORE_PIPELINE_CLOUD_RUN_OPERATIONS)[number];

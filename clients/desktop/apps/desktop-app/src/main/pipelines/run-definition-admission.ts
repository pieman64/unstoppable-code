import {
  createPipelineDefinitionService,
  type PipelineDefinitionService,
} from '@canopy/core-runtime/node/pipeline';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { PipelineDefinition } from '@canopy/protocol/canopy-core';
import {
  createStoredPipelineDefinitionPort,
  localPipelineNormalizeOptions,
} from '@canopy/desktop-shared/node/pipelines/definition-sources';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';

export interface AdmittedRunDefinition {
  /** The validated document the run executes and snapshots. */
  readonly pipeline: Pipeline;
  readonly definition: PipelineDefinition;
}

let admission: PipelineDefinitionService | undefined;

/**
 * Core's resolution and validation over the stored definitions, without the
 * navigation context's visibility filter: the start path authorizes a run
 * against its own owner before it is admitted. This in-process call stands
 * in for `core.pipeline.definition.get`, whose desktop binding filters by the
 * selected navigation context and has no owner-scoped read; it is recorded
 * compatibility debt (CAN-4139-core-pipeline-run-admission.yaml, CAN-4140).
 */
function admissionService(): PipelineDefinitionService {
  admission ??= createPipelineDefinitionService({
    ports: [createStoredPipelineDefinitionPort()],
    normalizeOptions: localPipelineNormalizeOptions,
  });
  return admission;
}

/**
 * The validated definition a stored (user or bundled) run executes, resolved
 * by core rather than taken from the caller. `null` when core has no such
 * definition, as for an inline one. A stored definition that no longer
 * validates refuses the run with its first diagnostic.
 */
export async function admitStoredRunDefinition(
  definitionId: string,
): Promise<AdmittedRunDefinition | null> {
  let definition: PipelineDefinition;
  try {
    definition = await admissionService().get(
      definitionId,
      {},
      new AbortController().signal,
    );
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.payload.code === 'core.pipeline.definitionNotFound'
    )
      return null;
    throw error instanceof CanopyOperationError
      ? new Error(error.payload.message)
      : error;
  }
  const diagnostic = definition.diagnostics.find(
    (entry) => entry.severity === 'error',
  );
  if (diagnostic) throw new Error(diagnostic.message);
  return { pipeline: parsePipelineText(definition.document), definition };
}

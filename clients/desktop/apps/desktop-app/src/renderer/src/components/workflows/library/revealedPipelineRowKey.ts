import type { WorkflowLibraryTarget } from './useWorkflowLibraryRows';

/**
 * The Library row of a local pipeline, by id. Ids are unique per source only,
 * so a project file with the same id never stands in for the installed copy.
 */
export function revealedPipelineRowKey(
  targets: ReadonlyMap<string, WorkflowLibraryTarget>,
  pipelineId: string,
): string | null {
  for (const [key, target] of Array.from(targets)) {
    if (
      target.kind === 'pipeline' &&
      target.pipeline.id === pipelineId &&
      target.pipeline.source !== 'project'
    ) {
      return key;
    }
  }
  return null;
}

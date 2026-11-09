import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';

/** A row of the owned pipelines table: local pipelines and shared references. */
export type PipelineCatalogEntry = PipelineInfo;

/**
 * The stable identity of a catalog template, as recorded in the disabled
 * pipelines preference and resolved by launch pickers.
 */
export function curatedPipelineId(key: string): string {
  return `curated:${key}`;
}

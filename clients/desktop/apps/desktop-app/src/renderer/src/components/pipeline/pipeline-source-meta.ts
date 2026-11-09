import type { PipelineInfo } from '@canopy/execution-engine/types/pipeline';
import {
  PIPELINE_FILTER_SOURCES,
  PIPELINE_SOURCE_LABELS,
  pipelineSourceBadgeClassName,
} from '@canopy/ui-shared/lib';

export type PipelineSource = PipelineInfo['source'] | 'curated';

interface SourceMeta {
  label: string;
  badgeClass: string;
}

/**
 * Display metadata for each pipeline source. Used by the source badge column
 * and the source filter dropdown so labels stay in sync. The badge tones come
 * from the shared `pipelineSourceBadgeClassName` map so the trigger modal,
 * hook editor and the web plan-pipeline dialog paint the same origin alike.
 */
export const PIPELINE_SOURCE_META: Record<PipelineSource, SourceMeta> = {
  curated: {
    label: PIPELINE_SOURCE_LABELS.curated,
    badgeClass: pipelineSourceBadgeClassName('curated'),
  },
  user: {
    label: PIPELINE_SOURCE_LABELS.user,
    badgeClass: pipelineSourceBadgeClassName('user'),
  },
  project: {
    label: PIPELINE_SOURCE_LABELS.project,
    badgeClass: pipelineSourceBadgeClassName('project'),
  },
  bundled: {
    label: PIPELINE_SOURCE_LABELS.bundled,
    badgeClass: pipelineSourceBadgeClassName('bundled'),
  },
  shared: {
    label: PIPELINE_SOURCE_LABELS.shared,
    badgeClass: pipelineSourceBadgeClassName('shared'),
  },
};

/**
 * Source order used to render the source filter dropdown.
 */
export const PIPELINE_SOURCES: readonly PipelineSource[] =
  PIPELINE_FILTER_SOURCES;

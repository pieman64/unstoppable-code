import type { PipelineExecutionScope } from '@canopy/execution-engine/types/pipeline';
import { PIPELINE_EXECUTION_SCOPE_LABELS } from '@canopy/ui-shared/lib';
import { brandText } from '@/lib/brand';

export interface PipelineExecutionScopeMeta {
  label: string;
  description: string;
}

/**
 * Display metadata for each pipeline execution scope. Shared by the pipelines
 * table and every other surface that badges a pipeline's scopes so the labels
 * and descriptions stay in sync.
 */
export const PIPELINE_EXECUTION_SCOPE_META: Record<
  PipelineExecutionScope,
  PipelineExecutionScopeMeta
> = {
  global: {
    label: PIPELINE_EXECUTION_SCOPE_LABELS.global,
    description: 'Runs outside a directory or worktree context.',
  },
  directory: {
    label: PIPELINE_EXECUTION_SCOPE_LABELS.directory,
    description:
      'Runs from a filesystem directory. Legacy workflows default here.',
  },
  worktree: {
    label: PIPELINE_EXECUTION_SCOPE_LABELS.worktree,
    description: `Runs against a ${brandText.appName} project worktree.`,
  },
};

/** Shared chrome for an execution-scope badge, interactive or static. */
export const PIPELINE_EXECUTION_SCOPE_BADGE_CLASS =
  'shrink-0 inline-flex items-center justify-center rounded bg-secondary px-1.5 py-0.5 text-3xs font-medium fg-secondary';

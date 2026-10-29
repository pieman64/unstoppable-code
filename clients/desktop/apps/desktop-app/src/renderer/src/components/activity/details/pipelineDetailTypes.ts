/**
 * Shared contracts for the pipeline execution detail body and its hosts (the
 * compatibility modal, the archived viewer, and the pipeline execution panel).
 */
import type {
  PipelineDetailsDefinitionTarget,
  PipelineDetailsSelection,
} from './PipelineDetailsNav';

/** One level of the child-pipeline breadcrumb stack under a bound root run. */
export interface BreadcrumbEntry {
  executionId: string;
  label: string;
}

/**
 * Read-only archived-container source. Execution state, reports, and step
 * logs are read through the container-scoped `window.api.archivedContainers`
 * transport, never the live pipeline store or `window.pipelines`.
 */
export interface ArchivedPipelineSource {
  projectId: string;
  containerId: string;
}

/** Which view of a bound root run to show. */
export interface PipelineExecutionDetailTarget {
  /** Child breadcrumb stack under the bound root; omitted shows the root. */
  viewStack?: readonly BreadcrumbEntry[];
  /** Job to select; omitted shows the run Summary. */
  jobId?: string;
  /** Physical matrix variant under `jobId`. */
  variantJobId?: string;
  /**
   * Opens a run-level entry instead of a job. `cost` is the Cost entry (a run
   * opened from the Cost panel); it is ignored while the run has no cost, and
   * the run then opens at its Summary. `definition` is Definition used, the
   * definition the run started with. Wins over `jobId` when both are set.
   */
  entry?: 'cost' | 'definition';
}

/**
 * An explicit target for an already-mounted detail. The detail applies it
 * whenever `nonce` changes, so re-opening the same run at another job or
 * breadcrumb updates the visible view instead of being ignored.
 */
export interface PipelineExecutionDetailRevealTarget extends PipelineExecutionDetailTarget {
  nonce: string | number;
}

/**
 * A surface the detail sent the user to. Hosts that cover the app (the
 * modal) close when told about one; panel hosts ignore it, because opening
 * another surface never closes a pipeline tab.
 */
export type PipelineDetailDestination =
  | 'worker'
  | 'definition'
  | 'plan'
  | 'chat'
  | 'report-chat'
  | 'debug'
  | 'pipeline-follow-up'
  | 'report';

/** The nav selection is the run's Definition used entry. */
export function isPipelineDetailsDefinitionSelection(
  selection: PipelineDetailsSelection,
): selection is PipelineDetailsDefinitionTarget {
  return (
    selection !== null &&
    'entry' in selection &&
    selection.entry === 'definition'
  );
}

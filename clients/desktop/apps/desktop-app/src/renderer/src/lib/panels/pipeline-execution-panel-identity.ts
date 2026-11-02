/**
 * Pure `pipeline-execution` panel identity helpers, kept apart from the
 * registry and placement modules (the `browser-panel-identity.ts` pattern) so
 * callers that only need a deterministic id or seed do not pull the panel
 * registry and persistence graph into their bundle or tests.
 */
import type { ChatTabPanelSeed } from './chat-panel-binding';

/** Default tab title for a run panel (also the registry's kind title). */
export const PIPELINE_EXECUTION_PANEL_TITLE = 'Workflow run';

/**
 * Deterministic panel id for a run's panel, mirroring
 * `panel-browser-<browserId>`. Execution ids are UUIDs today; any other
 * character is folded to `_` so the id stays safe inside `data-testid`
 * selectors. Folding can collide in theory, so placement retries with a
 * generated id when the deterministic one is taken (identity is the
 * `pipeline-execution:<executionId>` instance key, never the panel id).
 */
export function pipelineExecutionPanelIdFor(executionId: string): string {
  return `panel-pipeline-${executionId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** The placement seed for one run's panel. */
export function pipelineExecutionPanelSeed(
  executionId: string,
): ChatTabPanelSeed {
  return {
    kind: 'pipeline-execution',
    panelId: pipelineExecutionPanelIdFor(executionId),
    title: PIPELINE_EXECUTION_PANEL_TITLE,
    instance: { executionId },
  };
}

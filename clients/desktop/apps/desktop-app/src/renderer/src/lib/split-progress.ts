import type { ProgressChecklistStep } from '@canopy/ui-shared/components';
import type {
  SplitPrPhase,
  SplitPrProgressEvent,
} from '@canopy/desktop-shared/types/github';

export const SPLIT_PR_PHASE_LABELS: Record<SplitPrPhase, string> = {
  gathering_diff: 'Gathering PR diff',
  planning: 'Planning split',
  creating_integration_branch: 'Creating integration branch',
  running_setup: 'Running worktree setup',
  carving_child: 'Carving child branch',
  verifying_child: 'Verifying child',
  opening_child_pr: 'Opening child PR',
  reconstructing_tip: 'Reconstructing original tip',
  opening_integration_pr: 'Opening integration PR',
  updating_pr_bodies: 'Updating PR descriptions',
  retargeting_original: 'Retargeting original PR',
  retargeting_dependents: 'Retargeting dependent PRs',
  closing_original: 'Closing original PR',
  done: 'Done',
  error: 'Error',
  cancelled: 'Cancelled',
};

/**
 * A one-line "what is currently running" status for the sidebar split badge
 * tooltip: the label (with child progress suffix) of the most recent
 * non-terminal phase event, or `null` when the feed has no in-flight phase yet.
 * Mirrors the row-label derivation in {@link buildSplitProgressView} so the
 * tooltip and the execute checklist read the same phase names.
 */
export function buildSplitRunningStatusLine(
  events: SplitPrProgressEvent[],
): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (
      event.phase === 'done' ||
      event.phase === 'error' ||
      event.phase === 'cancelled'
    ) {
      continue;
    }
    const childSuffix =
      event.childIndex !== undefined && event.childTotal !== undefined
        ? ` (${event.childIndex}/${event.childTotal})`
        : '';
    return `${SPLIT_PR_PHASE_LABELS[event.phase]}${childSuffix}`;
  }
  return null;
}

export type SplitTerminal = 'done' | 'error' | 'cancelled' | null;

export interface SplitProgressView {
  rows: ProgressChecklistStep[];
  terminal: SplitTerminal;
  errorText?: string;
}

/**
 * Builds checklist rows from the ordered split progress event feed. Per-child
 * phases repeat once per child, so rows are keyed by phase + child index and
 * grow as the run advances (mirroring the event feed) rather than being a
 * fixed phase list. The last row reflects the live state: active while the
 * run is in flight, error when the run failed.
 *
 * Shared by `PullRequestSection`'s progress overlay and `SplitWorkflowView`'s
 * embedded execute step so the per-child checklist is derived from one place.
 */
export function buildSplitProgressView(
  events: SplitPrProgressEvent[],
  isSplitting: boolean,
): SplitProgressView {
  const rowOrder: string[] = [];
  const rowLabels = new Map<string, string>();
  let terminal: SplitTerminal = null;
  let errorText: string | undefined;

  for (const event of events) {
    if (
      event.phase === 'done' ||
      event.phase === 'error' ||
      event.phase === 'cancelled'
    ) {
      terminal = event.phase;
      if (event.phase === 'error') {
        const parts = [event.message, event.error].filter(
          (part): part is string => typeof part === 'string' && part.length > 0,
        );
        errorText = parts.length > 0 ? parts.join('\n') : 'Split failed';
      }
      continue;
    }
    const rowKey =
      event.childIndex !== undefined
        ? `${event.phase}-${event.childIndex}`
        : event.phase;
    const childSuffix =
      event.childIndex !== undefined && event.childTotal !== undefined
        ? ` (${event.childIndex}/${event.childTotal})`
        : '';
    if (!rowLabels.has(rowKey)) {
      rowOrder.push(rowKey);
    }
    rowLabels.set(
      rowKey,
      `${SPLIT_PR_PHASE_LABELS[event.phase]}${childSuffix}`,
    );
  }

  const rows: ProgressChecklistStep[] = rowOrder.map((rowKey, index) => {
    const isLast = index === rowOrder.length - 1;
    let status: ProgressChecklistStep['status'] = 'completed';
    if (isLast && terminal === 'error') {
      status = 'error';
    } else if (isLast && terminal === null) {
      status = isSplitting ? 'active' : 'pending';
    }
    return { key: rowKey, label: rowLabels.get(rowKey) ?? rowKey, status };
  });

  return { rows, terminal, errorText };
}

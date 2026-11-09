import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowRunRow } from '@canopy/ui-app/workflows';
import { automationRunKey } from '@/lib/workflows/run-feed';
import { useNavigationStore } from '@/stores/navigationStore';

/**
 * The automation run an opener asked to see (a chat's run tile, a Runs row's
 * Open workflow), when it belongs to one of `isListed`'s records.
 */
export function useRequestedAutomationRun(
  isListed: (activityId: string) => boolean,
): { readonly activityId: string; readonly runId: string } | undefined {
  return useNavigationStore((state) => {
    const focus = state.pendingAutomationRunFocus;
    return focus && isListed(focus.activityId) ? focus : undefined;
  });
}

export interface AutomationRunHighlightOptions {
  readonly runId: string | undefined;
  readonly rows: readonly WorkflowRunRow[];
  /** The feed is loading or loading more. */
  readonly feedBusy: boolean;
  readonly hasMore: boolean;
  /** The row actions' dialog anchor, which shares the section's node. */
  readonly dialogAnchorRef: (node: HTMLDivElement | null) => void;
}

/**
 * Selects a requested run once it is listed, scrolls to it and focuses it;
 * a run that aged out of the history leaves Runs open without a selection.
 * Either way the request is consumed.
 */
export function useAutomationRunHighlight({
  runId,
  rows,
  feedBusy,
  hasMore,
  dialogAnchorRef,
}: AutomationRunHighlightOptions): {
  readonly highlightedKey: string | null;
  readonly setSectionRef: (node: HTMLDivElement | null) => void;
} {
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const setSectionRef = useCallback(
    (node: HTMLDivElement | null): void => {
      sectionRef.current = node;
      dialogAnchorRef(node);
    },
    [dialogAnchorRef],
  );
  useEffect(() => {
    if (runId === undefined) return;
    const key = automationRunKey(runId);
    const listed = rows.some((row) => row.key === key);
    // A completed batch can still leave another page or a retryable failure.
    const historySettled = !feedBusy && !hasMore;
    if (!listed && !historySettled) return;
    if (!listed) {
      useNavigationStore.getState().consumeAutomationRunFocus();
      return;
    }
    if (highlightedKey !== key) {
      setHighlightedKey(key);
      return;
    }
    // The highlight reveals a loaded row past the table's render limit.
    // Retry after that render before consuming the request.
    const row = Array.from(
      sectionRef.current?.querySelectorAll<HTMLElement>('[data-run-key]') ?? [],
    ).find((candidate) => candidate.dataset.runKey === key);
    if (!row) return;
    useNavigationStore.getState().consumeAutomationRunFocus();
    row.scrollIntoView?.({ block: 'nearest' });
    row.focus({ preventScroll: true });
  }, [feedBusy, runId, hasMore, highlightedKey, rows]);
  return { highlightedKey, setSectionRef };
}

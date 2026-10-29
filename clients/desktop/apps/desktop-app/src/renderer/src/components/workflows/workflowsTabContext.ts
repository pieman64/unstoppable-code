import { createContext, useContext, useEffect } from 'react';
import type { WorkflowsTabId } from '@canopy/ui-shared/lib';

export interface WorkflowsTabContextValue {
  readonly tab: WorkflowsTabId;
  /**
   * The tab a keyboard change is moving to. Each panel renders its own tab
   * bar, so the bar that mounts showing this tab takes focus and clears it;
   * `WorkflowsPage` clears it once any other tab is showing.
   */
  readonly keyboardTarget: { current: WorkflowsTabId | null };
}

/** The Workflows tab the page is showing; provided by `WorkflowsPage`. */
export const WorkflowsTabContext =
  createContext<WorkflowsTabContextValue | null>(null);

/**
 * Spends a pending keyboard tab change while `active`. A view that replaces
 * the Workflows header (the pipeline editor) uses it, so a header that mounts
 * later, such as Back to the list, does not take focus for that old change.
 */
export function useClearWorkflowsKeyboardTarget(active: boolean): void {
  const keyboardTarget = useContext(WorkflowsTabContext)?.keyboardTarget;
  useEffect(() => {
    if (active && keyboardTarget) keyboardTarget.current = null;
  }, [active, keyboardTarget]);
}

import { useContext, type JSX, type ReactNode } from 'react';
import {
  WORKFLOWS_TAB_PANEL_ID,
  workflowsTabElementId,
} from '@canopy/ui-shared/components';
import { WorkflowsTabContext } from './workflowsTabContext';

export interface WorkflowsTabPanelProps {
  readonly children: ReactNode;
  /** Layout classes for the panel body. */
  readonly className?: string;
}

/**
 * The body a Workflows tab controls, rendered after `WorkflowsPageHeader` so
 * the tab list and its panel are siblings. Panels without the header (the
 * pipeline editor) leave it out, so no tab points at a missing panel.
 */
export function WorkflowsTabPanel({
  children,
  className,
}: WorkflowsTabPanelProps): JSX.Element {
  const tab = useContext(WorkflowsTabContext)?.tab ?? 'workflows';
  return (
    <div
      role="tabpanel"
      id={WORKFLOWS_TAB_PANEL_ID}
      aria-labelledby={workflowsTabElementId(tab)}
      className={className}
    >
      {children}
    </div>
  );
}

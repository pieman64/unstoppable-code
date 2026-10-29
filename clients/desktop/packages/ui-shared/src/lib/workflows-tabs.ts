/**
 * The Workflows page's tabs (CAN-3981). Each one is its own navigable page on
 * the desktop, so the ids match those page ids. Runs is the landing tab and
 * keeps the bare `workflows` id.
 */
export type WorkflowsTabId =
  | 'workflows'
  | 'workflows-schedule'
  | 'workflows-library';

/** Canonical render order. */
export const WORKFLOWS_TABS: readonly WorkflowsTabId[] = [
  'workflows',
  'workflows-schedule',
  'workflows-library',
];

export const WORKFLOWS_TAB_LABELS: Readonly<Record<WorkflowsTabId, string>> = {
  workflows: 'Runs',
  'workflows-schedule': 'Schedule',
  'workflows-library': 'Library',
};

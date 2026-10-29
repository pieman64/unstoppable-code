import {
  useContext,
  useEffect,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { WorkflowsTabBar } from '@canopy/ui-shared/components';
import type { WorkflowsTabId } from '@canopy/ui-shared/lib';
import { useNavigationStore } from '@/stores/navigationStore';
import { PageHeading } from '../shared/PageHeading';
import { WorkflowsTabContext } from './workflowsTabContext';

export interface WorkflowsPageHeaderProps {
  /** The current tab's own actions, placed beside the heading. */
  readonly actions?: ReactNode;
  /** Counts beside the tab labels, in the selected context. */
  readonly counts?: Readonly<Partial<Record<WorkflowsTabId, number>>>;
}

/**
 * The Workflows heading and its Runs | Schedule | Library tab bar. A view
 * that needs full-page chrome (the pipeline editor) leaves it out.
 */
export function WorkflowsPageHeader({
  actions,
  counts,
}: WorkflowsPageHeaderProps): JSX.Element {
  const context = useContext(WorkflowsTabContext);
  const tab = context?.tab ?? 'workflows';
  const keyboardTarget = context?.keyboardTarget ?? null;
  const navigate = useNavigationStore((s) => s.navigate);
  // Read once: this bar takes focus on mount if a keyboard change brought it.
  const [focusSelectedOnMount] = useState(
    () => keyboardTarget !== null && keyboardTarget.current === tab,
  );
  useEffect(() => {
    if (keyboardTarget?.current === tab) keyboardTarget.current = null;
  }, [keyboardTarget, tab]);
  return (
    <>
      <PageHeading
        title="Workflows"
        subtitle="Chain together prompts and scripts from multiple agents and trigger them on a schedule, when something happens, or manually."
        actions={actions}
      />
      <WorkflowsTabBar
        className="mt-6"
        value={tab}
        counts={counts}
        focusSelectedOnMount={focusSelectedOnMount}
        onChange={(next, source): void => {
          if (next === tab) return;
          if (keyboardTarget) {
            keyboardTarget.current = source === 'keyboard' ? next : null;
          }
          navigate(next);
        }}
      />
    </>
  );
}

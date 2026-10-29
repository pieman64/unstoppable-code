import { lazy, Suspense, useEffect, useMemo, useRef, type JSX } from 'react';
import type { WorkflowsTabId } from '@canopy/ui-shared/lib';
import {
  AUTOMATIONS_OPEN_TAB_EVENT,
  isLegacyAutomationsTab,
  openLegacyAutomationsTab,
} from '@/lib/navigation/workflows-navigation';
import { useNavigationStore } from '@/stores/navigationStore';
import { WorkflowsTabContext } from '../workflows/workflowsTabContext';

const PipelinesPage = lazy(() =>
  import('./PipelinesPage').then((m) => ({ default: m.PipelinesPage })),
);

const AutomationsPage = lazy(() =>
  import('./AutomationsPage').then((m) => ({ default: m.AutomationsPage })),
);

const WorkflowsTabs = lazy(() =>
  import('../workflows/WorkflowsTabs').then((m) => ({
    default: m.WorkflowsTabs,
  })),
);

const WorkflowEditHost = lazy(() =>
  import('../workflows/edit/WorkflowEditHost').then((m) => ({
    default: m.WorkflowEditHost,
  })),
);

export interface WorkflowsPageProps {
  readonly tab: WorkflowsTabId;
}

/**
 * Workflows (CAN-3981): Runs, Schedule and Library. Each tab is its own
 * navigation page. The pipelines and automations hosts own their dialogs and
 * hand their lists to `WorkflowsTabs`, so one element serves all three tabs
 * and switching between them keeps what was loaded. An open item shows in
 * the edit shell (CAN-4072) inside both hosts, in place of the tabs.
 */
export function WorkflowsPage({ tab }: WorkflowsPageProps): JSX.Element {
  const workflowEdit = useNavigationStore((state) => state.workflowEdit);
  const keyboardTarget = useRef<WorkflowsTabId | null>(null);
  const tabContext = useMemo(() => ({ tab, keyboardTarget }), [tab]);
  // A keyboard change is spent once a different tab shows, such as after
  // other navigation, so a later header mount never takes focus for it.
  useEffect(() => {
    if (keyboardTarget.current !== null && keyboardTarget.current !== tab) {
      keyboardTarget.current = null;
    }
  }, [tab]);
  // Compatibility for the pre-Workflows tab event. Callers in the app open
  // tabs through `openLegacyAutomationsTab` directly.
  useEffect(() => {
    const listener = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (typeof detail !== 'object' || detail === null) return;
      const requested: unknown = Reflect.get(detail, 'tab');
      if (isLegacyAutomationsTab(requested)) {
        openLegacyAutomationsTab(requested);
      }
    };
    window.addEventListener(AUTOMATIONS_OPEN_TAB_EVENT, listener);
    return (): void => {
      window.removeEventListener(AUTOMATIONS_OPEN_TAB_EVENT, listener);
    };
  }, []);

  return (
    <WorkflowsTabContext.Provider value={tabContext}>
      <div className="h-full w-full" data-testid="page-workflows">
        <Suspense fallback={null}>
          <PipelinesPage
            assistantEnabled={tab === 'workflows-library'}
            renderList={(pipelines) => (
              <AutomationsPage
                renderBody={(automations) =>
                  // A tab change closes the shell (the navigation store clears
                  // it with the page), after its guard asks about unsaved
                  // edits.
                  workflowEdit ? (
                    <WorkflowEditHost
                      target={workflowEdit}
                      pipelines={pipelines}
                      automations={automations}
                    />
                  ) : (
                    <WorkflowsTabs
                      tab={tab}
                      pipelines={pipelines}
                      automations={automations}
                    />
                  )
                }
              />
            )}
          />
        </Suspense>
      </div>
    </WorkflowsTabContext.Provider>
  );
}

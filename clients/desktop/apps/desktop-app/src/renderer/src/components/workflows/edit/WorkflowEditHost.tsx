import { useLayoutEffect, useMemo, useState, type JSX } from 'react';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
} from '@canopy/ui-shared/components';
import { workflowEditBackLabel } from '@/lib/workflows/edit-back';
import {
  workflowEditKey,
  workflowEditTargetForActivity,
  type WorkflowEditTarget,
} from '@/lib/workflows/edit-target';
import { useNavigationStore } from '@/stores/navigationStore';
import type { AutomationsPageBodyApi } from '../../pages/AutomationsPage';
import type { PipelinesPageListApi } from '../../pages/PipelinesPage';
import { PageContent } from '../../shared/PageContent';
import { PageTitlebar } from '../../shared/PageTitlebar';
import { AutomationEditAdapter } from './AutomationEditAdapter';
import { PipelineEditAdapter } from './PipelineEditAdapter';
import { SharedAutomationEditAdapter } from './SharedAutomationEditAdapter';

export interface WorkflowEditHostProps {
  readonly target: WorkflowEditTarget;
  readonly pipelines: PipelinesPageListApi;
  readonly automations: AutomationsPageBodyApi;
}

/**
 * The Workflows edit shell's host (CAN-4072). It renders inside both page
 * hosts, so the automations store, the Share dialogs and the shared-pipeline
 * review stay available, and keys each adapter by the item so switching items
 * never reuses a draft.
 */
export function WorkflowEditHost({
  target,
  pipelines,
  automations,
}: WorkflowEditHostProps): JSX.Element {
  const targetKey = workflowEditKey(target);
  const section = target.section ?? 'definition';
  const backLabel = workflowEditBackLabel(target);
  // The pipeline that has opened. A later worktree change re-resolves the
  // checkout, but must not unmount an open editor and drop its edits.
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  // CAN-5782: a workflow schedule is edited on its Workflow page, however
  // it was opened (a link, a restored history entry, an agent), so its
  // automation target is replaced there before the Automation page shows.
  const redirect = useMemo(() => {
    if (target.kind !== 'automation') return undefined;
    const activity = automations.activities.find(
      (entry) => entry.id === target.activityId,
    );
    return activity
      ? workflowEditTargetForActivity(activity, {
          ...(target.section !== undefined ? { section: target.section } : {}),
          ...(target.returnTo !== undefined
            ? { returnTo: target.returnTo }
            : {}),
        })
      : undefined;
  }, [automations.activities, target]);
  useLayoutEffect(() => {
    if (redirect) useNavigationStore.getState().replaceWorkflowEdit(redirect);
  }, [redirect]);

  if (redirect) {
    return (
      <div
        className="page-scroll-gutter h-full overflow-auto"
        data-testid="workflow-edit-host"
      >
        <PageTitlebar />
        <DelayedLoadingPlaceholder>
          <div className="py-8">
            <CenteredLoadingSpinner />
          </div>
        </DelayedLoadingPlaceholder>
      </div>
    );
  }

  if (target.kind === 'pipeline') {
    // A project pipeline opens once the selected worktree's checkout is known.
    const pending = target.cwd !== undefined && pipelines.projectContextPending;
    if (!pending && openedKey !== targetKey) setOpenedKey(targetKey);
    const waiting = pending && openedKey !== targetKey;
    return (
      // The same reserved scrollbar width as the automation host, so the
      // centered content does not shift between the two. The editor still
      // scrolls inside itself; this root never overflows.
      <div
        className="page-scroll-gutter flex h-full min-h-0 w-full flex-col overflow-y-auto"
        data-testid="workflow-edit-host"
      >
        <PageTitlebar />
        {/* The Library's width, as an automation opens, so switching items
            never shifts the page; the editor fills the remaining height. */}
        <PageContent
          bottomInset="tight"
          className="flex min-h-0 flex-1 flex-col"
        >
          {waiting ? (
            <DelayedLoadingPlaceholder className="">
              <div className="box-content flex min-h-full flex-1 py-8">
                <CenteredLoadingSpinner className="" />
              </div>
            </DelayedLoadingPlaceholder>
          ) : (
            <PipelineEditAdapter
              key={targetKey}
              target={target}
              targetKey={targetKey}
              section={section}
              backLabel={backLabel}
              pipelines={pipelines}
              automations={automations}
            />
          )}
        </PageContent>
      </div>
    );
  }

  return (
    <div
      className="page-scroll-gutter h-full overflow-auto"
      data-testid="workflow-edit-host"
    >
      <PageTitlebar />
      <PageContent>
        {target.kind === 'shared-automation' ? (
          <SharedAutomationEditAdapter
            key={targetKey}
            targetKey={targetKey}
            remoteId={target.remoteId}
            fallbackName={target.name}
            section={section}
            backLabel={backLabel}
          />
        ) : target.kind === 'automation' ? (
          <AutomationEditAdapter
            key={targetKey}
            kind="automation"
            activityId={target.activityId}
            targetKey={targetKey}
            section={section}
            backLabel={backLabel}
            automations={automations}
          />
        ) : (
          <AutomationEditAdapter
            key={targetKey}
            kind="automation-draft"
            {...(target.seed !== undefined ? { seed: target.seed } : {})}
            targetKey={targetKey}
            section={section}
            backLabel={backLabel}
            automations={automations}
          />
        )}
      </PageContent>
    </div>
  );
}

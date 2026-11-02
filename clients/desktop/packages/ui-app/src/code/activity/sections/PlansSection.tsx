'use client';

import type { JSX } from 'react';
import type { PortalPlan } from '@canopy/protocol/portal';
import { isCursorPlanExecutionUnavailable } from '@canopy/app-core/client';
import {
  Button,
  Markdown,
  PlanActionButtonRow,
  PlanCopyAction,
  PlanReviewStatusBadge,
  planCopyStateFromMarkdown,
  PlanProvenance,
  hasPlanProvenance,
  markdownOptions,
  type MarkdownOverrides,
  type PlanActionButtonRowItem,
} from '@canopy/ui-shared/components';
import { ChatIcon, DocumentIcon, PipelineIcon } from '@canopy/ui-shared/icons';
import { resolvePlanDisplayStatus } from '@canopy/ui-shared/lib';
import { PlansEmptyMessage } from '../plans/PlansEmptyMessage';

export const PLAN_MARKDOWN_COMPONENTS: MarkdownOverrides = {
  a({ children }): JSX.Element {
    return <span>{children}</span>;
  },
};
const INLINE_PLAN_MARKDOWN_COMPONENTS: MarkdownOverrides = {
  p({ children }): JSX.Element {
    return <>{children}</>;
  },
  a({ children }): JSX.Element {
    return <span>{children}</span>;
  },
};
const PLAN_MARKDOWN_OPTIONS = markdownOptions(PLAN_MARKDOWN_COMPONENTS);
const INLINE_PLAN_MARKDOWN_OPTIONS = markdownOptions(
  INLINE_PLAN_MARKDOWN_COMPONENTS,
);

export function stripPlanTitleLine(content: string | undefined): string {
  if (!content) return '';
  const lines = content.split('\n');
  const index = lines.findIndex((line) => line.trim().length > 0);
  if (index < 0) return content;
  // Only drop a markdown heading title; plans that open with plain prose keep
  // their first line in the preview.
  if (!/^#{1,6}\s/.test(lines[index].trim())) return content;
  return lines
    .slice(index + 1)
    .join('\n')
    .trimStart();
}

export interface PlansSectionProps {
  readonly plans: readonly PortalPlan[];
  readonly onGetPlan?: (plan: PortalPlan) => void;
  readonly onImplementPlan?: (plan: PortalPlan) => void;
  /**
   * Hand the finished plan to a `plan_ready` pipeline (CAN-3019). Desktop
   * overrides this section body entirely, so this action is web-only today.
   */
  readonly onRunPlanPipeline?: (plan: PortalPlan) => void;
  /**
   * Open the host's plan import. Without it the empty state only explains
   * where plans come from; no web host can import yet.
   */
  readonly onImportPlan?: () => void;
}

function PlanCard({
  plan,
  onGetPlan,
  onImplementPlan,
  onRunPlanPipeline,
}: PlansSectionProps & { readonly plan: PortalPlan }): JSX.Element {
  const body = stripPlanTitleLine(plan.content);
  const revision = plan.revisionNumber ?? plan.latestRevisionNumber;
  // List summaries carry the stored review in `status`; loaded details also
  // supply `reviewStatus`. Both are projections of the same review enum.
  const reviewStatus =
    plan.reviewStatus ??
    (plan.status === 'pending' ||
    plan.status === 'approved' ||
    plan.status === 'dismissed'
      ? plan.status
      : undefined);
  const executionUnavailable = isCursorPlanExecutionUnavailable(plan);
  const actions: PlanActionButtonRowItem[] = [];
  if (plan.content && onImplementPlan && !executionUnavailable) {
    actions.push({
      label: 'Implement',
      icon: <ChatIcon width={13} height={13} aria-hidden="true" />,
      onClick: (): void => onImplementPlan(plan),
      dataTestId: `activity-plan-send-${plan.localId ?? plan.title}`,
    });
  }
  // After Implement, behind the same `plan.content` gate Implement
  // uses: a pipeline receives the plan body, so an unloaded plan has nothing
  // to dispatch. The label must stay unique — `PlanActionButtonRow` keys on it.
  if (plan.content && onRunPlanPipeline && !executionUnavailable) {
    actions.push({
      label: 'Workflow',
      icon: <PipelineIcon width={13} height={13} aria-hidden="true" />,
      onClick: (): void => onRunPlanPipeline(plan),
      dataTestId: `activity-plan-pipeline-${plan.localId ?? plan.title}`,
    });
  }
  // Copy plan is the shared action desktop's plan header and card use too
  // (CAN-5354); an unloaded plan keeps Copy visible beside Load.
  const copyAction = (
    <PlanCopyAction
      state={planCopyStateFromMarkdown(plan.content)}
      appearance="card"
      dataTestId={`activity-plan-copy-${plan.localId ?? plan.title}`}
    />
  );
  if (!plan.content && onGetPlan) {
    actions.push({
      label: 'Load',
      icon: <DocumentIcon width={13} height={13} aria-hidden="true" />,
      onClick: (): void => onGetPlan(plan),
    });
  }
  return (
    <div
      data-testid={`activity-plan-row-${plan.localId ?? plan.title}`}
      className="group/plan relative w-full rounded-lg border bg-fg-primary/[0.03] p-3 text-left transition-colors hover:bg-fg-primary/[0.06]"
    >
      <div className="truncate text-s font-semibold fg-primary">
        <Markdown options={INLINE_PLAN_MARKDOWN_OPTIONS}>{plan.title}</Markdown>
      </div>
      {body && (
        <div
          className="prose prose-sm mt-1 line-clamp-3 max-w-none text-xs leading-5 fg-secondary"
          data-testid={`activity-plan-body-${plan.localId ?? plan.title}`}
        >
          <Markdown options={PLAN_MARKDOWN_OPTIONS}>{body}</Markdown>
        </div>
      )}
      <div className="mt-2 flex items-center gap-3 text-2xs fg-secondary">
        {typeof revision === 'number' && (
          <span
            className="shrink-0 rounded-full bg-fg-primary/[0.05] px-1.5 py-0.5 text-3xs font-medium"
            data-testid={`activity-plan-revision-${plan.localId ?? plan.title}`}
          >
            Rev {revision}
          </span>
        )}
        {plan.status && plan.status !== reviewStatus && (
          <span className="shrink-0">{plan.status}</span>
        )}
        {/* The Portal projection carries no execution evidence, so web shows
            the stored review status only (never Implementing/Implemented). */}
        <PlanReviewStatusBadge
          className="shrink-0"
          status={resolvePlanDisplayStatus({ reviewStatus })}
          data-testid={`activity-plan-status-${plan.localId ?? plan.title}`}
        />
        {hasPlanProvenance(plan.source, plan.sourceFilePath) ? (
          <PlanProvenance
            source={plan.source}
            sourceFilePath={plan.sourceFilePath}
          />
        ) : (
          plan.source && <span className="fg-secondary/60">{plan.source}</span>
        )}
      </div>
      {(actions.length > 0 || copyAction) && (
        <PlanActionButtonRow items={actions} trailing={copyAction} />
      )}
    </div>
  );
}

export function PlansSection(props: PlansSectionProps): JSX.Element {
  if (props.plans.length === 0) {
    const { onImportPlan } = props;
    return (
      <div className="space-y-2" data-testid="activity-plans-empty">
        <PlansEmptyMessage canImport={onImportPlan !== undefined} />
        {onImportPlan && (
          <Button
            variant="secondary"
            size="compact"
            data-testid="activity-plans-empty-import"
            onClick={onImportPlan}
          >
            Import plan
          </Button>
        )}
      </div>
    );
  }
  return (
    <div
      className="max-h-76 space-y-2 overflow-y-auto"
      data-testid="activity-plans"
    >
      {props.plans.map((plan) => (
        <PlanCard key={plan.localId ?? plan.title} {...props} plan={plan} />
      ))}
    </div>
  );
}

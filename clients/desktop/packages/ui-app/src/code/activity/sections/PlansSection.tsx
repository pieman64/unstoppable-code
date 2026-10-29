'use client';

import { useState, type JSX } from 'react';
import type { PortalPlan } from '@canopy/protocol/portal';
import { isCursorPlanExecutionUnavailable } from '@canopy/app-core/client';
import {
  Markdown,
  PlanActionButtonRow,
  markdownOptions,
  type MarkdownOverrides,
  type PlanActionButtonRowItem,
} from '@canopy/ui-shared/components';
import {
  ChatIcon,
  CopyIcon,
  DocumentIcon,
  PipelineIcon,
} from '@canopy/ui-shared/icons';

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

export async function copyPlanToClipboard(content: string): Promise<void> {
  await navigator.clipboard.writeText(content);
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
}

function PlanCard({
  plan,
  onGetPlan,
  onImplementPlan,
  onRunPlanPipeline,
}: PlansSectionProps & { readonly plan: PortalPlan }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const body = stripPlanTitleLine(plan.content);
  const revision = plan.revisionNumber ?? plan.latestRevisionNumber;
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
  // Between Implement and Copy, behind the same `plan.content` gate Implement
  // uses: a pipeline receives the plan body, so an unloaded plan has nothing
  // to dispatch. The label must stay unique — `PlanActionButtonRow` keys on it.
  if (plan.content && onRunPlanPipeline && !executionUnavailable) {
    actions.push({
      label: 'Pipeline',
      icon: <PipelineIcon width={13} height={13} aria-hidden="true" />,
      onClick: (): void => onRunPlanPipeline(plan),
      dataTestId: `activity-plan-pipeline-${plan.localId ?? plan.title}`,
    });
  }
  if (plan.content) {
    actions.push({
      label: copied ? 'Copied' : 'Copy',
      icon: <CopyIcon width={13} height={13} aria-hidden="true" />,
      onClick: (): void => {
        void copyPlanToClipboard(plan.content ?? '')
          .then(() => {
            setCopied(true);
            setTimeout((): void => setCopied(false), 1_500);
          })
          .catch((): void => undefined);
      },
      dataTestId: `activity-plan-copy-${plan.localId ?? plan.title}`,
    });
  } else if (onGetPlan) {
    actions.push({
      label: 'Load',
      icon: <DocumentIcon width={13} height={13} aria-hidden="true" />,
      onClick: (): void => onGetPlan(plan),
    });
  }
  return (
    <div
      data-testid={`activity-plan-row-${plan.localId ?? plan.title}`}
      className="group/plan relative w-full rounded-lg border bg-fg-primary/[0.03] p-3 text-left transition hover:bg-fg-primary/[0.06]"
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
            className="rounded-full bg-fg-primary/[0.05] px-1.5 py-0.5 text-3xs font-medium "
            data-testid={`activity-plan-revision-${plan.localId ?? plan.title}`}
          >
            Rev {revision}
          </span>
        )}
        {plan.status && <span>{plan.status}</span>}
        {plan.reviewStatus && <span>{plan.reviewStatus}</span>}
        {plan.source && <span className="fg-secondary/60">{plan.source}</span>}
      </div>
      {actions.length > 0 && <PlanActionButtonRow items={actions} />}
    </div>
  );
}

export function PlansSection(props: PlansSectionProps): JSX.Element {
  if (props.plans.length === 0)
    return (
      <p className="text-xs fg-secondary" data-testid="activity-plans-empty">
        No plans.
      </p>
    );
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

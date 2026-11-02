import type {
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
import {
  describeAutomationAction,
  getAutomationTriggerLabel,
  type AutomationActionNameResolver,
} from '@canopy/desktop-shared/lib/automations';
import type { UnifiedLocalAutomationInput } from '@canopy/ui-app/capability';
import type { WorkflowLastRun } from '@canopy/ui-shared/lib';
import {
  automationTrigger,
  compactAutomationTrigger,
} from './workflows/library-projection';

/** Run state for the Customize Workflows row facets (CAN-4845). */
export interface MarketplaceAutomationRunContext {
  readonly recentRuns: readonly ScheduledActivityRun[];
  readonly locale?: string;
}

function automationLastRun(
  activity: ScheduledActivity,
  recentRuns: readonly ScheduledActivityRun[],
): WorkflowLastRun | null {
  if (
    recentRuns.some(
      (run) => run.activityId === activity.id && run.status === 'running',
    )
  ) {
    return { state: 'running' };
  }
  for (const run of recentRuns) {
    if (run.activityId !== activity.id) continue;
    const { status } = run;
    // A missed occurrence never ran, so it says nothing about the last run.
    if (status === 'running' || status === 'missed') continue;
    const at = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
    return {
      state: status,
      ...(Number.isFinite(at) ? { at } : {}),
      ...((run.error ?? run.ifCommandError)
        ? { errorMessage: run.error ?? run.ifCommandError }
        : {}),
    };
  }
  if (!activity.lastResult) return null;
  const at = Date.parse(activity.lastResult.completedAt);
  return {
    state: activity.lastResult.status,
    ...(Number.isFinite(at) ? { at } : {}),
  };
}

/**
 * Project a local automation onto the Marketplace's structural row. The
 * description says when it runs and what it does, the same two facts the
 * Automations list leads with. With run context, the row also carries the
 * Customize Workflows facets: schedule, action, last run and on/off.
 */
export function toMarketplaceLocalAutomation(
  activity: ScheduledActivity,
  nameResolver: AutomationActionNameResolver = {},
  context?: MarketplaceAutomationRunContext,
): UnifiedLocalAutomationInput {
  const action = describeAutomationAction(activity.action, nameResolver);
  const trigger = context
    ? automationTrigger(activity, context.locale)
    : undefined;
  return {
    id: activity.id,
    name: activity.name,
    description: `${getAutomationTriggerLabel(activity.schedule)} · ${action}`,
    ...(activity.remote ? { sharedRemoteId: activity.remote.remoteId } : {}),
    ...(activity.installedFrom
      ? {
          installedFrom: {
            remoteId: activity.installedFrom.remoteId,
            contentHash: activity.installedFrom.contentHash,
            ...(activity.installedFrom.sourceKind
              ? { sourceKind: activity.installedFrom.sourceKind }
              : {}),
          },
        }
      : {}),
    ...(context
      ? {
          workflow: {
            ...(trigger
              ? {
                  schedule: {
                    label: compactAutomationTrigger(trigger),
                    tooltip: trigger.text,
                  },
                }
              : {}),
            summary: action,
            lastRun: automationLastRun(activity, context.recentRuns),
            enabled: activity.enabled,
          },
        }
      : {}),
  };
}

export function toMarketplaceLocalAutomations(
  activities: readonly ScheduledActivity[],
  nameResolver: AutomationActionNameResolver = {},
  context?: MarketplaceAutomationRunContext,
): UnifiedLocalAutomationInput[] {
  return activities.map((activity) =>
    toMarketplaceLocalAutomation(activity, nameResolver, context),
  );
}

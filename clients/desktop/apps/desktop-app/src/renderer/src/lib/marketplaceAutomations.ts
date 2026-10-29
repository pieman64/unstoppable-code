import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  describeAutomationAction,
  getAutomationTriggerLabel,
  type AutomationActionNameResolver,
} from '@canopy/desktop-shared/lib/automations';
import type { UnifiedLocalAutomationInput } from '@canopy/ui-app/capability';

/**
 * Project a local automation onto the Marketplace's structural row. The
 * description says when it runs and what it does, the same two facts the
 * Automations list leads with.
 */
export function toMarketplaceLocalAutomation(
  activity: ScheduledActivity,
  nameResolver: AutomationActionNameResolver = {},
): UnifiedLocalAutomationInput {
  return {
    id: activity.id,
    name: activity.name,
    description: `${getAutomationTriggerLabel(activity.schedule)} · ${describeAutomationAction(activity.action, nameResolver)}`,
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
  };
}

export function toMarketplaceLocalAutomations(
  activities: readonly ScheduledActivity[],
  nameResolver: AutomationActionNameResolver = {},
): UnifiedLocalAutomationInput[] {
  return activities.map((activity) =>
    toMarketplaceLocalAutomation(activity, nameResolver),
  );
}

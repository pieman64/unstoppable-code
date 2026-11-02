import type { ScheduledActivity } from '@canopy/desktop-shared/types';

/**
 * An automation as main stores and runs it (CAN-4551). The automations list
 * shows a converted chat automation as its chat action; sharing publishes
 * what actually runs, its owned workflow, so it reads this instead.
 */
export function storedAutomationActivity(
  activity: ScheduledActivity,
): ScheduledActivity {
  const { ownedPipeline, ...stored } = activity;
  return ownedPipeline
    ? { ...stored, action: ownedPipeline.storedAction }
    : activity;
}

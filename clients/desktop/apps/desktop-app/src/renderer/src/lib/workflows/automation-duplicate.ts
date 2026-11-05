import type {
  AutomationCreateRequest,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';

/**
 * Whether the Library offers Duplicate on an automation. A usage-limit resume
 * binds to one local execution. A converted automation whose workflow was
 * edited by hand runs that workflow, which the original owns and deletes
 * with itself, so a copy could not run on its own. An install with a
 * capability package runs with the package overlay main registered for the
 * original's id; a copy would run without its packaged skills and plugins.
 */
export function canDuplicateAutomation(activity: ScheduledActivity): boolean {
  if (activity.action.type === 'pipeline_execution_resume') return false;
  if (activity.installedFrom?.capabilityPackage !== undefined) return false;
  return activity.ownedPipeline?.chatEditable !== false;
}

/**
 * The create request for an automation's copy: its trigger, action, gate and
 * run restriction under `<name> (Copy)`, as pipeline copies are named. The
 * copy starts off so it never fires on the original's schedule before it is
 * reviewed. A converted chat automation is sent as its chat action, so main
 * gives the copy a workflow of its own. Share, install and run history stay
 * with the original.
 */
export function automationDuplicateRequest(
  activity: ScheduledActivity,
): AutomationCreateRequest {
  return {
    name: `${activity.name} (Copy)`,
    schedule: activity.schedule,
    action: activity.action,
    enabled: false,
    ...(activity.ifCommand !== undefined
      ? { ifCommand: activity.ifCommand }
      : {}),
    ...(activity.dependencies !== undefined
      ? { dependencies: activity.dependencies }
      : {}),
    ...(activity.targetRequirement !== undefined &&
    activity.targetRequirementCleared !== true
      ? { targetRequirement: activity.targetRequirement }
      : {}),
  };
}

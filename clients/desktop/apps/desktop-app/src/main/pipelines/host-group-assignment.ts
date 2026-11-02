/**
 * Named-group assignment for pipeline host steps that create a task. Group
 * problems never fail the step (D12): a refusal becomes its code and any
 * other error `group_assignment_failed`. Group names are user text and are
 * never logged.
 */
import type { SidebarItemGroupScope } from '@canopy/protocol/sidebar';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  sidebarItemGroupsService,
  SidebarItemGroupRefusalError,
} from '../services/sidebar-item-groups-service';

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** `{ group_id, group_created, grouped, not_grouped_reason }`; never throws. */
export async function assignToNamedGroup(
  scope: SidebarItemGroupScope,
  taskId: string,
  name: string,
  /** Log label only, such as `create-project-entry`. */
  label: string,
): Promise<Record<string, string>> {
  try {
    const { group, created } =
      await sidebarItemGroupsService.assignItemToNamedGroup({
        scope,
        itemId: taskId,
        name,
      });
    return {
      group_id: group.id,
      group_created: String(created),
      grouped: 'true',
      not_grouped_reason: '',
    };
  } catch (error) {
    if (!(error instanceof SidebarItemGroupRefusalError)) {
      logMainProcessWarn(`[pipeline-host] ${label} group assignment failed`, {
        errorType: errorType(error),
      });
    }
    return {
      group_id: '',
      group_created: 'false',
      grouped: 'false',
      not_grouped_reason:
        error instanceof SidebarItemGroupRefusalError
          ? error.code
          : 'group_assignment_failed',
    };
  }
}

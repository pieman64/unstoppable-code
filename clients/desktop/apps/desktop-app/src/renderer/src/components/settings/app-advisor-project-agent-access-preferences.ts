import type {
  AppAdvisorProjectAgentAccess,
  ProjectOwnerContext,
} from '@canopy/desktop-shared/types';
import { normalizeAppAdvisorProjectAgentAccess } from '@canopy/desktop-shared/lib/app-advisor-project-agent-access';

export {
  DEFAULT_APP_ADVISOR_PROJECT_AGENT_ACCESS,
  buildAppAdvisorProjectAgentAccessOwnerOptions,
  type AppAdvisorProjectAgentAccessOwnerOption,
} from '@canopy/desktop-shared/lib/app-advisor-project-agent-access';

/** Coerce a possibly absent or malformed value to a fresh, complete preference. */
export function coerceAppAdvisorProjectAgentAccess(
  value: unknown,
): AppAdvisorProjectAgentAccess {
  return normalizeAppAdvisorProjectAgentAccess(value);
}

function projectOwnerEquals(
  left: ProjectOwnerContext,
  right: ProjectOwnerContext | undefined,
): boolean {
  if (!right || left.kind !== right.kind) return false;
  if (left.kind === 'personal') return true;
  return (
    right.kind === 'organization' &&
    left.organizationId === right.organizationId
  );
}

/** Compare access settings by mode and ordered owner identities. */
export function appAdvisorProjectAgentAccessEquals(
  left: AppAdvisorProjectAgentAccess,
  right: AppAdvisorProjectAgentAccess,
): boolean {
  return (
    left.mode === right.mode &&
    left.selectedOwners.length === right.selectedOwners.length &&
    left.selectedOwners.every((owner, index) =>
      projectOwnerEquals(owner, right.selectedOwners[index]),
    )
  );
}

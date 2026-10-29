import type { AppAdvisorProjectAgentAccess } from '@canopy/desktop-shared/types';
import {
  isProjectOwnerAllowedAppAdvisorAccess,
  normalizeAppAdvisorProjectAgentAccess,
} from '@canopy/desktop-shared/lib/app-advisor-project-agent-access';
import { logMainProcessWarn } from './main-process-logging';
import {
  resolveProjectSavedOwner,
  type ProjectOwnerTarget,
  type ResolvedProjectOwner,
} from './project-owner';
import { getWorkspaceContextService } from './workspace-context-service';

/** Typed error code for every App Advisor access refusal. */
export const ADVISOR_ACCESS_DISABLED = 'advisor_access_disabled' as const;

export const ADVISOR_ACCESS_DISABLED_MESSAGE =
  'App Advisor access is turned off for agents in this project. The user controls this in Settings > App Advisor.';

let currentAccess: AppAdvisorProjectAgentAccess =
  normalizeAppAdvisorProjectAgentAccess(undefined);

const accessChangeListeners = new Set<() => void>();

/** Apply the normalized preference; called at startup and after each save. */
export function setAppAdvisorProjectAgentAccess(value: unknown): void {
  const next = normalizeAppAdvisorProjectAgentAccess(value);
  // Every preferences save re-applies this setting; only a real change may
  // invalidate watcher and delivery authority.
  if (JSON.stringify(next) === JSON.stringify(currentAccess)) return;
  currentAccess = next;
  accessChangeListeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      logMainProcessWarn('[app-advisor-access] change listener failed', error);
    }
  });
}

/** Notified after each applied preference (for example, to resume held deliveries). */
export function onAppAdvisorProjectAgentAccessChange(
  listener: () => void,
): () => void {
  accessChangeListeners.add(listener);
  return () => accessChangeListeners.delete(listener);
}

export function getAppAdvisorProjectAgentAccessSnapshot(): AppAdvisorProjectAgentAccess {
  return {
    mode: currentAccess.mode,
    selectedOwners: currentAccess.selectedOwners.map((owner) => ({ ...owner })),
  };
}

export type AppAdvisorAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: 'advisor_access_disabled' | 'owner_unknown' };

/** Whether the signed-in account currently belongs to the organization. */
async function isCurrentOrganizationMember(
  organizationId: string,
): Promise<boolean> {
  try {
    const service = getWorkspaceContextService();
    await service.initialize();
    // Apply sign-outs and membership changes that are already queued.
    await service.whenIdle();
    const id = organizationId.toLowerCase();
    return service
      .getState()
      .organizations.some(
        (organization) => organization.id.toLowerCase() === id,
      );
  } catch (error) {
    logMainProcessWarn(
      '[app-advisor-access] organization membership could not be read; denying access',
      error,
    );
    return false;
  }
}

/**
 * Decide whether a code or cowork caller may use App Advisor tools, App
 * Advisor prompt automations, or bot watchers. The caller is identified by its
 * trusted runtime project (a delegate passes its root chat's project). App
 * Advisor itself is never gated. Evaluated on every call so a settings change
 * takes effect immediately. In Select owners mode, a selected organization
 * grants access only while the signed-in account is still a member of it.
 */
export async function decideAppAdvisorAccessForCaller(
  caller: ProjectOwnerTarget,
  /** The caller's owner when the caller already resolved it for this call. */
  resolvedCallerOwner?: ResolvedProjectOwner,
): Promise<AppAdvisorAccessDecision> {
  const owner = resolvedCallerOwner ?? (await resolveProjectSavedOwner(caller));
  if (owner.kind === 'none') return { allowed: true };
  if (owner.kind === 'unknown') {
    return { allowed: false, reason: 'owner_unknown' };
  }
  const member =
    owner.kind === 'organization' && currentAccess.mode === 'selected-owners'
      ? await isCurrentOrganizationMember(owner.organizationId)
      : undefined;
  // Judge the newest preference, read after every await above.
  const access = currentAccess;
  if (!isProjectOwnerAllowedAppAdvisorAccess(access, owner)) {
    return { allowed: false, reason: 'advisor_access_disabled' };
  }
  if (
    access.mode === 'selected-owners' &&
    owner.kind === 'organization' &&
    !(member ?? (await isCurrentOrganizationMember(owner.organizationId)))
  ) {
    return { allowed: false, reason: 'advisor_access_disabled' };
  }
  return { allowed: true };
}

export function resetAppAdvisorProjectAgentAccessForTests(): void {
  currentAccess = normalizeAppAdvisorProjectAgentAccess(undefined);
}

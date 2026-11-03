import { getWorkspaceIndexRepository } from './sidebar-items';
import {
  ensureOrganizationSourceHookBindings,
  ensurePersonalCatalogId,
  updateWorkspaceConfig,
  updateWorkspaceOwnership,
} from './workspace-persistence';
import {
  applyAdoptedWorkspaceIndexReleaseTo,
  applyHookExecutionContextsRebindTo,
  applyOrganizationPrivateMemoryTo,
  applyWorkspaceOwnerDecisionTo,
  checkAdoptedWorkspaceRelease,
  decideOrganizationOwnerRefresh,
} from './worktree-record-decision-apply';
import type {
  AdoptedWorkspaceIndexReleaseDecision,
  AdoptedWorkspaceReleaseDecision,
  HookExecutionContextsRebindDecision,
  OrganizationHookBindingsDecision,
  OrganizationHookBindingsOutcome,
  OrganizationOwnerBinding,
  OrganizationOwnerRefreshDecision,
  OrganizationOwnerRefreshOutcome,
  OrganizationPrivateMemoryDecision,
  OrganizationPrivateMemoryStatus,
  PersonalCatalogIdDecision,
  WorkspaceOwnerCompare,
  WorkspaceOwnershipDecision,
  WorkspaceOwnershipDecisionOutcome,
  WorkspaceOwnershipRecordStatus,
} from './worktree-record-decisions';

// The ownership and organization private memory members of
// `W5RecordDecisionPort` (W5c2), applied by the writers the records used,
// with each record's own updater logic as a pure apply. The Cowork members
// are in `cowork-record-decision-port.ts`, so these records keep their import
// graphs.

/**
 * Applies one owner decision through the single ownership writer (CAN-3415),
 * on its authoritative read in the manifest queue: the host's compare, or a
 * re-claim's fence refresh. Everything else in the manifest is kept, and a
 * written replacement notifies the Portal.
 */
export async function applyWorkspaceOwnerDecision(
  workspaceId: string,
  compare: WorkspaceOwnerCompare,
): Promise<WorkspaceOwnershipRecordStatus>;
export async function applyWorkspaceOwnerDecision(
  workspaceId: string,
  decision: OrganizationOwnerRefreshDecision,
): Promise<OrganizationOwnerRefreshOutcome>;
export async function applyWorkspaceOwnerDecision(
  workspaceId: string,
  decision: WorkspaceOwnerCompare | OrganizationOwnerRefreshDecision,
): Promise<WorkspaceOwnershipRecordStatus | OrganizationOwnerRefreshOutcome>;
export async function applyWorkspaceOwnerDecision(
  workspaceId: string,
  decision: WorkspaceOwnerCompare | OrganizationOwnerRefreshDecision,
): Promise<WorkspaceOwnershipRecordStatus | OrganizationOwnerRefreshOutcome> {
  if (typeof decision === 'function')
    return updateWorkspaceOwnership(workspaceId, (current) => {
      const replacement = decision(current);
      return replacement && applyWorkspaceOwnerDecisionTo(replacement);
    });
  const decided: { held?: OrganizationOwnerBinding } = {};
  const status = await updateWorkspaceOwnership(workspaceId, (current) => {
    const pass = decideOrganizationOwnerRefresh(current, decision);
    decided.held = pass.held;
    return pass.replacement && applyWorkspaceOwnerDecisionTo(pass.replacement);
  });
  return decided.held ? { status, held: decided.held } : { status };
}

/**
 * Applies a personal catalog enrollment through its writer, which asks
 * `allowed` inside the manifest queue and leaves an organization, temporary,
 * missing or unreadable workspace as it is.
 */
export function applyPersonalCatalogIdDecision(
  workspaceId: string,
  _decision: PersonalCatalogIdDecision,
  allowed: () => Promise<boolean>,
): Promise<string | undefined> {
  return ensurePersonalCatalogId(workspaceId, allowed);
}

/** Applies one ownership decision in the workspace's manifest queue. */
export async function applyWorkspaceOwnershipDecision(
  workspaceId: string,
  decision: OrganizationHookBindingsDecision,
): Promise<OrganizationHookBindingsOutcome>;
export async function applyWorkspaceOwnershipDecision(
  workspaceId: string,
  decision: HookExecutionContextsRebindDecision,
): Promise<string[]>;
export async function applyWorkspaceOwnershipDecision(
  workspaceId: string,
  decision: OrganizationPrivateMemoryDecision,
): Promise<OrganizationPrivateMemoryStatus>;
export async function applyWorkspaceOwnershipDecision(
  workspaceId: string,
  decision: WorkspaceOwnershipDecision,
): Promise<WorkspaceOwnershipDecisionOutcome>;
export async function applyWorkspaceOwnershipDecision(
  workspaceId: string,
  decision: WorkspaceOwnershipDecision,
): Promise<WorkspaceOwnershipDecisionOutcome> {
  switch (decision.kind) {
    case 'ownership.hook-bindings':
      // The writer checks the flag and the binding first, then binds under
      // the owner it reads in the queue.
      return ensureOrganizationSourceHookBindings({
        workspaceId,
        ...(decision.repoId === undefined ? {} : { repoId: decision.repoId }),
        source: decision.sourceHooks,
        local: decision.localHooks,
        owner: decision.owner,
      });
    case 'ownership.hook-contexts.rebind':
      // Writes only when a hook was rebound, so a missing manifest stays
      // missing; an unreadable one is refused.
      return updateWorkspaceConfig(
        workspaceId,
        (config): string[] =>
          applyHookExecutionContextsRebindTo(config, decision),
        { shouldWrite: (ids): boolean => ids.length > 0 },
      );
    case 'ownership.private-memory':
      return updateWorkspaceConfig(
        workspaceId,
        (config, read): OrganizationPrivateMemoryStatus =>
          applyOrganizationPrivateMemoryTo(config, read, decision),
        { shouldWrite: (status): boolean => status === 'recorded' },
      );
  }
}

/**
 * Applies an adoption release in the manifest queue, writing no manifest: it
 * checks the binding on the read there and, while the workspace is indexed
 * and bound to this instance, removes its index entry there. Resolves whether
 * the adoption is undone.
 */
export async function applyAdoptedWorkspaceRelease(
  workspaceId: string,
  decision: AdoptedWorkspaceReleaseDecision,
): Promise<boolean> {
  return updateWorkspaceConfig(
    workspaceId,
    async (config, read): Promise<boolean> => {
      const check = checkAdoptedWorkspaceRelease(config, read, decision);
      if (check === 'absent') return true;
      if (check === 'owner-unreadable') return false;
      if (!(await isIndexed(workspaceId))) return true;
      if (check === 'bound-elsewhere') return false;
      await applyAdoptedWorkspaceIndexRelease(decision.index);
      return true;
    },
    { shouldWrite: (): boolean => false },
  );
}

async function isIndexed(workspaceId: string): Promise<boolean> {
  return (await getWorkspaceIndexRepository().read()).entries.some(
    (entry) => entry.id === workspaceId,
  );
}

async function applyAdoptedWorkspaceIndexRelease(
  decision: AdoptedWorkspaceIndexReleaseDecision,
): Promise<void> {
  await getWorkspaceIndexRepository().update(({ entries }) => {
    const remaining = applyAdoptedWorkspaceIndexReleaseTo(entries, decision);
    return remaining
      ? { result: undefined, entries: remaining }
      : { result: undefined };
  });
}

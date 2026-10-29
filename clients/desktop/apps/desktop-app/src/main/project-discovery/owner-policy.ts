import type {
  ProjectOwnerContext,
  SidebarItem,
  WorkspaceConfigFile,
  WorkspaceOwnerBinding,
  CoworkSidebarItem,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  isOrgDefaultCoworkWorkspaceId,
  orgDefaultCoworkWorkspaceId,
} from '@canopy/protocol/ui-labels';
import {
  decideSameOwnerAccess,
  resolveProjectSavedOwner,
  type ResolvedProjectOwner,
} from '../lib/project-owner';
import {
  isOrgCoworkOperationEligible,
  isOrgMemberCodeOperationEligible,
} from '../lib/org-cowork-binding-deps';
import { DiscoveryError } from './errors';
import {
  getOrganizationMemberships,
  organizationChatsReadiness,
  organizationProjectReadiness,
  personalChatsReadiness,
  type OrganizationReadinessDependencies,
  type ProjectReadiness,
} from './readiness';
import {
  readProjectConfigSnapshot,
  readProjectInventory,
  type LegacyReadAuthority,
  type ProjectConfigSnapshot,
  type ProjectInventorySnapshot,
} from './sources';
import type { ProjectDiscoveryCaller } from './index';

export interface AuthorizedProject {
  item: SidebarItem;
  projectId: string;
  type: 'code' | 'cowork';
  purpose: 'project' | 'chats';
  name: string;
  displayName: string;
  description?: string;
  createdAt?: string;
  lastActivityAt?: string;
  incarnation: string;
  isDefault: boolean;
  owner: ProjectOwnerContext;
  readiness: ProjectReadiness;
  synthetic: boolean;
  inventoryAuthority: LegacyReadAuthority;
  inventoryOwnerMalformed: boolean;
  config?: WorkspaceConfigFile;
  configAuthority?: LegacyReadAuthority;
}

export interface AuthorizedProjectInventory {
  projects: AuthorizedProject[];
  /** Authority of the index, not of unrelated project manifests. */
  authority: LegacyReadAuthority;
}

const appAdvisorOwner: ResolvedProjectOwner = { kind: 'none' };
const ownerContextError = (): DiscoveryError =>
  new DiscoveryError(
    'owner_context_unavailable',
    'The project owner context is unavailable.',
  );

function asOwnerContext(
  owner: ResolvedProjectOwner,
): ProjectOwnerContext | null {
  return owner.kind === 'unknown' || owner.kind === 'none' ? null : owner;
}

export async function getCallerOwner(
  caller: ProjectDiscoveryCaller,
): Promise<ProjectOwnerContext | null> {
  if (caller.kind === 'app_advisor') return null;
  const resolved = await resolveProjectSavedOwner({
    projectId: caller.projectId,
    worktreeId: caller.worktreeId,
  });
  const owner = asOwnerContext(resolved);
  if (!owner) throw ownerContextError();
  return owner;
}

function ownerMatches(
  left: ProjectOwnerContext,
  right: ProjectOwnerContext,
): boolean {
  if (left.kind !== right.kind) return false;
  return (
    left.kind === 'personal' ||
    (right.kind === 'organization' &&
      left.organizationId.toLowerCase() === right.organizationId.toLowerCase())
  );
}

function ownerBinding(item: SidebarItem): WorkspaceOwnerBinding | undefined {
  return item.owner;
}

function syntheticChatsItem(projectId: string): CoworkSidebarItem {
  return {
    id: projectId,
    type: 'cowork',
    name: 'Chats',
    color: '#6B7280',
    collapsed: false,
    order: 0,
  };
}

function projectCreatedAt(item: SidebarItem): string | undefined {
  if (item.type === 'cowork') return item.cowork?.createdAt;
  return undefined;
}

function latestWorktreeActivity(item: SidebarItem): string | undefined {
  if (item.type === 'cowork') return item.lastActivityAt;
  return item.worktrees
    .map((worktree) => worktree.lastTouchedAt ?? worktree.createdAt)
    .filter((value) => value.length > 0)
    .sort()
    .slice(-1)[0];
}

function makeAuthorizedProject(
  item: SidebarItem,
  owner: ProjectOwnerContext,
  readiness: ProjectReadiness,
  inventory: ProjectInventorySnapshot,
  configSnapshot?: ProjectConfigSnapshot,
  synthetic = false,
): AuthorizedProject {
  const isDefault =
    item.type === 'cowork' &&
    (item.id === DEFAULT_COWORK_WORKSPACE_ID ||
      isOrgDefaultCoworkWorkspaceId(item.id));
  const createdAt = projectCreatedAt(item);
  const binding = ownerBinding(item);
  const purpose = isDefault ? 'chats' : 'project';
  const incarnation = JSON.stringify({
    projectId: item.id,
    owner,
    readiness,
    name: item.name,
    type: item.type,
    ...(binding
      ? {
          binding: {
            organizationId: binding.organizationId,
            projectId: binding.projectId,
            instanceId: binding.instanceId,
            bindingGeneration: binding.bindingGeneration,
          },
        }
      : {}),
    ...(createdAt ? { createdAt } : {}),
  });
  return {
    item,
    projectId: item.id,
    type: item.type === 'cowork' ? 'cowork' : 'code',
    purpose,
    name: isDefault ? 'Chats' : item.name,
    displayName: isDefault ? 'Chats' : item.name,
    ...(item.type === 'cowork' && item.cowork?.description
      ? { description: item.cowork.description }
      : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(latestWorktreeActivity(item)
      ? { lastActivityAt: latestWorktreeActivity(item) }
      : {}),
    incarnation,
    isDefault,
    owner,
    readiness,
    synthetic,
    inventoryAuthority: inventory.indexAuthority,
    inventoryOwnerMalformed: inventory.ownerMalformed,
    ...(configSnapshot ? { config: configSnapshot.config } : {}),
    ...(configSnapshot ? { configAuthority: configSnapshot.authority } : {}),
  };
}

function membershipsById(
  organizations: readonly { id: string; name?: string }[],
): Map<string, { id: string; name?: string }> {
  return new Map(
    organizations.map((organization) => [
      organization.id.trim().toLowerCase(),
      organization,
    ]),
  );
}

function organizationIdFromChatsId(projectId: string): string {
  return projectId.slice('cowork-org-'.length).toLowerCase();
}

async function readConfigForReadiness(
  projectId: string,
): Promise<ProjectConfigSnapshot | undefined> {
  try {
    return await readProjectConfigSnapshot(projectId);
  } catch {
    return undefined;
  }
}

async function readinessForItem(
  item: SidebarItem,
  owner: ProjectOwnerContext,
  inventory: ProjectInventorySnapshot,
  memberships: ReadonlyMap<string, { id: string; name?: string }>,
  organizationDependencies: OrganizationReadinessDependencies,
): Promise<{
  readiness: ProjectReadiness;
  configSnapshot?: ProjectConfigSnapshot;
}> {
  const isChats =
    item.type === 'cowork' &&
    (item.id === DEFAULT_COWORK_WORKSPACE_ID ||
      isOrgDefaultCoworkWorkspaceId(item.id));
  const configSnapshot = await readConfigForReadiness(item.id);
  if (owner.kind === 'personal') {
    if (!isChats) {
      if (
        !configSnapshot ||
        inventory.ownerMalformed ||
        ownerBinding(item) !== undefined ||
        configSnapshot.config.owner !== undefined
      ) {
        return { readiness: 'unavailable' };
      }
      return { readiness: 'ready', configSnapshot };
    }
    const readiness = personalChatsReadiness({
      indexed: true,
      inventoryAuthority: inventory.indexAuthority,
      ...(inventory.ownerMalformed
        ? {}
        : { inventoryOwner: ownerBinding(item) }),
      ...(configSnapshot
        ? {
            configAuthority: configSnapshot.authority,
            configOwner: configSnapshot.config.owner,
          }
        : {}),
    });
    return {
      readiness,
      ...(configSnapshot ? { configSnapshot } : {}),
    };
  }

  const organizationId = owner.organizationId.trim().toLowerCase();
  const member = memberships.get(organizationId);
  if (!member) return { readiness: 'unavailable' };
  const isCanonicalOrgChats = isOrgDefaultCoworkWorkspaceId(item.id);
  if (
    isCanonicalOrgChats &&
    organizationIdFromChatsId(item.id) !== organizationId
  ) {
    return { readiness: 'unavailable' };
  }
  const facts = {
    indexed: true,
    inventoryAuthority: inventory.indexAuthority,
    ...(inventory.ownerMalformed ? {} : { inventoryOwner: ownerBinding(item) }),
    ...(configSnapshot
      ? {
          configAuthority: configSnapshot.authority,
          configOwner: configSnapshot.config.owner,
        }
      : {}),
    ...(inventory.ownerMalformed ? { configOwnerMalformed: true } : {}),
  };
  const readiness =
    item.type === 'cowork'
      ? await organizationChatsReadiness(
          organizationId,
          facts,
          organizationDependencies,
        )
      : await organizationProjectReadiness(
          organizationId,
          facts,
          organizationDependencies,
        );
  return { readiness, ...(configSnapshot ? { configSnapshot } : {}) };
}

function allowedByCallerOwner(
  callerOwner: ProjectOwnerContext | null,
  owner: ProjectOwnerContext,
): boolean {
  return callerOwner === null || ownerMatches(callerOwner, owner);
}

async function authorizeOwner(
  callerOwner: ProjectOwnerContext | null,
  candidateOwner: ProjectOwnerContext,
  projectId: string,
): Promise<boolean> {
  const decision = await decideSameOwnerAccess(
    callerOwner ?? appAdvisorOwner,
    { projectId },
    {
      resolveTargetOwner: () => Promise.resolve(candidateOwner),
      isMissingTarget: () => Promise.resolve(false),
    },
  );
  if (decision.kind === 'caller_owner_unknown') throw ownerContextError();
  if (decision.kind === 'target_owner_unknown') throw ownerContextError();
  return decision.kind === 'allowed';
}

export async function listAuthorizedProjectInventory(
  caller: ProjectDiscoveryCaller,
): Promise<AuthorizedProjectInventory> {
  const callerOwner = await getCallerOwner(caller);
  const inventory = await readProjectInventory();
  // An absent index is a fresh-install empty success, not evidence that Chats
  // was missing and should be represented with a synthetic descriptor.
  if (inventory.indexAuthority === 'absent') {
    return { projects: [], authority: inventory.indexAuthority };
  }
  const organizations = await getOrganizationMemberships();
  const memberships = membershipsById(organizations);
  const organizationDependencies: OrganizationReadinessDependencies = {
    getOrganizations: () => Promise.resolve(organizations),
    isEligible: isOrgCoworkOperationEligible,
    isMemberCodeEligible: isOrgMemberCodeOperationEligible,
  };
  const projects: AuthorizedProject[] = [];
  const seen = new Set<string>();
  const indexedIds = new Set(inventory.items.map((item) => item.id));

  for (const item of inventory.items) {
    if (item.id === APP_ADVISOR_PROJECT_ID) continue;
    let owner: ProjectOwnerContext | null = null;
    const canonicalOrgChats =
      item.type === 'cowork' && isOrgDefaultCoworkWorkspaceId(item.id);
    if (canonicalOrgChats) {
      const organizationId = organizationIdFromChatsId(item.id);
      if (!memberships.has(organizationId)) continue;
      const resolved = await resolveProjectSavedOwner({ projectId: item.id });
      if (
        resolved.kind !== 'organization' ||
        resolved.organizationId.trim().toLowerCase() !== organizationId
      ) {
        continue;
      }
      owner = resolved;
    } else {
      const resolved = await resolveProjectSavedOwner({ projectId: item.id });
      if (resolved.kind === 'unknown' || resolved.kind === 'none') continue;
      owner = resolved;
    }
    if (!owner || !allowedByCallerOwner(callerOwner, owner)) continue;
    if (
      owner.kind === 'organization' &&
      !memberships.has(owner.organizationId.toLowerCase())
    )
      continue;
    if (!(await authorizeOwner(callerOwner, owner, item.id))) continue;

    const facts = await readinessForItem(
      item,
      owner,
      inventory,
      memberships,
      organizationDependencies,
    );
    projects.push(
      makeAuthorizedProject(
        item,
        owner,
        facts.readiness,
        inventory,
        facts.configSnapshot,
      ),
    );
    seen.add(item.id);
  }

  const canListPersonal = allowedByCallerOwner(callerOwner, {
    kind: 'personal',
  });
  if (
    canListPersonal &&
    !indexedIds.has(DEFAULT_COWORK_WORKSPACE_ID) &&
    !seen.has(DEFAULT_COWORK_WORKSPACE_ID)
  ) {
    const item = syntheticChatsItem(DEFAULT_COWORK_WORKSPACE_ID);
    const readiness = personalChatsReadiness({
      indexed: false,
      inventoryAuthority: inventory.indexAuthority,
    });
    projects.push(
      makeAuthorizedProject(
        item,
        { kind: 'personal' },
        readiness,
        inventory,
        undefined,
        true,
      ),
    );
  }

  // Saved origin ownership may outlive account membership. Advertise only an
  // unavailable missing-Chats descriptor, never task contents or a fallback.
  const chatsOrganizations = [...organizations];
  if (
    callerOwner?.kind === 'organization' &&
    !memberships.has(callerOwner.organizationId.trim().toLowerCase())
  ) {
    chatsOrganizations.push({ id: callerOwner.organizationId });
  }
  for (const organization of chatsOrganizations) {
    const organizationId = organization.id.trim().toLowerCase();
    const owner: ProjectOwnerContext = { kind: 'organization', organizationId };
    if (!allowedByCallerOwner(callerOwner, owner)) continue;
    const projectId = orgDefaultCoworkWorkspaceId(organizationId);
    if (indexedIds.has(projectId) || seen.has(projectId)) continue;
    const item = syntheticChatsItem(projectId);
    const readiness = await organizationChatsReadiness(
      organizationId,
      { indexed: false, inventoryAuthority: inventory.indexAuthority },
      organizationDependencies,
    );
    if (!(await authorizeOwner(callerOwner, owner, projectId))) continue;
    projects.push(
      makeAuthorizedProject(item, owner, readiness, inventory, undefined, true),
    );
  }

  return { projects, authority: inventory.indexAuthority };
}

export async function listAuthorizedProjects(
  caller: ProjectDiscoveryCaller,
): Promise<AuthorizedProject[]> {
  return (await listAuthorizedProjectInventory(caller)).projects;
}

export async function requireAuthorizedProject(
  projectId: string,
  caller: ProjectDiscoveryCaller,
): Promise<AuthorizedProject> {
  const inventory = await listAuthorizedProjectInventory(caller);
  if (inventory.authority === 'partial') {
    throw new DiscoveryError(
      'execution_failed',
      'Project inventory could not be read.',
    );
  }
  const project = inventory.projects.find(
    (candidate) => candidate.projectId === projectId,
  );
  if (!project) {
    throw new DiscoveryError('not_found', 'Project was not found.');
  }
  if (project.synthetic) {
    throw new DiscoveryError('not_found', 'Project was not found.');
  }

  const callerOwner = await getCallerOwner(caller);
  const targetOwner: ResolvedProjectOwner = await resolveProjectSavedOwner({
    projectId,
    ...(caller.kind === 'project_agent' && caller.projectId === projectId
      ? { worktreeId: caller.worktreeId }
      : {}),
  });
  if (targetOwner.kind === 'unknown' || targetOwner.kind === 'none') {
    throw new DiscoveryError('not_found', 'Project was not found.');
  }
  const decision = await decideSameOwnerAccess(
    callerOwner ?? appAdvisorOwner,
    { projectId },
    {
      resolveTargetOwner: () => Promise.resolve(targetOwner),
      isMissingTarget: () => Promise.resolve(false),
    },
  );
  if (decision.kind === 'caller_owner_unknown') throw ownerContextError();
  if (decision.kind === 'target_owner_unknown') {
    throw new DiscoveryError('not_found', 'Project was not found.');
  }
  if (decision.kind === 'hidden') {
    throw new DiscoveryError('not_found', 'Project was not found.');
  }
  if (!ownerMatches(targetOwner, project.owner)) {
    throw new DiscoveryError('not_found', 'Project was not found.');
  }
  return project;
}

import { isAbsolute } from 'node:path';
import type {
  ProjectOwnerContext,
  SidebarItem,
  WorkspaceConfigFile,
  WorkspaceOwnerBinding,
  CoworkSidebarItem,
  WorkspaceIndexEntry,
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
  readProjectIndexSnapshot,
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

export type AuthorizedProjectIdentity = Pick<
  AuthorizedProject,
  | 'projectId'
  | 'type'
  | 'owner'
  | 'incarnation'
  | 'readiness'
  | 'synthetic'
  | 'inventoryAuthority'
>;

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
  // A pipeline run reads as its own recorded owner, even when an agent started it.
  if (caller.kind === 'pipeline') return caller.owner;
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

interface ProjectIdentityItem {
  id: string;
  name: string;
  type: WorkspaceIndexEntry['type'];
  owner?: WorkspaceOwnerBinding;
  createdAt?: string;
}

function ownerBinding(
  item: ProjectIdentityItem,
): WorkspaceOwnerBinding | undefined {
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

function makeAuthorizedIdentity(
  item: ProjectIdentityItem,
  owner: ProjectOwnerContext,
  readiness: ProjectReadiness,
  inventoryAuthority: LegacyReadAuthority,
  synthetic = false,
): AuthorizedProjectIdentity {
  const binding = ownerBinding(item);
  return {
    projectId: item.id,
    type: item.type === 'cowork' ? 'cowork' : 'code',
    owner,
    readiness,
    synthetic,
    inventoryAuthority,
    incarnation: JSON.stringify({
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
      ...(item.createdAt ? { createdAt: item.createdAt } : {}),
    }),
  };
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
  const purpose = isDefault ? 'chats' : 'project';
  return {
    item,
    ...makeAuthorizedIdentity(
      { ...item, ...(createdAt ? { createdAt } : {}) },
      owner,
      readiness,
      inventory.indexAuthority,
      synthetic,
    ),
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
    isDefault,
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
  item: ProjectIdentityItem,
  owner: ProjectOwnerContext,
  inventory: Pick<
    ProjectInventorySnapshot,
    'indexAuthority' | 'ownerMalformed'
  >,
  memberships: ReadonlyMap<string, { id: string; name?: string }>,
  organizationDependencies: OrganizationReadinessDependencies,
  configSnapshot: ProjectConfigSnapshot | undefined,
): Promise<{
  readiness: ProjectReadiness;
  configSnapshot?: ProjectConfigSnapshot;
}> {
  const isChats =
    item.type === 'cowork' &&
    (item.id === DEFAULT_COWORK_WORKSPACE_ID ||
      isOrgDefaultCoworkWorkspaceId(item.id));
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

async function resolveEligibleOwner(
  item: ProjectIdentityItem,
  callerOwner: ProjectOwnerContext | null,
  memberships: ReadonlyMap<string, { id: string; name?: string }>,
): Promise<ProjectOwnerContext | null> {
  if (item.id === APP_ADVISOR_PROJECT_ID) return null;
  if (
    item.type === 'cowork' &&
    isOrgDefaultCoworkWorkspaceId(item.id) &&
    !memberships.has(organizationIdFromChatsId(item.id))
  )
    return null;
  const resolved = await resolveProjectSavedOwner({ projectId: item.id });
  if (resolved.kind === 'unknown' || resolved.kind === 'none') return null;
  if (
    item.type === 'cowork' &&
    isOrgDefaultCoworkWorkspaceId(item.id) &&
    (resolved.kind !== 'organization' ||
      resolved.organizationId.trim().toLowerCase() !==
        organizationIdFromChatsId(item.id))
  )
    return null;
  if (!allowedByCallerOwner(callerOwner, resolved)) return null;
  if (
    resolved.kind === 'organization' &&
    !memberships.has(resolved.organizationId.toLowerCase())
  )
    return null;
  return (await authorizeOwner(callerOwner, resolved, item.id))
    ? resolved
    : null;
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
    const owner = await resolveEligibleOwner(item, callerOwner, memberships);
    if (!owner) continue;

    const configSnapshot = await readConfigForReadiness(item.id);
    const facts = await readinessForItem(
      item,
      owner,
      inventory,
      memberships,
      organizationDependencies,
      configSnapshot,
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

/** Authorize one indexed project without sidebar, script or hook projection. */
export async function requireAuthorizedProjectIdentity(
  projectId: string,
  caller: ProjectDiscoveryCaller,
): Promise<AuthorizedProjectIdentity> {
  const callerOwner = await getCallerOwner(caller);
  const index = await readProjectIndexSnapshot(projectId);
  const entry = index.entry;
  if (!entry) throw new DiscoveryError('not_found', 'Project was not found.');

  const organizations = await getOrganizationMemberships();
  const memberships = membershipsById(organizations);
  const organizationDependencies: OrganizationReadinessDependencies = {
    getOrganizations: () => Promise.resolve(organizations),
    isEligible: isOrgCoworkOperationEligible,
    isMemberCodeEligible: isOrgMemberCodeOperationEligible,
  };
  const configSnapshot = await readConfigForReadiness(entry.id);
  if (
    !configSnapshot ||
    configSnapshot.authority !== 'ok' ||
    configSnapshot.config.type !== entry.type ||
    (entry.type === 'single-repo' &&
      (!configSnapshot.config.repoPath ||
        !isAbsolute(configSnapshot.config.repoPath)))
  )
    throw new DiscoveryError('not_found', 'Project was not found.');
  const item: ProjectIdentityItem = {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    ...(configSnapshot.config.owner
      ? { owner: configSnapshot.config.owner }
      : {}),
    ...(entry.type === 'cowork' && configSnapshot.config.cowork?.createdAt
      ? { createdAt: configSnapshot.config.cowork.createdAt }
      : {}),
  };
  const owner = await resolveEligibleOwner(item, callerOwner, memberships);
  if (!owner) throw new DiscoveryError('not_found', 'Project was not found.');
  const facts = await readinessForItem(
    item,
    owner,
    { indexAuthority: index.authority, ownerMalformed: false },
    memberships,
    organizationDependencies,
    configSnapshot,
  );
  const identity = makeAuthorizedIdentity(
    item,
    owner,
    facts.readiness,
    index.authority,
  );
  const latestCallerOwner = await getCallerOwner(caller);
  const latestTargetOwner = await resolveProjectSavedOwner({
    projectId: entry.id,
    ...(caller.kind === 'project_agent' && caller.projectId === entry.id
      ? { worktreeId: caller.worktreeId }
      : {}),
  });
  if (
    latestTargetOwner.kind === 'unknown' ||
    latestTargetOwner.kind === 'none' ||
    !ownerMatches(latestTargetOwner, identity.owner) ||
    !(await authorizeOwner(latestCallerOwner, latestTargetOwner, entry.id))
  )
    throw new DiscoveryError('not_found', 'Project was not found.');
  return identity;
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

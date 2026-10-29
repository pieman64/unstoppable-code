import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { join } from 'node:path';
import {
  isProfileId,
  isProfileRecord,
  type BrowserTaskScope,
} from '@canopy/protocol/browser-profiles';
import { readProfileJson } from './storage';

export interface BrowserTaskOwner {
  scope: BrowserTaskScope;
  projectId: string;
  worktreeId: string;
  createdAt: string;
}

function invalidRegistry(): never {
  throw new BrowserProfileError(
    'recovery_required',
    'The browser task registry is unavailable or damaged. Browser data was preserved.',
  );
}

async function workspaceRows(
  dataRoot: string,
): Promise<Array<{ id: string; type: string }>> {
  const value = await readProfileJson(
    join(dataRoot, 'workspaces', 'index.json'),
  );
  if (value === undefined) invalidRegistry();
  if (
    !isProfileRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.workspaces)
  )
    invalidRegistry();
  return value.workspaces.map((entry) => {
    if (
      !isProfileRecord(entry) ||
      !isProfileId(entry.id) ||
      !['single-repo', 'multi-repo', 'cowork'].includes(String(entry.type))
    )
      invalidRegistry();
    return { id: entry.id, type: String(entry.type) };
  });
}

async function ownersInWorkspace(
  dataRoot: string,
  projectId: string,
  type: string,
  allowMissing = false,
): Promise<BrowserTaskOwner[]> {
  const advisor = projectId === 'app-advisor';
  const entries = advisor || type === 'cowork';
  const value = await readProfileJson(
    join(
      dataRoot,
      advisor ? 'app-workspaces' : 'workspaces',
      projectId,
      entries ? 'work-entries.json' : 'worktrees.json',
    ),
  );
  if (value === undefined) {
    if (allowMissing) return [];
    invalidRegistry();
  }
  if (!isProfileRecord(value) || value.version !== 1) invalidRegistry();
  const rows = entries ? value.entries : value.worktrees;
  if (!Array.isArray(rows)) invalidRegistry();
  return rows.map((row) => {
    if (
      !isProfileRecord(row) ||
      !isProfileId(row.id) ||
      typeof row.createdAt !== 'string' ||
      !row.createdAt
    )
      invalidRegistry();
    const scope: BrowserTaskScope = advisor
      ? { kind: 'app_advisor_work_entry', workEntryId: row.id }
      : entries
        ? {
            kind: 'cowork_work_entry',
            workspaceId: projectId,
            workEntryId: row.id,
          }
        : { kind: 'worktree', projectId, worktreeId: row.id };
    return { scope, projectId, worktreeId: row.id, createdAt: row.createdAt };
  });
}

/** No lenient registry readers: corruption must not look like owner deletion. */
export async function resolveBrowserTaskOwner(
  dataRoot: string,
  projectId: string,
  worktreeId: string,
): Promise<BrowserTaskOwner | null> {
  if (!isProfileId(projectId) || !isProfileId(worktreeId))
    throw new BrowserProfileError(
      'invalid_request',
      'Invalid browser task identity.',
    );
  const type =
    projectId === 'app-advisor'
      ? 'cowork'
      : (await workspaceRows(dataRoot)).find((row) => row.id === projectId)
          ?.type;
  if (!type) return null;
  return (
    (await ownersInWorkspace(dataRoot, projectId, type)).find(
      (owner) => owner.worktreeId === worktreeId,
    ) ?? null
  );
}

export async function listBrowserTaskOwners(
  dataRoot: string,
  projectId: string,
  allowMissingRegistry = false,
): Promise<BrowserTaskOwner[]> {
  if (!isProfileId(projectId))
    throw new BrowserProfileError(
      'invalid_request',
      'Invalid browser project identity.',
    );
  const type =
    projectId === 'app-advisor'
      ? 'cowork'
      : (await workspaceRows(dataRoot)).find((row) => row.id === projectId)
          ?.type;
  return type
    ? ownersInWorkspace(dataRoot, projectId, type, allowMissingRegistry)
    : [];
}

export function legacyBrowserPartition(
  projectId: string,
  worktreeId: string,
): string {
  return `persist:canopy-browser-${encodeURIComponent(projectId)}-${encodeURIComponent(worktreeId)}`;
}

/** Only inspect registries whose project prefix could alias the legacy locator. */
export async function legacyBrowserPartitionOwners(
  dataRoot: string,
  partition: string,
): Promise<BrowserTaskOwner[]> {
  const workspaces = [
    ...(await workspaceRows(dataRoot)),
    { id: 'app-advisor', type: 'cowork' },
  ];
  const owners: BrowserTaskOwner[] = [];
  for (const workspace of workspaces) {
    if (
      !partition.startsWith(
        `persist:canopy-browser-${encodeURIComponent(workspace.id)}-`,
      )
    )
      continue;
    owners.push(
      ...(
        await ownersInWorkspace(dataRoot, workspace.id, workspace.type)
      ).filter(
        (owner) =>
          legacyBrowserPartition(owner.projectId, owner.worktreeId) ===
          partition,
      ),
    );
  }
  return owners;
}

/**
 * Every scope {@link browserTaskOwnerIds} maps to this pair. An owner already
 * removed from its registry no longer says which kind of task it was.
 */
export function browserTaskScopesForOwnerIds(
  projectId: string,
  worktreeId: string,
): BrowserTaskScope[] {
  const scopes: BrowserTaskScope[] = [
    { kind: 'worktree', projectId, worktreeId },
    {
      kind: 'cowork_work_entry',
      workspaceId: projectId,
      workEntryId: worktreeId,
    },
  ];
  if (projectId === 'app-advisor')
    scopes.push({ kind: 'app_advisor_work_entry', workEntryId: worktreeId });
  return scopes;
}

export function browserTaskOwnerIds(scope: BrowserTaskScope): {
  projectId: string;
  worktreeId: string;
} {
  switch (scope.kind) {
    case 'worktree':
      return { projectId: scope.projectId, worktreeId: scope.worktreeId };
    case 'cowork_work_entry':
      return { projectId: scope.workspaceId, worktreeId: scope.workEntryId };
    case 'app_advisor_work_entry':
      return { projectId: 'app-advisor', worktreeId: scope.workEntryId };
  }
}

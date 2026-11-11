import { relative } from 'node:path';
import type { WorkspaceManifestRepository } from '../w5/workspace-manifest-repository';
import type { WorktreeListRepository } from '../w5/worktree-list-repository';
import { parseWorktreeReplica } from '../w5/worktree-replica-codec';
import type { WorktreeReplicaState } from '@canopy/protocol/worktree-replica';
import { isJsonObject } from '../w5/file-store';
import { isWorkspaceWorktreeReadRow } from '../workspace/read-formats';
import {
  movedOwnedPath,
  RelocationRefusedError,
  type RelocationTransition,
} from './transition';

/** Captured through the W5 owners at the source, while maintenance excludes writers. */
export interface RelocationWorkspaceEvidence {
  readonly workspaceId: string;
  readonly targetId: string;
  readonly manifestRaw: string;
  readonly listRaw: string | null;
  /** Exact paths proven by the worker Git inventory, not a root-wide prefix grant. */
  readonly repositoryPaths: readonly string[];
  /** Exact link, combined-root and common-directory paths proven by the worker's ownership inventory. */
  readonly ownedPaths?: readonly string[];
}

type PathProjection = (path: unknown, field: string) => string;

function pathFields(
  value: unknown,
  project: PathProjection,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isJsonObject(value))
    throw new RelocationRefusedError('invalid-worktree-path-record');
  const next = { ...value };
  for (const key of required) next[key] = project(value[key], key);
  for (const key of optional)
    if (value[key] !== undefined) next[key] = project(value[key], key);
  return next;
}

function mapRecords(
  value: unknown,
  map: (row: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new RelocationRefusedError('invalid-worktree-path-records');
  return value.map((row: unknown) => {
    if (!isJsonObject(row))
      throw new RelocationRefusedError('invalid-worktree-path-record');
    return map(row);
  });
}

function compatibilityLinks(
  value: unknown,
  project: PathProjection,
): Record<string, unknown>[] {
  return mapRecords(value, (link) =>
    pathFields(link, project, ['path', 'targetPath']),
  );
}

// Mirrors the persisted desktop combine payload, including its joined-side retry payload.
function combinePaths(
  value: unknown,
  project: PathProjection,
): Record<string, unknown> {
  const next = pathFields(value, project, []);
  if (next.repoMappings !== undefined)
    next.repoMappings = mapRecords(next.repoMappings, (mapping) =>
      pathFields(
        mapping,
        project,
        ['repoPath', 'newWorktreePath'],
        ['oldWorktreePath'],
      ),
    );
  if (next.filePathRewrites !== undefined)
    next.filePathRewrites = mapRecords(next.filePathRewrites, (rewrite) =>
      pathFields(rewrite, project, ['fromRoot', 'toRoot']),
    );
  return next;
}

function worktreePaths(
  row: unknown,
  project: PathProjection,
): Record<string, unknown> {
  const next = pathFields(row, project, []);
  if (next.creation !== undefined) {
    const creation = pathFields(next.creation, project, []);
    creation.checkouts = mapRecords(creation.checkouts, (checkout) =>
      pathFields(checkout, project, ['repositoryPath', 'checkoutPath']),
    );
    next.creation = creation;
  }
  if (next.pendingArchiveBranchDeletion !== undefined)
    next.pendingArchiveBranchDeletion = pathFields(
      next.pendingArchiveBranchDeletion,
      project,
      ['referenceRepoPath', 'repositoryIdentity'],
    );
  if (next.pendingArchiveBranchDeletions !== undefined)
    next.pendingArchiveBranchDeletions = mapRecords(
      next.pendingArchiveBranchDeletions,
      (deletion) =>
        pathFields(deletion, project, [
          'referenceRepoPath',
          'repositoryIdentity',
        ]),
    );
  if (next.healthIssue !== undefined) {
    const issue = pathFields(next.healthIssue, project, ['worktreePath']);
    if (issue.repoIssues !== undefined)
      issue.repoIssues = mapRecords(issue.repoIssues, (repo) =>
        pathFields(repo, project, ['repoPath']),
      );
    next.healthIssue = issue;
  }
  if (next.compatibilitySymlinks !== undefined)
    next.compatibilitySymlinks = compatibilityLinks(
      next.compatibilitySymlinks,
      project,
    );
  if (next.adhocTransitionSource !== undefined) {
    const source = combinePaths(next.adhocTransitionSource, project);
    if (source.joinedWorktreeMigration !== undefined) {
      const joined = combinePaths(source.joinedWorktreeMigration, project);
      if (joined.compatibilitySymlinks !== undefined)
        joined.compatibilitySymlinks = compatibilityLinks(
          joined.compatibilitySymlinks,
          project,
        );
      source.joinedWorktreeMigration = joined;
    }
    next.adhocTransitionSource = source;
  }
  return next;
}

/** Enumerate exactly the list owner's named path fields, not arbitrary JSON strings. */
export function relocationWorktreeOwnedPaths(
  raw: string | null,
  options: { readonly checkoutsOnly?: boolean } = {},
): readonly string[] {
  if (raw === null) return [];
  const document: unknown = JSON.parse(raw);
  if (!isJsonObject(document) || !Array.isArray(document.worktrees))
    throw new RelocationRefusedError('invalid-worktree-path-records');
  const paths = new Set<string>();
  for (const row of document.worktrees) {
    if (!isWorkspaceWorktreeReadRow(row))
      throw new RelocationRefusedError('invalid-worktree-path-record');
    worktreePaths(row, (path, field) => {
      if (typeof path !== 'string')
        throw new RelocationRefusedError('invalid-worktree-path');
      // Relocation references include shared repositories, not just checkout ownership.
      if (
        !options.checkoutsOnly ||
        [
          'checkoutPath',
          'newWorktreePath',
          'oldWorktreePath',
          'worktreePath',
          'path',
        ].includes(field)
      )
        paths.add(path);
      return path;
    });
  }
  return [...paths];
}

function localReplica(
  replica: WorktreeReplicaState,
  transition: RelocationTransition,
  targetId: string,
): WorktreeReplicaState {
  if (replica.state === 'unreadable')
    throw new RelocationRefusedError('unreadable-replica');
  if (replica.state !== 'recorded') return replica;
  return {
    ...replica,
    repositories: replica.repositories.map((row) => {
      if (row.authorityId !== transition.from.authorityId) return row;
      if (
        row.targetId.primaryAuthorityId !== transition.from.authorityId ||
        row.targetId.targetId !== targetId
      )
        throw new RelocationRefusedError('replica-target-mismatch');
      return {
        ...row,
        authorityId: transition.to.authorityId,
        targetId: {
          ...row.targetId,
          primaryAuthorityId: transition.to.authorityId,
        },
      };
    }),
  };
}

/** Stages only named owner fields. Caller wraps both repositories in one W5 decision. */
export async function repairRelocatedWorkspace(
  transition: RelocationTransition,
  evidence: RelocationWorkspaceEvidence,
  manifest: WorkspaceManifestRepository,
  list: WorktreeListRepository,
): Promise<void> {
  const previous = await manifest.read(evidence.workspaceId);
  const previousList = await list.read(evidence.workspaceId);
  if (
    previous.authority !== 'ok' ||
    previous.raw !== evidence.manifestRaw ||
    (previousList.authority !== 'absent' && previousList.authority !== 'ok') ||
    (previousList.authority === 'ok' ? previousList.raw : null) !==
      evidence.listRaw ||
    (previousList.authority === 'ok' && !previousList.complete)
  )
    throw new RelocationRefusedError('metadata-evidence-mismatch');
  const document = previous.document;
  if (
    (document.workspaceId !== undefined &&
      document.workspaceId !== evidence.workspaceId) ||
    (document.authorityId !== undefined &&
      document.authorityId !== transition.from.authorityId) ||
    (document.targetId !== undefined && document.targetId !== evidence.targetId)
  )
    throw new RelocationRefusedError('foreign-manifest');
  const project = (path: unknown, field: string): string => {
    if (typeof path !== 'string')
      throw new RelocationRefusedError('invalid-repository-path');
    const moved = movedOwnedPath(transition, path);
    if (moved !== path && !evidence.repositoryPaths.includes(path))
      throw new RelocationRefusedError(
        'unproven-repository-path',
        `workspace=${JSON.stringify(evidence.workspaceId.slice(0, 160))} field=${field} path=${JSON.stringify(relative(transition.from.canonicalDataRoot, path).slice(0, 1000))}`,
      );
    return moved;
  };
  const next = { ...document };
  if (document.authorityId !== undefined)
    next.authorityId = transition.to.authorityId;
  for (const key of [
    'repoPath',
    'sourceRepoPath',
    'externalPath',
    'folderPath',
  ] as const)
    if (document[key] !== undefined) next[key] = project(document[key], key);
  if (document.repos !== undefined) {
    if (!Array.isArray(document.repos))
      throw new RelocationRefusedError('invalid-repositories');
    next.repos = document.repos.map((repo: unknown, index: number) => {
      if (!isJsonObject(repo))
        throw new RelocationRefusedError('invalid-repository');
      return {
        ...repo,
        repoPath: project(repo.repoPath, `repos[${index}].repoPath`),
      };
    });
  }
  if (document.temporaryRepoIdentityKeys !== undefined) {
    if (!Array.isArray(document.temporaryRepoIdentityKeys))
      throw new RelocationRefusedError('invalid-repository-identity-keys');
    next.temporaryRepoIdentityKeys = document.temporaryRepoIdentityKeys.map(
      (key: unknown, index: number) => {
        if (typeof key !== 'string')
          throw new RelocationRefusedError('invalid-repository-identity-key');
        return key.startsWith('path:')
          ? `path:${project(key.slice('path:'.length), `temporaryRepoIdentityKeys[${index}]`)}`
          : key;
      },
    );
  }
  const projectWorktreePath: PathProjection = (path) => {
    if (typeof path !== 'string')
      throw new RelocationRefusedError('invalid-worktree-path');
    const moved = movedOwnedPath(transition, path);
    if (
      moved !== path &&
      !evidence.repositoryPaths.includes(path) &&
      !evidence.ownedPaths?.includes(path)
    )
      throw new RelocationRefusedError('unproven-worktree-path');
    return moved;
  };
  const rows =
    previousList.authority === 'ok'
      ? previousList.worktrees.map((row, index) => {
          // Host projections may omit optional fields; inspect the frozen owner document.
          const raw: unknown = Array.isArray(previousList.document.worktrees)
            ? previousList.document.worktrees[index]
            : undefined;
          if (!isWorkspaceWorktreeReadRow(raw) || raw.id !== row.id)
            throw new RelocationRefusedError('metadata-evidence-mismatch');
          return {
            ...worktreePaths(raw, projectWorktreePath),
            id: raw.id,
            branchName: raw.branchName,
            createdAt: raw.createdAt,
            replica: localReplica(
              parseWorktreeReplica(raw.replica, evidence.workspaceId, raw.id),
              transition,
              evidence.targetId,
            ),
          };
        })
      : undefined;
  await manifest.replaceDocument(evidence.workspaceId, next, previous);
  if (rows) await list.replace(evidence.workspaceId, rows, previousList);
}

import {
  GITHUB_ITEM_NUMBER_MAX,
  isGitHubRepositoryName,
} from '@canopy/protocol/reference-previews';
import type { GitHubRepositoryRef } from './request-handle';

/**
 * The opaque `repositoryId` and `pullRequestId` of `core.pullRequest.*`
 * (CAN-4109). A repository id names a repository a workspace records (its own,
 * or a multi-repository member); a pull request id adds the GitHub owner and
 * name `origin` named at mint time and the number. They are structural, not
 * signed, so they stay stable across restarts: authority comes from resolving
 * the workspace record and re-reading `origin` on every call, never from the
 * identifier, so a well-formed identifier reaches only what a recorded
 * repository's `origin` names. Clients must not parse them.
 */
export interface RecordedRepositoryRef {
  readonly workspaceId: string;
  /** Absent for the workspace's own repository. */
  readonly repoId?: string;
}

export interface PullRequestIdentity {
  readonly repository: RecordedRepositoryRef;
  readonly github: GitHubRepositoryRef;
  readonly number: number;
}

const REPOSITORY_PREFIX = 'ghrepo1.';
const PULL_REQUEST_PREFIX = 'ghpr1.';
const MAX_ID_LENGTH = 512;
const MAX_RECORD_ID_LENGTH = 255;
// The longest GitHub owner and name, so every pull request of a minted
// repository id has an identifier within the canonical 512 characters.
const LONGEST_GITHUB: PullRequestIdentity['github'] = {
  owner: 'o'.repeat(39),
  repo: 'r'.repeat(100),
};

function encode(prefix: string, value: unknown[]): string {
  return `${prefix}${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
}

function decode(prefix: string, id: string): unknown[] | null {
  if (!id.startsWith(prefix) || id.length > MAX_ID_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(id.slice(prefix.length), 'base64url').toString('utf8'),
    );
  } catch {
    return null;
  }
  return Array.isArray(value) ? value : null;
}

function isRecordId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_RECORD_ID_LENGTH
  );
}

function repositoryFields(
  workspaceId: unknown,
  repoId: unknown,
): RecordedRepositoryRef | null {
  if (!isRecordId(workspaceId)) return null;
  if (repoId === null) return { workspaceId };
  return isRecordId(repoId) ? { workspaceId, repoId } : null;
}

export function isGitHubRepositoryRef(
  owner: unknown,
  repo: unknown,
): owner is string {
  return (
    typeof owner === 'string' &&
    typeof repo === 'string' &&
    isGitHubRepositoryName(owner.toLowerCase(), repo.toLowerCase())
  );
}

/** Whether two refs name one GitHub repository; GitHub names ignore case. */
export function sameGitHubRepository(
  a: GitHubRepositoryRef,
  b: GitHubRepositoryRef,
): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

function pullRequestIdOf(identity: PullRequestIdentity): string {
  return encode(PULL_REQUEST_PREFIX, [
    identity.repository.workspaceId,
    identity.repository.repoId ?? null,
    identity.github.owner,
    identity.github.repo,
    identity.number,
  ]);
}

/**
 * The repository id of a recorded repository, or `null` when its record
 * identifiers are too long for the canonical identifiers (those keep the
 * direct path, as CAN-5136's long ids do).
 */
export function mintRepositoryId(
  repository: RecordedRepositoryRef,
): string | null {
  if (
    !repositoryFields(repository.workspaceId, repository.repoId ?? null) ||
    pullRequestIdOf({
      repository,
      github: LONGEST_GITHUB,
      number: GITHUB_ITEM_NUMBER_MAX,
    }).length > MAX_ID_LENGTH
  )
    return null;
  return encode(REPOSITORY_PREFIX, [
    repository.workspaceId,
    repository.repoId ?? null,
  ]);
}

/** The recorded repository a minted repository id names, or `null`. */
export function parseRepositoryId(id: string): RecordedRepositoryRef | null {
  const fields = decode(REPOSITORY_PREFIX, id);
  if (!fields || fields.length !== 2) return null;
  const repository = repositoryFields(fields[0], fields[1]);
  // Only the canonical spelling the host mints.
  return repository && mintRepositoryId(repository) === id ? repository : null;
}

/** The pull request id; `null` when its fields are not a minted identity. */
export function mintPullRequestId(
  identity: PullRequestIdentity,
): string | null {
  if (
    mintRepositoryId(identity.repository) === null ||
    !isGitHubRepositoryRef(identity.github.owner, identity.github.repo) ||
    !Number.isSafeInteger(identity.number) ||
    identity.number < 1 ||
    identity.number > GITHUB_ITEM_NUMBER_MAX
  )
    return null;
  return pullRequestIdOf(identity);
}

export function parsePullRequestId(id: string): PullRequestIdentity | null {
  const fields = decode(PULL_REQUEST_PREFIX, id);
  if (!fields || fields.length !== 5) return null;
  const [workspaceId, repoId, owner, repo, number] = fields;
  const repository = repositoryFields(workspaceId, repoId);
  if (
    !repository ||
    !isGitHubRepositoryRef(owner, repo) ||
    typeof repo !== 'string' ||
    typeof number !== 'number'
  )
    return null;
  const identity: PullRequestIdentity = {
    repository,
    github: { owner, repo },
    number,
  };
  return mintPullRequestId(identity) === id ? identity : null;
}

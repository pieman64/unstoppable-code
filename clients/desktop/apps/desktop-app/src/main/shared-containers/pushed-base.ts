import { resolveGitHubTokenWithSource } from '../lib/github-auth';
import {
  countCommits,
  getHeadCommitSha,
  listRemoteTrackingCandidates,
  mergeBase,
} from '../lib/git';
import { getGitHubClient } from '../lib/github-client';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { resolveEffectiveBaseBranchForRepo } from '../lib/worktree-base-branches';
import { parseGitHubRemote } from './materialize/code';
import { sanitizeRemoteUrl } from '../lib/plan-share-repos';
import { getRemoteUrlStrict } from '../lib/git';

export interface SharedContainerPushedBase {
  baseSha: string;
  headSha: string;
  unpushedCommitCount: number;
}

export interface SharedContainerPushedBaseDependencies {
  getHead(repoPath: string): Promise<string | null>;
  resolveBaseBranch(input: {
    projectId: string;
    worktreeId: string;
    repoId: string;
    repoPath: string;
    allowRemoteLookup?: boolean;
  }): Promise<{ branch: string | null }>;
  listCandidates(repoPath: string, baseBranch?: string): Promise<string[]>;
  mergeBase(repoPath: string, a: string, b: string): Promise<string | null>;
  countCommits(repoPath: string, range: string): Promise<number>;
  getRemoteUrl(repoPath: string): Promise<string | null>;
  resolveToken(): Promise<string>;
  probeCommit(
    owner: string,
    repository: string,
    sha: string,
    token: string,
  ): Promise<void>;
}

const DEFAULT_DEPENDENCIES: SharedContainerPushedBaseDependencies = {
  getHead: getHeadCommitSha,
  resolveBaseBranch: resolveEffectiveBaseBranchForRepo,
  listCandidates: listRemoteTrackingCandidates,
  mergeBase,
  countCommits,
  getRemoteUrl: getRemoteUrlStrict,
  resolveToken: async () => (await resolveGitHubTokenWithSource()).token,
  probeCommit: async (owner, repository, sha, token) => {
    await getGitHubClient().enqueue(
      (octokit) =>
        octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
          owner,
          repo: repository,
          ref: sha,
        }),
      'high',
      { authenticationToken: token },
    );
  },
};

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 404
  );
}

export async function resolveSharedContainerPushedBase(
  input: {
    projectId: string;
    worktreeId: string;
    repoId: string;
    repoPath: string;
    /** False resolves the base branch from local knowledge only. */
    allowRemoteLookup?: boolean;
  },
  deps: SharedContainerPushedBaseDependencies = DEFAULT_DEPENDENCIES,
): Promise<SharedContainerPushedBase | null> {
  const headSha = await deps.getHead(input.repoPath);
  if (!headSha) return null;
  const effectiveBase = await deps.resolveBaseBranch(input);
  const refs = await deps.listCandidates(
    input.repoPath,
    effectiveBase.branch ?? undefined,
  );
  const candidates: Array<{ baseSha: string; count: number }> = [];
  for (const ref of refs) {
    const baseSha = await deps.mergeBase(input.repoPath, 'HEAD', ref);
    if (!baseSha) continue;
    const count = await deps.countCommits(
      input.repoPath,
      `${baseSha}..${headSha}`,
    );
    candidates.push({ baseSha, count });
  }
  candidates.sort((left, right) => left.count - right.count);
  if (candidates.length === 0) return null;

  const remote = await deps.getRemoteUrl(input.repoPath).catch(() => null);
  const coordinates = remote
    ? parseGitHubRemote(sanitizeRemoteUrl(remote) ?? '')
    : null;
  const token = coordinates ? await deps.resolveToken().catch(() => '') : '';
  for (const candidate of candidates) {
    if (coordinates && token) {
      try {
        await deps.probeCommit(
          coordinates.owner,
          coordinates.repository,
          candidate.baseSha,
          token,
        );
      } catch (error) {
        if (isNotFound(error)) continue;
        logMainProcessWarn(
          '[shared-containers] GitHub pushed-base verification unavailable; trusting local remote-tracking ref',
        );
      }
    } else {
      logMainProcessWarn(
        '[shared-containers] GitHub pushed-base verification unavailable; trusting local remote-tracking ref',
      );
    }
    return {
      baseSha: candidate.baseSha,
      headSha,
      unpushedCommitCount: candidate.count,
    };
  }
  return null;
}

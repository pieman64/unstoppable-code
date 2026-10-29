import { getGitHubClient } from './github-client';
import { parseGitHubRemote } from './github-pr';
import { getRemoteUrl, getCurrentBranch } from './git';
import { getWorktreeDir } from './paths';
import { logMainProcessWarn } from './main-process-logging';
import { readAllSidebarItems } from './sidebar-items';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';
import type {
  PrCheckStatusValue,
  PrReviewStatusValue,
  PrStateValue,
} from '@canopy/protocol/telemetry';
import type {
  PullRequestRecord,
  ReconcilableRepo,
} from '../services/pr-telemetry-reconciler';

/** GitHub search caps a single page at 100 items. */
const SEARCH_PAGE_SIZE = 100;

/**
 * GitHub search returns at most 1000 results for one query. Paging past that
 * yields nothing, so it is the real ceiling rather than a policy choice.
 */
const SEARCH_RESULT_CEILING = 1000;

interface SearchGraphQlResponse {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      number?: number;
      title?: string;
      url?: string;
      createdAt?: string;
      mergedAt?: string | null;
      closedAt?: string | null;
      state?: string;
      isDraft?: boolean;
      headRefName?: string;
      additions?: number;
      deletions?: number;
      changedFiles?: number;
      comments?: { totalCount?: number };
      reviewDecision?: string | null;
      commits?: {
        nodes?: Array<{
          commit?: { statusCheckRollup?: { state?: string } | null };
        } | null>;
      };
    } | null>;
  };
}

/**
 * Search for the viewer's PRs, returning `headRefName` in the same round trip.
 *
 * REST search does not expose the head ref, and fetching it per PR would be one
 * extra request each. The head ref is required, not cosmetic: it is what lets
 * the sweep skip PRs the live poller can still see (see `listReconcilableRepos`).
 *
 * `reviewDecision` and the head commit's `statusCheckRollup` ride along for the
 * same reason: a state update for a PR the poller sent rewrites the whole row,
 * so it must carry the observed check and review outcomes rather than `none`.
 */
const VIEWER_PRS_QUERY = `
  query($q: String!, $cursor: String) {
    search(query: $q, type: ISSUE, first: ${SEARCH_PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          number
          title
          url
          createdAt
          mergedAt
          closedAt
          state
          isDraft
          headRefName
          additions
          deletions
          changedFiles
          comments { totalCount }
          reviewDecision
          commits(last: 1) {
            nodes { commit { statusCheckRollup { state } } }
          }
        }
      }
    }
  }
`;

/**
 * Resolve every (workspace, repo) pair the sweep can query, along with the
 * branches that currently have a tracked worktree in that workspace.
 *
 * Cowork workspaces have no git remote of their own and are skipped; work done
 * in them lands in a normal repo workspace, which this sweep already covers.
 */
export async function listReconcilableRepos(): Promise<ReconcilableRepo[]> {
  const { items } = await readAllSidebarItems().catch(() => ({
    items: [] as Awaited<ReturnType<typeof readAllSidebarItems>>['items'],
  }));
  const repos: ReconcilableRepo[] = [];

  for (const entry of items) {
    if (entry.type === 'cowork') {
      continue;
    }

    // Accumulated per remote, because a single-repo workspace repeats one
    // remote across every worktree while a multi-repo workspace exposes several
    // through per-repo checkout paths.
    const byRemote = new Map<
      string,
      {
        owner: string;
        repo: string;
        ownedPrNumbers: Set<number>;
        unresolvedLiveBranches: Set<string>;
        liveBranches: Set<string>;
      }
    >();

    for (const worktree of entry.worktrees) {
      const worktreePath = getWorktreeDir(entry.id, worktree.id);
      // Resolve the same checkout paths the poller resolves. Reading the
      // worktree root alone would miss every sibling repo of a multi-repo
      // workspace, and find nothing at all when the root is not itself a repo.
      const repoPaths =
        entry.type === 'multi-repo'
          ? (
              await listWorkspaceWorktreeRepoEntries(
                entry.id,
                worktreePath,
              ).catch(() => [])
            ).map((repoEntry) => ({
              path: repoEntry.repoPath,
              repoId: repoEntry.repoId,
            }))
          : [{ path: worktreePath, repoId: undefined }];

      for (const { path: repoPath, repoId } of repoPaths) {
        const remoteUrl = await getRemoteUrl(repoPath).catch(() => null);
        if (!remoteUrl) {
          continue;
        }
        const remote = parseGitHubRemote(remoteUrl);
        if (!remote) {
          continue;
        }
        const key = `${remote.owner}/${remote.repo}`;
        let bucket = byRemote.get(key);
        if (!bucket) {
          bucket = {
            owner: remote.owner,
            repo: remote.repo,
            ownedPrNumbers: new Set<number>(),
            unresolvedLiveBranches: new Set<string>(),
            liveBranches: new Set<string>(),
          };
          byRemote.set(key, bucket);
        }

        // What the poller currently reports for this repo, if anything.
        const repoStatuses = worktree.lastKnownPrStatus?.repos ?? [];
        const matching = repoStatuses.filter((candidate) =>
          repoId === undefined ? true : candidate.repoId === repoId,
        );
        const observed = matching.filter(
          (candidate) => candidate.status !== null,
        );
        for (const candidate of observed) {
          if (candidate.status) {
            bucket.ownedPrNumbers.add(candidate.status.prNumber);
          }
        }
        const branch = await getCurrentBranch(repoPath).catch(() => '');
        if (branch) {
          // The poller reports this branch's open PR itself.
          bucket.liveBranches.add(branch);
          if (observed.length === 0) {
            // No recorded PR state: the poller's intent here is unknown, so
            // any PR still sitting on this branch is deferred to it.
            bucket.unresolvedLiveBranches.add(branch);
          }
        }
      }
    }

    for (const bucket of Array.from(byRemote.values())) {
      repos.push({
        projectId: entry.id,
        repoId: bucket.repo,
        repoName: bucket.repo,
        owner: bucket.owner,
        repo: bucket.repo,
        // Every worktree of a single-repo workspace shares one remote, so a PR
        // number is unambiguous within it. Multi-repo workspaces keep strict
        // per-repo key matching.
        dedupeByPrNumberOnly: entry.type === 'single-repo',
        ownedPrNumbers: bucket.ownedPrNumbers,
        unresolvedLiveBranches: bucket.unresolvedLiveBranches,
        liveBranches: bucket.liveBranches,
      });
    }
  }
  return repos;
}

let cachedViewerLogin: string | null = null;

/**
 * Drop the cached GitHub login.
 *
 * Must be called whenever GitHub credentials change. The login is used as the
 * search `author:` qualifier while the token supplies identity, so a stale
 * login after an account switch would search as the PREVIOUS account and
 * upload any matches as the currently signed-in user's work -- a silent
 * mis-attribution, not merely a stale read.
 */
export function invalidateReconcileViewerCache(): void {
  cachedViewerLogin = null;
}

/** GitHub login of the authenticated user, cached until credentials change. */
async function getViewerLogin(): Promise<string | null> {
  if (cachedViewerLogin) {
    return cachedViewerLogin;
  }
  try {
    const client = getGitHubClient();
    const response = await client.enqueue(
      (octokit) => octokit.users.getAuthenticated(),
      'normal',
      { operation: 'read', idempotency: 'safe' },
    );
    const login = response.data.login;
    // Re-check: an `invalidateReconcileViewerCache()` that landed while this
    // request was in flight must win, otherwise the pre-switch login would be
    // written back under the new credentials.
    if (cachedViewerLogin === null) {
      cachedViewerLogin = login;
    }
    return login;
  } catch (error) {
    logMainProcessWarn(
      '[pr-reconcile] Could not resolve the authenticated GitHub user',
      error,
    );
    return null;
  }
}

/**
 * GitHub's combined check state for the head commit, in the poller's terms.
 * A missing rollup means GitHub reported no checks, left unset so the payload
 * says `none` instead of guessing.
 */
function toCheckStatus(
  state: string | undefined,
): PrCheckStatusValue | undefined {
  switch (state) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return undefined;
  }
}

/** GitHub's PR state, in the poller's terms (a draft PR is `draft`). */
function toPrState(
  state: string | undefined,
  isDraft: boolean | undefined,
): PrStateValue | undefined {
  switch (state) {
    case 'MERGED':
      return 'merged';
    case 'CLOSED':
      return 'closed';
    case 'OPEN':
      return isDraft === true ? 'draft' : 'open';
    default:
      return undefined;
  }
}

/** Whether `iso` is at or after `since`. Unparseable instants are not. */
function isAtOrAfter(iso: string | null | undefined, since: Date): boolean {
  if (!iso) {
    return false;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= since.getTime();
}

/** GitHub's review decision, in the poller's terms. */
function toReviewStatus(
  decision: string | null | undefined,
): PrReviewStatusValue | undefined {
  switch (decision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'pending';
    default:
      return undefined;
  }
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * PRs authored by the authenticated user in one repo inside the lookback
 * window: merged at or after `since`, or unmerged (open, draft or closed) and
 * opened or closed at or after `since` (CAN-3516).
 *
 * Uses search rather than `pulls.list` because search filters by author and
 * date server-side; `pulls.list` would page the repo's entire PR history to
 * find a handful of our own. One `updated:>=` query covers every state: a PR
 * merged, closed or opened in the window was also updated in it. That keeps
 * the sweep at one search per repo, as it was when it looked for merges only.
 * The per-state window is then applied here, so a PR that was merged earlier
 * and merely commented on inside the window is not treated as a recent merge.
 */
export async function listPullRequestsByViewer(
  repo: ReconcilableRepo,
  since: Date,
): Promise<PullRequestRecord[]> {
  const login = await getViewerLogin();
  if (!login) {
    return [];
  }
  const client = getGitHubClient();
  const q = [
    `repo:${repo.owner}/${repo.repo}`,
    'is:pr',
    `author:${login}`,
    `updated:>=${toIsoDate(since)}`,
  ].join(' ');

  const records: PullRequestRecord[] = [];
  let cursor: string | null = null;
  while (records.length < SEARCH_RESULT_CEILING) {
    const response: SearchGraphQlResponse = await client.enqueue(
      (octokit) =>
        octokit.graphql<SearchGraphQlResponse>(VIEWER_PRS_QUERY, { q, cursor }),
      'normal',
      { operation: 'read', idempotency: 'safe', resource: 'graphql' },
    );
    for (const node of response.search.nodes) {
      if (!node?.number || !node.url || !node.createdAt) {
        continue;
      }
      const state = toPrState(node.state, node.isDraft);
      if (state === undefined) {
        continue;
      }
      const inWindow =
        state === 'merged'
          ? isAtOrAfter(node.mergedAt, since)
          : isAtOrAfter(node.createdAt, since) ||
            isAtOrAfter(node.closedAt, since);
      if (!inWindow) {
        continue;
      }
      const checkStatus = toCheckStatus(
        node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state,
      );
      const reviewStatus = toReviewStatus(node.reviewDecision);
      records.push({
        prNumber: node.number,
        title: node.title ?? '',
        prUrl: node.url,
        state,
        openedAt: node.createdAt,
        ...(state === 'merged' && node.mergedAt
          ? { mergedAt: node.mergedAt }
          : {}),
        headRefName: node.headRefName,
        additions: node.additions,
        deletions: node.deletions,
        changedFiles: node.changedFiles,
        commentCount: node.comments?.totalCount ?? 0,
        ...(checkStatus !== undefined ? { checkStatus } : {}),
        ...(reviewStatus !== undefined ? { reviewStatus } : {}),
      });
    }
    if (!response.search.pageInfo.hasNextPage) {
      return records;
    }
    cursor = response.search.pageInfo.endCursor;
  }
  // Only reachable if one author updated >1000 PRs in one repo inside the
  // lookback window. Logged rather than silently truncated: the omitted PRs
  // have no later sweep guaranteed to pick them up.
  logMainProcessWarn(
    '[pr-reconcile] Hit the GitHub search result ceiling; some PRs may be omitted',
    { repo: `${repo.owner}/${repo.repo}`, ceiling: SEARCH_RESULT_CEILING },
  );
  return records;
}

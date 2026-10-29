import type { PrStateValue } from '@canopy/protocol/telemetry';
import {
  PR_RECONCILIATION_LOOKBACK_DAYS,
  pullRequestKey,
  reconcilePullRequests,
  toPullRequestPayload,
  type PullRequestRecord,
  type PrReconciliationDeps,
  type ReconcilableRepo,
} from '../pr-telemetry-reconciler';

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);

function repo(overrides: Partial<ReconcilableRepo> = {}): ReconcilableRepo {
  return {
    projectId: 'canopy',
    repoId: 'canopy',
    repoName: 'canopy',
    owner: 'example-org',
    repo: 'example-repo',
    dedupeByPrNumberOnly: true,
    ownedPrNumbers: new Set<number>(),
    unresolvedLiveBranches: new Set<string>(),
    liveBranches: new Set<string>(),
    ...overrides,
  };
}

function pr(
  prNumber: number,
  overrides: Partial<PullRequestRecord> = {},
): PullRequestRecord {
  return {
    prNumber,
    title: `PR ${prNumber}`,
    prUrl: `https://github.com/example-org/example-repo/pull/${prNumber}`,
    state: 'merged',
    openedAt: '2026-08-26T10:00:00Z',
    mergedAt: '2026-08-27T10:00:00Z',
    headRefName: `feat/pr-${prNumber}`,
    ...overrides,
  };
}

interface Harness {
  deps: PrReconciliationDeps;
  enqueued: { projectId: string; numbers: number[] }[];
  stateUpdates: { projectId: string; numbers: number[]; states: string[] }[];
}

function harness(options: {
  repos: ReconcilableRepo[];
  prsByRepo: Record<string, PullRequestRecord[]>;
  synced?: Record<string, string[]>;
  syncedPrUrls?: string[];
  syncedPrStates?: Record<string, PrStateValue>;
  /** Projects whose enqueue accepts nothing (sharing off, no metadata). */
  ineligibleProjects?: string[];
  enqueueError?: Error;
  listError?: Error;
}): Harness {
  const enqueued: Harness['enqueued'] = [];
  const stateUpdates: Harness['stateUpdates'] = [];
  return {
    enqueued,
    stateUpdates,
    deps: {
      listRepos: () => Promise.resolve(options.repos),
      listPullRequestsByViewer: (r): Promise<PullRequestRecord[]> => {
        if (options.listError) return Promise.reject(options.listError);
        return Promise.resolve(options.prsByRepo[`${r.owner}/${r.repo}`] ?? []);
      },
      getSyncedPrKeys: (projectId) =>
        Promise.resolve(new Set(options.synced?.[projectId] ?? [])),
      getSyncedPrUrls: () =>
        Promise.resolve(new Set(options.syncedPrUrls ?? [])),
      getSyncedPrStates: () =>
        Promise.resolve(new Map(Object.entries(options.syncedPrStates ?? {}))),
      enqueue: (projectId, payloads): Promise<ReadonlySet<string>> => {
        if (options.enqueueError) return Promise.reject(options.enqueueError);
        if (options.ineligibleProjects?.includes(projectId)) {
          return Promise.resolve(new Set<string>());
        }
        enqueued.push({
          projectId,
          numbers: payloads.map((p) => p.prNumber),
        });
        return Promise.resolve(new Set(payloads.map((p) => p.prUrl)));
      },
      enqueueStateUpdates: (
        projectId,
        payloads,
      ): Promise<ReadonlySet<string>> => {
        if (options.enqueueError) return Promise.reject(options.enqueueError);
        if (options.ineligibleProjects?.includes(projectId)) {
          return Promise.resolve(new Set<string>());
        }
        stateUpdates.push({
          projectId,
          numbers: payloads.map((p) => p.prNumber),
          states: payloads.map((p) => p.state),
        });
        return Promise.resolve(new Set(payloads.map((p) => p.prUrl)));
      },
      now: () => NOW,
    },
  };
}

describe('reconcilePullRequests', () => {
  it('recovers merged PRs that were never synced', async () => {
    const h = harness({
      repos: [repo()],
      prsByRepo: { 'example-org/example-repo': [pr(1), pr(2), pr(3)] },
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsRecovered).toBe(3);
    expect(result.reposSwept).toBe(1);
    expect(result.reposFailed).toBe(0);
    expect(h.enqueued).toEqual([{ projectId: 'canopy', numbers: [1, 2, 3] }]);
  });

  it('skips PRs the live poller already synced', async () => {
    const h = harness({
      repos: [repo()],
      prsByRepo: { 'example-org/example-repo': [pr(1), pr(2), pr(3)] },
      synced: { canopy: [pullRequestKey('canopy', 2)] },
      syncedPrUrls: [pr(2).prUrl],
      syncedPrStates: { [pr(2).prUrl]: 'merged' },
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsRecovered).toBe(2);
    expect(h.enqueued[0].numbers).toEqual([1, 3]);
  });

  it('enqueues nothing when everything is already synced', async () => {
    const h = harness({
      repos: [repo()],
      prsByRepo: { 'example-org/example-repo': [pr(1)] },
      synced: { canopy: [pullRequestKey('canopy', 1)] },
      syncedPrUrls: [pr(1).prUrl],
      syncedPrStates: { [pr(1).prUrl]: 'merged' },
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsRecovered).toBe(0);
    expect(h.enqueued).toEqual([]);
    expect(h.stateUpdates).toEqual([]);
  });

  it('is idempotent across consecutive sweeps', async () => {
    const prs = [pr(1), pr(2)];
    const synced: Record<string, string[]> = { canopy: [] };
    const syncedPrUrls = new Set<string>();
    const syncedPrStates = new Map<string, PrStateValue>();
    const enqueued: number[][] = [];
    const deps: PrReconciliationDeps = {
      listRepos: () => Promise.resolve([repo()]),
      listPullRequestsByViewer: () => Promise.resolve(prs),
      getSyncedPrKeys: () => Promise.resolve(new Set(synced.canopy)),
      getSyncedPrUrls: () => Promise.resolve(new Set(syncedPrUrls)),
      getSyncedPrStates: () => Promise.resolve(new Map(syncedPrStates)),
      enqueue: (_projectId, payloads) => {
        enqueued.push(payloads.map((p) => p.prNumber));
        // Simulate the sync map recording what was just queued.
        for (const p of payloads) {
          synced.canopy.push(pullRequestKey(p.repoId, p.prNumber));
          syncedPrUrls.add(p.prUrl ?? '');
          syncedPrStates.set(p.prUrl ?? '', p.state);
        }
        return Promise.resolve(new Set(payloads.map((p) => p.prUrl)));
      },
      enqueueStateUpdates: () => Promise.reject(new Error('unexpected')),
      now: () => NOW,
    };

    await reconcilePullRequests(deps);
    await reconcilePullRequests(deps);

    expect(enqueued).toEqual([[1, 2]]);
  });

  it('skips a PR synced under another project identity', async () => {
    const merged = pr(42);
    const h = harness({
      repos: [
        repo({ projectId: 'unstoppable-domains-website' }),
        repo({
          projectId: 'unstoppable-domains-website-2',
          dedupeByPrNumberOnly: false,
        }),
      ],
      prsByRepo: { 'example-org/example-repo': [merged] },
      synced: { 'unstoppable-domains-website': ['worktree#42'] },
      syncedPrUrls: [merged.prUrl],
      syncedPrStates: { [merged.prUrl]: 'merged' },
    });

    const result = await reconcilePullRequests(h.deps);

    expect(result.prsRecovered).toBe(0);
    expect(h.enqueued).toEqual([]);
  });

  it('recovers an unobserved PR only once across project identities', async () => {
    const h = harness({
      repos: [
        repo({ projectId: 'unstoppable-domains-website' }),
        repo({ projectId: 'unstoppable-domains-website-2' }),
      ],
      prsByRepo: { 'example-org/example-repo': [pr(43)] },
    });

    const result = await reconcilePullRequests(h.deps);

    expect(result.prsRecovered).toBe(1);
    expect(h.enqueued).toEqual([
      { projectId: 'unstoppable-domains-website', numbers: [43] },
    ]);
    // Recovering it for one identity is not a state change for the other.
    expect(h.stateUpdates).toEqual([]);
  });

  it('does not double-enqueue when a project lists a repo twice', async () => {
    const h = harness({
      repos: [repo(), repo()],
      prsByRepo: { 'example-org/example-repo': [pr(7)] },
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsRecovered).toBe(1);
    expect(h.enqueued).toEqual([{ projectId: 'canopy', numbers: [7] }]);
    expect(h.stateUpdates).toEqual([]);
  });

  it('isolates a failing repo from the rest of the sweep', async () => {
    const enqueued: Harness['enqueued'] = [];
    const deps: PrReconciliationDeps = {
      listRepos: () =>
        Promise.resolve([
          repo({ projectId: 'broken', repoId: 'broken', repo: 'broken' }),
          repo(),
        ]),
      listPullRequestsByViewer: (r) => {
        if (r.repo === 'broken')
          return Promise.reject(new Error('rate limited'));
        return Promise.resolve([pr(9)]);
      },
      getSyncedPrKeys: () => Promise.resolve(new Set<string>()),
      getSyncedPrUrls: () => Promise.resolve(new Set<string>()),
      getSyncedPrStates: () => Promise.resolve(new Map<string, PrStateValue>()),
      enqueue: (projectId, payloads) => {
        enqueued.push({ projectId, numbers: payloads.map((p) => p.prNumber) });
        return Promise.resolve(new Set(payloads.map((p) => p.prUrl)));
      },
      enqueueStateUpdates: () => Promise.resolve(new Set<string>()),
      now: () => NOW,
    };
    const result = await reconcilePullRequests(deps);

    expect(result.reposFailed).toBe(1);
    expect(result.reposSwept).toBe(1);
    expect(result.prsRecovered).toBe(1);
    expect(enqueued).toEqual([{ projectId: 'canopy', numbers: [9] }]);
  });

  it('reports an enqueue failure without throwing', async () => {
    const h = harness({
      repos: [repo()],
      prsByRepo: { 'example-org/example-repo': [pr(1)] },
      enqueueError: new Error('offline'),
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsRecovered).toBe(0);
    expect(result.reposFailed).toBe(1);
  });

  it('groups recovered PRs per project', async () => {
    const h = harness({
      repos: [
        repo(),
        repo({
          projectId: 'website',
          repoId: 'website',
          repo: 'unstoppable-domains-website',
        }),
      ],
      prsByRepo: {
        'example-org/example-repo': [pr(1)],
        'example-org/unstoppable-domains-website': [pr(50)],
      },
    });
    await reconcilePullRequests(h.deps);

    expect(h.enqueued).toEqual([
      { projectId: 'canopy', numbers: [1] },
      { projectId: 'website', numbers: [50] },
    ]);
  });

  it('recognises PRs the poller synced under a per-worktree repoId', async () => {
    // Regression: for a single-repo workspace the live poller writes
    // `repoId = basename(worktreeDir)`, so the same repo appears under many
    // ids (one real account: 69 PR keys across 47 distinct repoIds). Matching
    // on repoId alone would miss these and re-ingest them as duplicates.
    const h = harness({
      repos: [repo()],
      prsByRepo: { 'example-org/example-repo': [pr(2427), pr(2611)] },
      synced: { canopy: ['alligator#2427', 'kudu#2611'] },
      syncedPrUrls: [pr(2427).prUrl, pr(2611).prUrl],
      syncedPrStates: {
        [pr(2427).prUrl]: 'merged',
        [pr(2611).prUrl]: 'merged',
      },
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsRecovered).toBe(0);
    expect(h.enqueued).toEqual([]);
  });

  it('still recovers unsynced PRs alongside worktree-keyed ones', async () => {
    const h = harness({
      repos: [repo()],
      prsByRepo: { 'example-org/example-repo': [pr(2427), pr(9999)] },
      synced: { canopy: ['alligator#2427'] },
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsRecovered).toBe(1);
    expect(h.enqueued[0].numbers).toEqual([9999]);
  });

  it('keeps strict per-repo matching for multi-repo projects', async () => {
    // Two sibling repos may legitimately share a PR number, so a multi-repo
    // workspace must not treat `other#7` as covering `canopy#7`.
    const h = harness({
      repos: [repo({ dedupeByPrNumberOnly: false })],
      prsByRepo: { 'example-org/example-repo': [pr(7)] },
      synced: { canopy: ['other-repo#7'] },
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsRecovered).toBe(1);
    expect(h.enqueued[0].numbers).toEqual([7]);
  });

  it('leaves PRs the poller currently reports and already sent to the poller', async () => {
    // Both writers producing a row would double-count: the storage key is
    // (worktreeId, repoId, prNumber), not a PR identity.
    const h = harness({
      repos: [repo({ ownedPrNumbers: new Set([1]) })],
      prsByRepo: { 'example-org/example-repo': [pr(1), pr(2)] },
      synced: { canopy: [pullRequestKey('tapir', 1)] },
      syncedPrUrls: [pr(1).prUrl],
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsLeftToPoller).toBe(1);
    expect(result.prsRecovered).toBe(1);
    expect(h.enqueued).toEqual([{ projectId: 'canopy', numbers: [2] }]);
  });

  it('recovers a PR a worktree lists but the poller never sent (#3994)', async () => {
    // tapir's persisted `lastKnownPrStatus` lists #3994, but no sync-map entry
    // or pending item exists for it: the poller never delivered it. Listing a
    // PR is not ownership; only a recorded key is, so the sweep uploads it.
    const h = harness({
      repos: [repo({ ownedPrNumbers: new Set([3994]) })],
      prsByRepo: {
        'example-org/example-repo': [
          pr(3994, { headRefName: 'tapir/pipeline-chain' }),
        ],
      },
      synced: { canopy: [pullRequestKey('tapir', 3854)] },
      syncedPrUrls: [pr(3854).prUrl],
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsLeftToPoller).toBe(0);
    expect(result.prsRecovered).toBe(1);
    expect(h.enqueued).toEqual([{ projectId: 'canopy', numbers: [3994] }]);
  });

  it('recovers an old merged PR whose branch name a newer PR reuses', async () => {
    // The poller resolves a branch to at most one PR, preferring the open one,
    // so the older merged PR is invisible to it forever. A branch-name-only
    // fence would have skipped it forever too and lost it permanently.
    const h = harness({
      repos: [
        repo({
          ownedPrNumbers: new Set([200]),
          unresolvedLiveBranches: new Set<string>(),
        }),
      ],
      prsByRepo: {
        'example-org/example-repo': [pr(100, { headRefName: 'feat/shared' })],
      },
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsRecovered).toBe(1);
    expect(h.enqueued[0].numbers).toEqual([100]);
  });

  it('defers a PR on a branch whose poller state is unknown', async () => {
    const h = harness({
      repos: [repo({ unresolvedLiveBranches: new Set(['feat/unknown']) })],
      prsByRepo: {
        'example-org/example-repo': [pr(5, { headRefName: 'feat/unknown' })],
      },
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsLeftToPoller).toBe(1);
    expect(h.enqueued).toEqual([]);
  });

  it('defers a PR whose head ref GitHub did not report', async () => {
    // Without a head ref the poller cannot be ruled out. A missed recovery is
    // retried next sweep; a duplicate is permanent.
    const h = harness({
      repos: [repo()],
      prsByRepo: {
        'example-org/example-repo': [pr(3, { headRefName: undefined })],
      },
    });
    const result = await reconcilePullRequests(h.deps);

    expect(result.prsLeftToPoller).toBe(1);
    expect(result.prsRecovered).toBe(0);
  });

  describe('open and closed PRs from untracked worktrees (CAN-3516)', () => {
    function open(
      prNumber: number,
      overrides: Partial<PullRequestRecord> = {},
    ): PullRequestRecord {
      return pr(prNumber, { state: 'open', mergedAt: undefined, ...overrides });
    }

    it('recovers open, draft and closed PRs no worktree tracks', async () => {
      // #4031 was opened from an agent side-worktree, #4055 from a /tmp
      // checkout: neither branch is checked out in a tracked worktree.
      const h = harness({
        repos: [repo()],
        prsByRepo: {
          'example-org/example-repo': [
            open(4031),
            open(4055, { state: 'draft' }),
            open(4162, { state: 'closed' }),
          ],
        },
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsRecovered).toBe(3);
      expect(h.enqueued).toEqual([
        { projectId: 'canopy', numbers: [4031, 4055, 4162] },
      ]);
      expect(h.stateUpdates).toEqual([]);
    });

    it('leaves an open PR on a checked-out branch to the poller', async () => {
      // The poller resolves a live branch to its open PR first, so it will
      // report this one; recovering it too would race the poller for it.
      const h = harness({
        repos: [repo({ liveBranches: new Set(['feat/pr-4200']) })],
        prsByRepo: { 'example-org/example-repo': [open(4200)] },
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsLeftToPoller).toBe(1);
      expect(h.enqueued).toEqual([]);
    });

    it('still recovers a merged PR whose branch a worktree has checked out', async () => {
      // Only open PRs are fenced by any live branch; the poller cannot see an
      // older merged PR on a branch that now has a newer one.
      const h = harness({
        repos: [
          repo({
            ownedPrNumbers: new Set([200]),
            liveBranches: new Set(['feat/shared']),
          }),
        ],
        prsByRepo: {
          'example-org/example-repo': [pr(100, { headRefName: 'feat/shared' })],
        },
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsRecovered).toBe(1);
    });

    it('recovers through another workspace when the first queues nothing', async () => {
      // The first workspace listing the repo has metadata sharing off. The
      // opened PR must still be recovered through the next one that can send
      // it, instead of being marked handled and dropped for this sweep.
      const h = harness({
        repos: [repo({ projectId: 'sharing-off' }), repo()],
        prsByRepo: { 'example-org/example-repo': [open(4031)] },
        ineligibleProjects: ['sharing-off'],
      });
      const result = await reconcilePullRequests(h.deps);

      expect(h.enqueued).toEqual([{ projectId: 'canopy', numbers: [4031] }]);
      expect(result.prsRecovered).toBe(1);
    });

    it('counts only recoveries that were queued', async () => {
      const h = harness({
        repos: [repo({ projectId: 'sharing-off' })],
        prsByRepo: { 'example-org/example-repo': [open(4031), pr(3994)] },
        ineligibleProjects: ['sharing-off'],
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsRecovered).toBe(0);
    });

    it('sends a state update when no workspace could recover the PR', async () => {
      // `legacy` recorded #3685 by key only (no URL), so for it this is a state
      // update; `sharing-off` sees it as new but queues nothing. The merge must
      // still go out through `legacy`.
      const h = harness({
        repos: [
          repo({ projectId: 'sharing-off' }),
          repo({ projectId: 'legacy' }),
        ],
        prsByRepo: { 'example-org/example-repo': [pr(3685)] },
        synced: { legacy: [pullRequestKey('flounder', 3685)] },
        ineligibleProjects: ['sharing-off'],
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsRecovered).toBe(0);
      expect(h.stateUpdates).toEqual([
        { projectId: 'legacy', numbers: [3685], states: ['merged'] },
      ]);
    });

    it('does not re-send an open PR that is already recorded', async () => {
      const h = harness({
        repos: [repo()],
        prsByRepo: { 'example-org/example-repo': [open(4031)] },
        synced: { canopy: [pullRequestKey('canopy', 4031)] },
        syncedPrUrls: [open(4031).prUrl],
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsRecovered).toBe(0);
      expect(result.prsStateUpdated).toBe(0);
    });

    it('sends the merge of an open recovery once it merges', async () => {
      const h = harness({
        repos: [repo()],
        prsByRepo: { 'example-org/example-repo': [pr(4031)] },
        synced: { canopy: [pullRequestKey('canopy', 4031)] },
        syncedPrUrls: [pr(4031).prUrl],
        syncedPrStates: { [pr(4031).prUrl]: 'open' },
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsStateUpdated).toBe(1);
      expect(h.stateUpdates).toEqual([
        { projectId: 'canopy', numbers: [4031], states: ['merged'] },
      ]);
    });

    it('sends the close of a PR first sent while open', async () => {
      // tapir sent #3786 while open and has since moved on to #3900.
      const h = harness({
        repos: [repo({ ownedPrNumbers: new Set([3900]) })],
        prsByRepo: {
          'example-org/example-repo': [open(3786, { state: 'closed' })],
        },
        synced: { canopy: [pullRequestKey('tapir', 3786)] },
        syncedPrUrls: [pr(3786).prUrl],
        syncedPrStates: { [pr(3786).prUrl]: 'open' },
      });
      const result = await reconcilePullRequests(h.deps);

      expect(h.stateUpdates).toEqual([
        { projectId: 'canopy', numbers: [3786], states: ['closed'] },
      ]);
      expect(result.prsStateUpdated).toBe(1);
    });

    it('does not re-send a close over a recorded merge', async () => {
      const h = harness({
        repos: [repo()],
        prsByRepo: {
          'example-org/example-repo': [open(3786, { state: 'closed' })],
        },
        synced: { canopy: [pullRequestKey('tapir', 3786)] },
        syncedPrUrls: [pr(3786).prUrl],
        syncedPrStates: { [pr(3786).prUrl]: 'merged' },
      });
      await reconcilePullRequests(h.deps);

      expect(h.stateUpdates).toEqual([]);
    });
  });

  it('asks GitHub for PRs inside the lookback window', async () => {
    const seen: Date[] = [];
    const deps: PrReconciliationDeps = {
      listRepos: () => Promise.resolve([repo()]),
      listPullRequestsByViewer: (_r, since) => {
        seen.push(since);
        return Promise.resolve([]);
      },
      getSyncedPrKeys: () => Promise.resolve(new Set<string>()),
      getSyncedPrUrls: () => Promise.resolve(new Set<string>()),
      getSyncedPrStates: () => Promise.resolve(new Map<string, PrStateValue>()),
      enqueue: () => Promise.resolve(new Set<string>()),
      enqueueStateUpdates: () => Promise.resolve(new Set<string>()),
      now: () => NOW,
    };
    await reconcilePullRequests(deps);

    const expected = new Date(
      NOW - PR_RECONCILIATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].toISOString()).toBe(expected.toISOString());
  });

  describe('merge state for PRs first sent while open (CAN-3513)', () => {
    const tapirUrl = pr(3854).prUrl;

    it('re-sends the merge of a PR sent while open whose worktree moved on', async () => {
      // tapir sent #3854 while it was open, then checked out #3900. The poller
      // only watches #3900 now, so the merge of #3854 never reaches the server.
      const h = harness({
        repos: [repo({ ownedPrNumbers: new Set([3900]) })],
        prsByRepo: { 'example-org/example-repo': [pr(3854)] },
        synced: { canopy: [pullRequestKey('tapir', 3854)] },
        syncedPrUrls: [tapirUrl],
        syncedPrStates: { [tapirUrl]: 'open' },
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsRecovered).toBe(0);
      expect(result.prsStateUpdated).toBe(1);
      expect(h.enqueued).toEqual([]);
      expect(h.stateUpdates).toEqual([
        { projectId: 'canopy', numbers: [3854], states: ['merged'] },
      ]);
    });

    it('backfills a PR recorded before the sent state was tracked', async () => {
      // Sync-map entries written before CAN-3513 carry no state, so the server
      // row may still read OPEN. Re-sending once is idempotent server-side.
      const h = harness({
        repos: [repo()],
        prsByRepo: { 'example-org/example-repo': [pr(3854)] },
        synced: { canopy: [pullRequestKey('tapir', 3854)] },
        syncedPrUrls: [tapirUrl],
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsStateUpdated).toBe(1);
      expect(h.stateUpdates[0]?.numbers).toEqual([3854]);
    });

    it('backfills a legacy entry recorded by key without a URL', async () => {
      const h = harness({
        repos: [repo()],
        prsByRepo: { 'example-org/example-repo': [pr(3685)] },
        synced: { canopy: [pullRequestKey('flounder', 3685)] },
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsRecovered).toBe(0);
      expect(result.prsStateUpdated).toBe(1);
    });

    it('does not re-send a PR already recorded as merged', async () => {
      const h = harness({
        repos: [repo()],
        prsByRepo: { 'example-org/example-repo': [pr(3854)] },
        synced: { canopy: [pullRequestKey('tapir', 3854)] },
        syncedPrUrls: [tapirUrl],
        syncedPrStates: { [tapirUrl]: 'merged' },
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsStateUpdated).toBe(0);
      expect(h.stateUpdates).toEqual([]);
    });

    it('leaves the merge to the poller while a worktree still reports the PR', async () => {
      // The poller watches #3854 and will observe the merge itself.
      const h = harness({
        repos: [repo({ ownedPrNumbers: new Set([3854]) })],
        prsByRepo: { 'example-org/example-repo': [pr(3854)] },
        synced: { canopy: [pullRequestKey('tapir', 3854)] },
        syncedPrUrls: [tapirUrl],
        syncedPrStates: { [tapirUrl]: 'open' },
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsLeftToPoller).toBe(1);
      expect(h.stateUpdates).toEqual([]);
    });

    it('re-sends a merge only once when two projects share the repo', async () => {
      const h = harness({
        repos: [repo(), repo({ projectId: 'canopy-2' })],
        prsByRepo: { 'example-org/example-repo': [pr(3854)] },
        synced: {
          canopy: [pullRequestKey('tapir', 3854)],
          'canopy-2': [pullRequestKey('tapir', 3854)],
        },
        syncedPrUrls: [tapirUrl],
        syncedPrStates: { [tapirUrl]: 'open' },
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsStateUpdated).toBe(1);
      expect(h.stateUpdates).toEqual([
        { projectId: 'canopy', numbers: [3854], states: ['merged'] },
      ]);
    });

    it('falls back to another workspace when the first queues nothing', async () => {
      // The first workspace listing the repo has metadata sharing off, so its
      // enqueue accepts nothing. The merge must still reach the server through
      // the next workspace that can send it, or the row stays OPEN.
      const h = harness({
        repos: [repo({ projectId: 'sharing-off' }), repo()],
        prsByRepo: { 'example-org/example-repo': [pr(3854)] },
        synced: {
          'sharing-off': [pullRequestKey('tapir', 3854)],
          canopy: [pullRequestKey('tapir', 3854)],
        },
        syncedPrUrls: [tapirUrl],
        syncedPrStates: { [tapirUrl]: 'open' },
        ineligibleProjects: ['sharing-off'],
      });
      const result = await reconcilePullRequests(h.deps);

      expect(h.stateUpdates).toEqual([
        { projectId: 'canopy', numbers: [3854], states: ['merged'] },
      ]);
      expect(result.prsStateUpdated).toBe(1);
    });

    it('counts only state updates that were queued', async () => {
      const h = harness({
        repos: [repo({ projectId: 'sharing-off' })],
        prsByRepo: { 'example-org/example-repo': [pr(3854)] },
        synced: { 'sharing-off': [pullRequestKey('tapir', 3854)] },
        syncedPrUrls: [tapirUrl],
        syncedPrStates: { [tapirUrl]: 'open' },
        ineligibleProjects: ['sharing-off'],
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsStateUpdated).toBe(0);
    });

    it('reports a state update failure without throwing', async () => {
      const h = harness({
        repos: [repo()],
        prsByRepo: { 'example-org/example-repo': [pr(3854)] },
        synced: { canopy: [pullRequestKey('tapir', 3854)] },
        syncedPrUrls: [tapirUrl],
        enqueueError: new Error('offline'),
      });
      const result = await reconcilePullRequests(h.deps);

      expect(result.prsStateUpdated).toBe(0);
      expect(result.reposFailed).toBe(1);
    });
  });
});

describe('toPullRequestPayload', () => {
  it('marks recovered PRs as merged', () => {
    const payload = toPullRequestPayload(repo(), pr(4));

    expect(payload.state).toBe('merged');
    expect(payload.prNumber).toBe(4);
    expect(payload.repoId).toBe('canopy');
    expect(payload.mergedAt).toBe('2026-08-27T10:00:00Z');
  });

  it('carries the state GitHub reports for an unmerged PR', () => {
    const payload = toPullRequestPayload(
      repo(),
      pr(4, { state: 'open', mergedAt: undefined }),
    );

    expect(payload.state).toBe('open');
    expect(payload.mergedAt).toBeUndefined();
    expect(payload.openedAt).toBe('2026-08-26T10:00:00Z');
  });

  it('does not claim unobserved check or review outcomes', () => {
    const payload = toPullRequestPayload(repo(), pr(4));

    // These two stay client-sourced server-side and feed the leaderboard's
    // checks-passing ratio, so an unobserved value must not read as "passing".
    expect(payload.checkStatus).toBe('none');
    expect(payload.reviewStatus).toBe('none');
  });

  it('passes check and review status GitHub reported through', () => {
    // A state update must not overwrite what the poller sent with `none`.
    const payload = toPullRequestPayload(
      repo(),
      pr(4, { checkStatus: 'passing', reviewStatus: 'approved' }),
    );

    expect(payload.checkStatus).toBe('passing');
    expect(payload.reviewStatus).toBe('approved');
  });

  it('omits diff stats that GitHub did not return', () => {
    const payload = toPullRequestPayload(repo(), pr(4));

    expect(payload.additions).toBeUndefined();
    expect(payload.deletions).toBeUndefined();
    expect(payload.changedFiles).toBeUndefined();
  });

  it('passes diff stats through when present', () => {
    const payload = toPullRequestPayload(
      repo(),
      pr(4, { additions: 10, deletions: 2, changedFiles: 3 }),
    );

    expect(payload.additions).toBe(10);
    expect(payload.deletions).toBe(2);
    expect(payload.changedFiles).toBe(3);
  });
});

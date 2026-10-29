import { collectCodeGraphDerivedBuildWarnings } from '../code-graph-tools';
import type { CodeGraphDerivedRepoStats } from '../code-graph';

// Whole-branch-review fix (Phase 6 final gates): `CodeGraphBuildResult.derived[].warnings`
// was recorded engine-level but discarded by both build-tool consumers (the
// Electron `BuildOrUpdateCodeGraph` tool runtime and the CLI `code-graph
// build` command). `collectCodeGraphDerivedBuildWarnings` is the shared
// mapping both now use to populate `CodeGraphBuildToolResult.derivedWarnings`
// -- exercising the end-to-end 50k-symbol community-detection skip or the
// flow global-membership cap isn't practical in a unit test, so this covers
// the mapping function directly (the runtime/CLI tests separately exercise
// the non-fatal derived-analysis-failure path end to end via a
// `CodeGraphStore.prototype` spy, matching engine.test.ts's technique).

function repoStats(
  repoId: string,
  warnings: string[],
): CodeGraphDerivedRepoStats {
  return {
    repoId,
    computed: warnings.length === 0,
    communityCount: 0,
    flowCount: 0,
    communitiesSkipped: false,
    flowsGlobalCapReached: false,
    warnings,
  };
}

describe('collectCodeGraphDerivedBuildWarnings', () => {
  it('returns an empty array for an empty derived list', () => {
    expect(collectCodeGraphDerivedBuildWarnings([])).toEqual([]);
  });

  it('returns an empty array when every processed repo has no warnings', () => {
    const derived = [repoStats('repo-a', []), repoStats('repo-b', [])];
    expect(collectCodeGraphDerivedBuildWarnings(derived)).toEqual([]);
  });

  it('flattens warnings across multiple repos in input order, without adding its own prefix', () => {
    const derived = [
      repoStats('repo-a', [
        'community detection skipped for repo-a: 50001 symbols exceeds the 50000-symbol cap',
      ]),
      repoStats('repo-b', []),
      repoStats('repo-c', [
        'flow tracing stopped early for repo-c: the global membership-row cap was reached',
        'derived analysis failed for repo-c: boom',
      ]),
    ];

    expect(collectCodeGraphDerivedBuildWarnings(derived)).toEqual([
      'community detection skipped for repo-a: 50001 symbols exceeds the 50000-symbol cap',
      'flow tracing stopped early for repo-c: the global membership-row cap was reached',
      'derived analysis failed for repo-c: boom',
    ]);
  });
});

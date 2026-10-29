import type { CodeGraphDerivedRepoStats } from '../../../types/code-graph';
import type { CodeGraphStore } from '../store/graph-store';
import { detectCommunities } from './communities';
import { traceFlows } from './flows';

// --- Derived-phase orchestrator (Phase 6 Task 6) ----------------------------
//
// This module is the impure glue between the two PURE analysis modules
// (analysis/communities.ts, analysis/flows.ts) and the store: it loads a
// repo's current symbols/edges/previous-memberships, runs both analyses, and
// persists the result via `CodeGraphStore.replaceDerivedForRepo`. Unlike its
// two pure siblings, this module has database access by design -- see
// `engine.ts`'s `buildOrUpdate`, the only production caller, which invokes
// this once per repository after resolvers + FTS rebuild.
//
// Non-fatal by construction: `computeDerivedForRepo` never throws. A failure
// in either analysis stage is caught and reported as a warning, leaving
// whatever derived data the store already had (from an earlier successful
// build, or none) untouched -- `replaceDerivedForRepo` is only reached after
// BOTH stages succeed, so a mid-way throw can never leave the derived tables
// partially overwritten.

// Mirrors impact/change-impact.ts's own (unexported) `yieldToEventLoop`.
// Louvain (analysis/communities.ts) and flow tracing (analysis/flows.ts) are
// both synchronous O(graph) passes over plain JS Maps/Sets -- no `await`
// points of their own -- so a large repo would otherwise run both back to
// back with zero chances for the event loop (Electron main) to service other
// work. Duplicated rather than imported: that module's helper is private
// (unexported), and this is the same technique applied at a different
// granularity (once per repo, between the two analysis stages), not a
// shared dependency worth extracting for a two-line function.
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => resolve());
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ComputeDerivedForRepoInput {
  store: CodeGraphStore;
  repoId: string;
  // Test-only injectable seams (see derived.test.ts's non-fatal-error-path
  // coverage) so a failing analysis stage can be exercised without
  // monkey-patching a module export. Production callers (engine.ts) never
  // pass these, so real builds always run the actual pure modules.
  detectCommunitiesFn?: typeof detectCommunities;
  traceFlowsFn?: typeof traceFlows;
}

// Loads a repo's current graph state, runs community detection + flow
// tracing, and persists the result in one `replaceDerivedForRepo` call.
// Resolves rather than rejecting for any analysis/persistence failure (see
// the module comment above for the non-fatal contract) -- with ONE
// theoretical escape: the catch path itself reads `getDerivedStats` from
// the store, so a db handle broken enough to fail THAT read too still
// rejects. `engine.ts`'s per-repo defensive catch converts that residual
// rejection into a warning entry, making the build-level guarantee total.
export async function computeDerivedForRepo(
  input: ComputeDerivedForRepoInput,
): Promise<CodeGraphDerivedRepoStats> {
  const { store, repoId } = input;
  const detect = input.detectCommunitiesFn ?? detectCommunities;
  const trace = input.traceFlowsFn ?? traceFlows;

  try {
    const symbols = store.listSymbolsForRepo(repoId);
    const edges = store.listEdges({ repoId });
    const files = store.listFiles(repoId);
    const fileRelativePathById = new Map(
      files.map((file): [string, string] => [file.id, file.relativePath]),
    );
    // Read BEFORE `replaceDerivedForRepo` overwrites the tables below --
    // this is how community ids stay stable across builds (see
    // communities.ts's `previousMemberships`/`STABLE_ID_MIN_JACCARD`).
    const previousMemberships = store.listCommunityMemberships(repoId);

    const communityResult = detect({
      repoId,
      symbols,
      edges,
      fileRelativePathById,
      previousMemberships,
    });

    // Yield between the two O(graph) analysis stages -- see the module
    // comment's `yieldToEventLoop` note.
    await yieldToEventLoop();

    const flowResult = trace({ repoId, symbols, edges });

    store.replaceDerivedForRepo(
      repoId,
      communityResult.communities,
      communityResult.memberships,
      flowResult.flows,
      flowResult.memberships,
    );

    const warnings: string[] = [];
    if (communityResult.skipped) {
      warnings.push(
        `community detection skipped for ${repoId}: ${communityResult.symbolCount} symbols; ${communityResult.skipReason ?? 'analysis work budget exceeded'}`,
      );
    }
    if (flowResult.globalCapReached) {
      warnings.push(
        `flow tracing stopped early for ${repoId}: the global membership-row cap was reached`,
      );
    }

    return {
      repoId,
      computed: true,
      communityCount: communityResult.communities.length,
      flowCount: flowResult.flows.length,
      communitiesSkipped: communityResult.skipped,
      flowsGlobalCapReached: flowResult.globalCapReached,
      warnings,
    };
  } catch (error) {
    // Never reached `replaceDerivedForRepo` above, so whatever the store
    // already had (an earlier successful build's rows, or nothing) is still
    // exactly what's there -- report THAT, not a hardcoded 0, so this stays
    // honest about the graph's actual current state.
    const stats = store.getDerivedStats(repoId);
    return {
      repoId,
      computed: false,
      communityCount: stats.communityCount,
      flowCount: stats.flowCount,
      communitiesSkipped: false,
      flowsGlobalCapReached: false,
      warnings: [
        `derived analysis failed for ${repoId}: ${toErrorMessage(error)}`,
      ],
    };
  }
}

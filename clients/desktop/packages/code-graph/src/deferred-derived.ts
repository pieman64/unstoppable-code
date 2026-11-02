import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type {
  CodeGraphDerivedRepoStats,
  CodeGraphDiagnostics,
} from './types/code-graph';
import { computeDerivedForRepo } from './analysis/derived';
import { CODE_GRAPH_BUILD_TIMING_KEY_PREFIX } from './build-timings';
import { computeGraphDiagnostics, type ScanDiagnostics } from './diagnostics';
import { publishCodeGraphSummaryProjection } from './summary-projection';
import {
  deleteMetadataValue,
  getMetadataValue,
  setMetadataValue,
  withImmediateTransaction,
  type CodeGraphDatabase,
} from './store/database';
import type { CodeGraphStore } from './store/graph-store';

/**
 * Deferred derived analysis (communities, flows) and diagnostics.
 *
 * A build with `deferDerived` publishes its facts, resolutions and full-text
 * index in its own transaction and records this pending request instead of
 * running derived analysis. {@link completeDeferredCodeGraphDerived} later
 * runs exactly the computation the build would have run inline, on the
 * published graph, then stamps `derived_at` and records diagnostics.
 *
 * One request is kept per graph: a later deferring build overwrites it with
 * its own scans, so any number of refreshes published before the analysis
 * runs are analysed once, on the latest graph.
 */
export const CODE_GRAPH_DERIVED_PENDING_KEY = 'derived_pending';

const scanSchema = z.object({
  eligibleFiles: z.number(),
  unsupportedFiles: z.number(),
  excludedFiles: z.number(),
  examples: z.array(z.string()),
});

const pendingSchema = z.object({
  repoIds: z.array(z.string()),
  scans: z.array(z.object({ repoId: z.string(), scan: scanSchema })),
  freshness: z.enum(['stat', 'content', 'reparsed']),
  factsChanged: z.boolean(),
});

type DerivedPending = z.infer<typeof pendingSchema>;

function readPending(db: CodeGraphDatabase): DerivedPending | null {
  const raw = getMetadataValue(db, CODE_GRAPH_DERIVED_PENDING_KEY);
  if (raw === null) return null;
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Records the pending request inside the publishing build's transaction. */
export function recordDeferredDerived(input: {
  db: CodeGraphDatabase;
  repoIds: readonly string[];
  scans: Map<string, ScanDiagnostics>;
  freshness: CodeGraphDiagnostics['freshness'];
  factsChanged: boolean;
}): void {
  const previous = readPending(input.db);
  const pending: DerivedPending = {
    repoIds: [...input.repoIds],
    scans: Array.from(input.scans, ([repoId, scan]) => ({ repoId, scan })),
    freshness: input.freshness,
    factsChanged: input.factsChanged || previous?.factsChanged === true,
  };
  setMetadataValue(
    input.db,
    CODE_GRAPH_DERIVED_PENDING_KEY,
    JSON.stringify(pending),
  );
}

/** An inline derived pass answers any pending request. */
export function clearDeferredDerived(db: CodeGraphDatabase): void {
  deleteMetadataValue(db, CODE_GRAPH_DERIVED_PENDING_KEY);
}

export interface CodeGraphDeferredDerivedResult {
  /** False when nothing was pending: the analysis is already current. */
  ran: boolean;
  derived: CodeGraphDerivedRepoStats[];
  derivedMs: number;
  diagnosticsMs: number;
}

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

const NOTHING_PENDING: CodeGraphDeferredDerivedResult = {
  ran: false,
  derived: [],
  derivedMs: 0,
  diagnosticsMs: 0,
};

/**
 * Runs a pending derived analysis on the published graph.
 *
 * The per-repository analysis is the inline build's (`computeDerivedForRepo`,
 * with the same defensive catch), so the stored communities, flows and
 * memberships are identical. Each repository's rows are replaced in their
 * own short transaction; the reads before them hold no write lock, so a
 * reader or the end-of-build fingerprint write is never blocked for the
 * length of the analysis. Until the final transaction stamps `derived_at`,
 * the graph reports its derived data as stale.
 *
 * The caller must be the graph's only writer of facts (the desktop runs this
 * in the build worker that published the graph, and a later build for the
 * same graph first stops that worker). As a guard, a build published in the
 * meantime leaves its own request pending instead of being marked current.
 */
export async function completeDeferredCodeGraphDerived(input: {
  db: CodeGraphDatabase;
  store: CodeGraphStore;
  now?: () => number;
  worktreeRootPath?: string;
}): Promise<CodeGraphDeferredDerivedResult> {
  const { db, store } = input;
  const now = input.now ?? ((): number => performance.now());
  const pendingRaw = getMetadataValue(db, CODE_GRAPH_DERIVED_PENDING_KEY);
  if (pendingRaw === null) return NOTHING_PENDING;
  const pending = readPending(db);
  const publishedAt = getMetadataValue(db, 'last_build_at');
  const projectionRevision = getMetadataValue(
    db,
    'summary_projection_revision',
  );
  const completedAt = getMetadataValue(db, 'completed_build_at');

  const derivedStartedAt = now();
  const derived: CodeGraphDerivedRepoStats[] = [];
  const repoIds =
    pending?.repoIds ?? store.listRepositories().map((r) => r.repoId);
  for (const repoId of repoIds) {
    try {
      derived.push(await computeDerivedForRepo({ store, repoId }));
    } catch (error) {
      // Same total guarantee as the inline build (see engine.ts).
      derived.push({
        repoId,
        computed: false,
        communityCount: 0,
        flowCount: 0,
        communitiesSkipped: false,
        flowsGlobalCapReached: false,
        warnings: [
          `derived analysis failed unexpectedly for ${repoId}: ${error instanceof Error ? error.message : String(error)}`,
        ],
      });
    }
  }
  const derivedMs = now() - derivedStartedAt;

  const diagnosticsStartedAt = now();
  const diagnostics = computeGraphDiagnostics({
    db,
    scans: new Map(
      (pending?.scans ?? []).map(({ repoId, scan }) => [repoId, scan]),
    ),
    derived,
    derivedRefreshed: true,
    computeDerived: true,
    factsChanged: pending?.factsChanged ?? true,
    freshness: pending?.freshness ?? 'stat',
  });
  const diagnosticsMs = now() - diagnosticsStartedAt;

  withImmediateTransaction(db, () => {
    if (
      getMetadataValue(db, 'last_build_at') !== publishedAt ||
      getMetadataValue(db, 'completed_build_at') !== completedAt ||
      getMetadataValue(db, 'summary_projection_revision') !==
        projectionRevision ||
      getMetadataValue(db, CODE_GRAPH_DERIVED_PENDING_KEY) !== pendingRaw
    ) {
      // A newer build was published meanwhile: its own request stays
      // pending and its derived data stays reported as stale.
      return;
    }
    if (derived.some((entry) => entry.computed)) {
      setMetadataValue(db, 'derived_at', String(Date.now()));
    }
    setMetadataValue(db, 'graph_diagnostics', JSON.stringify(diagnostics));
    deleteMetadataValue(db, CODE_GRAPH_DERIVED_PENDING_KEY);
    setMetadataValue(
      db,
      `${CODE_GRAPH_BUILD_TIMING_KEY_PREFIX}derived_ms`,
      String(roundMs(derivedMs)),
    );
    setMetadataValue(
      db,
      `${CODE_GRAPH_BUILD_TIMING_KEY_PREFIX}diagnostics_ms`,
      String(roundMs(diagnosticsMs)),
    );
    // Publication is inside the same guarded transaction: a superseded
    // derived computation can never replace the newer build's projection.
    publishCodeGraphSummaryProjection(
      db,
      input.worktreeRootPath === undefined
        ? {}
        : { worktreeRootPath: input.worktreeRootPath },
    );
  });
  return {
    ran: true,
    derived,
    derivedMs: roundMs(derivedMs),
    diagnosticsMs: roundMs(diagnosticsMs),
  };
}

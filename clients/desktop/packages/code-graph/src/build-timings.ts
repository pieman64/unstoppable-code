import { statSync } from 'node:fs';
import type {
  CodeGraphBuildPrelude,
  CodeGraphBuildTimings,
  CodeGraphResolverTimings,
} from './types/code-graph';
import {
  deleteMetadataValue,
  requireRow,
  setMetadataValue,
  withImmediateTransaction,
  type CodeGraphDatabase,
} from './store/database';

/**
 * Phase timings for one `CodeGraphEngine.buildOrUpdate`.
 *
 * Each phase's duration is written to `graph_metadata` as a
 * `build_timing:<name>` key when the phase ends, inside the build
 * transaction, so a graph always describes the build that last wrote it. A
 * build first deletes the previous build's keys: a key that is absent names a
 * phase the last build did not run. What only exists after the commit (its
 * duration, the WAL it left, the process's peak memory, and time to first
 * graph) is written in one small transaction right after it.
 *
 * Timing observes the build and never changes what a phase does; a failure to
 * record a timing never fails the build.
 */

export const CODE_GRAPH_BUILD_TIMING_KEY_PREFIX = 'build_timing:';
/** Written once, by the build that completes a database's first graph. */
export const CODE_GRAPH_TIME_TO_FIRST_GRAPH_KEY = 'time_to_first_graph_ms';

type ResolverPass = keyof CodeGraphResolverTimings;

export type CodeGraphBuildPhase =
  | 'prepare'
  | 'scan'
  | 'hash'
  | 'parse'
  | ResolverPass
  | 'fts'
  | 'derived'
  | 'diagnostics';

const RESOLVER_METADATA_NAMES: Readonly<Record<ResolverPass, string>> = {
  resetMs: 'resolve_reset_ms',
  importsMs: 'resolve_imports_ms',
  configExtendsMs: 'resolve_config_extends_ms',
  docLinksMs: 'resolve_doc_links_ms',
  ipcMs: 'resolve_ipc_ms',
  workflowActionsMs: 'resolve_workflow_actions_ms',
  callsMs: 'resolve_calls_ms',
  testsMs: 'resolve_tests_ms',
};

const PHASE_METADATA_NAMES: Readonly<Record<CodeGraphBuildPhase, string>> = {
  prepare: 'prepare_ms',
  scan: 'scan_ms',
  hash: 'hash_ms',
  parse: 'parse_ms',
  ...RESOLVER_METADATA_NAMES,
  fts: 'fts_ms',
  derived: 'derived_ms',
  diagnostics: 'diagnostics_ms',
};

/** The prelude durations with their metadata names. */
function preludeEntries(
  prelude: CodeGraphBuildPrelude,
): Array<[string, number | undefined]> {
  return [
    ['queue_wait_ms', prelude.queueWaitMs],
    ['fingerprint_ms', prelude.fingerprintMs],
    ['seed_copy_ms', prelude.seedCopyMs],
    ['fusion_ms', prelude.fusionMs],
  ];
}

const RESOLVER_PASSES: readonly ResolverPass[] = [
  'resetMs',
  'importsMs',
  'configExtendsMs',
  'docLinksMs',
  'ipcMs',
  'workflowActionsMs',
  'callsMs',
  'testsMs',
];

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function totalChanges(db: CodeGraphDatabase): number {
  const row = requireRow(db.prepare('SELECT total_changes() AS n').get());
  return Number(row.n);
}

function peakRssBytes(): number | undefined {
  try {
    // `maxRSS` is in kibibytes. The desktop runs each build in its own worker
    // process, so its peak is the build's.
    const kibibytes = process.resourceUsage().maxRSS;
    return Number.isFinite(kibibytes) && kibibytes > 0
      ? kibibytes * 1024
      : undefined;
  } catch {
    return undefined;
  }
}

function attempt(write: () => void): void {
  try {
    write();
  } catch {
    // Timings are diagnostics; they must never fail or alter a build.
  }
}

export interface CodeGraphBuildTimerOptions {
  db: CodeGraphDatabase;
  /** Monotonic clock in milliseconds. */
  now: () => number;
  /** The database's `-wal` file, sampled at phase boundaries. */
  walPath: string | undefined;
  prelude: CodeGraphBuildPrelude | undefined;
}

export class CodeGraphBuildTimer {
  private readonly phases = new Map<CodeGraphBuildPhase, number>();
  private readonly persisted = new Set<CodeGraphBuildPhase>();
  private changesAtStart = 0;
  private peakWal: number | undefined;
  private walStart: number | undefined;
  private firstGraph = false;
  private commitMs = 0;
  private rowsWritten = 0;
  private timeToFirstGraphMs: number | undefined;

  public constructor(private readonly options: CodeGraphBuildTimerOptions) {}

  public now(): number {
    return this.options.now();
  }

  /**
   * Opens the build inside its transaction: clears the previous build's
   * timings and records the prelude. `firstGraph` is whether no build had
   * completed this database before.
   */
  public begin(firstGraph: boolean): void {
    this.firstGraph = firstGraph;
    // SQLite reuses the WAL file without shrinking it, so its size here is
    // what an earlier transaction left; only growth past it is this build's.
    this.walStart = this.walSize() ?? (this.options.walPath ? 0 : undefined);
    attempt(() => {
      this.options.db
        .prepare('DELETE FROM graph_metadata WHERE substr(key, 1, ?) = ?')
        .run(
          CODE_GRAPH_BUILD_TIMING_KEY_PREFIX.length,
          CODE_GRAPH_BUILD_TIMING_KEY_PREFIX,
        );
    });
    attempt(() => {
      this.changesAtStart = totalChanges(this.options.db);
    });
    const prelude = this.options.prelude;
    if (prelude !== undefined) {
      for (const [name, value] of preludeEntries(prelude)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          this.write(name, roundMs(value));
        }
      }
    }
    if (this.walStart !== undefined) {
      this.write('wal_start_bytes', this.walStart);
    }
    this.sampleWal();
  }

  /** Adds time to a phase without ending it (per-file and per-repo work). */
  public add(phase: CodeGraphBuildPhase, elapsedMs: number): void {
    this.phases.set(phase, (this.phases.get(phase) ?? 0) + elapsedMs);
  }

  /** Total time recorded for a phase so far. */
  public total(phase: CodeGraphBuildPhase): number {
    return this.phases.get(phase) ?? 0;
  }

  public measure<T>(phase: CodeGraphBuildPhase, work: () => T): T {
    const startedAt = this.now();
    try {
      return work();
    } finally {
      this.add(phase, this.now() - startedAt);
    }
  }

  /** Ends phases at their boundary: writes their keys and samples the WAL. */
  public persist(...phases: CodeGraphBuildPhase[]): void {
    for (const phase of phases) {
      this.persisted.add(phase);
      this.write(PHASE_METADATA_NAMES[phase], roundMs(this.total(phase)));
    }
    this.sampleWal();
  }

  /** The last in-transaction write: rows written so far and memory. */
  public persistTransactionTotals(): void {
    attempt(() => {
      this.rowsWritten = Math.max(
        0,
        totalChanges(this.options.db) - this.changesAtStart,
      );
    });
    this.write('rows_written', this.rowsWritten);
    this.writePeaks();
  }

  /**
   * Records what exists only once the transaction has committed, in one
   * small transaction of its own.
   */
  public persistAfterCommit(commitMs: number, wallClockNow: number): void {
    this.commitMs = roundMs(commitMs);
    this.sampleWal();
    const requestedAt = this.options.prelude?.firstGraphRequestedAt;
    if (
      this.firstGraph &&
      typeof requestedAt === 'number' &&
      Number.isFinite(requestedAt)
    ) {
      this.timeToFirstGraphMs = Math.max(
        0,
        Math.round(wallClockNow - requestedAt),
      );
    }
    attempt(() => {
      withImmediateTransaction(this.options.db, () => {
        this.write('commit_ms', this.commitMs);
        this.writePeaks();
        if (this.timeToFirstGraphMs !== undefined) {
          setMetadataValue(
            this.options.db,
            CODE_GRAPH_TIME_TO_FIRST_GRAPH_KEY,
            String(this.timeToFirstGraphMs),
          );
        }
      });
    });
  }

  public result(): CodeGraphBuildTimings {
    const prelude = this.options.prelude ?? {};
    const timings: CodeGraphBuildTimings = {
      ...(prelude.queueWaitMs === undefined
        ? {}
        : { queueWaitMs: roundMs(prelude.queueWaitMs) }),
      ...(prelude.fingerprintMs === undefined
        ? {}
        : { fingerprintMs: roundMs(prelude.fingerprintMs) }),
      ...(prelude.seedCopyMs === undefined
        ? {}
        : { seedCopyMs: roundMs(prelude.seedCopyMs) }),
      ...(prelude.fusionMs === undefined
        ? {}
        : { fusionMs: roundMs(prelude.fusionMs) }),
      prepareMs: roundMs(this.total('prepare')),
      scanMs: roundMs(this.total('scan')),
      hashMs: roundMs(this.total('hash')),
      parseMs: roundMs(this.total('parse')),
      diagnosticsMs: roundMs(this.total('diagnostics')),
      commitMs: this.commitMs,
      rowsWritten: this.rowsWritten,
    };
    if (RESOLVER_PASSES.every((pass) => this.persisted.has(pass))) {
      const resolveMs: CodeGraphResolverTimings = {
        resetMs: roundMs(this.total('resetMs')),
        importsMs: roundMs(this.total('importsMs')),
        configExtendsMs: roundMs(this.total('configExtendsMs')),
        docLinksMs: roundMs(this.total('docLinksMs')),
        ipcMs: roundMs(this.total('ipcMs')),
        workflowActionsMs: roundMs(this.total('workflowActionsMs')),
        callsMs: roundMs(this.total('callsMs')),
        testsMs: roundMs(this.total('testsMs')),
      };
      timings.resolveMs = resolveMs;
    }
    if (this.persisted.has('fts')) timings.ftsMs = roundMs(this.total('fts'));
    if (this.persisted.has('derived')) {
      timings.derivedMs = roundMs(this.total('derived'));
    }
    if (this.walStart !== undefined) timings.walStartBytes = this.walStart;
    if (this.peakWal !== undefined) timings.peakWalBytes = this.peakWal;
    const rss = peakRssBytes();
    if (rss !== undefined) timings.peakRssBytes = rss;
    if (this.timeToFirstGraphMs !== undefined) {
      timings.timeToFirstGraphMs = this.timeToFirstGraphMs;
    }
    return timings;
  }

  private writePeaks(): void {
    if (this.peakWal !== undefined) {
      this.write('peak_wal_bytes', this.peakWal);
    }
    const rss = peakRssBytes();
    if (rss !== undefined) this.write('peak_rss_bytes', rss);
  }

  private write(name: string, value: number): void {
    attempt(() => {
      setMetadataValue(
        this.options.db,
        `${CODE_GRAPH_BUILD_TIMING_KEY_PREFIX}${name}`,
        String(value),
      );
    });
  }

  private walSize(): number | undefined {
    const walPath = this.options.walPath;
    if (walPath === undefined) return undefined;
    try {
      return statSync(walPath).size;
    } catch {
      // No WAL yet, or an in-memory database.
      return undefined;
    }
  }

  private sampleWal(): void {
    const size = this.walSize();
    if (size !== undefined) this.peakWal = Math.max(this.peakWal ?? 0, size);
  }
}

/** Removes a time-to-first-graph copied from another database. */
export function clearCopiedTimeToFirstGraph(db: CodeGraphDatabase): void {
  attempt(() => deleteMetadataValue(db, CODE_GRAPH_TIME_TO_FIRST_GRAPH_KEY));
}

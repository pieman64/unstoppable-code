import { CodeGraphEngine } from '@canopy/desktop-shared/node/code-graph/engine';
import {
  cloneCompletedCodeGraphDatabase,
  finalizeCodeGraphBaseStaging,
  hasCompletedCodeGraph,
  readPublishedCodeGraphBase,
  seedCodeGraphDatabase,
  seedCodeGraphDatabaseByClone,
  type CodeGraphSeedOutcome,
  type CodeGraphSeedSource,
  type SeedCodeGraphResult,
} from '@canopy/desktop-shared/node/code-graph/base-graph';
import { completeDeferredCodeGraphDerived } from '@canopy/desktop-shared/node/code-graph/deferred-derived';
import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '@canopy/desktop-shared/node/code-graph/store/database';
import { CodeGraphStore } from '@canopy/desktop-shared/node/code-graph/store/graph-store';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { Session, type Profiler } from 'node:inspector';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { CodeGraphBuildResult } from '@canopy/desktop-shared/types/code-graph';
import type { ParentPort } from 'electron';
import type {
  CodeGraphWorkerSummaryRepairRequest,
  CodeGraphWorkerSummaryRepairResponse,
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerBuildResponse,
  CodeGraphWorkerDerivedCompletion,
  CodeGraphWorkerEagerSeedRequest,
  CodeGraphWorkerEagerSeedResponse,
} from './build-runner';

const CPU_SAMPLING_INTERVAL_US = 1_000;

export function codeGraphWorkerCpuProfileDirectory(
  e2eEnabled = __CANOPY_E2E__,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const directory = env.CANOPY_PERFORMANCE_UTILITY_CPU_PROFILE_DIR?.trim();
  return e2eEnabled && directory && path.isAbsolute(directory)
    ? directory
    : undefined;
}

interface ActiveCpuProfiler {
  stop(): Promise<void>;
}

function postProfilerEnable(session: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    session.post('Profiler.enable', (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function postProfilerSamplingInterval(session: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    session.post(
      'Profiler.setSamplingInterval',
      { interval: CPU_SAMPLING_INTERVAL_US },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

function postProfilerStart(session: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    session.post('Profiler.start', (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function postProfilerStop(session: Session): Promise<Profiler.StopReturnType> {
  return new Promise((resolve, reject) => {
    session.post('Profiler.stop', (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });
}

async function startCodeGraphWorkerCpuProfiler(): Promise<
  ActiveCpuProfiler | undefined
> {
  const directory = codeGraphWorkerCpuProfileDirectory();
  if (directory === undefined) return undefined;

  const session = new Session();
  try {
    await mkdir(directory, { recursive: true });
    session.connect();
    await postProfilerEnable(session);
    await postProfilerSamplingInterval(session);
    await postProfilerStart(session);
  } catch {
    try {
      session.disconnect();
    } catch {
      // Diagnostic profiling must never alter worker completion semantics.
    }
    return undefined;
  }

  return {
    async stop(): Promise<void> {
      try {
        const { profile } = await postProfilerStop(session);
        const outputPath = path.join(
          directory,
          `CPU.code-graph.${process.pid}.${Date.now()}.cpuprofile`,
        );
        await writeFile(outputPath, JSON.stringify(profile), 'utf8');
      } finally {
        session.disconnect();
      }
    },
  };
}

/**
 * Adds base finalization to the returned timings. The finalized database is
 * sealed (checkpointed and integrity-checked), so this phase is reported but
 * never written into it.
 */
function withFinalizeTiming(
  result: CodeGraphBuildResult,
  finalizeMs: number,
): CodeGraphBuildResult {
  if (result.timings === undefined) return result;
  return {
    ...result,
    timings: {
      ...result.timings,
      finalizeMs: Math.round(Math.max(0, finalizeMs) * 10) / 10,
    },
  };
}

/**
 * Seeds a worktree that has no completed graph. A single-repository worktree
 * with its one base clones it, keeping the base's metadata; anything else,
 * or a clone that cannot be used, fuses (row copy into a fresh database).
 */
async function seedWorktreeDatabase(
  request: CodeGraphWorkerBuildRequest,
  preparation: NonNullable<CodeGraphWorkerBuildRequest['preparation']>,
): Promise<SeedCodeGraphResult> {
  const [onlySource] = preparation.seedSources;
  const [onlyRepository] = request.repositories;
  if (
    onlySource !== undefined &&
    onlyRepository !== undefined &&
    preparation.seedSources.length === 1 &&
    request.repositories.length === 1 &&
    preparation.coldFallbacks.length === 0 &&
    onlySource.repoId === onlyRepository.repoId &&
    onlySource.destinationRootPath === onlyRepository.rootPath
  ) {
    const cloned = await seedCodeGraphDatabaseByClone({
      targetDbPath: request.dbPath,
      source: onlySource,
      customLanguagesFingerprint: preparation.customLanguagesFingerprint,
    });
    if (cloned !== null) return cloned;
  }
  return seedCodeGraphDatabase({
    targetDbPath: request.dbPath,
    sources: preparation.seedSources,
    customLanguagesFingerprint: preparation.customLanguagesFingerprint,
  });
}

export interface CodeGraphBuildExecutionOptions {
  /**
   * Set only by the worker transport, which posts the published response
   * and then the derived completion. In-process callers (tests) leave it
   * unset and get today's single response with derived analysis inline.
   */
  allowDeferredDerived?: boolean;
}

/**
 * Repairs the worktree's summary projection through an Engine-owned writer.
 * This is intentionally a normal `CodeGraphEngine.open` lifecycle, not a
 * second `openCodeGraphDatabase` handle. Opening a standalone engine can run
 * the usual migrations and initialize the parser runtime; this operation is
 * therefore writer-safe, not a claim that opening it is grammar-free.
 */
export async function executeCodeGraphSummaryRepair(
  request: CodeGraphWorkerSummaryRepairRequest,
): Promise<CodeGraphWorkerSummaryRepairResponse> {
  let engine: CodeGraphEngine | undefined;
  try {
    engine = await CodeGraphEngine.open({
      dbPath: request.dbPath,
      repositories: request.repositories,
      resourcesDir: request.resourcesDir,
      worktreeRootPath: request.worktreeRootPath,
      customLanguagesRootPath: request.customLanguagesRootPath,
    });
    return { ok: true, result: engine.repairSummaryProjection() };
  } catch {
    return {
      ok: false,
      // Do not send paths or SQLite diagnostics over the utility-process
      // boundary. The caller classifies this as a failed repair attempt.
      message: 'The code-graph summary repair could not be completed.',
    };
  } finally {
    try {
      engine?.close();
    } catch {
      // The utility process exits after answering; preserve the repair result.
    }
  }
}

/**
 * The build worker's one job: open a {@link CodeGraphEngine} against the
 * fully-resolved paths in `request`, run one `buildOrUpdate`, and hand back a
 * typed response. Every path is supplied by the caller (main), so this derives
 * nothing from `cwd` or `process.env`. The whole body is wrapped so any
 * failure becomes `{ ok: false }` rather than a thrown error, and the engine
 * is always closed — a live `DatabaseSync` handle would otherwise keep file
 * descriptors open.
 *
 * Exported (not just wired to `parentPort`) so it can be exercised directly,
 * in-process, against a real engine without spawning a utilityProcess.
 */
export async function executeCodeGraphBuild(
  request: CodeGraphWorkerBuildRequest,
  execution?: CodeGraphBuildExecutionOptions,
): Promise<CodeGraphWorkerBuildResponse> {
  // A finalized base must carry its derived analysis, so it never defers.
  const deferDerived =
    execution?.allowDeferredDerived === true &&
    request.deferDerived === true &&
    request.baseFinalization === undefined;
  let engine: CodeGraphEngine | undefined;
  let seedOutcomes: CodeGraphSeedOutcome[] = [];
  let fusionDurationMs = 0;
  let fused = false;
  try {
    if (request.preparation !== undefined) {
      if (hasCompletedCodeGraph(request.dbPath)) {
        seedOutcomes = request.repositories.map((repository) => ({
          repoId: repository.repoId,
          status: 'existing-graph-reused',
        }));
      } else {
        const seeded = await seedWorktreeDatabase(request, request.preparation);
        fusionDurationMs = seeded.durationMs;
        fused = true;
        seedOutcomes = [
          ...seeded.outcomes,
          ...request.preparation.coldFallbacks.map((fallback) => ({
            repoId: fallback.repoId,
            status: 'cold-fallback' as const,
            reason: fallback.reason,
          })),
        ];
      }
    }
    engine = await CodeGraphEngine.open({
      dbPath: request.dbPath,
      repositories: request.repositories,
      resourcesDir: request.resourcesDir,
      worktreeRootPath: request.worktreeRootPath,
      customLanguagesRootPath: request.customLanguagesRootPath,
    });
    // The prelude main measured (queue wait, fingerprint, seed copy) and
    // this worker's fusion are persisted with the build's own phase timings.
    const result = await engine.buildOrUpdate({
      ...request.options,
      deferDerived,
      prelude: {
        ...request.timings,
        ...(fused ? { fusionMs: fusionDurationMs } : {}),
      },
    });
    if (request.baseFinalization === undefined) {
      return {
        ok: true,
        result,
        seedOutcomes,
        fusionDurationMs,
        ...(result.derivedDeferred === true
          ? { derivedPending: true as const }
          : {}),
      };
    }
    if (request.baseFinalization.repairSummaryProjection === true) {
      const repair = engine.repairSummaryProjection();
      if (repair.state !== 'ready') {
        throw new Error(
          'The staged base summary projection was not ready for publication.',
        );
      }
    }
    // Finalization reopens the database for its checkpoint and full-page
    // integrity scan, so the build connection must be closed first.
    const builtEngine = engine;
    engine = undefined;
    builtEngine.close();
    const finalizeStartedAt = performance.now();
    await finalizeCodeGraphBaseStaging({
      dbPath: request.dbPath,
      identity: request.baseFinalization.identity,
      gitHead: request.baseFinalization.gitHead,
    });
    return {
      ok: true,
      result: withFinalizeTiming(result, performance.now() - finalizeStartedAt),
      seedOutcomes,
      fusionDurationMs,
      baseFinalized: true,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        request.baseFinalization?.repairSummaryProjection === true
          ? 'The staged base summary repair could not be completed.'
          : error instanceof Error
            ? error.message
            : String(error),
    };
  } finally {
    if (engine !== undefined) {
      try {
        engine.close();
      } catch {
        // Best-effort close; the worker process exits immediately after.
      }
    }
    if (request.preparation !== undefined) {
      await rm(request.preparation.seedStagingDir, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }
}

/**
 * Runs the derived analysis a published worktree build left pending, in the
 * worker that published it (see `deferred-derived.ts`). It opens its own
 * connection and never fails the published build: any error is reported in
 * the completion and the graph keeps reporting stale derived data.
 */
export async function executeDeferredCodeGraphDerived(input: {
  dbPath: string;
}): Promise<CodeGraphWorkerDerivedCompletion> {
  if (!existsSync(input.dbPath)) {
    return {
      kind: 'derived-complete',
      ok: false,
      message: 'The code graph database no longer exists.',
    };
  }
  let db: CodeGraphDatabase | undefined;
  try {
    db = openCodeGraphDatabase(input.dbPath);
    const completed = await completeDeferredCodeGraphDerived({
      db,
      store: new CodeGraphStore(db),
    });
    return { kind: 'derived-complete', ok: true, ...completed };
  } catch (error) {
    return {
      kind: 'derived-complete',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      db?.close();
    } catch {
      // The worker exits right after; the completion already says what happened.
    }
  }
}

/** Executes only the eager snapshot install; it never parses source files. */
export async function executeCodeGraphEagerSeed(
  request: CodeGraphWorkerEagerSeedRequest,
): Promise<CodeGraphWorkerEagerSeedResponse> {
  const startedAt = Date.now();
  try {
    if (hasCompletedCodeGraph(request.targetDbPath)) {
      return {
        ok: true,
        status: 'existing',
        durationMs: Date.now() - startedAt,
      };
    }

    if (request.source.kind === 'base-worktree') {
      const result = await cloneCompletedCodeGraphDatabase({
        sourceDbPath: request.source.dbPath,
        targetDbPath: request.targetDbPath,
        repositories: request.repositories,
        sourceValidation: 'metadata-only',
        targetValidation: 'metadata-only',
      });
      return {
        ok: true,
        status: result.installed ? 'seeded' : 'no-compatible-source',
        ...(result.installed ? { source: 'base-worktree' as const } : {}),
        durationMs: Date.now() - startedAt,
      };
    }

    const sources: CodeGraphSeedSource[] = [];
    for (const base of request.source.bases) {
      const published = await readPublishedCodeGraphBase({
        variantDir: base.variantDir,
        identity: base.identity,
        validation: 'metadata-only',
      });
      if (published === null) {
        return {
          ok: true,
          status: 'no-compatible-source',
          durationMs: Date.now() - startedAt,
        };
      }
      sources.push({
        dbPath: published.dbPath,
        repoId: base.identity.repoId,
        canonicalRepoRoot: base.identity.canonicalRepoRoot,
        destinationRootPath: base.destinationRootPath,
        generationId: published.manifest.generationId,
        gitHead: published.manifest.gitHead,
        completedBuildAt: Date.parse(published.manifest.publishedAt),
      });
    }

    if (
      sources.length !== request.repositories.length ||
      sources.length === 0
    ) {
      return {
        ok: true,
        status: 'no-compatible-source',
        durationMs: Date.now() - startedAt,
      };
    }
    if (sources.length === 1) {
      const source = sources[0];
      if (source === undefined) {
        throw new Error('Missing single-repository eager seed source.');
      }
      const result = await cloneCompletedCodeGraphDatabase({
        sourceDbPath: source.dbPath,
        targetDbPath: request.targetDbPath,
        repositories: request.repositories,
        copyMode: 'immutable-file-copy',
        sourceAlreadyValidated: true,
        targetValidation: 'metadata-only',
      });
      return {
        ok: true,
        status: result.installed ? 'seeded' : 'existing',
        source: 'workspace-shadow',
        durationMs: Date.now() - startedAt,
      };
    }

    const result = await seedCodeGraphDatabase({
      targetDbPath: request.targetDbPath,
      sources,
      customLanguagesFingerprint:
        request.source.bases[0]?.identity.customLanguagesFingerprint ?? '',
      markCompletedFromSources: true,
    });
    return {
      ok: true,
      status: result.installed ? 'seeded' : 'existing',
      source: 'workspace-shadow',
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorkerBuildRequest(
  value: unknown,
): value is CodeGraphWorkerBuildRequest {
  return (
    isRecord(value) &&
    typeof value.dbPath === 'string' &&
    typeof value.worktreeRootPath === 'string' &&
    typeof value.resourcesDir === 'string' &&
    (value.customLanguagesRootPath === undefined ||
      typeof value.customLanguagesRootPath === 'string') &&
    Array.isArray(value.repositories) &&
    isRecord(value.options) &&
    (value.preparation === undefined || isRecord(value.preparation)) &&
    (value.baseFinalization === undefined ||
      (isRecord(value.baseFinalization) &&
        isRecord(value.baseFinalization.identity))) &&
    (value.deferDerived === undefined ||
      typeof value.deferDerived === 'boolean')
  );
}

function isWorkerSummaryRepairRequest(
  value: unknown,
): value is CodeGraphWorkerSummaryRepairRequest {
  return (
    isRecord(value) &&
    value.operation === 'summary-repair' &&
    typeof value.dbPath === 'string' &&
    typeof value.worktreeRootPath === 'string' &&
    typeof value.customLanguagesRootPath === 'string' &&
    typeof value.resourcesDir === 'string' &&
    Array.isArray(value.repositories)
  );
}

function isWorkerEagerSeedRequest(
  value: unknown,
): value is CodeGraphWorkerEagerSeedRequest {
  return (
    isRecord(value) &&
    value.operation === 'eager-seed' &&
    typeof value.targetDbPath === 'string' &&
    Array.isArray(value.repositories) &&
    isRecord(value.source) &&
    (value.source.kind === 'base-worktree' ||
      value.source.kind === 'workspace-shadow')
  );
}

async function respondOnce(
  parentPort: ParentPort,
  payload: unknown,
): Promise<void> {
  const cpuProfiler = isWorkerBuildRequest(payload)
    ? await startCodeGraphWorkerCpuProfiler()
    : undefined;
  try {
    if (isWorkerEagerSeedRequest(payload)) {
      parentPort.postMessage(await executeCodeGraphEagerSeed(payload));
    } else if (isWorkerSummaryRepairRequest(payload)) {
      parentPort.postMessage(await executeCodeGraphSummaryRepair(payload));
    } else if (isWorkerBuildRequest(payload)) {
      const response = await executeCodeGraphBuild(payload, {
        allowDeferredDerived: true,
      });
      // The caller is answered as soon as the graph is published.
      parentPort.postMessage(response);
      if (response.ok && response.derivedPending === true) {
        parentPort.postMessage(
          await executeDeferredCodeGraphDerived({ dbPath: payload.dbPath }),
        );
      }
    } else {
      parentPort.postMessage({
        ok: false,
        message: 'Malformed code-graph worker request.',
      });
    }
  } finally {
    await cpuProfiler?.stop().catch(() => undefined);
    // One response per spawn (plus the derived completion after a
    // `derivedPending` response), then exit; the runner treats this exit as
    // the normal completion path.
    process.exit(0);
  }
}

// Only wire the parentPort transport when actually running as a forked
// utilityProcess child. When this module is imported in-process (Electron main
// smoke-load, Jest, the in-process parity test) `process.parentPort` is
// undefined, so wiring is skipped and `executeCodeGraphBuild` can be called
// directly with zero side effects.
const workerParentPort: ParentPort | undefined = process.parentPort;
if (workerParentPort) {
  workerParentPort.once('message', (event: unknown): void => {
    const payload = isRecord(event) ? event.data : undefined;
    void respondOnce(workerParentPort, payload);
  });
}

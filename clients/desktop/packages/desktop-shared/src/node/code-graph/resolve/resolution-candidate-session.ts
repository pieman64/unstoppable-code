import type { CodeGraphBuildTimer } from '../build-timings';
import { RESOLUTION_CAPTURE_PHASES } from './resolution-candidate-timings';
import type { CodeGraphRepositoryInput } from '../../../types/code-graph';
import { repositoryRowId } from '../ids';
import {
  requireRow,
  requireString,
  type CodeGraphDatabase,
} from '../store/database';
import type { CodeGraphStore } from '../store/graph-store';
import { ResolutionPriorFacts } from '../store/resolution-prior-facts';
import { priorResolutionFileImage } from './resolution-prior-fact-codec';
import {
  changedFileFactKeys,
  type ResolutionFileFactImage,
} from './resolution-change-keys';
import { SqliteResolutionProjection } from './resolution-projection';
import { SqliteResolutionDependencyWriter } from './resolution-dependency-store';
import {
  computeAffectedResolutionClosure,
  SqliteResolutionDependencyIndex,
  type ResolutionClosureResult,
} from './resolution-dependency-index';
import {
  createSharedResolutionProjectionResetScope,
  resolutionProjectionConstructorOptions,
  type ResolutionRepositoryProjectionPlan,
  type SharedResolutionProjectionResetScope,
} from './scoped-resolution-projection';
import { runCapturedRepositoryResolution } from './captured-resolution-passes';
import { RESOLUTION_CAPTURE_RESOLVERS } from './resolution-dependency-capture';
import type {
  ResolutionDependencyCaptureMetadata,
  ResolutionDependencyCaptureSnapshot,
  ResolutionDependencyKey,
} from './resolution-dependency-capture';

export type ResolutionCandidateMode =
  | 'full-reset'
  | 'full-diff'
  | 'incremental';

interface RepositoryCandidateState {
  input: CodeGraphRepositoryInput;
  prior: ResolutionDependencyCaptureMetadata | null;
  changedFiles: Set<string>;
  removedFiles: Set<string>;
  changedSymbols: Set<string>;
  keys: Map<string, ResolutionDependencyKey>;
  globalReasons: Set<string>;
}
export interface ResolutionCandidateRepositoryResult {
  repoId: string;
  closure: ResolutionClosureResult | null;
  fallbackReasons: readonly string[];
  capture: ResolutionDependencyCaptureSnapshot;
}
export interface ResolutionCandidateResult {
  mode: ResolutionCandidateMode;
  repositories: readonly ResolutionCandidateRepositoryResult[];
  /** W2 counters are measured by its implementation, not invented here. */
  projection: ReturnType<SqliteResolutionProjection['getCounters']> | null;
  resetScopeReason: string;
}

/** Requires a NEW transaction full pass; never retries inside a dirty overlay. */
export class ResolutionCandidateNeedsFullPass extends Error {
  public constructor(public readonly repositoryIds: readonly string[]) {
    super(
      'Selective capture became incomplete; rollback and recompute full repository',
    );
    this.name = 'ResolutionCandidateNeedsFullPass';
  }
}

/**
 * Construct inside the owned build transaction BEFORE reconcile/fact writers.
 * It contains only repo state/affected IDs/keys. Previous graph rows are in
 * SQLite TEMP, not a JavaScript all-edge mirror. close() never publishes.
 */
export class ResolutionCandidateBuildSession {
  private readonly priorFacts: ResolutionPriorFacts;
  private readonly states = new Map<string, RepositoryCandidateState>();
  private resultValue: ResolutionCandidateResult | null = null;

  public constructor(
    private readonly db: CodeGraphDatabase,
    private readonly store: CodeGraphStore,
    repositories: readonly CodeGraphRepositoryInput[],
    private readonly mode: ResolutionCandidateMode,
    forcedFullRepositoryIds: readonly string[] = [],
  ) {
    const writer = new SqliteResolutionDependencyWriter(db);
    // Read eligibility before any changed-file or membership writer invalidates it.
    for (const input of repositories) {
      this.states.set(input.repoId, {
        input,
        prior: writer.isCompatible(input)
          ? writer.readMetadata(input.repoId)
          : null,
        changedFiles: new Set(),
        removedFiles: new Set(),
        changedSymbols: new Set(),
        keys: new Map(),
        globalReasons: new Set(
          forcedFullRepositoryIds.includes(input.repoId)
            ? ['capture-incomplete-retry']
            : [],
        ),
      });
    }
    this.priorFacts = new ResolutionPriorFacts(db);
  }

  public preserve(fileId: string): void {
    this.priorFacts.preserve(fileId);
  }

  private state(repoId: string): RepositoryCandidateState {
    const state = this.states.get(repoId);
    if (state === undefined)
      throw new Error('Unknown repository in resolution candidate');
    return state;
  }

  public markGlobal(repoId: string, reason: string): void {
    this.state(repoId).globalReasons.add(reason);
  }
  public markAllGlobal(reason: string): void {
    for (const state of Array.from(this.states.values()))
      state.globalReasons.add(reason);
  }

  public changed(repoId: string, fileId: string, removed = false): void {
    const state = this.state(repoId);
    state.changedFiles.add(fileId);
    if (removed) state.removedFiles.add(fileId);
    const before = priorResolutionFileImage(this.priorFacts.read(fileId));
    const after: ResolutionFileFactImage = {
      file: this.store.getFileById(fileId),
      symbols: this.store.listSymbolsForFile(fileId),
      edges: this.store.listEdges({ repoId, sourceFileId: fileId }),
    };
    for (const key of changedFileFactKeys(repoId, before, after)) {
      state.keys.set(
        JSON.stringify([key.dependencyKind, key.dependencyKey]),
        key,
      );
    }
    for (const symbol of [...before.symbols, ...after.symbols])
      state.changedSymbols.add(symbol.id);
    if (after.file?.parseStatus === 'failed')
      state.globalReasons.add('parse-failure');
  }

  public needsResolution(factsChanged: boolean): boolean {
    return (
      factsChanged ||
      Array.from(this.states.values()).some(
        (state): boolean =>
          state.prior === null || state.globalReasons.size > 0,
      )
    );
  }

  public run(timer?: CodeGraphBuildTimer): ResolutionCandidateResult {
    const sortedStates = Array.from(this.states.values()).sort(
      (a, b): number =>
        a.input.repoId < b.input.repoId
          ? -1
          : a.input.repoId > b.input.repoId
            ? 1
            : 0,
    );
    const closures = new Map<string, ResolutionClosureResult>();
    let resetScopeReason = 'explicit-full-capture';
    let plans: ResolutionRepositoryProjectionPlan[] = [];
    if (this.mode === 'incremental') {
      plans = sortedStates.map((state): ResolutionRepositoryProjectionPlan => {
        const index = new SqliteResolutionDependencyIndex(
          this.db,
          state.input.repoId,
        );
        const closureIndex = {
          producerKeys: (
            fileId: string,
          ): ReturnType<SqliteResolutionDependencyIndex['producerKeys']> =>
            index.producerKeys(fileId),
          dependencySourceFileIds: (): readonly string[] =>
            index.dependencySourceFileIds(),
          sourceFilesUsingChangedSymbol: (
            symbolId: string,
          ): readonly string[] => index.sourceFilesUsingChangedSymbol(symbolId),
          reverseOwners: (
            key: ResolutionDependencyKey,
          ): ReturnType<SqliteResolutionDependencyIndex['reverseOwners']> =>
            this.priorFacts
              .reverseDependencyOwners(
                repositoryRowId(state.input.repoId),
                key.dependencyKind,
                key.dependencyKey,
              )
              .map((row) => {
                const resolverValue = requireString(row, 'resolver');
                const resolver = RESOLUTION_CAPTURE_RESOLVERS.find(
                  (candidate) => candidate === resolverValue,
                );
                if (resolver === undefined)
                  throw new Error(
                    'Unknown resolver in prior dependency capture',
                  );
                return {
                  resolver,
                  sourceFileId: requireString(row, 'source_file_id'),
                };
              }),
        };
        const closure = computeAffectedResolutionClosure(closureIndex, {
          repoId: state.input.repoId,
          rootPath: state.input.rootPath,
          changedFileIds: Array.from(state.changedFiles),
          deletedFileIds: Array.from(state.removedFiles),
          changedSymbolIds: Array.from(state.changedSymbols),
          changedDependencyKeys: Array.from(state.keys.values()),
          priorCompatibleMetadata: state.prior,
          repositoryGlobalChange: state.globalReasons.size > 0,
        });
        closures.set(state.input.repoId, closure);
        return {
          repoId: state.input.repoId,
          closure,
          repositoryFileIds: this.store
            .listFiles(state.input.repoId)
            .map((file): string => file.id),
          retiredDependencySourceFileIds: index.dependencySourceFileIds(),
          retiredTestLinkSourceFileIds: this.db
            .prepare(
              "SELECT DISTINCT source_file_id FROM edges WHERE repository_id = ? AND resolver_id = 'test-linker' ORDER BY source_file_id",
            )
            .all(repositoryRowId(state.input.repoId))
            .map((row): string =>
              requireString(requireRow(row), 'source_file_id'),
            ),
        };
      });
    }
    const scope: SharedResolutionProjectionResetScope =
      this.mode === 'incremental'
        ? createSharedResolutionProjectionResetScope(plans)
        : { requiresWholeBuildFullReset: true, reason: 'whole-build-full' };
    resetScopeReason = scope.reason;
    const createProjection = (): SqliteResolutionProjection | null =>
      this.mode === 'full-reset'
        ? null
        : new SqliteResolutionProjection(
            this.db,
            this.store,
            resolutionProjectionConstructorOptions(scope),
          );
    const projection =
      timer === undefined
        ? createProjection()
        : timer.measure('resetMs', createProjection);
    try {
      if (projection === null) {
        const reset = (): void => {
          this.store.resetResolutions();
          this.store.nullDanglingEdgeTargets();
        };
        if (timer === undefined) reset();
        else timer.measure('resetMs', reset);
      }
      const repositories: ResolutionCandidateRepositoryResult[] = [];
      const requireFull: string[] = [];
      for (const state of sortedStates) {
        const closure = closures.get(state.input.repoId) ?? null;
        const sourceFileIds =
          this.mode === 'incremental' &&
          !scope.requiresWholeBuildFullReset &&
          closure?.mode === 'incremental'
            ? closure.resetSourceFileIds
            : undefined;
        const trustedPrior =
          sourceFileIds !== undefined && state.prior !== null
            ? { metadata: state.prior, closureComplete: true }
            : undefined;
        const incompleteReasons: string[] = [];
        // Unknown facts/custom grammars must never become qualified captures.
        if (
          this.store
            .listFiles(state.input.repoId)
            .some((file): boolean => file.parseStatus === 'failed')
        )
          incompleteReasons.push('parse-failure');
        if (state.globalReasons.has('custom-grammar'))
          incompleteReasons.push('custom-grammar');
        const capture = runCapturedRepositoryResolution({
          db: this.db,
          store: projection ?? this.store,
          repoId: state.input.repoId,
          rootPath: state.input.rootPath,
          sourceFileIds,
          trustedPrior,
          incompleteReasons,
          measure:
            timer === undefined
              ? undefined
              : (resolver, operation): number =>
                  timer.measure(RESOLUTION_CAPTURE_PHASES[resolver], operation),
        });
        if (sourceFileIds !== undefined && !capture.metadata.complete)
          requireFull.push(state.input.repoId);
        repositories.push({
          repoId: state.input.repoId,
          closure,
          fallbackReasons: Array.from(state.globalReasons).sort(),
          capture,
        });
      }
      if (requireFull.length > 0)
        throw new ResolutionCandidateNeedsFullPass(requireFull);
      projection?.apply();
      timer?.persist(
        'resetMs',
        'importsMs',
        'configExtendsMs',
        'docLinksMs',
        'ipcMs',
        'workflowActionsMs',
        'callsMs',
        'testsMs',
      );
      const result: ResolutionCandidateResult = {
        mode: this.mode,
        repositories,
        projection: projection?.getCounters() ?? null,
        resetScopeReason,
      };
      this.resultValue = result;
      return result;
    } finally {
      projection?.close();
    }
  }

  public getResult(): ResolutionCandidateResult | null {
    return this.resultValue;
  }
  public close(): void {
    this.priorFacts.close();
  }
}

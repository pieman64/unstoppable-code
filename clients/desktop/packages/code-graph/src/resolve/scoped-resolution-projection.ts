// Proposed target: packages/code-graph/src/resolve/
// scoped-resolution-projection.ts
//
// Closure-owned scheduling/scoping helpers. The single W2 projection and its
// third-argument reset set are shared by every repository in one engine build.

import type {
  CodeGraphConfidenceTier,
  CodeGraphEdgeKind,
  CodeGraphEdgeRecord,
  CodeGraphFileRecord,
  CodeGraphSymbolKind,
  CodeGraphSymbolRecord,
} from '../types/code-graph';
import type { ResolutionProjectionStore } from './resolution-projection';
import {
  MAX_AFFECTED_SOURCE_FILES,
  type ResolutionClosureResult,
} from './resolution-dependency-index';

export const RESOLUTION_SCOPE_FILE_ID_BATCH_SIZE = 1_000;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ResolutionRepositoryProjectionPlan {
  repoId: string;
  closure: ResolutionClosureResult;
  /** Current repository file IDs for a repository-only full fallback. */
  repositoryFileIds?: readonly string[];
  /** Old dependency rows whose source file was deleted or is no longer indexed. */
  retiredDependencySourceFileIds?: readonly string[];
  /** Old generated TESTED_BY source-file owners not in files anymore. */
  retiredTestLinkSourceFileIds?: readonly string[];
  /** Only this explicit condition may request full reset of every repo. */
  forceWholeBuildFullReset?: boolean;
}

export interface SharedResolutionProjectionResetScope {
  /**
   * Passed as W2's third constructor argument. Undefined/omitted preserves the
   * independent legacy whole-graph reset; [] means an intentional no-reset.
   */
  resetSourceFileIds?: readonly string[];
  /** True means a caller could not safely localize; use old whole-graph reset. */
  requiresWholeBuildFullReset: boolean;
  reason: 'incremental-union' | 'whole-build-full' | 'unlocalizable-repository';
}

/** Exact W2 constructor third-argument shape authorized for engine integration. */
export interface SqliteResolutionProjectionOptions {
  resetSourceFileIds?: readonly string[];
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort(compareText);
}

/**
 * Build the one constructor reset set for the entire multi-repository overlay.
 * A repository-only fallback is expanded to every current file and every old
 * dependency/test-link owner for that repository. Missing localization or an
 * oversized union safely selects the legacy global reset; it never truncates.
 */
export function createSharedResolutionProjectionResetScope(
  plans: readonly ResolutionRepositoryProjectionPlan[],
): SharedResolutionProjectionResetScope {
  if (plans.some((plan) => plan.forceWholeBuildFullReset === true)) {
    return {
      requiresWholeBuildFullReset: true,
      reason: 'whole-build-full',
    };
  }

  const resetSourceFileIds = new Set<string>();
  const addSourceIds = (sourceFileIds: readonly string[]): boolean => {
    for (const sourceFileId of sourceFileIds) {
      resetSourceFileIds.add(sourceFileId);
      if (resetSourceFileIds.size > MAX_AFFECTED_SOURCE_FILES) return false;
    }
    return true;
  };
  for (const plan of plans) {
    if (plan.closure.mode === 'incremental') {
      if (!addSourceIds(plan.closure.resetSourceFileIds)) {
        return {
          requiresWholeBuildFullReset: true,
          reason: 'unlocalizable-repository',
        };
      }
      continue;
    }
    const repositoryFileIds = plan.repositoryFileIds;
    const retiredDependencySourceFileIds = plan.retiredDependencySourceFileIds;
    const retiredTestLinkSourceFileIds = plan.retiredTestLinkSourceFileIds;
    if (
      repositoryFileIds === undefined ||
      retiredDependencySourceFileIds === undefined ||
      retiredTestLinkSourceFileIds === undefined
    ) {
      return {
        requiresWholeBuildFullReset: true,
        reason: 'unlocalizable-repository',
      };
    }
    if (
      !addSourceIds(repositoryFileIds) ||
      !addSourceIds(retiredDependencySourceFileIds) ||
      !addSourceIds(retiredTestLinkSourceFileIds)
    ) {
      return {
        requiresWholeBuildFullReset: true,
        reason: 'unlocalizable-repository',
      };
    }
  }

  const uniqueIds = Array.from(resetSourceFileIds).sort(compareText);
  return {
    resetSourceFileIds: uniqueIds,
    requiresWholeBuildFullReset: false,
    reason: 'incremental-union',
  };
}

/**
 * Translate the multi-repo union into the single W2 constructor options value.
 * A whole-build fallback omits the field, preserving the legacy full reset;
 * incremental [] remains explicit and means none.
 */
export function resolutionProjectionConstructorOptions(
  scope: SharedResolutionProjectionResetScope,
): SqliteResolutionProjectionOptions {
  if (
    scope.requiresWholeBuildFullReset ||
    scope.resetSourceFileIds === undefined
  ) {
    return {};
  }
  return { resetSourceFileIds: scope.resetSourceFileIds };
}

export interface ResolutionSourceSelection {
  /** undefined means full; [] means no mutable source files. */
  sourceFileIds?: readonly string[];
}

function selectRowsForSourceFiles<T extends { sourceFileId: string }>(
  rows: readonly T[],
  sourceFileIds: readonly string[] | undefined,
): T[] {
  if (sourceFileIds === undefined) return [...rows];
  if (sourceFileIds.length === 0) return [];
  const selected = new Set(sourceFileIds);
  return rows
    .filter((row) => selected.has(row.sourceFileId))
    .sort((left, right) => compareText(left.sourceFileId, right.sourceFileId));
}

/**
 * Exact eleven-method W2 decorator. Those methods remain transparent: an
 * immutable symbol/file lookup or call-adjacency query cannot be silently
 * clipped by the source reset scope. Resolver code opts into the three
 * explicit mutable enumerators below when it passes its sourceFileIds.
 */
export class ScopedResolutionProjectionStore implements ResolutionProjectionStore {
  public constructor(private readonly inner: ResolutionProjectionStore) {}

  public listEdges(filter: {
    kind?: CodeGraphEdgeKind;
    unresolvedOnly?: boolean;
    sourceFileId?: string;
    repoId?: string;
  }): CodeGraphEdgeRecord[] {
    return this.inner.listEdges(filter);
  }

  public listConfigExtendsEdges(repoId: string): CodeGraphEdgeRecord[] {
    return this.inner.listConfigExtendsEdges(repoId);
  }

  public listTestCallTargets(repoId: string): Array<{
    sourceFileId: string;
    targetSymbolId: string;
    testFileSymbolId: string;
  }> {
    return this.inner.listTestCallTargets(repoId);
  }

  public getFileById(fileId: string): CodeGraphFileRecord | null {
    return this.inner.getFileById(fileId);
  }

  public listFiles(repoId: string): CodeGraphFileRecord[] {
    return this.inner.listFiles(repoId);
  }

  public getSymbolByQualifiedName(
    qualifiedName: string,
    repoId: string,
  ): CodeGraphSymbolRecord | null {
    return this.inner.getSymbolByQualifiedName(qualifiedName, repoId);
  }

  public listSymbolsForFile(fileId: string): CodeGraphSymbolRecord[] {
    return this.inner.listSymbolsForFile(fileId);
  }

  public listSymbolsByKindAndName(
    kind: CodeGraphSymbolKind,
    name: string,
    repoId: string,
  ): CodeGraphSymbolRecord[] {
    return this.inner.listSymbolsByKindAndName(kind, name, repoId);
  }

  public updateEdgeResolution(
    edgeId: string,
    update: {
      targetSymbolId: string;
      confidenceTier: CodeGraphConfidenceTier;
      confidenceScore: number;
      resolverId: string;
      evidence: Record<string, unknown>;
    },
  ): void {
    this.inner.updateEdgeResolution(edgeId, update);
  }

  public updateEdgeEvidence(
    edgeId: string,
    evidence: Record<string, unknown>,
  ): void {
    this.inner.updateEdgeEvidence(edgeId, evidence);
  }

  public insertEdges(edges: readonly CodeGraphEdgeRecord[]): void {
    this.inner.insertEdges(edges);
  }

  /**
   * Enumerate only mutable candidate rows for these sources through the same
   * temp reset+proposal view. Each SQL lookup uses the existing single-source
   * filter, never a large IN-list; all edges are returned in stable-ID order.
   * The call resolver must continue to use listEdges({ kind: 'IMPORTS_FROM' })
   * directly for global import adjacency, not this mutable candidate helper.
   */
  public forEachMutableEdgesForSources(
    filter: {
      kind?: CodeGraphEdgeKind;
      unresolvedOnly?: boolean;
      repoId?: string;
    },
    sourceFileIds: readonly string[],
    visitSource: (
      sourceFileId: string,
      edges: readonly CodeGraphEdgeRecord[],
    ) => void,
  ): void {
    const sourceIds = sortedUnique(sourceFileIds);
    if (sourceIds.length === 0) return;
    for (
      let offset = 0;
      offset < sourceIds.length;
      offset += RESOLUTION_SCOPE_FILE_ID_BATCH_SIZE
    ) {
      const batch = sourceIds.slice(
        offset,
        offset + RESOLUTION_SCOPE_FILE_ID_BATCH_SIZE,
      );
      for (const sourceFileId of batch) {
        const rows = this.inner
          .listEdges({
            ...filter,
            sourceFileId,
          })
          .sort((left, right) => compareText(left.id, right.id));
        visitSource(sourceFileId, rows);
      }
    }
  }

  /**
   * Existing W2 port only exposes the repository query. This pass projection
   * filters its rows by generated-link owner (the test source file) after the
   * TEMP view has produced candidates; unrelated repo rows are never written.
   * Parent may push the same selection into a query helper for row-volume work.
   */
  public listTestCallTargetsForSources(
    repoId: string,
    sourceFileIds: readonly string[] | undefined,
  ): Array<{
    sourceFileId: string;
    targetSymbolId: string;
    testFileSymbolId: string;
  }> {
    return selectRowsForSourceFiles(
      this.inner.listTestCallTargets(repoId),
      sourceFileIds,
    );
  }

  /** Config-extends candidate rows are likewise filtered by source owner. */
  public listConfigExtendsEdgesForSources(
    repoId: string,
    sourceFileIds: readonly string[] | undefined,
  ): CodeGraphEdgeRecord[] {
    return selectRowsForSourceFiles(
      this.inner.listConfigExtendsEdges(repoId),
      sourceFileIds,
    );
  }
}

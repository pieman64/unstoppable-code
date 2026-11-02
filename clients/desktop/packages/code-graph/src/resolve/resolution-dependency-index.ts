// Proposed target: packages/code-graph/src/resolve/
// resolution-dependency-index.ts
//
// Closure-owned consumer of the capture worker's schema-v5 writer/metadata
// API. Parent engine integration supplies the before/after fact keys and the
// compatibility snapshot read before fact writes begin.

import {
  CODE_GRAPH_SYMBOL_KINDS,
  type CodeGraphSymbolKind,
} from '../types/code-graph';
import {
  requireRow,
  requireString,
  type CodeGraphDatabase,
} from '../store/database';
import { repositoryRowId } from '../ids';
import {
  RESOLUTION_CAPTURE_ALGORITHM_VERSIONS,
  RESOLUTION_CAPTURE_FORMAT_VERSION,
  RESOLUTION_CAPTURE_RESOLVERS,
  RESOLUTION_CAPTURE_SCHEMA_VERSION,
  resolutionDependencyKey,
  type ResolutionCaptureResolver,
  type ResolutionDependencyCaptureMetadata,
  type ResolutionDependencyKey,
} from './resolution-dependency-capture';

export const MAX_AFFECTED_SOURCE_FILES = 10_000;
export const MAX_AFFECTED_DEPENDENCY_KEYS = 100_000;

export type ResolutionClosureFallbackReason =
  | 'capture-missing'
  | 'capture-invalid'
  | 'capture-incomplete'
  | 'schema-version-mismatch'
  | 'capture-version-mismatch'
  | 'root-path-mismatch'
  | 'algorithm-version-mismatch'
  | 'source-file-cap'
  | 'dependency-key-cap'
  | 'changed-symbol-cap'
  | 'repository-global-input'
  | 'unsupported-capture';

export interface ResolutionClosureCounters {
  /** Distinct changed/deleted/consumer source IDs discovered by closure. */
  visitedSourceFiles: number;
  /** Distinct (dependencyKind, dependencyKey) addresses enqueued/visited. */
  visitedDependencyKeys: number;
  /** Reverse-index rows returned from resolution_dependencies. */
  reverseOwnersRead: number;
  /** Current producer facts enumerated for changed files and fresh owners. */
  producerKeysRead: number;
  /** Changed symbol IDs admitted for owner lookup or cap decision. */
  changedSymbolIdsVisited: number;
  /** CALLS/TESTED_BY source-file rows returned across symbol queries. */
  changedSymbolSourceFilesRead: number;
}

export type ResolutionClosureResult =
  | {
      mode: 'incremental';
      /** Exact set passed to scoped W2 reset; [] means no reset. */
      resetSourceFileIds: readonly string[];
      /** Files whose dependency rows must be replaced, including deletions. */
      dependencyReplacementFileIds: readonly string[];
      counters: ResolutionClosureCounters;
      fallbackReason: null;
      /** Set only by the pass runner from actual W2 enumeration counters. */
      fullPassInspectedSourceFiles: null;
    }
  | {
      mode: 'full';
      /** Absence means full-repository resolution; never a truncated scope. */
      resetSourceFileIds: undefined;
      /** Full capture replaces all rows; no partial replacement list exists. */
      dependencyReplacementFileIds: undefined;
      counters: ResolutionClosureCounters;
      fallbackReason: ResolutionClosureFallbackReason;
      /** The parent pass runner fills this only from its actual source scan. */
      fullPassInspectedSourceFiles: number | null;
    };

export interface ResolutionClosureSeeds {
  /** Public repoId selects metadata/keys; SQL uses repositoryRowId(repoId). */
  repoId: string;
  rootPath: string;
  changedFileIds: readonly string[];
  deletedFileIds?: readonly string[];
  /** Every old and new external/fact key from the parent pre/post emitter. */
  changedDependencyKeys?: readonly ResolutionDependencyKey[];
  /** All changed symbol IDs, including surviving IDs whose membership changed. */
  changedSymbolIds?: readonly string[];
  /** This snapshot was checked before the facts writer invalidated metadata. */
  priorCompatibleMetadata: ResolutionDependencyCaptureMetadata | null;
  /** Global namespaces/configuration explicitly choose a repo-wide full pass. */
  repositoryGlobalChange?: boolean;
  /** Custom grammar, parse degradation, or nonlocalizable resolver input. */
  unsupportedCapture?: boolean;
}

export interface ResolutionDependencyOwner {
  resolver: ResolutionCaptureResolver;
  sourceFileId: string;
}

/**
 * Implemented by the schema-v5 index reader or a deterministic in-memory
 * oracle. `producerKeys` are outputs of a file, not observations owned by its
 * input edges. This distinction is what allows alias/barrel fixed points.
 */
export interface ResolutionDependencyClosureIndex {
  producerKeys(sourceFileId: string): readonly ResolutionDependencyKey[];
  reverseOwners(
    key: ResolutionDependencyKey,
  ): readonly ResolutionDependencyOwner[];
  sourceFilesUsingChangedSymbol(symbolId: string): readonly string[];
  /** All source owners that may need retirement on repository-only fallback. */
  dependencySourceFileIds(): readonly string[];
}

function emptyCounters(): ResolutionClosureCounters {
  return {
    visitedSourceFiles: 0,
    visitedDependencyKeys: 0,
    reverseOwnersRead: 0,
    producerKeysRead: 0,
    changedSymbolIdsVisited: 0,
    changedSymbolSourceFilesRead: 0,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueGroupsUpToCap(
  groups: readonly (readonly string[])[],
  cap: number,
): { values: string[]; exceeded: boolean } {
  const unique = new Set<string>();
  for (const values of groups) {
    for (const value of values) {
      unique.add(value);
      if (unique.size > cap)
        return { values: Array.from(unique), exceeded: true };
    }
  }
  return { values: Array.from(unique).sort(compareText), exceeded: false };
}

function keyIdentity(key: ResolutionDependencyKey): string {
  return JSON.stringify([key.dependencyKind, key.dependencyKey]);
}

function compareKeys(
  left: ResolutionDependencyKey,
  right: ResolutionDependencyKey,
): number {
  const kindOrder = compareText(left.dependencyKind, right.dependencyKind);
  return kindOrder !== 0
    ? kindOrder
    : compareText(left.dependencyKey, right.dependencyKey);
}

/** A bounded deterministic min-heap avoids insertion-order-dependent closure. */
class DependencyKeyQueue {
  private readonly heap: ResolutionDependencyKey[] = [];

  public get size(): number {
    return this.heap.length;
  }

  public push(key: ResolutionDependencyKey): void {
    this.heap.push(key);
    let child = this.heap.length - 1;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      const parentKey = this.heap[parent];
      const childKey = this.heap[child];
      if (
        parentKey === undefined ||
        childKey === undefined ||
        compareKeys(parentKey, childKey) <= 0
      ) {
        break;
      }
      this.heap[parent] = childKey;
      this.heap[child] = parentKey;
      child = parent;
    }
  }

  public pop(): ResolutionDependencyKey | undefined {
    const first = this.heap[0];
    if (first === undefined) return undefined;
    const last = this.heap.pop();
    if (this.heap.length === 0 || last === undefined) return first;
    this.heap[0] = last;
    let parent = 0;
    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let smallest = parent;
      const smallestKey = this.heap[smallest];
      const leftKey = this.heap[left];
      const rightKey = this.heap[right];
      if (
        smallestKey !== undefined &&
        leftKey !== undefined &&
        compareKeys(leftKey, smallestKey) < 0
      ) {
        smallest = left;
      }
      const nextSmallest = this.heap[smallest];
      if (
        nextSmallest !== undefined &&
        rightKey !== undefined &&
        compareKeys(rightKey, nextSmallest) < 0
      ) {
        smallest = right;
      }
      if (smallest === parent) break;
      const parentKey = this.heap[parent];
      const smallestChild = this.heap[smallest];
      if (parentKey === undefined || smallestChild === undefined) break;
      this.heap[parent] = smallestChild;
      this.heap[smallest] = parentKey;
      parent = smallest;
    }
    return first;
  }
}

function metadataFallback(
  metadata: ResolutionDependencyCaptureMetadata | null,
  rootPath: string,
): ResolutionClosureFallbackReason | null {
  if (metadata === null) return 'capture-missing';
  if (metadata.schemaVersion !== RESOLUTION_CAPTURE_SCHEMA_VERSION) {
    return 'schema-version-mismatch';
  }
  if (metadata.captureVersion !== RESOLUTION_CAPTURE_FORMAT_VERSION) {
    return 'capture-version-mismatch';
  }
  if (metadata.rootPath !== rootPath) return 'root-path-mismatch';
  if (!metadata.complete || metadata.incompleteResolvers.length > 0) {
    return 'capture-incomplete';
  }
  for (const resolver of RESOLUTION_CAPTURE_RESOLVERS) {
    if (
      metadata.algorithmVersions[resolver] !==
      RESOLUTION_CAPTURE_ALGORITHM_VERSIONS[resolver]
    ) {
      return 'algorithm-version-mismatch';
    }
  }
  return null;
}

function fullClosure(
  reason: ResolutionClosureFallbackReason,
  counters: ResolutionClosureCounters,
): ResolutionClosureResult {
  return {
    mode: 'full',
    resetSourceFileIds: undefined,
    dependencyReplacementFileIds: undefined,
    counters,
    fallbackReason: reason,
    fullPassInspectedSourceFiles: null,
  };
}

/** Schema-v5 reverse index reader; repository_id is opaque, never public ID. */
export class SqliteResolutionDependencyIndex implements ResolutionDependencyClosureIndex {
  private readonly repositoryId: string;

  public constructor(
    private readonly db: CodeGraphDatabase,
    private readonly repoId: string,
  ) {
    this.repositoryId = repositoryRowId(repoId);
  }

  /**
   * Produce current provider addresses from canonical facts. This is not a
   * query of resolution_dependencies: resolver rows are consumer observations
   * and may be edge-owned (`source_edge_id <> ''`). Deleted providers rely on
   * the parent's old+new pre/post changedDependencyKeys.
   */
  public producerKeys(
    sourceFileId: string,
  ): readonly ResolutionDependencyKey[] {
    const fileValue = this.db
      .prepare(
        `
        SELECT relative_path
        FROM files
        WHERE repository_id = ? AND id = ?
      `,
      )
      .get(this.repositoryId, sourceFileId);
    if (fileValue === undefined) return [];
    const relativePath = requireString(requireRow(fileValue), 'relative_path');
    const symbolRows = this.db
      .prepare(
        `
        SELECT kind, name, qualified_name, exported
        FROM symbols
        WHERE repository_id = ? AND file_id = ?
        ORDER BY qualified_name, kind, name
        LIMIT ${MAX_AFFECTED_DEPENDENCY_KEYS + 1}
      `,
      )
      .all(this.repositoryId, sourceFileId);

    if (symbolRows.length > MAX_AFFECTED_DEPENDENCY_KEYS) {
      throw new Error(
        'Producer symbol enumeration exceeded dependency-key bound',
      );
    }
    const keys = new Map<string, ResolutionDependencyKey>();
    const add = (key: ResolutionDependencyKey): void => {
      keys.set(keyIdentity(key), key);
    };
    add(resolutionDependencyKey.moduleImports(sourceFileId));
    add(resolutionDependencyKey.moduleSymbols(sourceFileId));
    add(resolutionDependencyKey.symbolsForFile(sourceFileId));
    add(resolutionDependencyKey.moduleCandidate(relativePath));
    for (const value of symbolRows) {
      const row = requireRow(value);
      const kindText = requireString(row, 'kind');
      const kind: CodeGraphSymbolKind | undefined =
        CODE_GRAPH_SYMBOL_KINDS.find((candidate) => candidate === kindText);
      if (kind === undefined) {
        throw new Error(`Unknown symbol kind in code graph: ${kindText}`);
      }
      const name = requireString(row, 'name');
      const qualifiedName = requireString(row, 'qualified_name');
      add(resolutionDependencyKey.qualifiedName(this.repoId, qualifiedName));
      add(
        resolutionDependencyKey.symbolsByKindAndName(this.repoId, kind, name),
      );
      if (row.exported === 1) {
        add(resolutionDependencyKey.exportedName(relativePath, name));
      }
      if (keys.size > MAX_AFFECTED_DEPENDENCY_KEYS) {
        return Array.from(keys.values()).sort(compareKeys);
      }
    }
    return Array.from(keys.values()).sort(compareKeys);
  }

  /** Reverse lookup is by (kind,key), preserving independent repo identity. */
  public reverseOwners(
    key: ResolutionDependencyKey,
  ): readonly ResolutionDependencyOwner[] {
    const rows = this.db
      .prepare(
        `
        SELECT MIN(resolver) AS resolver, source_file_id
        FROM resolution_dependencies
        WHERE repository_id = ? AND dependency_kind = ? AND dependency_key = ?
        GROUP BY source_file_id
        ORDER BY source_file_id
        LIMIT ${MAX_AFFECTED_SOURCE_FILES + 1}
      `,
      )
      .all(this.repositoryId, key.dependencyKind, key.dependencyKey);
    return rows.map((value) => {
      const row = requireRow(value);
      const resolver = requireString(row, 'resolver');
      if (!isCaptureResolver(resolver)) {
        throw new Error(
          `Unknown resolver in resolution_dependencies: ${resolver}`,
        );
      }
      return {
        resolver,
        sourceFileId: requireString(row, 'source_file_id'),
      };
    });
  }

  public dependencySourceFileIds(): readonly string[] {
    const rows = this.db
      .prepare(
        `
        SELECT DISTINCT source_file_id
        FROM resolution_dependencies
        WHERE repository_id = ?
        ORDER BY source_file_id
        LIMIT ${MAX_AFFECTED_SOURCE_FILES + 1}
      `,
      )
      .all(this.repositoryId);
    return rows.map((value) =>
      requireString(requireRow(value), 'source_file_id'),
    );
  }

  /**
   * A symbol target can change membership without changing a call's source
   * facts. Include old persisted CALLS callers and generated TESTED_BY owners;
   * TESTED_BY source_file_id is the test source file. Newly possible matches
   * are found through the parent's old+new store-symbols-by-kind-name keys.
   */
  public sourceFilesUsingChangedSymbol(symbolId: string): readonly string[] {
    const rows = this.db
      .prepare(
        `
        SELECT DISTINCT source_file_id
        FROM edges
        WHERE repository_id = ? AND (
          (kind = 'CALLS' AND target_symbol_id = ?)
          OR (kind = 'TESTED_BY' AND
            (source_symbol_id = ? OR target_symbol_id = ?))
        )
        ORDER BY source_file_id
        LIMIT ${MAX_AFFECTED_SOURCE_FILES + 1}
      `,
      )
      .all(this.repositoryId, symbolId, symbolId, symbolId);
    return rows.map((value) =>
      requireString(requireRow(value), 'source_file_id'),
    );
  }
}

/**
 * Follow old observed inputs to owner files, then follow each owner's current
 * producer outputs. The heap makes traversal independent of seed input order;
 * visited-address and visited-file sets terminate alias/star cycles.
 */
export function computeAffectedResolutionClosure(
  index: ResolutionDependencyClosureIndex,
  seeds: ResolutionClosureSeeds,
): ResolutionClosureResult {
  const counters = emptyCounters();
  const initialFileIds = uniqueGroupsUpToCap(
    [seeds.changedFileIds, seeds.deletedFileIds ?? []],
    MAX_AFFECTED_SOURCE_FILES,
  );
  counters.visitedSourceFiles = initialFileIds.values.length;
  const metadataReason = metadataFallback(
    seeds.priorCompatibleMetadata,
    seeds.rootPath,
  );
  if (metadataReason !== null) return fullClosure(metadataReason, counters);
  if (seeds.repositoryGlobalChange === true) {
    return fullClosure('repository-global-input', counters);
  }
  if (seeds.unsupportedCapture === true) {
    return fullClosure('unsupported-capture', counters);
  }
  if (initialFileIds.exceeded) {
    return fullClosure('source-file-cap', {
      ...counters,
      visitedSourceFiles: initialFileIds.values.length,
    });
  }

  const changedSymbolIds = uniqueGroupsUpToCap(
    [seeds.changedSymbolIds ?? []],
    MAX_AFFECTED_DEPENDENCY_KEYS,
  );
  counters.changedSymbolIdsVisited = changedSymbolIds.values.length;
  if (changedSymbolIds.exceeded) {
    return fullClosure('changed-symbol-cap', {
      ...counters,
      visitedSourceFiles: initialFileIds.values.length,
      changedSymbolIdsVisited: changedSymbolIds.values.length,
    });
  }

  const affectedFiles = new Set<string>(initialFileIds.values);
  const replacementFiles = new Set<string>(initialFileIds.values);
  counters.visitedSourceFiles = affectedFiles.size;

  try {
    for (const symbolId of changedSymbolIds.values) {
      const sourceFiles = index.sourceFilesUsingChangedSymbol(symbolId);
      counters.changedSymbolSourceFilesRead += sourceFiles.length;
      if (sourceFiles.length > MAX_AFFECTED_SOURCE_FILES) {
        return fullClosure('source-file-cap', counters);
      }
      for (const sourceFileId of sourceFiles) {
        affectedFiles.add(sourceFileId);
        replacementFiles.add(sourceFileId);
        if (affectedFiles.size > MAX_AFFECTED_SOURCE_FILES) {
          counters.visitedSourceFiles = affectedFiles.size;
          return fullClosure('source-file-cap', counters);
        }
      }
    }
  } catch {
    return fullClosure('capture-invalid', counters);
  }
  counters.visitedSourceFiles = affectedFiles.size;

  const queue = new DependencyKeyQueue();
  const visitedKeys = new Set<string>();
  const enqueue = (key: ResolutionDependencyKey): boolean => {
    const identity = keyIdentity(key);
    if (visitedKeys.has(identity)) return true;
    visitedKeys.add(identity);
    counters.visitedDependencyKeys = visitedKeys.size;
    if (visitedKeys.size > MAX_AFFECTED_DEPENDENCY_KEYS) return false;
    queue.push(key);
    return true;
  };

  const initialKeyByIdentity = new Map<string, ResolutionDependencyKey>();
  for (const key of seeds.changedDependencyKeys ?? []) {
    initialKeyByIdentity.set(keyIdentity(key), key);
    if (initialKeyByIdentity.size > MAX_AFFECTED_DEPENDENCY_KEYS) {
      return fullClosure('dependency-key-cap', {
        ...counters,
        visitedSourceFiles: affectedFiles.size,
        visitedDependencyKeys: initialKeyByIdentity.size,
      });
    }
  }
  const initialKeys = Array.from(initialKeyByIdentity.values()).sort(
    compareKeys,
  );
  try {
    for (const key of initialKeys) {
      if (!enqueue(key)) return fullClosure('dependency-key-cap', counters);
    }
  } catch {
    return fullClosure('capture-invalid', counters);
  }

  const expandedProducerFiles = new Set<string>();
  const enqueueProducerKeys = (sourceFileId: string): boolean => {
    if (expandedProducerFiles.has(sourceFileId)) return true;
    expandedProducerFiles.add(sourceFileId);
    const keys = index.producerKeys(sourceFileId);
    counters.producerKeysRead += keys.length;
    if (keys.length > MAX_AFFECTED_DEPENDENCY_KEYS) return false;
    const sortedKeys = [...keys].sort(compareKeys);
    for (const key of sortedKeys) {
      if (!enqueue(key)) return false;
    }
    return true;
  };

  try {
    for (const fileId of Array.from(affectedFiles).sort(compareText)) {
      if (!enqueueProducerKeys(fileId)) {
        return fullClosure('dependency-key-cap', counters);
      }
    }
  } catch {
    return fullClosure('capture-invalid', counters);
  }

  try {
    while (queue.size > 0) {
      const key = queue.pop();
      if (key === undefined) break;
      const owners = index.reverseOwners(key);
      counters.reverseOwnersRead += owners.length;
      if (owners.length > MAX_AFFECTED_SOURCE_FILES) {
        return fullClosure('source-file-cap', counters);
      }
      for (const owner of owners) {
        const isFreshOwner = !affectedFiles.has(owner.sourceFileId);
        affectedFiles.add(owner.sourceFileId);
        replacementFiles.add(owner.sourceFileId);
        counters.visitedSourceFiles = affectedFiles.size;
        if (affectedFiles.size > MAX_AFFECTED_SOURCE_FILES) {
          return fullClosure('source-file-cap', counters);
        }
        if (isFreshOwner && !enqueueProducerKeys(owner.sourceFileId)) {
          return fullClosure('dependency-key-cap', counters);
        }
      }
    }
  } catch {
    return fullClosure('capture-invalid', counters);
  }

  const resetSourceFileIds = Array.from(affectedFiles).sort(compareText);
  return {
    mode: 'incremental',
    resetSourceFileIds,
    dependencyReplacementFileIds:
      Array.from(replacementFiles).sort(compareText),
    counters,
    fallbackReason: null,
    fullPassInspectedSourceFiles: null,
  };
}

function isCaptureResolver(value: string): value is ResolutionCaptureResolver {
  return RESOLUTION_CAPTURE_RESOLVERS.some((resolver) => resolver === value);
}

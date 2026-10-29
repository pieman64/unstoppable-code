import type {
  CodeGraphEdgeRecord,
  CodeGraphFileRecord,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import type { ResolutionProjectionStore } from '../resolve/resolution-projection';
import {
  createSharedResolutionProjectionResetScope,
  resolutionProjectionConstructorOptions,
  RESOLUTION_SCOPE_FILE_ID_BATCH_SIZE,
  ScopedResolutionProjectionStore,
  type ResolutionRepositoryProjectionPlan,
} from '../resolve/scoped-resolution-projection';
import type { ResolutionClosureResult } from '../resolve/resolution-dependency-index';

function incrementalClosure(
  sourceFileIds: readonly string[],
): ResolutionClosureResult {
  return {
    mode: 'incremental',
    resetSourceFileIds: [...sourceFileIds],
    dependencyReplacementFileIds: [...sourceFileIds],
    counters: {
      visitedSourceFiles: sourceFileIds.length,
      visitedDependencyKeys: 0,
      reverseOwnersRead: 0,
      producerKeysRead: 0,
      changedSymbolIdsVisited: 0,
      changedSymbolSourceFilesRead: 0,
    },
    fallbackReason: null,
    fullPassInspectedSourceFiles: null,
  };
}

function fullClosure(): ResolutionClosureResult {
  return {
    mode: 'full',
    resetSourceFileIds: undefined,
    dependencyReplacementFileIds: undefined,
    counters: {
      visitedSourceFiles: 0,
      visitedDependencyKeys: 0,
      reverseOwnersRead: 0,
      producerKeysRead: 0,
      changedSymbolIdsVisited: 0,
      changedSymbolSourceFilesRead: 0,
    },
    fallbackReason: 'capture-incomplete',
    fullPassInspectedSourceFiles: null,
  };
}

function edge(
  id: string,
  sourceFileId: string,
  kind: CodeGraphEdgeRecord['kind'],
): CodeGraphEdgeRecord {
  return {
    id,
    repositoryId: 'opaque-repository-row-A',
    kind,
    sourceSymbolId: null,
    targetSymbolId: null,
    sourceFileId,
    targetRef: null,
    line: null,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1,
    resolverId: null,
    evidence: {},
  };
}

class MemoryProjectionStore implements ResolutionProjectionStore {
  public readonly edges: CodeGraphEdgeRecord[] = [
    edge('import-a', 'consumer-a', 'IMPORTS_FROM'),
    edge('import-z', 'consumer-z', 'IMPORTS_FROM'),
    edge('call-a', 'test-a', 'CALLS'),
    edge('call-z', 'test-z', 'CALLS'),
    edge('config-a', 'config-a', 'REFERENCES'),
    edge('config-z', 'config-z', 'REFERENCES'),
  ];
  public readonly testTargets = [
    {
      sourceFileId: 'test-a',
      targetSymbolId: 'production-a',
      testFileSymbolId: 'test-symbol-a',
    },
    {
      sourceFileId: 'test-z',
      targetSymbolId: 'production-z',
      testFileSymbolId: 'test-symbol-z',
    },
  ];
  public edgeQueryCount = 0;
  public immutableFileLookups: string[] = [];
  public immutableSymbolLookups: string[] = [];

  public listEdges(filter: {
    kind?: CodeGraphEdgeRecord['kind'];
    unresolvedOnly?: boolean;
    sourceFileId?: string;
    repoId?: string;
  }): CodeGraphEdgeRecord[] {
    this.edgeQueryCount += 1;
    return this.edges.filter(
      (row) =>
        (filter.kind === undefined || row.kind === filter.kind) &&
        (filter.sourceFileId === undefined ||
          row.sourceFileId === filter.sourceFileId),
    );
  }

  public listConfigExtendsEdges(_repoId: string): CodeGraphEdgeRecord[] {
    void _repoId;
    return this.edges.filter((row) => row.id.startsWith('config-'));
  }

  public listTestCallTargets(_repoId: string): Array<{
    sourceFileId: string;
    targetSymbolId: string;
    testFileSymbolId: string;
  }> {
    void _repoId;
    return [...this.testTargets];
  }

  public getFileById(_fileId: string): CodeGraphFileRecord | null {
    this.immutableFileLookups.push(_fileId);
    return null;
  }

  public listFiles(_repoId: string): CodeGraphFileRecord[] {
    void _repoId;
    return [];
  }

  public getSymbolByQualifiedName(
    qualifiedName: string,
    _repoId: string,
  ): CodeGraphSymbolRecord | null {
    void _repoId;
    this.immutableSymbolLookups.push(qualifiedName);
    return null;
  }

  public listSymbolsForFile(fileId: string): CodeGraphSymbolRecord[] {
    this.immutableSymbolLookups.push(`file:${fileId}`);
    return [];
  }

  public listSymbolsByKindAndName(
    _kind: CodeGraphSymbolRecord['kind'],
    name: string,
    _repoId: string,
  ): CodeGraphSymbolRecord[] {
    void _kind;
    void _repoId;
    this.immutableSymbolLookups.push(`name:${name}`);
    return [];
  }

  public updateEdgeResolution(
    _edgeId: string,
    _update: {
      targetSymbolId: string;
      confidenceTier: CodeGraphEdgeRecord['confidenceTier'];
      confidenceScore: number;
      resolverId: string;
      evidence: Record<string, unknown>;
    },
  ): void {
    void _edgeId;
    void _update;
  }

  public updateEdgeEvidence(
    _edgeId: string,
    _evidence: Record<string, unknown>,
  ): void {
    void _edgeId;
    void _evidence;
  }

  public insertEdges(_edges: readonly CodeGraphEdgeRecord[]): void {
    void _edges;
  }
}

describe('shared scoped resolution projection', () => {
  it('unions repository reset IDs once and preserves empty versus absent scope', () => {
    const plans: ResolutionRepositoryProjectionPlan[] = [
      { repoId: 'repo-b', closure: incrementalClosure(['b-2', 'shared']) },
      { repoId: 'repo-a', closure: incrementalClosure(['a-1', 'shared']) },
    ];
    const scope = createSharedResolutionProjectionResetScope(plans);
    expect(scope.requiresWholeBuildFullReset).toBe(false);
    expect(scope.resetSourceFileIds).toEqual(['a-1', 'b-2', 'shared']);
    expect(resolutionProjectionConstructorOptions(scope)).toEqual({
      resetSourceFileIds: ['a-1', 'b-2', 'shared'],
    });

    const noChange = createSharedResolutionProjectionResetScope([
      { repoId: 'repo-empty', closure: incrementalClosure([]) },
    ]);
    expect(noChange.resetSourceFileIds).toEqual([]);
    expect(resolutionProjectionConstructorOptions(noChange)).toEqual({
      resetSourceFileIds: [],
    });
    expect(noChange.reason).toBe('incremental-union');

    const full = createSharedResolutionProjectionResetScope([
      {
        repoId: 'repo-global',
        closure: fullClosure(),
        forceWholeBuildFullReset: true,
      },
    ]);
    expect(full.resetSourceFileIds).toBeUndefined();
    expect(resolutionProjectionConstructorOptions(full)).toEqual({});
    expect(full.reason).toBe('whole-build-full');
  });

  it('expands a repository-only fallback into that repo and retired owners', () => {
    const scope = createSharedResolutionProjectionResetScope([
      {
        repoId: 'repo-b',
        closure: incrementalClosure(['b-change']),
      },
      {
        repoId: 'repo-a',
        closure: fullClosure(),
        repositoryFileIds: ['a-current-2', 'a-current-1'],
        retiredDependencySourceFileIds: ['a-deleted-dependency-owner'],
        retiredTestLinkSourceFileIds: ['a-deleted-test-owner'],
      },
    ]);
    expect(scope.requiresWholeBuildFullReset).toBe(false);
    expect(scope.resetSourceFileIds).toEqual([
      'a-current-1',
      'a-current-2',
      'a-deleted-dependency-owner',
      'a-deleted-test-owner',
      'b-change',
    ]);

    const unlocalized = createSharedResolutionProjectionResetScope([
      { repoId: 'repo-a', closure: fullClosure(), repositoryFileIds: ['a1'] },
    ]);
    expect(unlocalized.requiresWholeBuildFullReset).toBe(true);
    expect(unlocalized.resetSourceFileIds).toBeUndefined();
  });

  it('keeps global import adjacency and immutable lookups transparent while scoping mutable rows', () => {
    const inner = new MemoryProjectionStore();
    const projection = new ScopedResolutionProjectionStore(inner);

    const importAdjacency = projection.listEdges({ kind: 'IMPORTS_FROM' });
    expect(importAdjacency.map((row) => row.id)).toEqual([
      'import-a',
      'import-z',
    ]);

    const visitedMutableCalls: string[] = [];
    projection.forEachMutableEdgesForSources(
      { kind: 'CALLS' },
      ['test-z', 'test-a', 'test-z'],
      (sourceFileId, rows) => {
        expect(rows.every((row) => row.sourceFileId === sourceFileId)).toBe(
          true,
        );
        visitedMutableCalls.push(...rows.map((row) => row.id));
      },
    );
    expect(visitedMutableCalls).toEqual(['call-a', 'call-z']);
    const queryCountBeforeEmptyScope = inner.edgeQueryCount;
    projection.forEachMutableEdgesForSources({ kind: 'CALLS' }, [], () => {
      throw new Error('An empty source scope must not enumerate mutable rows');
    });
    expect(inner.edgeQueryCount).toBe(queryCountBeforeEmptyScope);
    expect(
      projection.listTestCallTargetsForSources('repo-a', ['test-a']),
    ).toEqual([
      {
        sourceFileId: 'test-a',
        targetSymbolId: 'production-a',
        testFileSymbolId: 'test-symbol-a',
      },
    ]);
    expect(
      projection
        .listConfigExtendsEdgesForSources('repo-a', ['config-a'])
        .map((row) => row.sourceFileId),
    ).toEqual(['config-a']);

    projection.getFileById('unselected-file');
    projection.getSymbolByQualifiedName('qualified::unselected', 'repo-a');
    projection.listSymbolsForFile('unselected-file');
    expect(inner.immutableFileLookups).toEqual(['unselected-file']);
    expect(inner.immutableSymbolLookups).toEqual([
      'qualified::unselected',
      'file:unselected-file',
    ]);
  });

  it('streams a large scope in bounded source-ID batches without a global edge map', () => {
    const inner = new MemoryProjectionStore();
    const projection = new ScopedResolutionProjectionStore(inner);
    const sourceFileIds = Array.from(
      { length: 1_001 },
      (_, index) => `source-${index.toString().padStart(4, '0')}`,
    );
    const visitedSourceIds: string[] = [];
    projection.forEachMutableEdgesForSources(
      { kind: 'CALLS' },
      sourceFileIds,
      (sourceFileId, rows) => {
        expect(rows.every((row) => row.sourceFileId === sourceFileId)).toBe(
          true,
        );
        visitedSourceIds.push(sourceFileId);
      },
    );
    expect(inner.edgeQueryCount).toBe(sourceFileIds.length);
    expect(visitedSourceIds[0]).toBe('source-0000');
    expect(visitedSourceIds[visitedSourceIds.length - 1]).toBe('source-1000');
    expect(RESOLUTION_SCOPE_FILE_ID_BATCH_SIZE).toBe(1_000);
  });
});

import {
  RESOLUTION_CAPTURE_ALGORITHM_VERSIONS,
  RESOLUTION_CAPTURE_FORMAT_VERSION,
  RESOLUTION_CAPTURE_SCHEMA_VERSION,
  resolutionDependencyKey,
} from '../resolve/resolution-dependency-capture';
import type {
  ResolutionCaptureResolver,
  ResolutionDependencyCaptureMetadata,
  ResolutionDependencyKey,
} from '../resolve/resolution-dependency-capture';
import {
  computeAffectedResolutionClosure,
  MAX_AFFECTED_DEPENDENCY_KEYS,
  MAX_AFFECTED_SOURCE_FILES,
  type ResolutionDependencyClosureIndex,
  type ResolutionDependencyOwner,
  type ResolutionClosureSeeds,
  type ResolutionClosureResult,
} from '../resolve/resolution-dependency-index';

function completeMetadata(
  rootPath: string,
): ResolutionDependencyCaptureMetadata {
  return {
    schemaVersion: RESOLUTION_CAPTURE_SCHEMA_VERSION,
    captureVersion: RESOLUTION_CAPTURE_FORMAT_VERSION,
    rootPath,
    complete: true,
    algorithmVersions: RESOLUTION_CAPTURE_ALGORITHM_VERSIONS,
    incompleteResolvers: [],
    reasonsByResolver: {},
    dependencyCoverage: {
      'ts-module-resolution': { rowCount: 1, sourceCount: 1, sha256: 'a' },
      'config-extends': { rowCount: 1, sourceCount: 1, sha256: 'b' },
      'doc-link': { rowCount: 1, sourceCount: 1, sha256: 'c' },
      'ipc-channel': { rowCount: 1, sourceCount: 1, sha256: 'd' },
      'workflow-action': { rowCount: 1, sourceCount: 1, sha256: 'e' },
      'call-resolution': { rowCount: 1, sourceCount: 1, sha256: 'f' },
      'test-linker': { rowCount: 1, sourceCount: 1, sha256: 'g' },
    },
  };
}

function identity(key: ResolutionDependencyKey): string {
  return JSON.stringify([key.dependencyKind, key.dependencyKey]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class MemoryClosureIndex implements ResolutionDependencyClosureIndex {
  public readonly producers = new Map<string, ResolutionDependencyKey[]>();
  public readonly consumers = new Map<string, ResolutionDependencyOwner[]>();
  public readonly symbolOwners = new Map<string, string[]>();

  public producerKeys(
    sourceFileId: string,
  ): readonly ResolutionDependencyKey[] {
    return this.producers.get(sourceFileId) ?? [];
  }

  public reverseOwners(
    key: ResolutionDependencyKey,
  ): readonly ResolutionDependencyOwner[] {
    return this.consumers.get(identity(key)) ?? [];
  }

  public sourceFilesUsingChangedSymbol(symbolId: string): readonly string[] {
    return this.symbolOwners.get(symbolId) ?? [];
  }

  public dependencySourceFileIds(): readonly string[] {
    return Array.from(this.producers.keys()).sort(compareText);
  }

  public produce(
    sourceFileId: string,
    keys: readonly ResolutionDependencyKey[],
  ): void {
    this.producers.set(sourceFileId, [...keys]);
  }

  public consume(
    sourceFileId: string,
    resolver: ResolutionCaptureResolver,
    key: ResolutionDependencyKey,
  ): void {
    const owners = this.consumers.get(identity(key)) ?? [];
    owners.push({ sourceFileId, resolver });
    this.consumers.set(identity(key), owners);
  }
}

function seeds(
  changedFileIds: readonly string[],
  changedDependencyKeys: readonly ResolutionDependencyKey[] = [],
  changedSymbolIds: readonly string[] = [],
): ResolutionClosureSeeds {
  return {
    repoId: 'public-repo-A',
    rootPath: '/work/repo-A',
    changedFileIds,
    changedDependencyKeys,
    changedSymbolIds,
    priorCompatibleMetadata: completeMetadata('/work/repo-A'),
  };
}

describe('resolution dependency fixed-point closure', () => {
  it('walks edge-owned alias outputs through cycles and changed test targets', () => {
    const index = new MemoryClosureIndex();
    const libRun = resolutionDependencyKey.exportedName('src/lib.ts', 'run');
    const barrelAOutput = resolutionDependencyKey.exportedName(
      'src/barrel-a.ts',
      'run',
    );
    const barrelBOutput = resolutionDependencyKey.exportedName(
      'src/barrel-b.ts',
      'run',
    );

    // Inputs are edge-owned consumers, deliberately not source_edge_id=''.
    index.consume('barrel-a', 'ts-module-resolution', libRun);
    index.consume('barrel-b', 'ts-module-resolution', barrelAOutput);
    index.consume('barrel-a', 'ts-module-resolution', barrelBOutput);
    index.consume('consumer', 'ts-module-resolution', barrelAOutput);
    index.consume('test-owner', 'test-linker', barrelBOutput);
    index.produce('lib', [
      resolutionDependencyKey.moduleCandidate('src/lib.ts'),
      libRun,
    ]);
    index.produce('barrel-a', [
      resolutionDependencyKey.moduleCandidate('src/barrel-a.ts'),
      barrelAOutput,
    ]);
    index.produce('barrel-b', [
      resolutionDependencyKey.moduleCandidate('src/barrel-b.ts'),
      barrelBOutput,
    ]);
    index.produce('consumer', [
      resolutionDependencyKey.moduleImports('consumer'),
    ]);
    index.produce('test-owner', [
      resolutionDependencyKey.symbolsForFile('test-owner'),
    ]);
    index.symbolOwners.set('symbol-before-and-after', ['test-owner', 'caller']);

    const result = computeAffectedResolutionClosure(
      index,
      seeds(['lib'], [libRun], ['symbol-before-and-after']),
    );

    if (result.mode !== 'incremental') {
      throw new Error(`Expected scoped closure; got ${result.fallbackReason}`);
    }
    expect(result.resetSourceFileIds).toEqual([
      'barrel-a',
      'barrel-b',
      'caller',
      'consumer',
      'lib',
      'test-owner',
    ]);
    expect(result.counters.visitedDependencyKeys).toBeGreaterThan(0);
    expect(result.counters.changedSymbolIdsVisited).toBe(1);
    expect(result.counters.changedSymbolSourceFilesRead).toBe(2);
    expect(result.counters.reverseOwnersRead).toBeGreaterThan(0);
  });

  it('is deterministic when changed-key seed order differs', () => {
    const run = (
      keys: readonly ResolutionDependencyKey[],
    ): ResolutionClosureResult => {
      const index = new MemoryClosureIndex();
      const a = resolutionDependencyKey.moduleCandidate('src/a.ts');
      const b = resolutionDependencyKey.exportedName('src/b.ts', 'entry');
      index.consume('consumer-b', 'ts-module-resolution', a);
      index.consume('consumer-a', 'ts-module-resolution', b);
      index.produce('consumer-a', [
        resolutionDependencyKey.moduleImports('consumer-a'),
      ]);
      index.produce('consumer-b', [
        resolutionDependencyKey.moduleImports('consumer-b'),
      ]);
      return computeAffectedResolutionClosure(index, seeds(['changed'], keys));
    };
    const a = resolutionDependencyKey.moduleCandidate('src/a.ts');
    const b = resolutionDependencyKey.exportedName('src/b.ts', 'entry');
    const first = run([a, b]);
    const reversed = run([b, a]);
    expect(first).toEqual(reversed);
  });

  it('requires the checked pre-facts metadata snapshot and refuses stale roots', () => {
    const index = new MemoryClosureIndex();
    const absent = computeAffectedResolutionClosure(index, {
      ...seeds(['changed']),
      priorCompatibleMetadata: null,
    });
    expect(absent.mode).toBe('full');
    if (absent.mode === 'full')
      expect(absent.fallbackReason).toBe('capture-missing');

    const wrongRoot = computeAffectedResolutionClosure(index, {
      ...seeds(['changed']),
      priorCompatibleMetadata: completeMetadata('/copied/elsewhere'),
    });
    expect(wrongRoot.mode).toBe('full');
    if (wrongRoot.mode === 'full') {
      expect(wrongRoot.fallbackReason).toBe('root-path-mismatch');
      expect(wrongRoot.resetSourceFileIds).toBeUndefined();
      expect(wrongRoot.fullPassInspectedSourceFiles).toBeNull();
    }
  });

  it('falls back rather than truncating the initial changed/deleted file union', () => {
    const index = new MemoryClosureIndex();
    const ids = Array.from(
      { length: MAX_AFFECTED_SOURCE_FILES },
      (_, index) => `changed-${index.toString().padStart(5, '0')}`,
    );
    const result = computeAffectedResolutionClosure(index, {
      ...seeds(ids.slice(0, MAX_AFFECTED_SOURCE_FILES - 1)),
      deletedFileIds: ids.slice(MAX_AFFECTED_SOURCE_FILES - 1),
    });
    expect(result.mode).toBe('incremental');

    const over = computeAffectedResolutionClosure(index, {
      ...seeds(ids),
      deletedFileIds: ['one-more-deleted'],
    });
    expect(over.mode).toBe('full');
    if (over.mode === 'full') {
      expect(over.fallbackReason).toBe('source-file-cap');
      expect(over.counters.visitedSourceFiles).toBe(
        MAX_AFFECTED_SOURCE_FILES + 1,
      );
      expect(over.resetSourceFileIds).toBeUndefined();
    }
  });

  it('uses an explicit full-repository fallback after the distinct-key cap', () => {
    const index = new MemoryClosureIndex();
    const keys = Array.from(
      { length: MAX_AFFECTED_DEPENDENCY_KEYS + 1 },
      (_, index) => resolutionDependencyKey.moduleCandidate(`src/${index}.ts`),
    );
    const result = computeAffectedResolutionClosure(
      index,
      seeds(['changed'], keys),
    );
    expect(result.mode).toBe('full');
    if (result.mode === 'full') {
      expect(result.fallbackReason).toBe('dependency-key-cap');
      expect(result.counters.visitedDependencyKeys).toBe(
        MAX_AFFECTED_DEPENDENCY_KEYS + 1,
      );
      expect(result.dependencyReplacementFileIds).toBeUndefined();
    }
  });
});

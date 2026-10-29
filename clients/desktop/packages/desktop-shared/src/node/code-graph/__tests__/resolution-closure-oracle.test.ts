// Supplemental algorithm fixture only: this does not instantiate the
// production CodeGraphEngine, W2 SQLite view, or production resolver passes.
// Keep the fixed-seed model history as a fast oracle, but do not use it as
// production overlay/equivalence qualification; that belongs in the parent's
// full-reset/stable-diff/incremental/cold engine driver.
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
  type ResolutionDependencyClosureIndex,
  type ResolutionDependencyOwner,
} from '../resolve/resolution-dependency-index';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface FixtureSymbol {
  id: string;
  name: string;
  exported: boolean;
}

interface FixtureImport {
  id: string;
  specifier: string;
  candidatePath: string;
  importedName: string;
}

interface FixtureReExport {
  exportedName: string;
  sourceFileId: string;
  importedName: string;
}

interface FixtureCall {
  id: string;
  name: string;
}

interface FixtureFile {
  id: string;
  relativePath: string;
  present: boolean;
  testFileSymbolId: string | null;
  symbols: readonly FixtureSymbol[];
  imports: readonly FixtureImport[];
  reexports: readonly FixtureReExport[];
  calls: readonly FixtureCall[];
}

interface SemanticEdge {
  id: string;
  kind: 'IMPORTS_FROM' | 'CALLS' | 'TESTED_BY';
  sourceFileId: string;
  sourceSymbolId: string | null;
  targetSymbolId: string | null;
  targetRef: string | null;
}

class FixtureWorld {
  private readonly files = new Map<string, FixtureFile>();

  public add(file: FixtureFile): void {
    this.files.set(file.id, file);
  }

  public get(fileId: string): FixtureFile {
    const file = this.files.get(fileId);
    if (file === undefined) throw new Error(`Missing fixture file ${fileId}`);
    return file;
  }

  public allFiles(): readonly FixtureFile[] {
    return Array.from(this.files.values()).sort((left, right) =>
      compareText(left.id, right.id),
    );
  }

  public clone(): FixtureWorld {
    const cloned = new FixtureWorld();
    for (const file of Array.from(this.files.values())) {
      cloned.add({
        ...file,
        symbols: file.symbols.map((symbol) => ({ ...symbol })),
        imports: file.imports.map((value) => ({ ...value })),
        reexports: file.reexports.map((value) => ({ ...value })),
        calls: file.calls.map((value) => ({ ...value })),
      });
    }
    return cloned;
  }

  public activeFiles(): readonly FixtureFile[] {
    return this.allFiles().filter((file) => file.present);
  }

  public activeFilesAtPath(relativePath: string): readonly FixtureFile[] {
    return this.activeFiles().filter(
      (file) => file.relativePath === relativePath,
    );
  }

  public resolveExports(
    fileId: string,
    name: string,
    visited: ReadonlySet<string> = new Set<string>(),
  ): readonly FixtureSymbol[] {
    const file = this.get(fileId);
    if (!file.present) return [];
    const marker = `${fileId}\u0000${name}`;
    if (visited.has(marker)) return [];
    const nextVisited = new Set(visited);
    nextVisited.add(marker);

    const locals = file.symbols.filter(
      (symbol) => symbol.exported && symbol.name === name,
    );
    if (locals.length > 0) return locals;

    const targets = new Map<string, FixtureSymbol>();
    for (const reexport of file.reexports) {
      if (reexport.exportedName !== name) continue;
      const symbols = this.resolveExports(
        reexport.sourceFileId,
        reexport.importedName,
        nextVisited,
      );
      for (const symbol of symbols) targets.set(symbol.id, symbol);
    }
    return Array.from(targets.values()).sort((left, right) =>
      compareText(left.id, right.id),
    );
  }

  public allExportedTargets(name: string): readonly FixtureSymbol[] {
    const targets = new Map<string, FixtureSymbol>();
    for (const file of this.activeFiles()) {
      for (const symbol of this.resolveExports(file.id, name)) {
        targets.set(symbol.id, symbol);
      }
    }
    return Array.from(targets.values()).sort((left, right) =>
      compareText(left.id, right.id),
    );
  }
}

function newWorld(): FixtureWorld {
  const world = new FixtureWorld();
  world.add({
    id: 'lib-main',
    relativePath: 'src/lib-main.ts',
    present: true,
    testFileSymbolId: null,
    symbols: [{ id: 'symbol-main-run', name: 'run', exported: true }],
    imports: [],
    reexports: [],
    calls: [],
  });
  world.add({
    id: 'lib-alternate',
    relativePath: 'src/lib-alternate.ts',
    present: true,
    testFileSymbolId: null,
    symbols: [{ id: 'symbol-alternate-run', name: 'run', exported: false }],
    imports: [],
    reexports: [],
    calls: [],
  });
  world.add({
    id: 'barrel-a',
    relativePath: 'src/barrel-a.ts',
    present: true,
    testFileSymbolId: null,
    symbols: [],
    imports: [],
    reexports: [
      { exportedName: 'run', sourceFileId: 'barrel-b', importedName: 'run' },
    ],
    calls: [],
  });
  world.add({
    id: 'barrel-b',
    relativePath: 'src/barrel-b.ts',
    present: true,
    testFileSymbolId: null,
    symbols: [],
    imports: [],
    reexports: [
      { exportedName: 'run', sourceFileId: 'barrel-a', importedName: 'run' },
      { exportedName: 'run', sourceFileId: 'lib-main', importedName: 'run' },
    ],
    calls: [],
  });
  world.add({
    id: 'consumer',
    relativePath: 'src/consumer.ts',
    present: true,
    testFileSymbolId: null,
    symbols: [],
    imports: [
      {
        id: 'import-consumer-run',
        specifier: './barrel-a',
        candidatePath: 'src/barrel-a.ts',
        importedName: 'run',
      },
    ],
    reexports: [],
    calls: [],
  });
  world.add({
    id: 'bridge',
    relativePath: 'src/bridge.ts',
    present: true,
    testFileSymbolId: null,
    symbols: [],
    imports: [
      {
        id: 'import-optional-late',
        specifier: './optional',
        candidatePath: 'src/optional.ts',
        importedName: 'late',
      },
    ],
    reexports: [],
    calls: [],
  });
  world.add({
    id: 'optional',
    relativePath: 'src/optional.ts',
    present: false,
    testFileSymbolId: null,
    symbols: [{ id: 'symbol-optional-late', name: 'late', exported: true }],
    imports: [],
    reexports: [],
    calls: [],
  });
  world.add({
    id: 'test-a',
    relativePath: 'src/test-a.test.ts',
    present: true,
    testFileSymbolId: 'test-file-symbol-a',
    symbols: [],
    imports: [],
    reexports: [],
    calls: [
      { id: 'call-run-0', name: 'run' },
      { id: 'call-run-1', name: 'run' },
    ],
  });
  world.add({
    id: 'test-b',
    relativePath: 'src/test-b.test.ts',
    present: true,
    testFileSymbolId: 'test-file-symbol-b',
    symbols: [],
    imports: [],
    reexports: [],
    calls: [{ id: 'call-late-0', name: 'late' }],
  });
  return world;
}

function resolveImportTarget(
  world: FixtureWorld,
  importedName: string,
  candidatePath: string,
): FixtureSymbol | null {
  const candidateFiles = world.activeFilesAtPath(candidatePath);
  if (candidateFiles.length !== 1) return null;
  const targetFile = candidateFiles[0];
  if (targetFile === undefined) return null;
  const targets = world.resolveExports(targetFile.id, importedName);
  return targets.length === 1 ? (targets[0] ?? null) : null;
}

function outputForSource(
  world: FixtureWorld,
  fileId: string,
): readonly SemanticEdge[] {
  const file = world.get(fileId);
  if (!file.present) return [];
  const edges: SemanticEdge[] = [];
  for (const imported of file.imports) {
    const target = resolveImportTarget(
      world,
      imported.importedName,
      imported.candidatePath,
    );
    edges.push({
      id: `edge:${imported.id}`,
      kind: 'IMPORTS_FROM',
      sourceFileId: file.id,
      sourceSymbolId: null,
      targetSymbolId: target?.id ?? null,
      targetRef: imported.specifier,
    });
  }
  for (const call of file.calls) {
    const targets = world.allExportedTargets(call.name);
    const target = targets.length === 1 ? (targets[0] ?? null) : null;
    edges.push({
      id: `edge:call:${file.id}:${call.id}`,
      kind: 'CALLS',
      sourceFileId: file.id,
      sourceSymbolId: file.testFileSymbolId,
      targetSymbolId: target?.id ?? null,
      targetRef: call.name,
    });
    if (file.testFileSymbolId !== null && target !== null) {
      edges.push({
        id: `edge:test-link:${file.id}:${call.id}`,
        kind: 'TESTED_BY',
        // The generated link is owned by the test source, not production file.
        sourceFileId: file.id,
        sourceSymbolId: target.id,
        targetSymbolId: file.testFileSymbolId,
        targetRef: null,
      });
    }
  }
  return edges;
}

/** Independent reset-everything oracle used after every edit. */
function fullResetOracle(world: FixtureWorld): SemanticEdge[] {
  const edges: SemanticEdge[] = [];
  for (const file of world.activeFiles()) {
    edges.push(...outputForSource(world, file.id));
  }
  return edges.sort((left, right) => compareText(left.id, right.id));
}

/** Stable-ID diff oracle models the W2 old-row/new-proposal final apply. */
function applyStableIdDiff(
  priorEdges: readonly SemanticEdge[],
  freshEdges: readonly SemanticEdge[],
): SemanticEdge[] {
  const priorById = new Map<string, SemanticEdge>();
  const freshById = new Map<string, SemanticEdge>();
  for (const edge of priorEdges) priorById.set(edge.id, edge);
  for (const edge of freshEdges) freshById.set(edge.id, edge);
  const finalById = new Map(priorById);
  for (const [id, prior] of Array.from(priorById)) {
    const fresh = freshById.get(id);
    if (fresh === undefined) {
      finalById.delete(id);
      continue;
    }
    if (JSON.stringify(prior) !== JSON.stringify(fresh)) {
      finalById.set(id, fresh);
    }
  }
  for (const [id, fresh] of Array.from(freshById)) {
    if (!priorById.has(id)) finalById.set(id, fresh);
  }
  return Array.from(finalById.values()).sort((left, right) =>
    compareText(left.id, right.id),
  );
}

function dedupeKeys(
  keys: readonly ResolutionDependencyKey[],
): ResolutionDependencyKey[] {
  const unique = new Map<string, ResolutionDependencyKey>();
  for (const key of keys) {
    unique.set(JSON.stringify([key.dependencyKind, key.dependencyKey]), key);
  }
  return Array.from(unique.values()).sort((left, right) => {
    const kindOrder = compareText(left.dependencyKind, right.dependencyKind);
    return kindOrder !== 0
      ? kindOrder
      : compareText(left.dependencyKey, right.dependencyKey);
  });
}

function inputKeysForFile(
  world: FixtureWorld,
  file: FixtureFile,
): readonly ResolutionDependencyKey[] {
  const keys: ResolutionDependencyKey[] = [];
  for (const imported of file.imports) {
    keys.push(
      resolutionDependencyKey.moduleSpecifier(file.id, imported.specifier),
      resolutionDependencyKey.moduleCandidate(imported.candidatePath),
      resolutionDependencyKey.exportedName(
        imported.candidatePath,
        imported.importedName,
      ),
    );
  }
  for (const reexport of file.reexports) {
    const targetFile = world.get(reexport.sourceFileId);
    keys.push(
      resolutionDependencyKey.moduleSpecifier(file.id, targetFile.relativePath),
      resolutionDependencyKey.moduleCandidate(targetFile.relativePath),
      resolutionDependencyKey.exportedName(
        targetFile.relativePath,
        reexport.importedName,
      ),
    );
  }
  for (const call of file.calls) {
    keys.push(
      resolutionDependencyKey.symbolsByKindAndName(
        'public-repo-A',
        'function',
        call.name,
      ),
    );
    if (file.testFileSymbolId !== null) {
      keys.push(resolutionDependencyKey.testCallCandidate(file.id, call.name));
    }
  }
  return dedupeKeys(keys);
}

function producerKeysForFile(
  file: FixtureFile,
): readonly ResolutionDependencyKey[] {
  if (!file.present) return [];
  const keys: ResolutionDependencyKey[] = [
    resolutionDependencyKey.moduleImports(file.id),
    resolutionDependencyKey.moduleSymbols(file.id),
    resolutionDependencyKey.symbolsForFile(file.id),
    resolutionDependencyKey.moduleCandidate(file.relativePath),
  ];
  for (const symbol of file.symbols) {
    keys.push(
      resolutionDependencyKey.qualifiedName(
        'public-repo-A',
        `${file.id}::${symbol.name}`,
      ),
      resolutionDependencyKey.symbolsByKindAndName(
        'public-repo-A',
        'function',
        symbol.name,
      ),
    );
    if (symbol.exported) {
      keys.push(
        resolutionDependencyKey.exportedName(file.relativePath, symbol.name),
      );
    }
  }
  for (const reexport of file.reexports) {
    keys.push(
      resolutionDependencyKey.exportedName(
        file.relativePath,
        reexport.exportedName,
      ),
    );
  }
  return dedupeKeys(keys);
}

function resolverForKey(
  key: ResolutionDependencyKey,
): ResolutionCaptureResolver {
  if (
    key.dependencyKind === 'module-candidate' ||
    key.dependencyKind === 'module-specifier' ||
    key.dependencyKind === 'export-candidate-set'
  ) {
    return 'ts-module-resolution';
  }
  if (key.dependencyKind === 'test-call-candidate-set') return 'test-linker';
  return 'call-resolution';
}

class FixtureClosureIndex implements ResolutionDependencyClosureIndex {
  private readonly priorEdges: readonly SemanticEdge[];
  private readonly owners = new Map<string, ResolutionDependencyOwner[]>();

  public constructor(
    prior: FixtureWorld,
    private readonly current: FixtureWorld,
  ) {
    this.priorEdges = fullResetOracle(prior);
    for (const file of prior.activeFiles()) {
      for (const key of inputKeysForFile(prior, file)) {
        const identity = JSON.stringify([
          key.dependencyKind,
          key.dependencyKey,
        ]);
        const owners = this.owners.get(identity) ?? [];
        owners.push({
          resolver: resolverForKey(key),
          sourceFileId: file.id,
        });
        this.owners.set(identity, owners);
      }
    }
  }

  public producerKeys(
    sourceFileId: string,
  ): readonly ResolutionDependencyKey[] {
    return producerKeysForFile(this.current.get(sourceFileId));
  }

  public reverseOwners(
    key: ResolutionDependencyKey,
  ): readonly ResolutionDependencyOwner[] {
    const identity = JSON.stringify([key.dependencyKind, key.dependencyKey]);
    return this.owners.get(identity) ?? [];
  }

  public sourceFilesUsingChangedSymbol(symbolId: string): readonly string[] {
    const sourceFileIds = new Set<string>();
    for (const edge of this.priorEdges) {
      if (
        (edge.kind === 'CALLS' && edge.targetSymbolId === symbolId) ||
        (edge.kind === 'TESTED_BY' &&
          (edge.sourceSymbolId === symbolId ||
            edge.targetSymbolId === symbolId))
      ) {
        sourceFileIds.add(edge.sourceFileId);
      }
    }
    return Array.from(sourceFileIds).sort(compareText);
  }

  public dependencySourceFileIds(): readonly string[] {
    const sourceFileIds = new Set<string>();
    for (const ownerList of Array.from(this.owners.values())) {
      for (const owner of ownerList) sourceFileIds.add(owner.sourceFileId);
    }
    return Array.from(sourceFileIds).sort(compareText);
  }
}

function changedSymbolIds(
  before: FixtureWorld,
  after: FixtureWorld,
  changedFileIds: readonly string[],
): string[] {
  const ids = new Set<string>();
  for (const fileId of changedFileIds) {
    for (const symbol of before.get(fileId).symbols) ids.add(symbol.id);
    for (const symbol of after.get(fileId).symbols) ids.add(symbol.id);
  }
  return Array.from(ids).sort(compareText);
}

function changedKeys(
  before: FixtureWorld,
  after: FixtureWorld,
  changedFileIds: readonly string[],
): ResolutionDependencyKey[] {
  const keys: ResolutionDependencyKey[] = [];
  for (const fileId of changedFileIds) {
    const beforeFile = before.get(fileId);
    const afterFile = after.get(fileId);
    keys.push(
      ...producerKeysForFile(beforeFile),
      ...producerKeysForFile(afterFile),
      ...inputKeysForFile(before, beforeFile),
      ...inputKeysForFile(after, afterFile),
    );
  }
  return dedupeKeys(keys);
}

function refreshIncrementally(
  priorEdges: readonly SemanticEdge[],
  world: FixtureWorld,
  sourceFileIds: readonly string[],
): SemanticEdge[] {
  const selected = new Set(sourceFileIds);
  const kept = priorEdges.filter((edge) => !selected.has(edge.sourceFileId));
  for (const sourceFileId of Array.from(selected).sort((left, right) =>
    compareText(left, right),
  )) {
    if (!world.get(sourceFileId).present) continue;
    kept.push(...outputForSource(world, sourceFileId));
  }
  return kept.sort((left, right) => compareText(left.id, right.id));
}

function makeMetadata(rootPath: string): ResolutionDependencyCaptureMetadata {
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

function mutateForStep(
  world: FixtureWorld,
  operation: number,
): readonly string[] {
  if (operation === 0) {
    const file = world.get('lib-main');
    const symbol = file.symbols[0];
    if (symbol === undefined)
      throw new Error('lib-main fixture symbol missing');
    const name = symbol.name === 'run' ? 'renamedRun' : 'run';
    world.add({
      ...file,
      symbols: [{ ...symbol, name }],
    });
    return ['lib-main'];
  }
  if (operation === 1) {
    const file = world.get('lib-alternate');
    const symbol = file.symbols[0];
    if (symbol === undefined)
      throw new Error('lib-alternate fixture symbol missing');
    world.add({
      ...file,
      symbols: [{ ...symbol, exported: !symbol.exported }],
    });
    return ['lib-alternate'];
  }
  if (operation === 2) {
    const file = world.get('barrel-b');
    const current = file.reexports.find(
      (reexport) => reexport.sourceFileId !== 'barrel-a',
    );
    const target =
      current?.sourceFileId === 'lib-main' ? 'lib-alternate' : 'lib-main';
    world.add({
      ...file,
      reexports: [
        { exportedName: 'run', sourceFileId: 'barrel-a', importedName: 'run' },
        { exportedName: 'run', sourceFileId: target, importedName: 'run' },
      ],
    });
    return ['barrel-b'];
  }
  if (operation === 3) {
    const file = world.get('optional');
    world.add({ ...file, present: !file.present });
    return ['optional'];
  }
  if (operation === 4) {
    const file = world.get('test-a');
    const priorRunCalls = file.calls.filter(
      (call) => call.name === 'run',
    ).length;
    const nextCount = (priorRunCalls + 1) % 4;
    const calls = Array.from({ length: nextCount }, (_, index) => ({
      id: `call-run-${index}`,
      name: 'run',
    }));
    world.add({ ...file, calls });
    return ['test-a'];
  }
  const file = world.get('bridge');
  const importFact = file.imports[0];
  if (importFact === undefined)
    throw new Error('bridge import fixture missing');
  const candidatePath =
    importFact.candidatePath === 'src/optional.ts'
      ? 'src/missing.ts'
      : 'src/optional.ts';
  world.add({
    ...file,
    imports: [
      {
        ...importFact,
        candidatePath,
        specifier:
          candidatePath === 'src/optional.ts' ? './optional' : './missing',
      },
    ],
  });
  return ['bridge'];
}

function qualificationStep(
  priorWorld: FixtureWorld,
  currentWorld: FixtureWorld,
  priorIncrementalEdges: readonly SemanticEdge[],
  changedFileIds: readonly string[],
): SemanticEdge[] {
  const deletedFileIds = changedFileIds.filter(
    (fileId) =>
      priorWorld.get(fileId).present && !currentWorld.get(fileId).present,
  );
  const index = new FixtureClosureIndex(priorWorld, currentWorld);
  const result = computeAffectedResolutionClosure(index, {
    repoId: 'public-repo-A',
    rootPath: '/fixture/repo-A',
    changedFileIds,
    deletedFileIds,
    changedDependencyKeys: changedKeys(
      priorWorld,
      currentWorld,
      changedFileIds,
    ),
    changedSymbolIds: changedSymbolIds(
      priorWorld,
      currentWorld,
      changedFileIds,
    ),
    // This is the snapshot captured before facts are replaced. The runner must
    // not consult a metadata marker after the writer invalidates it.
    priorCompatibleMetadata: makeMetadata('/fixture/repo-A'),
  });
  if (result.mode === 'full') {
    return fullResetOracle(currentWorld);
  }
  return refreshIncrementally(
    priorIncrementalEdges,
    currentWorld,
    result.resetSourceFileIds,
  );
}

describe('supplemental source-scoped reset model oracle', () => {
  it('matches full reset after alias cycles, negative candidates, renames, and repeated links', () => {
    const world = newWorld();
    let incrementalEdges = fullResetOracle(world);

    for (const edit of [
      { fileId: 'lib-main', update: 0 },
      { fileId: 'lib-alternate', update: 1 },
      { fileId: 'barrel-b', update: 2 },
      { fileId: 'optional', update: 3 },
      { fileId: 'test-a', update: 4 },
      { fileId: 'bridge', update: 5 },
    ]) {
      const before = world.clone();
      const changedFileIds = mutateForStep(world, edit.update);
      const oldRows = incrementalEdges;
      const fullResetRows = fullResetOracle(world);
      const diffRows = applyStableIdDiff(oldRows, fullResetRows);
      const coldRows = fullResetOracle(world.clone());
      incrementalEdges = qualificationStep(
        before,
        world,
        oldRows,
        changedFileIds,
      );
      expect(diffRows).toEqual(fullResetRows);
      expect(coldRows).toEqual(fullResetRows);
      expect(incrementalEdges).toEqual(fullResetRows);
    }

    const generatedLinks = incrementalEdges.filter(
      (edge) => edge.kind === 'TESTED_BY' && edge.sourceFileId === 'test-a',
    );
    expect(new Set(generatedLinks.map((edge) => edge.id)).size).toBe(
      generatedLinks.length,
    );
    expect(generatedLinks.every((edge) => edge.sourceFileId === 'test-a')).toBe(
      true,
    );
  });

  it('retains a deterministic fixed-seed 100-edit qualification loop', () => {
    let state = 0x5eed1234;
    const nextRandom = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };

    const world = newWorld();
    let incrementalEdges = fullResetOracle(world);
    const seed = state;
    for (let step = 0; step < 100; step += 1) {
      const before = world.clone();
      const operation = nextRandom() % 6;
      const changedFileIds = mutateForStep(world, operation);
      const oldRows = incrementalEdges;
      const fullResetRows = fullResetOracle(world);
      const diffRows = applyStableIdDiff(oldRows, fullResetRows);
      const coldRows = fullResetOracle(world.clone());
      incrementalEdges = qualificationStep(
        before,
        world,
        oldRows,
        changedFileIds,
      );
      expect({
        context: `diff: seed ${seed}, edit ${step}`,
        value: diffRows,
      }).toEqual({
        context: `diff: seed ${seed}, edit ${step}`,
        value: fullResetRows,
      });
      expect({
        context: `cold: seed ${seed}, edit ${step}`,
        value: coldRows,
      }).toEqual({
        context: `cold: seed ${seed}, edit ${step}`,
        value: fullResetRows,
      });
      expect({
        context: `incremental: seed ${seed}, edit ${step}`,
        value: incrementalEdges,
      }).toEqual({
        context: `incremental: seed ${seed}, edit ${step}`,
        value: fullResetRows,
      });
    }
  });
});

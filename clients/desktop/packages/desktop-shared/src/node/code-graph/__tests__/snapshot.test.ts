import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  getMetadataValue,
  openCodeGraphDatabase,
  setMetadataValue,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import { isSymbolFtsMappingTrusted } from '../store/fts';
import {
  edgeRowId,
  fileQualifiedName,
  fileRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import type {
  CodeGraphEdgeRecord,
  CodeGraphFileFacts,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import type {
  CodeGraphSnapshotEdge,
  CodeGraphSnapshotEnvelope,
  CodeGraphSnapshotFile,
  CodeGraphSnapshotSymbol,
} from '../../../types/code-graph-tools';
import {
  buildCodeGraphSnapshot,
  CodeGraphSnapshotShrinkError,
  exportCodeGraphSnapshotToFile,
  readBundledGrammarManifest,
} from '../snapshot/export';
import {
  applyCodeGraphSnapshot,
  CodeGraphSnapshotVersionError,
  checkSnapshotGrammarCompatibility,
  parseCodeGraphSnapshotEnvelope,
  SNAPSHOT_IMPORT_MAX_COLLISION_WARNINGS,
} from '../snapshot/import';

const REPO = 'repo-a';
const FIXED_GENERATED_AT = '2026-07-09T00:00:00.000Z';

// --- Shared fixture helpers (mirrors the hand-built-facts pattern used by
// queries.test.ts / change-impact.test.ts: real store writes through
// replaceFileFacts, not mocks). ---

function fileSymbol(
  relativePath: string,
  repoId: string = REPO,
): CodeGraphSymbolRecord {
  return {
    id: symbolRowId(repoId, fileQualifiedName(relativePath)),
    repositoryId: repoId,
    fileId: fileRowId(repoId, relativePath),
    kind: 'file',
    name: relativePath.split('/').pop() ?? relativePath,
    qualifiedName: fileQualifiedName(relativePath),
    parentSymbolId: null,
    lineStart: 1,
    lineEnd: 10,
    byteStart: 0,
    byteEnd: 100,
    signature: null,
    exported: false,
    isTest: false,
    extra: {},
  };
}

function fnSymbol(
  relativePath: string,
  name: string,
  repoId: string = REPO,
): CodeGraphSymbolRecord {
  return {
    ...fileSymbol(relativePath, repoId),
    id: symbolRowId(repoId, symbolQualifiedName(relativePath, [], name)),
    kind: 'function',
    name,
    qualifiedName: symbolQualifiedName(relativePath, [], name),
    lineStart: 2,
    lineEnd: 4,
    byteStart: 10,
    byteEnd: 50,
    signature: `function ${name}(): void {}`,
  };
}

function facts(
  relativePath: string,
  symbols: CodeGraphSymbolRecord[],
  edges: CodeGraphEdgeRecord[] = [],
  repoId: string = REPO,
): CodeGraphFileFacts {
  return {
    file: {
      id: fileRowId(repoId, relativePath),
      repositoryId: repoId,
      relativePath,
      absolutePath: `/abs/${relativePath}`,
      language: 'typescript',
      contentHash: `hash-${relativePath}`,
      sizeBytes: 100,
      mtimeNs: '1700000000000000000',
      lineCount: 10,
      grammarId: 'typescript',
      grammarAbi: 14,
      parseStatus: 'parsed',
      hasErrors: false,
      updatedAt: Date.now(),
    },
    symbols,
    edges,
  };
}

function resolvedCallEdge(
  relativePath: string,
  sourceId: string,
  target: CodeGraphSymbolRecord,
  line: number,
  repoId: string = REPO,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId,
      kind: 'CALLS',
      sourceId,
      target: target.name,
      line,
    }),
    repositoryId: repoId,
    kind: 'CALLS',
    sourceSymbolId: sourceId,
    targetSymbolId: target.id,
    sourceFileId: fileRowId(repoId, relativePath),
    targetRef: target.name,
    line,
    confidenceTier: 'RESOLVED',
    confidenceScore: 0.9,
    resolverId: 'import-binding',
    evidence: { via: 'import' },
  };
}

function unresolvedReferenceEdge(
  relativePath: string,
  sourceId: string,
  targetName: string,
  line: number,
  repoId: string = REPO,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId,
      kind: 'REFERENCES',
      sourceId,
      target: targetName,
      line,
    }),
    repositoryId: repoId,
    kind: 'REFERENCES',
    sourceSymbolId: sourceId,
    targetSymbolId: null,
    sourceFileId: fileRowId(repoId, relativePath),
    targetRef: targetName,
    line,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1,
    resolverId: null,
    evidence: { capture: 'reference.call' },
  };
}

function setupStore(prefix: string): {
  dir: string;
  db: CodeGraphDatabase;
  store: CodeGraphStore;
} {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
  runCodeGraphMigrations(db);
  const store = new CodeGraphStore(db);
  return { dir, db, store };
}

// --- Synthetic SNAPSHOT-side entry helpers (for import-only tests that build
// an envelope by hand rather than exporting one from a seeded store). ---

function snapshotFileEntry(relativePath: string): CodeGraphSnapshotFile {
  return {
    relativePath,
    language: 'typescript',
    contentHash: `hash-${relativePath}`,
    sizeBytes: 100,
    mtimeNs: '1700000000000000000',
    lineCount: 10,
    grammarId: 'typescript',
    grammarAbi: 14,
    parseStatus: 'parsed',
    hasErrors: false,
  };
}

function snapshotSymbolEntry(
  qualifiedName: string,
  filePath: string,
): CodeGraphSnapshotSymbol {
  return {
    qualifiedName,
    kind: qualifiedName.includes('::') ? 'function' : 'file',
    signature: null,
    filePath,
  };
}

// Two calls with DIFFERENT `targetRef` values (the raw pre-resolution
// reference text — e.g. two aliased imports of one function) but identical
// kind/source/line/RESOLVED-target reconstruct to the SAME edge id under the
// import module's generic id formula, which hashes the resolved target
// symbol id, not the raw text the original extractor hashed. This is the
// exact collision scenario the collision-handling tests below exercise.
function collidingCallEdge(targetRef: string): CodeGraphSnapshotEdge {
  return {
    kind: 'CALLS',
    sourceFilePath: 'src/main.ts',
    sourceQualifiedName: 'src/main.ts::run',
    targetQualifiedName: 'src/lib.ts::helper',
    targetRef,
    line: 3,
    confidenceTier: 'RESOLVED',
    confidenceScore: 0.9,
    resolverId: 'import-binding',
    evidence: {},
  };
}

function syntheticTwoFileEnvelope(
  edges: CodeGraphSnapshotEdge[],
): CodeGraphSnapshotEnvelope {
  return {
    schemaVersion: 1,
    generatedAt: FIXED_GENERATED_AT,
    repository: { repoId: REPO, gitHead: null },
    grammars: [], // empty on purpose: keeps result.warnings collision-only
    files: [snapshotFileEntry('src/lib.ts'), snapshotFileEntry('src/main.ts')],
    symbols: [
      snapshotSymbolEntry('src/lib.ts', 'src/lib.ts'),
      snapshotSymbolEntry('src/lib.ts::helper', 'src/lib.ts'),
      snapshotSymbolEntry('src/main.ts', 'src/main.ts'),
      snapshotSymbolEntry('src/main.ts::run', 'src/main.ts'),
    ],
    edges,
  };
}

// Builds a small two-file graph: src/lib.ts::helper (called by
// src/main.ts::run), plus one unresolved reference from run(). Returns the
// store already seeded and the repository's gitHead for assertions.
function seedTwoFileGraph(
  store: CodeGraphStore,
  repoId: string,
  rootPath: string,
  gitHead: string | null,
): void {
  store.upsertRepository({ repoId, rootPath, gitHead });
  const libFile = fileSymbol('src/lib.ts', repoId);
  const helper = fnSymbol('src/lib.ts', 'helper', repoId);
  store.replaceFileFacts(facts('src/lib.ts', [libFile, helper], [], repoId));

  const mainFile = fileSymbol('src/main.ts', repoId);
  const run = fnSymbol('src/main.ts', 'run', repoId);
  const callEdge = resolvedCallEdge('src/main.ts', run.id, helper, 3, repoId);
  const unresolvedEdge = unresolvedReferenceEdge(
    'src/main.ts',
    run.id,
    'somethingUnbound',
    4,
    repoId,
  );
  store.replaceFileFacts(
    facts('src/main.ts', [mainFile, run], [callEdge, unresolvedEdge], repoId),
  );
}

describe('buildCodeGraphSnapshot (export)', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  beforeEach(() => {
    ({ dir, db, store } = setupStore('code-graph-snapshot-export-'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is byte-identical across two exports of the same state with a fixed generatedAt', async () => {
    seedTwoFileGraph(store, REPO, '/abs/root', 'commit-a');

    const first = await buildCodeGraphSnapshot({
      store,
      repoId: REPO,
      generatedAt: FIXED_GENERATED_AT,
    });
    const second = await buildCodeGraphSnapshot({
      store,
      repoId: REPO,
      generatedAt: FIXED_GENERATED_AT,
    });

    expect(second.json).toBe(first.json);
  });

  it('produces the documented envelope shape: repo-relative only, stable sort, 2-space indent + trailing newline', async () => {
    seedTwoFileGraph(store, REPO, '/abs/root', 'commit-a');

    const { envelope, json } = await buildCodeGraphSnapshot({
      store,
      repoId: REPO,
      generatedAt: FIXED_GENERATED_AT,
    });

    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.generatedAt).toBe(FIXED_GENERATED_AT);
    expect(envelope.repository).toEqual({ repoId: REPO, gitHead: 'commit-a' });
    expect(envelope.grammars.length).toBeGreaterThan(0);

    // Files sorted by relativePath, no absolutePath field anywhere.
    expect(envelope.files.map((file) => file.relativePath)).toEqual([
      'src/lib.ts',
      'src/main.ts',
    ]);
    expect(JSON.stringify(envelope)).not.toContain('/abs/');

    // Symbols sorted by qualifiedName.
    expect(envelope.symbols.map((symbol) => symbol.qualifiedName)).toEqual(
      [...envelope.symbols.map((symbol) => symbol.qualifiedName)].sort(),
    );
    expect(envelope.symbols).toContainEqual({
      qualifiedName: 'src/lib.ts::helper',
      kind: 'function',
      signature: 'function helper(): void {}',
      filePath: 'src/lib.ts',
    });

    // Edges carry portable qualifiedName/relativePath references, not
    // internal hash ids.
    const callEdge = envelope.edges.find(
      (edge) => edge.kind === 'CALLS' && edge.targetQualifiedName !== null,
    );
    expect(callEdge).toMatchObject({
      sourceFilePath: 'src/main.ts',
      sourceQualifiedName: 'src/main.ts::run',
      targetQualifiedName: 'src/lib.ts::helper',
      confidenceTier: 'RESOLVED',
    });
    const unresolvedEdge = envelope.edges.find(
      (edge) => edge.kind === 'REFERENCES',
    );
    expect(unresolvedEdge).toMatchObject({
      sourceQualifiedName: 'src/main.ts::run',
      targetQualifiedName: null,
      targetRef: 'somethingUnbound',
    });

    // 2-space indent + trailing newline.
    expect(json.endsWith('}\n')).toBe(true);
    expect(json).toContain('{\n  "schemaVersion": 1,');
    expect(json).toBe(`${JSON.stringify(envelope, null, 2)}\n`);
  });

  it('throws when the requested repository does not exist', async () => {
    await expect(
      buildCodeGraphSnapshot({
        store,
        repoId: 'no-such-repo',
        generatedAt: FIXED_GENERATED_AT,
      }),
    ).rejects.toThrow('no-such-repo');
  });

  // Schema v2 (Phase 6 Task 3) added derived-analysis tables (communities/
  // flows + their memberships). The snapshot contract deliberately never
  // carries them -- see snapshot/export.ts's comment on
  // buildCodeGraphSnapshot. This locks that in at both the type level
  // (CodeGraphSnapshotEnvelope has no communities/flows fields at all) and
  // at runtime (populating derived data doesn't leak into the exported JSON
  // and doesn't interact with the refuse-to-shrink guard, which only ever
  // compares `symbols.length`).
  it('excludes derived-analysis tables (communities/flows) from the snapshot entirely', async () => {
    seedTwoFileGraph(store, REPO, '/abs/root', 'commit-a');
    const helperId = symbolRowId(
      REPO,
      symbolQualifiedName('src/lib.ts', [], 'helper'),
    );
    store.replaceDerivedForRepo(
      REPO,
      [
        {
          id: 'com-1',
          repositoryId: REPO,
          label: 'src',
          cohesion: 0.9,
          size: 1,
          fingerprint: 'fp-1',
          extra: {},
        },
      ],
      [{ communityId: 'com-1', symbolId: helperId }],
      [
        {
          id: 'flow-1',
          repositoryId: REPO,
          entrySymbolId: helperId,
          name: 'flow 1',
          criticality: 0.5,
          symbolCount: 1,
          fileSpread: 1,
          maxDepth: 0,
          extra: {},
        },
      ],
      [{ flowId: 'flow-1', symbolId: helperId, depth: 0 }],
    );

    const withDerived = await buildCodeGraphSnapshot({
      store,
      repoId: REPO,
      generatedAt: FIXED_GENERATED_AT,
    });

    expect(Object.keys(withDerived.envelope).sort()).toEqual(
      [
        'schemaVersion',
        'generatedAt',
        'repository',
        'grammars',
        'files',
        'symbols',
        'edges',
      ].sort(),
    );
    expect(withDerived.json).not.toContain('communities');
    expect(withDerived.json).not.toContain('"flows"');
    expect(withDerived.json).not.toContain('cohesion');
    expect(withDerived.json).not.toContain('criticality');

    // Wiping derived data entirely changes nothing the shrink-guard cares
    // about (it only ever inspects `symbols.length`).
    store.replaceDerivedForRepo(REPO, [], [], [], []);
    const withoutDerived = await buildCodeGraphSnapshot({
      store,
      repoId: REPO,
      generatedAt: FIXED_GENERATED_AT,
    });
    expect(withoutDerived.json).toBe(withDerived.json);
  });
});

describe('exportCodeGraphSnapshotToFile (refuse-to-shrink)', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let outPath: string;

  beforeEach(() => {
    ({ dir, db, store } = setupStore('code-graph-snapshot-shrink-'));
    outPath = path.join(dir, 'out', 'graph.snapshot.json');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedManySymbolFile(count: number): void {
    store.upsertRepository({
      repoId: REPO,
      rootPath: '/abs/root',
      gitHead: null,
    });
    const file = fileSymbol('src/big.ts');
    const fns = Array.from({ length: count }, (_, index) =>
      fnSymbol('src/big.ts', `fn${index}`),
    );
    store.replaceFileFacts(facts('src/big.ts', [file, ...fns]));
  }

  it('writes freely when the destination does not exist yet', async () => {
    seedManySymbolFile(3);
    const { envelope } = await exportCodeGraphSnapshotToFile({
      store,
      repoId: REPO,
      generatedAt: FIXED_GENERATED_AT,
      outPath,
    });
    expect(envelope.symbols.length).toBe(4); // file symbol + 3 functions
    const written: unknown = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(written).toEqual(envelope);
  });

  it('refuses to overwrite with a snapshot whose symbol count shrank by more than 50%, naming both counts', async () => {
    seedManySymbolFile(9); // 10 symbols total (file + 9 fns)
    await exportCodeGraphSnapshotToFile({
      store,
      repoId: REPO,
      generatedAt: FIXED_GENERATED_AT,
      outPath,
    });

    // Now shrink drastically: replace the file's facts with just the file
    // symbol and one function (2 symbols total, well under half of 10).
    const file = fileSymbol('src/big.ts');
    const onlyFn = fnSymbol('src/big.ts', 'onlyOne');
    store.replaceFileFacts(facts('src/big.ts', [file, onlyFn]));

    await expect(
      exportCodeGraphSnapshotToFile({
        store,
        repoId: REPO,
        generatedAt: FIXED_GENERATED_AT,
        outPath,
      }),
    ).rejects.toThrow(CodeGraphSnapshotShrinkError);

    try {
      await exportCodeGraphSnapshotToFile({
        store,
        repoId: REPO,
        generatedAt: FIXED_GENERATED_AT,
        outPath,
      });
      throw new Error('expected exportCodeGraphSnapshotToFile to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CodeGraphSnapshotShrinkError);
      if (error instanceof CodeGraphSnapshotShrinkError) {
        expect(error.previousSymbolCount).toBe(10);
        expect(error.nextSymbolCount).toBe(2);
        expect(error.message).toContain('10');
        expect(error.message).toContain('2');
      }
    }

    // The destination file must be untouched by the rejected write.
    const stillOnDisk: unknown = JSON.parse(readFileSync(outPath, 'utf8'));
    if (!Array.isArray((stillOnDisk as { symbols?: unknown }).symbols)) {
      throw new Error(
        'expected the on-disk snapshot to still have a symbols array',
      );
    }
    expect((stillOnDisk as { symbols: unknown[] }).symbols.length).toBe(10);
  });

  it('force: true overrides the refuse-to-shrink guard', async () => {
    seedManySymbolFile(9);
    await exportCodeGraphSnapshotToFile({
      store,
      repoId: REPO,
      generatedAt: FIXED_GENERATED_AT,
      outPath,
    });

    const file = fileSymbol('src/big.ts');
    const onlyFn = fnSymbol('src/big.ts', 'onlyOne');
    store.replaceFileFacts(facts('src/big.ts', [file, onlyFn]));

    const { envelope } = await exportCodeGraphSnapshotToFile({
      store,
      repoId: REPO,
      generatedAt: FIXED_GENERATED_AT,
      outPath,
      force: true,
    });
    expect(envelope.symbols.length).toBe(2);
    const written: unknown = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(written).toEqual(envelope);
  });
});

describe('parseCodeGraphSnapshotEnvelope (import validation)', () => {
  it('rejects a wrong schemaVersion with a typed error naming expected/actual', () => {
    const raw = {
      schemaVersion: 2,
      generatedAt: FIXED_GENERATED_AT,
      repository: { repoId: REPO, gitHead: null },
      grammars: [],
      files: [],
      symbols: [],
      edges: [],
    };
    expect(() => parseCodeGraphSnapshotEnvelope(raw)).toThrow(
      CodeGraphSnapshotVersionError,
    );
    try {
      parseCodeGraphSnapshotEnvelope(raw);
      throw new Error('expected parseCodeGraphSnapshotEnvelope to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CodeGraphSnapshotVersionError);
      expect((error as Error).message).toContain('1');
      expect((error as Error).message).toContain('2');
    }
  });

  it('rejects a non-object root', () => {
    expect(() => parseCodeGraphSnapshotEnvelope('not an object')).toThrow(
      /must be an object/,
    );
  });

  it('rejects a missing/malformed files array', () => {
    const raw = {
      schemaVersion: 1,
      generatedAt: FIXED_GENERATED_AT,
      repository: { repoId: REPO, gitHead: null },
      grammars: [],
      files: 'nope',
      symbols: [],
      edges: [],
    };
    expect(() => parseCodeGraphSnapshotEnvelope(raw)).toThrow(/"files"/);
  });

  it('rejects a symbol referencing a file absent from the files list', () => {
    const raw = {
      schemaVersion: 1,
      generatedAt: FIXED_GENERATED_AT,
      repository: { repoId: REPO, gitHead: null },
      grammars: [],
      files: [],
      symbols: [
        {
          qualifiedName: 'src/ghost.ts',
          kind: 'file',
          signature: null,
          filePath: 'src/ghost.ts',
        },
      ],
      edges: [],
    };
    expect(() => parseCodeGraphSnapshotEnvelope(raw)).toThrow(/references a/);
  });

  it('rejects an edge referencing a file absent from the files list', () => {
    const raw = {
      schemaVersion: 1,
      generatedAt: FIXED_GENERATED_AT,
      repository: { repoId: REPO, gitHead: null },
      grammars: [],
      files: [],
      symbols: [],
      edges: [
        {
          kind: 'CALLS',
          sourceFilePath: 'src/ghost.ts',
          sourceQualifiedName: null,
          targetQualifiedName: null,
          targetRef: 'somewhere',
          line: 1,
          confidenceTier: 'EXTRACTED',
          confidenceScore: 1,
          resolverId: null,
          evidence: {},
        },
      ],
    };
    expect(() => parseCodeGraphSnapshotEnvelope(raw)).toThrow(
      /edge references a file not present/,
    );
  });

  it('rejects a file whose relativePath contains a ".." segment', () => {
    const raw = {
      schemaVersion: 1,
      generatedAt: FIXED_GENERATED_AT,
      repository: { repoId: REPO, gitHead: null },
      grammars: [],
      files: [snapshotFileEntry('../escape.ts')],
      symbols: [],
      edges: [],
    };
    expect(() => parseCodeGraphSnapshotEnvelope(raw)).toThrow(
      /repo-relative path/,
    );
  });

  it('rejects a file with an absolute relativePath', () => {
    const raw = {
      schemaVersion: 1,
      generatedAt: FIXED_GENERATED_AT,
      repository: { repoId: REPO, gitHead: null },
      grammars: [],
      files: [snapshotFileEntry('/etc/passwd')],
      symbols: [],
      edges: [],
    };
    expect(() => parseCodeGraphSnapshotEnvelope(raw)).toThrow(
      /repo-relative path/,
    );
  });

  it('rejects a file whose relativePath contains a backslash (Windows traversal)', () => {
    // `"..\\evil.ts"` has no `..` element when split on `/`, but on Windows
    // path.join treats `\` as a separator, so it would still traverse out of
    // the import root. A legit export can never contain a backslash —
    // canonicalRelativePath normalizes `\` to `/` before paths reach the
    // store — so ANY backslash is rejected outright.
    const raw = {
      schemaVersion: 1,
      generatedAt: FIXED_GENERATED_AT,
      repository: { repoId: REPO, gitHead: null },
      grammars: [],
      files: [snapshotFileEntry('..\\evil.ts')],
      symbols: [],
      edges: [],
    };
    expect(() => parseCodeGraphSnapshotEnvelope(raw)).toThrow(
      /repo-relative path/,
    );
  });

  it('rejects an edge whose source symbol is absent from the symbols list', () => {
    const raw = {
      schemaVersion: 1,
      generatedAt: FIXED_GENERATED_AT,
      repository: { repoId: REPO, gitHead: null },
      grammars: [],
      files: [snapshotFileEntry('src/lib.ts')],
      symbols: [],
      edges: [
        {
          kind: 'CALLS',
          sourceFilePath: 'src/lib.ts',
          sourceQualifiedName: 'src/lib.ts::run',
          targetQualifiedName: null,
          targetRef: null,
          line: 1,
          confidenceTier: 'RESOLVED',
          confidenceScore: 0.9,
          resolverId: null,
          evidence: {},
        },
      ],
    };
    expect(() => parseCodeGraphSnapshotEnvelope(raw)).toThrow(
      /source symbol not present/,
    );
  });

  it('rejects an edge whose target symbol is absent from the symbols list', () => {
    const raw = {
      schemaVersion: 1,
      generatedAt: FIXED_GENERATED_AT,
      repository: { repoId: REPO, gitHead: null },
      grammars: [],
      files: [snapshotFileEntry('src/lib.ts')],
      symbols: [snapshotSymbolEntry('src/lib.ts::run', 'src/lib.ts')],
      edges: [
        {
          kind: 'CALLS',
          sourceFilePath: 'src/lib.ts',
          sourceQualifiedName: 'src/lib.ts::run',
          targetQualifiedName: 'src/lib.ts::missing',
          targetRef: null,
          line: 1,
          confidenceTier: 'RESOLVED',
          confidenceScore: 0.9,
          resolverId: null,
          evidence: {},
        },
      ],
    };
    expect(() => parseCodeGraphSnapshotEnvelope(raw)).toThrow(
      /target symbol not present/,
    );
  });

  it('rejects duplicate files entries (same relativePath twice)', () => {
    const raw = {
      schemaVersion: 1,
      generatedAt: FIXED_GENERATED_AT,
      repository: { repoId: REPO, gitHead: null },
      grammars: [],
      files: [snapshotFileEntry('src/lib.ts'), snapshotFileEntry('src/lib.ts')],
      symbols: [],
      edges: [],
    };
    expect(() => parseCodeGraphSnapshotEnvelope(raw)).toThrow(
      /duplicate files entry/,
    );
  });

  it('rejects duplicate symbols entries (same qualifiedName twice)', () => {
    const raw = {
      schemaVersion: 1,
      generatedAt: FIXED_GENERATED_AT,
      repository: { repoId: REPO, gitHead: null },
      grammars: [],
      files: [snapshotFileEntry('src/lib.ts')],
      symbols: [
        snapshotSymbolEntry('src/lib.ts::helper', 'src/lib.ts'),
        snapshotSymbolEntry('src/lib.ts::helper', 'src/lib.ts'),
      ],
      edges: [],
    };
    expect(() => parseCodeGraphSnapshotEnvelope(raw)).toThrow(
      /duplicate symbols entry/,
    );
  });

  it('accepts a well-formed minimal envelope', () => {
    const raw = {
      schemaVersion: 1,
      generatedAt: FIXED_GENERATED_AT,
      repository: { repoId: REPO, gitHead: 'commit-a' },
      grammars: [{ package: 'tree-sitter-typescript', version: '0.23.2' }],
      files: [
        {
          relativePath: 'src/lib.ts',
          language: 'typescript',
          contentHash: 'h',
          sizeBytes: 10,
          mtimeNs: '1',
          lineCount: 1,
          grammarId: 'typescript',
          grammarAbi: 14,
          parseStatus: 'parsed',
          hasErrors: false,
        },
      ],
      symbols: [
        {
          qualifiedName: 'src/lib.ts',
          kind: 'file',
          signature: null,
          filePath: 'src/lib.ts',
        },
      ],
      edges: [],
    };
    const envelope: CodeGraphSnapshotEnvelope =
      parseCodeGraphSnapshotEnvelope(raw);
    expect(envelope.files).toHaveLength(1);
  });
});

describe('checkSnapshotGrammarCompatibility', () => {
  it('warns (does not throw) on an unknown package and a version mismatch, and stays clean for a match', async () => {
    const local = await readBundledGrammarManifest();
    expect(local.length).toBeGreaterThan(0);
    const matching = local[0];

    const warnings = await checkSnapshotGrammarCompatibility([
      matching,
      { ...matching, version: '0.0.0-does-not-exist' },
      { package: 'totally-unknown-package', version: '1.0.0' },
    ]);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('version mismatch');
    expect(warnings[1]).toContain('not present');
  });

  it('returns no warnings for an empty grammars list', async () => {
    expect(await checkSnapshotGrammarCompatibility([])).toEqual([]);
  });
});

describe('applyCodeGraphSnapshot (edge-id collision handling)', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  beforeEach(() => {
    ({ dir, db, store } = setupStore('code-graph-snapshot-collision-'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops the second of two distinct edges whose reconstructed ids collide, warns, and reports the honest count', async () => {
    // Two aliased references to the same resolved target on the same line:
    // distinct edges in the ORIGINAL graph (their original ids hashed the
    // differing raw targetRef text), but identical under the import module's
    // generic id formula (which hashes the RESOLVED target symbol id).
    const envelope = syntheticTwoFileEnvelope([
      collidingCallEdge('helper'),
      collidingCallEdge('helperAlias'),
    ]);

    const result = await applyCodeGraphSnapshot({
      store,
      db,
      repoId: REPO,
      rootPath: '/abs/root',
      envelope,
    });

    expect(result.edgesImported).toBe(1);
    expect(store.countEdges()).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(
      'Dropped duplicate reconstructed edge',
    );
    expect(result.warnings[0]).toContain('src/main.ts');
    expect(result.warnings[0]).toContain('helperAlias'); // names the DROPPED edge, not the kept one
  });

  it('does not warn or drop for non-colliding edges', async () => {
    const distinct = collidingCallEdge('helper');
    const differentLine: CodeGraphSnapshotEdge = {
      ...collidingCallEdge('helperAlias'),
      line: 7,
    };
    const envelope = syntheticTwoFileEnvelope([distinct, differentLine]);

    const result = await applyCodeGraphSnapshot({
      store,
      db,
      repoId: REPO,
      rootPath: '/abs/root',
      envelope,
    });

    expect(result.edgesImported).toBe(2);
    expect(store.countEdges()).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it('caps per-edge collision warnings and appends a "+N more" summary line', async () => {
    const droppedBeyondCap = 5;
    // 1 kept + (cap + droppedBeyondCap) dropped collisions.
    const edges = Array.from(
      { length: 1 + SNAPSHOT_IMPORT_MAX_COLLISION_WARNINGS + droppedBeyondCap },
      (_, index) => collidingCallEdge(`alias${index}`),
    );
    const envelope = syntheticTwoFileEnvelope(edges);

    const result = await applyCodeGraphSnapshot({
      store,
      db,
      repoId: REPO,
      rootPath: '/abs/root',
      envelope,
    });

    expect(result.edgesImported).toBe(1);
    expect(store.countEdges()).toBe(1);
    // Exactly cap-many per-edge warnings plus one trailing summary line.
    expect(result.warnings).toHaveLength(
      SNAPSHOT_IMPORT_MAX_COLLISION_WARNINGS + 1,
    );
    expect(result.warnings[result.warnings.length - 1]).toContain(
      `+${droppedBeyondCap} more`,
    );
  });
});

describe('applyCodeGraphSnapshot (derived-state clearing)', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  beforeEach(() => {
    ({ dir, db, store } = setupStore('code-graph-snapshot-derived-clear-'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Regression test for the whole-branch-review finding: symbol ids are pure
  // (repoId, qualifiedName) hashes, so a PRE-import community/flow membership
  // row keeps joining fine against POST-import symbols that happen to share
  // the same qualifiedName -- silently describing the wrong (pre-import)
  // partition with no `derived: none` note anywhere. Importing must clear
  // `repoId`'s derived tables so those surfaces go honestly empty instead.
  it('clears stale derived rows and build-completion markers when importing over an existing graph', async () => {
    seedTwoFileGraph(store, REPO, '/abs/root', 'commit-a');
    const helperId = symbolRowId(
      REPO,
      symbolQualifiedName('src/lib.ts', [], 'helper'),
    );
    store.replaceDerivedForRepo(
      REPO,
      [
        {
          id: 'com-1',
          repositoryId: REPO,
          label: 'src',
          cohesion: 0.9,
          size: 1,
          fingerprint: 'fp-1',
          extra: {},
        },
      ],
      [{ communityId: 'com-1', symbolId: helperId }],
      [
        {
          id: 'flow-1',
          repositoryId: REPO,
          entrySymbolId: helperId,
          name: 'flow 1',
          criticality: 0.5,
          symbolCount: 1,
          fileSpread: 1,
          maxDepth: 0,
          extra: {},
        },
      ],
      [{ flowId: 'flow-1', symbolId: helperId, depth: 0 }],
    );
    expect(store.getDerivedStats(REPO)).toEqual({
      communityCount: 1,
      flowCount: 1,
    });
    setMetadataValue(db, 'graph_diagnostics', '{"freshness":"content"}');
    setMetadataValue(db, 'last_build_at', '123456789');
    setMetadataValue(db, 'completed_build_at', '123456789');
    setMetadataValue(db, 'derived_at', '123456789');
    expect(getMetadataValue(db, 'derived_at')).toBe('123456789');

    // The imported envelope reconstructs the SAME symbol ids (pure hashes of
    // repoId + qualifiedName) as the pre-import graph above, which is
    // exactly the scenario that let stale derived rows keep joining fine.
    const envelope = syntheticTwoFileEnvelope([]);
    const result = await applyCodeGraphSnapshot({
      store,
      db,
      repoId: REPO,
      rootPath: '/abs/new-root',
      envelope,
    });

    expect(result.filesImported).toBe(2);
    expect(store.getDerivedStats(REPO)).toEqual({
      communityCount: 0,
      flowCount: 0,
    });
    expect(store.listCommunities(REPO)).toEqual([]);
    expect(store.listFlows(REPO)).toEqual([]);
    expect(store.listCommunityMemberships(REPO)).toEqual([]);
    expect(getMetadataValue(db, 'derived_at')).toBeNull();
    expect(getMetadataValue(db, 'graph_diagnostics')).toBeNull();
    // Intentional current red: snapshot import invalidates derived freshness,
    // but currently leaves the prior build's completion markers behind. An
    // imported snapshot is not a completed local graph build.
    expect(getMetadataValue(db, 'last_build_at')).toBeNull();
    expect(getMetadataValue(db, 'completed_build_at')).toBeNull();
  });
});

describe('export -> import -> export round trip', () => {
  it('reproduces byte-identical files/symbols/edges/grammars, differing only in repository.gitHead', async () => {
    const source = setupStore('code-graph-snapshot-roundtrip-src-');
    const destination = setupStore('code-graph-snapshot-roundtrip-dst-');
    try {
      seedTwoFileGraph(source.store, REPO, '/abs/source-root', 'commit-a');
      // Distinct source offsets preserve two calls on the same line.
      const call = source.store.listEdges({ repoId: REPO, kind: 'CALLS' })[0];
      if (call === undefined) throw new Error('missing fixture call');
      source.store.updateEdgeEvidence(call.id, {
        ...call.evidence,
        offset: 10,
      });
      source.store.insertEdges([
        {
          ...call,
          id: `${call.id}-second`,
          evidence: { ...call.evidence, offset: 20 },
        },
      ]);

      const first = await buildCodeGraphSnapshot({
        store: source.store,
        repoId: REPO,
        generatedAt: FIXED_GENERATED_AT,
      });

      const importResult = await applyCodeGraphSnapshot({
        store: destination.store,
        db: destination.db,
        repoId: REPO,
        rootPath: '/abs/destination-root',
        envelope: parseCodeGraphSnapshotEnvelope(JSON.parse(first.json)),
      });
      expect(importResult.warnings).toEqual([]);
      expect(importResult.filesImported).toBe(2);
      expect(importResult.symbolsImported).toBe(first.envelope.symbols.length);
      expect(importResult.edgesImported).toBe(first.envelope.edges.length);
      // The imported facts are queryable, but import itself is not a build
      // and must not invent either completion timestamp on a fresh database.
      expect(getMetadataValue(destination.db, 'last_build_at')).toBeNull();
      expect(getMetadataValue(destination.db, 'completed_build_at')).toBeNull();
      // The reported counts must reflect actually-persisted rows, not the
      // envelope's array lengths (a real export can't produce collisions, so
      // these agree here — the collision describe below covers divergence).
      expect(destination.store.countEdges()).toBe(importResult.edgesImported);
      expect(destination.store.countSymbols()).toBe(
        importResult.symbolsImported,
      );

      // Simulate a later real build touching this repo's row on a checkout
      // that has since moved to a different commit — gitHead is the ONE
      // field the round-trip contract allows to diverge.
      destination.store.upsertRepository({
        repoId: REPO,
        rootPath: '/abs/destination-root',
        gitHead: 'commit-b',
      });

      const third = await buildCodeGraphSnapshot({
        store: destination.store,
        repoId: REPO,
        generatedAt: FIXED_GENERATED_AT,
      });

      expect(first.envelope.repository.gitHead).toBe('commit-a');
      expect(third.envelope.repository.gitHead).toBe('commit-b');

      const normalize = (
        envelope: CodeGraphSnapshotEnvelope,
      ): CodeGraphSnapshotEnvelope => ({
        ...envelope,
        repository: { ...envelope.repository, gitHead: null },
      });
      expect(normalize(third.envelope)).toEqual(normalize(first.envelope));
    } finally {
      source.db.close();
      destination.db.close();
      rmSync(source.dir, { recursive: true, force: true });
      rmSync(destination.dir, { recursive: true, force: true });
    }
  });

  it('sets imported_from_snapshot metadata and reconstructs absolutePath from the target rootPath', async () => {
    const source = setupStore('code-graph-snapshot-roundtrip-meta-src-');
    const destination = setupStore('code-graph-snapshot-roundtrip-meta-dst-');
    try {
      seedTwoFileGraph(source.store, REPO, '/abs/source-root', 'commit-a');
      const { json } = await buildCodeGraphSnapshot({
        store: source.store,
        repoId: REPO,
        generatedAt: FIXED_GENERATED_AT,
      });

      await applyCodeGraphSnapshot({
        store: destination.store,
        db: destination.db,
        repoId: REPO,
        rootPath: '/abs/destination-root',
        envelope: parseCodeGraphSnapshotEnvelope(JSON.parse(json)),
      });

      expect(isSymbolFtsMappingTrusted(destination.db)).toBe(true);
      const imported = destination.store.getFileByPath(REPO, 'src/lib.ts');
      expect(imported?.absolutePath).toBe(
        path.join('/abs/destination-root', 'src/lib.ts'),
      );

      const repos = destination.store.listRepositories();
      expect(repos).toEqual([
        {
          repoId: REPO,
          rootPath: '/abs/destination-root',
          gitHead: 'commit-a',
        },
      ]);
    } finally {
      source.db.close();
      destination.db.close();
      rmSync(source.dir, { recursive: true, force: true });
      rmSync(destination.dir, { recursive: true, force: true });
    }
  });
});

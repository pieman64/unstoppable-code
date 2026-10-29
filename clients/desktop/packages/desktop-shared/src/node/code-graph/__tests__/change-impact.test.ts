import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import { CodeGraphQueryService } from '../query/queries';
import { CodeGraphEngine } from '../engine';
import {
  edgeRowId,
  fileQualifiedName,
  fileRowId,
  symbolQualifiedName,
  symbolRowId,
} from '../ids';
import type {
  CodeGraphCommunityMembershipRecord,
  CodeGraphCommunityRecord,
  CodeGraphEdgeRecord,
  CodeGraphFileFacts,
  CodeGraphFlowMembershipRecord,
  CodeGraphFlowRecord,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import {
  mapRangesToSymbols,
  type ChangedSymbol,
} from '../impact/changed-symbols';
import type { BeforeGraphResult } from '../impact/before-graph';
import {
  CHANGE_IMPACT_MAX_SEEDS,
  assembleChangeImpact,
  changeRiskLevelForScore,
  computeChangeImpactRadius,
  computeImpactedTests,
  computeSymbolDelta,
  createTestsForCache,
  findTestGaps,
  impactSeedQualifiedNames,
  scoreChangeRisk,
  type SymbolDelta,
} from '../impact/change-impact';

const REPO = 'repo-a';

// --- Shared fixture helpers (mirrors the pattern used by queries.test.ts /
// changed-symbols.test.ts: hand-built store facts wired through
// replaceFileFacts so lookups go through the real store/graph-store code
// path rather than mocks). ---

function fileSymbol(
  relativePath: string,
  isTest = false,
): CodeGraphSymbolRecord {
  return {
    id: symbolRowId(REPO, fileQualifiedName(relativePath)),
    repositoryId: REPO,
    fileId: fileRowId(REPO, relativePath),
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
    isTest,
    extra: {},
  };
}

function fnSymbol(
  relativePath: string,
  name: string,
  options: {
    isTest?: boolean;
    kind?: CodeGraphSymbolRecord['kind'];
    signature?: string;
  } = {},
): CodeGraphSymbolRecord {
  return {
    ...fileSymbol(relativePath, options.isTest ?? false),
    id: symbolRowId(REPO, symbolQualifiedName(relativePath, [], name)),
    kind: options.kind ?? 'function',
    name,
    qualifiedName: symbolQualifiedName(relativePath, [], name),
    lineStart: 2,
    lineEnd: 4,
    byteStart: 10,
    byteEnd: 50,
    signature: options.signature ?? `function ${name}()`,
  };
}

function facts(
  relativePath: string,
  symbols: CodeGraphSymbolRecord[],
  edges: CodeGraphEdgeRecord[] = [],
): CodeGraphFileFacts {
  return {
    file: {
      id: fileRowId(REPO, relativePath),
      repositoryId: REPO,
      relativePath,
      absolutePath: `/abs/${relativePath}`,
      language: 'typescript',
      contentHash: 'h',
      sizeBytes: 100,
      mtimeNs: '1',
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
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId: REPO,
      kind: 'CALLS',
      sourceId,
      target: target.name,
      line,
    }),
    repositoryId: REPO,
    kind: 'CALLS',
    sourceSymbolId: sourceId,
    targetSymbolId: target.id,
    sourceFileId: fileRowId(REPO, relativePath),
    targetRef: target.name,
    line,
    confidenceTier: 'RESOLVED',
    confidenceScore: 0.9,
    resolverId: 'import-binding',
    evidence: {},
  };
}

function testedByEdge(
  target: CodeGraphSymbolRecord,
  testFile: CodeGraphSymbolRecord,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId: REPO,
      kind: 'TESTED_BY',
      sourceId: target.id,
      target: testFile.id,
      line: null,
    }),
    repositoryId: REPO,
    kind: 'TESTED_BY',
    sourceSymbolId: target.id,
    targetSymbolId: testFile.id,
    sourceFileId: testFile.fileId,
    targetRef: null,
    line: null,
    confidenceTier: 'INFERRED',
    confidenceScore: 0.8,
    resolverId: 'test-linker',
    evidence: {},
  };
}

// --- Derived-analysis fixture helpers (Phase 6 Task 7 risk terms) ---------
// Mirrors derived-store.test.ts's hand-built-fixture pattern: real rows
// written through `store.replaceDerivedForRepo`, not mocks.

function community(
  id: string,
  size: number,
  cohesion = 0.5,
): CodeGraphCommunityRecord {
  return {
    id,
    repositoryId: REPO,
    label: id,
    cohesion,
    size,
    fingerprint: `fp-${id}`,
    extra: {},
  };
}

function membership(
  communityId: string,
  symbolId: string,
): CodeGraphCommunityMembershipRecord {
  return { communityId, symbolId };
}

function flow(
  id: string,
  entrySymbolId: string,
  criticality: number,
): CodeGraphFlowRecord {
  return {
    id,
    repositoryId: REPO,
    entrySymbolId,
    name: `flow ${id}`,
    criticality,
    symbolCount: 1,
    fileSpread: 1,
    maxDepth: 1,
    extra: {},
  };
}

function flowMembership(
  flowId: string,
  symbolId: string,
  depth = 0,
): CodeGraphFlowMembershipRecord {
  return { flowId, symbolId, depth };
}

function toChangedSymbol(
  record: CodeGraphSymbolRecord,
  filePath: string,
  changeKind: ChangedSymbol['changeKind'] = 'modified',
): ChangedSymbol {
  return {
    qualifiedName: record.qualifiedName,
    kind: record.kind,
    filePath,
    lineStart: record.lineStart,
    lineEnd: record.lineEnd,
    changeKind,
  };
}

function emptyDelta(): SymbolDelta {
  return { added: [], removed: [], signatureChanged: [] };
}

// A minimal store+queries pair against a fresh temp sqlite db, reused by
// every describe block below that needs hand-built fixtures rather than a
// real git+engine pipeline.
function setupStore(prefix: string): {
  dir: string;
  db: CodeGraphDatabase;
  store: CodeGraphStore;
  queries: CodeGraphQueryService;
} {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
  runCodeGraphMigrations(db);
  const store = new CodeGraphStore(db);
  store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });
  const queries = new CodeGraphQueryService(db);
  return { dir, db, store, queries };
}

describe('computeSymbolDelta', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  beforeEach(() => {
    ({ dir, db, store } = setupStore('code-graph-change-impact-delta-'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('classifies a changed symbol with no before-graph entry as added', () => {
    const file = fileSymbol('src/lib.ts');
    const brandNew = fnSymbol('src/lib.ts', 'brandNew');
    store.replaceFileFacts(facts('src/lib.ts', [file, brandNew]));

    const before: BeforeGraphResult = {
      symbols: new Map(),
      filesBuilt: 0,
      filesSkipped: 0,
    };
    const changed: ChangedSymbol[] = [toChangedSymbol(brandNew, 'src/lib.ts')];

    const delta = computeSymbolDelta({ changed, before, store, repoId: REPO });

    expect(delta.added).toEqual(changed);
    expect(delta.removed).toEqual([]);
    expect(delta.signatureChanged).toEqual([]);
  });

  it('classifies a before-graph entry absent from the current graph as removed', () => {
    const before: BeforeGraphResult = {
      symbols: new Map([
        [
          'src/gone.ts::goneFn',
          {
            qualifiedName: 'src/gone.ts::goneFn',
            kind: 'function',
            signature: 'function goneFn()',
            filePath: 'src/gone.ts',
          },
        ],
      ]),
      filesBuilt: 1,
      filesSkipped: 0,
    };

    const delta = computeSymbolDelta({
      changed: [],
      before,
      store,
      repoId: REPO,
    });

    expect(delta.removed).toEqual([
      {
        qualifiedName: 'src/gone.ts::goneFn',
        kind: 'function',
        filePath: 'src/gone.ts',
      },
    ]);
    expect(delta.added).toEqual([]);
    expect(delta.signatureChanged).toEqual([]);
  });

  it('classifies a symbol present on both sides with a differing signature as signatureChanged', () => {
    const file = fileSymbol('src/lib.ts');
    const alpha = fnSymbol('src/lib.ts', 'alpha', {
      signature: 'function alpha(a: string, b: number)',
    });
    store.replaceFileFacts(facts('src/lib.ts', [file, alpha]));

    const before: BeforeGraphResult = {
      symbols: new Map([
        [
          alpha.qualifiedName,
          {
            qualifiedName: alpha.qualifiedName,
            kind: 'function',
            signature: 'function alpha(a: string)',
            filePath: 'src/lib.ts',
          },
        ],
      ]),
      filesBuilt: 1,
      filesSkipped: 0,
    };
    const changed: ChangedSymbol[] = [toChangedSymbol(alpha, 'src/lib.ts')];

    const delta = computeSymbolDelta({ changed, before, store, repoId: REPO });

    expect(delta.signatureChanged).toEqual([
      {
        qualifiedName: alpha.qualifiedName,
        before: 'function alpha(a: string)',
        after: 'function alpha(a: string, b: number)',
      },
    ]);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
  });

  it('does not classify a symbol with an identical signature on both sides', () => {
    const file = fileSymbol('src/lib.ts');
    const stable = fnSymbol('src/lib.ts', 'stable', {
      signature: 'function stable()',
    });
    store.replaceFileFacts(facts('src/lib.ts', [file, stable]));

    const before: BeforeGraphResult = {
      symbols: new Map([
        [
          stable.qualifiedName,
          {
            qualifiedName: stable.qualifiedName,
            kind: 'function',
            signature: 'function stable()',
            filePath: 'src/lib.ts',
          },
        ],
      ]),
      filesBuilt: 1,
      filesSkipped: 0,
    };
    const changed: ChangedSymbol[] = [toChangedSymbol(stable, 'src/lib.ts')];

    const delta = computeSymbolDelta({ changed, before, store, repoId: REPO });

    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.signatureChanged).toEqual([]);
  });

  it('does not infer a rename: shows as removed (old name) and added (new name), never linked', () => {
    const file = fileSymbol('src/lib.ts');
    const renamedFn = fnSymbol('src/lib.ts', 'newName');
    store.replaceFileFacts(facts('src/lib.ts', [file, renamedFn]));

    const before: BeforeGraphResult = {
      symbols: new Map([
        [
          'src/lib.ts::oldName',
          {
            qualifiedName: 'src/lib.ts::oldName',
            kind: 'function',
            signature: 'function oldName()',
            filePath: 'src/lib.ts',
          },
        ],
      ]),
      filesBuilt: 1,
      filesSkipped: 0,
    };
    const changed: ChangedSymbol[] = [toChangedSymbol(renamedFn, 'src/lib.ts')];

    const delta = computeSymbolDelta({ changed, before, store, repoId: REPO });

    expect(delta.added.map((s) => s.qualifiedName)).toEqual([
      'src/lib.ts::newName',
    ]);
    expect(delta.removed.map((s) => s.qualifiedName)).toEqual([
      'src/lib.ts::oldName',
    ]);
    expect(delta.signatureChanged).toEqual([]);
  });
});

describe('scoreChangeRisk', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let queries: CodeGraphQueryService;

  beforeEach(() => {
    ({ dir, db, store, queries } = setupStore(
      'code-graph-change-impact-risk-',
    ));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('scores an untested function +0.30 and levels it low', () => {
    const file = fileSymbol('src/lib.ts');
    const plain = fnSymbol('src/lib.ts', 'plainFn');
    store.replaceFileFacts(facts('src/lib.ts', [file, plain]));

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(plain, 'src/lib.ts')],
      queries,
    });

    expect(risk.score).toBeCloseTo(0.3, 5);
    expect(risk.level).toBe('low');
    expect(risk.reasons).toHaveLength(1);
    expect(risk.reasons[0]).toContain('src/lib.ts::plainFn');
    expect(risk.reasons[0]).toContain('untested');
  });

  it('scores a tested function +0.05 instead of +0.30', () => {
    const file = fileSymbol('src/lib.ts');
    const plain = fnSymbol('src/lib.ts', 'plainFn');
    const testFile = fileSymbol('src/__tests__/lib.test.ts', true);
    store.replaceFileFacts(facts('src/lib.ts', [file, plain]));
    store.replaceFileFacts(
      facts(
        'src/__tests__/lib.test.ts',
        [testFile],
        [testedByEdge(plain, testFile)],
      ),
    );

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(plain, 'src/lib.ts')],
      queries,
    });

    expect(risk.score).toBeCloseTo(0.05, 5);
    expect(risk.level).toBe('low');
  });

  it('adds +0.20 for a security-sensitive qualified name match', () => {
    const file = fileSymbol('src/authTool.ts');
    const check = fnSymbol('src/authTool.ts', 'checkAuthToken');
    store.replaceFileFacts(facts('src/authTool.ts', [file, check]));

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(check, 'src/authTool.ts')],
      queries,
    });

    // untested (0.30) + security keyword (0.20) = 0.50
    expect(risk.score).toBeCloseTo(0.5, 5);
    expect(risk.level).toBe('medium');
  });

  it('adds fan-in that scales with caller count, up to the 0.10 cap', () => {
    const file = fileSymbol('src/lib.ts');
    const target = fnSymbol('src/lib.ts', 'target');
    const callerFile = fileSymbol('src/caller.ts');
    const callerFn = fnSymbol('src/caller.ts', 'callerFn');
    store.replaceFileFacts(facts('src/lib.ts', [file, target]));
    store.replaceFileFacts(
      facts(
        'src/caller.ts',
        [callerFile, callerFn],
        [resolvedCallEdge('src/caller.ts', callerFn.id, target, 3)],
      ),
    );

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(target, 'src/lib.ts')],
      queries,
    });

    // untested (0.30) + fan-in 1 caller (0.05) = 0.35
    expect(risk.score).toBeCloseTo(0.35, 5);
  });

  it('caps fan-in at 0.10 even with many more than 2 callers', () => {
    const file = fileSymbol('src/lib.ts');
    const target = fnSymbol('src/lib.ts', 'target');
    store.replaceFileFacts(facts('src/lib.ts', [file, target]));

    for (let i = 0; i < 5; i += 1) {
      const callerFile = fileSymbol(`src/caller${i}.ts`);
      const callerFn = fnSymbol(`src/caller${i}.ts`, `callerFn${i}`);
      store.replaceFileFacts(
        facts(
          `src/caller${i}.ts`,
          [callerFile, callerFn],
          [resolvedCallEdge(`src/caller${i}.ts`, callerFn.id, target, 3)],
        ),
      );
    }

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(target, 'src/lib.ts')],
      queries,
    });

    // untested (0.30) + fan-in capped at 0.10 (5 callers would be 0.25 uncapped) = 0.40
    expect(risk.score).toBeCloseTo(0.4, 5);
    expect(risk.level).toBe('medium');
  });

  it('discriminates: a security-named, untested, high-fan-in symbol scores strictly higher than a plain tested one', () => {
    const secFile = fileSymbol('src/authTool.ts');
    const secFn = fnSymbol('src/authTool.ts', 'checkAuthToken');
    const caller1File = fileSymbol('src/caller1.ts');
    const caller1Fn = fnSymbol('src/caller1.ts', 'callerOne');
    const caller2File = fileSymbol('src/caller2.ts');
    const caller2Fn = fnSymbol('src/caller2.ts', 'callerTwo');
    store.replaceFileFacts(facts('src/authTool.ts', [secFile, secFn]));
    store.replaceFileFacts(
      facts(
        'src/caller1.ts',
        [caller1File, caller1Fn],
        [resolvedCallEdge('src/caller1.ts', caller1Fn.id, secFn, 3)],
      ),
    );
    store.replaceFileFacts(
      facts(
        'src/caller2.ts',
        [caller2File, caller2Fn],
        [resolvedCallEdge('src/caller2.ts', caller2Fn.id, secFn, 3)],
      ),
    );

    const plainFile = fileSymbol('src/lib.ts');
    const plainFn = fnSymbol('src/lib.ts', 'plainFn');
    const testFile = fileSymbol('src/__tests__/lib.test.ts', true);
    store.replaceFileFacts(facts('src/lib.ts', [plainFile, plainFn]));
    store.replaceFileFacts(
      facts(
        'src/__tests__/lib.test.ts',
        [testFile],
        [testedByEdge(plainFn, testFile)],
      ),
    );

    const riskForSecurity = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(secFn, 'src/authTool.ts')],
      queries,
    });
    const riskForPlain = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(plainFn, 'src/lib.ts')],
      queries,
    });

    expect(riskForSecurity.score).toBeGreaterThan(riskForPlain.score);
    // untested (0.30) + security (0.20) + fan-in capped (0.10) = 0.60
    expect(riskForSecurity.score).toBeCloseTo(0.6, 5);
    expect(riskForSecurity.level).toBe('medium');
    expect(riskForPlain.score).toBeCloseTo(0.05, 5);
    expect(riskForPlain.level).toBe('low');
  }, 15_000);

  it('excludes the coverage component for a symbol that is itself a test', () => {
    const testFile = fileSymbol('src/__tests__/lib.test.ts', true);
    const testFn = fnSymbol('src/__tests__/lib.test.ts', 'runsSomething', {
      isTest: true,
    });
    store.replaceFileFacts(
      facts('src/__tests__/lib.test.ts', [testFile, testFn]),
    );

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(testFn, 'src/__tests__/lib.test.ts')],
      queries,
    });

    expect(risk.score).toBe(0);
    expect(risk.level).toBe('low');
    expect(risk.reasons).toEqual([]);
  });

  it('does not apply the coverage component to non function/method/class kinds', () => {
    const file = fileSymbol('src/config.ts');
    const variable: CodeGraphSymbolRecord = {
      ...fnSymbol('src/config.ts', 'CONFIG'),
      kind: 'variable',
    };
    store.replaceFileFacts(facts('src/config.ts', [file, variable]));

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(variable, 'src/config.ts')],
      queries,
    });

    expect(risk.score).toBe(0);
  });

  it('scores a removed symbol using only the security-keyword component', () => {
    const delta: SymbolDelta = {
      added: [],
      removed: [
        {
          qualifiedName: 'src/authTool.ts::checkAuthToken',
          kind: 'function',
          filePath: 'src/authTool.ts',
        },
      ],
      signatureChanged: [],
    };

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta,
      changed: [],
      queries,
    });

    expect(risk.score).toBeCloseTo(0.2, 5);
    expect(risk.reasons[0]).toContain('src/authTool.ts::checkAuthToken');
  });

  it('does not score a plain removed symbol at all (no security keyword)', () => {
    const delta: SymbolDelta = {
      added: [],
      removed: [
        {
          qualifiedName: 'src/lib.ts::goneFn',
          kind: 'function',
          filePath: 'src/lib.ts',
        },
      ],
      signatureChanged: [],
    };

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta,
      changed: [],
      queries,
    });

    expect(risk.score).toBe(0);
    expect(risk.reasons).toEqual([]);
  });

  it('bounds reasons to 10 entries, sorted by score then qualifiedName (tie-break)', () => {
    const changed: ChangedSymbol[] = [];
    for (let i = 0; i < 12; i += 1) {
      const label = String(i).padStart(2, '0');
      const relativePath = 'src/lib.ts';
      const name = `fn${label}`;
      const file = fileSymbol(relativePath);
      const fn = fnSymbol(relativePath, name);
      store.replaceFileFacts(facts(`${relativePath}#${label}`, [file, fn]));
      changed.push(toChangedSymbol(fn, relativePath));
    }

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed,
      queries,
    });

    expect(risk.reasons).toHaveLength(10);
    expect(risk.reasons[0]).toContain('src/lib.ts::fn00');
    expect(risk.reasons[9]).toContain('src/lib.ts::fn09');
  }, 15_000);

  it('names all five components in `formula` and states the 1.00 ceiling is reachable, with no derived data computed for this repo', () => {
    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [],
      queries,
    });

    const formula = risk.formula.toLowerCase();
    expect(formula).toContain('untested');
    expect(formula).toContain('security');
    expect(risk.formula).toContain('fan-in');
    expect(formula).toContain('flowparticipation');
    expect(formula).toContain('communitycrossing');
    // The formula string is agent/CLI-visible: it must state concretely that
    // the full 5-component ceiling (1.00 per symbol) makes high (>=0.70) and
    // critical (>=0.85) reachable — no more "cannot fire yet" caveat.
    expect(formula).toContain('1.00');
    expect(formula).toContain('high');
    expect(formula).toContain('critical');
    expect(formula).toContain('reachable');
    expect(formula).not.toContain('cannot fire');
    // This describe block's `store`/`queries` never seed derived data (no
    // `replaceDerivedForRepo` call), so the honest absent-derived note must
    // be appended.
    expect(risk.formula).toContain(
      'derived analyses not computed — flow/community terms inactive',
    );
  }, 15_000);

  it('returns score 0 and level low for an empty delta/changed set', () => {
    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [],
      queries,
    });

    expect(risk.score).toBe(0);
    expect(risk.level).toBe('low');
    expect(risk.reasons).toEqual([]);
  });

  it('contributes 0 for flow-participation/community-crossing when derived tables are empty/absent for the repo, even for a symbol with callers', () => {
    // Same fixture shape as the fan-in test above (an untested symbol with a
    // caller), but with NO `replaceDerivedForRepo` call at all — proving the
    // two new terms stay inert (not just "queried and happened to find
    // nothing") when derived analysis was never computed for this repo.
    const file = fileSymbol('src/lib.ts');
    const target = fnSymbol('src/lib.ts', 'target');
    const callerFile = fileSymbol('src/caller.ts');
    const callerFn = fnSymbol('src/caller.ts', 'callerFn');
    store.replaceFileFacts(facts('src/lib.ts', [file, target]));
    store.replaceFileFacts(
      facts(
        'src/caller.ts',
        [callerFile, callerFn],
        [resolvedCallEdge('src/caller.ts', callerFn.id, target, 3)],
      ),
    );

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(target, 'src/lib.ts')],
      queries,
    });

    // untested (0.30) + fan-in 1 caller (0.05) = 0.35 -- identical to the
    // no-derived-analysis-terms case above, confirming the two new
    // components contributed exactly 0.
    expect(risk.score).toBeCloseTo(0.35, 5);
    expect(risk.reasons[0]).not.toContain('flow');
    expect(risk.reasons[0]).not.toContain('cross-community');
    expect(risk.formula).toContain(
      'derived analyses not computed — flow/community terms inactive',
    );
  });
});

describe('scoreChangeRisk with derived analyses computed (flow-participation + community-crossing)', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let queries: CodeGraphQueryService;

  beforeEach(() => {
    ({ dir, db, store, queries } = setupStore(
      'code-graph-change-impact-derived-risk-',
    ));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds flow-participation as the sum of criticality across every flow containing the symbol, capped at 0.25', () => {
    const file = fileSymbol('src/lib.ts');
    const target = fnSymbol('src/lib.ts', 'target');
    store.replaceFileFacts(facts('src/lib.ts', [file, target]));
    // Seed communities too (a single one containing just `target`) so
    // `derivedComputed` is true and the community-crossing term is
    // attempted -- it stays 0 here since there are no callers at all.
    store.replaceDerivedForRepo(
      REPO,
      [community('com-1', 1)],
      [membership('com-1', target.id)],
      [flow('flow-1', target.id, 0.12), flow('flow-2', target.id, 0.1)],
      [
        flowMembership('flow-1', target.id),
        flowMembership('flow-2', target.id),
      ],
    );

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(target, 'src/lib.ts')],
      queries,
    });

    // untested (0.30) + flowParticipation: sum(0.12, 0.10) = 0.22, under the
    // 0.25 cap, so uncapped = 0.30 + 0.22 = 0.52.
    expect(risk.score).toBeCloseTo(0.52, 5);
    expect(risk.level).toBe('medium');
    expect(risk.reasons[0]).toContain('in 2 flows (+0.22)');
    expect(risk.formula).not.toContain('derived analyses not computed');
  });

  it('caps flow-participation at 0.25 even when summed criticality exceeds it', () => {
    const file = fileSymbol('src/lib.ts');
    const target = fnSymbol('src/lib.ts', 'target');
    store.replaceFileFacts(facts('src/lib.ts', [file, target]));
    store.replaceDerivedForRepo(
      REPO,
      [],
      [],
      [
        flow('flow-1', target.id, 0.2),
        flow('flow-2', target.id, 0.2),
        flow('flow-3', target.id, 0.2),
      ],
      [
        flowMembership('flow-1', target.id),
        flowMembership('flow-2', target.id),
        flowMembership('flow-3', target.id),
      ],
    );

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(target, 'src/lib.ts')],
      queries,
    });

    // untested (0.30) + flowParticipation capped at 0.25 (raw sum 0.60) = 0.55.
    expect(risk.score).toBeCloseTo(0.55, 5);
    expect(risk.reasons[0]).toContain('in 3 flows (+0.25)');
  });

  it('adds 0.05 per cross-community caller for community-crossing, uncapped below the 0.15 ceiling', () => {
    const file = fileSymbol('src/lib.ts');
    const target = fnSymbol('src/lib.ts', 'target');
    const caller1File = fileSymbol('src/caller1.ts');
    const caller1Fn = fnSymbol('src/caller1.ts', 'callerOne');
    const caller2File = fileSymbol('src/caller2.ts');
    const caller2Fn = fnSymbol('src/caller2.ts', 'callerTwo');
    store.replaceFileFacts(facts('src/lib.ts', [file, target]));
    store.replaceFileFacts(
      facts(
        'src/caller1.ts',
        [caller1File, caller1Fn],
        [resolvedCallEdge('src/caller1.ts', caller1Fn.id, target, 3)],
      ),
    );
    store.replaceFileFacts(
      facts(
        'src/caller2.ts',
        [caller2File, caller2Fn],
        [resolvedCallEdge('src/caller2.ts', caller2Fn.id, target, 3)],
      ),
    );
    // `target` in its own community; BOTH callers in a different one, so
    // `countCrossCommunityCallers(target)` reports 2.
    store.replaceDerivedForRepo(
      REPO,
      [community('com-target', 1), community('com-callers', 2)],
      [
        membership('com-target', target.id),
        membership('com-callers', caller1Fn.id),
        membership('com-callers', caller2Fn.id),
      ],
      [],
      [],
    );

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(target, 'src/lib.ts')],
      queries,
    });

    // untested (0.30) + fan-in 2 callers (0.10, capped) + communityCrossing
    // 2 * 0.05 = 0.10 = 0.30 + 0.10 + 0.10 = 0.50.
    expect(risk.score).toBeCloseTo(0.5, 5);
    expect(risk.reasons[0]).toContain('2 cross-community callers (+0.10)');
  });

  it('caps community-crossing at 0.15 even with more than 3 cross-community callers', () => {
    const file = fileSymbol('src/lib.ts');
    const target = fnSymbol('src/lib.ts', 'target');
    store.replaceFileFacts(facts('src/lib.ts', [file, target]));
    const callerIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const callerFile = fileSymbol(`src/caller${i}.ts`);
      const callerFn = fnSymbol(`src/caller${i}.ts`, `caller${i}`);
      store.replaceFileFacts(
        facts(
          `src/caller${i}.ts`,
          [callerFile, callerFn],
          [resolvedCallEdge(`src/caller${i}.ts`, callerFn.id, target, 3)],
        ),
      );
      callerIds.push(callerFn.id);
    }
    store.replaceDerivedForRepo(
      REPO,
      [community('com-target', 1), community('com-callers', 5)],
      [
        membership('com-target', target.id),
        ...callerIds.map((id) => membership('com-callers', id)),
      ],
      [],
      [],
    );

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(target, 'src/lib.ts')],
      queries,
    });

    // untested (0.30) + fan-in capped (0.10) + communityCrossing capped
    // (0.15, raw 5 * 0.05 = 0.25) = 0.55.
    expect(risk.score).toBeCloseTo(0.55, 5);
    expect(risk.reasons[0]).toContain('5 cross-community callers (+0.15)');
  });

  it('does not apply community-crossing when all callers share the symbol’s own community', () => {
    const file = fileSymbol('src/lib.ts');
    const target = fnSymbol('src/lib.ts', 'target');
    const callerFile = fileSymbol('src/caller.ts');
    const callerFn = fnSymbol('src/caller.ts', 'callerFn');
    store.replaceFileFacts(facts('src/lib.ts', [file, target]));
    store.replaceFileFacts(
      facts(
        'src/caller.ts',
        [callerFile, callerFn],
        [resolvedCallEdge('src/caller.ts', callerFn.id, target, 3)],
      ),
    );
    store.replaceDerivedForRepo(
      REPO,
      [community('com-1', 2)],
      [membership('com-1', target.id), membership('com-1', callerFn.id)],
      [],
      [],
    );

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(target, 'src/lib.ts')],
      queries,
    });

    // untested (0.30) + fan-in 1 caller (0.05) = 0.35; no cross-community
    // callers since the sole caller shares `target`'s own community.
    expect(risk.score).toBeCloseTo(0.35, 5);
    expect(risk.reasons[0]).not.toContain('cross-community');
  });

  it('uses singular grammar for a single flow and a single cross-community caller', () => {
    const file = fileSymbol('src/lib.ts');
    const target = fnSymbol('src/lib.ts', 'target');
    const callerFile = fileSymbol('src/caller.ts');
    const callerFn = fnSymbol('src/caller.ts', 'callerFn');
    store.replaceFileFacts(facts('src/lib.ts', [file, target]));
    store.replaceFileFacts(
      facts(
        'src/caller.ts',
        [callerFile, callerFn],
        [resolvedCallEdge('src/caller.ts', callerFn.id, target, 3)],
      ),
    );
    store.replaceDerivedForRepo(
      REPO,
      [community('com-target', 1), community('com-caller', 1)],
      [
        membership('com-target', target.id),
        membership('com-caller', callerFn.id),
      ],
      [flow('flow-1', target.id, 0.12)],
      [flowMembership('flow-1', target.id)],
    );

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(target, 'src/lib.ts')],
      queries,
    });

    // untested (0.30) + fan-in 1 caller (0.05) + flowParticipation 0.12 +
    // communityCrossing 1 * 0.05 = 0.52.
    expect(risk.score).toBeCloseTo(0.52, 5);
    expect(risk.reasons[0]).toContain('in 1 flow (+0.12)');
    expect(risk.reasons[0]).toContain('1 cross-community caller (+0.05)');
  });

  it('reaches a "high" level (>=0.70) once flow-participation and community-crossing stack on top of the Phase 4 components', () => {
    const file = fileSymbol('src/lib.ts');
    const target = fnSymbol('src/lib.ts', 'target');
    const caller1File = fileSymbol('src/caller1.ts');
    const caller1Fn = fnSymbol('src/caller1.ts', 'callerOne');
    const caller2File = fileSymbol('src/caller2.ts');
    const caller2Fn = fnSymbol('src/caller2.ts', 'callerTwo');
    store.replaceFileFacts(facts('src/lib.ts', [file, target]));
    store.replaceFileFacts(
      facts(
        'src/caller1.ts',
        [caller1File, caller1Fn],
        [resolvedCallEdge('src/caller1.ts', caller1Fn.id, target, 3)],
      ),
    );
    store.replaceFileFacts(
      facts(
        'src/caller2.ts',
        [caller2File, caller2Fn],
        [resolvedCallEdge('src/caller2.ts', caller2Fn.id, target, 3)],
      ),
    );
    store.replaceDerivedForRepo(
      REPO,
      [community('com-target', 1), community('com-callers', 2)],
      [
        membership('com-target', target.id),
        membership('com-callers', caller1Fn.id),
        membership('com-callers', caller2Fn.id),
      ],
      [flow('flow-1', target.id, 0.3)],
      [flowMembership('flow-1', target.id)],
    );

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(target, 'src/lib.ts')],
      queries,
    });

    // untested (0.30) + fan-in capped (0.10) + flowParticipation capped
    // (0.25, raw 0.30) + communityCrossing 2 * 0.05 (0.10) = 0.75.
    expect(risk.score).toBeCloseTo(0.75, 5);
    expect(risk.level).toBe('high');
  });

  it('reaches the full 1.00 ceiling ("critical") when every component maxes out', () => {
    const file = fileSymbol('src/authTool.ts');
    const target = fnSymbol('src/authTool.ts', 'checkAuthToken');
    const callerIds: string[] = [];
    store.replaceFileFacts(facts('src/authTool.ts', [file, target]));
    for (let i = 0; i < 3; i += 1) {
      const callerFile = fileSymbol(`src/caller${i}.ts`);
      const callerFn = fnSymbol(`src/caller${i}.ts`, `caller${i}`);
      store.replaceFileFacts(
        facts(
          `src/caller${i}.ts`,
          [callerFile, callerFn],
          [resolvedCallEdge(`src/caller${i}.ts`, callerFn.id, target, 3)],
        ),
      );
      callerIds.push(callerFn.id);
    }
    store.replaceDerivedForRepo(
      REPO,
      [community('com-target', 1), community('com-callers', 3)],
      [
        membership('com-target', target.id),
        ...callerIds.map((id) => membership('com-callers', id)),
      ],
      [flow('flow-1', target.id, 0.3)],
      [flowMembership('flow-1', target.id)],
    );

    const risk = scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed: [toChangedSymbol(target, 'src/authTool.ts')],
      queries,
    });

    // untested (0.30) + security (0.20) + fan-in capped (0.10) +
    // flowParticipation capped (0.25) + communityCrossing capped (0.15,
    // raw 3 * 0.05 = 0.15) = 1.00 exactly.
    expect(risk.score).toBeCloseTo(1.0, 5);
    expect(risk.level).toBe('critical');
  });
});

describe('changeRiskLevelForScore', () => {
  it('maps boundary values to the documented levels (<0.40 low, <0.70 medium, <0.85 high, else critical)', () => {
    expect(changeRiskLevelForScore(0)).toBe('low');
    expect(changeRiskLevelForScore(0.39)).toBe('low');
    expect(changeRiskLevelForScore(0.4)).toBe('medium');
    expect(changeRiskLevelForScore(0.69)).toBe('medium');
    expect(changeRiskLevelForScore(0.7)).toBe('high');
    expect(changeRiskLevelForScore(0.84)).toBe('high');
    expect(changeRiskLevelForScore(0.85)).toBe('critical');
    expect(changeRiskLevelForScore(1)).toBe('critical');
  });
});

describe('computeChangeImpactRadius', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let queries: CodeGraphQueryService;

  beforeEach(() => {
    ({ dir, db, store, queries } = setupStore(
      'code-graph-change-impact-radius-',
    ));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('unions hits from multiple seeds, deduping and keeping the minimum depth', async () => {
    // shared: file1::target1 <- caller.ts::callerFn ; file2::target2 <- caller.ts::callerFn (same caller calls both)
    const target1File = fileSymbol('src/target1.ts');
    const target1 = fnSymbol('src/target1.ts', 'target1');
    const target2File = fileSymbol('src/target2.ts');
    const target2 = fnSymbol('src/target2.ts', 'target2');
    const callerFile = fileSymbol('src/caller.ts');
    const callerFn = fnSymbol('src/caller.ts', 'callerFn');
    store.replaceFileFacts(facts('src/target1.ts', [target1File, target1]));
    store.replaceFileFacts(facts('src/target2.ts', [target2File, target2]));
    store.replaceFileFacts(
      facts(
        'src/caller.ts',
        [callerFile, callerFn],
        [
          resolvedCallEdge('src/caller.ts', callerFn.id, target1, 2),
          resolvedCallEdge('src/caller.ts', callerFn.id, target2, 3),
        ],
      ),
    );

    const { impacted, truncated } = await computeChangeImpactRadius({
      queries,
      repoId: REPO,
      seedQualifiedNames: [target1.qualifiedName, target2.qualifiedName],
    });

    expect(truncated).toBe(false);
    const names = impacted.map((hit) => hit.qualifiedName);
    expect(names).toEqual(['src/caller.ts::callerFn']);
    expect(impacted[0].depth).toBe(1);
  });

  it('truncates to maxNodes and reports truncated: true', async () => {
    const targetFile = fileSymbol('src/target.ts');
    const target = fnSymbol('src/target.ts', 'target');
    store.replaceFileFacts(facts('src/target.ts', [targetFile, target]));

    for (let i = 0; i < 5; i += 1) {
      const callerFile = fileSymbol(`src/caller${i}.ts`);
      const callerFn = fnSymbol(`src/caller${i}.ts`, `callerFn${i}`);
      store.replaceFileFacts(
        facts(
          `src/caller${i}.ts`,
          [callerFile, callerFn],
          [resolvedCallEdge(`src/caller${i}.ts`, callerFn.id, target, 2)],
        ),
      );
    }

    const { impacted, truncated } = await computeChangeImpactRadius({
      queries,
      repoId: REPO,
      seedQualifiedNames: [target.qualifiedName],
      maxNodes: 3,
    });

    expect(impacted).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it('does not truncate when hits are within maxNodes', async () => {
    const targetFile = fileSymbol('src/target.ts');
    const target = fnSymbol('src/target.ts', 'target');
    store.replaceFileFacts(facts('src/target.ts', [targetFile, target]));
    const callerFile = fileSymbol('src/caller.ts');
    const callerFn = fnSymbol('src/caller.ts', 'callerFn');
    store.replaceFileFacts(
      facts(
        'src/caller.ts',
        [callerFile, callerFn],
        [resolvedCallEdge('src/caller.ts', callerFn.id, target, 2)],
      ),
    );

    const { impacted, truncated } = await computeChangeImpactRadius({
      queries,
      repoId: REPO,
      seedQualifiedNames: [target.qualifiedName],
      maxNodes: 10,
    });

    expect(impacted).toHaveLength(1);
    expect(truncated).toBe(false);
  });

  it('returns no hits and no truncation for an empty seed list', async () => {
    const { impacted, truncated } = await computeChangeImpactRadius({
      queries,
      repoId: REPO,
      seedQualifiedNames: [],
    });

    expect(impacted).toEqual([]);
    expect(truncated).toBe(false);
  });
});

describe('computeImpactedTests', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let queries: CodeGraphQueryService;

  beforeEach(() => {
    ({ dir, db, store, queries } = setupStore(
      'code-graph-change-impact-tests-',
    ));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('dedupes tests across multiple changed symbols', () => {
    const file = fileSymbol('src/lib.ts');
    const a = fnSymbol('src/lib.ts', 'a');
    const b = fnSymbol('src/lib.ts', 'b');
    const testFile = fileSymbol('src/__tests__/lib.test.ts', true);
    store.replaceFileFacts(facts('src/lib.ts', [file, a, b]));
    store.replaceFileFacts(
      facts(
        'src/__tests__/lib.test.ts',
        [testFile],
        [testedByEdge(a, testFile), testedByEdge(b, testFile)],
      ),
    );

    const { impactedTests, truncated } = computeImpactedTests({
      queries,
      repoId: REPO,
      changed: [
        toChangedSymbol(a, 'src/lib.ts'),
        toChangedSymbol(b, 'src/lib.ts'),
      ],
    });

    expect(impactedTests).toEqual(['src/__tests__/lib.test.ts']);
    expect(truncated).toBe(false);
  });

  it('truncates to maxTests and reports truncated: true', () => {
    const file = fileSymbol('src/lib.ts');
    const target = fnSymbol('src/lib.ts', 'target');
    store.replaceFileFacts(facts('src/lib.ts', [file, target]));

    for (let i = 0; i < 5; i += 1) {
      const testFile = fileSymbol(`src/__tests__/case${i}.test.ts`, true);
      store.replaceFileFacts(
        facts(
          `src/__tests__/case${i}.test.ts`,
          [testFile],
          [testedByEdge(target, testFile)],
        ),
      );
    }

    const { impactedTests, truncated } = computeImpactedTests({
      queries,
      repoId: REPO,
      changed: [toChangedSymbol(target, 'src/lib.ts')],
      maxTests: 2,
    });

    expect(impactedTests).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});

describe('findTestGaps', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let queries: CodeGraphQueryService;

  beforeEach(() => {
    ({ dir, db, store, queries } = setupStore(
      'code-graph-change-impact-gaps-',
    ));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags an untested changed function as a test gap', () => {
    const file = fileSymbol('src/lib.ts');
    const fn = fnSymbol('src/lib.ts', 'untested');
    store.replaceFileFacts(facts('src/lib.ts', [file, fn]));

    const { testGaps, truncated } = findTestGaps({
      store,
      queries,
      repoId: REPO,
      changed: [toChangedSymbol(fn, 'src/lib.ts')],
    });

    expect(testGaps).toEqual([
      {
        qualifiedName: 'src/lib.ts::untested',
        kind: 'function',
        filePath: 'src/lib.ts',
      },
    ]);
    expect(truncated).toBe(false);
  });

  it('does not flag a tested changed function', () => {
    const file = fileSymbol('src/lib.ts');
    const fn = fnSymbol('src/lib.ts', 'tested');
    const testFile = fileSymbol('src/__tests__/lib.test.ts', true);
    store.replaceFileFacts(facts('src/lib.ts', [file, fn]));
    store.replaceFileFacts(
      facts(
        'src/__tests__/lib.test.ts',
        [testFile],
        [testedByEdge(fn, testFile)],
      ),
    );

    const { testGaps } = findTestGaps({
      store,
      queries,
      repoId: REPO,
      changed: [toChangedSymbol(fn, 'src/lib.ts')],
    });

    expect(testGaps).toEqual([]);
  });

  it('excludes class-kind symbols even if untested (function/method only)', () => {
    const file = fileSymbol('src/widget.ts');
    const cls = fnSymbol('src/widget.ts', 'Widget', { kind: 'class' });
    store.replaceFileFacts(facts('src/widget.ts', [file, cls]));

    const { testGaps } = findTestGaps({
      store,
      queries,
      repoId: REPO,
      changed: [toChangedSymbol(cls, 'src/widget.ts')],
    });

    expect(testGaps).toEqual([]);
  });

  it('excludes symbols that are themselves tests', () => {
    const testFile = fileSymbol('src/__tests__/lib.test.ts', true);
    const testFn = fnSymbol('src/__tests__/lib.test.ts', 'runsSomething', {
      isTest: true,
    });
    store.replaceFileFacts(
      facts('src/__tests__/lib.test.ts', [testFile, testFn]),
    );

    const { testGaps } = findTestGaps({
      store,
      queries,
      repoId: REPO,
      changed: [toChangedSymbol(testFn, 'src/__tests__/lib.test.ts')],
    });

    expect(testGaps).toEqual([]);
  });

  it('truncates to maxGaps and reports truncated: true', () => {
    const changed: ChangedSymbol[] = [];
    for (let i = 0; i < 5; i += 1) {
      const relativePath = `src/lib${i}.ts`;
      const file = fileSymbol(relativePath);
      const fn = fnSymbol(relativePath, `fn${i}`);
      store.replaceFileFacts(facts(relativePath, [file, fn]));
      changed.push(toChangedSymbol(fn, relativePath));
    }

    const { testGaps, truncated } = findTestGaps({
      store,
      queries,
      repoId: REPO,
      changed,
      maxGaps: 2,
    });

    expect(testGaps).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});

describe('impactSeedQualifiedNames', () => {
  function addedSymbol(qualifiedName: string): ChangedSymbol {
    return {
      qualifiedName,
      kind: 'function',
      filePath: qualifiedName.split('::')[0] ?? qualifiedName,
      lineStart: 1,
      lineEnd: 1,
      changeKind: 'added-file',
    };
  }

  it('caps seeds at CHANGE_IMPACT_MAX_SEEDS and reports truncation, keeping the sorted head', () => {
    const added: ChangedSymbol[] = [];
    for (let i = 0; i < CHANGE_IMPACT_MAX_SEEDS + 50; i += 1) {
      // Zero-padded so lexical order matches numeric order for a clean head/
      // tail assertion.
      added.push(addedSymbol(`src/lib.ts::fn${String(i).padStart(4, '0')}`));
    }
    const delta: SymbolDelta = { added, removed: [], signatureChanged: [] };

    const { seeds, truncated } = impactSeedQualifiedNames(delta, []);

    expect(truncated).toBe(true);
    expect(seeds).toHaveLength(CHANGE_IMPACT_MAX_SEEDS);
    // Added group is sorted by qualifiedName, so the retained head is the
    // first CHANGE_IMPACT_MAX_SEEDS entries in that order.
    expect(seeds[0]).toBe('src/lib.ts::fn0000');
    expect(seeds[CHANGE_IMPACT_MAX_SEEDS - 1]).toBe('src/lib.ts::fn0199');
  });

  it('orders added, then signatureChanged, then modified; no truncation under the cap', () => {
    const delta: SymbolDelta = {
      added: [addedSymbol('src/z.ts::addedFn')],
      removed: [],
      signatureChanged: [
        { qualifiedName: 'src/a.ts::sigFn', before: null, after: null },
      ],
    };
    const changed: ChangedSymbol[] = [
      {
        qualifiedName: 'src/a.ts::modFn',
        kind: 'function',
        filePath: 'src/a.ts',
        lineStart: 1,
        lineEnd: 1,
        changeKind: 'modified',
      },
    ];

    const { seeds, truncated } = impactSeedQualifiedNames(delta, changed);

    expect(truncated).toBe(false);
    expect(seeds).toEqual([
      'src/z.ts::addedFn',
      'src/a.ts::sigFn',
      'src/a.ts::modFn',
    ]);
  });
});

describe('createTestsForCache reuse across change-impact stages', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;
  let queries: CodeGraphQueryService;

  beforeEach(() => {
    ({ dir, db, store, queries } = setupStore('code-graph-tests-reuse-'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('queries a changed symbol’s tests once across risk, impacted-tests, and test-gap stages', () => {
    // A single untested function flows through all three stages: risk coverage
    // (function kind), impacted-tests, and test-gap all consult getTestsFor.
    const file = fileSymbol('src/lib.ts');
    const doWork = fnSymbol('src/lib.ts', 'doWork');
    store.replaceFileFacts(facts('src/lib.ts', [file, doWork]));
    const changed: ChangedSymbol[] = [toChangedSymbol(doWork, 'src/lib.ts')];

    const spy = jest.spyOn(queries, 'getTestsFor');
    const testsFor = createTestsForCache(queries, REPO);

    scoreChangeRisk({
      store,
      repoId: REPO,
      delta: emptyDelta(),
      changed,
      queries,
      testsFor,
    });
    computeImpactedTests({ queries, repoId: REPO, changed, testsFor });
    findTestGaps({ store, queries, repoId: REPO, changed, testsFor });

    // Shared cache: doWork's tests are fetched exactly once across all three
    // stages (would be 3 without the shared cache).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('src/lib.ts::doWork', REPO);
  });
});

describe('rename symmetry (mapRangesToSymbols + computeSymbolDelta)', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  beforeEach(() => {
    ({ dir, db, store } = setupStore('code-graph-change-impact-rename-'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('yields symmetric removed/added lists for a pure git-mv of a multi-symbol file', () => {
    // Current graph holds ONLY the NEW path (post-rename) symbols.
    const newFile = fileSymbol('src/new.ts');
    const newAlpha = fnSymbol('src/new.ts', 'alpha');
    const newBeta = fnSymbol('src/new.ts', 'beta');
    store.replaceFileFacts(facts('src/new.ts', [newFile, newAlpha, newBeta]));

    // Before-graph holds the OLD path (pre-rename) symbols — what the scoped
    // before-graph recovers from `git show <baseRef>:src/old.ts`.
    const before: BeforeGraphResult = {
      symbols: new Map([
        [
          'src/old.ts',
          {
            qualifiedName: 'src/old.ts',
            kind: 'file',
            signature: null,
            filePath: 'src/old.ts',
          },
        ],
        [
          'src/old.ts::alpha',
          {
            qualifiedName: 'src/old.ts::alpha',
            kind: 'function',
            signature: 'function alpha()',
            filePath: 'src/old.ts',
          },
        ],
        [
          'src/old.ts::beta',
          {
            qualifiedName: 'src/old.ts::beta',
            kind: 'function',
            signature: 'function beta()',
            filePath: 'src/old.ts',
          },
        ],
      ]),
      filesBuilt: 1,
      filesSkipped: 0,
    };

    // Pure `git mv`: rename with NO hunks.
    const { changed } = mapRangesToSymbols({
      store,
      repoId: REPO,
      changes: [
        {
          relativePath: 'src/new.ts',
          ranges: [],
          status: 'renamed',
          previousPath: 'src/old.ts',
        },
      ],
    });

    const delta = computeSymbolDelta({ changed, before, store, repoId: REPO });

    // Symmetric: every old-path symbol removed, every new-path symbol added —
    // the whole-file rename mapping makes the documented invariant hold rather
    // than the old removed:3 / added:1 (file symbol only).
    expect(delta.removed.map((symbol) => symbol.qualifiedName).sort()).toEqual([
      'src/old.ts',
      'src/old.ts::alpha',
      'src/old.ts::beta',
    ]);
    expect(delta.added.map((symbol) => symbol.qualifiedName).sort()).toEqual([
      'src/new.ts',
      'src/new.ts::alpha',
      'src/new.ts::beta',
    ]);
    expect(delta.added).toHaveLength(delta.removed.length);
  });
});

// --- assembleChangeImpact end-to-end (real git + engine) --------------------

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  }).trim();
}

function commitAll(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, [
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
  return git(root, ['rev-parse', 'HEAD']);
}

describe('assembleChangeImpact', () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-change-impact-e2e-'));
    git(root, ['init', '--quiet']);
    mkdirSync(path.join(root, 'src', 'callers'), { recursive: true });
    mkdirSync(path.join(root, 'src', '__tests__'), { recursive: true });
    dbPath = path.join(root, '.graph', 'graph.db');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('assembles delta, risk, impact, and review context for a real git diff', async () => {
    // v1 --------------------------------------------------------------
    writeFileSync(
      path.join(root, 'src', 'lib.ts'),
      'export function alpha(a: string): void {}\n' +
        'export function stable(): void {}\n',
    );
    writeFileSync(
      path.join(root, 'src', 'authTool.ts'),
      'export function checkAuthToken(token: string): boolean {\n' +
        '  return token.length > 0;\n' +
        '}\n',
    );
    writeFileSync(
      path.join(root, 'src', 'callers', 'one.ts'),
      "import { checkAuthToken } from '../authTool';\n" +
        'export function useAuthOne(): boolean {\n' +
        "  return checkAuthToken('a');\n" +
        '}\n',
    );
    writeFileSync(
      path.join(root, 'src', 'callers', 'two.ts'),
      "import { checkAuthToken } from '../authTool';\n" +
        'export function useAuthTwo(): boolean {\n' +
        "  return checkAuthToken('b');\n" +
        '}\n',
    );
    writeFileSync(
      path.join(root, 'src', 'gone.ts'),
      'export function goneFn(): void {}\n',
    );
    writeFileSync(
      path.join(root, 'src', '__tests__', 'lib.test.ts'),
      "import { alpha } from '../lib';\n" +
        'export function runsAlpha(): void {\n' +
        "  alpha('x');\n" +
        '}\n',
    );
    const baseRef = commitAll(root, 'v1');

    // v2 --------------------------------------------------------------
    writeFileSync(
      path.join(root, 'src', 'lib.ts'),
      'export function alpha(a: string, b: number): void {}\n' +
        'export function stable(): void {}\n' +
        'export function newFn(): number { return 1; }\n',
    );
    writeFileSync(
      path.join(root, 'src', 'authTool.ts'),
      'export function checkAuthToken(token: string): boolean {\n' +
        '  return token.trim().length > 0;\n' +
        '}\n',
    );
    rmSync(path.join(root, 'src', 'gone.ts'));
    commitAll(root, 'v2');

    // Build the CURRENT graph at v2 state.
    const engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: REPO, rootPath: root }],
    });
    await engine.buildOrUpdate();
    engine.close();

    // A fresh connection to the same (already-built) db, so `store`/`queries`
    // are independent of the engine instance that built the graph.
    const db = openCodeGraphDatabase(dbPath);
    runCodeGraphMigrations(db);
    const store = new CodeGraphStore(db);
    const queries = new CodeGraphQueryService(db);

    try {
      const report = await assembleChangeImpact({
        store,
        queries,
        repoId: REPO,
        rootPath: root,
        baseRef,
      });

      expect(report.repoId).toBe(REPO);
      expect(report.baseRef).toBe(baseRef);

      // Delta classes.
      expect(report.delta.added.map((s) => s.qualifiedName)).toContain(
        'src/lib.ts::newFn',
      );
      expect(report.delta.removed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ qualifiedName: 'src/gone.ts::goneFn' }),
        ]),
      );
      const alphaDelta = report.delta.signatureChanged.find(
        (s) => s.qualifiedName === 'src/lib.ts::alpha',
      );
      expect(alphaDelta).toBeDefined();
      expect(alphaDelta?.before).not.toContain('b: number');
      expect(alphaDelta?.after).toContain('b: number');

      // Risk: checkAuthToken is untested + security-named + 2 callers
      // (0.60), plus flow-participation now that the real build's derived
      // phase (Phase 6 Task 6, `computeDerived` defaults true) traces
      // useAuthOne/useAuthTwo as call-graph-root-seeded flows reaching
      // checkAuthToken, capping flowParticipation at its 0.25 ceiling
      // (0.60 + 0.25 = 0.85). communityCrossing stays 0: this trivial
      // fixture's Louvain partition places every symbol in one community,
      // so neither caller counts as cross-community.
      expect(report.risk.score).toBeCloseTo(0.85, 5);
      expect(report.risk.level).toBe('critical');
      expect(
        report.risk.reasons.some((reason) =>
          reason.includes('src/authTool.ts::checkAuthToken'),
        ),
      ).toBe(true);

      // Impact: checkAuthToken's callers must show up as impacted.
      const impactedNames = report.impacted.map((hit) => hit.qualifiedName);
      expect(impactedNames).toContain('src/callers/one.ts::useAuthOne');
      expect(impactedNames).toContain('src/callers/two.ts::useAuthTwo');
      expect(report.impactTruncated).toBe(false);

      // Impacted tests: alpha's signature changed and it is covered by lib.test.ts.
      expect(report.impactedTests).toContain('src/__tests__/lib.test.ts');
      expect(report.impactedTestsTruncated).toBe(false);

      // Test gaps: checkAuthToken (changed, untested); NOT alpha (tested),
      // NOT stable (untouched by the diff, so not in `changed` at all).
      const gapNames = report.reviewContext.testGaps.map(
        (g) => g.qualifiedName,
      );
      expect(gapNames).toContain('src/authTool.ts::checkAuthToken');
      expect(gapNames).not.toContain('src/lib.ts::alpha');
      expect(gapNames).not.toContain('src/lib.ts::stable');

      // Review context: changed symbols carry their own risk reasons.
      const checkAuthReview = report.reviewContext.changedSymbols.find(
        (s) => s.qualifiedName === 'src/authTool.ts::checkAuthToken',
      );
      expect(checkAuthReview?.riskScore).toBeCloseTo(0.85, 5);
      expect(checkAuthReview?.riskReasons.length).toBeGreaterThan(0);

      // Review priorities: checkAuthToken should be the top priority.
      expect(report.reviewContext.reviewPriorities[0]?.qualifiedName).toBe(
        'src/authTool.ts::checkAuthToken',
      );

      // Before-graph coverage: lib.ts + authTool.ts + gone.ts were all
      // scoped (modified/modified/deleted) and all existed at baseRef.
      expect(report.beforeGraph.filesBuilt).toBe(3);
      expect(report.beforeGraph.filesSkipped).toBe(0);
    } finally {
      db.close();
    }
  }, 30_000);

  it('surfaces a purely untracked file’s symbols as added-file changes', async () => {
    writeFileSync(
      path.join(root, 'src', 'lib.ts'),
      'export function alpha(a: string): void {}\n',
    );
    const baseRef = commitAll(root, 'v1');

    // Never `git add`ed: the graph scan still includes it (ls-files --others),
    // but `git diff <ref>` does not, so only the untracked-fold path in
    // getDiffRanges can surface it as a change.
    writeFileSync(
      path.join(root, 'src', 'fresh.ts'),
      'export function freshFn(): number {\n  return 1;\n}\n',
    );

    const engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: REPO, rootPath: root }],
    });
    await engine.buildOrUpdate();
    engine.close();

    const db = openCodeGraphDatabase(dbPath);
    runCodeGraphMigrations(db);
    const store = new CodeGraphStore(db);
    const queries = new CodeGraphQueryService(db);

    try {
      const report = await assembleChangeImpact({
        store,
        queries,
        repoId: REPO,
        rootPath: root,
        baseRef,
      });

      const fresh = report.changed.find(
        (symbol) => symbol.qualifiedName === 'src/fresh.ts::freshFn',
      );
      expect(fresh).toBeDefined();
      expect(fresh?.changeKind).toBe('added-file');
      // With no before-graph entry it also lands in the delta's added set.
      expect(
        report.delta.added.map((symbol) => symbol.qualifiedName),
      ).toContain('src/fresh.ts::freshFn');
      expect(report.unmatchedFiles).not.toContain('src/fresh.ts');
    } finally {
      db.close();
    }
  }, 30_000);
});

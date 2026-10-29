import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import { edgeRowId, fileRowId, symbolQualifiedName, symbolRowId } from '../ids';
import type {
  CodeGraphCommunityMembershipRecord,
  CodeGraphCommunityRecord,
  CodeGraphEdgeRecord,
  CodeGraphFlowMembershipRecord,
  CodeGraphFlowRecord,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';

const REPO = 'repo-a';

// --- Fixture helpers (mirrors graph-store.test.ts's hand-built-facts
// pattern: real store writes through replaceFileFacts, not mocks). ---

function makeSymbol(
  relativePath: string,
  name: string,
  index: number,
): CodeGraphSymbolRecord {
  const fileId = fileRowId(REPO, relativePath);
  return {
    id: symbolRowId(REPO, symbolQualifiedName(relativePath, [], name)),
    repositoryId: REPO,
    fileId,
    kind: 'function',
    name,
    qualifiedName: symbolQualifiedName(relativePath, [], name),
    parentSymbolId: null,
    lineStart: index + 1,
    lineEnd: index + 1,
    byteStart: index * 10,
    byteEnd: index * 10 + 5,
    signature: `function ${name}()`,
    exported: true,
    isTest: false,
    extra: {},
  };
}

function makeCallEdge(
  relativePath: string,
  source: CodeGraphSymbolRecord,
  target: CodeGraphSymbolRecord,
  line: number,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId: REPO,
      kind: 'CALLS',
      sourceId: source.id,
      target: target.name,
      line,
    }),
    repositoryId: REPO,
    kind: 'CALLS',
    sourceSymbolId: source.id,
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

function makeReferenceEdge(
  relativePath: string,
  source: CodeGraphSymbolRecord,
  target: CodeGraphSymbolRecord,
  line: number,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId: REPO,
      kind: 'REFERENCES',
      sourceId: source.id,
      target: target.name,
      line,
    }),
    repositoryId: REPO,
    kind: 'REFERENCES',
    sourceSymbolId: source.id,
    targetSymbolId: target.id,
    sourceFileId: fileRowId(REPO, relativePath),
    targetRef: target.name,
    line,
    confidenceTier: 'RESOLVED',
    confidenceScore: 0.9,
    resolverId: null,
    evidence: {},
  };
}

function community(
  id: string,
  label: string,
  cohesion: number,
  size: number,
): CodeGraphCommunityRecord {
  return {
    id,
    repositoryId: REPO,
    label,
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
  symbolCount: number,
  fileSpread: number,
  maxDepth: number,
): CodeGraphFlowRecord {
  return {
    id,
    repositoryId: REPO,
    entrySymbolId,
    name: `flow ${id}`,
    criticality,
    symbolCount,
    fileSpread,
    maxDepth,
    extra: {},
  };
}

function flowMembership(
  flowId: string,
  symbolId: string,
  depth: number,
): CodeGraphFlowMembershipRecord {
  return { flowId, symbolId, depth };
}

describe('CodeGraphStore derived analyses (communities + flows)', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-derived-store-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO, rootPath: '/abs', gitHead: null });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('replaceDerivedForRepo + listCommunities + listCommunityMembers + getCommunityForSymbol', () => {
    it('inserts communities and memberships, then fully replaces them (delete-then-insert, not accumulate)', () => {
      const alpha = makeSymbol('src/a.ts', 'alpha', 0);
      const gamma = makeSymbol('src/a.ts', 'gamma', 1);
      const beta = makeSymbol('src/b.ts', 'beta', 0);
      store.replaceFileFacts({
        file: {
          id: fileRowId(REPO, 'src/a.ts'),
          repositoryId: REPO,
          relativePath: 'src/a.ts',
          absolutePath: '/abs/src/a.ts',
          language: 'typescript',
          contentHash: 'hash-a',
          sizeBytes: 100,
          mtimeNs: '1',
          lineCount: 10,
          grammarId: 'typescript',
          grammarAbi: 14,
          parseStatus: 'parsed',
          hasErrors: false,
          updatedAt: Date.now(),
        },
        symbols: [alpha, gamma],
        edges: [],
      });
      store.replaceFileFacts({
        file: {
          id: fileRowId(REPO, 'src/b.ts'),
          repositoryId: REPO,
          relativePath: 'src/b.ts',
          absolutePath: '/abs/src/b.ts',
          language: 'typescript',
          contentHash: 'hash-b',
          sizeBytes: 100,
          mtimeNs: '1',
          lineCount: 10,
          grammarId: 'typescript',
          grammarAbi: 14,
          parseStatus: 'parsed',
          hasErrors: false,
          updatedAt: Date.now(),
        },
        symbols: [beta],
        edges: [],
      });

      const com1 = community('com-1', 'src', 0.9, 2);
      const com2 = community('com-2', 'src', 0.5, 1);
      store.replaceDerivedForRepo(
        REPO,
        [com1, com2],
        [
          membership('com-1', alpha.id),
          membership('com-1', gamma.id),
          membership('com-2', beta.id),
        ],
        [],
        [],
      );

      const listed = store.listCommunities(REPO);
      expect(listed.map((c) => c.id)).toEqual(['com-1', 'com-2']); // size desc
      expect(listed[0].repositoryId).toBe(REPO);
      expect(listed[0].cohesion).toBeCloseTo(0.9);

      const members = store.listCommunityMembers('com-1');
      expect(members.map((s) => s.qualifiedName).sort()).toEqual(
        [alpha.qualifiedName, gamma.qualifiedName].sort(),
      );

      expect(store.getCommunityForSymbol(alpha.id)?.id).toBe('com-1');
      expect(store.getCommunityForSymbol(beta.id)?.id).toBe('com-2');
      expect(store.getCommunityForSymbol('sym_unknown')).toBeNull();

      // Re-running with a smaller/different set fully replaces the prior
      // rows -- proving delete-then-insert, not accumulation.
      const com3 = community('com-3', 'other', 0.7, 1);
      store.replaceDerivedForRepo(
        REPO,
        [com3],
        [membership('com-3', beta.id)],
        [],
        [],
      );
      expect(store.listCommunities(REPO).map((c) => c.id)).toEqual(['com-3']);
      expect(store.getCommunityForSymbol(alpha.id)).toBeNull();
      expect(store.listCommunityMembers('com-1')).toEqual([]);
    });
  });

  describe('listFlows + listFlowsForSymbol', () => {
    it('lists flows ordered by criticality desc and resolves flows containing a symbol', () => {
      const alpha = makeSymbol('src/a.ts', 'alpha', 0);
      const gamma = makeSymbol('src/a.ts', 'gamma', 1);
      const beta = makeSymbol('src/b.ts', 'beta', 0);

      const flow1 = flow('flow-1', alpha.id, 0.8, 2, 1, 2);
      const flow2 = flow('flow-2', beta.id, 0.3, 1, 1, 1);
      store.replaceDerivedForRepo(
        REPO,
        [],
        [],
        [flow1, flow2],
        [
          flowMembership('flow-1', alpha.id, 0),
          flowMembership('flow-1', gamma.id, 1),
          flowMembership('flow-2', beta.id, 0),
        ],
      );

      const listed = store.listFlows(REPO);
      expect(listed.map((f) => f.id)).toEqual(['flow-1', 'flow-2']);
      expect(listed[0].repositoryId).toBe(REPO);
      expect(listed[0].entrySymbolId).toBe(alpha.id);
      expect(listed[0].symbolCount).toBe(2);
      expect(listed[0].fileSpread).toBe(1);
      expect(listed[0].maxDepth).toBe(2);

      expect(store.listFlowsForSymbol(gamma.id).map((f) => f.id)).toEqual([
        'flow-1',
      ]);
      expect(store.listFlowsForSymbol(beta.id).map((f) => f.id)).toEqual([
        'flow-2',
      ]);
      expect(store.listFlowsForSymbol('sym_unknown')).toEqual([]);
    });
  });

  describe('countCrossCommunityCallers (hand-built fixture, known expected values)', () => {
    it('counts only distinct caller symbols in a DIFFERENT community than the target, deduping repeat calls and excluding same-community/no-community callers', () => {
      // com1 = {alpha, gamma}; com2 = {beta, delta}; com3 = {epsilon}.
      // "outsider" is deliberately left OUT of every community.
      const alpha = makeSymbol('src/a.ts', 'alpha', 0);
      const gamma = makeSymbol('src/a.ts', 'gamma', 1);
      const beta = makeSymbol('src/b.ts', 'beta', 0);
      const delta = makeSymbol('src/b.ts', 'delta', 1);
      const epsilon = makeSymbol('src/c.ts', 'epsilon', 0);
      const outsider = makeSymbol('src/d.ts', 'outsider', 0);

      store.replaceFileFacts({
        file: {
          id: fileRowId(REPO, 'src/a.ts'),
          repositoryId: REPO,
          relativePath: 'src/a.ts',
          absolutePath: '/abs/src/a.ts',
          language: 'typescript',
          contentHash: 'hash-a',
          sizeBytes: 100,
          mtimeNs: '1',
          lineCount: 10,
          grammarId: 'typescript',
          grammarAbi: 14,
          parseStatus: 'parsed',
          hasErrors: false,
          updatedAt: Date.now(),
        },
        symbols: [alpha, gamma],
        edges: [
          makeCallEdge('src/a.ts', alpha, beta, 1),
          // A second, later-line call from the SAME caller (alpha) to the
          // same target must not be double-counted.
          makeCallEdge('src/a.ts', alpha, beta, 2),
          makeCallEdge('src/a.ts', gamma, beta, 3),
        ],
      });
      store.replaceFileFacts({
        file: {
          id: fileRowId(REPO, 'src/b.ts'),
          repositoryId: REPO,
          relativePath: 'src/b.ts',
          absolutePath: '/abs/src/b.ts',
          language: 'typescript',
          contentHash: 'hash-b',
          sizeBytes: 100,
          mtimeNs: '1',
          lineCount: 10,
          grammarId: 'typescript',
          grammarAbi: 14,
          parseStatus: 'parsed',
          hasErrors: false,
          updatedAt: Date.now(),
        },
        symbols: [beta, delta],
        // Same-community caller of beta: must NOT count.
        edges: [makeCallEdge('src/b.ts', delta, beta, 1)],
      });
      store.replaceFileFacts({
        file: {
          id: fileRowId(REPO, 'src/c.ts'),
          repositoryId: REPO,
          relativePath: 'src/c.ts',
          absolutePath: '/abs/src/c.ts',
          language: 'typescript',
          contentHash: 'hash-c',
          sizeBytes: 100,
          mtimeNs: '1',
          lineCount: 10,
          grammarId: 'typescript',
          grammarAbi: 14,
          parseStatus: 'parsed',
          hasErrors: false,
          updatedAt: Date.now(),
        },
        symbols: [epsilon],
        edges: [makeCallEdge('src/c.ts', epsilon, beta, 1)],
      });
      store.replaceFileFacts({
        file: {
          id: fileRowId(REPO, 'src/d.ts'),
          repositoryId: REPO,
          relativePath: 'src/d.ts',
          absolutePath: '/abs/src/d.ts',
          language: 'typescript',
          contentHash: 'hash-d',
          sizeBytes: 100,
          mtimeNs: '1',
          lineCount: 10,
          grammarId: 'typescript',
          grammarAbi: 14,
          parseStatus: 'parsed',
          hasErrors: false,
          updatedAt: Date.now(),
        },
        symbols: [outsider],
        // A caller with NO community assignment at all: must NOT count
        // (honest "we can't tell" rather than guessing cross-community).
        edges: [makeCallEdge('src/d.ts', outsider, beta, 1)],
      });

      store.replaceDerivedForRepo(
        REPO,
        [
          community('com-1', 'a', 0.9, 2),
          community('com-2', 'b', 0.9, 2),
          community('com-3', 'c', 0.9, 1),
        ],
        [
          membership('com-1', alpha.id),
          membership('com-1', gamma.id),
          membership('com-2', beta.id),
          membership('com-2', delta.id),
          membership('com-3', epsilon.id),
        ],
        [],
        [],
      );

      expect(store.countCrossCommunityCallers(beta.id)).toBe(3); // alpha, gamma, epsilon
      // A target with no community assignment: honestly reports 0.
      expect(store.countCrossCommunityCallers(outsider.id)).toBe(0);
    });
  });

  describe('listTopDegreeSymbols (hand-built fixture, known expected values)', () => {
    it('ranks symbols by total edge degree (in + out, every edge kind), computed live from edges with no dedicated table', () => {
      const hub = makeSymbol('src/hub.ts', 'hub', 0);
      const c1 = makeSymbol('src/c1.ts', 'c1', 0);
      const c2 = makeSymbol('src/c2.ts', 'c2', 0);
      const c3 = makeSymbol('src/c3.ts', 'c3', 0);
      const callee1 = makeSymbol('src/callee1.ts', 'callee1', 0);
      const callee2 = makeSymbol('src/callee2.ts', 'callee2', 0);
      const ref1 = makeSymbol('src/ref1.ts', 'ref1', 0);
      const lowCaller = makeSymbol('src/lowcaller.ts', 'lowCaller', 0);
      const low = makeSymbol('src/low.ts', 'low', 0);

      function seed(
        relativePath: string,
        symbols: CodeGraphSymbolRecord[],
        edges: CodeGraphEdgeRecord[],
      ): void {
        store.replaceFileFacts({
          file: {
            id: fileRowId(REPO, relativePath),
            repositoryId: REPO,
            relativePath,
            absolutePath: `/abs/${relativePath}`,
            language: 'typescript',
            contentHash: `hash-${relativePath}`,
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
        });
      }

      // hub in-degree: c1, c2, c3 (CALLS) + ref1 (REFERENCES) = 4.
      // hub out-degree: callee1, callee2 (CALLS) = 2.
      // hub total degree = 6.
      seed('src/hub.ts', [hub], []);
      seed('src/c1.ts', [c1], [makeCallEdge('src/c1.ts', c1, hub, 1)]);
      seed('src/c2.ts', [c2], [makeCallEdge('src/c2.ts', c2, hub, 1)]);
      seed('src/c3.ts', [c3], [makeCallEdge('src/c3.ts', c3, hub, 1)]);
      seed('src/callee1.ts', [callee1], []);
      seed('src/callee2.ts', [callee2], []);
      seed(
        'src/ref1.ts',
        [ref1],
        [makeReferenceEdge('src/ref1.ts', ref1, hub, 1)],
      );
      // hub's own outgoing edges live on hub's file.
      store.replaceFileFacts({
        file: {
          id: fileRowId(REPO, 'src/hub.ts'),
          repositoryId: REPO,
          relativePath: 'src/hub.ts',
          absolutePath: '/abs/src/hub.ts',
          language: 'typescript',
          contentHash: 'hash-hub-2',
          sizeBytes: 100,
          mtimeNs: '2',
          lineCount: 10,
          grammarId: 'typescript',
          grammarAbi: 14,
          parseStatus: 'parsed',
          hasErrors: false,
          updatedAt: Date.now(),
        },
        symbols: [hub],
        edges: [
          makeCallEdge('src/hub.ts', hub, callee1, 2),
          makeCallEdge('src/hub.ts', hub, callee2, 3),
        ],
      });

      // low: exactly one caller, degree 1.
      seed('src/low.ts', [low], []);
      seed(
        'src/lowcaller.ts',
        [lowCaller],
        [makeCallEdge('src/lowcaller.ts', lowCaller, low, 1)],
      );

      const ranked = store.listTopDegreeSymbols(REPO, 10);
      expect(ranked[0].qualifiedName).toBe(hub.qualifiedName);
      expect(ranked[0].degree).toBe(6);
      expect(ranked[0].kind).toBe('function');
      expect(ranked[0].filePath).toBe('src/hub.ts');

      const lowEntry = ranked.find(
        (r) => r.qualifiedName === low.qualifiedName,
      );
      expect(lowEntry?.degree).toBe(1);
    });
  });

  describe('getDerivedStats', () => {
    it('reports community/flow counts scoped to the repository, zero when nothing has been computed', () => {
      expect(store.getDerivedStats(REPO)).toEqual({
        communityCount: 0,
        flowCount: 0,
      });

      const alpha = makeSymbol('src/a.ts', 'alpha', 0);
      store.replaceDerivedForRepo(
        REPO,
        [community('com-1', 'a', 0.9, 1), community('com-2', 'b', 0.5, 1)],
        [membership('com-1', alpha.id)],
        [flow('flow-1', alpha.id, 0.4, 1, 1, 0)],
        [flowMembership('flow-1', alpha.id, 0)],
      );

      expect(store.getDerivedStats(REPO)).toEqual({
        communityCount: 2,
        flowCount: 1,
      });
    });

    it('aggregates across every repository when repoId is omitted (Phase 6 Task 6: mirrors symbolCount/edgeCount)', () => {
      const otherRepo = 'repo-b';
      store.upsertRepository({
        repoId: otherRepo,
        rootPath: '/abs-b',
        gitHead: null,
      });

      const alpha = makeSymbol('src/a.ts', 'alpha', 0);
      store.replaceDerivedForRepo(
        REPO,
        [community('com-1', 'a', 0.9, 1)],
        [membership('com-1', alpha.id)],
        [flow('flow-1', alpha.id, 0.4, 1, 1, 0)],
        [flowMembership('flow-1', alpha.id, 0)],
      );

      const beta: CodeGraphSymbolRecord = {
        ...makeSymbol('src/b.ts', 'beta', 0),
        id: 'sym-beta-other-repo',
        repositoryId: otherRepo,
      };
      store.replaceDerivedForRepo(
        otherRepo,
        [
          {
            id: 'com-other',
            repositoryId: otherRepo,
            label: 'b',
            cohesion: 0.5,
            size: 1,
            fingerprint: 'fp-other',
            extra: {},
          },
        ],
        [{ communityId: 'com-other', symbolId: beta.id }],
        [],
        [],
      );

      expect(store.getDerivedStats(REPO)).toEqual({
        communityCount: 1,
        flowCount: 1,
      });
      expect(store.getDerivedStats(otherRepo)).toEqual({
        communityCount: 1,
        flowCount: 0,
      });
      expect(store.getDerivedStats()).toEqual({
        communityCount: 2,
        flowCount: 1,
      });
    });
  });

  describe('listSymbolsForRepo', () => {
    it('returns full symbol records for the whole repo, ordered by id', () => {
      const alpha = makeSymbol('src/a.ts', 'alpha', 0);
      const gamma = makeSymbol('src/a.ts', 'gamma', 1);
      const beta = makeSymbol('src/b.ts', 'beta', 0);
      store.replaceFileFacts({
        file: {
          id: fileRowId(REPO, 'src/a.ts'),
          repositoryId: REPO,
          relativePath: 'src/a.ts',
          absolutePath: '/abs/src/a.ts',
          language: 'typescript',
          contentHash: 'hash-a',
          sizeBytes: 100,
          mtimeNs: '1',
          lineCount: 10,
          grammarId: 'typescript',
          grammarAbi: 14,
          parseStatus: 'parsed',
          hasErrors: false,
          updatedAt: Date.now(),
        },
        symbols: [alpha, gamma],
        edges: [],
      });
      store.replaceFileFacts({
        file: {
          id: fileRowId(REPO, 'src/b.ts'),
          repositoryId: REPO,
          relativePath: 'src/b.ts',
          absolutePath: '/abs/src/b.ts',
          language: 'typescript',
          contentHash: 'hash-b',
          sizeBytes: 100,
          mtimeNs: '1',
          lineCount: 10,
          grammarId: 'typescript',
          grammarAbi: 14,
          parseStatus: 'parsed',
          hasErrors: false,
          updatedAt: Date.now(),
        },
        symbols: [beta],
        edges: [],
      });

      const listed = store.listSymbolsForRepo(REPO);
      expect(listed.map((s) => s.qualifiedName).sort()).toEqual(
        [alpha.qualifiedName, gamma.qualifiedName, beta.qualifiedName].sort(),
      );
      // Full record, not the narrow `listSymbols` summary projection --
      // `.id`/`.fileId` must round-trip so the derived-analysis orchestrator
      // can feed these straight into `detectCommunities`/`traceFlows`.
      const found = listed.find((s) => s.id === alpha.id);
      expect(found?.fileId).toBe(alpha.fileId);
      expect(found?.kind).toBe('function');
    });

    it('returns an empty list for a repo with no symbols', () => {
      expect(store.listSymbolsForRepo(REPO)).toEqual([]);
    });
  });

  describe('listCommunityMemberships', () => {
    it('returns every (communityId, symbolId) pair for a repo, ordered deterministically', () => {
      const alpha = makeSymbol('src/a.ts', 'alpha', 0);
      const gamma = makeSymbol('src/a.ts', 'gamma', 1);
      const beta = makeSymbol('src/b.ts', 'beta', 0);
      store.replaceDerivedForRepo(
        REPO,
        [community('com-1', 'a', 0.9, 2), community('com-2', 'b', 0.5, 1)],
        [
          membership('com-1', alpha.id),
          membership('com-1', gamma.id),
          membership('com-2', beta.id),
        ],
        [],
        [],
      );

      // Ordered by (communityId, symbolId) -- alpha/gamma's relative order
      // within com-1 follows their hashed ids, not insertion order, so sort
      // the expected pair the same way rather than hardcoding it.
      const com1SymbolIds = [alpha.id, gamma.id].sort();
      expect(store.listCommunityMemberships(REPO)).toEqual([
        { communityId: 'com-1', symbolId: com1SymbolIds[0] },
        { communityId: 'com-1', symbolId: com1SymbolIds[1] },
        { communityId: 'com-2', symbolId: beta.id },
      ]);
    });

    it('returns an empty list before anything has ever been computed', () => {
      expect(store.listCommunityMemberships(REPO)).toEqual([]);
    });

    it('scopes to the given repo only, excluding another repo’s memberships', () => {
      const otherRepo = 'repo-c';
      store.upsertRepository({
        repoId: otherRepo,
        rootPath: '/abs-c',
        gitHead: null,
      });
      store.replaceDerivedForRepo(
        otherRepo,
        [
          {
            id: 'com-other',
            repositoryId: otherRepo,
            label: 'c',
            cohesion: 0.5,
            size: 1,
            fingerprint: 'fp-other',
            extra: {},
          },
        ],
        [{ communityId: 'com-other', symbolId: 'sym-other' }],
        [],
        [],
      );

      expect(store.listCommunityMemberships(REPO)).toEqual([]);
      expect(store.listCommunityMemberships(otherRepo)).toEqual([
        { communityId: 'com-other', symbolId: 'sym-other' },
      ]);
    });
  });
});

import { CODE_GRAPH_SECURITY_KEYWORD_PATTERN } from '../analysis/security-keywords';
import { edgeRowId, fileRowId, symbolQualifiedName, symbolRowId } from '../ids';
import type {
  CodeGraphEdgeKind,
  CodeGraphEdgeRecord,
  CodeGraphSymbolKind,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';
import {
  CODE_GRAPH_FLOW_ENTRY_POINT_MAX,
  CODE_GRAPH_FLOW_MAX_DEPTH,
  CODE_GRAPH_FLOW_MAX_MEMBERS,
  detectFlowEntryPoints,
  traceFlows,
} from '../analysis/flows';

const REPO = 'repo-a';

// --- Fixture helpers (mirrors communities.test.ts's hand-built pattern) -----

function makeSymbol(input: {
  relativePath: string;
  name: string;
  kind?: CodeGraphSymbolKind;
  index?: number;
}): CodeGraphSymbolRecord {
  const { relativePath, name } = input;
  const kind = input.kind ?? 'function';
  const index = input.index ?? 0;
  const fileId = fileRowId(REPO, relativePath);
  return {
    id: symbolRowId(REPO, symbolQualifiedName(relativePath, [], name)),
    repositoryId: REPO,
    fileId,
    kind,
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
  source: CodeGraphSymbolRecord,
  target: CodeGraphSymbolRecord | null,
  line: number,
  targetRefOverride?: string,
): CodeGraphEdgeRecord {
  const targetRef = targetRefOverride ?? target?.name ?? 'unresolved';
  return {
    id: edgeRowId({
      repoId: REPO,
      kind: 'CALLS',
      sourceId: source.id,
      target: targetRef,
      line,
    }),
    repositoryId: REPO,
    kind: 'CALLS',
    sourceSymbolId: source.id,
    targetSymbolId: target?.id ?? null,
    sourceFileId: source.fileId,
    targetRef,
    line,
    confidenceTier: target === null ? 'AMBIGUOUS' : 'RESOLVED',
    confidenceScore: target === null ? 0.2 : 0.9,
    resolverId: null,
    evidence: {},
  };
}

function makeEdge(
  kind: CodeGraphEdgeKind,
  source: CodeGraphSymbolRecord,
  target: CodeGraphSymbolRecord,
  line: number | null,
): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId: REPO,
      kind,
      sourceId: source.id,
      target: target.name,
      line,
    }),
    repositoryId: REPO,
    kind,
    sourceSymbolId: source.id,
    targetSymbolId: target.id,
    sourceFileId: source.fileId,
    targetRef: target.name,
    line,
    confidenceTier: 'RESOLVED',
    confidenceScore: 0.9,
    resolverId: null,
    evidence: {},
  };
}

function flowFor(
  flows: ReturnType<typeof traceFlows>,
  entrySymbol: CodeGraphSymbolRecord,
): ReturnType<typeof traceFlows>['flows'][number] | undefined {
  return flows.flows.find((flow) => flow.entrySymbolId === entrySymbol.id);
}

describe('detectFlowEntryPoints: entry-point classes', () => {
  it('detects a call-graph root: a function with >=1 outgoing CALLS and 0 incoming CALLS', () => {
    const root = makeSymbol({ relativePath: 'src/root.ts', name: 'doWork' });
    const callee = makeSymbol({
      relativePath: 'src/callee.ts',
      name: 'helper',
    });
    const symbols = [root, callee];
    const edges = [makeCallEdge(root, callee, 1)];

    const entryPoints = detectFlowEntryPoints(symbols, edges);
    expect(entryPoints).toEqual([
      { symbolId: root.id, evidence: 'call-graph-root' },
    ]);
  });

  it('does not treat the callee (which has an incoming CALLS edge) as a root', () => {
    const root = makeSymbol({ relativePath: 'src/root.ts', name: 'doWork' });
    const callee = makeSymbol({
      relativePath: 'src/callee.ts',
      name: 'helper',
    });
    const symbols = [root, callee];
    const edges = [makeCallEdge(root, callee, 1)];

    const entryPoints = detectFlowEntryPoints(symbols, edges);
    expect(entryPoints.some((entry) => entry.symbolId === callee.id)).toBe(
      false,
    );
  });

  it('detects an IPC-handler entry point: the SOURCE of an IPC_HANDLES edge', () => {
    const handler = makeSymbol({
      relativePath: 'src/ipc/chat.ts',
      name: 'onChatSend',
    });
    const channel = makeSymbol({
      relativePath: 'src/ipc/channels.ts',
      name: 'chat:send',
      kind: 'ipc_channel',
    });
    const symbols = [handler, channel];
    const edges = [makeEdge('IPC_HANDLES', handler, channel, 5)];

    const entryPoints = detectFlowEntryPoints(symbols, edges);
    expect(entryPoints).toEqual([
      { symbolId: handler.id, evidence: 'ipc-handler' },
    ]);
  });

  it('detects a conventional-name entry point by exact, case-sensitive name match', () => {
    const activate = makeSymbol({
      relativePath: 'src/extension.ts',
      name: 'activate',
    });
    // Case-sensitive: "Activate" must NOT match.
    const notActivate = makeSymbol({
      relativePath: 'src/other.ts',
      name: 'Activate',
    });
    const symbols = [activate, notActivate];

    const entryPoints = detectFlowEntryPoints(symbols, []);
    expect(entryPoints).toEqual([
      { symbolId: activate.id, evidence: 'conventional-name' },
    ]);
  });

  it('treats a function named "run" as a conventional-name entry point', () => {
    const runFunction = makeSymbol({
      relativePath: 'src/runner.ts',
      name: 'run',
    });

    const entryPoints = detectFlowEntryPoints([runFunction], []);
    expect(entryPoints).toEqual([
      { symbolId: runFunction.id, evidence: 'conventional-name' },
    ]);
  });

  it('does not treat a non-callable symbol named "run" as an entry point', () => {
    // Entry-point class (c) is restricted to callable kinds
    // (function/method), same as class (a): a variable/const that merely
    // happens to be named `run` is not somewhere execution can start.
    const runVariable = makeSymbol({
      relativePath: 'src/config.ts',
      name: 'run',
      kind: 'variable',
    });
    const mainVariable = makeSymbol({
      relativePath: 'src/index.ts',
      name: 'main',
      kind: 'variable',
    });

    expect(detectFlowEntryPoints([runVariable, mainVariable], [])).toEqual([]);
  });

  it("recognizes every conventional name in the brief's exact list", () => {
    const names = ['main', 'activate', 'run', 'handler', 'execute'];
    const symbols = names.map((name, index) =>
      makeSymbol({ relativePath: `src/${name}.ts`, name, index }),
    );

    const entryPoints = detectFlowEntryPoints(symbols, []);
    expect(entryPoints.map((entry) => entry.symbolId).sort()).toEqual(
      symbols.map((symbol) => symbol.id).sort(),
    );
  });
});

describe('detectFlowEntryPoints: dedup and ordering', () => {
  it('dedupes a symbol matching multiple classes into its highest-priority class (ipc-handler > root > name)', () => {
    // `run` is simultaneously an IPC handler, a call-graph root, AND a
    // conventional name -- it must appear exactly once, classified under the
    // highest-priority class (ipc-handler).
    const run = makeSymbol({ relativePath: 'src/run.ts', name: 'run' });
    const callee = makeSymbol({
      relativePath: 'src/callee.ts',
      name: 'helper',
    });
    const channel = makeSymbol({
      relativePath: 'src/channels.ts',
      name: 'app:run',
      kind: 'ipc_channel',
    });
    const symbols = [run, callee, channel];
    const edges = [
      makeCallEdge(run, callee, 1),
      makeEdge('IPC_HANDLES', run, channel, 2),
    ];

    const entryPoints = detectFlowEntryPoints(symbols, edges);
    const matches = entryPoints.filter((entry) => entry.symbolId === run.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.evidence).toBe('ipc-handler');
  });

  it('orders ipc-handler entries first, then roots, then conventional names, id-ascending within each class', () => {
    const handlerA = makeSymbol({ relativePath: 'src/h/a.ts', name: 'onA' });
    const handlerB = makeSymbol({ relativePath: 'src/h/b.ts', name: 'onB' });
    const channelA = makeSymbol({
      relativePath: 'src/h/channels.ts',
      name: 'a:chan',
      kind: 'ipc_channel',
    });
    const channelB = makeSymbol({
      relativePath: 'src/h/channels.ts',
      name: 'b:chan',
      kind: 'ipc_channel',
    });
    const rootA = makeSymbol({ relativePath: 'src/r/a.ts', name: 'rootA' });
    const rootB = makeSymbol({ relativePath: 'src/r/b.ts', name: 'rootB' });
    const calleeA = makeSymbol({
      relativePath: 'src/r/ca.ts',
      name: 'calleeA',
    });
    const calleeB = makeSymbol({
      relativePath: 'src/r/cb.ts',
      name: 'calleeB',
    });
    const named = makeSymbol({ relativePath: 'src/n/main.ts', name: 'main' });

    const symbols = [
      named,
      rootB,
      rootA,
      handlerB,
      handlerA,
      channelA,
      channelB,
      calleeA,
      calleeB,
    ];
    const edges = [
      makeEdge('IPC_HANDLES', handlerA, channelA, 1),
      makeEdge('IPC_HANDLES', handlerB, channelB, 1),
      makeCallEdge(rootA, calleeA, 1),
      makeCallEdge(rootB, calleeB, 1),
    ];

    const entryPoints = detectFlowEntryPoints(symbols, edges);

    const expectedHandlerIds = [handlerA.id, handlerB.id].sort();
    const expectedRootIds = [rootA.id, rootB.id].sort();

    expect(entryPoints.map((entry) => entry.evidence)).toEqual([
      'ipc-handler',
      'ipc-handler',
      'call-graph-root',
      'call-graph-root',
      'conventional-name',
    ]);
    expect(entryPoints.slice(0, 2).map((entry) => entry.symbolId)).toEqual(
      expectedHandlerIds,
    );
    expect(entryPoints.slice(2, 4).map((entry) => entry.symbolId)).toEqual(
      expectedRootIds,
    );
    expect(entryPoints[4]?.symbolId).toBe(named.id);
  });

  it('caps entry points at 500 total, id-ascending within the conventional-name class', () => {
    const symbols: CodeGraphSymbolRecord[] = [];
    for (let i = 0; i < CODE_GRAPH_FLOW_ENTRY_POINT_MAX + 1; i++) {
      symbols.push(
        makeSymbol({
          relativePath: `src/many/f${i}.ts`,
          name: 'main',
          index: i,
        }),
      );
    }

    const entryPoints = detectFlowEntryPoints(symbols, []);
    expect(entryPoints).toHaveLength(CODE_GRAPH_FLOW_ENTRY_POINT_MAX);
    const ids = entryPoints.map((entry) => entry.symbolId);
    const sortedIds = [...ids].sort();
    expect(ids).toEqual(sortedIds);
  });
});

describe('traceFlows: determinism', () => {
  it('produces byte-identical output across two runs on the same input', () => {
    const root = makeSymbol({ relativePath: 'src/root.ts', name: 'main' });
    const mid = makeSymbol({ relativePath: 'src/mid.ts', name: 'mid' });
    const leaf = makeSymbol({ relativePath: 'src/leaf.ts', name: 'leaf' });
    const symbols = [root, mid, leaf];
    const edges = [makeCallEdge(root, mid, 1), makeCallEdge(mid, leaf, 1)];

    const run = (): ReturnType<typeof traceFlows> =>
      traceFlows({ repoId: REPO, symbols, edges });

    const result1 = run();
    const result2 = run();
    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
    expect(result1.flows.length).toBeGreaterThan(0);
  });
});

describe('traceFlows: depth cap', () => {
  it('stops BFS at depth 15 and flags truncation when deeper members exist', () => {
    // A straight chain f0 -> f1 -> ... -> f19 (20 nodes): f0 is the only
    // root (0 incoming CALLS), so it is the sole entry point.
    const chain: CodeGraphSymbolRecord[] = [];
    for (let i = 0; i < 20; i++) {
      chain.push(
        makeSymbol({ relativePath: `src/chain/f${i}.ts`, name: `f${i}` }),
      );
    }
    const edges: CodeGraphEdgeRecord[] = [];
    for (let i = 0; i < chain.length - 1; i++) {
      edges.push(makeCallEdge(chain[i], chain[i + 1], 1));
    }

    const result = traceFlows({ repoId: REPO, symbols: chain, edges });
    const flow = flowFor(result, chain[0]);
    expect(flow).toBeDefined();
    expect(flow?.maxDepth).toBe(CODE_GRAPH_FLOW_MAX_DEPTH);
    // f0 (depth 0) through f15 (depth 15) = 16 members; f16..f19 cut off.
    expect(flow?.symbolCount).toBe(CODE_GRAPH_FLOW_MAX_DEPTH + 1);
    expect(flow?.extra.truncated).toBe(true);
  });
});

describe('traceFlows: member cap', () => {
  it('stops adding members at 2000 per flow and flags truncation', () => {
    const root = makeSymbol({
      relativePath: 'src/fanout/root.ts',
      name: 'main',
    });
    const leaves: CodeGraphSymbolRecord[] = [];
    for (let i = 0; i < 2005; i++) {
      leaves.push(
        makeSymbol({
          relativePath: `src/fanout/leaf${i}.ts`,
          name: `leaf${i}`,
        }),
      );
    }
    const symbols = [root, ...leaves];
    const edges = leaves.map((leaf, index) => makeCallEdge(root, leaf, index));

    const result = traceFlows({ repoId: REPO, symbols, edges });
    const flow = flowFor(result, root);
    expect(flow).toBeDefined();
    expect(flow?.symbolCount).toBe(CODE_GRAPH_FLOW_MAX_MEMBERS);
    expect(flow?.maxDepth).toBe(1);
    expect(flow?.extra.truncated).toBe(true);
  });
});

describe('traceFlows: global membership-row cap', () => {
  it('drops a whole flow (not a partial one) once the cap would be exceeded, and stops tracing further flows', () => {
    // Three independent 2-member flows (root + 1 callee each), no cross
    // links. With `globalMembershipCap` overridden to 3 (see
    // `computeChangeImpactRadius`'s precedent for overridable caps so tests
    // don't need to construct 200k real rows): the first processed flow (2
    // members) fits under the cap (running total 2). The second candidate
    // flow would push the running total to 4 > 3, so it is dropped WHOLE
    // (memberships stays at exactly 2, never 3 -- proving no partial
    // inclusion), tracing stops immediately, and the third flow -- which
    // would have fit in isolation -- is never even attempted.
    const rootA = makeSymbol({
      relativePath: 'src/cap/rootA.ts',
      name: 'rootA',
    });
    const calleeA = makeSymbol({
      relativePath: 'src/cap/calleeA.ts',
      name: 'calleeA',
    });
    const rootB = makeSymbol({
      relativePath: 'src/cap/rootB.ts',
      name: 'rootB',
    });
    const calleeB = makeSymbol({
      relativePath: 'src/cap/calleeB.ts',
      name: 'calleeB',
    });
    const rootC = makeSymbol({
      relativePath: 'src/cap/rootC.ts',
      name: 'rootC',
    });
    const calleeC = makeSymbol({
      relativePath: 'src/cap/calleeC.ts',
      name: 'calleeC',
    });

    const symbols = [rootA, calleeA, rootB, calleeB, rootC, calleeC];
    const edges = [
      makeCallEdge(rootA, calleeA, 1),
      makeCallEdge(rootB, calleeB, 1),
      makeCallEdge(rootC, calleeC, 1),
    ];

    const result = traceFlows({
      repoId: REPO,
      symbols,
      edges,
      globalMembershipCap: 3,
    });

    expect(result.entryPointCount).toBe(3);
    expect(result.flows).toHaveLength(1);
    expect(result.memberships).toHaveLength(2);
    expect(result.globalCapReached).toBe(true);
  });
});

describe('traceFlows: criticality component math', () => {
  it('matches hand-computed component values on a small fixture', () => {
    // Call graph: main -> helperA, main -> checkAuthToken, helperA -> helperB,
    // helperB -> (unresolved external call).
    //
    // Members: main, helperA, checkAuthToken, helperB (4 total).
    // Files: main.ts (main), helperA.ts (helperA + checkAuthToken), helperB.ts
    // (helperB) -> 3 distinct files / 4 members = fileSpreadRatio 0.75.
    // Security keyword: only "checkAuthToken" matches (contains "token") ->
    // 1/4 = 0.25.
    // Test gap: only "main" has TESTED_BY coverage -> 3/4 untested = 0.75.
    // External call ratio: 4 total outgoing CALLS from members (main->helperA,
    // main->checkAuthToken, helperA->helperB, helperB->null), 1 unresolved ->
    // 1/4 = 0.25.
    // Depth: main=0, helperA=1, checkAuthToken=1, helperB=2 -> maxDepth=2,
    // depthRatio = 2/15 rounded to 0.133.
    //
    // criticality = 0.75*0.30 + 0.25*0.20 + 0.25*0.25 + 0.75*0.15 + 0.133*0.10
    //             = 0.225 + 0.05 + 0.0625 + 0.1125 + 0.0133 = 0.4633 -> 0.463
    const main = makeSymbol({ relativePath: 'src/main.ts', name: 'main' });
    const helperA = makeSymbol({
      relativePath: 'src/helperA.ts',
      name: 'helperA',
    });
    const checkAuthToken = makeSymbol({
      relativePath: 'src/helperA.ts',
      name: 'checkAuthToken',
      index: 1,
    });
    const helperB = makeSymbol({
      relativePath: 'src/helperB.ts',
      name: 'helperB',
    });
    const testFile = makeSymbol({
      relativePath: 'src/main.test.ts',
      name: 'main.test.ts',
      kind: 'file',
    });

    expect(
      CODE_GRAPH_SECURITY_KEYWORD_PATTERN.test(checkAuthToken.qualifiedName),
    ).toBe(true);
    expect(
      CODE_GRAPH_SECURITY_KEYWORD_PATTERN.test(helperA.qualifiedName),
    ).toBe(false);

    const symbols = [main, helperA, checkAuthToken, helperB, testFile];
    const edges: CodeGraphEdgeRecord[] = [
      makeCallEdge(main, helperA, 1),
      makeCallEdge(main, checkAuthToken, 2),
      makeCallEdge(helperA, helperB, 1),
      makeCallEdge(helperB, null, 1, 'external:fetch'),
      makeEdge('TESTED_BY', main, testFile, null),
    ];

    const result = traceFlows({ repoId: REPO, symbols, edges });
    const flow = flowFor(result, main);
    expect(flow).toBeDefined();
    expect(flow?.symbolCount).toBe(4);
    expect(flow?.fileSpread).toBe(3);
    expect(flow?.maxDepth).toBe(2);

    expect(flow?.extra.criticalityComponents).toEqual({
      fileSpreadRatio: 0.75,
      externalCallRatio: 0.25,
      securityKeywordFraction: 0.25,
      testGapFraction: 0.75,
      depthRatio: 0.133,
    });

    expect(flow?.criticality).toBeCloseTo(0.463, 3);
  });
});

describe('security-keyword reuse (no drift)', () => {
  it("flows.ts's securityKeywordFraction counts exactly what the shared change-impact pattern matches", () => {
    const main = makeSymbol({ relativePath: 'src/main.ts', name: 'main' });
    const withSecret = makeSymbol({
      relativePath: 'src/secretStore.ts',
      name: 'getSecretValue',
    });
    const withoutKeyword = makeSymbol({
      relativePath: 'src/plain.ts',
      name: 'plainHelper',
    });

    expect(
      CODE_GRAPH_SECURITY_KEYWORD_PATTERN.test(withSecret.qualifiedName),
    ).toBe(true);
    expect(
      CODE_GRAPH_SECURITY_KEYWORD_PATTERN.test(withoutKeyword.qualifiedName),
    ).toBe(false);

    const symbols = [main, withSecret, withoutKeyword];
    const edges = [
      makeCallEdge(main, withSecret, 1),
      makeCallEdge(main, withoutKeyword, 2),
    ];

    const result = traceFlows({ repoId: REPO, symbols, edges });
    const flow = flowFor(result, main);
    // 3 members total (main, withSecret, withoutKeyword); exactly 1 matches
    // the shared pattern -> securityKeywordFraction = 1/3 = 0.333.
    expect(flow?.extra.criticalityComponents).toEqual({
      fileSpreadRatio: 1,
      externalCallRatio: 0,
      securityKeywordFraction: 0.333,
      testGapFraction: 1,
      depthRatio: 0.067,
    });
  });
});

describe('traceFlows: flow id and name', () => {
  it('names the flow after the entry symbol qualifiedName and mints a flow_-prefixed id', () => {
    const main = makeSymbol({ relativePath: 'src/main.ts', name: 'main' });
    const result = traceFlows({ repoId: REPO, symbols: [main], edges: [] });
    const flow = flowFor(result, main);
    expect(flow).toBeDefined();
    expect(flow?.name).toBe(main.qualifiedName);
    expect(flow?.id.startsWith('flow_')).toBe(true);
  });
});

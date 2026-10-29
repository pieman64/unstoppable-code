import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import { resolveIpcEdges } from '../resolve/ipc-resolver';
import { CodeGraphEngine } from '../engine';
import { edgeRowId, fileQualifiedName, fileRowId, symbolRowId } from '../ids';
import type {
  CodeGraphEdgeRecord,
  CodeGraphFileFacts,
  CodeGraphSymbolRecord,
} from '../../../types/code-graph';

const REPO_A = 'repo-a';
const REPO_B = 'repo-b';

function fileSymbol(
  repoId: string,
  relativePath: string,
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

function ipcChannelSymbol(
  repoId: string,
  relativePath: string,
  key: string,
  line: number,
): CodeGraphSymbolRecord {
  const qualifiedName = `${fileQualifiedName(relativePath)}::ipc.${key}`;
  return {
    id: symbolRowId(repoId, qualifiedName),
    repositoryId: repoId,
    fileId: fileRowId(repoId, relativePath),
    kind: 'ipc_channel',
    name: key,
    qualifiedName,
    parentSymbolId: null,
    lineStart: line,
    lineEnd: line,
    byteStart: 0,
    byteEnd: 10,
    signature: `${key}:channel`,
    exported: false,
    isTest: false,
    extra: {},
  };
}

function facts(
  repoId: string,
  relativePath: string,
  symbols: CodeGraphSymbolRecord[],
  edges: CodeGraphEdgeRecord[],
): CodeGraphFileFacts {
  return {
    file: {
      id: fileRowId(repoId, relativePath),
      repositoryId: repoId,
      relativePath,
      absolutePath: `/abs/${repoId}/${relativePath}`,
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

function ipcEdge(input: {
  repoId: string;
  kind: 'IPC_HANDLES' | 'IPC_INVOKES';
  relativePath: string;
  sourceSymbolId: string;
  key: string;
  line: number;
}): CodeGraphEdgeRecord {
  const targetRef = `ipc:${input.key}`;
  return {
    id: edgeRowId({
      repoId: input.repoId,
      kind: input.kind,
      sourceId: input.sourceSymbolId,
      target: targetRef,
      line: input.line,
    }),
    repositoryId: input.repoId,
    kind: input.kind,
    sourceSymbolId: input.sourceSymbolId,
    targetSymbolId: null,
    sourceFileId: fileRowId(input.repoId, input.relativePath),
    targetRef,
    line: input.line,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1.0,
    resolverId: null,
    evidence: { callee: 'registerIpcHandler' },
  };
}

describe('resolveIpcEdges', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-ipcres-'));
    db = openCodeGraphDatabase(path.join(dir, 'graph.db'));
    runCodeGraphMigrations(db);
    store = new CodeGraphStore(db);
    store.upsertRepository({ repoId: REPO_A, rootPath: '/abs', gitHead: null });
    store.upsertRepository({ repoId: REPO_B, rootPath: '/abs', gitHead: null });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('binds a handler edge and an invoker edge to the single matching channel symbol', () => {
    const typesFile = fileSymbol(REPO_A, 'src/shared/types.ts');
    const channel = ipcChannelSymbol(
      REPO_A,
      'src/shared/types.ts',
      'fooLoad',
      2,
    );
    store.replaceFileFacts(
      facts(REPO_A, 'src/shared/types.ts', [typesFile, channel], []),
    );

    const registerFile = fileSymbol(REPO_A, 'src/main/ipc/register.ts');
    const handlesEdge = ipcEdge({
      repoId: REPO_A,
      kind: 'IPC_HANDLES',
      relativePath: 'src/main/ipc/register.ts',
      sourceSymbolId: registerFile.id,
      key: 'fooLoad',
      line: 3,
    });
    store.replaceFileFacts(
      facts(REPO_A, 'src/main/ipc/register.ts', [registerFile], [handlesEdge]),
    );

    const preloadFile = fileSymbol(REPO_A, 'src/preload/index.ts');
    const invokesEdge = ipcEdge({
      repoId: REPO_A,
      kind: 'IPC_INVOKES',
      relativePath: 'src/preload/index.ts',
      sourceSymbolId: preloadFile.id,
      key: 'fooLoad',
      line: 4,
    });
    store.replaceFileFacts(
      facts(REPO_A, 'src/preload/index.ts', [preloadFile], [invokesEdge]),
    );

    const resolved = resolveIpcEdges({ store, repoId: REPO_A });
    expect(resolved).toBe(2);

    const boundHandles = store.listEdges({
      kind: 'IPC_HANDLES',
      repoId: REPO_A,
    });
    expect(boundHandles).toHaveLength(1);
    expect(boundHandles[0].targetSymbolId).toBe(channel.id);
    expect(boundHandles[0].confidenceTier).toBe('RESOLVED');
    expect(boundHandles[0].confidenceScore).toBe(0.95);
    expect(boundHandles[0].resolverId).toBe('ipc-channel');
    expect(boundHandles[0].evidence.resolvedPath).toBe('src/shared/types.ts');
    // Prior evidence is preserved, not clobbered.
    expect(boundHandles[0].evidence.callee).toBe('registerIpcHandler');

    const boundInvokes = store.listEdges({
      kind: 'IPC_INVOKES',
      repoId: REPO_A,
    });
    expect(boundInvokes).toHaveLength(1);
    expect(boundInvokes[0].targetSymbolId).toBe(channel.id);
    expect(boundInvokes[0].resolverId).toBe('ipc-channel');
  });

  it('leaves an edge referencing an unknown channel key unresolved', () => {
    const registerFile = fileSymbol(REPO_A, 'src/main/ipc/register.ts');
    const edge = ipcEdge({
      repoId: REPO_A,
      kind: 'IPC_HANDLES',
      relativePath: 'src/main/ipc/register.ts',
      sourceSymbolId: registerFile.id,
      key: 'typoedKey',
      line: 3,
    });
    store.replaceFileFacts(
      facts(REPO_A, 'src/main/ipc/register.ts', [registerFile], [edge]),
    );

    const resolved = resolveIpcEdges({ store, repoId: REPO_A });
    expect(resolved).toBe(0);

    const edges = store.listEdges({ kind: 'IPC_HANDLES', repoId: REPO_A });
    expect(edges[0].targetSymbolId).toBeNull();
    expect(edges[0].confidenceTier).toBe('EXTRACTED');
    expect(edges[0].resolverId).toBeNull();
    expect(edges[0].evidence.candidates).toBeUndefined();
  });

  it('leaves an edge unresolved and records candidate count when two files declare the same channel key', () => {
    const typesFile = fileSymbol(REPO_A, 'src/shared/types.ts');
    const channelOne = ipcChannelSymbol(
      REPO_A,
      'src/shared/types.ts',
      'dupKey',
      2,
    );
    const otherTypesFile = fileSymbol(REPO_A, 'src/shared/other-types.ts');
    const channelTwo = ipcChannelSymbol(
      REPO_A,
      'src/shared/other-types.ts',
      'dupKey',
      5,
    );
    store.replaceFileFacts(
      facts(REPO_A, 'src/shared/types.ts', [typesFile, channelOne], []),
    );
    store.replaceFileFacts(
      facts(
        REPO_A,
        'src/shared/other-types.ts',
        [otherTypesFile, channelTwo],
        [],
      ),
    );

    const registerFile = fileSymbol(REPO_A, 'src/main/ipc/register.ts');
    const edge = ipcEdge({
      repoId: REPO_A,
      kind: 'IPC_HANDLES',
      relativePath: 'src/main/ipc/register.ts',
      sourceSymbolId: registerFile.id,
      key: 'dupKey',
      line: 3,
    });
    store.replaceFileFacts(
      facts(REPO_A, 'src/main/ipc/register.ts', [registerFile], [edge]),
    );

    const resolved = resolveIpcEdges({ store, repoId: REPO_A });
    expect(resolved).toBe(0);

    const edges = store.listEdges({ kind: 'IPC_HANDLES', repoId: REPO_A });
    expect(edges[0].targetSymbolId).toBeNull();
    expect(edges[0].confidenceTier).toBe('EXTRACTED');
    expect(edges[0].resolverId).toBeNull();
    expect(edges[0].evidence.candidates).toBe(2);
    // Prior evidence is preserved alongside the new candidates field.
    expect(edges[0].evidence.callee).toBe('registerIpcHandler');
  });

  it("does not bind across repositories: a same-key channel declared only in repo-b never binds repo-a's edge", () => {
    const otherRepoFile = fileSymbol(REPO_B, 'src/shared/types.ts');
    const otherRepoChannel = ipcChannelSymbol(
      REPO_B,
      'src/shared/types.ts',
      'sharedKey',
      2,
    );
    store.replaceFileFacts(
      facts(
        REPO_B,
        'src/shared/types.ts',
        [otherRepoFile, otherRepoChannel],
        [],
      ),
    );

    const registerFile = fileSymbol(REPO_A, 'src/main/ipc/register.ts');
    const edge = ipcEdge({
      repoId: REPO_A,
      kind: 'IPC_HANDLES',
      relativePath: 'src/main/ipc/register.ts',
      sourceSymbolId: registerFile.id,
      key: 'sharedKey',
      line: 3,
    });
    store.replaceFileFacts(
      facts(REPO_A, 'src/main/ipc/register.ts', [registerFile], [edge]),
    );

    const resolvedA = resolveIpcEdges({ store, repoId: REPO_A });
    expect(resolvedA).toBe(0);
    const edgesA = store.listEdges({ kind: 'IPC_HANDLES', repoId: REPO_A });
    expect(edgesA[0].targetSymbolId).toBeNull();

    // repo-b itself has no IPC_HANDLES/IPC_INVOKES edges, so resolving it is a no-op.
    const resolvedB = resolveIpcEdges({ store, repoId: REPO_B });
    expect(resolvedB).toBe(0);
  });

  it('is idempotent: a second run resolves nothing further and leaves bound edges untouched', () => {
    const typesFile = fileSymbol(REPO_A, 'src/shared/types.ts');
    const channel = ipcChannelSymbol(
      REPO_A,
      'src/shared/types.ts',
      'fooLoad',
      2,
    );
    store.replaceFileFacts(
      facts(REPO_A, 'src/shared/types.ts', [typesFile, channel], []),
    );
    const registerFile = fileSymbol(REPO_A, 'src/main/ipc/register.ts');
    const edge = ipcEdge({
      repoId: REPO_A,
      kind: 'IPC_HANDLES',
      relativePath: 'src/main/ipc/register.ts',
      sourceSymbolId: registerFile.id,
      key: 'fooLoad',
      line: 3,
    });
    store.replaceFileFacts(
      facts(REPO_A, 'src/main/ipc/register.ts', [registerFile], [edge]),
    );

    expect(resolveIpcEdges({ store, repoId: REPO_A })).toBe(1);
    expect(resolveIpcEdges({ store, repoId: REPO_A })).toBe(0);

    const edges = store.listEdges({ kind: 'IPC_HANDLES', repoId: REPO_A });
    expect(edges[0].targetSymbolId).toBe(channel.id);
    expect(edges[0].resolverId).toBe('ipc-channel');
  });
});

describe('CodeGraphEngine IPC resolution wiring (end to end)', () => {
  let root: string;
  let dbPath: string;
  let engine: CodeGraphEngine;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-ipcres-engine-'));
    mkdirSync(path.join(root, 'src', 'shared'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'main', 'ipc'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'preload'), { recursive: true });
    dbPath = path.join(root, '.graph', 'graph.db');
    engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: 'fixture', rootPath: root }],
    });
  });

  afterEach(() => {
    engine.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('binds IPC_HANDLES/IPC_INVOKES edges to their channel declaration after a real build', async () => {
    writeFileSync(
      path.join(root, 'src', 'shared', 'types.ts'),
      `export const IPC_CHANNELS = {
  fooLoad: 'foo:load',
  barSave: 'bar:save',
} as const;
`,
    );
    writeFileSync(
      path.join(root, 'src', 'main', 'ipc', 'register.ts'),
      `import { IPC_CHANNELS } from '../../shared/types';

export function registerIpcHandler(channel: string, handler: () => void): void {}

export function registerHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.fooLoad, () => {});
}
`,
    );
    // declare-const shim instead of an electron import: the extractor keys on
    // callee text alone, and a literal electron specifier (even inside a
    // template string) trips the regex-based check:electron-boundary scanner.
    writeFileSync(
      path.join(root, 'src', 'preload', 'index.ts'),
      `declare const ipcRenderer: { invoke: Function; send: Function; on: Function };
import { IPC_CHANNELS } from '../shared/types';

export const api = {
  loadFoo: () => ipcRenderer.invoke(IPC_CHANNELS.fooLoad),
};
`,
    );

    const result = await engine.buildOrUpdate();
    expect(result.parseFailures).toBe(0);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const typesFileId = fileRowId('fixture', 'src/shared/types.ts');
      const channelSymbol = store
        .listSymbolsForFile(typesFileId)
        .find((s) => s.kind === 'ipc_channel' && s.name === 'fooLoad');
      expect(channelSymbol).toBeDefined();

      const handlesEdges = store.listEdges({
        kind: 'IPC_HANDLES',
        repoId: 'fixture',
      });
      expect(handlesEdges).toHaveLength(1);
      expect(handlesEdges[0].targetSymbolId).toBe(channelSymbol?.id);
      expect(handlesEdges[0].confidenceTier).toBe('RESOLVED');
      expect(handlesEdges[0].resolverId).toBe('ipc-channel');
      expect(handlesEdges[0].evidence.resolvedPath).toBe('src/shared/types.ts');

      const invokesEdges = store.listEdges({
        kind: 'IPC_INVOKES',
        repoId: 'fixture',
      });
      expect(invokesEdges).toHaveLength(1);
      expect(invokesEdges[0].targetSymbolId).toBe(channelSymbol?.id);
      expect(invokesEdges[0].resolverId).toBe('ipc-channel');

      // Re-running the build is idempotent: same bindings, no duplication.
      await engine.buildOrUpdate();
      const handlesAfterRebuild = store.listEdges({
        kind: 'IPC_HANDLES',
        repoId: 'fixture',
      });
      expect(handlesAfterRebuild).toHaveLength(1);
      expect(handlesAfterRebuild[0].targetSymbolId).toBe(channelSymbol?.id);
    } finally {
      db.close();
    }
  });

  it('leaves a key declared by two different registries in the same repo unresolved with candidates evidence (P6 collision honesty)', async () => {
    // Resolver keying is `ipc:<key>` regardless of which registry constant
    // declared the key, so a key collision ACROSS registries is exactly as
    // ambiguous as the same-registry duplicate case: binding to either
    // declaration would be a guess.
    writeFileSync(
      path.join(root, 'src', 'shared', 'types.ts'),
      `export const IPC_CHANNELS = {
  dupKey: 'dup:one',
} as const;
`,
    );
    writeFileSync(
      path.join(root, 'src', 'shared', 'skill-channels.ts'),
      `export const SKILLS_CHANNELS = {
  dupKey: 'dup:two',
} as const;
`,
    );
    writeFileSync(
      path.join(root, 'src', 'main', 'ipc', 'register.ts'),
      `import { SKILLS_CHANNELS } from '../../shared/skill-channels';

export function registerIpcHandler(channel: string, handler: () => void): void {}

export function registerHandlers(): void {
  registerIpcHandler(SKILLS_CHANNELS.dupKey, () => {});
}
`,
    );

    const result = await engine.buildOrUpdate();
    expect(result.parseFailures).toBe(0);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const handlesEdges = store.listEdges({
        kind: 'IPC_HANDLES',
        repoId: 'fixture',
      });
      expect(handlesEdges).toHaveLength(1);
      expect(handlesEdges[0].targetRef).toBe('ipc:dupKey');
      expect(handlesEdges[0].targetSymbolId).toBeNull();
      expect(handlesEdges[0].confidenceTier).toBe('EXTRACTED');
      expect(handlesEdges[0].resolverId).toBeNull();
      expect(handlesEdges[0].evidence.candidates).toBe(2);
      expect(handlesEdges[0].evidence.registry).toBe('SKILLS_CHANNELS');
    } finally {
      db.close();
    }
  });
});

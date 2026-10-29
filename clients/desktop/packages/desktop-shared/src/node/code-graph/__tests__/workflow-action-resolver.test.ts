import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  openCodeGraphDatabase,
  type CodeGraphDatabase,
} from '../store/database';
import { runCodeGraphMigrations } from '../store/migrations';
import { CodeGraphStore } from '../store/graph-store';
import { resolveWorkflowActionEdges } from '../resolve/workflow-action-resolver';
import { CodeGraphEngine } from '../engine';
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

const REPO_A = 'repo-a';
const REPO_B = 'repo-b';
const WORKFLOW_PATH = '.github/workflows/ci.yml';

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

function workflowJobSymbol(
  repoId: string,
  relativePath: string,
  name: string,
): CodeGraphSymbolRecord {
  const qualifiedName = symbolQualifiedName(relativePath, ['jobs'], name);
  return {
    id: symbolRowId(repoId, qualifiedName),
    repositoryId: repoId,
    fileId: fileRowId(repoId, relativePath),
    kind: 'workflow_job',
    name,
    qualifiedName,
    parentSymbolId: null,
    lineStart: 2,
    lineEnd: 5,
    byteStart: 0,
    byteEnd: 0,
    signature: null,
    exported: false,
    isTest: false,
    extra: {},
  };
}

function facts(
  repoId: string,
  relativePath: string,
  language: string,
  symbols: CodeGraphSymbolRecord[],
  edges: CodeGraphEdgeRecord[],
): CodeGraphFileFacts {
  return {
    file: {
      id: fileRowId(repoId, relativePath),
      repositoryId: repoId,
      relativePath,
      absolutePath: `/abs/${repoId}/${relativePath}`,
      language,
      contentHash: 'h',
      sizeBytes: 100,
      mtimeNs: '1',
      lineCount: 10,
      grammarId: language,
      grammarAbi: null,
      parseStatus: 'parsed',
      hasErrors: false,
      updatedAt: Date.now(),
    },
    symbols,
    edges,
  };
}

function usesEdge(input: {
  repoId: string;
  jobSymbolId: string;
  targetRef: string;
  stepIndex: number;
  line: number;
}): CodeGraphEdgeRecord {
  return {
    id: edgeRowId({
      repoId: input.repoId,
      kind: 'USES_PIPELINE_ACTION',
      sourceId: input.jobSymbolId,
      target: `${input.targetRef}#${input.stepIndex}`,
      line: input.line,
    }),
    repositoryId: input.repoId,
    kind: 'USES_PIPELINE_ACTION',
    sourceSymbolId: input.jobSymbolId,
    targetSymbolId: null,
    sourceFileId: fileRowId(input.repoId, WORKFLOW_PATH),
    targetRef: input.targetRef,
    line: input.line,
    confidenceTier: 'EXTRACTED',
    confidenceScore: 1.0,
    resolverId: null,
    evidence: { stepIndex: input.stepIndex },
  };
}

describe('resolveWorkflowActionEdges', () => {
  let dir: string;
  let db: CodeGraphDatabase;
  let store: CodeGraphStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'code-graph-workflowres-'));
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

  it('binds a local uses: ref to the single matching action.yml file symbol', () => {
    const job = workflowJobSymbol(REPO_A, WORKFLOW_PATH, 'build');
    const edge = usesEdge({
      repoId: REPO_A,
      jobSymbolId: job.id,
      targetRef: './.github/actions/local-thing',
      stepIndex: 2,
      line: 12,
    });
    store.replaceFileFacts(
      facts(REPO_A, WORKFLOW_PATH, 'github-workflow', [job], [edge]),
    );

    const manifestPath = '.github/actions/local-thing/action.yml';
    const manifest = fileSymbol(REPO_A, manifestPath);
    store.replaceFileFacts(
      facts(REPO_A, manifestPath, 'github-action-manifest', [manifest], []),
    );

    const resolved = resolveWorkflowActionEdges({ store, repoId: REPO_A });
    expect(resolved).toBe(1);

    const bound = store.listEdges({
      kind: 'USES_PIPELINE_ACTION',
      repoId: REPO_A,
    })[0];
    expect(bound.targetSymbolId).toBe(manifest.id);
    expect(bound.confidenceTier).toBe('RESOLVED');
    expect(bound.confidenceScore).toBe(0.95);
    expect(bound.resolverId).toBe('workflow-action');
    expect(bound.evidence.resolvedPath).toBe(manifestPath);
    // Prior evidence (stepIndex) is preserved, not clobbered.
    expect(bound.evidence.stepIndex).toBe(2);
  });

  it('binds to action.yaml when only that extension exists', () => {
    const job = workflowJobSymbol(REPO_A, WORKFLOW_PATH, 'build');
    const edge = usesEdge({
      repoId: REPO_A,
      jobSymbolId: job.id,
      targetRef: './.github/actions/local-thing',
      stepIndex: 0,
      line: 9,
    });
    store.replaceFileFacts(
      facts(REPO_A, WORKFLOW_PATH, 'github-workflow', [job], [edge]),
    );

    const manifestPath = '.github/actions/local-thing/action.yaml';
    const manifest = fileSymbol(REPO_A, manifestPath);
    store.replaceFileFacts(
      facts(REPO_A, manifestPath, 'github-action-manifest', [manifest], []),
    );

    const resolved = resolveWorkflowActionEdges({ store, repoId: REPO_A });
    expect(resolved).toBe(1);
    const bound = store.listEdges({
      kind: 'USES_PIPELINE_ACTION',
      repoId: REPO_A,
    })[0];
    expect(bound.targetSymbolId).toBe(manifest.id);
    expect(bound.evidence.resolvedPath).toBe(manifestPath);
  });

  it('resolves a bare `uses: ./` local ref to the repository-root action.yml', () => {
    const job = workflowJobSymbol(REPO_A, WORKFLOW_PATH, 'build');
    const edge = usesEdge({
      repoId: REPO_A,
      jobSymbolId: job.id,
      targetRef: './',
      stepIndex: 0,
      line: 9,
    });
    store.replaceFileFacts(
      facts(REPO_A, WORKFLOW_PATH, 'github-workflow', [job], [edge]),
    );

    const manifest = fileSymbol(REPO_A, 'action.yml');
    store.replaceFileFacts(
      facts(REPO_A, 'action.yml', 'github-action-manifest', [manifest], []),
    );

    const resolved = resolveWorkflowActionEdges({ store, repoId: REPO_A });
    expect(resolved).toBe(1);
    const bound = store.listEdges({
      kind: 'USES_PIPELINE_ACTION',
      repoId: REPO_A,
    })[0];
    expect(bound.targetSymbolId).toBe(manifest.id);
    expect(bound.evidence.resolvedPath).toBe('action.yml');
  });

  it('leaves an external ref unresolved (owner/repo@ref)', () => {
    const job = workflowJobSymbol(REPO_A, WORKFLOW_PATH, 'build');
    const edge = usesEdge({
      repoId: REPO_A,
      jobSymbolId: job.id,
      targetRef: 'actions/checkout@v4',
      stepIndex: 0,
      line: 9,
    });
    store.replaceFileFacts(
      facts(REPO_A, WORKFLOW_PATH, 'github-workflow', [job], [edge]),
    );

    const resolved = resolveWorkflowActionEdges({ store, repoId: REPO_A });
    expect(resolved).toBe(0);
    const bound = store.listEdges({
      kind: 'USES_PIPELINE_ACTION',
      repoId: REPO_A,
    })[0];
    expect(bound.targetSymbolId).toBeNull();
    expect(bound.confidenceTier).toBe('EXTRACTED');
    expect(bound.resolverId).toBeNull();
  });

  it('leaves a docker:// ref unresolved', () => {
    const job = workflowJobSymbol(REPO_A, WORKFLOW_PATH, 'build');
    const edge = usesEdge({
      repoId: REPO_A,
      jobSymbolId: job.id,
      targetRef: 'docker://alpine:3.19',
      stepIndex: 0,
      line: 9,
    });
    store.replaceFileFacts(
      facts(REPO_A, WORKFLOW_PATH, 'github-workflow', [job], [edge]),
    );

    const resolved = resolveWorkflowActionEdges({ store, repoId: REPO_A });
    expect(resolved).toBe(0);
    expect(
      store.listEdges({ kind: 'USES_PIPELINE_ACTION', repoId: REPO_A })[0]
        .targetSymbolId,
    ).toBeNull();
  });

  it('leaves a local ref unresolved when no manifest file symbol exists in the graph (untracked/missing)', () => {
    const job = workflowJobSymbol(REPO_A, WORKFLOW_PATH, 'build');
    const edge = usesEdge({
      repoId: REPO_A,
      jobSymbolId: job.id,
      targetRef: './.github/actions/nonexistent',
      stepIndex: 0,
      line: 9,
    });
    store.replaceFileFacts(
      facts(REPO_A, WORKFLOW_PATH, 'github-workflow', [job], [edge]),
    );

    const resolved = resolveWorkflowActionEdges({ store, repoId: REPO_A });
    expect(resolved).toBe(0);
    const bound = store.listEdges({
      kind: 'USES_PIPELINE_ACTION',
      repoId: REPO_A,
    })[0];
    expect(bound.targetSymbolId).toBeNull();
    expect(bound.evidence.candidates).toBeUndefined();
  });

  it('leaves a local ref unresolved and records candidate count when both action.yml and action.yaml exist for the same directory', () => {
    const job = workflowJobSymbol(REPO_A, WORKFLOW_PATH, 'build');
    const edge = usesEdge({
      repoId: REPO_A,
      jobSymbolId: job.id,
      targetRef: './.github/actions/ambiguous',
      stepIndex: 0,
      line: 9,
    });
    store.replaceFileFacts(
      facts(REPO_A, WORKFLOW_PATH, 'github-workflow', [job], [edge]),
    );

    const ymlPath = '.github/actions/ambiguous/action.yml';
    const yamlPath = '.github/actions/ambiguous/action.yaml';
    store.replaceFileFacts(
      facts(
        REPO_A,
        ymlPath,
        'github-action-manifest',
        [fileSymbol(REPO_A, ymlPath)],
        [],
      ),
    );
    store.replaceFileFacts(
      facts(
        REPO_A,
        yamlPath,
        'github-action-manifest',
        [fileSymbol(REPO_A, yamlPath)],
        [],
      ),
    );

    const resolved = resolveWorkflowActionEdges({ store, repoId: REPO_A });
    expect(resolved).toBe(0);
    const bound = store.listEdges({
      kind: 'USES_PIPELINE_ACTION',
      repoId: REPO_A,
    })[0];
    expect(bound.targetSymbolId).toBeNull();
    expect(bound.confidenceTier).toBe('EXTRACTED');
    expect(bound.resolverId).toBeNull();
    expect(bound.evidence.candidates).toBe(2);
    // Prior evidence preserved alongside the new candidates field.
    expect(bound.evidence.stepIndex).toBe(0);
  });

  it('leaves a ref escaping the repository root unresolved (./../outside)', () => {
    const job = workflowJobSymbol(REPO_A, WORKFLOW_PATH, 'build');
    const edge = usesEdge({
      repoId: REPO_A,
      jobSymbolId: job.id,
      targetRef: './../outside',
      stepIndex: 0,
      line: 9,
    });
    store.replaceFileFacts(
      facts(REPO_A, WORKFLOW_PATH, 'github-workflow', [job], [edge]),
    );

    const resolved = resolveWorkflowActionEdges({ store, repoId: REPO_A });
    expect(resolved).toBe(0);
  });

  it("does not bind across repositories: a same-path manifest declared only in repo-b never binds repo-a's edge", () => {
    const manifestPath = '.github/actions/local-thing/action.yml';
    const otherRepoManifest = fileSymbol(REPO_B, manifestPath);
    store.replaceFileFacts(
      facts(
        REPO_B,
        manifestPath,
        'github-action-manifest',
        [otherRepoManifest],
        [],
      ),
    );

    const job = workflowJobSymbol(REPO_A, WORKFLOW_PATH, 'build');
    const edge = usesEdge({
      repoId: REPO_A,
      jobSymbolId: job.id,
      targetRef: './.github/actions/local-thing',
      stepIndex: 0,
      line: 9,
    });
    store.replaceFileFacts(
      facts(REPO_A, WORKFLOW_PATH, 'github-workflow', [job], [edge]),
    );

    const resolvedA = resolveWorkflowActionEdges({ store, repoId: REPO_A });
    expect(resolvedA).toBe(0);
    expect(
      store.listEdges({ kind: 'USES_PIPELINE_ACTION', repoId: REPO_A })[0]
        .targetSymbolId,
    ).toBeNull();
  });

  it('is idempotent: a second run resolves nothing further and leaves the bound edge untouched', () => {
    const job = workflowJobSymbol(REPO_A, WORKFLOW_PATH, 'build');
    const edge = usesEdge({
      repoId: REPO_A,
      jobSymbolId: job.id,
      targetRef: './.github/actions/local-thing',
      stepIndex: 0,
      line: 9,
    });
    store.replaceFileFacts(
      facts(REPO_A, WORKFLOW_PATH, 'github-workflow', [job], [edge]),
    );
    const manifestPath = '.github/actions/local-thing/action.yml';
    const manifest = fileSymbol(REPO_A, manifestPath);
    store.replaceFileFacts(
      facts(REPO_A, manifestPath, 'github-action-manifest', [manifest], []),
    );

    expect(resolveWorkflowActionEdges({ store, repoId: REPO_A })).toBe(1);
    expect(resolveWorkflowActionEdges({ store, repoId: REPO_A })).toBe(0);

    const bound = store.listEdges({
      kind: 'USES_PIPELINE_ACTION',
      repoId: REPO_A,
    })[0];
    expect(bound.targetSymbolId).toBe(manifest.id);
    expect(bound.resolverId).toBe('workflow-action');
  });

  it('is idempotent for an ambiguous edge too: a second run still resolves nothing new', () => {
    const job = workflowJobSymbol(REPO_A, WORKFLOW_PATH, 'build');
    const edge = usesEdge({
      repoId: REPO_A,
      jobSymbolId: job.id,
      targetRef: './.github/actions/ambiguous',
      stepIndex: 0,
      line: 9,
    });
    store.replaceFileFacts(
      facts(REPO_A, WORKFLOW_PATH, 'github-workflow', [job], [edge]),
    );
    const ymlPath = '.github/actions/ambiguous/action.yml';
    const yamlPath = '.github/actions/ambiguous/action.yaml';
    store.replaceFileFacts(
      facts(
        REPO_A,
        ymlPath,
        'github-action-manifest',
        [fileSymbol(REPO_A, ymlPath)],
        [],
      ),
    );
    store.replaceFileFacts(
      facts(
        REPO_A,
        yamlPath,
        'github-action-manifest',
        [fileSymbol(REPO_A, yamlPath)],
        [],
      ),
    );

    expect(resolveWorkflowActionEdges({ store, repoId: REPO_A })).toBe(0);
    expect(resolveWorkflowActionEdges({ store, repoId: REPO_A })).toBe(0);
    expect(
      store.listEdges({ kind: 'USES_PIPELINE_ACTION', repoId: REPO_A })[0]
        .evidence.candidates,
    ).toBe(2);
  });
});

describe('CodeGraphEngine workflow-action resolution wiring (end to end)', () => {
  let root: string;
  let dbPath: string;
  let engine: CodeGraphEngine;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-workflowres-engine-'));
    mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    mkdirSync(path.join(root, '.github', 'actions', 'local-thing'), {
      recursive: true,
    });
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

  it('resolves a real local uses: ref to its real action.yml file symbol after a real build, leaving the external ref unresolved', async () => {
    writeFileSync(
      path.join(root, '.github', 'workflows', 'ci.yml'),
      `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/local-thing
`,
    );
    writeFileSync(
      path.join(root, '.github', 'actions', 'local-thing', 'action.yml'),
      `name: Local Thing
description: does a thing
runs:
  using: node20
  main: index.js
`,
    );

    const result = await engine.buildOrUpdate();
    expect(result.parseFailures).toBe(0);

    const db = openCodeGraphDatabase(dbPath);
    const store = new CodeGraphStore(db);
    try {
      const manifestFileId = fileRowId(
        'fixture',
        '.github/actions/local-thing/action.yml',
      );
      const manifestSymbol = store
        .listSymbolsForFile(manifestFileId)
        .find((s) => s.kind === 'file');
      expect(manifestSymbol).toBeDefined();

      const usesEdges = store.listEdges({
        kind: 'USES_PIPELINE_ACTION',
        repoId: 'fixture',
      });
      expect(usesEdges).toHaveLength(2);

      const localEdge = usesEdges.find(
        (edge) => edge.targetRef === './.github/actions/local-thing',
      );
      expect(localEdge?.targetSymbolId).toBe(manifestSymbol?.id);
      expect(localEdge?.confidenceTier).toBe('RESOLVED');
      expect(localEdge?.resolverId).toBe('workflow-action');
      expect(localEdge?.evidence.resolvedPath).toBe(
        '.github/actions/local-thing/action.yml',
      );

      const externalEdge = usesEdges.find(
        (edge) => edge.targetRef === 'actions/checkout@v4',
      );
      expect(externalEdge?.targetSymbolId).toBeNull();
      expect(externalEdge?.confidenceTier).toBe('EXTRACTED');

      // Re-running the build is idempotent: same bindings, no duplication.
      await engine.buildOrUpdate();
      const usesEdgesAfterRebuild = store.listEdges({
        kind: 'USES_PIPELINE_ACTION',
        repoId: 'fixture',
      });
      expect(usesEdgesAfterRebuild).toHaveLength(2);
      const localEdgeAfterRebuild = usesEdgesAfterRebuild.find(
        (edge) => edge.targetRef === './.github/actions/local-thing',
      );
      expect(localEdgeAfterRebuild?.targetSymbolId).toBe(manifestSymbol?.id);
    } finally {
      db.close();
    }
  });
});

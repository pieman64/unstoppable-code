import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodeGraphEngine } from '../engine';
import {
  cleanupCodeGraphBaseStaging,
  cloneCompletedCodeGraphDatabase,
  codeGraphBaseVariantHash,
  getCodeGraphBaseVariantDir,
  hasPublishedCodeGraphBaseForRepository,
  prepareCodeGraphBaseStaging,
  publishCodeGraphBase,
  readLatestPublishedCodeGraphBaseForRepository,
  readPublishedCodeGraphBase,
  readReadonlyCodeGraphSummary,
  readCodeGraphSummaryProjection,
  seedCodeGraphDatabase,
  type ValidatedCodeGraphBase,
} from '../base-graph';
import { fingerprintCustomLanguageInputs } from '../languages/custom-config';
import { requireRow } from '../store/database';

const REPO_ID = 'fixture';
const SOURCE = `export function value(): number { return 42; }\n`;
const GRAPH_CONTENT_TABLES = [
  'repositories',
  'files',
  'symbols',
  'edges',
  'communities',
  'community_memberships',
  'flows',
  'flow_memberships',
  'symbol_fts',
  'symbol_fragment_fts',
] as const;

function tableRows(
  dbPath: string,
  table: string,
): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all()
      .map(requireRow);
  } finally {
    db.close();
  }
}

function normalizedRows(
  dbPath: string,
  table: string,
  options: { ignoreFileMtimes?: boolean } = {},
): Array<Record<string, unknown>> {
  return tableRows(dbPath, table).map((row) => {
    const copy = { ...row };
    delete copy.updated_at;
    if (table === 'repositories') {
      delete copy.root_path;
    }
    if (table === 'files') {
      delete copy.absolute_path;
      if (options.ignoreFileMtimes === true) delete copy.mtime_ns;
    }
    return copy;
  });
}

/**
 * A clone describes another checkout's files, so it clears their mtimes and
 * the next refresh reads and hashes every file.
 */
function expectClearedFileMtimes(dbPath: string): void {
  const mtimes = tableRows(dbPath, 'files').map((row) => row.mtime_ns);
  expect(mtimes.length).toBeGreaterThan(0);
  expect(new Set(mtimes)).toEqual(new Set(['']));
}

function expectRepositoryFilePaths(
  dbPath: string,
  repoId: string,
  rootPath: string,
): void {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT f.absolute_path, f.relative_path
         FROM files f
         JOIN repositories r ON r.id = f.repository_id
         WHERE r.repo_id = ?
         ORDER BY f.relative_path`,
      )
      .all(repoId);
    expect(rows.length).toBeGreaterThan(0);
    for (const value of rows) {
      const row = requireRow(value);
      expect(String(row.absolute_path)).toBe(
        path.join(rootPath, String(row.relative_path)),
      );
    }
  } finally {
    db.close();
  }
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('immutable code-graph bases', () => {
  let root: string;
  let sourceRoot: string;
  let variantDir: string;
  let fingerprint: string;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-base-'));
    sourceRoot = path.join(root, 'source');
    mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
    writeFileSync(path.join(sourceRoot, 'src', 'value.ts'), SOURCE);
    fingerprint = (await fingerprintCustomLanguageInputs(sourceRoot)).value;
    variantDir = getCodeGraphBaseVariantDir(path.join(root, 'shadow'), {
      repoId: REPO_ID,
      customLanguagesFingerprint: fingerprint,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function buildAndPublish(
    generationId: string,
  ): Promise<ValidatedCodeGraphBase> {
    const staging = await prepareCodeGraphBaseStaging({
      variantDir,
      buildId: generationId,
    });
    const engine = await CodeGraphEngine.open({
      dbPath: staging.dbPath,
      repositories: [{ repoId: REPO_ID, rootPath: sourceRoot }],
      worktreeRootPath: sourceRoot,
    });
    try {
      await engine.buildOrUpdate();
    } finally {
      engine.close();
    }
    return publishCodeGraphBase({
      variantDir,
      stagingDir: staging.stagingDir,
      identity: {
        repoId: REPO_ID,
        canonicalRepoRoot: sourceRoot,
        customLanguagesFingerprint: fingerprint,
      },
      gitHead: null,
      generationId,
    });
  }

  it('uses path-safe deterministic variants and recovers from a corrupt pointer', async () => {
    expect(
      codeGraphBaseVariantHash({
        repoId: '../unsafe/id',
        customLanguagesFingerprint: fingerprint,
      }),
    ).toMatch(/^[a-f0-9]{32}$/);
    const published = await buildAndPublish('generation-a');
    const manifest = requireRow(
      JSON.parse(readFileSync(path.join(variantDir, 'current.json'), 'utf8')),
    );
    expect(manifest).toMatchObject({
      generationId: 'generation-a',
      canonicalRepoRoot: sourceRoot,
    });
    await expect(
      readPublishedCodeGraphBase({
        variantDir,
        identity: {
          repoId: REPO_ID,
          canonicalRepoRoot: `${sourceRoot}-wrong`,
          customLanguagesFingerprint: fingerprint,
        },
      }),
    ).resolves.toBeNull();
    writeFileSync(path.join(variantDir, 'current.json'), '{broken');
    const recovered = await readPublishedCodeGraphBase({
      variantDir,
      identity: {
        repoId: REPO_ID,
        canonicalRepoRoot: sourceRoot,
        customLanguagesFingerprint: fingerprint,
      },
    });
    expect(recovered?.recovered).toBe(true);
    expect(recovered?.dbPath).toBe(published.dbPath);
  });

  it('reads counts without migration and selects the newest matching immutable generation', async () => {
    const first = await buildAndPublish('generation-a');
    const summary = readReadonlyCodeGraphSummary(first.dbPath);
    expect(summary).toMatchObject({
      completed: true,
      canonicalRepoRoot: sourceRoot,
      customLanguagesFingerprint: fingerprint,
      repositories: [
        expect.objectContaining({
          repoId: REPO_ID,
          fileCount: 1,
          filesWithErrors: 0,
        }),
      ],
    });
    expect(summary?.repositories[0]?.symbolCount).toBeGreaterThan(0);

    const schemaV1Path = path.join(root, 'schema-v1.db');
    cpSync(first.dbPath, schemaV1Path);
    const schemaV1 = new DatabaseSync(schemaV1Path);
    schemaV1.exec('DROP TABLE communities; DROP TABLE flows;');
    schemaV1
      .prepare(
        "UPDATE graph_metadata SET value = '1' WHERE key = 'schema_version'",
      )
      .run();
    schemaV1.close();
    expect(readReadonlyCodeGraphSummary(schemaV1Path)).toMatchObject({
      schemaVersion: 1,
      repositories: [
        expect.objectContaining({ communityCount: 0, flowCount: 0 }),
      ],
    });

    await buildAndPublish('generation-b');
    await expect(
      readLatestPublishedCodeGraphBaseForRepository({
        shadowDir: path.join(root, 'shadow'),
        repoId: REPO_ID,
        canonicalRepoRoot: sourceRoot,
      }),
    ).resolves.toMatchObject({
      manifest: { generationId: 'generation-b' },
    });
  });

  it('keeps graph-status and per-repository summary count rules distinct', async () => {
    writeFileSync(
      path.join(sourceRoot, 'src', 'other.ts'),
      'export const other = 7;\n',
    );
    const dbPath = path.join(root, 'count-rules', 'graph.db');
    const buildEngine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: REPO_ID, rootPath: sourceRoot }],
      worktreeRootPath: sourceRoot,
    });
    await buildEngine.buildOrUpdate();
    const baselineStatus = buildEngine.getStatus();
    buildEngine.close();

    const baselineSummary = readReadonlyCodeGraphSummary(dbPath);
    if (baselineSummary === null) {
      throw new Error('Expected a summary for the freshly built graph.');
    }
    const baselineRepository = baselineSummary.repositories.find(
      (repository) => repository.repoId === REPO_ID,
    );
    if (baselineRepository === undefined) {
      throw new Error('Expected the built fixture repository in its summary.');
    }

    const unresolvedStatusKinds = [
      'CALLS',
      'IMPORTS_FROM',
      'REFERENCES',
      'DOCUMENTS',
      'IPC_HANDLES',
      'IPC_INVOKES',
      'USES_PIPELINE_ACTION',
    ] as const;
    const otherUnresolvedKinds = [
      'CONTAINS',
      'TESTED_BY',
      'DECLARES_DEPENDENCY',
      'DECLARES_SCRIPT',
      'DECLARES_MCP_TOOL',
      'CONFIGURES',
      'RATIONALE_FOR',
    ] as const;

    const fixtureDb = new DatabaseSync(dbPath);
    try {
      const repository = requireRow(
        fixtureDb
          .prepare('SELECT id FROM repositories WHERE repo_id = ?')
          .get(REPO_ID),
      );
      const repositoryRowId = String(repository.id);
      const fileIds = fixtureDb
        .prepare(
          'SELECT id FROM files WHERE repository_id = ? ORDER BY relative_path',
        )
        .all(repositoryRowId)
        .map((value) => String(requireRow(value).id));
      const firstFileId = fileIds[0];
      const secondFileId = fileIds[1];
      if (firstFileId === undefined || secondFileId === undefined) {
        throw new Error('Expected two real source files in the built graph.');
      }
      const target = requireRow(
        fixtureDb
          .prepare(
            'SELECT id FROM symbols WHERE file_id = ? ORDER BY id LIMIT 1',
          )
          .get(firstFileId),
      );
      if (typeof target.id !== 'string') {
        throw new Error('Expected a real target symbol in the built graph.');
      }

      fixtureDb
        .prepare('UPDATE files SET has_errors = ? WHERE id = ?')
        .run(1, firstFileId);
      fixtureDb
        .prepare('UPDATE files SET has_errors = ? WHERE id = ?')
        .run(2, secondFileId);

      const insertEdge = fixtureDb.prepare(
        `INSERT INTO edges (
          id, repository_id, kind, source_symbol_id, target_symbol_id,
          source_file_id, target_ref, line, confidence_tier,
          confidence_score, resolver_id, evidence_json
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, 1, 'exact', 1, NULL, '{}')`,
      );
      const edgeKinds: readonly string[] = [
        ...unresolvedStatusKinds,
        ...otherUnresolvedKinds,
      ];
      for (const [index, kind] of Array.from(edgeKinds.entries())) {
        insertEdge.run(
          `fixture-unresolved-${index}`,
          repositoryRowId,
          kind,
          null,
          firstFileId,
          `fixture-target-${index}`,
        );
      }
      insertEdge.run(
        'fixture-resolved-call',
        repositoryRowId,
        'CALLS',
        target.id,
        firstFileId,
        'fixture-resolved-target',
      );
    } finally {
      fixtureDb.close();
    }

    const statusEngine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: REPO_ID, rootPath: sourceRoot }],
      worktreeRootPath: sourceRoot,
    });
    const statusAfterFixtures = statusEngine.getStatus();
    statusEngine.close();
    const summaryAfterFixtures = readReadonlyCodeGraphSummary(dbPath);
    if (summaryAfterFixtures === null) {
      throw new Error('Expected a summary after adding count-rule fixtures.');
    }
    const repositoryAfterFixtures = summaryAfterFixtures.repositories.find(
      (repository) => repository.repoId === REPO_ID,
    );
    if (repositoryAfterFixtures === undefined) {
      throw new Error('Expected the fixture repository in its summary.');
    }

    expect(statusAfterFixtures.unresolvedEdgeCount).toBe(
      baselineStatus.unresolvedEdgeCount + unresolvedStatusKinds.length,
    );
    expect(statusAfterFixtures.filesWithErrors).toBe(
      baselineStatus.filesWithErrors + 1,
    );
    expect(repositoryAfterFixtures.unresolvedEdgeCount).toBe(
      baselineRepository.unresolvedEdgeCount +
        unresolvedStatusKinds.length +
        otherUnresolvedKinds.length,
    );
    expect(repositoryAfterFixtures.filesWithErrors).toBe(
      baselineRepository.filesWithErrors + 2,
    );
  });

  it('keeps summary SQL free of integrity checks and per-fact count scans', async () => {
    const published = await buildAndPublish('generation-summary-sql');

    // The spy keeps its default call-through behavior so it records real SQL.
    const prepare = jest.spyOn(DatabaseSync.prototype, 'prepare');
    let statements: string[] = [];
    let summary: ReturnType<typeof readCodeGraphSummaryProjection> | undefined;
    try {
      summary = readCodeGraphSummaryProjection(published.dbPath);
      statements = prepare.mock.calls.map(([sql]): string => sql);
    } finally {
      prepare.mockRestore();
    }

    expect(summary).toMatchObject({ state: 'ready' });
    expect(statements).not.toContain('PRAGMA quick_check');
    expect(statements.filter((sql) => /\bCOUNT\s*\(/i.test(sql))).toEqual([]);
    expect(
      statements.filter((sql) =>
        /\b(?:FROM|JOIN)\s+(?:files|symbols|edges|communities|flows)\b/i.test(
          sql,
        ),
      ),
    ).toEqual([]);
  });

  it('distinguishes an unreadable matching variant from an unrelated variant', async () => {
    const published = await buildAndPublish('generation-a');
    writeFileSync(published.dbPath, 'not a sqlite database');
    writeFileSync(path.join(variantDir, 'current.json'), '{broken');

    await expect(
      readLatestPublishedCodeGraphBaseForRepository({
        shadowDir: path.join(root, 'shadow'),
        repoId: REPO_ID,
        canonicalRepoRoot: sourceRoot,
      }),
    ).resolves.toBeNull();
    await expect(
      hasPublishedCodeGraphBaseForRepository({
        shadowDir: path.join(root, 'shadow'),
        repoId: REPO_ID,
        canonicalRepoRoot: sourceRoot,
        customLanguagesFingerprint: 'different-custom-languages',
      }),
    ).resolves.toBe(false);
    await expect(
      hasPublishedCodeGraphBaseForRepository({
        shadowDir: path.join(root, 'shadow'),
        repoId: REPO_ID,
        canonicalRepoRoot: sourceRoot,
        customLanguagesFingerprint: fingerprint,
      }),
    ).resolves.toBe(true);
    await expect(
      hasPublishedCodeGraphBaseForRepository({
        shadowDir: path.join(root, 'shadow'),
        repoId: 'different-repository',
        canonicalRepoRoot: sourceRoot,
      }),
    ).resolves.toBe(false);
  });

  it('fuses an unchanged base without reparsing and matches a cold build', async () => {
    const published = await buildAndPublish('generation-a');
    const destinationRoot = path.join(root, 'destination');
    cpSync(sourceRoot, destinationRoot, { recursive: true });
    const seededDbPath = path.join(root, 'seeded', 'graph.db');
    const seeded = await seedCodeGraphDatabase({
      targetDbPath: seededDbPath,
      customLanguagesFingerprint: fingerprint,
      sources: [
        {
          dbPath: published.dbPath,
          repoId: REPO_ID,
          canonicalRepoRoot: sourceRoot,
          destinationRootPath: destinationRoot,
          generationId: published.manifest.generationId,
          gitHead: null,
        },
      ],
    });
    expect(seeded.installed).toBe(true);
    expect(seeded.outcomes[0]?.status).toBe('seeded');

    const seededEngine = await CodeGraphEngine.open({
      dbPath: seededDbPath,
      repositories: [{ repoId: REPO_ID, rootPath: destinationRoot }],
      worktreeRootPath: destinationRoot,
    });
    const seededBuild = await seededEngine.buildOrUpdate();
    seededEngine.close();
    expect(seededBuild.filesParsed).toBe(0);
    expect(seededBuild.filesUnchanged).toBe(1);

    const coldDbPath = path.join(root, 'cold', 'graph.db');
    const coldEngine = await CodeGraphEngine.open({
      dbPath: coldDbPath,
      repositories: [{ repoId: REPO_ID, rootPath: destinationRoot }],
      worktreeRootPath: destinationRoot,
    });
    await coldEngine.buildOrUpdate();
    coldEngine.close();

    for (const table of GRAPH_CONTENT_TABLES) {
      expect(normalizedRows(seededDbPath, table)).toEqual(
        normalizedRows(coldDbPath, table),
      );
    }
    expectRepositoryFilePaths(seededDbPath, REPO_ID, destinationRoot);
  });

  it('marks an eager fused seed readable using the source generation timestamp', async () => {
    const published = await buildAndPublish('generation-a');
    const sourceSummary = readCodeGraphSummaryProjection(published.dbPath);
    expect(sourceSummary).toMatchObject({ state: 'ready' });
    if (
      sourceSummary.state !== 'ready' ||
      sourceSummary.projection.completedBuildAt === null
    ) {
      throw new Error('Expected a recorded source completion timestamp.');
    }
    const sourceCompletedAt = sourceSummary.projection.completedBuildAt;
    expect(sourceCompletedAt).toBeGreaterThan(123);
    const destinationRoot = path.join(root, 'eager-destination');
    cpSync(sourceRoot, destinationRoot, { recursive: true });
    const seededDbPath = path.join(root, 'eager-seeded', 'graph.db');

    await seedCodeGraphDatabase({
      targetDbPath: seededDbPath,
      customLanguagesFingerprint: fingerprint,
      markCompletedFromSources: true,
      sources: [
        {
          dbPath: published.dbPath,
          repoId: REPO_ID,
          canonicalRepoRoot: sourceRoot,
          destinationRootPath: destinationRoot,
          generationId: published.manifest.generationId,
          gitHead: null,
          completedBuildAt: 123,
        },
      ],
    });

    expect(readReadonlyCodeGraphSummary(seededDbPath)).toMatchObject({
      completed: true,
      lastBuildAt: sourceCompletedAt,
      repositories: [expect.objectContaining({ repoId: REPO_ID })],
    });
  });

  it('clones a completed worktree graph and rebinds paths atomically', async () => {
    const published = await buildAndPublish('generation-a');
    const destinationRoot = path.join(root, 'clone-destination');
    cpSync(sourceRoot, destinationRoot, { recursive: true });
    const clonedDbPath = path.join(root, 'cloned', 'graph.db');

    await expect(
      cloneCompletedCodeGraphDatabase({
        sourceDbPath: published.dbPath,
        targetDbPath: clonedDbPath,
        repositories: [{ repoId: REPO_ID, rootPath: destinationRoot }],
      }),
    ).resolves.toMatchObject({ installed: true });

    expect(readReadonlyCodeGraphSummary(clonedDbPath)).toMatchObject({
      completed: true,
      repositories: [expect.objectContaining({ repoId: REPO_ID })],
    });
    expect(tableRows(clonedDbPath, 'repositories')).toEqual([
      expect.objectContaining({ repo_id: REPO_ID, root_path: destinationRoot }),
    ]);
    expectRepositoryFilePaths(clonedDbPath, REPO_ID, destinationRoot);
  });

  it('uses a direct file copy for an already-validated immutable base', async () => {
    const published = await buildAndPublish('generation-a');
    const destinationRoot = path.join(root, 'immutable-clone-destination');
    cpSync(sourceRoot, destinationRoot, { recursive: true });
    const clonedDbPath = path.join(root, 'immutable-cloned', 'graph.db');
    const sourceRepositoriesBefore = tableRows(
      published.dbPath,
      'repositories',
    );
    const sourceFilesBefore = tableRows(published.dbPath, 'files');

    await expect(
      cloneCompletedCodeGraphDatabase({
        sourceDbPath: published.dbPath,
        targetDbPath: clonedDbPath,
        repositories: [{ repoId: REPO_ID, rootPath: destinationRoot }],
        copyMode: 'immutable-file-copy',
        sourceAlreadyValidated: true,
        targetValidation: 'metadata-only',
      }),
    ).resolves.toMatchObject({ installed: true });

    expect(readReadonlyCodeGraphSummary(clonedDbPath)).toMatchObject({
      completed: true,
      repositories: [expect.objectContaining({ repoId: REPO_ID })],
    });
    expect(tableRows(clonedDbPath, 'repositories')).toEqual([
      expect.objectContaining({ repo_id: REPO_ID, root_path: destinationRoot }),
    ]);
    expectRepositoryFilePaths(clonedDbPath, REPO_ID, destinationRoot);
    expectClearedFileMtimes(clonedDbPath);
    for (const table of GRAPH_CONTENT_TABLES) {
      expect(
        normalizedRows(clonedDbPath, table, { ignoreFileMtimes: true }),
      ).toEqual(
        normalizedRows(published.dbPath, table, { ignoreFileMtimes: true }),
      );
    }
    expect(tableRows(published.dbPath, 'repositories')).toEqual(
      sourceRepositoriesBefore,
    );
    expect(tableRows(published.dbPath, 'files')).toEqual(sourceFilesBefore);
    expectRepositoryFilePaths(published.dbPath, REPO_ID, sourceRoot);

    const clonedEngine = await CodeGraphEngine.open({
      dbPath: clonedDbPath,
      repositories: [{ repoId: REPO_ID, rootPath: destinationRoot }],
      worktreeRootPath: destinationRoot,
    });
    const refreshed = await clonedEngine.buildOrUpdate();
    clonedEngine.close();
    expect(refreshed.filesParsed).toBe(0);
    expect(refreshed.filesUnchanged).toBe(1);
  });

  it('rebinds every repository in a completed multi-repo worktree clone', async () => {
    const sourceRootB = path.join(root, 'source-b');
    mkdirSync(path.join(sourceRootB, 'src'), { recursive: true });
    writeFileSync(
      path.join(sourceRootB, 'src', 'other.ts'),
      `export const other = 7;\n`,
    );
    const sourceDbPath = path.join(root, 'multi-source', 'graph.db');
    const sourceEngine = await CodeGraphEngine.open({
      dbPath: sourceDbPath,
      repositories: [
        { repoId: REPO_ID, rootPath: sourceRoot },
        { repoId: 'repo-b', rootPath: sourceRootB },
      ],
      worktreeRootPath: sourceRoot,
    });
    await sourceEngine.buildOrUpdate();
    sourceEngine.close();

    const destinationA = path.join(root, 'multi-destination-a');
    const destinationB = path.join(root, 'multi-destination-b');
    cpSync(sourceRoot, destinationA, { recursive: true });
    cpSync(sourceRootB, destinationB, { recursive: true });
    const clonedDbPath = path.join(root, 'multi-cloned', 'graph.db');
    const sourceRepositoriesBefore = tableRows(sourceDbPath, 'repositories');
    const sourceFilesBefore = tableRows(sourceDbPath, 'files');

    await expect(
      cloneCompletedCodeGraphDatabase({
        sourceDbPath,
        targetDbPath: clonedDbPath,
        repositories: [
          { repoId: REPO_ID, rootPath: destinationA },
          { repoId: 'repo-b', rootPath: destinationB },
        ],
      }),
    ).resolves.toMatchObject({ installed: true });

    expect(readReadonlyCodeGraphSummary(clonedDbPath)).toMatchObject({
      completed: true,
      repositories: [
        expect.objectContaining({ repoId: REPO_ID }),
        expect.objectContaining({ repoId: 'repo-b' }),
      ],
    });
    expect(tableRows(clonedDbPath, 'repositories')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repo_id: REPO_ID, root_path: destinationA }),
        expect.objectContaining({ repo_id: 'repo-b', root_path: destinationB }),
      ]),
    );
    expectRepositoryFilePaths(clonedDbPath, REPO_ID, destinationA);
    expectRepositoryFilePaths(clonedDbPath, 'repo-b', destinationB);
    expectClearedFileMtimes(clonedDbPath);
    for (const table of GRAPH_CONTENT_TABLES) {
      expect(
        normalizedRows(clonedDbPath, table, { ignoreFileMtimes: true }),
      ).toEqual(
        normalizedRows(sourceDbPath, table, { ignoreFileMtimes: true }),
      );
    }
    expect(tableRows(sourceDbPath, 'repositories')).toEqual(
      sourceRepositoriesBefore,
    );
    expect(tableRows(sourceDbPath, 'files')).toEqual(sourceFilesBefore);
    expectRepositoryFilePaths(sourceDbPath, REPO_ID, sourceRoot);
    expectRepositoryFilePaths(sourceDbPath, 'repo-b', sourceRootB);

    const clonedEngine = await CodeGraphEngine.open({
      dbPath: clonedDbPath,
      repositories: [
        { repoId: REPO_ID, rootPath: destinationA },
        { repoId: 'repo-b', rootPath: destinationB },
      ],
      worktreeRootPath: destinationA,
    });
    const refreshed = await clonedEngine.buildOrUpdate();
    clonedEngine.close();
    expect(refreshed.filesParsed).toBe(0);
    expect(refreshed.filesUnchanged).toBe(2);
  });

  it('fuses complete multi-repo shadow bases with exact destination paths', async () => {
    const publishedA = await buildAndPublish('generation-a');
    const sourceRootB = path.join(root, 'fusion-source-b');
    mkdirSync(path.join(sourceRootB, 'src'), { recursive: true });
    writeFileSync(
      path.join(sourceRootB, 'src', 'other.ts'),
      `export const other = 7;\n`,
    );
    const variantDirB = getCodeGraphBaseVariantDir(
      path.join(root, 'fusion-shadow-b'),
      {
        repoId: 'repo-b',
        customLanguagesFingerprint: fingerprint,
      },
    );
    const stagingB = await prepareCodeGraphBaseStaging({
      variantDir: variantDirB,
      buildId: 'generation-b',
    });
    const sourceEngineB = await CodeGraphEngine.open({
      dbPath: stagingB.dbPath,
      repositories: [{ repoId: 'repo-b', rootPath: sourceRootB }],
      worktreeRootPath: sourceRootB,
    });
    await sourceEngineB.buildOrUpdate();
    sourceEngineB.close();
    const publishedB = await publishCodeGraphBase({
      variantDir: variantDirB,
      stagingDir: stagingB.stagingDir,
      identity: {
        repoId: 'repo-b',
        canonicalRepoRoot: sourceRootB,
        customLanguagesFingerprint: fingerprint,
      },
      gitHead: null,
      generationId: 'generation-b',
    });
    const sourceDbPathB = publishedB.dbPath;
    const sourceSummaryA = readCodeGraphSummaryProjection(publishedA.dbPath);
    const sourceSummaryB = readCodeGraphSummaryProjection(sourceDbPathB);
    expect(sourceSummaryA).toMatchObject({ state: 'ready' });
    expect(sourceSummaryB).toMatchObject({ state: 'ready' });
    if (
      sourceSummaryA.state !== 'ready' ||
      sourceSummaryB.state !== 'ready' ||
      sourceSummaryA.projection.completedBuildAt === null ||
      sourceSummaryB.projection.completedBuildAt === null
    ) {
      throw new Error(
        'Expected recorded completion timestamps for both sources.',
      );
    }
    const latestSourceCompletedAt = Math.max(
      sourceSummaryA.projection.completedBuildAt,
      sourceSummaryB.projection.completedBuildAt,
    );
    expect(latestSourceCompletedAt).toBeGreaterThan(200);

    const destinationA = path.join(root, 'fusion-destination-a');
    const destinationB = path.join(root, 'fusion-destination-b');
    cpSync(sourceRoot, destinationA, { recursive: true });
    cpSync(sourceRootB, destinationB, { recursive: true });
    const fusedDbPath = path.join(root, 'multi-fused', 'graph.db');
    const sourceRepositoriesABefore = tableRows(
      publishedA.dbPath,
      'repositories',
    );
    const sourceFilesABefore = tableRows(publishedA.dbPath, 'files');
    const sourceRepositoriesBBefore = tableRows(sourceDbPathB, 'repositories');
    const sourceFilesBBefore = tableRows(sourceDbPathB, 'files');

    const seeded = await seedCodeGraphDatabase({
      targetDbPath: fusedDbPath,
      customLanguagesFingerprint: fingerprint,
      markCompletedFromSources: true,
      sources: [
        {
          dbPath: publishedA.dbPath,
          repoId: REPO_ID,
          canonicalRepoRoot: sourceRoot,
          destinationRootPath: destinationA,
          generationId: publishedA.manifest.generationId,
          gitHead: null,
          completedBuildAt: 100,
        },
        {
          dbPath: sourceDbPathB,
          repoId: 'repo-b',
          canonicalRepoRoot: sourceRootB,
          destinationRootPath: destinationB,
          generationId: 'generation-b',
          gitHead: null,
          completedBuildAt: 200,
        },
      ],
    });

    expect(seeded.installed).toBe(true);
    expect(seeded.outcomes).toEqual([
      expect.objectContaining({ repoId: REPO_ID, status: 'seeded' }),
      expect.objectContaining({ repoId: 'repo-b', status: 'seeded' }),
    ]);
    expect(readReadonlyCodeGraphSummary(fusedDbPath)).toMatchObject({
      completed: true,
      lastBuildAt: latestSourceCompletedAt,
      repositories: [
        expect.objectContaining({ repoId: REPO_ID }),
        expect.objectContaining({ repoId: 'repo-b' }),
      ],
    });
    expect(tableRows(fusedDbPath, 'repositories')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repo_id: REPO_ID, root_path: destinationA }),
        expect.objectContaining({ repo_id: 'repo-b', root_path: destinationB }),
      ]),
    );
    expectRepositoryFilePaths(fusedDbPath, REPO_ID, destinationA);
    expectRepositoryFilePaths(fusedDbPath, 'repo-b', destinationB);
    expect(tableRows(publishedA.dbPath, 'repositories')).toEqual(
      sourceRepositoriesABefore,
    );
    expect(tableRows(publishedA.dbPath, 'files')).toEqual(sourceFilesABefore);
    expect(tableRows(sourceDbPathB, 'repositories')).toEqual(
      sourceRepositoriesBBefore,
    );
    expect(tableRows(sourceDbPathB, 'files')).toEqual(sourceFilesBBefore);
    expectRepositoryFilePaths(publishedA.dbPath, REPO_ID, sourceRoot);
    expectRepositoryFilePaths(sourceDbPathB, 'repo-b', sourceRootB);

    const fusedEngine = await CodeGraphEngine.open({
      dbPath: fusedDbPath,
      repositories: [
        { repoId: REPO_ID, rootPath: destinationA },
        { repoId: 'repo-b', rootPath: destinationB },
      ],
      worktreeRootPath: destinationA,
    });
    const refreshed = await fusedEngine.buildOrUpdate();
    fusedEngine.close();
    expect(refreshed.filesParsed).toBe(0);
    expect(refreshed.filesUnchanged).toBe(2);

    const coldDbPath = path.join(root, 'multi-cold', 'graph.db');
    const coldEngine = await CodeGraphEngine.open({
      dbPath: coldDbPath,
      repositories: [
        { repoId: REPO_ID, rootPath: destinationA },
        { repoId: 'repo-b', rootPath: destinationB },
      ],
      worktreeRootPath: destinationA,
    });
    await coldEngine.buildOrUpdate();
    coldEngine.close();
    for (const table of GRAPH_CONTENT_TABLES) {
      expect(normalizedRows(fusedDbPath, table)).toEqual(
        normalizedRows(coldDbPath, table),
      );
    }
  });

  it('preserves a completed legacy graph that predates the completion marker', async () => {
    const legacyDbPath = path.join(root, 'legacy', 'graph.db');
    const legacyEngine = await CodeGraphEngine.open({
      dbPath: legacyDbPath,
      repositories: [{ repoId: REPO_ID, rootPath: sourceRoot }],
      worktreeRootPath: sourceRoot,
    });
    await legacyEngine.buildOrUpdate();
    legacyEngine.close();

    const legacyDb = new DatabaseSync(legacyDbPath);
    legacyDb
      .prepare("DELETE FROM graph_metadata WHERE key = 'completed_build_at'")
      .run();
    legacyDb.close();

    const seeded = await seedCodeGraphDatabase({
      targetDbPath: legacyDbPath,
      customLanguagesFingerprint: fingerprint,
      sources: [],
    });

    expect(seeded.installed).toBe(false);
    expect(tableRows(legacyDbPath, 'files')).toHaveLength(1);
  });

  it('keeps valid sources when another repository falls back to a cold scan', async () => {
    const published = await buildAndPublish('generation-a');
    const destinationA = path.join(root, 'destination-a');
    const destinationB = path.join(root, 'destination-b');
    cpSync(sourceRoot, destinationA, { recursive: true });
    mkdirSync(path.join(destinationB, 'src'), { recursive: true });
    writeFileSync(path.join(destinationB, 'src', 'other.ts'), SOURCE);

    const dbPath = path.join(root, 'partial', 'graph.db');
    const seeded = await seedCodeGraphDatabase({
      targetDbPath: dbPath,
      customLanguagesFingerprint: fingerprint,
      sources: [
        {
          dbPath: published.dbPath,
          repoId: REPO_ID,
          canonicalRepoRoot: sourceRoot,
          destinationRootPath: destinationA,
          generationId: published.manifest.generationId,
          gitHead: null,
        },
        {
          dbPath: path.join(root, 'missing.db'),
          repoId: 'repo-b',
          canonicalRepoRoot: destinationB,
          destinationRootPath: destinationB,
          generationId: 'missing',
          gitHead: null,
        },
      ],
    });
    expect(seeded.installed).toBe(true);
    expect(seeded.outcomes).toEqual([
      expect.objectContaining({ repoId: REPO_ID, status: 'seeded' }),
      expect.objectContaining({ repoId: 'repo-b', status: 'cold-fallback' }),
    ]);

    const engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [
        { repoId: REPO_ID, rootPath: destinationA },
        { repoId: 'repo-b', rootPath: destinationB },
      ],
      worktreeRootPath: destinationA,
    });
    const reconciled = await engine.buildOrUpdate();
    engine.close();
    expect(reconciled.filesParsed).toBe(1);
    expect(reconciled.filesUnchanged).toBe(1);
    expect(tableRows(dbPath, 'repositories')).toHaveLength(2);
  });

  it('keeps A seedable while B is blocked or cancelled and keeps B after abandoned staging cleanup', async () => {
    const generationA = await buildAndPublish('generation-a');
    const generationBStaging = await prepareCodeGraphBaseStaging({
      variantDir,
      buildId: 'generation-b',
      sourceDbPath: generationA.dbPath,
    });
    expect(
      (
        await readPublishedCodeGraphBase({
          variantDir,
          identity: {
            repoId: REPO_ID,
            canonicalRepoRoot: sourceRoot,
            customLanguagesFingerprint: fingerprint,
          },
        })
      )?.manifest.generationId,
    ).toBe('generation-a');

    const blockedSeed = await seedCodeGraphDatabase({
      targetDbPath: path.join(root, 'blocked-successor-seed', 'graph.db'),
      customLanguagesFingerprint: fingerprint,
      sources: [
        {
          dbPath: generationA.dbPath,
          repoId: REPO_ID,
          canonicalRepoRoot: sourceRoot,
          destinationRootPath: sourceRoot,
          generationId: 'generation-a',
          gitHead: null,
        },
      ],
    });
    expect(blockedSeed.outcomes).toEqual([
      expect.objectContaining({
        status: 'seeded',
        generationId: 'generation-a',
      }),
    ]);
    await cleanupCodeGraphBaseStaging(variantDir);
    expect(existsSync(generationBStaging.stagingDir)).toBe(false);
    expect(
      (
        await readPublishedCodeGraphBase({
          variantDir,
          identity: {
            repoId: REPO_ID,
            canonicalRepoRoot: sourceRoot,
            customLanguagesFingerprint: fingerprint,
          },
        })
      )?.manifest.generationId,
    ).toBe('generation-a');

    const resumedGenerationBStaging = await prepareCodeGraphBaseStaging({
      variantDir,
      buildId: 'generation-b-resumed',
      sourceDbPath: generationA.dbPath,
    });

    const engine = await CodeGraphEngine.open({
      dbPath: resumedGenerationBStaging.dbPath,
      repositories: [{ repoId: REPO_ID, rootPath: sourceRoot }],
      worktreeRootPath: sourceRoot,
    });
    try {
      await engine.buildOrUpdate();
    } finally {
      engine.close();
    }
    const generationB = await publishCodeGraphBase({
      variantDir,
      stagingDir: resumedGenerationBStaging.stagingDir,
      identity: {
        repoId: REPO_ID,
        canonicalRepoRoot: sourceRoot,
        customLanguagesFingerprint: fingerprint,
      },
      gitHead: null,
      generationId: 'generation-b',
    });
    expect(generationB.manifest.generationId).toBe('generation-b');

    const abandoned = await prepareCodeGraphBaseStaging({
      variantDir,
      buildId: 'abandoned',
      sourceDbPath: generationB.dbPath,
    });
    expect(readFileSync(abandoned.dbPath).length).toBeGreaterThan(0);
    await cleanupCodeGraphBaseStaging(variantDir);
    const current = await readPublishedCodeGraphBase({
      variantDir,
      identity: {
        repoId: REPO_ID,
        canonicalRepoRoot: sourceRoot,
        customLanguagesFingerprint: fingerprint,
      },
    });
    expect(current?.manifest.generationId).toBe('generation-b');
  });

  it('publishes and recovers a Windows-style canonical identity with portable manifest paths', async () => {
    const generationA = await buildAndPublish('generation-a');
    const windowsRoot = String.raw`C:\Users\dev\repo`;
    const windowsVariantDir = getCodeGraphBaseVariantDir(
      path.join(root, 'windows-shadow'),
      { repoId: REPO_ID, customLanguagesFingerprint: fingerprint },
    );
    const staging = await prepareCodeGraphBaseStaging({
      variantDir: windowsVariantDir,
      sourceDbPath: generationA.dbPath,
    });
    const published = await publishCodeGraphBase({
      variantDir: windowsVariantDir,
      stagingDir: staging.stagingDir,
      identity: {
        repoId: REPO_ID,
        canonicalRepoRoot: windowsRoot,
        customLanguagesFingerprint: fingerprint,
      },
      gitHead: null,
      generationId: 'windows-generation',
    });

    expect(published.manifest).toMatchObject({
      canonicalRepoRoot: windowsRoot,
      graphRelativePath: 'generations/windows-generation/graph.db',
    });
    writeFileSync(path.join(windowsVariantDir, 'current.json'), '{broken');
    await expect(
      readPublishedCodeGraphBase({
        variantDir: windowsVariantDir,
        identity: {
          repoId: REPO_ID,
          canonicalRepoRoot: windowsRoot,
          customLanguagesFingerprint: fingerprint,
        },
      }),
    ).resolves.toMatchObject({ recovered: true });
  });

  it('retains the prior valid generation and never switches to a failed successor', async () => {
    const generationA = await buildAndPublish('generation-a');
    const invalidStaging = await prepareCodeGraphBaseStaging({
      variantDir,
      buildId: 'generation-invalid',
      sourceDbPath: generationA.dbPath,
    });
    const invalidDb = new DatabaseSync(invalidStaging.dbPath);
    invalidDb
      .prepare(
        "UPDATE graph_metadata SET value = '0' WHERE key = 'extractor_version'",
      )
      .run();
    invalidDb.close();
    await expect(
      publishCodeGraphBase({
        variantDir,
        stagingDir: invalidStaging.stagingDir,
        identity: {
          repoId: REPO_ID,
          canonicalRepoRoot: sourceRoot,
          customLanguagesFingerprint: fingerprint,
        },
        gitHead: null,
        generationId: 'generation-invalid',
      }),
    ).rejects.toThrow(/validation/i);
    expect(
      (
        await readPublishedCodeGraphBase({
          variantDir,
          identity: {
            repoId: REPO_ID,
            canonicalRepoRoot: sourceRoot,
            customLanguagesFingerprint: fingerprint,
          },
        })
      )?.manifest.generationId,
    ).toBe('generation-a');

    await buildAndPublish('generation-b');
    await buildAndPublish('generation-c');
    const generationNames = readdirSync(
      path.join(variantDir, 'generations'),
    ).sort();
    expect(generationNames).toEqual(['generation-b', 'generation-c']);
    expect(existsSync(generationA.dbPath)).toBe(false);
  });

  it('rejects a schema-incompatible successor and recovers the prior generation', async () => {
    await buildAndPublish('generation-a');
    const incompatible = await prepareCodeGraphBaseStaging({
      variantDir,
      buildId: 'schema-incompatible',
      sourceDbPath: path.join(
        variantDir,
        'generations',
        'generation-a',
        'graph.db',
      ),
    });
    const db = new DatabaseSync(incompatible.dbPath);
    db.prepare(
      "UPDATE graph_metadata SET value = '0' WHERE key = 'schema_version'",
    ).run();
    db.close();

    await expect(
      publishCodeGraphBase({
        variantDir,
        stagingDir: incompatible.stagingDir,
        identity: {
          repoId: REPO_ID,
          canonicalRepoRoot: sourceRoot,
          customLanguagesFingerprint: fingerprint,
        },
        gitHead: null,
        generationId: 'schema-incompatible',
      }),
    ).rejects.toThrow(/validation/i);
    await expect(
      readPublishedCodeGraphBase({
        variantDir,
        identity: {
          repoId: REPO_ID,
          canonicalRepoRoot: sourceRoot,
          customLanguagesFingerprint: fingerprint,
        },
      }),
    ).resolves.toMatchObject({
      manifest: { generationId: 'generation-a' },
    });
  });
});

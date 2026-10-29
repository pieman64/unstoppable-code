/**
 * Phase 20 (G2, G3): seeding reuses the work a published base already did,
 * and base variants are shared only when their graphs are byte-identical.
 *
 * - Fusion carries each source's `resolution_inputs:<repoId>`, the
 *   derived-analysis marker and per-repository diagnostics, so a refresh of
 *   an unchanged multi-repository worktree reuses resolution, the full-text
 *   index and derived analysis, and still equals a cold build.
 * - A base variant is keyed by repository id and custom-language inputs.
 *   Every graph row id hashes the repository id, so two variants that differ
 *   only by repository id are different graphs and must never share a base.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodeGraphEngine } from '../engine';
import {
  codeGraphBaseVariantHash,
  getCodeGraphBaseVariantDir,
  prepareCodeGraphBaseStaging,
  publishCodeGraphBase,
  readReadonlyCodeGraphSummary,
  seedCodeGraphDatabase,
  seedCodeGraphDatabaseByClone,
  type ValidatedCodeGraphBase,
} from '../base-graph';
import { fingerprintCustomLanguageInputs } from '../languages/custom-config';
import { isSymbolFtsMappingTrusted } from '../store/fts';
import * as symbolFtsStore from '../store/fts';
import { openCodeGraphDatabase, requireRow } from '../store/database';
import {
  resolutionInputsTransferable,
  resolutionRootDepth,
} from '../resolve/ts-module-resolver';

const GRAPH_TABLES = [
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

const LIB_A = `export function doWork(): number {
  return 42;
}
`;
const MAIN_A = `import { doWork } from './lib';

export function run(): number {
  return doWork();
}
`;
const LIB_B = `export function other(): number {
  return 7;
}
`;
const MAIN_B = `import { other } from './lib';

export function entry(): number {
  return other() + other();
}
`;

function metadata(dbPath: string, key: string): string | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT value FROM graph_metadata WHERE key = ?')
      .get(key);
    return row === undefined ? null : String(requireRow(row).value);
  } finally {
    db.close();
  }
}

function normalizedRows(
  dbPath: string,
  table: string,
): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // FTS rowids are storage identities: fused and cold graphs may insert
    // identical symbols in different orders. Compare every persisted field by
    // stable symbol ID; ordered agent-visible search has separate coverage.
    const orderBy =
      table === 'symbol_fts' || table === 'symbol_fragment_fts'
        ? 'symbol_id'
        : 'rowid';
    return db
      .prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`)
      .all()
      .map((value) => {
        const row = { ...requireRow(value) };
        delete row.updated_at;
        if (table === 'repositories') delete row.root_path;
        if (table === 'files') delete row.absolute_path;
        return row;
      });
  } finally {
    db.close();
  }
}

/** Rows as a set: a reparsed file's rows come back under new rowids. */
function rowSet(dbPath: string, table: string): string[] {
  return normalizedRows(dbPath, table)
    .map((row) => JSON.stringify(row))
    .sort();
}

function expectFtsMappingCoherent(dbPath: string): void {
  const db = openCodeGraphDatabase(dbPath);
  try {
    expect(isSymbolFtsMappingTrusted(db)).toBe(true);
    const brokenJoin = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM symbols s
         LEFT JOIN symbol_fts_rows m ON m.symbol_id = s.id
         LEFT JOIN symbol_fts f
           ON f.rowid = m.symbol_fts_rowid AND f.symbol_id = s.id
         LEFT JOIN symbol_fragment_fts x
           ON x.rowid = m.fragment_fts_rowid AND x.symbol_id = s.id
         WHERE m.symbol_id IS NULL OR f.symbol_id IS NULL OR x.symbol_id IS NULL
            OR m.file_id <> s.file_id OR m.repository_id <> s.repository_id`,
      )
      .get();
    expect(Number(requireRow(brokenJoin).n)).toBe(0);
    const orphanMap = db
      .prepare(
        `SELECT COUNT(*) AS n FROM symbol_fts_rows m
         LEFT JOIN symbols s ON s.id = m.symbol_id WHERE s.id IS NULL`,
      )
      .get();
    expect(Number(requireRow(orphanMap).n)).toBe(0);
  } finally {
    db.close();
  }
}

function diagnosticsRepositories(dbPath: string): unknown {
  const raw = metadata(dbPath, 'graph_diagnostics');
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'object' && parsed !== null
    ? Reflect.get(parsed, 'repositories')
    : null;
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('seeding reuse and base variant identity', () => {
  let root: string;
  let fingerprint: string;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-seed-reuse-'));
    fingerprint = (await fingerprintCustomLanguageInputs(root)).value;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeRepo(rootPath: string, lib: string, main: string): void {
    mkdirSync(path.join(rootPath, 'src'), { recursive: true });
    writeFileSync(path.join(rootPath, 'src', 'lib.ts'), lib);
    writeFileSync(path.join(rootPath, 'src', 'main.ts'), main);
  }

  async function buildAndPublish(input: {
    repoId: string;
    sourceRoot: string;
    generationId: string;
  }): Promise<ValidatedCodeGraphBase> {
    const variantDir = getCodeGraphBaseVariantDir(
      path.join(root, `shadow-${input.repoId}`),
      { repoId: input.repoId, customLanguagesFingerprint: fingerprint },
    );
    const staging = await prepareCodeGraphBaseStaging({
      variantDir,
      buildId: input.generationId,
    });
    const engine = await CodeGraphEngine.open({
      dbPath: staging.dbPath,
      repositories: [{ repoId: input.repoId, rootPath: input.sourceRoot }],
      worktreeRootPath: input.sourceRoot,
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
        repoId: input.repoId,
        canonicalRepoRoot: input.sourceRoot,
        customLanguagesFingerprint: fingerprint,
      },
      gitHead: null,
      generationId: input.generationId,
    });
  }

  it('carries resolution inputs, the derived marker and diagnostics through multi-repository fusion, and the refresh equals a cold build', async () => {
    const sourceA = path.join(root, 'source-a');
    const sourceB = path.join(root, 'source-b');
    writeRepo(sourceA, LIB_A, MAIN_A);
    writeRepo(sourceB, LIB_B, MAIN_B);
    const baseA = await buildAndPublish({
      repoId: 'repo-a',
      sourceRoot: sourceA,
      generationId: 'generation-a',
    });
    const baseB = await buildAndPublish({
      repoId: 'repo-b',
      sourceRoot: sourceB,
      generationId: 'generation-b',
    });
    // Same depth as the sources: see the deeper-destination test below.
    const destinationA = path.join(root, 'worktree-a');
    const destinationB = path.join(root, 'worktree-b');
    cpSync(sourceA, destinationA, { recursive: true });
    cpSync(sourceB, destinationB, { recursive: true });

    const fusedDbPath = path.join(root, 'fused', 'graph.db');
    const sources = [
      {
        dbPath: baseA.dbPath,
        repoId: 'repo-a',
        canonicalRepoRoot: sourceA,
        destinationRootPath: destinationA,
        generationId: baseA.manifest.generationId,
        gitHead: null,
      },
      {
        dbPath: baseB.dbPath,
        repoId: 'repo-b',
        canonicalRepoRoot: sourceB,
        destinationRootPath: destinationB,
        generationId: baseB.manifest.generationId,
        gitHead: null,
      },
    ];
    const seeded = await seedCodeGraphDatabase({
      targetDbPath: fusedDbPath,
      customLanguagesFingerprint: fingerprint,
      sources,
    });
    expect(seeded.installed).toBe(true);
    expectFtsMappingCoherent(fusedDbPath);
    expectFtsMappingCoherent(baseA.dbPath);
    expectFtsMappingCoherent(baseB.dbPath);

    // The markers each base computed survive fusion.
    for (const [repoId, base] of [
      ['repo-a', baseA],
      ['repo-b', baseB],
    ] as const) {
      expect(metadata(fusedDbPath, `resolution_inputs:${repoId}`)).toBe(
        metadata(base.dbPath, `resolution_inputs:${repoId}`),
      );
    }
    expect(metadata(fusedDbPath, 'derived_at')).not.toBeNull();
    expect(diagnosticsRepositories(fusedDbPath)).toEqual([
      expect.objectContaining({ repoId: 'repo-a' }),
      expect.objectContaining({ repoId: 'repo-b' }),
    ]);
    // Fusion still leaves completion to the worktree refresh.
    expect(metadata(fusedDbPath, 'completed_build_at')).toBeNull();
    expect(metadata(fusedDbPath, 'last_build_at')).toBeNull();
    expect(readReadonlyCodeGraphSummary(fusedDbPath)).toMatchObject({
      completed: false,
      lastBuildAt: null,
      repositories: [
        expect.objectContaining({ repoId: 'repo-a', fileCount: 2 }),
        expect.objectContaining({ repoId: 'repo-b', fileCount: 2 }),
      ],
    });

    const repositories = [
      { repoId: 'repo-a', rootPath: destinationA },
      { repoId: 'repo-b', rootPath: destinationB },
    ];
    const fusedEngine = await CodeGraphEngine.open({
      dbPath: fusedDbPath,
      repositories,
      worktreeRootPath: destinationA,
    });
    const refreshed = await fusedEngine.buildOrUpdate();
    fusedEngine.close();
    expect(refreshed.filesParsed).toBe(0);
    // Unchanged inputs: resolution, the full-text index and derived analysis
    // are reused rather than recomputed for the whole graph.
    expect(refreshed.factsChanged).toBe(false);
    expect(refreshed.timings?.resolveMs).toBeUndefined();
    expect(refreshed.timings?.ftsMs).toBeUndefined();
    expect(refreshed.timings?.derivedMs).toBeUndefined();

    const coldDbPath = path.join(root, 'cold', 'graph.db');
    const coldEngine = await CodeGraphEngine.open({
      dbPath: coldDbPath,
      repositories,
      worktreeRootPath: destinationA,
    });
    await coldEngine.buildOrUpdate();
    coldEngine.close();
    for (const table of GRAPH_TABLES) {
      expect(normalizedRows(fusedDbPath, table)).toEqual(
        normalizedRows(coldDbPath, table),
      );
    }
    expect(diagnosticsRepositories(fusedDbPath)).toEqual(
      diagnosticsRepositories(coldDbPath),
    );
  });

  it('marks eager multi-repository fusion complete from all source timestamps', async () => {
    const sourceA = path.join(root, 'source-a');
    const sourceB = path.join(root, 'source-b');
    writeRepo(sourceA, LIB_A, MAIN_A);
    writeRepo(sourceB, LIB_B, MAIN_B);
    const baseA = await buildAndPublish({
      repoId: 'repo-a',
      sourceRoot: sourceA,
      generationId: 'generation-a',
    });
    const baseB = await buildAndPublish({
      repoId: 'repo-b',
      sourceRoot: sourceB,
      generationId: 'generation-b',
    });
    // Same depth as the sources: see the deeper-destination test below.
    const destinationA = path.join(root, 'worktree-a');
    const destinationB = path.join(root, 'worktree-b');
    cpSync(sourceA, destinationA, { recursive: true });
    cpSync(sourceB, destinationB, { recursive: true });

    const sources = [
      {
        dbPath: baseA.dbPath,
        repoId: 'repo-a',
        canonicalRepoRoot: sourceA,
        destinationRootPath: destinationA,
        generationId: baseA.manifest.generationId,
        gitHead: null,
      },
      {
        dbPath: baseB.dbPath,
        repoId: 'repo-b',
        canonicalRepoRoot: sourceB,
        destinationRootPath: destinationB,
        generationId: baseB.manifest.generationId,
        gitHead: null,
      },
    ];
    // An eager fusion is immediately readable only when every requested
    // repository seeded successfully. It records the completed-source marker
    // without needing a worktree refresh to manufacture a build timestamp.
    const sourceCompletionTimes = [baseA, baseB].map((base) => {
      const raw = metadata(base.dbPath, 'completed_build_at');
      if (raw === null || !Number.isFinite(Number(raw))) {
        throw new Error('Expected completion metadata in each generated base.');
      }
      return Number(raw);
    });
    const eagerFusedDbPath = path.join(root, 'fused-eager', 'graph.db');
    const eagerSeed = await seedCodeGraphDatabase({
      targetDbPath: eagerFusedDbPath,
      customLanguagesFingerprint: fingerprint,
      sources: sources.map((source, index) => ({
        ...source,
        completedBuildAt: sourceCompletionTimes[index],
      })),
      markCompletedFromSources: true,
    });
    expect(eagerSeed.installed).toBe(true);
    expectFtsMappingCoherent(eagerFusedDbPath);
    expect(eagerSeed.outcomes.map((outcome) => outcome.status)).toEqual([
      'seeded',
      'seeded',
    ]);
    const eagerCompletedAt = metadata(eagerFusedDbPath, 'completed_build_at');
    expect(eagerCompletedAt).toBe(String(Math.max(...sourceCompletionTimes)));
    expect(metadata(eagerFusedDbPath, 'last_build_at')).toBe(eagerCompletedAt);
    const lastBuildAtMatcher: unknown = expect.any(Number);
    expect(readReadonlyCodeGraphSummary(eagerFusedDbPath)).toMatchObject({
      completed: true,
      lastBuildAt: lastBuildAtMatcher,
      repositories: [
        expect.objectContaining({ repoId: 'repo-a', fileCount: 2 }),
        expect.objectContaining({ repoId: 'repo-b', fileCount: 2 }),
      ],
    });
  });

  it.each(['clone', 'fusion'] as const)(
    'rereads a seeded file whose size and mtime match the base but whose bytes differ (%s seed)',
    async (seedPath) => {
      const stamp = 1_700_000_000;
      const stampFiles = (rootPath: string): void => {
        for (const file of ['lib.ts', 'main.ts']) {
          utimesSync(path.join(rootPath, 'src', file), stamp, stamp);
        }
      };
      const source = path.join(root, 'source-a');
      writeRepo(source, LIB_A, MAIN_A);
      stampFiles(source);
      const base = await buildAndPublish({
        repoId: 'repo-a',
        sourceRoot: source,
        generationId: 'generation-a',
      });
      // Same length, different bytes, and the base's recorded size and mtime.
      const destination = path.join(root, 'worktree-a');
      const changedLib = LIB_A.replace('doWork', 'doWirk');
      expect(changedLib).toHaveLength(LIB_A.length);
      writeRepo(destination, changedLib, MAIN_A);
      stampFiles(destination);

      const seedSource = {
        dbPath: base.dbPath,
        repoId: 'repo-a',
        canonicalRepoRoot: source,
        destinationRootPath: destination,
        generationId: base.manifest.generationId,
        gitHead: null,
      };
      const seededDbPath = path.join(root, 'seeded', 'graph.db');
      const installed =
        seedPath === 'clone'
          ? (
              await seedCodeGraphDatabaseByClone({
                targetDbPath: seededDbPath,
                source: seedSource,
                customLanguagesFingerprint: fingerprint,
              })
            )?.installed
          : (
              await seedCodeGraphDatabase({
                targetDbPath: seededDbPath,
                customLanguagesFingerprint: fingerprint,
                sources: [seedSource],
              })
            ).installed;
      expect(installed).toBe(true);
      // Clone preserves the complete SQLite mapping/marker; fusion instead
      // regenerates target-local rowids. Both must be coherent before refresh.
      expectFtsMappingCoherent(seededDbPath);
      // Both seed paths preserve facts but leave this worktree's completion
      // markers unset until its refresh; a clone specifically clears the
      // completed source's markers as part of rebinding it to this checkout.
      expect(readReadonlyCodeGraphSummary(seededDbPath)).toMatchObject({
        completed: false,
        lastBuildAt: null,
        repositories: [
          expect.objectContaining({ repoId: 'repo-a', fileCount: 2 }),
        ],
      });

      const repositories = [{ repoId: 'repo-a', rootPath: destination }];
      const seededEngine = await CodeGraphEngine.open({
        dbPath: seededDbPath,
        repositories,
        worktreeRootPath: destination,
      });
      const rebuildObserver = jest.spyOn(symbolFtsStore, 'rebuildSymbolFts');
      try {
        const refresh = await seededEngine.buildOrUpdate();
        expect(rebuildObserver).not.toHaveBeenCalled();
        expect(refresh.timings?.ftsMs).toBeGreaterThanOrEqual(0);
      } finally {
        rebuildObserver.mockRestore();
        seededEngine.close();
      }
      expectFtsMappingCoherent(seededDbPath);
      const coldDbPath = path.join(root, 'cold', 'graph.db');
      const coldEngine = await CodeGraphEngine.open({
        dbPath: coldDbPath,
        repositories,
        worktreeRootPath: destination,
      });
      await coldEngine.buildOrUpdate();
      coldEngine.close();
      // The facts match a cold build. (A refresh keeps an existing
      // community's id where a cold build derives it, so the derived tables
      // are not compared here.)
      for (const table of [
        'repositories',
        'files',
        'symbols',
        'edges',
        'symbol_fts',
        'symbol_fragment_fts',
      ]) {
        expect(rowSet(seededDbPath, table)).toEqual(rowSet(coldDbPath, table));
      }
    },
  );

  it('does not carry the derived marker when a repository falls back to a cold scan', async () => {
    const sourceA = path.join(root, 'source-a');
    writeRepo(sourceA, LIB_A, MAIN_A);
    const baseA = await buildAndPublish({
      repoId: 'repo-a',
      sourceRoot: sourceA,
      generationId: 'generation-a',
    });
    const destinationA = path.join(root, 'worktree-a');
    cpSync(sourceA, destinationA, { recursive: true });
    const fusedDbPath = path.join(root, 'partial', 'graph.db');
    const seeded = await seedCodeGraphDatabase({
      targetDbPath: fusedDbPath,
      customLanguagesFingerprint: fingerprint,
      sources: [
        {
          dbPath: baseA.dbPath,
          repoId: 'repo-a',
          canonicalRepoRoot: sourceA,
          destinationRootPath: destinationA,
          generationId: baseA.manifest.generationId,
          gitHead: null,
        },
        {
          dbPath: path.join(root, 'missing.db'),
          repoId: 'repo-b',
          canonicalRepoRoot: path.join(root, 'source-b'),
          destinationRootPath: path.join(root, 'worktree', 'b'),
          gitHead: null,
        },
      ],
    });
    expect(seeded.outcomes.map((outcome) => outcome.status)).toEqual([
      'seeded',
      'cold-fallback',
    ]);
    expect(metadata(fusedDbPath, 'resolution_inputs:repo-a')).not.toBeNull();
    expect(metadata(fusedDbPath, 'resolution_inputs:repo-b')).toBeNull();
    expect(metadata(fusedDbPath, 'derived_at')).toBeNull();
  });

  it('carries resolution inputs to a deeper destination only after checking the ancestors the base never probed, and the refresh equals a cold build', async () => {
    const sourceA = path.join(root, 'source-a');
    writeRepo(sourceA, LIB_A, MAIN_A);
    const baseA = await buildAndPublish({
      repoId: 'repo-a',
      sourceRoot: sourceA,
      generationId: 'generation-a',
    });
    // The fixture has no tsconfig.json, so the resolver probed every
    // ancestor up to the filesystem root, relative to the base's root.
    const recorded = metadata(baseA.dbPath, 'resolution_inputs:repo-a');
    expect(recorded).toContain('../');
    // Two levels deeper: the two topmost ancestors were never probed. They
    // hold none of the probed names, so the inputs carry over.
    const destinationA = path.join(root, 'deeper', 'nested', 'worktree-a');
    cpSync(sourceA, destinationA, { recursive: true });
    const fusedDbPath = path.join(root, 'fused-deeper', 'graph.db');
    await seedCodeGraphDatabase({
      targetDbPath: fusedDbPath,
      customLanguagesFingerprint: fingerprint,
      sources: [
        {
          dbPath: baseA.dbPath,
          repoId: 'repo-a',
          canonicalRepoRoot: sourceA,
          destinationRootPath: destinationA,
          generationId: baseA.manifest.generationId,
          gitHead: null,
        },
      ],
    });
    expect(metadata(fusedDbPath, 'resolution_inputs:repo-a')).toBe(recorded);

    const repositories = [{ repoId: 'repo-a', rootPath: destinationA }];
    const fusedEngine = await CodeGraphEngine.open({
      dbPath: fusedDbPath,
      repositories,
      worktreeRootPath: destinationA,
    });
    const refreshed = await fusedEngine.buildOrUpdate();
    fusedEngine.close();
    expect(refreshed.factsChanged).toBe(false);

    const coldDbPath = path.join(root, 'cold-deeper', 'graph.db');
    const coldEngine = await CodeGraphEngine.open({
      dbPath: coldDbPath,
      repositories,
      worktreeRootPath: destinationA,
    });
    await coldEngine.buildOrUpdate();
    coldEngine.close();
    for (const table of GRAPH_TABLES) {
      expect(normalizedRows(fusedDbPath, table)).toEqual(
        normalizedRows(coldDbPath, table),
      );
    }
  });

  it('transfers resolution inputs only when every probe the resolver could make at the new root was recorded or is absent', () => {
    const contained = JSON.stringify({
      'file-exists:tsconfig.json': 'exists',
      'tsconfig.json': 'abc',
    });
    // Probes inside the root are recorded relative to it: any depth works.
    expect(resolutionInputsTransferable(contained, '/a/b', '/x/y/z/w')).toBe(
      true,
    );
    // A walk recorded up to the filesystem root ("/a/b" is two levels deep).
    const escaping = JSON.stringify({
      'file-exists:tsconfig.json': null,
      'file-exists:../tsconfig.json': null,
      'file-exists:../../tsconfig.json': null,
    });
    // Same or shallower depth: every ancestor is reached by a recorded key.
    expect(resolutionInputsTransferable(escaping, '/a/b', '/x/y')).toBe(true);
    expect(resolutionInputsTransferable(escaping, '/a/b', '/x')).toBe(true);
    // Deeper: the ancestors above the recorded walk are probed now. Here the
    // new root is four levels below `root`, so `root` itself is one of them.
    const deeper = path.join(root, 'p', 'q', 'r');
    mkdirSync(deeper, { recursive: true });
    expect(resolutionInputsTransferable(escaping, '/a/b', deeper)).toBe(true);
    writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    expect(resolutionInputsTransferable(escaping, '/a/b', deeper)).toBe(false);
    // A walk that stopped below the filesystem root (it found its target)
    // stops at the same, validated, key at any depth.
    const stopped = JSON.stringify({
      'file-exists:../tsconfig.json': 'exists',
    });
    expect(resolutionInputsTransferable(stopped, '/a/b', deeper)).toBe(true);
    // Unreadable fingerprints are never transferred.
    expect(resolutionInputsTransferable('not json', '/a/b', '/x/y')).toBe(
      false,
    );
  });

  it('counts a root depth in steps up to the filesystem root, on POSIX and Windows paths', () => {
    expect(resolutionRootDepth('/', path.posix)).toBe(0);
    expect(resolutionRootDepth('/a/b', path.posix)).toBe(2);
    // Two `..` steps reach `C:\` from `C:\a\b`; the drive is not a step.
    expect(resolutionRootDepth('C:\\', path.win32)).toBe(0);
    expect(resolutionRootDepth('C:\\a\\b', path.win32)).toBe(2);
    expect(resolutionRootDepth('\\\\server\\share\\a', path.win32)).toBe(1);
  });

  it('maps identical variant inputs to one base and keeps variants with different inputs apart', () => {
    const shadow = path.join(root, 'shadow');
    const identity = {
      repoId: '__workspace_root__',
      customLanguagesFingerprint: fingerprint,
    };
    // Identical inputs (another workspace over the same repository) share
    // one variant directory, so one base and one maintenance build.
    expect(getCodeGraphBaseVariantDir(shadow, { ...identity })).toBe(
      getCodeGraphBaseVariantDir(shadow, identity),
    );
    expect(codeGraphBaseVariantHash({ ...identity })).toBe(
      codeGraphBaseVariantHash(identity),
    );
    // A different repository id or custom-language input is a different
    // variant.
    expect(
      getCodeGraphBaseVariantDir(shadow, { ...identity, repoId: 'canopy' }),
    ).not.toBe(getCodeGraphBaseVariantDir(shadow, identity));
    expect(
      getCodeGraphBaseVariantDir(shadow, {
        ...identity,
        customLanguagesFingerprint: `${fingerprint}-other`,
      }),
    ).not.toBe(getCodeGraphBaseVariantDir(shadow, identity));
  });

  it('builds non-identical graphs for one checkout under two repository ids, so those variants never share a base', async () => {
    const checkout = path.join(root, 'checkout');
    writeRepo(checkout, LIB_A, MAIN_A);
    const baseRoot = await buildAndPublish({
      repoId: '__workspace_root__',
      sourceRoot: checkout,
      generationId: 'generation-root',
    });
    const baseNamed = await buildAndPublish({
      repoId: 'canopy',
      sourceRoot: checkout,
      generationId: 'generation-named',
    });
    expect(path.dirname(path.dirname(path.dirname(baseRoot.dbPath)))).not.toBe(
      path.dirname(path.dirname(path.dirname(baseNamed.dbPath))),
    );
    for (const table of ['repositories', 'files', 'symbols', 'edges']) {
      const rootRows = normalizedRows(baseRoot.dbPath, table);
      const namedRows = normalizedRows(baseNamed.dbPath, table);
      expect(rootRows.length).toBe(namedRows.length);
      // Same facts, different row identities: every id hashes the repository id.
      expect(rootRows).not.toEqual(namedRows);
    }
  });
});

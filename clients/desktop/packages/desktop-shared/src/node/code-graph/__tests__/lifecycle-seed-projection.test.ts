/**
 * PRIVATE DRAFT ONLY. Intended as additive coverage after the lifecycle and
 * summary-projection implementation is adopted. This module is deliberately
 * unrun; it does not edit the existing seeding or snapshot tests.
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodeGraphEngine } from '../engine';
import {
  getCodeGraphBaseVariantDir,
  prepareCodeGraphBaseStaging,
  publishCodeGraphBase,
  readCodeGraphSummaryProjection,
  readReadonlyCodeGraphSummaryProjectionAssembly,
  seedCodeGraphDatabase,
  type CodeGraphSeedSource,
  type ValidatedCodeGraphBase,
} from '../base-graph';
import {
  backfillCodeGraphSummaryProjection,
  parseCodeGraphImportedTimestamp,
} from '../summary-projection';
import { fingerprintCustomLanguageInputs } from '../languages/custom-config';
import { deleteMetadataValue, setMetadataValue } from '../store/database';

const REPO_A = 'lifecycle-repo-a';
const REPO_B = 'lifecycle-repo-b';
const LIB = `export function work(): number { return 42; }\n`;
const MAIN = `import { work } from './lib';\nexport function run(): number { return work(); }\n`;

function writeFixture(rootPath: string): void {
  mkdirSync(path.join(rootPath, 'src'), { recursive: true });
  writeFileSync(path.join(rootPath, 'src', 'lib.ts'), LIB);
  writeFileSync(path.join(rootPath, 'src', 'main.ts'), MAIN);
}

function metadata(dbPath: string, key: string): string | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT value FROM graph_metadata WHERE key = ?')
      .get(key);
    return row === undefined ? null : String(Reflect.get(row, 'value'));
  } finally {
    db.close();
  }
}

function updateMetadata(
  dbPath: string,
  key: string,
  value: string | null,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    if (value === null) {
      deleteMetadataValue(db, key);
    } else {
      setMetadataValue(db, key, value);
    }
  } finally {
    db.close();
  }
}

async function buildAndPublish(input: {
  root: string;
  fingerprint: string;
  repoId: string;
  sourceRoot: string;
  generationId: string;
}): Promise<ValidatedCodeGraphBase> {
  const variantDir = getCodeGraphBaseVariantDir(
    path.join(input.root, `shadow-${input.repoId}`),
    {
      repoId: input.repoId,
      customLanguagesFingerprint: input.fingerprint,
    },
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
      customLanguagesFingerprint: input.fingerprint,
    },
    gitHead: null,
    generationId: input.generationId,
  });
}

function seedSource(input: {
  base: ValidatedCodeGraphBase;
  sourceDbPath?: string;
  repoId: string;
  canonicalRepoRoot: string;
  destinationRootPath: string;
  completedBuildAt?: number;
}): CodeGraphSeedSource {
  return {
    dbPath: input.sourceDbPath ?? input.base.dbPath,
    repoId: input.repoId,
    canonicalRepoRoot: input.canonicalRepoRoot,
    destinationRootPath: input.destinationRootPath,
    generationId: input.base.manifest.generationId,
    gitHead: input.base.manifest.gitHead,
    ...(input.completedBuildAt === undefined
      ? {}
      : { completedBuildAt: input.completedBuildAt }),
  };
}

describe('strict imported snapshot timestamps for eager source fusion', () => {
  it('accepts only bounded canonical UTC timestamps', () => {
    expect(parseCodeGraphImportedTimestamp('2026-10-07T10:11:12Z')).toBe(
      Date.parse('2026-10-07T10:11:12Z'),
    );
    expect(parseCodeGraphImportedTimestamp('2026-10-07T10:11:12.3Z')).toBe(
      Date.parse('2026-10-07T10:11:12.3Z'),
    );
    expect(parseCodeGraphImportedTimestamp('2026-10-07T10:11:12.123Z')).toBe(
      Date.parse('2026-10-07T10:11:12.123Z'),
    );

    const oversizedDate = `${'October 7, 2026'}${' '.repeat(129)}`;
    const noncanonicalButDateParseable = [
      '1',
      'October 7, 2026',
      '2026-10-07T10:11:12+00:00',
      '2026-02-30T10:11:12.000Z',
      '1969-12-31T23:59:59.999Z',
      oversizedDate,
    ];
    expect(Number.isFinite(Date.parse('1'))).toBe(true);
    expect(Number.isFinite(Date.parse('October 7, 2026'))).toBe(true);
    expect(Number.isFinite(Date.parse('2026-10-07T10:11:12+00:00'))).toBe(true);
    expect(Number.isFinite(Date.parse('2026-02-30T10:11:12.000Z'))).toBe(true);
    expect(Number.isFinite(Date.parse(oversizedDate))).toBe(true);
    expect(oversizedDate.length).toBeGreaterThan(128);
    for (const raw of noncanonicalButDateParseable) {
      expect(parseCodeGraphImportedTimestamp(raw)).toBeNull();
    }
  });
});

describe('eager seed completion evidence', () => {
  let root: string;
  let fingerprint: string;
  let sourceRoot: string;
  let sourceDbPath: string;
  let base: ValidatedCodeGraphBase;
  let targetSequence: number;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-lifecycle-seed-'));
    fingerprint = (await fingerprintCustomLanguageInputs(root)).value;
    sourceRoot = path.join(root, 'source-a');
    writeFixture(sourceRoot);
    base = await buildAndPublish({
      root,
      fingerprint,
      repoId: REPO_A,
      sourceRoot,
      generationId: 'generation-a',
    });
    sourceDbPath = path.join(root, 'mutable-source-a.db');
    // Seed tests perturb metadata on private mutable copies, never on the
    // immutable published generation returned by publishCodeGraphBase().
    copyFileSync(base.dbPath, sourceDbPath);
    targetSequence = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function eagerSeed(sources: readonly CodeGraphSeedSource[]): Promise<{
    targetDbPath: string;
    installed: boolean;
    statuses: string[];
  }> {
    const targetDbPath = path.join(
      root,
      `fused-${targetSequence++}`,
      'graph.db',
    );
    const result = await seedCodeGraphDatabase({
      targetDbPath,
      customLanguagesFingerprint: fingerprint,
      sources,
      markCompletedFromSources: true,
    });
    return {
      targetDbPath,
      installed: result.installed,
      statuses: result.outcomes.map((outcome) => outcome.status),
    };
  }

  it('keeps completion when actual and valid imported sources both provide retained completion evidence', async () => {
    const sourceBRoot = path.join(root, 'source-b');
    writeFixture(sourceBRoot);
    const baseB = await buildAndPublish({
      root,
      fingerprint,
      repoId: REPO_B,
      sourceRoot: sourceBRoot,
      generationId: 'generation-b',
    });
    const sourceBDbPath = path.join(root, 'mutable-source-b.db');
    copyFileSync(baseB.dbPath, sourceBDbPath);
    const completedA = metadata(sourceDbPath, 'completed_build_at');
    const completedB = metadata(sourceBDbPath, 'completed_build_at');
    if (completedA === null || completedB === null) {
      throw new Error('Expected published fixtures to have completed markers.');
    }
    updateMetadata(
      sourceBDbPath,
      'imported_from_snapshot',
      new Date(Number(completedB) - 1).toISOString(),
    );

    const fused = await eagerSeed([
      seedSource({
        base,
        sourceDbPath,
        repoId: REPO_A,
        canonicalRepoRoot: sourceRoot,
        destinationRootPath: path.join(root, 'destination-a'),
      }),
      seedSource({
        base: baseB,
        sourceDbPath: sourceBDbPath,
        repoId: REPO_B,
        canonicalRepoRoot: sourceBRoot,
        destinationRootPath: path.join(root, 'destination-b'),
      }),
    ]);
    const expectedCompletion = String(
      Math.max(Number(completedA), Number(completedB)),
    );

    expect(fused.installed).toBe(true);
    expect(fused.statuses).toEqual(['seeded', 'seeded']);
    expect(metadata(fused.targetDbPath, 'completed_build_at')).toBe(
      expectedCompletion,
    );
    expect(metadata(fused.targetDbPath, 'last_build_at')).toBe(
      expectedCompletion,
    );
    expect(readCodeGraphSummaryProjection(fused.targetDbPath)).toMatchObject({
      state: 'ready',
      projection: {
        assembly: 'complete',
        completedBuildAt: Number(expectedCompletion),
        lastBuildAt: Number(expectedCompletion),
      },
    });
  });

  const invalidImportedMarkers = [
    '1',
    'October 7, 2026',
    '2026-10-07T10:11:12+00:00',
    '2026-02-30T10:11:12.000Z',
    '1969-12-31T23:59:59.999Z',
    `${'October 7, 2026'}${' '.repeat(129)}`,
  ];

  for (const marker of invalidImportedMarkers) {
    it(`does not promote imported completion for noncanonical marker ${JSON.stringify(marker)}`, async () => {
      const completed = metadata(sourceDbPath, 'completed_build_at');
      if (completed === null) {
        throw new Error('Expected a generated completion marker.');
      }
      updateMetadata(sourceDbPath, 'imported_from_snapshot', marker);
      const fused = await eagerSeed([
        seedSource({
          base,
          sourceDbPath,
          repoId: REPO_A,
          canonicalRepoRoot: sourceRoot,
          destinationRootPath: path.join(root, 'destination'),
          // Caller-supplied timestamps cannot substitute for invalid retained
          // evidence from the attached source.
          completedBuildAt: Number(completed),
        }),
      ]);

      expect(fused.installed).toBe(true);
      expect(fused.statuses).toEqual(['seeded']);
      expect(metadata(fused.targetDbPath, 'last_build_at')).toBeNull();
      expect(metadata(fused.targetDbPath, 'completed_build_at')).toBeNull();
      expect(readCodeGraphSummaryProjection(fused.targetDbPath)).toMatchObject({
        state: 'pending',
        reason: 'projection-missing',
      });
    });
  }

  it('does not promote completion older than a valid canonical import even with a caller override', async () => {
    const completedRaw = metadata(sourceDbPath, 'completed_build_at');
    if (completedRaw === null)
      throw new Error('Expected generated completion evidence.');
    const importAt = Number(completedRaw) + 1000;
    updateMetadata(
      sourceDbPath,
      'imported_from_snapshot',
      new Date(importAt).toISOString(),
    );
    const fused = await eagerSeed([
      seedSource({
        base,
        sourceDbPath,
        repoId: REPO_A,
        canonicalRepoRoot: sourceRoot,
        destinationRootPath: path.join(root, 'destination'),
        completedBuildAt: importAt + 1000,
      }),
    ]);
    expect(fused.statuses).toEqual(['seeded']);
    expect(metadata(fused.targetDbPath, 'last_build_at')).toBeNull();
    expect(metadata(fused.targetDbPath, 'completed_build_at')).toBeNull();
    expect(readCodeGraphSummaryProjection(fused.targetDbPath)).toMatchObject({
      state: 'pending',
      reason: 'projection-missing',
    });
  });

  const invalidCompletionMarkers = [
    '-1',
    '9007199254740992',
    '1.5',
    'not-a-number',
  ];

  for (const marker of invalidCompletionMarkers) {
    it(`does not promote invalid retained completion ${JSON.stringify(marker)} from a caller override`, async () => {
      updateMetadata(sourceDbPath, 'completed_build_at', marker);
      updateMetadata(sourceDbPath, 'last_build_at', '1700000000000');
      const fused = await eagerSeed([
        seedSource({
          base,
          sourceDbPath,
          repoId: REPO_A,
          canonicalRepoRoot: sourceRoot,
          destinationRootPath: path.join(root, 'destination'),
          completedBuildAt: 1700000000000,
        }),
      ]);

      expect(fused.installed).toBe(true);
      expect(fused.statuses).toEqual(['seeded']);
      expect(metadata(fused.targetDbPath, 'last_build_at')).toBeNull();
      expect(metadata(fused.targetDbPath, 'completed_build_at')).toBeNull();
      expect(readCodeGraphSummaryProjection(fused.targetDbPath)).toMatchObject({
        state: 'pending',
        reason: 'projection-missing',
      });
    });
  }

  it('measures legacy last-only completion in readonly assembly/backfill but preserves eager source eligibility', async () => {
    const legacyLastBuildAt = '1700000000000';
    updateMetadata(sourceDbPath, 'completed_build_at', null);
    updateMetadata(sourceDbPath, 'last_build_at', legacyLastBuildAt);
    updateMetadata(sourceDbPath, 'imported_from_snapshot', null);
    updateMetadata(sourceDbPath, 'derived_pending', null);

    // Full published-base/source compatibility validation still requires the
    // explicit completed marker. Summary assembly can honestly measure this
    // committed legacy graph without widening eager source eligibility.
    const assembled =
      readReadonlyCodeGraphSummaryProjectionAssembly(sourceDbPath);
    expect(assembled).toMatchObject({
      state: 'ready',
      projection: {
        assembly: 'complete',
        lastBuildAt: Number(legacyLastBuildAt),
        completedBuildAt: null,
      },
    });
    if (assembled.state !== 'ready')
      throw new Error('Expected legacy readonly assembly.');
    expect(assembled.projection.totals.fileCount).toBe(2);
    const writer = new DatabaseSync(sourceDbPath);
    try {
      const backfilled = backfillCodeGraphSummaryProjection(sourceDbPath, {
        db: writer,
      });
      expect(backfilled.state).toBe('ready');
      expect(metadata(sourceDbPath, 'last_build_at')).toBe(legacyLastBuildAt);
      expect(metadata(sourceDbPath, 'completed_build_at')).toBeNull();
      const published = readCodeGraphSummaryProjection(sourceDbPath);
      expect(published).toMatchObject({
        state: 'ready',
        projection: {
          assembly: 'complete',
          lastBuildAt: Number(legacyLastBuildAt),
          completedBuildAt: null,
          totals: assembled.projection.totals,
        },
      });
      if (published.state !== 'ready')
        throw new Error('Expected legacy measured backfill.');
      expect(published.projection.projectionRevision).toBeGreaterThan(
        assembled.projection.projectionRevision,
      );
    } finally {
      writer.close();
    }

    const fused = await eagerSeed([
      seedSource({
        base,
        sourceDbPath,
        repoId: REPO_A,
        canonicalRepoRoot: sourceRoot,
        destinationRootPath: path.join(root, 'destination'),
      }),
    ]);

    expect(fused.installed).toBe(true);
    expect(fused.statuses).toEqual(['cold-fallback']);
    expect(metadata(fused.targetDbPath, 'last_build_at')).toBeNull();
    expect(metadata(fused.targetDbPath, 'completed_build_at')).toBeNull();
    expect(readCodeGraphSummaryProjection(fused.targetDbPath)).toMatchObject({
      state: 'pending',
      reason: 'projection-missing',
    });
  });
});

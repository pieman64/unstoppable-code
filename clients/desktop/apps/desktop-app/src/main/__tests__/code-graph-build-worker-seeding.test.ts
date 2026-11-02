/**
 * Phase 20 (G2, G6) in the build worker, against the real engine in-process.
 *
 * - A new single-repository worktree on the deferred seeding path clones its
 *   published base and keeps the base's metadata (resolution inputs, the
 *   derived marker, diagnostics), so an unchanged checkout skips whole-graph
 *   resolution, the full-text rebuild and derived analysis, and its refresh
 *   still equals a cold build and still records time to first graph.
 * - A transformed checkout (smudge filter or `eol`), whose index blob equals
 *   the base's but whose working-tree bytes differ, never keeps the base's
 *   stale symbols or edges: the refresh reads the working tree.
 * - A worktree build asked to defer derived analysis publishes first and
 *   completes derived analysis in a second step; base finalization never
 *   defers.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  getCodeGraphBaseVariantDir,
  prepareCodeGraphBaseStaging,
  publishCodeGraphBase,
  type CodeGraphSeedSource,
} from '@canopy/code-graph/base-graph';
import { CodeGraphEngine } from '@canopy/code-graph/engine';
import { fingerprintCustomLanguageInputs } from '@canopy/code-graph/languages/custom-config';
import { getBundledCodeGraphDir } from '@canopy/desktop-shared/pipelines/config-paths';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import {
  executeCodeGraphBuild,
  executeDeferredCodeGraphDerived,
} from '../code-graph/build-worker';

interface SeedBase {
  dbPath: string;
  gitHead: string | null;
}

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

const LIB = `export function foo(): number {
  return 41;
}
`;
const MAIN = `import { foo } from './lib';

export function run(): number {
  return foo() + 1;
}
`;

function metadata(dbPath: string, key: string): string | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT value FROM graph_metadata WHERE key = ?')
      .get(key);
    return row === undefined ? null : String(row.value);
  } finally {
    db.close();
  }
}

/**
 * Rows in a stable order, without checkout paths or timestamps. Community ids
 * are replaced by fingerprints: an incremental build keeps a community's id
 * across builds (stable-id retention), so a seeded refresh and a cold build
 * mint different ids for the same community.
 */
function sortedRows(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const fingerprintById = new Map(
      db
        .prepare('SELECT id, fingerprint FROM communities')
        .all()
        .map((row) => [String(row.id), String(row.fingerprint)]),
    );
    return db
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((row) => {
        const copy: Record<string, unknown> = { ...row };
        delete copy.updated_at;
        delete copy.root_path;
        delete copy.absolute_path;
        if (table === 'communities') delete copy.id;
        if (table === 'community_memberships') {
          copy.community_id = fingerprintById.get(String(copy.community_id));
        }
        return JSON.stringify(copy);
      })
      .sort();
  } finally {
    db.close();
  }
}

function qualifiedNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare('SELECT qualified_name FROM symbols ORDER BY qualified_name')
      .all()
      .map((row) => String(row.qualified_name));
  } finally {
    db.close();
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('code graph build worker seeding reuse', () => {
  let root: string;
  let sourceRoot: string;
  let fingerprint: string;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-worker-seeding-'));
    sourceRoot = path.join(root, 'source');
    mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
    writeFileSync(path.join(sourceRoot, 'src', 'lib.ts'), LIB);
    writeFileSync(path.join(sourceRoot, 'src', 'main.ts'), MAIN);
    fingerprint = (await fingerprintCustomLanguageInputs(sourceRoot)).value;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function headOf(rootPath: string): string | null {
    try {
      return git(rootPath, 'rev-parse', 'HEAD').trim();
    } catch {
      return null;
    }
  }

  async function publishBase(): Promise<SeedBase> {
    const gitHead = existsSync(path.join(sourceRoot, '.git'))
      ? headOf(sourceRoot)
      : null;
    const variantDir = getCodeGraphBaseVariantDir(path.join(root, 'shadow'), {
      repoId: WORKSPACE_ROOT_REPO_ID,
      customLanguagesFingerprint: fingerprint,
    });
    const staging = await prepareCodeGraphBaseStaging({
      variantDir,
      buildId: 'generation-a',
    });
    const engine = await CodeGraphEngine.open({
      dbPath: staging.dbPath,
      repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: sourceRoot }],
      worktreeRootPath: sourceRoot,
    });
    try {
      await engine.buildOrUpdate();
    } finally {
      engine.close();
    }
    const published = await publishCodeGraphBase({
      variantDir,
      stagingDir: staging.stagingDir,
      identity: {
        repoId: WORKSPACE_ROOT_REPO_ID,
        canonicalRepoRoot: sourceRoot,
        customLanguagesFingerprint: fingerprint,
      },
      gitHead,
      generationId: 'generation-a',
    });
    return { dbPath: published.dbPath, gitHead };
  }

  /** Mirrors main's seed copy: a private copy of the published generation. */
  function stagedSeedSource(
    base: SeedBase,
    seedStagingDir: string,
    destinationRootPath: string,
  ): CodeGraphSeedSource {
    mkdirSync(seedStagingDir, { recursive: true });
    const copied = path.join(seedStagingDir, 'seed-copy.db');
    copyFileSync(base.dbPath, copied);
    return {
      dbPath: copied,
      repoId: WORKSPACE_ROOT_REPO_ID,
      canonicalRepoRoot: sourceRoot,
      destinationRootPath,
      generationId: 'generation-a',
      gitHead: base.gitHead,
      completedBuildAt: 1,
    };
  }

  async function seededBuild(
    destination: string,
    base: SeedBase,
    dbPath: string,
  ): Promise<Awaited<ReturnType<typeof executeCodeGraphBuild>>> {
    const seedStagingDir = path.join(path.dirname(dbPath), 'seed-staging');
    return executeCodeGraphBuild({
      dbPath,
      worktreeRootPath: destination,
      resourcesDir: getBundledCodeGraphDir(),
      repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: destination }],
      options: {},
      preparation: {
        seedSources: [stagedSeedSource(base, seedStagingDir, destination)],
        coldFallbacks: [],
        customLanguagesFingerprint: fingerprint,
        seedStagingDir,
      },
      timings: { seedCopyMs: 1, firstGraphRequestedAt: Date.now() - 1_000 },
    });
  }

  async function coldBuild(destination: string, dbPath: string): Promise<void> {
    const engine = await CodeGraphEngine.open({
      dbPath,
      repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: destination }],
      worktreeRootPath: destination,
    });
    try {
      await engine.buildOrUpdate();
    } finally {
      engine.close();
    }
  }

  it('clones the base for a deferred single-repository seed and keeps its metadata', async () => {
    const base = await publishBase();
    const destination = path.join(root, 'worktree');
    cpSync(sourceRoot, destination, { recursive: true });
    const dbPath = path.join(root, 'worktree-data', 'graph.db');

    const response = await seededBuild(destination, base, dbPath);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.seedOutcomes).toEqual([
      expect.objectContaining({
        repoId: WORKSPACE_ROOT_REPO_ID,
        status: 'seeded',
        generationId: 'generation-a',
      }),
    ]);
    // Every file is read again (new checkout, new mtimes) but none reparsed,
    // and nothing graph-wide is recomputed.
    expect(response.result.filesParsed).toBe(0);
    expect(response.result.factsChanged).toBe(false);
    expect(response.result.timings?.resolveMs).toBeUndefined();
    expect(response.result.timings?.ftsMs).toBeUndefined();
    expect(response.result.timings?.derivedMs).toBeUndefined();
    // The clone is this worktree's first graph.
    expect(response.result.timings?.timeToFirstGraphMs).toEqual(
      expect.any(Number),
    );
    expect(metadata(dbPath, 'time_to_first_graph_ms')).not.toBeNull();
    expect(metadata(dbPath, 'completed_build_at')).not.toBeNull();
    expect(metadata(dbPath, 'derived_at')).not.toBeNull();

    const coldDbPath = path.join(root, 'cold', 'graph.db');
    await coldBuild(destination, coldDbPath);
    for (const table of GRAPH_TABLES) {
      expect(sortedRows(dbPath, table)).toEqual(sortedRows(coldDbPath, table));
    }
  });

  it('reparses changed files in a cloned seed and still equals a cold build', async () => {
    const base = await publishBase();
    const destination = path.join(root, 'worktree');
    cpSync(sourceRoot, destination, { recursive: true });
    writeFileSync(
      path.join(destination, 'src', 'extra.ts'),
      `import { run } from './main';\nexport function extra(): number { return run(); }\n`,
    );
    const dbPath = path.join(root, 'worktree-data', 'graph.db');
    const response = await seededBuild(destination, base, dbPath);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.result.factsChanged).toBe(true);

    const coldDbPath = path.join(root, 'cold', 'graph.db');
    await coldBuild(destination, coldDbPath);
    for (const table of GRAPH_TABLES) {
      expect(sortedRows(dbPath, table)).toEqual(sortedRows(coldDbPath, table));
    }
  });

  describe('transformed checkouts', () => {
    function initSourceRepository(): string {
      git(sourceRoot, 'init', '-q', '-b', 'main');
      git(sourceRoot, 'config', 'user.email', 'test@example.com');
      git(sourceRoot, 'config', 'user.name', 'Test');
      git(sourceRoot, 'add', '-A');
      git(sourceRoot, 'commit', '-q', '-m', 'init');
      return git(sourceRoot, 'ls-files', '-s', 'src/lib.ts').split(/\s+/)[1];
    }

    function transformedClone(
      destination: string,
      configure: (gitDir: string) => void,
    ): void {
      git(root, 'clone', '-q', '--no-checkout', sourceRoot, destination);
      configure(path.join(destination, '.git'));
      git(destination, 'reset', '-q', '--hard', 'HEAD');
    }

    async function expectWorkingTreeWins(
      destination: string,
      blobId: string,
    ): Promise<void> {
      // The index blob still equals the base's, git reports the checkout
      // clean, and yet the working-tree bytes differ from what the base parsed.
      expect(git(destination, 'ls-files', '-s', 'src/lib.ts')).toContain(
        blobId,
      );
      expect(git(destination, 'diff-files', '--name-only')).toBe('');
      expect(readFileSync(path.join(destination, 'src', 'lib.ts'))).not.toEqual(
        readFileSync(path.join(sourceRoot, 'src', 'lib.ts')),
      );

      const base = await publishBase();
      const dbPath = path.join(root, 'worktree-data', 'graph.db');
      const response = await seededBuild(destination, base, dbPath);
      expect(response.ok).toBe(true);

      const coldDbPath = path.join(root, 'cold', 'graph.db');
      await coldBuild(destination, coldDbPath);
      for (const table of GRAPH_TABLES) {
        expect(sortedRows(dbPath, table)).toEqual(
          sortedRows(coldDbPath, table),
        );
      }
      return Promise.resolve();
    }

    it('never keeps stale symbols when a smudge filter changed the working-tree bytes', async () => {
      const blobId = initSourceRepository();
      const destination = path.join(root, 'worktree');
      transformedClone(destination, (gitDir) => {
        mkdirSync(path.join(gitDir, 'info'), { recursive: true });
        writeFileSync(
          path.join(gitDir, 'info', 'attributes'),
          '*.ts filter=swap\n',
        );
        git(
          path.dirname(gitDir),
          'config',
          'filter.swap.smudge',
          'sed s/foo/bar/g',
        );
        git(
          path.dirname(gitDir),
          'config',
          'filter.swap.clean',
          'sed s/bar/foo/g',
        );
      });
      await expectWorkingTreeWins(destination, blobId);
      const dbPath = path.join(root, 'worktree-data', 'graph.db');
      expect(qualifiedNames(dbPath)).toEqual(
        expect.arrayContaining(['src/lib.ts::bar', 'src/main.ts::run']),
      );
      expect(qualifiedNames(dbPath)).not.toContain('src/lib.ts::foo');
    });

    it('never keeps stale byte ranges when eol conversion changed the working-tree bytes', async () => {
      const blobId = initSourceRepository();
      const destination = path.join(root, 'worktree');
      transformedClone(destination, (gitDir) => {
        mkdirSync(path.join(gitDir, 'info'), { recursive: true });
        writeFileSync(
          path.join(gitDir, 'info', 'attributes'),
          '*.ts text eol=crlf\n',
        );
      });
      expect(
        readFileSync(path.join(destination, 'src', 'lib.ts'), 'utf8'),
      ).toContain('\r\n');
      await expectWorkingTreeWins(destination, blobId);
    });
  });

  it('runs a deferring build inline for an in-process caller that cannot receive the publication', async () => {
    const dbPath = path.join(root, 'worktree-data', 'graph.db');
    const response = await executeCodeGraphBuild({
      dbPath,
      worktreeRootPath: sourceRoot,
      resourcesDir: getBundledCodeGraphDir(),
      repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: sourceRoot }],
      options: {},
      deferDerived: true,
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.derivedPending).toBeUndefined();
    expect(response.result.derived[0]?.computed).toBe(true);
    expect(metadata(dbPath, 'derived_at')).not.toBeNull();
  });

  it('publishes a worktree build before deferred derived analysis and completes it in a second step', async () => {
    const dbPath = path.join(root, 'worktree-data', 'graph.db');
    const response = await executeCodeGraphBuild(
      {
        dbPath,
        worktreeRootPath: sourceRoot,
        resourcesDir: getBundledCodeGraphDir(),
        repositories: [
          { repoId: WORKSPACE_ROOT_REPO_ID, rootPath: sourceRoot },
        ],
        options: {},
        deferDerived: true,
      },
      { allowDeferredDerived: true },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.derivedPending).toBe(true);
    expect(response.result.derivedDeferred).toBe(true);
    expect(metadata(dbPath, 'completed_build_at')).not.toBeNull();
    expect(metadata(dbPath, 'derived_at')).toBeNull();

    const completion = await executeDeferredCodeGraphDerived({ dbPath });
    expect(completion).toMatchObject({
      kind: 'derived-complete',
      ok: true,
      ran: true,
    });
    expect(metadata(dbPath, 'derived_at')).not.toBeNull();

    const again = await executeDeferredCodeGraphDerived({ dbPath });
    expect(again).toMatchObject({ kind: 'derived-complete', ran: false });
  });

  it('never defers derived analysis for a base build it finalizes', async () => {
    const variantDir = getCodeGraphBaseVariantDir(path.join(root, 'shadow'), {
      repoId: WORKSPACE_ROOT_REPO_ID,
      customLanguagesFingerprint: fingerprint,
    });
    const staging = await prepareCodeGraphBaseStaging({
      variantDir,
      buildId: 'generation-b',
    });
    const response = await executeCodeGraphBuild(
      {
        dbPath: staging.dbPath,
        worktreeRootPath: sourceRoot,
        resourcesDir: getBundledCodeGraphDir(),
        repositories: [
          { repoId: WORKSPACE_ROOT_REPO_ID, rootPath: sourceRoot },
        ],
        options: {},
        deferDerived: true,
        baseFinalization: {
          identity: {
            repoId: WORKSPACE_ROOT_REPO_ID,
            canonicalRepoRoot: sourceRoot,
            customLanguagesFingerprint: fingerprint,
          },
          gitHead: null,
        },
      },
      { allowDeferredDerived: true },
    );
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.derivedPending).toBeUndefined();
    expect(response.result.derivedDeferred).toBeUndefined();
    expect(metadata(staging.dbPath, 'derived_at')).not.toBeNull();
  });
});

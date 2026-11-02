/**
 * The build worker hands main the phase timings of the build it ran, with the
 * worker-only phases (seed fusion, base finalization) and the main-side
 * prelude it was sent, and persists the build's own timings in graph metadata.
 * These exercise the real engine in-process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  getCodeGraphBaseVariantDir,
  prepareCodeGraphBaseStaging,
} from '@canopy/code-graph/base-graph';
import { fingerprintCustomLanguageInputs } from '@canopy/code-graph/languages/custom-config';
import { getBundledCodeGraphDir } from '@canopy/desktop-shared/pipelines/config-paths';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { executeCodeGraphBuild } from '../code-graph/build-worker';

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

describe('code graph build worker timings', () => {
  let root: string;
  let sourceRoot: string;
  // The engine runs in-process and its first build starts cold; busy CI
  // runners have taken longer than Jest's default 5 s for it.
  jest.setTimeout(30_000);

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-worker-timings-'));
    sourceRoot = path.join(root, 'source');
    mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
    writeFileSync(
      path.join(sourceRoot, 'src', 'value.ts'),
      'export function value(): number { return 1; }\n',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns and persists the prelude, fusion and engine timings of a worktree build', async () => {
    const dbPath = path.join(root, 'worktree', 'graph.db');
    const seedStagingDir = path.join(root, 'worktree', 'seed-staging', 'one');
    mkdirSync(seedStagingDir, { recursive: true });
    const requestedAt = Date.now() - 2_000;

    const response = await executeCodeGraphBuild({
      dbPath,
      worktreeRootPath: sourceRoot,
      resourcesDir: getBundledCodeGraphDir(),
      repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: sourceRoot }],
      options: {},
      preparation: {
        seedSources: [],
        coldFallbacks: [{ repoId: WORKSPACE_ROOT_REPO_ID, reason: 'no base' }],
        customLanguagesFingerprint: '',
        seedStagingDir,
      },
      timings: {
        queueWaitMs: 75,
        fingerprintMs: 12,
        seedCopyMs: 0,
        firstGraphRequestedAt: requestedAt,
      },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const timings = response.result.timings;
    expect(timings).toMatchObject({
      queueWaitMs: 75,
      fingerprintMs: 12,
      seedCopyMs: 0,
    });
    expect(timings?.fusionMs).toBeGreaterThanOrEqual(0);
    expect(timings?.peakRssBytes).toBeGreaterThan(0);
    expect(timings?.timeToFirstGraphMs).toBeGreaterThanOrEqual(2_000);
    expect(metadata(dbPath, 'build_timing:queue_wait_ms')).toBe('75');
    expect(metadata(dbPath, 'build_timing:fusion_ms')).not.toBeNull();
    expect(Number(metadata(dbPath, 'time_to_first_graph_ms'))).toBe(
      timings?.timeToFirstGraphMs,
    );
  });

  it('reports base finalization with the build timings', async () => {
    const identity = {
      repoId: WORKSPACE_ROOT_REPO_ID,
      canonicalRepoRoot: sourceRoot,
      customLanguagesFingerprint: (
        await fingerprintCustomLanguageInputs(sourceRoot)
      ).value,
    };
    const staging = await prepareCodeGraphBaseStaging({
      variantDir: getCodeGraphBaseVariantDir(
        path.join(root, 'shadow'),
        identity,
      ),
    });

    const response = await executeCodeGraphBuild({
      dbPath: staging.dbPath,
      worktreeRootPath: sourceRoot,
      customLanguagesRootPath: sourceRoot,
      resourcesDir: getBundledCodeGraphDir(),
      repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: sourceRoot }],
      options: {},
      baseFinalization: { identity, gitHead: null },
      timings: { queueWaitMs: 3, seedCopyMs: 9 },
    });

    expect(response).toMatchObject({ ok: true, baseFinalized: true });
    if (!response.ok) return;
    expect(response.result.timings?.finalizeMs).toBeGreaterThanOrEqual(0);
    expect(response.result.timings).toMatchObject({
      queueWaitMs: 3,
      seedCopyMs: 9,
    });
    // The finalized base carries the build's own timings.
    expect(metadata(staging.dbPath, 'build_timing:seed_copy_ms')).toBe('9');
    expect(metadata(staging.dbPath, 'build_timing:commit_ms')).not.toBeNull();
  });
});

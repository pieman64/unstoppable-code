/**
 * Base finalization runs inside the build worker so Electron main only renames
 * the staging directory into place. These exercise the real engine in-process.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  getCodeGraphBaseVariantDir,
  installCodeGraphBaseGeneration,
  prepareCodeGraphBaseStaging,
  readPublishedCodeGraphBase,
} from '@canopy/desktop-shared/node/code-graph/base-graph';
import { fingerprintCustomLanguageInputs } from '@canopy/desktop-shared/node/code-graph/languages/custom-config';
import { getBundledCodeGraphDir } from '@canopy/desktop-shared/pipelines/config-paths';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { executeCodeGraphBuild } from '../code-graph/build-worker';
import { executeCodeGraphRead } from '../code-graph/read-worker';

describe('code graph build worker base finalization', () => {
  let root: string;
  let sourceRoot: string;
  let identity: {
    repoId: string;
    canonicalRepoRoot: string;
    customLanguagesFingerprint: string;
  };
  let variantDir: string;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-finalize-'));
    sourceRoot = path.join(root, 'source');
    mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
    writeFileSync(
      path.join(sourceRoot, 'src', 'value.ts'),
      'export function value(): number { return 1; }\n',
    );
    identity = {
      repoId: WORKSPACE_ROOT_REPO_ID,
      canonicalRepoRoot: sourceRoot,
      customLanguagesFingerprint: (
        await fingerprintCustomLanguageInputs(sourceRoot)
      ).value,
    };
    variantDir = getCodeGraphBaseVariantDir(
      path.join(root, 'shadow'),
      identity,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function buildStaging(
    gitHead: string | null,
  ): Promise<{ stagingDir: string; response: unknown }> {
    const staging = await prepareCodeGraphBaseStaging({ variantDir });
    const response = await executeCodeGraphBuild({
      dbPath: staging.dbPath,
      worktreeRootPath: sourceRoot,
      customLanguagesRootPath: sourceRoot,
      resourcesDir: getBundledCodeGraphDir(),
      repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: sourceRoot }],
      options: {},
      baseFinalization: { identity, gitHead },
    });
    return { stagingDir: staging.stagingDir, response };
  }

  it('finalizes a base build that main can install without SQLite', async () => {
    const { stagingDir, response } = await buildStaging(null);

    expect(response).toMatchObject({ ok: true, baseFinalized: true });
    await installCodeGraphBaseGeneration({
      variantDir,
      stagingDir,
      identity,
      gitHead: null,
    });
    await expect(
      readPublishedCodeGraphBase({ variantDir, identity, validation: 'full' }),
    ).resolves.toMatchObject({ manifest: { gitHead: null }, recovered: false });
  });

  it('repairs a private staged base without mutating the immutable publication', async () => {
    const { stagingDir } = await buildStaging(null);
    const published = await installCodeGraphBaseGeneration({
      variantDir,
      stagingDir,
      identity,
      gitHead: null,
    });
    const publishedBytes = createHash('sha256')
      .update(readFileSync(published.dbPath))
      .digest('hex');
    const staged = await prepareCodeGraphBaseStaging({
      variantDir,
      sourceDbPath: published.dbPath,
    });

    const response = await executeCodeGraphBuild({
      dbPath: staged.dbPath,
      worktreeRootPath: sourceRoot,
      customLanguagesRootPath: sourceRoot,
      resourcesDir: getBundledCodeGraphDir(),
      repositories: [{ repoId: WORKSPACE_ROOT_REPO_ID, rootPath: sourceRoot }],
      options: {},
      baseFinalization: {
        identity,
        gitHead: null,
        repairSummaryProjection: true,
      },
    });

    expect(response).toMatchObject({ ok: true, baseFinalized: true });
    expect(
      createHash('sha256').update(readFileSync(published.dbPath)).digest('hex'),
    ).toBe(publishedBytes);
  });

  it('validates an installed generation in the read worker before maintenance trusts it', async () => {
    const { stagingDir } = await buildStaging(null);
    const published = await installCodeGraphBaseGeneration({
      variantDir,
      stagingDir,
      identity,
      gitHead: null,
    });
    const validate = (gitHead: string | null): Promise<unknown> =>
      executeCodeGraphRead({
        dbPath: published.dbPath,
        task: { kind: 'validate-base', identity, gitHead },
      });

    await expect(validate(null)).resolves.toEqual({
      ok: true,
      result: { kind: 'validate-base', value: true },
    });
    await expect(validate('0'.repeat(40))).resolves.toEqual({
      ok: true,
      result: { kind: 'validate-base', value: false },
    });
    writeFileSync(published.dbPath, 'not a code graph database');
    await expect(validate(null)).resolves.toEqual({
      ok: true,
      result: { kind: 'validate-base', value: false },
    });
  });

  it('rejects a build whose recorded head differs from the requested head', async () => {
    const { response } = await buildStaging('0'.repeat(40));

    expect(response).toEqual({
      ok: false,
      message: 'Code-graph base publication validation failed.',
    });
  });
});

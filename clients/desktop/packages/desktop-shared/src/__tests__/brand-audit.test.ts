import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(__dirname, '../../../..');
const scriptPath = join(repoRoot, 'scripts/brand/audit-external-branding.mjs');
const sourceBrandDir = join(repoRoot, 'brands/canopy');
const createdRepoRoots: string[] = [];
const createdDistDirs: string[] = [];

function createFixtureRepoRoot(): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'canopy-brand-audit-root-'));
  createdRepoRoots.push(fixtureRoot);
  mkdirSync(join(fixtureRoot, 'brands'), { recursive: true });
  return fixtureRoot;
}

function createBrand(
  fixtureRoot: string,
  id: string,
  prefixes: string[],
): void {
  const brandDir = join(fixtureRoot, 'brands', id);
  rmSync(brandDir, { recursive: true, force: true });
  cpSync(sourceBrandDir, brandDir, { recursive: true });
  const manifest = JSON.parse(
    readFileSync(join(brandDir, 'brand.json'), 'utf8'),
  ) as Record<string, unknown>;
  Object.assign(manifest, {
    schemaVersion: 5,
    id,
    displayName: id,
    shortName: id,
    internalName: id,
    cliName: id,
    appId: `com.${id}.ui`,
    description: `${id} test brand`,
    author: 'Test',
    serverDisplayName: `${id} Server`,
    storage: {
      dataDirNames: {
        prod: [`.${id}`],
        rc: [`.${id}-rc`],
        dev: [`.${id}-dev`],
      },
      secureDataDirNames: {
        prod: `.${id}-secure`,
        rc: `.${id}-rc-secure`,
        internal: `.${id}-internal-secure`,
        dev: `.${id}-secure-dev`,
      },
      configFileNames: [`${id}.json`],
      projectConfigDirNames: [`.${id}`],
    },
    environment: { prefixes },
    tools: { namespace: id },
    desktopIntegration: {
      routePrefix: `/${id}`,
      tokenHeaderName: `X-${id}-Integration-Token`,
      tokenEnvVar: `${prefixes[0]}_DESKTOP_INTEGRATION_TOKEN`,
    },
    dictation: {
      binaryName: `${id}-dictate`,
      bundleId: `com.${id}.dictate`,
      displayName: `${id} Dictate`,
    },
    web: {
      hostnames: [],
      apiNamespace: id,
      wellKnownNamespace: id,
      title: id,
      description: `${id} test brand`,
    },
    release: { enabled: [], artifactPrefix: id },
  });
  writeFileSync(
    join(brandDir, 'brand.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function createDist(content: string): string {
  const distDir = mkdtempSync(join(tmpdir(), 'canopy-brand-audit-'));
  createdDistDirs.push(distDir);
  writeFileSync(join(distDir, 'bundle.js'), content);
  return distDir;
}

function createRepoDist(
  fixtureRoot: string,
  relativePath: string,
  content: string,
): string {
  const distDir = join(fixtureRoot, 'dist');
  const filePath = join(distDir, relativePath);
  mkdirSync(resolve(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
  return distDir;
}

function runAudit(
  fixtureRoot: string,
  brand: string,
  dist: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [scriptPath, '--repo-root', fixtureRoot, '--brand', brand, '--dist', dist],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
}

afterAll(() => {
  for (const fixtureRoot of createdRepoRoots) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
  for (const distDir of createdDistDirs) {
    rmSync(distDir, { recursive: true, force: true });
  }
});

describe('external brand audit', () => {
  it('allows CANOPY env names only for brands that declare the fallback prefix', () => {
    const fixtureRoot = createFixtureRepoRoot();
    createBrand(fixtureRoot, 'audit-fallback', ['AUDIT_FALLBACK', 'CANOPY']);
    createBrand(fixtureRoot, 'audit-primary', ['AUDIT_PRIMARY']);

    const fallbackResult = runAudit(
      fixtureRoot,
      'audit-fallback',
      createDist('process.env.CANOPY_OUTPUT = "ok";\n'),
    );
    expect(fallbackResult.status).toBe(0);

    const primaryOnlyResult = runAudit(
      fixtureRoot,
      'audit-primary',
      createDist('process.env.CANOPY_OUTPUT = "bad";\n'),
    );
    expect(primaryOnlyResult.status).toBe(1);
    expect(primaryOnlyResult.stderr).toContain('contains CANOPY');
  });

  it('rejects unreviewed Canopy tokens near generic fallback wording', () => {
    const fixtureRoot = createFixtureRepoRoot();
    createBrand(fixtureRoot, 'audit-fallback', ['AUDIT_FALLBACK', 'CANOPY']);

    const result = runAudit(
      fixtureRoot,
      'audit-fallback',
      createDist('This fallback still says Canopy in visible copy.\n'),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bundle.js: contains Canopy');
  });

  it('rejects raw canopy event expressions in non-Canopy artifacts', () => {
    const fixtureRoot = createFixtureRepoRoot();
    createBrand(fixtureRoot, 'audit-fallback', ['AUDIT_FALLBACK', 'CANOPY']);

    const result = runAudit(
      fixtureRoot,
      'audit-fallback',
      createDist('plan_path=${{ canopy.event.plan_ready.plan_path }}\n'),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bundle.js: contains canopy');
  });

  it('rejects raw canopy report action ids in non-Canopy artifacts', () => {
    const fixtureRoot = createFixtureRepoRoot();
    createBrand(fixtureRoot, 'audit-fallback', ['AUDIT_FALLBACK', 'CANOPY']);

    const result = runAudit(
      fixtureRoot,
      'audit-fallback',
      createDist('uses: builtin/canopy-report\n'),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bundle.js: contains canopy');
  });

  it('allows reviewed CLI bundle pipeline context internals', () => {
    const fixtureRoot = createFixtureRepoRoot();
    createBrand(fixtureRoot, 'audit-fallback', ['AUDIT_FALLBACK', 'CANOPY']);

    const result = runAudit(
      fixtureRoot,
      'audit-fallback',
      createRepoDist(
        fixtureRoot,
        'cli/index.bundle.js',
        'function buildContext(e){return {canopy:e.canopy, eventData:e.canopy?.event}}',
      ),
    );

    expect(result.status).toBe(0);
  });

  it('rejects legacy canopy report action ids in CLI artifacts', () => {
    const fixtureRoot = createFixtureRepoRoot();
    createBrand(fixtureRoot, 'audit-fallback', ['AUDIT_FALLBACK', 'CANOPY']);

    const result = runAudit(
      fixtureRoot,
      'audit-fallback',
      createRepoDist(
        fixtureRoot,
        'cli/index.bundle.js',
        '"actions/canopy-report/action.yml": "name: audit-fallback Report"',
      ),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cli/index.bundle.js: contains canopy');
  });

  it('scans release staging directories for unreviewed branding tokens', () => {
    const fixtureRoot = createFixtureRepoRoot();
    createBrand(fixtureRoot, 'audit-fallback', ['AUDIT_FALLBACK', 'CANOPY']);
    const stagedBinDir = join(fixtureRoot, '.cache/bin/darwin-arm64');
    const stagedCliDir = join(fixtureRoot, '.cache/cli/darwin-arm64');
    mkdirSync(stagedBinDir, { recursive: true });
    mkdirSync(stagedCliDir, { recursive: true });
    writeFileSync(join(stagedBinDir, 'helper-metadata.txt'), 'Canopy leak\n');
    writeFileSync(join(stagedCliDir, 'cli-metadata.txt'), 'canopy leak\n');

    const result = runAudit(
      fixtureRoot,
      'audit-fallback',
      createDist('clean\n'),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '.cache/bin/darwin-arm64/helper-metadata.txt: contains Canopy',
    );
    expect(result.stderr).toContain(
      '.cache/cli/darwin-arm64/cli-metadata.txt: contains canopy',
    );
  });

  it('scans built renderer output for unreviewed branding tokens', () => {
    const fixtureRoot = createFixtureRepoRoot();
    createBrand(fixtureRoot, 'audit-fallback', ['AUDIT_FALLBACK', 'CANOPY']);
    const rendererDir = join(fixtureRoot, 'out/renderer/assets');
    mkdirSync(rendererDir, { recursive: true });
    writeFileSync(join(rendererDir, 'index.js'), 'Canopy renderer leak\n');

    const result = runAudit(
      fixtureRoot,
      'audit-fallback',
      createDist('clean\n'),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'out/renderer/assets/index.js: contains Canopy',
    );
  });
});

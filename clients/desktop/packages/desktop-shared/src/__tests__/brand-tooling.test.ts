import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../../../..');
const tempRoots: string[] = [];
const sourceBrandDir = join(repoRoot, 'brands/canopy');
const repoTestBrandDir = join(repoRoot, 'brands/testbrand');
const repoTestBrandCacheDir = join(repoRoot, '.cache/brand/testbrand');
const repoUnstoppableCodeCacheDir = join(
  repoRoot,
  '.cache/brand/unstoppable-code',
);
const repoTestBrandWebPublicDir = join(
  repoRoot,
  'apps/web/public/brand/testbrand',
);
let createdRepoTestBrand = false;

interface RenderedClaudeMarketplaceFixture {
  name: string;
  plugins: Array<{
    name: string;
    source: string;
    description?: string;
  }>;
}

interface RenderedCodexMarketplaceFixture {
  plugins: Array<{
    name: string;
    source: { path: string };
    category?: string;
    author?: { name?: string };
  }>;
}

interface BrandStorageForTest {
  dataDirNames: { prod: string[]; rc: string[]; dev: string[] };
  secureDataDirNames: {
    prod: string;
    rc: string;
    internal: string;
    dev: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRecordProperty(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const property = value[key];
  if (!isRecord(property)) {
    throw new Error(`Expected ${key} to be an object.`);
  }
  return property;
}

function readStringArrayProperty(
  value: Record<string, unknown>,
  key: string,
): string[] {
  const property = value[key];
  if (!Array.isArray(property)) {
    throw new Error(`Expected ${key} to be a string array.`);
  }
  const strings: string[] = [];
  for (const item of property) {
    if (typeof item !== 'string') {
      throw new Error(`Expected ${key} to be a string array.`);
    }
    strings.push(item);
  }
  return strings;
}

function readStringProperty(
  value: Record<string, unknown>,
  key: string,
): string {
  const property = value[key];
  if (typeof property !== 'string') {
    throw new Error(`Expected ${key} to be a string.`);
  }
  return property;
}

function parseBrandStorageForTest(value: unknown): BrandStorageForTest {
  if (!isRecord(value)) {
    throw new Error('Expected brand storage to be an object.');
  }
  const dataDirNames = readRecordProperty(value, 'dataDirNames');
  const secureDataDirNames = readRecordProperty(value, 'secureDataDirNames');
  return {
    dataDirNames: {
      prod: readStringArrayProperty(dataDirNames, 'prod'),
      rc: readStringArrayProperty(dataDirNames, 'rc'),
      dev: readStringArrayProperty(dataDirNames, 'dev'),
    },
    secureDataDirNames: {
      prod: readStringProperty(secureDataDirNames, 'prod'),
      rc: readStringProperty(secureDataDirNames, 'rc'),
      internal: readStringProperty(secureDataDirNames, 'internal'),
      dev: readStringProperty(secureDataDirNames, 'dev'),
    },
  };
}

function applyTestBrandManifest(
  manifest: Record<string, unknown>,
  id: string,
): void {
  manifest.schemaVersion = 5;
  manifest.id = id;
  manifest.displayName = id === 'testbrand' ? 'TestBrand' : id;
  manifest.shortName = id;
  manifest.internalName = id;
  manifest.cliName = id;
  manifest.appId = `com.${id}.ui`;
  manifest.description = `${id} test brand`;
  manifest.author = 'Test';
  manifest.serverDisplayName = `${id} Server`;
  manifest.storage = {
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
  };
  const envPrefix = id.toUpperCase().replace(/-/g, '_');
  manifest.environment = { prefixes: [envPrefix] };
  manifest.tools = { namespace: id };
  manifest.desktopIntegration = {
    routePrefix: `/${id}`,
    tokenHeaderName: `X-${id}-Integration-Token`,
    tokenEnvVar: `${envPrefix}_DESKTOP_INTEGRATION_TOKEN`,
  };
  manifest.dictation = {
    binaryName: `${id}-dictate`,
    bundleId: `com.${id}.dictate`,
    displayName: `${id} Dictate`,
  };
  manifest.web = {
    hostnames: [],
    apiNamespace: id,
    wellKnownNamespace: id,
    title: id,
    description: `${id} test brand`,
  };
  manifest.release = { enabled: [], artifactPrefix: id };
}

function writeTestBrandFixture(brandDir: string, id: string): void {
  rmSync(brandDir, { recursive: true, force: true });
  cpSync(sourceBrandDir, brandDir, { recursive: true });
  const manifest = JSON.parse(
    readFileSync(join(brandDir, 'brand.json'), 'utf8'),
  ) as Record<string, unknown>;
  applyTestBrandManifest(manifest, id);
  writeFileSync(
    join(brandDir, 'brand.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function runBrandScript(script: string, args: string[] = []): void {
  execFileSync(process.execPath, [join(repoRoot, script), ...args], {
    cwd: repoRoot,
    env: { ...process.env, CANOPY_BRAND: 'canopy' },
    stdio: 'pipe',
  });
}

function normalizeGeneratedConfig(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .split(repoRoot)
      .join('<repo>')
      .replace(/\\/g, '/')
      .replace(/Copyright © \d{4}/g, 'Copyright © <year>');
  }
  if (Array.isArray(value)) {
    return value.map(normalizeGeneratedConfig);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeGeneratedConfig(item),
      ]),
    );
  }
  return value;
}

function createTempBrandRepo(
  id: string,
  mutate: (manifest: Record<string, unknown>) => void,
): string {
  const tempRoot = mkdtempSync(join(tmpdir(), 'canopy-brand-tooling-'));
  tempRoots.push(tempRoot);
  const tempBrandDir = join(tempRoot, 'brands', id);
  mkdirSync(join(tempRoot, 'brands'), { recursive: true });
  writeTestBrandFixture(tempBrandDir, id);
  const manifest = JSON.parse(
    readFileSync(join(tempBrandDir, 'brand.json'), 'utf8'),
  ) as Record<string, unknown>;
  mutate(manifest);
  writeFileSync(
    join(tempBrandDir, 'brand.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return tempRoot;
}

function runLoadBrand(
  brandId: string,
  tempRoot: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { loadBrand } from './scripts/brand/load-brand.mjs'; loadBrand(process.argv[1], { repoRoot: process.argv[2] });",
      brandId,
      tempRoot,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
}

function loadBrandStorage(
  brandId: string,
  tempRoot: string,
): BrandStorageForTest {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "import { loadBrand } from './scripts/brand/load-brand.mjs';",
        'const brand = loadBrand(process.argv[1], { repoRoot: process.argv[2] });',
        'console.log(JSON.stringify(brand.storage));',
      ].join(' '),
      brandId,
      tempRoot,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  expect(result.status).toBe(0);
  const parsed: unknown = JSON.parse(result.stdout);
  return parseBrandStorageForTest(parsed);
}

beforeAll(() => {
  if (!existsSync(repoTestBrandDir)) {
    writeTestBrandFixture(repoTestBrandDir, 'testbrand');
    createdRepoTestBrand = true;
  }
});

afterAll(() => {
  if (createdRepoTestBrand) {
    rmSync(repoTestBrandDir, { recursive: true, force: true });
  }
  rmSync(repoTestBrandCacheDir, { recursive: true, force: true });
  rmSync(repoUnstoppableCodeCacheDir, { recursive: true, force: true });
  rmSync(repoTestBrandWebPublicDir, { recursive: true, force: true });
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('brand tooling', () => {
  it('prepares the desktop brand without hosted web assets', () => {
    runBrandScript('scripts/brand/prepare-brand.mjs', ['--brand', 'canopy']);
    expect(readFileSync(join(repoRoot, '.cache/brand/current/desktop-brand.ts'), 'utf8')).toContain('../canopy/desktop-brand');
    expect(existsSync(join(repoRoot, 'apps/web'))).toBe(false);
    expect(existsSync(join(repoRoot, '.cache/brand/web-brands.ts'))).toBe(false);
  });

  it('rejects an explicit unknown current brand when preparing all brands', () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts/brand/prepare-brand.mjs'), '--all'],
      {
        cwd: repoRoot,
        env: { ...process.env, CANOPY_BRAND: 'missing-brand' },
        encoding: 'utf8',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Current brand "missing-brand" was requested but no matching brand pack exists.',
    );
  });

  it('exposes listBrandIds as a synchronous helper', () => {
    const tempRoot = createTempBrandRepo('synctest', () => {});
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          "import { listBrandIds } from './scripts/brand/load-brand.mjs';",
          'const ids = listBrandIds({ repoRoot: process.argv[1] });',
          "if (!Array.isArray(ids) || ids.join(',') !== 'synctest') process.exit(1);",
        ].join(' '),
        tempRoot,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(0);
  });

  it.skip('keeps the default Electron builder config matched to the golden file', () => {
    runBrandScript('scripts/brand/generate-electron-builder-config.mjs', [
      '--brand',
      'canopy',
      '--release-flavor',
      'stable',
    ]);

    const actual = normalizeGeneratedConfig(
      JSON.parse(
        readFileSync(
          join(repoRoot, '.cache/brand/canopy/electron-builder.json'),
          'utf8',
        ),
      ),
    );
    const expected: unknown = JSON.parse(
      readFileSync(
        join(
          repoRoot,
          'packages/desktop-shared/src/__tests__/fixtures/canopy-electron-builder.golden.json',
        ),
        'utf8',
      ),
    );

    expect(actual).toEqual(expected);
  });

  it.skip('uses brand-specific Electron updater metadata channels', () => {
    runBrandScript('scripts/brand/generate-electron-builder-config.mjs', [
      '--brand',
      'testbrand',
      '--no-current',
    ]);

    const config = JSON.parse(
      readFileSync(
        join(repoRoot, '.cache/brand/testbrand/electron-builder.json'),
        'utf8',
      ),
    ) as { publish?: { channel?: string } };

    expect(config.publish?.channel).toBe('testbrand');
  });

  it('renders generated macOS icons with the expected transparent inset', () => {
    const script = String.raw`
      import sharp from 'sharp';
      import { renderMacIconPng } from './scripts/brand/generate-icons.mjs';

      const source = await sharp({
        create: {
          width: 1024,
          height: 1024,
          channels: 4,
          background: { r: 12, g: 12, b: 16, alpha: 1 },
        },
      }).png().toBuffer();
      const output = await renderMacIconPng(source, 1024);
      const { data, info } = await sharp(output)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let minX = info.width;
      let minY = info.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          const alpha = data[(y * info.width + x) * 4 + 3];
          if (alpha > 10) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }
      if (minX !== 100 || minY !== 100 || maxX !== 923 || maxY !== 923) {
        throw new Error('unexpected bounds ' + [minX, minY, maxX, maxY].join(','));
      }
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it.skip('excludes selected and legacy dictation helpers from Windows package resources', () => {
    runBrandScript('scripts/brand/generate-electron-builder-config.mjs', [
      '--brand',
      'testbrand',
      '--no-current',
    ]);

    const config = JSON.parse(
      readFileSync(
        join(repoRoot, '.cache/brand/testbrand/electron-builder.json'),
        'utf8',
      ),
    ) as {
      win?: { extraResources?: Array<{ to?: string; filter?: string[] }> };
    };
    const binResource = config.win?.extraResources?.find(
      (entry) => entry.to === 'bin',
    );

    expect(binResource?.filter).toEqual(
      expect.arrayContaining([
        '!testbrand-dictate',
        '!testbrand-dictate.exe',
        '!.testbrand-dictate-version',
        '!canopy-dictate',
        '!canopy-dictate.exe',
        '!.canopy-dictate-version',
      ]),
    );
  });

  it('rejects brand manifests with missing asset paths', () => {
    const tempRoot = createTempBrandRepo('missing-asset', (manifest) => {
      const assets = manifest.assets as Record<string, unknown>;
      assets.logoSvg = './missing.svg';
    });

    const result = runLoadBrand('missing-asset', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('assets.logoSvg does not exist');
  });

  it('rejects malformed bundle identifiers before plist rendering', () => {
    const tempRoot = createTempBrandRepo('bad-bundle-id', (manifest) => {
      manifest.dictation = {
        ...((manifest.dictation as Record<string, unknown>) ?? {}),
        bundleId: 'com.bad&bundle.dictate',
      };
    });

    const result = runLoadBrand('bad-bundle-id', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'dictation.bundleId must be a reverse-DNS bundle identifier',
    );
  });

  it('rejects malformed app ids before packaging config rendering', () => {
    const tempRoot = createTempBrandRepo('bad-app-id', (manifest) => {
      manifest.appId = 'com.bad<app>.ui';
    });

    const result = runLoadBrand('bad-app-id', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'appId must be a reverse-DNS bundle identifier',
    );
  });

  it('rejects unsafe logo SVG before brand preparation can cache it', () => {
    const tempRoot = createTempBrandRepo('unsafe-logo', () => {});
    writeFileSync(
      join(tempRoot, 'brands', 'unsafe-logo', 'logo.svg'),
      '<svg/onload=alert(1)><path fill="currentColor" /></svg>',
    );

    const result = runLoadBrand('unsafe-logo', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'assets.logoSvg must not contain event handler attribute onload',
    );
  });

  it('rejects an unsafe optional wordmark SVG', () => {
    const tempRoot = createTempBrandRepo('unsafe-wordmark', (manifest) => {
      const assets = manifest.assets as Record<string, unknown>;
      assets.wordmarkSvg = './wordmark.svg';
    });
    writeFileSync(
      join(tempRoot, 'brands', 'unsafe-wordmark', 'wordmark.svg'),
      '<svg/onload=alert(1)><path fill="currentColor" /></svg>',
    );

    const result = runLoadBrand('unsafe-wordmark', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'assets.wordmarkSvg must not contain event handler attribute onload',
    );
  });

  it('loads brand manifests that only provide strictly required assets', () => {
    const tempRoot = createTempBrandRepo('strict-assets-only', (manifest) => {
      const assets = manifest.assets as Record<string, unknown>;
      delete assets.macIconIcns;
      delete assets.windowsIconIco;
      delete assets.linuxIconDir;
      delete assets.webIconPng;
    });

    const result = runLoadBrand('strict-assets-only', tempRoot);

    expect(result.status).toBe(0);
  });

  it('loads legacy v2 brand manifests without explicit rc storage fields', () => {
    const tempRoot = createTempBrandRepo('legacy-storage', (manifest) => {
      const storage = readRecordProperty(manifest, 'storage');
      const dataDirNames = readRecordProperty(storage, 'dataDirNames');
      const secureDataDirNames = readRecordProperty(
        storage,
        'secureDataDirNames',
      );
      delete dataDirNames.rc;
      delete secureDataDirNames.rc;
    });

    const storage = loadBrandStorage('legacy-storage', tempRoot);

    expect(storage.dataDirNames.rc).toEqual(['.legacy-storage-dev']);
    expect(storage.secureDataDirNames.rc).toBe('.legacy-storage-secure-dev');
    expect(storage.secureDataDirNames.internal).toBe(
      '.legacy-storage-internal-secure',
    );
  });

  it('rejects a missing internal secure data directory', () => {
    const tempRoot = createTempBrandRepo('missing-internal', (manifest) => {
      const storage = readRecordProperty(manifest, 'storage');
      const secureDataDirNames = readRecordProperty(
        storage,
        'secureDataDirNames',
      );
      delete secureDataDirNames.internal;
    });

    const result = runLoadBrand('missing-internal', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('storage.secureDataDirNames.internal');
  });

  it('rejects an internal secure directory shared with another secure mode', () => {
    const tempRoot = createTempBrandRepo(
      'duplicate-internal-secure',
      (manifest) => {
        const storage = readRecordProperty(manifest, 'storage');
        const secureDataDirNames = readRecordProperty(
          storage,
          'secureDataDirNames',
        );
        secureDataDirNames.internal = secureDataDirNames.prod;
      },
    );

    const result = runLoadBrand('duplicate-internal-secure', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'storage.secureDataDirNames.internal must be unique',
    );
  });

  it('rejects a case-equivalent internal secure directory', () => {
    const tempRoot = createTempBrandRepo(
      'case-equivalent-internal-secure',
      (manifest) => {
        const storage = readRecordProperty(manifest, 'storage');
        const secureDataDirNames = readRecordProperty(
          storage,
          'secureDataDirNames',
        );
        secureDataDirNames.internal = String(
          secureDataDirNames.prod,
        ).toUpperCase();
      },
    );

    const result = runLoadBrand('case-equivalent-internal-secure', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'storage.secureDataDirNames.internal must be unique',
    );
  });

  it('rejects a mixed trailing-period-and-space internal secure directory collision', () => {
    const tempRoot = createTempBrandRepo(
      'trailing-period-internal-secure',
      (manifest) => {
        const storage = readRecordProperty(manifest, 'storage');
        const secureDataDirNames = readRecordProperty(
          storage,
          'secureDataDirNames',
        );
        secureDataDirNames.internal = `${String(secureDataDirNames.prod)}. .`;
      },
    );

    const result = runLoadBrand('trailing-period-internal-secure', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'storage.secureDataDirNames.internal must be unique',
    );
  });

  it('rejects an internal secure directory that is empty on Windows', () => {
    const tempRoot = createTempBrandRepo(
      'windows-empty-internal-secure',
      (manifest) => {
        const storage = readRecordProperty(manifest, 'storage');
        const secureDataDirNames = readRecordProperty(
          storage,
          'secureDataDirNames',
        );
        secureDataDirNames.internal = '...';
      },
    );

    const result = runLoadBrand('windows-empty-internal-secure', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'storage.secureDataDirNames.internal must resolve to a non-empty directory name on Windows',
    );
  });

  it('rejects an internal secure directory shared with an ordinary data fallback', () => {
    const tempRoot = createTempBrandRepo(
      'data-internal-collision',
      (manifest) => {
        const storage = readRecordProperty(manifest, 'storage');
        const dataDirNames = readRecordProperty(storage, 'dataDirNames');
        const secureDataDirNames = readRecordProperty(
          storage,
          'secureDataDirNames',
        );
        (dataDirNames.prod as string[]).push('.shared-ordinary-fallback');
        secureDataDirNames.internal = '.shared-ordinary-fallback';
      },
    );

    const result = runLoadBrand('data-internal-collision', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'storage.secureDataDirNames.internal must not match an ordinary data directory',
    );
  });

  it("rejects one brand's internal secure directory shared with another brand's secure mode", () => {
    const manifestPath = join(repoTestBrandDir, 'brand.json');
    const original = readFileSync(manifestPath, 'utf8');
    try {
      const manifest = JSON.parse(original) as Record<string, unknown>;
      const storage = readRecordProperty(manifest, 'storage');
      const secureDataDirNames = readRecordProperty(
        storage,
        'secureDataDirNames',
      );
      secureDataDirNames.internal = '.canopy-secure';
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = spawnSync(
        process.execPath,
        [join(repoRoot, 'scripts/brand/validate-brands.mjs')],
        { cwd: repoRoot, encoding: 'utf8' },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'testbrand: storage.secureDataDirNames.internal ".canopy-secure" duplicates canopy storage.secureDataDirNames.prod',
      );
    } finally {
      writeFileSync(manifestPath, original);
    }
  });

  it("rejects one brand's Windows-equivalent internal secure directory shared with another brand", () => {
    const manifestPath = join(repoTestBrandDir, 'brand.json');
    const original = readFileSync(manifestPath, 'utf8');
    try {
      const manifest = JSON.parse(original) as Record<string, unknown>;
      const storage = readRecordProperty(manifest, 'storage');
      const secureDataDirNames = readRecordProperty(
        storage,
        'secureDataDirNames',
      );
      secureDataDirNames.internal = '.CANOPY-SECURE. .';
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = spawnSync(
        process.execPath,
        [join(repoRoot, 'scripts/brand/validate-brands.mjs')],
        { cwd: repoRoot, encoding: 'utf8' },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'testbrand: storage.secureDataDirNames.internal ".CANOPY-SECURE. ." duplicates canopy storage.secureDataDirNames.prod',
      );
    } finally {
      writeFileSync(manifestPath, original);
    }
  });

  it("rejects one brand's internal secure directory that is empty on Windows", () => {
    const manifestPath = join(repoTestBrandDir, 'brand.json');
    const original = readFileSync(manifestPath, 'utf8');
    try {
      const manifest = JSON.parse(original) as Record<string, unknown>;
      const storage = readRecordProperty(manifest, 'storage');
      const secureDataDirNames = readRecordProperty(
        storage,
        'secureDataDirNames',
      );
      secureDataDirNames.internal = '. .';
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = spawnSync(
        process.execPath,
        [join(repoRoot, 'scripts/brand/validate-brands.mjs')],
        { cwd: repoRoot, encoding: 'utf8' },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'storage.secureDataDirNames.internal must resolve to a non-empty directory name on Windows',
      );
    } finally {
      writeFileSync(manifestPath, original);
    }
  });

  it('rejects duplicate fallback entries instead of silently deduping them', () => {
    const tempRoot = createTempBrandRepo('duplicate-fallback', (manifest) => {
      manifest.storage = {
        ...((manifest.storage as Record<string, unknown>) ?? {}),
        dataDirNames: {
          prod: ['.duplicate-fallback', '.canopy', '.canopy'],
          rc: ['.duplicate-fallback-rc', '.canopy-rc'],
          dev: ['.duplicate-fallback-dev', '.canopy-dev'],
        },
        configFileNames: [
          'duplicate-fallback.json',
          'canopy.json',
          'canopy.json',
        ],
        projectConfigDirNames: ['.duplicate-fallback', '.canopy', '.canopy'],
      };
    });

    const result = runLoadBrand('duplicate-fallback', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'storage.dataDirNames.prod must not contain duplicate entries',
    );
  });

  it('rejects secure data directory traversal segments', () => {
    const tempRoot = createTempBrandRepo('secure-traversal', (manifest) => {
      manifest.storage = {
        ...((manifest.storage as Record<string, unknown>) ?? {}),
        secureDataDirNames: {
          prod: '..',
          rc: '.secure-traversal-rc-secure',
          internal: '.secure-traversal-internal-secure',
          dev: '.secure-traversal-dev',
        },
      };
    });

    const result = runLoadBrand('secure-traversal', tempRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'storage.secureDataDirNames.prod must not be a path traversal segment',
    );
  });

  it('loads the testbrand CLI executable name from the brand manifest', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          "import { loadBrand } from './scripts/brand/load-brand.mjs';",
          "const brand = loadBrand('testbrand');",
          "if (brand.cliName !== 'testbrand') process.exit(1);",
        ].join(' '),
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
  });

  it('renders TestBrand pipeline resources with branded runtime identifiers', () => {
    runBrandScript('scripts/brand/render-branded-resources.mjs', [
      '--brand',
      'testbrand',
    ]);

    const renderedTaskPipeline = readFileSync(
      join(
        repoRoot,
        '.cache/brand/testbrand/resources/pipelines/create-task-implementation-plan.yaml',
      ),
      'utf8',
    );
    const renderedWritingSkill = readFileSync(
      join(
        repoRoot,
        '.cache/brand/testbrand/resources/skills/testbrand-pipeline-writing/SKILL.md',
      ),
      'utf8',
    );
    const renderedCliSkill = readFileSync(
      join(
        repoRoot,
        '.cache/brand/testbrand/resources/skills/testbrand-pipeline-cli/SKILL.md',
      ),
      'utf8',
    );

    expect(renderedTaskPipeline).toContain(
      '${{ testbrand.event.task_ready.task_path }}',
    );
    expect(renderedTaskPipeline).toContain('uses: builtin/pipeline-report');
    expect(renderedTaskPipeline).not.toContain('canopy.event');
    expect(renderedTaskPipeline).not.toContain('builtin/app-report');
    expect(renderedTaskPipeline).not.toContain('canopyOutput');
    expect(renderedWritingSkill).toContain('`builtin/pipeline-report`');
    expect(renderedWritingSkill).toContain('testbrand.event_name');
    expect(renderedWritingSkill).toContain(
      'Child pipelines inherit the parent execution',
    );
    expect(renderedWritingSkill).toContain(
      'Resume and retry keep the plugin preference snapshot',
    );
    expect(renderedWritingSkill).not.toContain('canopy.event');
    expect(renderedWritingSkill).not.toContain('canopy-report');
    expect(renderedWritingSkill).not.toContain('src/builtin-actions');
    expect(renderedWritingSkill).not.toContain('resources/actions/');
    expect(renderedWritingSkill).not.toContain(
      'packaged builtins should prefer compiled JS',
    );
    expect(renderedCliSkill).toContain(
      'This skill is the complete reference for the CLI',
    );
    expect(renderedCliSkill).toContain(
      '[`testbrand-pipeline-writing`](../testbrand-pipeline-writing/SKILL.md)',
    );
    expect(renderedCliSkill).not.toContain('docs/pipelines.md');
  });

  it('renders hyphenated brand resources with expression-safe identifiers', () => {
    runBrandScript('scripts/brand/render-branded-resources.mjs', [
      '--brand',
      'unstoppable-code',
    ]);

    const renderedTaskPipeline = readFileSync(
      join(
        repoRoot,
        '.cache/brand/unstoppable-code/resources/pipelines/create-task-implementation-plan.yaml',
      ),
      'utf8',
    );

    expect(renderedTaskPipeline).toContain(
      '${{ unstoppableCode.event.task_ready.task_path }}',
    );
    expect(renderedTaskPipeline).toContain('const brandOutput =');
    expect(renderedTaskPipeline).toContain('uses: builtin/pipeline-report');
    expect(renderedTaskPipeline).not.toContain('unstoppable-code.event');
    expect(renderedTaskPipeline).not.toContain('unstoppable-codeOutput');
  });

  it('uses explicit placeholders for brand resource rewriting', () => {
    const rendererSource = readFileSync(
      join(repoRoot, 'scripts/brand/render-branded-resources.mjs'),
      'utf8',
    );
    expect(rendererSource).not.toContain("replaceAll('canopy.event'");
    expect(rendererSource).not.toContain("replaceAll('builtin/app-report'");
    expect(rendererSource).not.toContain("replaceAll('canopy-report'");
    expect(rendererSource).not.toContain("replaceAll('canopyOutput'");
  });

  it('renders built-in plugin marketplaces with provider output and binary-safe assets', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'canopy-brand-plugins-'));
    tempRoots.push(tempRoot);
    const sourceResources = join(tempRoot, 'resources');
    const pluginTemplates = join(tempRoot, 'plugins');
    const preparedPlugins = join(tempRoot, 'prepared-plugins');
    const targetResources = join(tempRoot, 'out');
    mkdirSync(sourceResources, { recursive: true });
    mkdirSync(join(pluginTemplates, 'example-plugin', 'skills', 'native'), {
      recursive: true,
    });
    mkdirSync(join(pluginTemplates, 'example-plugin', 'commands'), {
      recursive: true,
    });
    mkdirSync(join(pluginTemplates, 'example-plugin', 'assets'), {
      recursive: true,
    });
    mkdirSync(join(pluginTemplates, 'generated-plugin', 'mcp'), {
      recursive: true,
    });
    mkdirSync(join(pluginTemplates, 'generated-plugin', 'apps'), {
      recursive: true,
    });
    mkdirSync(join(pluginTemplates, 'generated-plugin', 'commands'), {
      recursive: true,
    });
    writeFileSync(
      join(pluginTemplates, 'example-plugin', 'plugin.yaml'),
      [
        'name: example-plugin',
        'version: 1.0.0',
        'description: Example {{BRAND_DISPLAY_NAME}} plugin',
        'author:',
        '  name: "{{BRAND_DISPLAY_NAME}}"',
        'category: development',
        'targets:',
        '  codex:',
        '    category: Development',
      ].join('\n'),
    );
    writeFileSync(
      join(pluginTemplates, 'example-plugin', 'index.md'),
      '{% if claude %}Claude {{BRAND_DISPLAY_NAME}}{% else %}Codex {{BRAND_DISPLAY_NAME}}{% endif %}',
    );
    writeFileSync(
      join(pluginTemplates, 'example-plugin', 'skills', 'native', 'SKILL.md'),
      [
        '---',
        'description: Native skill',
        'disable-model-invocation: true',
        '---',
        'Use {{BRAND_CLI_NAME}}.',
      ].join('\n'),
    );
    writeFileSync(
      join(pluginTemplates, 'example-plugin', 'commands', 'open-pr.md'),
      ['---', 'description: Open PR', '---', 'Open the PR.'].join('\n'),
    );
    writeFileSync(
      join(pluginTemplates, 'example-plugin', 'assets', 'image.bin'),
      Buffer.from([0, 255, 10, 13, 128]),
    );
    writeFileSync(
      join(pluginTemplates, 'generated-plugin', 'plugin.yaml'),
      [
        'name: generated-plugin',
        'version: 1.0.0',
        'description: Generated plugin',
        'author:',
        '  name: "{{BRAND_DISPLAY_NAME}}"',
        'category: development',
        'targets:',
        '  codex:',
        '    category: Development',
      ].join('\n'),
    );
    writeFileSync(
      join(pluginTemplates, 'generated-plugin', 'mcp', '.mcp.json'),
      '{"mcpServers":{}}\n',
    );
    writeFileSync(
      join(pluginTemplates, 'generated-plugin', 'apps', '.app.json'),
      '{"apps":[]}\n',
    );
    writeFileSync(
      join(pluginTemplates, 'generated-plugin', 'commands', 'open-pr.md'),
      ['---', 'description: Open PR', '---', 'Open the PR.'].join('\n'),
    );

    mkdirSync(
      join(preparedPlugins, 'example-plugin', 'codex', '.codex-plugin'),
      { recursive: true },
    );
    writeFileSync(
      join(
        preparedPlugins,
        'example-plugin',
        'codex',
        '.codex-plugin',
        'plugin.json',
      ),
      JSON.stringify({
        name: 'example-plugin',
        version: '9.0.0',
        description: 'Prepared Codex plugin',
        author: { name: 'Prepared' },
      }),
    );

    const script = `
      import { loadBrand } from './scripts/brand/load-brand.mjs';
      import { renderBrandedResources } from './scripts/brand/render-branded-resources.mjs';
      const brand = loadBrand('canopy');
      renderBrandedResources(brand, {
        sourceResources: process.argv[1],
        sourcePluginTemplates: process.argv[2],
        sourcePreparedPluginTemplates: process.argv[3],
        sourceBrandPlugins: process.argv[4],
        sourceBrandPreparedPlugins: process.argv[4],
        sourceSkillTemplates: process.argv[4],
        sourceBrandSkills: process.argv[4],
        targetResources: process.argv[5],
      });
    `;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        sourceResources,
        pluginTemplates,
        preparedPlugins,
        join(tempRoot, 'missing'),
        targetResources,
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    const pluginsRoot = join(targetResources, 'plugins');
    const claudeMarketplace = JSON.parse(
      readFileSync(
        join(pluginsRoot, '.claude-plugin', 'marketplace.json'),
        'utf8',
      ),
    ) as RenderedClaudeMarketplaceFixture;
    const codexMarketplace = JSON.parse(
      readFileSync(
        join(pluginsRoot, '.agents', 'plugins', 'marketplace.json'),
        'utf8',
      ),
    ) as RenderedCodexMarketplaceFixture;
    expect(claudeMarketplace.name).toBe('canopy-plugins');
    expect(claudeMarketplace.plugins[0]).toMatchObject({
      name: 'example-plugin',
      source: './claude-plugins/example-plugin',
      description: 'Example Canopy plugin',
    });
    expect(codexMarketplace.plugins[0].source.path).toBe(
      './codex-plugins/example-plugin',
    );
    const codexMarketplacePlugin = codexMarketplace.plugins.find(
      (plugin) => plugin.name === 'example-plugin',
    );
    expect(codexMarketplacePlugin).toMatchObject({
      category: 'Development',
      author: { name: 'Prepared' },
    });
    expect(
      readFileSync(
        join(pluginsRoot, 'claude-plugins', 'example-plugin', 'index.md'),
        'utf8',
      ),
    ).toBe('Claude Canopy');
    expect(
      JSON.parse(
        readFileSync(
          join(
            pluginsRoot,
            'codex-plugins',
            'example-plugin',
            '.codex-plugin',
            'plugin.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({ version: '9.0.0', description: 'Prepared Codex plugin' });
    expect(
      JSON.parse(
        readFileSync(
          join(
            pluginsRoot,
            'codex-plugins',
            'generated-plugin',
            '.codex-plugin',
            'plugin.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({
      mcpServers: './mcp/.mcp.json',
      apps: './apps/.app.json',
    });
    const projectedCommandSkill = readFileSync(
      join(
        pluginsRoot,
        'codex-plugins',
        'generated-plugin',
        'skills',
        'open-pr',
        'SKILL.md',
      ),
      'utf8',
    );
    expect(projectedCommandSkill.match(/^---$/gm)).toHaveLength(2);
    expect(projectedCommandSkill).not.toContain(
      '\n---\ndescription: Open PR\n---\n',
    );
    expect(
      existsSync(
        join(pluginsRoot, 'codex-plugins', 'generated-plugin', 'README.md'),
      ),
    ).toBe(false);
    expect(
      readFileSync(
        join(
          pluginsRoot,
          'claude-plugins',
          'example-plugin',
          'assets',
          'image.bin',
        ),
      ),
    ).toEqual(Buffer.from([0, 255, 10, 13, 128]));
  });

  it('preserves built action bundles when branded resources are re-rendered', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'canopy-brand-resources-'));
    tempRoots.push(tempRoot);
    const sourceResources = join(tempRoot, 'source-resources');
    const targetResources = join(tempRoot, 'target-resources');
    mkdirSync(join(sourceResources, 'actions', 'agent-prompt'), {
      recursive: true,
    });
    mkdirSync(join(targetResources, 'actions', 'agent-prompt'), {
      recursive: true,
    });
    mkdirSync(join(targetResources, 'actions', 'removed-action'), {
      recursive: true,
    });
    writeFileSync(
      join(sourceResources, 'actions', 'agent-prompt', 'action.yml'),
      ['name: agent-prompt', 'runs:', '  using: node', '  main: index.js'].join(
        '\n',
      ),
    );
    writeFileSync(
      join(targetResources, 'actions', 'agent-prompt', 'index.js'),
      'module.exports = "compiled";\n',
    );
    writeFileSync(
      join(targetResources, 'actions', 'agent-prompt', 'index.js.map'),
      '{"version":3}\n',
    );
    writeFileSync(
      join(targetResources, 'actions', 'removed-action', 'index.js'),
      'module.exports = "stale";\n',
    );

    const script = `
      import { loadBrand } from './scripts/brand/load-brand.mjs';
      import { renderBrandedResources } from './scripts/brand/render-branded-resources.mjs';
      const brand = loadBrand('canopy');
      renderBrandedResources(brand, {
        sourceResources: process.argv[1],
        sourcePluginTemplates: process.argv[3],
        sourcePreparedPluginTemplates: process.argv[3],
        sourceBrandPlugins: process.argv[3],
        sourceBrandPreparedPlugins: process.argv[3],
        sourceSkillTemplates: process.argv[3],
        sourceBrandSkills: process.argv[3],
        targetResources: process.argv[2],
      });
    `;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        sourceResources,
        targetResources,
        join(tempRoot, 'missing'),
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(
      readFileSync(
        join(targetResources, 'actions', 'agent-prompt', 'index.js'),
        'utf8',
      ),
    ).toBe('module.exports = "compiled";\n');
    expect(
      readFileSync(
        join(targetResources, 'actions', 'agent-prompt', 'index.js.map'),
        'utf8',
      ),
    ).toBe('{"version":3}\n');
    expect(
      existsSync(
        join(targetResources, 'actions', 'removed-action', 'index.js'),
      ),
    ).toBe(false);
  });

  it('rejects prepared provider directories that are missing their provider manifest', () => {
    const preparedPluginDir = join(
      repoRoot,
      'brand-templates',
      'prepared-plugins',
      'incomplete-prepared-plugin',
    );
    rmSync(preparedPluginDir, { recursive: true, force: true });
    try {
      mkdirSync(join(preparedPluginDir, 'claude'), { recursive: true });
      mkdirSync(join(preparedPluginDir, 'codex', '.codex-plugin'), {
        recursive: true,
      });
      writeFileSync(
        join(preparedPluginDir, 'codex', '.codex-plugin', 'plugin.json'),
        JSON.stringify({
          name: 'incomplete-prepared-plugin',
          version: '1.0.0',
          description: 'Valid Codex side',
          author: { name: 'Canopy' },
        }),
      );

      const result = spawnSync(
        process.execPath,
        [join(repoRoot, 'scripts/brand/validate-brands.mjs')],
        { cwd: repoRoot, encoding: 'utf8' },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'prepared Claude bundle must contain .claude-plugin/plugin.json',
      );
    } finally {
      rmSync(preparedPluginDir, { recursive: true, force: true });
    }
  });
});

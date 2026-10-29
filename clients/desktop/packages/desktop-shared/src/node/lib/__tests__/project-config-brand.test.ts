import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as CanopyJsonModule from '../canopy-json';

const testBrand = {
  schemaVersion: 5,
  id: 'testbrand',
  displayName: 'TestBrand',
  shortName: 'TestBrand',
  internalName: 'testbrand',
  cliName: 'testbrand',
  appId: 'com.testbrand.ui',
  description: 'TestBrand',
  author: 'TestBrand',
  serverDisplayName: 'TestBrand Server',
  storage: {
    dataDirNames: {
      prod: ['.testbrand', '.canopy'],
      rc: ['.testbrand-rc', '.canopy-rc'],
      dev: ['.testbrand-dev', '.canopy-dev'],
    },
    secureDataDirNames: {
      prod: '.testbrand-secure',
      rc: '.testbrand-rc-secure',
      internal: '.testbrand-internal-secure',
      dev: '.testbrand-secure-dev',
    },
    configFileNames: ['testbrand.json', 'canopy.json'],
    projectConfigDirNames: ['.testbrand', '.canopy'],
  },
  environment: { prefixes: ['TESTBRAND', 'CANOPY'] },
  tools: { namespace: 'testbrand' },
  desktopIntegration: {
    routePrefix: '/testbrand',
    tokenHeaderName: 'X-TestBrand-Integration-Token',
    tokenEnvVar: 'TESTBRAND_DESKTOP_INTEGRATION_TOKEN',
  },
  dictation: {
    binaryName: 'testbrand-dictate',
    bundleId: 'com.testbrand.dictate',
    displayName: 'TestBrand Dictate',
  },
  web: {
    hostnames: ['testbrand.localhost'],
    apiNamespace: 'testbrand',
    wellKnownNamespace: 'testbrand',
    title: 'TestBrand',
    description: 'TestBrand',
  },
  release: { enabled: [], artifactPrefix: 'testbrand' },
  assets: {
    logoSvg: '<svg />',
    logoSvgPath: '/tmp/logo.svg',
    appIconPng: '/tmp/app-icon.png',
    macIconIcns: '/tmp/icon.icns',
    windowsIconIco: '/tmp/icon.ico',
    linuxIconDir: '/tmp/icons',
    webIconPng: '/tmp/web-icon.png',
  },
};

describe('branded project config file resolution', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    jest.doMock('@canopy/brand/current', () => ({
      BRAND: testBrand,
      default: testBrand,
    }));
  });

  afterEach(() => {
    jest.dontMock('@canopy/brand/current');
    jest.resetModules();
  });

  afterAll(() => {
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeRepo(): string {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-config-'));
    tempDirs.push(repoPath);
    return repoPath;
  }

  function loadModule(): typeof CanopyJsonModule {
    jest.resetModules();
    jest.doMock('@canopy/brand/current', () => ({
      BRAND: testBrand,
      default: testBrand,
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../canopy-json') as typeof CanopyJsonModule;
  }

  it('writes new project config files to the primary branded filename', async () => {
    const repoPath = makeRepo();
    const { getCanopyJsonPath, writeCanopyJson } = loadModule();

    await writeCanopyJson(repoPath, {
      version: 1,
      scripts: { start: 'npm run dev' },
    });

    expect(getCanopyJsonPath(repoPath)).toBe(
      path.join(repoPath, 'testbrand.json'),
    );
    expect(fs.existsSync(path.join(repoPath, 'testbrand.json'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, 'canopy.json'))).toBe(false);
  });

  it('rejects a dangling primary config symlink instead of writing its target', async () => {
    const repoPath = makeRepo();
    const targetPath = path.join(repoPath, 'outside-config-target.json');
    const configPath = path.join(repoPath, 'testbrand.json');
    await fsp.symlink(targetPath, configPath);
    const { writeCanopyJson } = loadModule();

    await expect(writeCanopyJson(repoPath, { version: 1 })).rejects.toThrow(
      /symbolic link/i,
    );

    expect(fs.existsSync(targetPath)).toBe(false);
    expect((await fsp.lstat(configPath)).isSymbolicLink()).toBe(true);
  });

  it('prefers primary branded config over fallback canopy.json when both exist', async () => {
    const repoPath = makeRepo();
    await fsp.writeFile(
      path.join(repoPath, 'canopy.json'),
      JSON.stringify({ version: 1, scripts: { start: 'fallback' } }),
    );
    await fsp.writeFile(
      path.join(repoPath, 'testbrand.json'),
      JSON.stringify({ version: 1, scripts: { start: 'primary' } }),
    );
    const { findExistingProjectConfigFile, readCanopyJson } = loadModule();

    await expect(findExistingProjectConfigFile(repoPath)).resolves.toBe(
      path.join(repoPath, 'testbrand.json'),
    );
    await expect(readCanopyJson(repoPath)).resolves.toMatchObject({
      scripts: { start: 'primary' },
    });
  });

  it('reads fallback canopy.json when no primary branded config exists', async () => {
    const repoPath = makeRepo();
    await fsp.writeFile(
      path.join(repoPath, 'canopy.json'),
      JSON.stringify({ version: 1, scripts: { start: 'fallback' } }),
    );
    const { findExistingProjectConfigFile, readCanopyJson } = loadModule();

    await expect(findExistingProjectConfigFile(repoPath)).resolves.toBe(
      path.join(repoPath, 'canopy.json'),
    );
    await expect(readCanopyJson(repoPath)).resolves.toMatchObject({
      scripts: { start: 'fallback' },
    });
  });

  it('updates the fallback config file when it is the only existing candidate', async () => {
    const repoPath = makeRepo();
    await fsp.writeFile(
      path.join(repoPath, 'canopy.json'),
      JSON.stringify({ version: 1, scripts: { start: 'old' } }),
    );
    const { writeCanopyJson } = loadModule();

    await writeCanopyJson(repoPath, { version: 1, scripts: { start: 'new' } });

    expect(fs.existsSync(path.join(repoPath, 'testbrand.json'))).toBe(false);
    await expect(
      fsp.readFile(path.join(repoPath, 'canopy.json'), 'utf8'),
    ).resolves.toContain('"start": "new"');
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DesktopBrandRuntime } from '@canopy/protocol/brand';
import type * as OsModule from 'node:os';
import type * as PathsModule from '../lib/paths';

const testTheme = {
  default: {
    id: 'default',
    label: 'Default',
    swatch: {
      light: { background: '#fff', accent: '#000' },
      dark: { background: '#000', accent: '#fff' },
    },
    light: {},
    dark: {},
  },
} as DesktopBrandRuntime['theme'];

describe('main paths data-root integration', () => {
  const originalCanopyEnv = process.env.CANOPY_ENV;
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  const originalNodeEnv = process.env.NODE_ENV;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalCanopyEnv === undefined) {
      delete process.env.CANOPY_ENV;
    } else {
      process.env.CANOPY_ENV = originalCanopyEnv;
    }
    if (originalCanopyDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalCanopyDataDir;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    jest.dontMock('node:os');
    jest.dontMock('@canopy/brand/current');
    jest.resetModules();
  });

  afterAll(() => {
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeTempHome(): string {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-main-paths-'),
    );
    tempDirs.push(tempDir);
    return tempDir;
  }

  function makeTestBrand(): DesktopBrandRuntime {
    return {
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
      theme: testTheme,
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
  }

  function mockBrandAndHome(homeDir: string): void {
    const actualOs = jest.requireActual<typeof OsModule>('node:os');
    const brand = makeTestBrand();
    jest.doMock('node:os', () => ({
      ...actualOs,
      homedir: (): string => homeDir,
    }));
    jest.doMock('@canopy/brand/current', () => ({
      BRAND: brand,
      default: brand,
    }));
  }

  it('reads preferences from the sticky fallback data root when only legacy data exists', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_ENV;
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.NODE_ENV;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const paths = require('../lib/paths') as typeof PathsModule;

    expect(paths.getPreferencesFilePath()).toBe(
      path.join(homeDir, '.canopy', 'preferences.json'),
    );
  });

  it('resolves the model policy marker inside the resolved data root', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_ENV;
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.NODE_ENV;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const paths = require('../lib/paths') as typeof PathsModule;

    expect(paths.getModelPolicyMarkerFilePath()).toBe(
      path.join(homeDir, '.canopy', 'model-policy-marker.json'),
    );
  });

  it('resolves the Ledger database inside the resolved data root without creating it', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_ENV;
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.NODE_ENV;

    const paths = jest.requireActual<typeof PathsModule>('../lib/paths');

    expect(paths.getLedgerDatabasePath()).toBe(
      path.join(homeDir, '.canopy', 'ledger', 'ledger.sqlite'),
    );
    expect(fs.existsSync(path.join(homeDir, '.canopy', 'ledger'))).toBe(false);
  });
});

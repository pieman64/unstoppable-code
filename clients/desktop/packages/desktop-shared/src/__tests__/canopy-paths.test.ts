import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopBrandRuntime } from '@canopy/protocol/brand';
import type * as OsModule from 'node:os';
import type * as CanopyPathsModule from '../canopy-paths';
import { DEFAULT_COWORK_WORKSPACE_ID } from '../types';

declare global {
  var __CANOPY_RELEASE_FLAVOR__: string | undefined;
}

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

describe('canopy-paths', () => {
  const originalCanopyEnv = process.env.CANOPY_ENV;
  const originalCanopyDataDir = process.env.CANOPY_DATA_DIR;
  const originalCanopySecureDataDir = process.env.CANOPY_SECURE_DATA_DIR;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalExecArgv = [...process.execArgv];
  const tempDirs: string[] = [];
  const originalDefaultAppDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'defaultApp',
  );

  afterEach(() => {
    delete globalThis.__CANOPY_RELEASE_FLAVOR__;

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

    if (originalCanopySecureDataDir === undefined) {
      delete process.env.CANOPY_SECURE_DATA_DIR;
    } else {
      process.env.CANOPY_SECURE_DATA_DIR = originalCanopySecureDataDir;
    }

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    process.execArgv = [...originalExecArgv];

    if (originalDefaultAppDescriptor) {
      Object.defineProperty(
        process,
        'defaultApp',
        originalDefaultAppDescriptor,
      );
    } else {
      Reflect.deleteProperty(process, 'defaultApp');
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-paths-'));
    tempDirs.push(tempDir);
    return tempDir;
  }

  function makeBrand(
    overrides: Partial<DesktopBrandRuntime> = {},
  ): DesktopBrandRuntime {
    const brand = {
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
        routePrefix: '/testbrand' as const,
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
      ...overrides,
    } satisfies DesktopBrandRuntime;
    return brand;
  }

  function mockBrandAndHome(homeDir: string, brand = makeBrand()): void {
    const actualOs = jest.requireActual<typeof OsModule>('node:os');
    jest.doMock('node:os', () => ({
      ...actualOs,
      homedir: (): string => homeDir,
    }));
    jest.doMock('@canopy/brand/current', () => ({
      BRAND: brand,
      default: brand,
    }));
  }

  function loadCanopyPaths(): typeof CanopyPathsModule {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../canopy-paths') as typeof CanopyPathsModule;
  }

  function writeWorkspaceIndex(dataDir: string, workspaces: unknown[]): void {
    fs.mkdirSync(path.join(dataDir, 'workspaces'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'workspaces', 'index.json'),
      JSON.stringify({ version: 1, workspaces }),
    );
  }

  function seedInstallData(dataDir: string): void {
    writeWorkspaceIndex(dataDir, [
      {
        id: 'real-workspace',
        name: 'Real Workspace',
        type: 'single-repo',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
      },
    ]);
  }

  it('defaults to prod when no env is set', () => {
    const homeDir = makeTempHome();
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_ENV;
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getCanopyRuntimeMode()).toBe('prod');
    expect(canopyPaths.getCanopyDataDir()).toBe(
      path.join(homeDir, '.testbrand'),
    );
    expect(canopyPaths.getCanopyCacheDir()).toBe(
      path.join(homeDir, '.testbrand', '.cache'),
    );
    expect(canopyPaths.getCanopySecureDataDir()).toBe(
      path.join(homeDir, '.testbrand-secure'),
    );
  });

  it('uses dev mode when CANOPY_ENV=development', () => {
    const homeDir = makeTempHome();
    mockBrandAndHome(homeDir);
    process.env.CANOPY_ENV = 'development';
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getCanopyRuntimeMode()).toBe('dev');
    expect(canopyPaths.getCanopyDataDir()).toBe(
      path.join(homeDir, '.testbrand-dev'),
    );
    expect(canopyPaths.getCanopySecureDataDir()).toBe(
      path.join(homeDir, '.testbrand-secure-dev'),
    );
  });

  it('uses rc mode when the packaged release flavor is rc', () => {
    const homeDir = makeTempHome();
    mockBrandAndHome(homeDir);
    globalThis.__CANOPY_RELEASE_FLAVOR__ = 'rc';
    process.env.CANOPY_ENV = 'production';
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getCanopyRuntimeMode()).toBe('rc');
    expect(canopyPaths.getCanopyDataDir()).toBe(
      path.join(homeDir, '.testbrand-rc'),
    );
    expect(canopyPaths.getCanopySecureDataDir()).toBe(
      path.join(homeDir, '.testbrand-rc-secure'),
    );
  });

  it('keeps internal ordinary data in prod while isolating secure storage', () => {
    const homeDir = makeTempHome();
    mockBrandAndHome(homeDir);
    globalThis.__CANOPY_RELEASE_FLAVOR__ = 'internal';
    process.env.CANOPY_ENV = 'production';
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getCanopyRuntimeMode()).toBe('prod');
    expect(canopyPaths.getCanopySecureStorageMode()).toBe('internal');
    expect(canopyPaths.getCanopyDataDir()).toBe(
      path.join(homeDir, '.testbrand'),
    );
    expect(canopyPaths.getCanopySecureDataDir()).toBe(
      path.join(homeDir, '.testbrand-internal-secure'),
    );
    expect(canopyPaths.getInternalLegacySharedSecureDataDir()).toBe(
      path.join(homeDir, '.testbrand-secure'),
    );
  });

  it('does not expose an implicit internal migration source under overrides', () => {
    const homeDir = makeTempHome();
    mockBrandAndHome(homeDir);
    globalThis.__CANOPY_RELEASE_FLAVOR__ = 'internal';
    process.env.CANOPY_ENV = 'production';
    process.env.CANOPY_DATA_DIR = path.join(homeDir, 'override');
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getCanopySecureStorageMode()).toBe('internal');
    expect(canopyPaths.getInternalLegacySharedSecureDataDir()).toBeNull();
  });

  it('does not expose an implicit internal migration source under a secure-only override', () => {
    const homeDir = makeTempHome();
    mockBrandAndHome(homeDir);
    globalThis.__CANOPY_RELEASE_FLAVOR__ = 'internal';
    process.env.CANOPY_ENV = 'production';
    delete process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_SECURE_DATA_DIR = path.join(homeDir, 'secure-override');
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getResolvedCanopySecureDataDir()).toEqual({
      path: path.join(homeDir, 'secure-override'),
      source: 'override',
    });
    expect(canopyPaths.getInternalLegacySharedSecureDataDir()).toBeNull();
  });

  it('falls back from rc to an existing stable branded data directory', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.testbrand'));
    mockBrandAndHome(homeDir);
    globalThis.__CANOPY_RELEASE_FLAVOR__ = 'rc';
    process.env.CANOPY_ENV = 'production';
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getCanopyRuntimeMode()).toBe('rc');
    expect(canopyPaths.getResolvedCanopyDataDir()).toEqual({
      path: path.join(homeDir, '.testbrand'),
      source: 'fallback',
      allCandidates: [
        path.join(homeDir, '.testbrand-rc'),
        path.join(homeDir, '.canopy-rc'),
        path.join(homeDir, '.testbrand'),
        path.join(homeDir, '.canopy'),
      ],
    });
    expect(canopyPaths.getResolvedCanopySecureDataDir()).toEqual({
      path: path.join(homeDir, '.testbrand-rc-secure'),
      source: 'fresh',
    });
    expect(canopyPaths.getAiGatewayModelCatalogCacheFilePath()).toBe(
      path.join(
        homeDir,
        '.testbrand',
        '.cache',
        'model-catalog',
        'ai-gateway-v1.json',
      ),
    );
  });

  it('prefers an existing rc legacy data directory over stable fallback directories', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.canopy-rc'));
    fs.mkdirSync(path.join(homeDir, '.testbrand'));
    mockBrandAndHome(homeDir);
    globalThis.__CANOPY_RELEASE_FLAVOR__ = 'rc';
    process.env.CANOPY_ENV = 'production';
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getResolvedCanopyDataDir()).toEqual({
      path: path.join(homeDir, '.canopy-rc'),
      source: 'fallback',
      allCandidates: [
        path.join(homeDir, '.testbrand-rc'),
        path.join(homeDir, '.canopy-rc'),
        path.join(homeDir, '.testbrand'),
        path.join(homeDir, '.canopy'),
      ],
    });
    expect(canopyPaths.getResolvedCanopySecureDataDir()).toEqual({
      path: path.join(homeDir, '.testbrand-rc-secure'),
      source: 'fresh',
    });
  });

  it('uses CANOPY_DATA_DIR when provided', () => {
    process.env.CANOPY_DATA_DIR = '/tmp/canopy-e2e';
    process.env.CANOPY_SECURE_DATA_DIR = '/tmp/canopy-e2e-secure';
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getCanopyDataDir()).toBe(
      path.resolve('/tmp/canopy-e2e'),
    );
    expect(canopyPaths.getCanopyCacheDir()).toBe(
      path.resolve('/tmp/canopy-e2e', '.cache'),
    );
    expect(canopyPaths.getCanopySecureDataDir()).toBe(
      path.resolve('/tmp/canopy-e2e-secure'),
    );
  });

  it('derives the secure data dir from CANOPY_DATA_DIR when no secure override is provided', () => {
    process.env.CANOPY_DATA_DIR = '/tmp/canopy-e2e';
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getResolvedCanopySecureDataDir()).toEqual({
      path: path.resolve('/tmp/canopy-e2e-secure'),
      source: 'override',
    });
    expect(canopyPaths.getCanopySecureDataDir()).toBe(
      path.resolve('/tmp/canopy-e2e-secure'),
    );
  });

  it('uses prod mode when CANOPY_ENV=production', () => {
    const homeDir = makeTempHome();
    mockBrandAndHome(homeDir);
    process.env.CANOPY_ENV = 'production';
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    process.env.NODE_ENV = 'development';

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getCanopyRuntimeMode()).toBe('prod');
    expect(canopyPaths.getCanopyDataDir()).toBe(
      path.join(homeDir, '.testbrand'),
    );
  });

  it('uses Electron default-app mode when available', () => {
    const homeDir = makeTempHome();
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_ENV;
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.NODE_ENV;
    Object.defineProperty(process, 'defaultApp', {
      configurable: true,
      value: true,
    });

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getCanopyRuntimeMode()).toBe('dev');
    expect(canopyPaths.getCanopyDataDir()).toBe(
      path.join(homeDir, '.testbrand-dev'),
    );
  });

  it('defaults source CLI runs under tsx to dev mode', () => {
    const homeDir = makeTempHome();
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_ENV;
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.NODE_ENV;
    process.execArgv = [
      '--import',
      'file:///repo/node_modules/tsx/dist/loader.mjs',
    ];

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getCanopyRuntimeMode()).toBe('dev');
    expect(canopyPaths.getCanopyDataDir()).toBe(
      path.join(homeDir, '.testbrand-dev'),
    );
  });

  it('reports explicit data-dir overrides without probing brand fallbacks', () => {
    const homeDir = makeTempHome();
    const overrideDir = path.join(homeDir, 'override');
    mockBrandAndHome(homeDir);
    process.env.CANOPY_DATA_DIR = overrideDir;
    process.env.CANOPY_SECURE_DATA_DIR = `${overrideDir}-secure`;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();
    const resolved = canopyPaths.getResolvedCanopyDataDir();

    expect(resolved).toEqual({
      path: overrideDir,
      source: 'override',
      allCandidates: [
        path.join(homeDir, '.testbrand'),
        path.join(homeDir, '.canopy'),
      ],
    });
    expect(canopyPaths.getCanopyDataDir()).toBe(overrideDir);
    expect(canopyPaths.getResolvedCanopySecureDataDir()).toEqual({
      path: `${overrideDir}-secure`,
      source: 'override',
    });
  });

  it('uses the primary branded directory for fresh non-Canopy installs', () => {
    const homeDir = makeTempHome();
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const resolved = loadCanopyPaths().getResolvedCanopyDataDir();

    expect(resolved.source).toBe('fresh');
    expect(resolved.path).toBe(path.join(homeDir, '.testbrand'));
  });

  it('uses an existing fallback directory when no primary directory exists', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const resolved = loadCanopyPaths().getResolvedCanopyDataDir();

    expect(resolved.source).toBe('fallback');
    expect(resolved.path).toBe(path.join(homeDir, '.canopy'));
    expect(loadCanopyPaths().getAiGatewayModelCatalogCacheFilePath()).toBe(
      path.join(
        homeDir,
        '.canopy',
        '.cache',
        'model-catalog',
        'ai-gateway-v1.json',
      ),
    );
  });

  it('uses the brand secure directory without probing fallback data directories', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const resolved = loadCanopyPaths().getResolvedCanopySecureDataDir();

    expect(resolved).toEqual({
      path: path.join(homeDir, '.testbrand-secure'),
      source: 'fresh',
    });
  });

  it('reports the brand secure directory as primary when it exists', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.testbrand-secure'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const resolved = loadCanopyPaths().getResolvedCanopySecureDataDir();

    expect(resolved).toEqual({
      path: path.join(homeDir, '.testbrand-secure'),
      source: 'primary',
    });
  });

  it('prefers an existing primary branded directory when both candidates exist', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.testbrand'));
    fs.mkdirSync(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const resolved = loadCanopyPaths().getResolvedCanopyDataDir();

    expect(resolved.source).toBe('primary');
    expect(resolved.path).toBe(path.join(homeDir, '.testbrand'));
  });

  it('prefers a data-bearing fallback over a skeleton primary directory', () => {
    const homeDir = makeTempHome();
    // Mimic the CAN-2271 incident: a stray cache write created the primary
    // directory without any install data while the real install lives in the
    // fallback directory.
    fs.mkdirSync(path.join(homeDir, '.testbrand', '.cache', 'model-catalog'), {
      recursive: true,
    });
    seedInstallData(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();
    const resolved = canopyPaths.getResolvedCanopyDataDir();

    expect(resolved.source).toBe('fallback');
    expect(resolved.path).toBe(path.join(homeDir, '.canopy'));
    expect(canopyPaths.getAiGatewayModelCatalogCacheFilePath()).toBe(
      path.join(
        homeDir,
        '.canopy',
        '.cache',
        'model-catalog',
        'ai-gateway-v1.json',
      ),
    );
  });

  it('prefers the primary directory when both candidates contain install data', () => {
    const homeDir = makeTempHome();
    seedInstallData(path.join(homeDir, '.testbrand'));
    seedInstallData(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const resolved = loadCanopyPaths().getResolvedCanopyDataDir();

    expect(resolved.source).toBe('primary');
    expect(resolved.path).toBe(path.join(homeDir, '.testbrand'));
  });

  function writeAutoProvisionedCoworkIndex(
    dataDir: string,
    workspaceId = 'cowork-default',
  ): void {
    writeWorkspaceIndex(dataDir, [
      {
        id: workspaceId,
        name: 'Default',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
      },
    ]);
    // The auto-provision scaffold also creates empty per-workspace dirs.
    fs.mkdirSync(
      path.join(dataDir, 'workspaces', workspaceId, 'chat-history'),
      { recursive: true },
    );
  }

  it('does not count an auto-provisioned default cowork project as install data', () => {
    const homeDir = makeTempHome();
    // A pre-fix accidental boot on the stray primary auto-provisions the
    // default cowork workspace into an otherwise skeleton directory. That
    // machine-created entry (and its empty scaffold dirs) must not
    // legitimize the hijacked primary.
    writeAutoProvisionedCoworkIndex(path.join(homeDir, '.testbrand'));
    seedInstallData(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const resolved = loadCanopyPaths().getResolvedCanopyDataDir();

    expect(resolved.source).toBe('fallback');
    expect(resolved.path).toBe(path.join(homeDir, '.canopy'));
  });

  it('does not count an empty auto-provisioned organization Chats project as install data', () => {
    const homeDir = makeTempHome();
    writeAutoProvisionedCoworkIndex(
      path.join(homeDir, '.testbrand'),
      'cowork-org-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    seedInstallData(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const resolved = loadCanopyPaths().getResolvedCanopyDataDir();

    expect(resolved.source).toBe('fallback');
  });

  it.each([
    'cowork-default',
    'cowork-org-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ])(
    'counts auto-provisioned workspace %s with persisted chats as install data',
    (workspaceId) => {
      const homeDir = makeTempHome();
      // A cowork-only install keeps every chat under the always-present
      // default workspace; that real usage must protect the install from a
      // stray skeleton primary even though the index holds no other entry.
      fs.mkdirSync(path.join(homeDir, '.testbrand', '.cache'), {
        recursive: true,
      });
      const fallbackDir = path.join(homeDir, '.canopy');
      writeAutoProvisionedCoworkIndex(fallbackDir, workspaceId);
      fs.mkdirSync(path.join(fallbackDir, 'workspaces', workspaceId, 'chats'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(fallbackDir, 'workspaces', workspaceId, 'chats', 'home.json'),
        JSON.stringify({ version: 1, tabs: [] }),
      );
      mockBrandAndHome(homeDir);
      delete process.env.CANOPY_DATA_DIR;
      delete process.env.CANOPY_SECURE_DATA_DIR;
      delete process.env.CANOPY_ENV;
      delete process.env.NODE_ENV;

      const resolved = loadCanopyPaths().getResolvedCanopyDataDir();

      expect(resolved.source).toBe('fallback');
      expect(resolved.path).toBe(fallbackDir);
    },
  );

  it('counts app-managed chat project content as install data', () => {
    const homeDir = makeTempHome();
    // An install whose only usage is an app-managed chat surface (e.g. App
    // Advisor) has no workspace index at all, but its app-workspaces content
    // is created solely by user interaction — it must still protect the
    // install from a stray skeleton primary.
    fs.mkdirSync(path.join(homeDir, '.testbrand', '.cache'), {
      recursive: true,
    });
    const fallbackDir = path.join(homeDir, '.canopy');
    fs.mkdirSync(path.join(fallbackDir, 'app-workspaces', 'app-advisor'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(fallbackDir, 'app-workspaces', 'app-advisor', 'chats.json'),
      JSON.stringify({ version: 1 }),
    );
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const resolved = loadCanopyPaths().getResolvedCanopyDataDir();

    expect(resolved.source).toBe('fallback');
    expect(resolved.path).toBe(fallbackDir);
  });

  it('does not count an empty app-workspaces directory as install data', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.testbrand', 'app-workspaces'), {
      recursive: true,
    });
    seedInstallData(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const resolved = loadCanopyPaths().getResolvedCanopyDataDir();

    expect(resolved.source).toBe('fallback');
    expect(resolved.path).toBe(path.join(homeDir, '.canopy'));
  });

  it('treats an explicit adoption marker as install data', () => {
    const homeDir = makeTempHome();
    const primaryDir = path.join(homeDir, '.testbrand');
    fs.mkdirSync(primaryDir, { recursive: true });
    fs.writeFileSync(
      path.join(primaryDir, 'data-dir-adopted.json'),
      JSON.stringify({ version: 1, adoptedAt: '2026-08-12T00:00:00.000Z' }),
    );
    seedInstallData(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const resolved = loadCanopyPaths().getResolvedCanopyDataDir();

    expect(resolved.source).toBe('primary');
    expect(resolved.path).toBe(primaryDir);
  });

  it('ignores an unreadable project index when detecting install data', () => {
    const homeDir = makeTempHome();
    const primaryDir = path.join(homeDir, '.testbrand');
    fs.mkdirSync(path.join(primaryDir, 'workspaces'), { recursive: true });
    fs.writeFileSync(
      path.join(primaryDir, 'workspaces', 'index.json'),
      'not-json',
    );
    seedInstallData(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const resolved = loadCanopyPaths().getResolvedCanopyDataDir();

    expect(resolved.source).toBe('fallback');
    expect(resolved.path).toBe(path.join(homeDir, '.canopy'));
  });

  it('keeps the auto-provisioned project id aligned with the cowork default', () => {
    const canopyPaths = loadCanopyPaths();
    expect(canopyPaths.DATA_DIR_AUTO_PROVISIONED_WORKSPACE_ID).toBe(
      DEFAULT_COWORK_WORKSPACE_ID,
    );
  });

  it('keeps CANOPY_DATA_DIR authoritative over data-bearing candidates', () => {
    const homeDir = makeTempHome();
    const overrideDir = path.join(homeDir, 'override');
    seedInstallData(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    process.env.CANOPY_DATA_DIR = overrideDir;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();
    const resolved = canopyPaths.getResolvedCanopyDataDir();

    expect(resolved.source).toBe('override');
    expect(resolved.path).toBe(overrideDir);
    expect(canopyPaths.getAiGatewayModelCatalogCacheFilePath()).toBe(
      path.join(overrideDir, '.cache', 'model-catalog', 'ai-gateway-v1.json'),
    );
  });

  it('keeps the process-sticky resolved directory until explicitly reset', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();
    expect(canopyPaths.getResolvedCanopyDataDir().path).toBe(
      path.join(homeDir, '.canopy'),
    );

    fs.mkdirSync(path.join(homeDir, '.testbrand'));
    expect(canopyPaths.getResolvedCanopyDataDir().path).toBe(
      path.join(homeDir, '.canopy'),
    );

    canopyPaths.resetResolvedCanopyDataDirForTests();
    expect(canopyPaths.getResolvedCanopyDataDir().path).toBe(
      path.join(homeDir, '.testbrand'),
    );
  });

  it('exposes an app-facing cache reset for primary data-dir transitions', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();
    expect(canopyPaths.getResolvedCanopyDataDir().source).toBe('fallback');

    fs.mkdirSync(path.join(homeDir, '.testbrand'));
    canopyPaths.resetResolvedCanopyDataDirCache();

    expect(canopyPaths.getResolvedCanopyDataDir()).toEqual({
      path: path.join(homeDir, '.testbrand'),
      source: 'primary',
      allCandidates: [
        path.join(homeDir, '.testbrand'),
        path.join(homeDir, '.canopy'),
      ],
    });
  });

  it('routes legacy environment and current environment config paths to the expected roots', () => {
    const homeDir = makeTempHome();
    fs.mkdirSync(path.join(homeDir, '.canopy'));
    mockBrandAndHome(homeDir);
    delete process.env.CANOPY_DATA_DIR;
    delete process.env.CANOPY_SECURE_DATA_DIR;
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getUserEnvironmentFilePath()).toBe(
      path.join(homeDir, '.canopy', 'user-environment.json'),
    );
    expect(canopyPaths.getLegacyEnvironmentConfigFilePath()).toBe(
      path.join(homeDir, '.canopy', 'environments.json'),
    );
    expect(canopyPaths.getEnvironmentConfigFilePath()).toBe(
      path.join(homeDir, '.testbrand-secure', 'environments.json'),
    );
  });

  it('exposes environment config paths inside an explicit data dir', () => {
    process.env.CANOPY_DATA_DIR = '/tmp/canopy-e2e-env';
    process.env.CANOPY_SECURE_DATA_DIR = '/tmp/canopy-e2e-secure-env';
    delete process.env.CANOPY_ENV;
    delete process.env.NODE_ENV;

    const canopyPaths = loadCanopyPaths();

    expect(canopyPaths.getUserEnvironmentFilePath()).toBe(
      path.resolve('/tmp/canopy-e2e-env', 'user-environment.json'),
    );
    expect(canopyPaths.getEnvironmentConfigFilePath()).toBe(
      path.resolve('/tmp/canopy-e2e-secure-env', 'environments.json'),
    );
  });
});

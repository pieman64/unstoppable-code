// Resolve the test Git independently of desktop preferences; this suite tests Git operations.
jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    Promise.resolve(process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git'),
}));

import type * as ChildProcessModule from 'node:child_process';

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcessModule>('node:child_process'),
  execFile: jest.fn(),
}));

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

const mockedExecFile = jest.mocked(execFile);

afterEach(() => {
  jest.dontMock('@canopy/brand/current');
  jest.resetModules();
  jest.clearAllMocks();
});

describe('branded git repo initialization', () => {
  it('stages the primary branded project config file', async () => {
    const repoPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-git-brand-'),
    );
    const calls: string[] = [];

    jest.doMock('@canopy/brand/current', () => ({
      BRAND: testBrand,
      default: testBrand,
    }));
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: (error: Error | null, stdout: unknown, stderr?: unknown) => void,
    ) => {
      if (Array.isArray(args) && args[0] === '-lic') {
        // getEnhancedEnv()'s login-shell PATH probe (config-paths
        // startLoginShellPathRefresh) uses execFile's raw POSITIONAL
        // callback — (error, stdout, stderr) strings — unlike runGit's
        // promisified consumer below, and calls `child.unref?.()` on the
        // returned handle.
        cb?.(null, '', '');
        return { unref: (): void => undefined };
      }
      calls.push(args.join(' '));
      // Promisified consumers (util.promisify over this mock) resolve with
      // the first callback value, so the {stdout, stderr} shape lands as
      // the await result that runGit destructures.
      cb?.(null, { stdout: '', stderr: '' });
      return { unref: (): void => undefined };
    }) as typeof execFile);

    try {
      await jest.isolateModulesAsync(async () => {
        const { initLocalRepo } = await import('../lib/git');
        await initLocalRepo(repoPath, 'branded repo');
      });

      expect(calls).toContain('add README.md .gitignore testbrand.json');
      expect(fs.existsSync(path.join(repoPath, 'testbrand.json'))).toBe(true);
      expect(fs.existsSync(path.join(repoPath, 'canopy.json'))).toBe(false);
    } finally {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

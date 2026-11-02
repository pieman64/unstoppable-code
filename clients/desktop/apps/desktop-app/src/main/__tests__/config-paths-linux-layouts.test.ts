import type * as ChildProcess from 'node:child_process';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CanopyRuntimeMode } from '@canopy/protocol/brand';
import type * as CanopyPathsModule from '@canopy/desktop-shared/canopy-paths';
import type * as BundledBinaryReportModule from '../lib/bundled-binary-report';
import type * as SharedConfigPathsModule from '@canopy/desktop-shared/pipelines/config-paths';
import type * as MainConfigPathsModule from '../pipelines/config-paths';

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcess>('node:child_process'),
  // Keep real spawnSync layout proof; never run host startup profiles when
  // these suites simulate a different platform's login-shell resolver.
  execFile: jest.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      queueMicrotask(() =>
        callback(new Error('fixture: login probe unavailable'), '', ''),
      );
      return { unref: jest.fn() };
    },
  ),
}));

// Real-filesystem fixtures of both native Linux layouts: the development cache,
// packaged Electron resources, the standalone CLI and the in-app CLI. Every
// resolved tool is spawned with an empty PATH so a lookup that silently fell
// through to a host installation cannot pass.

const SHARED_MEMBERS = [
  'claude',
  'codex',
  'codex-code-mode-host',
  'gh',
  'rg',
  'rtk',
] as const;
const DESKTOP_MEMBERS = [...SHARED_MEMBERS, 'canopy-file-broker'] as const;
type DesktopMember = (typeof DESKTOP_MEMBERS)[number];

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

const CLEARED_ENV_NAMES = [
  'CANOPY_ENV',
  'CANOPY_ENABLE_LINUX_ARM64_DEVELOPMENT',
  'CANOPY_LINUX_ARM64_DEVELOPMENT_BUILD',
  'CANOPY_CLAUDE_BINARY_PATH',
  'CANOPY_CODEX_BINARY_PATH',
  'CANOPY_GH_BINARY_PATH',
  'CANOPY_RG_BINARY_PATH',
  'CANOPY_RTK_BINARY_PATH',
  'CANOPY_DICTATE_BINARY_PATH',
  'CLAUDE_CODE_EXECUTABLE',
  'CODEX_EXECUTABLE',
  'GH_EXECUTABLE',
  'RG_EXECUTABLE',
  'RTK_EXECUTABLE',
] as const;

interface LoadedModules {
  configPaths: typeof MainConfigPathsModule;
  report: typeof BundledBinaryReportModule;
}

interface LayoutState {
  mode: CanopyRuntimeMode;
  execPath: string;
  resourcesPath?: string;
  cwd?: string;
  pathEnv?: string;
}

const warnMock = jest.fn<void, [string, unknown]>();

function writeStub(filePath: string, output: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `#!/bin/sh\necho "${output}"\n`);
  chmodSync(filePath, 0o755);
}

function stageMembers(binDir: string): void {
  for (const member of DESKTOP_MEMBERS) {
    writeStub(path.join(binDir, member), `${member} stub`);
  }
}

function getResolvedPaths(
  configPaths: typeof MainConfigPathsModule,
): Record<DesktopMember, string> {
  return {
    claude: configPaths.getBundledClaudeBinaryPath(),
    codex: configPaths.getBundledCodexBinaryPath(),
    'codex-code-mode-host': configPaths.getBundledCodexCodeModeHostPath(),
    gh: configPaths.getBundledGhBinaryPath(),
    rg: configPaths.getBundledRgBinaryPath(),
    rtk: configPaths.getBundledRtkBinaryPath(),
    'canopy-file-broker': configPaths.getBundledDelegationFileBrokerPath(),
  };
}

describeOnPosix.each(['x64', 'arm64'])(
  'Linux %s bundled binary layouts on disk',
  (arch) => {
    const originalEnv = { ...process.env };
    const originalDescriptors: Array<[string, PropertyDescriptor | undefined]> =
      ['platform', 'arch', 'execPath', 'resourcesPath'].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(process, key),
      ]);
    let fixtureRoot = '';
    const loadedConfigs: Array<typeof SharedConfigPathsModule> = [];

    function defineProcessValue(key: string, value: unknown): void {
      Object.defineProperty(process, key, {
        configurable: true,
        writable: true,
        value,
      });
    }

    function applyLayout(state: LayoutState): LoadedModules {
      const env: NodeJS.ProcessEnv = {
        ...originalEnv,
        PATH: state.pathEnv ?? '',
      };
      for (const name of CLEARED_ENV_NAMES) {
        delete env[name];
      }
      process.env = env;
      defineProcessValue('platform', 'linux');
      defineProcessValue('arch', arch);
      defineProcessValue('execPath', state.execPath);
      defineProcessValue('resourcesPath', state.resourcesPath);
      if (state.cwd) {
        jest.spyOn(process, 'cwd').mockReturnValue(state.cwd);
      }

      let loaded: LoadedModules | undefined;
      jest.isolateModules((): void => {
        jest.doMock('@canopy/desktop-shared/canopy-paths', () => ({
          ...jest.requireActual<typeof CanopyPathsModule>(
            '@canopy/desktop-shared/canopy-paths',
          ),
          getCanopyRuntimeMode: (): CanopyRuntimeMode => state.mode,
        }));
        jest.doMock('../lib/main-process-logging', () => ({
          logMainProcessWarn: warnMock,
        }));
        loadedConfigs.push(
          jest.requireActual<typeof SharedConfigPathsModule>(
            '@canopy/desktop-shared/pipelines/config-paths',
          ),
        );
        loaded = {
          configPaths: jest.requireActual<typeof MainConfigPathsModule>(
            '../pipelines/config-paths',
          ),
          report: jest.requireActual<typeof BundledBinaryReportModule>(
            '../lib/bundled-binary-report',
          ),
        };
      });
      if (!loaded) {
        throw new Error('Failed to load the bundled binary modules');
      }
      return loaded;
    }

    function expectEveryMemberRunsFrom(
      configPaths: typeof MainConfigPathsModule,
      binDir: string,
    ): void {
      expect(configPaths.getBundledBinDir()).toBe(binDir);
      const resolvedPaths = getResolvedPaths(configPaths);
      for (const member of DESKTOP_MEMBERS) {
        const resolvedPath = resolvedPaths[member];
        expect(resolvedPath).toBe(path.join(binDir, member));
        const result = spawnSync(resolvedPath, [], {
          encoding: 'utf8',
          env: { PATH: '' },
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(`${member} stub`);
      }
      expect(configPaths.listMissingDesktopBundledBinaries()).toEqual([]);
    }

    beforeEach(() => {
      fixtureRoot = realpathSync(
        mkdtempSync(path.join(tmpdir(), 'canopy-linux-bundled-')),
      );
      warnMock.mockReset();
    });

    afterEach(async () => {
      for (const config of loadedConfigs) config.resetLoginShellPathCache();
      await new Promise<void>((resolve) => setImmediate(resolve));
      loadedConfigs.length = 0;
      jest.restoreAllMocks();
      process.env = { ...originalEnv };
      for (const [key, descriptor] of originalDescriptors) {
        if (descriptor) {
          Object.defineProperty(process, key, descriptor);
        } else {
          Reflect.deleteProperty(process, key);
        }
      }
      jest.resetModules();
      rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it('runs every staged tool from the development cache', () => {
      const repoRoot = path.join(fixtureRoot, 'repo');
      const binDir = path.join(repoRoot, '.cache', 'bin', `linux-${arch}`);
      stageMembers(binDir);

      const { configPaths } = applyLayout({
        mode: 'dev',
        execPath: path.join(repoRoot, 'node_modules', 'electron', 'electron'),
        cwd: repoRoot,
      });

      expectEveryMemberRunsFrom(configPaths, binDir);
    });

    it('runs every staged tool from packaged resources/bin with an empty PATH', () => {
      const appDir = path.join(fixtureRoot, 'opt', 'Canopy');
      const binDir = path.join(appDir, 'resources', 'bin');
      stageMembers(binDir);
      writeStub(path.join(appDir, 'canopy'), 'app');

      const { configPaths } = applyLayout({
        mode: 'prod',
        execPath: path.join(appDir, 'canopy'),
        resourcesPath: path.join(appDir, 'resources'),
      });

      expectEveryMemberRunsFrom(configPaths, binDir);
      // Both supported Linux architectures recover a safe system PATH when
      // the inherited PATH is empty and the login-shell probe is unavailable.
      // Tool execution above still uses PATH: '' to rule out host fallback.
      expect(configPaths.getEnhancedEnv().PATH).toBe(
        `${binDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      );
    });

    it('runs sibling tools of a standalone CLI instead of a neighboring ~/bin', () => {
      const cliDir = path.join(fixtureRoot, 'home', 'u', 'canopy-cli');
      stageMembers(cliDir);
      writeStub(path.join(cliDir, 'canopy'), 'cli');
      for (const member of DESKTOP_MEMBERS) {
        writeStub(path.join(fixtureRoot, 'home', 'u', 'bin', member), 'decoy');
      }

      const { configPaths } = applyLayout({
        mode: 'prod',
        execPath: path.join(cliDir, 'canopy'),
      });

      expectEveryMemberRunsFrom(configPaths, cliDir);
    });

    it('runs resources/bin tools for a symlinked in-app CLI', () => {
      const resourcesDir = path.join(fixtureRoot, 'opt', 'Canopy', 'resources');
      const binDir = path.join(resourcesDir, 'bin');
      stageMembers(binDir);
      const cliPath = path.join(resourcesDir, 'cli', 'canopy');
      writeStub(cliPath, 'cli');
      const symlinkPath = path.join(fixtureRoot, 'usr', 'bin', 'canopy');
      mkdirSync(path.dirname(symlinkPath), { recursive: true });
      symlinkSync(cliPath, symlinkPath);

      const { configPaths } = applyLayout({
        mode: 'prod',
        execPath: symlinkPath,
      });

      expectEveryMemberRunsFrom(configPaths, binDir);
    });

    it('reports a missing staged member instead of a same-named host tool', () => {
      const repoRoot = path.join(fixtureRoot, 'repo');
      const binDir = path.join(repoRoot, '.cache', 'bin', `linux-${arch}`);
      stageMembers(binDir);
      rmSync(path.join(binDir, 'claude'));
      rmSync(path.join(binDir, 'canopy-file-broker'));
      const decoyDir = path.join(fixtureRoot, 'decoy');
      writeStub(path.join(decoyDir, 'claude'), 'decoy');

      const { configPaths, report } = applyLayout({
        mode: 'dev',
        execPath: path.join(repoRoot, 'node_modules', 'electron', 'electron'),
        cwd: repoRoot,
        pathEnv: decoyDir,
      });

      expect(configPaths.getBundledClaudeBinaryPath()).toBe(
        path.join(binDir, 'claude'),
      );
      expect(configPaths.listMissingDesktopBundledBinaries()).toEqual([
        { member: 'claude', path: path.join(binDir, 'claude') },
        {
          member: 'canopy-file-broker',
          path: path.join(binDir, 'canopy-file-broker'),
        },
      ]);

      report.warnAboutMissingBundledBinaries();

      expect(warnMock).toHaveBeenCalledTimes(2);
      expect(warnMock).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('claude'),
        expect.objectContaining({
          member: 'claude',
          expectedPath: path.join(binDir, 'claude'),
          hint:
            'Run `node scripts/stage-host-binaries.mjs`, then `node scripts/verify-staged-binaries.mjs --target linux-' +
            arch +
            '`.',
        }),
      );
      expect(warnMock).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('canopy-file-broker'),
        expect.objectContaining({
          member: 'canopy-file-broker',
          expectedPath: path.join(binDir, 'canopy-file-broker'),
        }),
      );
    });

    it('reports missing members only after startup settles', async () => {
      const appDir = path.join(fixtureRoot, 'opt', 'Canopy');
      const binDir = path.join(appDir, 'resources', 'bin');
      stageMembers(binDir);
      rmSync(path.join(binDir, 'gh'));

      const { report } = applyLayout({
        mode: 'prod',
        execPath: path.join(appDir, 'canopy'),
        resourcesPath: path.join(appDir, 'resources'),
      });
      let settleStartup = (): void => {};
      const startupSettled = new Promise<void>((resolve) => {
        settleStartup = resolve;
      });

      report.scheduleMissingBundledBinaryReport(startupSettled);
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnMock).not.toHaveBeenCalled();

      settleStartup();
      await startupSettled;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock).toHaveBeenCalledWith(
        expect.stringContaining('gh'),
        expect.objectContaining({
          member: 'gh',
          expectedPath: path.join(binDir, 'gh'),
        }),
      );
    });
  },
);

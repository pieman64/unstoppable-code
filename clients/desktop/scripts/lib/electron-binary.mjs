import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function getElectronPlatformPath() {
  const platform =
    process.env.ELECTRON_INSTALL_PLATFORM ??
    process.env.npm_config_platform ??
    process.platform;

  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error(
        `Electron builds are not available on platform: ${platform}`,
      );
  }
}

function runElectronInstaller(electronModuleDir) {
  const result = spawnSync(
    process.execPath,
    [path.join(electronModuleDir, 'install.js')],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw new Error(
      `Electron binary install failed to start: ${result.error.message}`,
      { cause: result.error },
    );
  }

  if (result.signal) {
    throw new Error(
      `Electron binary install terminated by signal: ${result.signal}`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `Electron binary install failed (exit ${result.status ?? 'unknown'})`,
    );
  }
}

export function ensureElectronBinaryInstalled() {
  const electronPackageJsonPath = require.resolve(
    ['electron', 'package.json'].join('/'),
  );
  const electronModuleDir = path.dirname(electronPackageJsonPath);
  const pathFile = path.join(electronModuleDir, 'path.txt');
  const expectedRelativePath = getElectronPlatformPath();
  const relativePath = existsSync(pathFile)
    ? readFileSync(pathFile, 'utf8').trim() || expectedRelativePath
    : expectedRelativePath;
  const distRoot =
    process.env.ELECTRON_OVERRIDE_DIST_PATH ??
    path.join(electronModuleDir, 'dist');
  let electronPath = path.join(distRoot, relativePath);

  if (!existsSync(electronPath)) {
    if (!process.env.ELECTRON_OVERRIDE_DIST_PATH) {
      rmSync(path.join(electronModuleDir, 'dist'), {
        recursive: true,
        force: true,
      });
    }
    runElectronInstaller(electronModuleDir);
    const installedRelativePath = existsSync(pathFile)
      ? readFileSync(pathFile, 'utf8').trim() || expectedRelativePath
      : expectedRelativePath;
    electronPath = path.join(distRoot, installedRelativePath);
  }

  if (!existsSync(electronPath)) {
    throw new Error(
      `Resolved Electron executable does not exist: ${electronPath}`,
    );
  }

  if (!existsSync(pathFile) && !process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    writeFileSync(pathFile, relativePath);
  }

  process.env.ELECTRON_EXEC_PATH = electronPath;
}

#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureElectronBinaryInstalled } from '../../../scripts/lib/electron-binary.mjs';

const require = createRequire(import.meta.url);

function getElectronViteCliPath() {
  const packageJsonPath = require.resolve('electron-vite/package.json');
  const packageJson = require(packageJsonPath);
  const { bin } = packageJson;
  const cliRelativePath =
    typeof bin === 'string'
      ? bin
      : bin && typeof bin === 'object'
        ? (bin['electron-vite'] ?? Object.values(bin)[0])
        : null;

  if (typeof cliRelativePath !== 'string' || cliRelativePath.length === 0) {
    throw new Error(
      'Unable to determine electron-vite CLI path from package.json bin field',
    );
  }

  return path.join(path.dirname(packageJsonPath), cliRelativePath);
}

function runBuild() {
  ensureElectronBinaryInstalled();
  const cliPath = getElectronViteCliPath();
  const maxOldSpaceSize =
    process.env.CANOPY_ELECTRON_VITE_MAX_OLD_SPACE_SIZE || '8192';
  const result = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${maxOldSpaceSize}`,
      cliPath,
      'build',
      '--config',
      'apps/desktop-app/electron.vite.config.ts',
      ...process.argv.slice(2),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw new Error(
      `electron-vite build failed to start: ${result.error.message}`,
      {
        cause: result.error,
      },
    );
  }

  if (result.signal) {
    throw new Error(
      `electron-vite build terminated by signal: ${result.signal}`,
    );
  }

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  throw new Error('electron-vite build did not return an exit status');
}

runBuild();

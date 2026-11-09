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

// Budget: 3 attempts of at most 5 minutes each, plus 15s and 30s waits
// between them (under 16 minutes in total). Only download failures are
// retried; install.js verifies the archive checksum before it extracts.
const ELECTRON_INSTALL_RETRY_DELAYS_MS = [15_000, 30_000];
const ELECTRON_INSTALL_ATTEMPT_TIMEOUT_MS = 5 * 60_000;

// install.js prints only the @electron/get error stack, without its cause.
// Retry HTTP statuses that GitHub's CDN returns transiently, and undici's
// "terminated", which means the response body dropped mid-download. Do not
// retry "fetch failed": TLS, DNS, proxy and refused connections print it
// identically, so it cannot be told apart from a permanent failure.
const TRANSIENT_DOWNLOAD_FAILURE =
  /\bHTTPError: Response code (?:408|429|500|502|503|504)\b|\bTypeError: terminated\b/;

function isTransientElectronDownloadFailure(stderr) {
  return TRANSIENT_DOWNLOAD_FAILURE.test(stderr) && !/checksum/i.test(stderr);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runElectronInstaller(
  electronModuleDir,
  resetDist,
  { retryDelaysMs, attemptTimeoutMs },
) {
  const attempts = retryDelaysMs.length + 1;
  for (let attempt = 1; ; attempt += 1) {
    resetDist();
    // stderr is captured to classify the failure, then echoed unchanged.
    const result = spawnSync(
      process.execPath,
      [path.join(electronModuleDir, 'install.js')],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['inherit', 'inherit', 'pipe'],
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: attemptTimeoutMs,
      },
    );
    if (result.stderr) process.stderr.write(result.stderr);
    // A stalled download is killed by our own timeout and retried; any
    // other spawn error or signal fails immediately.
    const timedOut = result.error?.code === 'ETIMEDOUT';

    if (result.error && !timedOut) {
      throw new Error(
        `Electron binary install failed to start: ${result.error.message}`,
        { cause: result.error },
      );
    }

    if (result.signal && !timedOut) {
      throw new Error(
        `Electron binary install terminated by signal: ${result.signal}`,
      );
    }

    if (result.status === 0) return;

    const failure = timedOut
      ? `Electron binary install timed out after ${attemptTimeoutMs}ms on attempt ${attempt}/${attempts}`
      : `Electron binary install failed (exit ${result.status ?? 'unknown'}) on attempt ${attempt}/${attempts}`;
    if (!timedOut && !isTransientElectronDownloadFailure(result.stderr ?? '')) {
      throw new Error(`${failure}; not a transient download error`);
    }
    if (attempt === attempts) {
      throw new Error(`${failure}; transient download retries exhausted`);
    }
    const delayMs = retryDelaysMs[attempt - 1];
    console.warn(
      `::warning::${failure} with a transient download error; retrying in ${delayMs}ms`,
    );
    sleepSync(delayMs);
  }
}

export function ensureElectronBinaryInstalled({
  electronPackageJsonPath = require.resolve(
    ['electron', 'package.json'].join('/'),
  ),
  retryDelaysMs = ELECTRON_INSTALL_RETRY_DELAYS_MS,
  attemptTimeoutMs = ELECTRON_INSTALL_ATTEMPT_TIMEOUT_MS,
} = {}) {
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
    runElectronInstaller(
      electronModuleDir,
      () => {
        if (!process.env.ELECTRON_OVERRIDE_DIST_PATH) {
          rmSync(path.join(electronModuleDir, 'dist'), {
            recursive: true,
            force: true,
          });
        }
      },
      { retryDelaysMs, attemptTimeoutMs },
    );
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

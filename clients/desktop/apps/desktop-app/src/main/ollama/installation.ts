import { execFile, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { get } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BRAND } from '@canopy/brand/current';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { getBrandEnv } from '@canopy/execution-engine/brand/env';
import { isOllamaSupportedOnPlatform } from '@canopy/desktop-shared/platform-capabilities';
import type {
  OllamaInstallProgress,
  OllamaInstallationSource,
  OllamaInstallationStatus,
} from '@canopy/desktop-shared/types';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getLoginShellPath } from '../pipelines/config-paths';
import {
  readOllamaPreferences,
  writeOllamaConfigurationPreference,
} from './preferences';
import { installMacOllamaPackage } from './install-macos';
import { installWindowsOllamaPackage } from './install-windows';

const OLLAMA_MACOS_DOWNLOAD_URL =
  'https://ollama.com/download/Ollama-darwin.zip';
const OLLAMA_WINDOWS_DOWNLOAD_URL =
  'https://ollama.com/download/OllamaSetup.exe';
const COMMAND_OUTPUT_LIMIT_BYTES = 8 * 1024;
const VALIDATION_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const MAX_DOWNLOAD_REDIRECTS = 5;
const SAFE_INSTALL_FAILURE_MESSAGE =
  'Ollama installation could not be completed. Try again or install Ollama manually.';

export interface ExecFileBoundedResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface ExecFileBoundedOptions {
  timeoutMs: number;
  allowNonZeroExit?: boolean;
  windowsHide?: boolean;
}

interface Candidate {
  path: string;
  source: OllamaInstallationSource;
}

let detectionPromise: Promise<OllamaInstallationStatus> | null = null;
let installPromise: Promise<OllamaInstallationStatus> | null = null;
const activeTempDirs = new Set<string>();
const activeDownloadRequests = new Set<ClientRequest>();
const activeCommandChildren = new Set<ChildProcess>();

function nowIso(): string {
  return new Date().toISOString();
}

function isSupportedInstallPlatform(): boolean {
  return (
    isOllamaSupportedOnPlatform() &&
    (hostOperatingSystem() === 'darwin' || hostOperatingSystem() === 'win32')
  );
}

function createStatus(update: {
  ready: boolean;
  path: string | null;
  version: string | null;
  source: OllamaInstallationSource;
  error?: string;
}): OllamaInstallationStatus {
  return {
    platform: process.platform,
    ready: update.ready,
    path: update.path,
    version: update.version,
    source: update.source,
    checkedAt: nowIso(),
    automaticInstallSupported: isSupportedInstallPlatform(),
    ...(update.error ? { error: update.error } : {}),
  };
}

export function createUnavailableOllamaInstallationStatus(
  error?: string,
): OllamaInstallationStatus {
  return createStatus({
    ready: false,
    path: null,
    version: null,
    source: 'not-found',
    ...(error ? { error } : {}),
  });
}

function getNumericExitCode(error: unknown): number | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'number'
  ) {
    return error.code;
  }
  return null;
}

export function execFileBounded(
  file: string,
  args: string[],
  options: ExecFileBoundedOptions,
): Promise<ExecFileBoundedResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: options.windowsHide ?? hostOperatingSystem() === 'win32',
        maxBuffer: COMMAND_OUTPUT_LIMIT_BYTES,
      },
      (error, stdout, stderr) => {
        activeCommandChildren.delete(child);
        const exitCode = getNumericExitCode(error);
        const result = {
          stdout: String(stdout ?? '').slice(-COMMAND_OUTPUT_LIMIT_BYTES),
          stderr: String(stderr ?? '').slice(-COMMAND_OUTPUT_LIMIT_BYTES),
          exitCode,
        };
        if (error && (!options.allowNonZeroExit || exitCode === null)) {
          reject(
            new Error(
              result.stderr.trim() || result.stdout.trim() || error.message,
            ),
          );
          return;
        }
        resolve(result);
      },
    );
    activeCommandChildren.add(child);
    child.stdout?.on('data', () => {});
  });
}

export function quoteAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseOllamaVersion(output: string): string | null {
  if (!/ollama/i.test(output)) {
    return null;
  }
  const match =
    /(?:version\s*(?:is\s*)?|ollama\s+)(v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i.exec(
      output,
    );
  return match?.[1]?.replace(/^v/i, '') ?? null;
}

export async function validateOllamaExecutable(
  candidatePath: string,
  source: OllamaInstallationSource,
): Promise<OllamaInstallationStatus> {
  const trimmed = candidatePath.trim();
  if (!trimmed || !isAbsolute(trimmed)) {
    return createStatus({
      ready: false,
      path: null,
      version: null,
      source,
      error: 'Select a valid absolute path to the Ollama executable.',
    });
  }

  try {
    const candidateStat = await stat(trimmed);
    if (!candidateStat.isFile()) {
      return createStatus({
        ready: false,
        path: trimmed,
        version: null,
        source,
        error: 'The selected path is not an executable file.',
      });
    }
    try {
      await access(trimmed, constants.X_OK);
    } catch {
      return createStatus({
        ready: false,
        path: trimmed,
        version: null,
        source,
        error: 'The selected path is not an executable file.',
      });
    }
    const result = await execFileBounded(trimmed, ['--version'], {
      timeoutMs: VALIDATION_TIMEOUT_MS,
      allowNonZeroExit: true,
    });
    const version = parseOllamaVersion(`${result.stdout}\n${result.stderr}`);
    if (!version) {
      return createStatus({
        ready: false,
        path: trimmed,
        version: null,
        source,
        error: 'The selected executable did not report an Ollama version.',
      });
    }
    return createStatus({
      ready: true,
      path: trimmed,
      version,
      source,
    });
  } catch (error) {
    return createStatus({
      ready: false,
      path: trimmed,
      version: null,
      source,
      error:
        error instanceof Error
          ? error.message
          : 'The selected executable could not be validated.',
    });
  }
}

function normalizeCandidatePath(value: string): string {
  if (hostOperatingSystem() === 'win32') {
    return value.toLowerCase();
  }
  return value;
}

function pushCandidate(
  candidates: Candidate[],
  seen: Set<string>,
  path: string | undefined,
  source: OllamaInstallationSource,
): void {
  const trimmed = path?.trim();
  if (!trimmed) {
    return;
  }
  const key = normalizeCandidatePath(trimmed);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  candidates.push({ path: trimmed, source });
}

function normalizePathDirectory(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function isSafeOllamaPathDirectory(
  directory: string,
  workingDirectory: string,
): boolean {
  if (!isAbsolute(directory)) {
    return false;
  }
  return (
    normalizeCandidatePath(resolve(directory)) !==
    normalizeCandidatePath(resolve(workingDirectory))
  );
}

function getPathCandidates(): string[] {
  const names =
    hostOperatingSystem() === 'win32' ? ['ollama.exe', 'ollama'] : ['ollama'];
  const rawPath =
    hostOperatingSystem() === 'darwin' || hostOperatingSystem() === 'linux'
      ? getLoginShellPath()
      : (process.env.PATH ?? '');
  const workingDirectory = process.cwd();
  const workingDirectoryCandidates = new Set(
    names.map((name) => normalizeCandidatePath(join(process.cwd(), name))),
  );
  return rawPath
    .split(delimiter)
    .map(normalizePathDirectory)
    .filter((dir) => isSafeOllamaPathDirectory(dir, workingDirectory))
    .flatMap((dir) => names.map((name) => join(dir, name)))
    .filter(
      (candidate) =>
        !workingDirectoryCandidates.has(normalizeCandidatePath(candidate)),
    );
}

function getKnownLocationCandidates(): string[] {
  if (hostOperatingSystem() === 'darwin') {
    const home = process.env.HOME ?? '';
    return [
      '/Applications/Ollama.app/Contents/Resources/ollama',
      ...(home
        ? [
            join(
              home,
              'Applications',
              'Ollama.app',
              'Contents',
              'Resources',
              'ollama',
            ),
          ]
        : []),
      '/opt/homebrew/bin/ollama',
      '/usr/local/bin/ollama',
    ];
  }

  if (hostOperatingSystem() === 'win32') {
    return [
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')
        : '',
      process.env.ProgramFiles
        ? join(process.env.ProgramFiles, 'Ollama', 'ollama.exe')
        : '',
      process.env['ProgramFiles(x86)']
        ? join(process.env['ProgramFiles(x86)'], 'Ollama', 'ollama.exe')
        : '',
    ].filter(Boolean);
  }

  if (hostOperatingSystem() === 'linux') {
    return ['/usr/local/bin/ollama', '/usr/bin/ollama'];
  }

  return [];
}

function collectCandidates(persistedPath?: string): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  pushCandidate(
    candidates,
    seen,
    getBrandEnv(process.env, 'OLLAMA_BINARY_PATH'),
    'environment',
  );
  pushCandidate(candidates, seen, process.env.OLLAMA_EXECUTABLE, 'environment');
  pushCandidate(candidates, seen, persistedPath, 'persisted');
  for (const path of getPathCandidates()) {
    pushCandidate(candidates, seen, path, 'auto-detected');
  }
  for (const path of getKnownLocationCandidates()) {
    pushCandidate(candidates, seen, path, 'auto-detected');
  }
  return candidates;
}

async function detectOllamaInstallationInner(
  persistedPath?: string,
  persistDetectedPath = true,
): Promise<OllamaInstallationStatus> {
  if (!isOllamaSupportedOnPlatform()) {
    return createUnavailableOllamaInstallationStatus(
      "Ollama isn't available on this platform.",
    );
  }

  let lastFailure: OllamaInstallationStatus | null = null;
  for (const candidate of collectCandidates(persistedPath)) {
    const status = await validateOllamaExecutable(
      candidate.path,
      candidate.source,
    );
    if (status.ready && status.path) {
      if (persistDetectedPath) {
        await writeOllamaConfigurationPreference({
          executablePath: status.path,
        });
      }
      return status;
    }
    lastFailure = status;
  }

  return createUnavailableOllamaInstallationStatus(lastFailure?.error);
}

export function detectOllamaInstallation(options?: {
  force?: boolean;
  persistedPath?: string;
  persistDetectedPath?: boolean;
}): Promise<OllamaInstallationStatus> {
  if (!options?.force && detectionPromise) {
    return detectionPromise;
  }
  detectionPromise = detectOllamaInstallationInner(
    options?.persistedPath,
    options?.persistDetectedPath,
  ).finally(() => {
    detectionPromise = null;
  });
  return detectionPromise;
}

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  activeTempDirs.add(dir);
  return dir;
}

async function cleanupTempDir(dir: string): Promise<void> {
  activeTempDirs.delete(dir);
  await rm(dir, { force: true, recursive: true });
}

async function downloadToFile(
  url: string,
  destination: string,
  onProgress?: (
    progress: Pick<OllamaInstallProgress, 'downloadedBytes' | 'totalBytes'>,
  ) => void,
  redirectCount = 0,
  deadlineMs = Date.now() + DOWNLOAD_TIMEOUT_MS,
): Promise<void> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Ollama downloads must use HTTPS.');
  }
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error('Timed out downloading Ollama.');
  }
  await new Promise<void>((resolve, reject) => {
    let responseStarted = false;
    let responseStream: IncomingMessage | null = null;
    const resolveBeforeDeadline = (): void => {
      clearTimeout(deadlineTimer);
      resolve();
    };
    const rejectBeforeDeadline = (error: Error): void => {
      clearTimeout(deadlineTimer);
      reject(error);
    };
    const request = get(parsedUrl, (response) => {
      responseStarted = true;
      responseStream = response;
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        if (redirectCount >= MAX_DOWNLOAD_REDIRECTS) {
          response.destroy();
          rejectBeforeDeadline(
            new Error('Too many redirects while downloading Ollama.'),
          );
          return;
        }
        let redirectUrl: URL;
        try {
          redirectUrl = new URL(response.headers.location, parsedUrl);
        } catch {
          response.destroy();
          rejectBeforeDeadline(
            new Error('Ollama download returned an invalid redirect.'),
          );
          return;
        }
        if (redirectUrl.protocol !== 'https:') {
          response.destroy();
          rejectBeforeDeadline(
            new Error('Ollama download redirected to a non-HTTPS URL.'),
          );
          return;
        }
        response.once('error', rejectBeforeDeadline);
        response.once('end', () => {
          downloadToFile(
            redirectUrl.href,
            destination,
            onProgress,
            redirectCount + 1,
            deadlineMs,
          ).then(resolveBeforeDeadline, rejectBeforeDeadline);
        });
        response.resume();
        return;
      }
      if (response.statusCode !== 200) {
        response.destroy();
        rejectBeforeDeadline(
          new Error(`Download failed with HTTP ${String(response.statusCode)}`),
        );
        return;
      }

      const totalBytes = Number(response.headers['content-length']);
      let downloadedBytes = 0;
      const stream = createWriteStream(destination);
      response.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        onProgress?.({
          downloadedBytes,
          ...(Number.isFinite(totalBytes) && totalBytes > 0
            ? { totalBytes }
            : {}),
        });
      });
      pipeline(response, stream).then(
        resolveBeforeDeadline,
        rejectBeforeDeadline,
      );
    });
    activeDownloadRequests.add(request);
    const deadlineTimer = setTimeout(() => {
      const error = new Error('Timed out downloading Ollama.');
      responseStream?.destroy(error);
      request.destroy(error);
    }, remainingMs);
    request.on('error', (error) => {
      if (!responseStarted) {
        rejectBeforeDeadline(error);
      }
    });
    request.on('close', () => {
      activeDownloadRequests.delete(request);
    });
  });
}

function emitProgress(
  onProgress: ((progress: OllamaInstallProgress) => void) | undefined,
  progress: OllamaInstallProgress,
): void {
  onProgress?.(progress);
}

function toRendererSafeInstallError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Ollama installation cleanup requested.') {
    return message;
  }
  return SAFE_INSTALL_FAILURE_MESSAGE;
}

async function installOllamaInner(
  onProgress?: (progress: OllamaInstallProgress) => void,
): Promise<OllamaInstallationStatus> {
  if (!isSupportedInstallPlatform()) {
    return createUnavailableOllamaInstallationStatus(
      isOllamaSupportedOnPlatform() && hostOperatingSystem() === 'linux'
        ? 'Automatic Ollama installation is unavailable on Linux. Install Ollama manually, then refresh detection or browse for its executable.'
        : "Ollama isn't available on this platform.",
    );
  }

  const preferences = await readOllamaPreferences();
  const existing = await detectOllamaInstallation({
    force: true,
    persistedPath: preferences.executablePath,
  });
  if (existing.ready) {
    return existing;
  }

  let currentPhase: OllamaInstallProgress['phase'] = 'starting';
  const report = (progress: OllamaInstallProgress): void => {
    currentPhase = progress.phase;
    emitProgress(onProgress, progress);
  };
  report({
    phase: 'starting',
    message: 'Preparing Ollama installation...',
  });

  const tempDir = await createTempDir(`${BRAND.id}-ollama-`);
  try {
    const downloadUrl =
      hostOperatingSystem() === 'darwin'
        ? OLLAMA_MACOS_DOWNLOAD_URL
        : hostOperatingSystem() === 'win32'
          ? OLLAMA_WINDOWS_DOWNLOAD_URL
          : null;
    if (!downloadUrl) {
      throw new Error('Automatic Ollama installation is unsupported here.');
    }
    const downloadPath = join(tempDir, basename(new URL(downloadUrl).pathname));
    report({
      phase: 'downloading',
      message: 'Downloading Ollama...',
    });
    await downloadToFile(downloadUrl, downloadPath, (progress) => {
      report({
        phase: 'downloading',
        message: 'Downloading Ollama...',
        ...progress,
      });
    });

    report({
      phase: 'verifying',
      message: 'Verifying the Ollama download...',
    });
    let installedExecutablePath: string | undefined;
    if (hostOperatingSystem() === 'darwin') {
      const extractDir = join(tempDir, 'extract');
      installedExecutablePath = await installMacOllamaPackage(
        downloadPath,
        extractDir,
        () =>
          report({
            phase: 'installing',
            message: 'Installing Ollama...',
          }),
      );
    } else if (hostOperatingSystem() === 'win32') {
      await installWindowsOllamaPackage(downloadPath, () =>
        report({
          phase: 'installing',
          message: 'Installing Ollama...',
        }),
      );
    } else {
      throw new Error('Automatic Ollama installation is unsupported here.');
    }

    report({
      phase: 'detecting',
      message: 'Detecting the installed Ollama executable...',
    });
    const status = await detectOllamaInstallation({
      force: true,
      persistedPath: installedExecutablePath,
    });
    if (!status.ready) {
      throw new Error(
        status.error ??
          'Ollama was installed but its executable could not be detected.',
      );
    }
    report({
      phase: 'success',
      message: 'Ollama was installed successfully.',
      ...(status.path ? { path: status.path } : {}),
      ...(status.version ? { version: status.version } : {}),
    });
    return {
      ...status,
      source: 'installed',
    };
  } catch (error) {
    // The renderer only receives a generic message, so the cause is kept here.
    logMainProcessWarn('Ollama installation failed', {
      phase: currentPhase,
      error: error instanceof Error ? error.message : String(error),
    });
    const message = toRendererSafeInstallError(error);
    emitProgress(onProgress, {
      phase: 'failure',
      message: 'Ollama installation could not be completed.',
      error: message,
    });
    return createUnavailableOllamaInstallationStatus(message);
  } finally {
    await cleanupTempDir(tempDir);
  }
}

export function installOllama(
  onProgress?: (progress: OllamaInstallProgress) => void,
): Promise<OllamaInstallationStatus> {
  if (installPromise) {
    return Promise.reject(
      new Error('An Ollama installation is already running.'),
    );
  }
  installPromise = installOllamaInner(onProgress).finally(() => {
    installPromise = null;
  });
  return installPromise;
}

export async function cleanupOllamaInstallationWork(): Promise<void> {
  for (const request of Array.from(activeDownloadRequests)) {
    request.destroy(new Error('Ollama installation cleanup requested.'));
  }
  for (const child of Array.from(activeCommandChildren)) {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  }
  const pendingInstall = installPromise;
  if (pendingInstall) {
    await pendingInstall.catch(() => undefined);
  }
  await Promise.all(
    Array.from(activeTempDirs).map((dir) =>
      cleanupTempDir(dir).catch(() => {}),
    ),
  );
}

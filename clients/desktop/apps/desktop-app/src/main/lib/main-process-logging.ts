/* eslint-disable no-console -- this module deliberately redirects console output to the persistent log */
import { app } from 'electron';
import log from 'electron-log/main.js';
import type { LogMessage, Transport } from 'electron-log';
import {
  AsyncMainLogSink,
  type MainLogFlushResult,
} from './async-main-log-sink';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import { isE2eBuild } from './e2e-gate';

const MAIN_LOG_MAX_SIZE_BYTES = 10 * 1024 * 1024;

type ForwardedConsoleMethod = 'debug' | 'error' | 'info' | 'log' | 'warn';

const forwardedConsoleMethods: readonly ForwardedConsoleMethod[] = [
  'debug',
  'error',
  'info',
  'log',
  'warn',
];

let initialized = false;
let mainLogSink: AsyncMainLogSink | null = null;
let originalConsoleMethods: Partial<
  Record<ForwardedConsoleMethod, (...args: unknown[]) => void>
> = {};

export function logMainProcessError(message: string, error: unknown): void {
  try {
    log.error(message, error);
  } catch {
    // Logging must never break the main-process operation being diagnosed.
  }
}

export function logMainProcessInfo(message: string, context?: unknown): void {
  try {
    if (context === undefined) {
      log.info(message);
    } else {
      log.info(message, context);
    }
  } catch {
    // Logging must never break the main-process operation being diagnosed.
  }
}

/** High-volume traces; the file transport keeps them only in development. */
export function logMainProcessDebug(message: string, context?: unknown): void {
  try {
    if (context === undefined) {
      log.debug(message);
    } else {
      log.debug(message, context);
    }
  } catch {
    // Logging must never break the main-process operation being diagnosed.
  }
}

export function logMainProcessWarn(message: string, context?: unknown): void {
  try {
    if (context === undefined) {
      log.warn(message);
    } else {
      log.warn(message, context);
    }
  } catch {
    // Logging must never break the main-process operation being diagnosed.
  }
}

export function getMainLogPath(
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = homedir(),
  isolatedDataDirectory?: string,
): string {
  const normalizedIsolatedDataDirectory = isolatedDataDirectory?.trim();
  if (normalizedIsolatedDataDirectory) {
    return join(normalizedIsolatedDataDirectory, 'logs', 'main.log');
  }

  if (platform === 'darwin') {
    return join(
      homeDirectory,
      'Library',
      'Logs',
      `${BRAND.internalName}-ui`,
      'main.log',
    );
  }

  return join(app.getPath('userData'), 'logs', 'main.log');
}

function forwardConsoleToFile(): void {
  const loggerByConsoleMethod: Record<
    ForwardedConsoleMethod,
    (...args: unknown[]) => void
  > = {
    debug: (...args) => log.debug(...args),
    error: (...args) => log.error(...args),
    info: (...args) => log.info(...args),
    log: (...args) => log.info(...args),
    warn: (...args) => log.warn(...args),
  };

  for (const method of forwardedConsoleMethods) {
    const original = console[method].bind(console);
    const fileLogger = loggerByConsoleMethod[method];
    originalConsoleMethods[method] = original;
    console[method] = (...args: unknown[]): void => {
      original(...args);
      try {
        fileLogger(...args);
      } catch {
        // Persistent logging must never break the call site using console.
      }
    };
  }
}

/**
 * Installs persistent main-process logging before the desktop app starts any
 * asynchronous work. Existing console calls keep their original terminal
 * output and are also written to main.log.
 */
export function initializeMainProcessLogging(): string {
  // E2E launches provide a unique CANOPY_DATA_DIR for every app process. Keep
  // their diagnostics with that disposable test state instead of mixing them
  // into the retained user log. Standard E2E bundles use the build-time gate;
  // the harness explicitly marks its production-bundle launches so release-like
  // specs get the same isolation. Packaged production launches ignore that
  // marker and therefore cannot redirect logging with CANOPY_DATA_DIR alone.
  const isolateE2eLogging =
    isE2eBuild() ||
    (!app.isPackaged && process.env.CANOPY_E2E_ISOLATED_LOGGING === '1');
  const configuredIsolatedDataDirectory = isolateE2eLogging
    ? process.env.CANOPY_DATA_DIR || process.env.CANOPY_E2E_USER_DATA_DIR
    : undefined;
  const isolatedDataDirectory =
    configuredIsolatedDataDirectory?.trim() &&
    existsSync(configuredIsolatedDataDirectory)
      ? configuredIsolatedDataDirectory
      : undefined;
  const logPath = getMainLogPath(
    process.platform,
    homedir(),
    isolatedDataDirectory,
  );
  if (initialized) {
    return logPath;
  }

  const logDirectory = dirname(logPath);
  app.setAppLogsPath(logDirectory);

  log.transports.file.resolvePathFn = (): string => logPath;
  log.transports.file.fileName = 'main.log';
  log.transports.file.maxSize = MAIN_LOG_MAX_SIZE_BYTES;
  const fileLevel = process.env.NODE_ENV === 'development' ? 'debug' : 'info';
  log.transports.file.level = false;
  log.transports.file.format =
    '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
  const originalError = console.error.bind(console);
  const sink = new AsyncMainLogSink({
    path: logPath,
    maxSize: MAIN_LOG_MAX_SIZE_BYTES,
    maxPendingBytes: 1024 * 1024,
    fallback: originalError,
  });
  mainLogSink = sink;
  const transportOptions: Pick<Transport, 'level' | 'transforms'> = {
    level: fileLevel,
    transforms: [],
  };
  const transport: Transport = Object.assign((message: LogMessage): void => {
    try {
      // Use the installed library's public formatting pipeline, not its writer.
      let data: unknown = message.data;
      for (const transform of log.transports.file.transforms) {
        if (!Array.isArray(data))
          throw new Error('Unexpected main log transform input');
        data = transform({
          data,
          message,
          logger: log,
          transport: log.transports.file,
        });
      }
      if (typeof data !== 'string')
        throw new Error('Unexpected main log transform output');
      sink.append(data);
    } catch (error) {
      try {
        originalError('Main log formatting failed', error);
      } catch {
        /* Best effort. */
      }
      // Count a lost record with a gap; no recursive logger call.
      sink.rejectRecord();
    }
  }, transportOptions);
  log.transports.mainFileAsync = transport;

  // The wrapper above preserves the original console output. Disable the
  // logger's console transport so each message is not printed twice.
  log.transports.console.level = false;

  // Renderer errors are already filtered and relayed by index.ts. Avoid the
  // library's second console-message listener, which would duplicate them.
  log.initialize({ preload: false, spyRendererConsole: false });
  forwardConsoleToFile();
  initialized = true;

  console.info('Main process file logging initialized', { logPath });
  return logPath;
}

export function flushMainProcessLogging(): Promise<MainLogFlushResult> {
  return (
    mainLogSink?.flush() ??
    Promise.resolve({
      throughSequence: 0,
      writtenRecords: 0,
      failedRecords: 0,
      droppedRecords: 0,
      failedGapNotices: 0,
    })
  );
}

export function drainMainProcessLogging(): Promise<MainLogFlushResult> {
  return mainLogSink?.drain() ?? flushMainProcessLogging();
}

/** Ancillary failure-exit tail only; required runtime/storage drains are separate. */
export async function drainMainProcessLoggingBestEffort(
  timeoutMs: number,
): Promise<MainLogFlushResult | null> {
  let cancel = (): void => undefined;
  const timeout = new Promise<null>((resolve) => {
    const timer = setTimeout(() => {
      try {
        originalConsoleMethods.error?.('Main log terminal drain timed out');
      } catch {
        /* Best effort. */
      }
      resolve(null);
    }, timeoutMs);
    cancel = (): void => clearTimeout(timer);
  });
  try {
    return await Promise.race([drainMainProcessLogging(), timeout]);
  } finally {
    cancel();
  }
}

export function resetMainProcessLoggingForTests(): void {
  // Tests must await the drain before resetting an initialized real sink.
  log.transports.mainFileAsync = null;
  mainLogSink = null;
  for (const method of forwardedConsoleMethods) {
    const original = originalConsoleMethods[method];
    if (original) {
      console[method] = original;
    }
  }
  originalConsoleMethods = {};
  initialized = false;
}

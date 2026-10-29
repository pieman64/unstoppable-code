import { spawn, type ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { open, rename, writeFile, unlink, readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { basename, dirname } from 'node:path';
import { fsyncDirectory } from '../lib/fsync-directory';
import { isErrnoException, isRecord } from '../lib/type-guards';
import { findExecutableOnPath } from '@canopy/desktop-shared/node/lib/path-lookup';
import {
  LOCAL_WATCHER_LIMITS,
  type WatcherCommandOutput,
} from '@canopy/desktop-shared/types/local-watchers';

export interface WatcherCommandResult {
  exitCode: number | null;
  signal: string | null;
  reason?: string;
  output: WatcherCommandOutput;
}

function isCommandResult(
  value: unknown,
  outputPath: string,
): value is WatcherCommandResult {
  if (!isRecord(value)) return false;
  const result = value;
  if (
    (result.exitCode !== null && !Number.isInteger(result.exitCode)) ||
    (result.signal !== null && typeof result.signal !== 'string') ||
    (result.reason !== undefined && typeof result.reason !== 'string') ||
    !isRecord(result.output)
  )
    return false;
  const output = result.output;
  if (
    typeof output.byteSize !== 'number' ||
    !Number.isInteger(output.byteSize) ||
    output.byteSize < 0 ||
    output.byteSize > LOCAL_WATCHER_LIMITS.maxBytes ||
    typeof output.lineCount !== 'number' ||
    !Number.isInteger(output.lineCount) ||
    output.lineCount < 0 ||
    output.lineCount > output.byteSize ||
    typeof output.complete !== 'boolean'
  )
    return false;
  return output.kind === 'inline'
    ? typeof output.text === 'string' &&
        Buffer.byteLength(output.text) === output.byteSize &&
        output.byteSize <= LOCAL_WATCHER_LIMITS.inlineBytes
    : output.kind === 'file' &&
        output.path === outputPath &&
        (output.scriptId === undefined || typeof output.scriptId === 'string');
}

export async function readWatcherCommandResult(
  outputPath: string,
): Promise<WatcherCommandResult | undefined> {
  let contents: string;
  try {
    contents = await readFile(`${outputPath}.result.json`, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  let checkpoint: unknown;
  try {
    checkpoint = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const result =
    isRecord(checkpoint) && checkpoint.version === 1
      ? checkpoint.result
      : isRecord(checkpoint) && 'version' in checkpoint
        ? undefined
        : checkpoint;
  return isCommandResult(result, outputPath) ? result : undefined;
}

/** Kill the process tree asynchronously, including descendants holding pipes open. */
type KillableChildProcess = Pick<ChildProcess, 'pid' | 'kill'>;
type SpawnTaskkill = (
  command: string,
  args: string[],
  options: { windowsHide: boolean; stdio: 'ignore' },
) => EventEmitter;

export async function terminateWindowsProcessTree(
  child: KillableChildProcess,
  spawnProcess: SpawnTaskkill = (command, args, options) =>
    spawn(command, args, options),
): Promise<void> {
  if (!child.pid) return;
  await new Promise<void>((resolve, reject) => {
    const killer = spawnProcess(
      'taskkill',
      ['/pid', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    );
    killer.once('error', (error) => {
      try {
        child.kill();
      } catch {
        // Preserve the taskkill failure below; it is the actionable root cause.
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    killer.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolve();
        return;
      }
      try {
        child.kill();
      } catch {
        // Preserve the taskkill failure below; it is the actionable root cause.
      }
      reject(new Error(`taskkill failed with exit code ${String(exitCode)}`));
    });
  });
}

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(child);
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ESRCH') return;
      if (isErrnoException(error) && error.code === 'EPERM') {
        // On macOS an already-exited group can return EPERM before Node emits
        // its exit event. Confirm exit; never hide a denial for a live child.
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        if (child.exitCode !== null || child.signalCode !== null) return;
      }
      throw error;
    }
  }
}

/** Bounded-memory, lossless capture of the terminal attempt (arrival-order merged streams). */
export async function runWatcherCommand(options: {
  command: string;
  cwd: string;
  outputPath: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  inlineBytes?: number;
  maxBytes?: number;
}): Promise<WatcherCommandResult> {
  options.signal?.throwIfAborted();
  const activePath = `${options.outputPath}.active`;
  const file = await open(activePath, 'wx', 0o600);
  let scriptPath: string | undefined;
  const merged = new PassThrough({ highWaterMark: 64 * 1024 });
  const maxBytes = options.maxBytes ?? LOCAL_WATCHER_LIMITS.maxBytes;
  const inlineBytes = options.inlineBytes ?? LOCAL_WATCHER_LIMITS.inlineBytes;
  let reason: string | undefined;
  let byteSize = 0;
  let newlines = 0;
  let lastByte: number | undefined;
  const preview: Buffer[] = [];
  let child: ChildProcess | undefined;
  let processClosed = false;
  let termination: Promise<void> | undefined;
  const stop = (why: string): void => {
    if (why === 'timeout' && processClosed) return;
    reason ??= why;
    if (child && !processClosed && !termination) {
      termination = terminate(child).catch((error) => {
        merged.destroy(
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      });
    }
  };
  const abort = (): void => stop('cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let shell: string;
    let args: string[];
    let windowsVerbatimArguments = false;
    if (process.platform === 'win32') {
      const powershell =
        findExecutableOnPath('pwsh.exe') ??
        findExecutableOnPath('powershell.exe');
      scriptPath = `${options.outputPath}.${powershell ? 'ps1' : 'cmd'}`;
      const script = powershell
        ? [
            "$ErrorActionPreference = 'Stop'",
            options.command,
            '$watcherSuccess = $?',
            '$watcherExit = $LASTEXITCODE',
            'if (-not $watcherSuccess) { if ($watcherExit -is [int] -and $watcherExit -ne 0) { exit $watcherExit }; exit 1 }',
            'exit 0',
          ].join('\n')
        : options.command;
      await writeFile(scriptPath, script, { mode: 0o600, flag: 'wx' });
      shell = powershell ?? process.env.ComSpec ?? 'cmd.exe';
      args = powershell
        ? [
            '-NoLogo',
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
          ]
        : ['/d', '/s', '/c', `"${scriptPath}"`];
      windowsVerbatimArguments = !powershell;
    } else {
      // Approval rules use the POSIX command grammar. Execute with the matching
      // fixed shell instead of a user-selected login shell whose extensions
      // (for example zsh glob qualifiers) the approval matcher cannot model.
      shell = '/bin/sh';
      args = ['-c', options.command];
    }
    options.signal?.throwIfAborted();
    const spawned = spawn(shell, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = spawned;
    const closed = new Promise<{
      exitCode: number | null;
      signal: string | null;
    }>((resolve) => {
      spawned.once('error', (error) => {
        reason ??= `spawn_error: ${error.message}`;
      });
      spawned.once('close', (exitCode, signal) => {
        processClosed = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        merged.end();
        resolve({ exitCode, signal });
      });
    });
    spawned.stdout.pipe(merged, { end: false });
    spawned.stderr.pipe(merged, { end: false });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    timer = setTimeout(
      () => stop('timeout'),
      options.timeoutMs ?? LOCAL_WATCHER_LIMITS.timeoutMs,
    );
    for await (const chunk of merged) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const bytes = incoming.subarray(0, Math.max(0, maxBytes - byteSize));
      if (bytes.length) {
        // FileHandle.write may write fewer bytes than requested.
        for (let offset = 0; offset < bytes.length; ) {
          const written = await file.write(
            bytes,
            offset,
            bytes.length - offset,
          );
          if (!written.bytesWritten)
            throw new Error('Output file made no write progress.');
          offset += written.bytesWritten;
        }
        byteSize += bytes.length;
        for (let index = 0; index < bytes.length; index++)
          if (bytes[index] === 10) newlines++;
        lastByte = bytes[bytes.length - 1];
        if (byteSize <= inlineBytes) preview.push(Buffer.from(bytes));
        else preview.length = 0;
      }
      if (bytes.length < incoming.length) stop('output_limit');
    }
    const result = await closed;
    await termination;
    await file.sync();
    await file.close();
    await rename(activePath, options.outputPath);
    await fsyncDirectory(dirname(options.outputPath));
    const metadata = {
      byteSize,
      lineCount: newlines + (lastByte !== undefined && lastByte !== 10 ? 1 : 0),
      complete: !reason && !result.signal,
    };
    const buffer = Buffer.concat(preview);
    const text = buffer.toString('utf8');
    const output: WatcherCommandOutput =
      byteSize <= inlineBytes && Buffer.from(text).equals(buffer)
        ? { ...metadata, kind: 'inline', text }
        : {
            ...metadata,
            kind: 'file',
            path: options.outputPath,
            scriptId: `watcher:${basename(dirname(options.outputPath))}:${basename(options.outputPath, '.log').replace('attempt-', '')}`,
          };
    const terminalResult = {
      ...result,
      reason: reason ?? (result.signal ? 'signal' : undefined),
      output,
    };
    if (reason === 'cancelled') return terminalResult;
    // Recover this exact result if the process dies before the watcher outbox commits.
    const checkpoint = await open(
      `${options.outputPath}.result.json.active`,
      'wx',
      0o600,
    );
    try {
      await checkpoint.writeFile(
        JSON.stringify({ version: 1, result: terminalResult }),
      );
      await checkpoint.sync();
    } finally {
      await checkpoint.close();
    }
    await rename(
      `${options.outputPath}.result.json.active`,
      `${options.outputPath}.result.json`,
    );
    await fsyncDirectory(dirname(options.outputPath));
    return terminalResult;
  } catch (error) {
    stop('capture_error');
    await termination;
    // Preserve the .active prefix for recovery. Never report a successful capture.
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    await file.close().catch(() => undefined);
    if (scriptPath) await unlink(scriptPath).catch(() => undefined);
  }
}

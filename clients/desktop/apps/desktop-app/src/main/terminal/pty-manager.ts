import { logMainProcessWarn } from '../lib/main-process-logging';
import { drainOwnedProcess } from '../lib/process-kill';
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path, { basename } from 'node:path';
import {
  spawn as spawnPty,
  type IPty,
  type IPtyForkOptions,
  type IWindowsPtyForkOptions,
} from 'node-pty';
import { TERMINAL_SHELL_UNAVAILABLE_PREFIX } from '@canopy/protocol/terminal';
import {
  IPC_CHANNELS,
  TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL,
  TERMINAL_WORKTREE_CLEANUP_SIGNAL,
  type PersistedTerminalEntry,
  type TerminalAttachResponse,
  type TerminalExitEvent,
  type TerminalOutputEvent,
  type TerminalRunningChangedEvent,
  type TerminalSession,
  type ManagedTerminalCommand,
  type TerminalShellProfile,
  type TerminalShellProfileId,
} from '@canopy/desktop-shared/types';
import {
  getEnhancedEnv,
  isLinuxLoginShellPathSupported as isLinuxX64,
  resolveLinuxAccountShell,
} from '@canopy/desktop-shared/pipelines/config-paths';
import { findExecutableOnPath } from '@canopy/desktop-shared/node/lib/path-lookup';
import { startWindowsProcessTreeKill } from '@canopy/desktop-shared/node/lib/process-kill';
import { resolveWindowsGitBash } from '../lib/windows-git-bash';
import { isPathInside } from '../lib/path-safety';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { lowerSpawnedProcessPriority } from '../lib/background-process';
import {
  getResourceMonitorService,
  type ResourceRegistrationHandle,
} from '../resource-monitor';
import { buildWorktreeDataEnv } from '../lib/worktree-data-env';
import { assertWorkspaceTargetRuntimeStartAllowed } from '../lib/workspace-target-exclusion';
import { sanitizeManagedBaseEnv } from './managed-terminal-env';
import { terminalPersistenceStore } from './persistence';
import {
  computeTerminalRunningState,
  isTerminalTypeProcessName,
  TerminalRunningDetector,
  type RunningDetectorStore,
  type RunningDetectorTerminalSnapshot,
} from './running-detector';

export const TERMINAL_REPLAY_BUFFER_MAX_BYTES = 256 * 1024;
export const TERMINAL_INITIAL_ATTACH_REPLAY_MAX_BYTES = 1024 * 1024;
export const TERMINAL_FLUSH_THRESHOLD_BYTES = 8 * 1024;
export const TERMINAL_MAX_UNFLUSHED_BYTES = 2 * 1024 * 1024;
export const TERMINAL_USER_INTERRUPT_SUPPRESS_MS = 5000;
export const WINDOWS_RUNNING_PROCESS_PROBE_INTERVAL_MS = 1000;
export const TERMINAL_KILL_EXIT_GRACE_MS = 2000;
const DEFAULT_MAX_LIVE_TERMINALS = 128;
const WINDOWS_RUNNING_PROCESS_PROBE_TIMEOUT_MS = 1000;
const DEFAULT_LANG = 'en_US.UTF-8';
const INITIAL_COMMAND_SUPPRESSION_MAX_BYTES = 64 * 1024;
const INITIAL_COMMAND_READY_DEBOUNCE_MS = 100;
const INITIAL_COMMAND_FALLBACK_MS = 1000;
const TRUNCATION_MARKER = '\r\n\x1b[33m[output truncated]\x1b[0m\r\n';
const RESTORE_MARKER = '[Terminal restarted]';
const CTRL_C = '\x03';
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);
const WINDOWS_TERMINAL_HOST_PROCESS_NAMES = [
  'conhost',
  'openconsole',
  'winpty',
  'winpty-agent',
] as const;

interface PtyInputSocket {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

function getPtyInputSocket(pty: IPty): PtyInputSocket | undefined {
  if (!('_agent' in pty)) return undefined;
  const agent = pty._agent;
  if (typeof agent !== 'object' || agent === null || !('inSocket' in agent)) {
    return undefined;
  }
  const input = agent.inSocket;
  if (
    typeof input !== 'object' ||
    input === null ||
    !('on' in input) ||
    typeof input.on !== 'function'
  ) {
    return undefined;
  }
  const on = input.on;
  return {
    on: (event, listener): unknown =>
      Reflect.apply(on, input, [event, listener]),
  };
}

function getErrnoDetail(
  error: Error,
  key: 'code' | 'syscall',
): string | undefined {
  if (key === 'code') {
    return 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  }
  return 'syscall' in error && typeof error.syscall === 'string'
    ? error.syscall
    : undefined;
}
const WINDOWS_CMD_BUILTIN_COMMANDS = new Set([
  'assoc',
  'break',
  'call',
  'cd',
  'chdir',
  'cls',
  'color',
  'copy',
  'date',
  'del',
  'dir',
  'echo',
  'endlocal',
  'erase',
  'exit',
  'for',
  'ftype',
  'goto',
  'if',
  'md',
  'mkdir',
  'move',
  'path',
  'pause',
  'popd',
  'prompt',
  'pushd',
  'rd',
  'rem',
  'ren',
  'rename',
  'rmdir',
  'set',
  'setlocal',
  'shift',
  'start',
  'time',
  'title',
  'type',
  'ver',
  'verify',
  'vol',
]);
const WINDOWS_POWERSHELL_BUILTIN_COMMANDS = new Set([
  'cd',
  'clear',
  'cls',
  'copy',
  'del',
  'dir',
  'echo',
  'erase',
  'exit',
  'get-childitem',
  'get-location',
  'ls',
  'move',
  'popd',
  'pushd',
  'pwd',
  'rm',
  'set-location',
  'sleep',
  'start-sleep',
  'type',
]);
const WINDOWS_BASH_BUILTIN_COMMANDS = new Set([
  'alias',
  'bg',
  'cd',
  'echo',
  'eval',
  'exec',
  'exit',
  'export',
  'fg',
  'hash',
  'help',
  'history',
  'jobs',
  'popd',
  'pushd',
  'pwd',
  'read',
  'set',
  'shift',
  'source',
  'test',
  'trap',
  'type',
  'unalias',
  'unset',
]);

class TerminalUnsupportedPlatformError extends Error {
  public readonly code = 'ERR_TERMINAL_UNSUPPORTED_PLATFORM';

  public constructor(platform: NodeJS.Platform) {
    super(
      `ERR_TERMINAL_UNSUPPORTED_PLATFORM: Terminal unavailable on platform: ${platform}`,
    );
    this.name = 'TerminalUnsupportedPlatformError';
  }
}

/**
 * Claims a PTY's process tree in the resource monitor so a shell and the
 * commands run in it are not counted as processes the app itself runs.
 */
function registerTerminalResource(
  session: TerminalSession,
  pid: number,
): ResourceRegistrationHandle | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const claude =
    session.kind === 'claude-code' || session.kind === 'claude-worker';
  return getResourceMonitorService().registerProcess({
    id: `terminal:${session.id}`,
    groupId: claude ? 'claude' : 'terminal',
    kind: claude ? 'chat-provider' : 'terminal',
    label: session.title ?? session.shellBasename,
    pid,
    processGroupId: pid,
    metadata: { type: 'generic' },
  });
}

interface TerminalRecord {
  archiveDrain?: Promise<void>;
  session: TerminalSession;
  pty: IPty;
  dataDisposable: { dispose(): void } | null;
  exitDisposable: { dispose(): void } | null;
  resourceHandle?: ResourceRegistrationHandle;
  forcedExitTimer: NodeJS.Timeout | null;
  seq: number;
  queue: Buffer[];
  queuedBytes: number;
  flushScheduled: boolean;
  replayBuffer: Buffer;
  initialCommandSuppression: {
    value: string;
    buffered: Buffer;
    sent: boolean;
    sendTimer: NodeJS.Timeout | null;
  } | null;
  /**
   * One-shot full replay returned on the first attach after lazy restore so
   * persisted history is not clipped to the rolling live replay cap.
   */
  initialAttachReplayChunks: Buffer[] | null;
  initialAttachReplayBytes: number;
  running: boolean;
  /** Last-emitted foreground process name; `null` when the shell is in the foreground. */
  lastProcessName: string | null;
  lastWindowsProcessProbeAt: number;
  lastWindowsDescendantProcessName: string | null;
  windowsProcessProbeInFlight: boolean;
  windowsShellCommandActive: boolean;
  windowsActiveCommandName: string | null;
  windowsPendingInputLine: string;
  windowsPromptTail: string;
  exited: boolean;
  pendingExitSignalOverride: string | null;
  pendingUserInterruptAt: number | null;
  pendingUserInterruptProcessName: string | null;
}

interface CreateTerminalRecordOptions {
  projectId: string;
  worktreeId: string;
  cols: number;
  rows: number;
  terminalId?: string;
  selectedRepoId?: string;
  cwd?: string;
  managedCommand?: ManagedTerminalCommand;
  terminalProfileId?: TerminalShellProfileId;
  initialCommand?: string;
  restoredShell?: ResolvedTerminalShell;
  environmentOverride?: NodeJS.ProcessEnv;
}

type TerminalEventPayload =
  | TerminalSession
  | TerminalOutputEvent
  | TerminalExitEvent
  | TerminalRunningChangedEvent;

type TerminalEventChannel =
  | typeof IPC_CHANNELS.terminalSpawned
  | typeof IPC_CHANNELS.terminalOutput
  | typeof IPC_CHANNELS.terminalExit
  | typeof IPC_CHANNELS.terminalRunningChanged;

type TerminalEventSender = (
  channel: TerminalEventChannel,
  payload: TerminalEventPayload,
) => void;

export type { TerminalEventChannel, TerminalEventPayload };

export type TerminalEventListener = TerminalEventSender;

interface PtyManagerOptions {
  createTerminalId?: () => string;
  now?: () => number;
  ptySpawn?: typeof spawnPty;
  resolveWorktreeCwdFn?: typeof resolveWorktreeCwd;
  buildWorktreeDataEnvFn?: typeof buildWorktreeDataEnv;
  getEnhancedEnvFn?: typeof getEnhancedEnv;
  runningDetector?: RunningDetectorController;
  persistenceStore?: TerminalPersistenceController;
  maxLiveTerminals?: number;
  killExitGraceMs?: number;
}

interface RunningDetectorController {
  syncLifecycle(): void;
}

interface TerminalPersistenceController {
  registerLiveSession(session: TerminalSession): void;
  appendTerminalOutput(
    projectId: string,
    worktreeId: string,
    terminalId: string,
    chunk: Buffer,
  ): void;
  markTerminalExited(
    projectId: string,
    worktreeId: string,
    terminalId: string,
    exitCode: number | null,
    signal: string | null,
  ): void;
  getPersistedTerminalEntry(terminalId: string): PersistedTerminalEntry | null;
}

function getCurrentTime(): number {
  return Date.now();
}

function isSupportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

function cloneBytes(buffer: Buffer): Uint8Array {
  return Uint8Array.from(buffer);
}

function appendReplayChunk(existing: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= TERMINAL_REPLAY_BUFFER_MAX_BYTES) {
    return chunk.subarray(
      chunk.length - TERMINAL_REPLAY_BUFFER_MAX_BYTES,
      chunk.length,
    );
  }

  const combined = Buffer.concat([existing, chunk]);
  if (combined.length <= TERMINAL_REPLAY_BUFFER_MAX_BYTES) {
    return combined;
  }

  return combined.subarray(
    combined.length - TERMINAL_REPLAY_BUFFER_MAX_BYTES,
    combined.length,
  );
}

function normalizeSignal(signal: number | undefined): string | null {
  if (typeof signal !== 'number' || signal === 0) {
    return null;
  }

  return `${signal}`;
}

function isRestorableExitSignal(signal: string | null): boolean {
  return (
    signal === null ||
    signal === '0' ||
    signal === 'app-quit' ||
    signal === 'fatal-exit' ||
    signal === 'pipe-error'
  );
}

function buildRestoreMarker(hasReplay: boolean): Buffer {
  const prefix = hasReplay ? '\r\n' : '';
  return Buffer.from(`${prefix}\x1b[2m${RESTORE_MARKER}\x1b[0m\r\n`, 'utf8');
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value);
}

function prependPathEntries(
  env: Record<string, string | undefined>,
  entries: string[] | undefined,
): Record<string, string | undefined> {
  if (!entries || entries.length === 0) {
    return env;
  }
  return {
    ...env,
    PATH: [...entries, env.PATH].filter(Boolean).join(path.delimiter),
  };
}

function buildPtySpawnOptions(options: {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
}): IPtyForkOptions | IWindowsPtyForkOptions {
  const baseOptions: IPtyForkOptions | IWindowsPtyForkOptions = {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
  };

  if (process.platform !== 'win32') {
    return baseOptions;
  }

  return {
    ...baseOptions,
    useConpty: true,
  };
}

interface ResolvedTerminalShell {
  shell: string;
  args: string[];
  shellBasename: string;
}

function existingFile(candidate: string | null | undefined): string | null {
  if (!candidate) {
    return null;
  }
  try {
    const stat = existsSync(candidate);
    return stat ? candidate : null;
  } catch {
    return null;
  }
}

function firstExistingFile(
  candidates: Array<string | null | undefined>,
): string | null {
  for (const candidate of candidates) {
    const existing = existingFile(candidate);
    if (existing !== null) {
      return existing;
    }
  }
  return null;
}

function terminalShellBasename(filePath: string): string {
  return process.platform === 'win32'
    ? path.win32.basename(filePath)
    : basename(filePath);
}

function buildInitialCommandSubmission(
  command: string,
  shellBasename: string,
): string {
  const normalizedShell = shellBasename.toLowerCase().replace(/\.exe$/, '');
  if (normalizedShell === 'cmd') {
    return `${command} & exit`;
  }
  if (normalizedShell === 'powershell' || normalizedShell === 'pwsh') {
    const quotedCommand = command.replace(/'/g, "''");
    return `& ([scriptblock]::Create('${quotedCommand}')); exit`;
  }
  const quotedCommand = command.replace(/'/g, `'"'"'`);
  return `eval -- '${quotedCommand}'; exit`;
}

function normalizeWindowsProcessName(value: string): string {
  return path.win32
    .basename(value.trim())
    .toLowerCase()
    .replace(/\.exe$/, '');
}

function windowsOutputEndsWithPrompt(output: string): boolean {
  const normalized = output.replace(ANSI_ESCAPE_PATTERN, '');
  return /(?:^|\r?\n)\s*(?:PS\s+[^\r\n>]+>|[A-Za-z]:\\[^\r\n>]*>|\\\\[^\r\n>]+>|[^\r\n]*[$#] +)\s*$/.test(
    normalized,
  );
}

function firstCommandToken(commandLine: string): string | null {
  const trimmed = commandLine.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const match = /^(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function stripWindowsExecutableExtension(commandName: string): string {
  return commandName.replace(/\.(?:cmd|bat|com|exe)$/i, '');
}

function windowsCommandFallbackName(
  commandLine: string,
  shellBasename: string,
): string {
  let remainingCommandLine = commandLine.trim();
  let token = firstCommandToken(remainingCommandLine);
  while (token && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
    remainingCommandLine = remainingCommandLine
      .slice(remainingCommandLine.indexOf(token) + token.length)
      .trimStart();
    token = firstCommandToken(remainingCommandLine);
  }
  if (token === null) {
    return 'command';
  }

  const normalizedShell = normalizeWindowsProcessName(shellBasename);
  const basenameToken = path.win32.basename(path.posix.basename(token));
  const commandName = stripWindowsExecutableExtension(basenameToken);
  const normalizedCommand = commandName.toLowerCase();

  if (
    (normalizedShell === 'cmd' &&
      WINDOWS_CMD_BUILTIN_COMMANDS.has(normalizedCommand)) ||
    ((normalizedShell === 'powershell' || normalizedShell === 'pwsh') &&
      WINDOWS_POWERSHELL_BUILTIN_COMMANDS.has(normalizedCommand)) ||
    (normalizedShell === 'bash' &&
      WINDOWS_BASH_BUILTIN_COMMANDS.has(normalizedCommand))
  ) {
    return 'command';
  }

  if (/\.(?:cmd|bat|com|exe)$/i.test(basenameToken)) {
    return basenameToken;
  }
  return `${commandName}.exe`;
}

function resolveWindowsPowerShell(): string | null {
  return (
    findExecutableOnPath('pwsh.exe') ??
    findExecutableOnPath('powershell.exe') ??
    firstExistingFile([
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ])
  );
}

function buildWindowsForegroundProcessScript(rootPid: number): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$emitted = @{}',
    'function Emit-ProcessName([int]$processId) {',
    '  if ($processId -eq $PID -or $emitted.ContainsKey($processId)) { return }',
    '  $emitted[$processId] = $true',
    '  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"',
    '  if ($process -and $process.Name) { [string]$process.Name }',
    '}',
    'try {',
    '  $kernel32 = \'using System; using System.Runtime.InteropServices; public static class CanopyConsoleProcesses { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId); [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole(); [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList(uint[] processList, uint processCount); }\'',
    '  Add-Type -ErrorAction SilentlyContinue -TypeDefinition $kernel32',
    '  [CanopyConsoleProcesses]::FreeConsole() | Out-Null',
    `  if ([CanopyConsoleProcesses]::AttachConsole(${rootPid})) {`,
    '    $processIds = New-Object uint[] 256',
    '    $count = [CanopyConsoleProcesses]::GetConsoleProcessList($processIds, $processIds.Length)',
    '    [CanopyConsoleProcesses]::FreeConsole() | Out-Null',
    '    for ($index = 0; $index -lt $count -and $index -lt $processIds.Length; $index++) {',
    '      Emit-ProcessName ([int]$processIds[$index])',
    '    }',
    '  }',
    '} catch {',
    '  try { [CanopyConsoleProcesses]::FreeConsole() | Out-Null } catch {}',
    '}',
    '$queue = New-Object "System.Collections.Generic.Queue[int]"',
    `$queue.Enqueue(${rootPid})`,
    '$seen = @{}',
    'while ($queue.Count -gt 0) {',
    '  $parentPid = $queue.Dequeue()',
    '  Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentPid" | ForEach-Object {',
    '    $childPid = [int]$_.ProcessId',
    '    if (-not $seen.ContainsKey($childPid)) {',
    '      $seen[$childPid] = $true',
    '      $queue.Enqueue($childPid)',
    '      Emit-ProcessName $childPid',
    '    }',
    '  }',
    '}',
  ].join('; ');
}

function foregroundProcessNameFromWindowsProbeOutput(
  stdout: string,
  shellBasename: string,
): string | null {
  const shellProcessName = normalizeWindowsProcessName(shellBasename);
  const excludedProcessNames = new Set([
    shellProcessName,
    ...WINDOWS_TERMINAL_HOST_PROCESS_NAMES,
  ]);
  const candidates = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const normalized = normalizeWindowsProcessName(candidate);
    if (excludedProcessNames.has(normalized)) {
      continue;
    }
    return candidate;
  }

  return null;
}

function resolveWindowsForegroundProcessName(
  rootPid: number,
  shellBasename: string,
): Promise<string | null> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return Promise.resolve(null);
  }

  const powershell = resolveWindowsPowerShell() ?? 'powershell.exe';
  const script = buildWindowsForegroundProcessScript(rootPid);

  return new Promise((resolve) => {
    try {
      execFile(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          timeout: WINDOWS_RUNNING_PROCESS_PROBE_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error || typeof stdout !== 'string') {
            resolve(null);
            return;
          }

          resolve(
            foregroundProcessNameFromWindowsProbeOutput(stdout, shellBasename),
          );
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function resolveWindowsCommandPrompt(): string {
  const comSpec = process.env.ComSpec?.trim();
  return comSpec && comSpec.length > 0
    ? comSpec
    : 'C:\\Windows\\System32\\cmd.exe';
}

const LINUX_ACCOUNT_SHELL_TTL_MS = 5 * 60_000;
// Shells qualified for `-l` login startup. Anything else (nologin, tcsh, …)
// is not launched as the Default until it has been qualified.
const LINUX_SUPPORTED_DEFAULT_SHELLS = new Set(['bash', 'zsh', 'fish']);

let linuxAccountShellCache: { shell: string | undefined; at: number } | null =
  null;
let linuxAccountShellRefresh: Promise<void> | null = null;
let linuxAccountShellGeneration = 0;

function unavailableShellError(sentence: string): Error {
  return new Error(`${TERMINAL_SHELL_UNAVAILABLE_PREFIX}${sentence}`);
}

/** Why a Linux shell path cannot be launched, or null when it can. */
function linuxShellFailure(shell: string): string | null {
  if (!path.posix.isAbsolute(shell) || /[\0\r\n]/.test(shell)) {
    return 'is not an absolute path';
  }
  try {
    if (!statSync(shell).isFile()) return 'is not a file';
    accessSync(shell, constants.X_OK);
    return null;
  } catch (error) {
    const code = error instanceof Error ? getErrnoDetail(error, 'code') : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'was not found';
    return 'is not executable by this user';
  }
}

function isUsableLinuxDefaultShell(
  candidate: string | undefined,
): candidate is string {
  return (
    candidate !== undefined &&
    LINUX_SUPPORTED_DEFAULT_SHELLS.has(basename(candidate)) &&
    linuxShellFailure(candidate) === null
  );
}

function refreshLinuxAccountShell(): Promise<void> {
  if (linuxAccountShellRefresh !== null) return linuxAccountShellRefresh;
  // A reset bumps the generation: a lookup that finishes afterwards neither
  // writes the cache nor clears its successor's in-flight slot.
  const generation = linuxAccountShellGeneration;
  const refresh: Promise<void> = resolveLinuxAccountShell()
    .then((shell): void => {
      if (generation === linuxAccountShellGeneration) {
        linuxAccountShellCache = { shell, at: Date.now() };
      }
    })
    .finally((): void => {
      if (linuxAccountShellRefresh === refresh) linuxAccountShellRefresh = null;
    });
  linuxAccountShellRefresh = refresh;
  return refresh;
}

/**
 * Cache-only read of the account's login shell: it never blocks. An absent or
 * expired entry starts one background bounded `getent` lookup (the same one the
 * login-shell PATH uses); the previous value, even a stale or failed one, is
 * returned meanwhile. Entry points that choose a user default await
 * {@link prewarmLinuxTerminalShell} first so this is warm when they spawn.
 */
function cachedLinuxAccountShell(): string | undefined {
  if (
    linuxAccountShellCache === null ||
    Date.now() - linuxAccountShellCache.at >= LINUX_ACCOUNT_SHELL_TTL_MS
  ) {
    void refreshLinuxAccountShell();
  }
  return linuxAccountShellCache?.shell;
}

/**
 * Warm the account-shell cache before a Default terminal is chosen. A no-op off
 * Linux x64 and when `$SHELL` already names a usable shell. Never rejects.
 */
export async function prewarmLinuxTerminalShell(): Promise<void> {
  if (!isLinuxX64() || isUsableLinuxDefaultShell(process.env.SHELL?.trim())) {
    return;
  }
  if (
    linuxAccountShellCache !== null &&
    Date.now() - linuxAccountShellCache.at < LINUX_ACCOUNT_SHELL_TTL_MS
  ) {
    return;
  }
  await refreshLinuxAccountShell();
}

/** @internal — exposed for testing only */
export function resetLinuxTerminalShellLookupForTests(): void {
  linuxAccountShellGeneration += 1;
  linuxAccountShellCache = null;
  linuxAccountShellRefresh = null;
}

interface LinuxShellLookup {
  shell: string | null;
  /** First candidate that exists but cannot be launched, with its reason. */
  problem: string | null;
}

function findLinuxShell(name: 'bash' | 'zsh'): LinuxShellLookup {
  const candidates = [
    `/bin/${name}`,
    `/usr/bin/${name}`,
    findExecutableOnPath(name),
  ];
  let problem: string | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const failure = linuxShellFailure(candidate);
    if (failure === null) return { shell: candidate, problem: null };
    if (problem === null && failure !== 'was not found') {
      problem = `${candidate} ${failure}`;
    }
  }
  return { shell: null, problem };
}

function resolveLinuxDefaultShellPath(): string | null {
  const configured = process.env.SHELL?.trim();
  if (isUsableLinuxDefaultShell(configured)) return configured;
  const account = cachedLinuxAccountShell();
  if (isUsableLinuxDefaultShell(account)) return account;
  return findLinuxShell('bash').shell;
}

function resolveDefaultTerminalShell(): ResolvedTerminalShell {
  if (process.platform === 'win32') {
    const shell = resolveWindowsPowerShell() ?? resolveWindowsCommandPrompt();
    return {
      shell,
      args: shell.toLowerCase().endsWith('cmd.exe') ? [] : ['-NoLogo'],
      shellBasename: terminalShellBasename(shell),
    };
  }

  if (isLinuxX64()) {
    const shell = resolveLinuxDefaultShellPath();
    if (shell === null) {
      throw unavailableShellError(
        "No usable shell was found and Bash isn't installed. Install Bash and try again.",
      );
    }
    return { shell, args: ['-l'], shellBasename: terminalShellBasename(shell) };
  }

  const shell =
    process.env.SHELL ??
    (process.platform === 'linux' ? '/bin/bash' : '/bin/zsh');
  return { shell, args: ['-l'], shellBasename: terminalShellBasename(shell) };
}

function resolvePersistedTerminalShell(
  session: TerminalSession,
): ResolvedTerminalShell {
  const shellBasename =
    session.shellBasename || terminalShellBasename(session.shell);
  if (process.platform === 'win32') {
    const normalizedShell = session.shell.toLowerCase();
    if (normalizedShell.endsWith('cmd.exe')) {
      return { shell: session.shell, args: [], shellBasename };
    }
    if (normalizedShell.endsWith('bash.exe')) {
      return { shell: session.shell, args: ['--login'], shellBasename };
    }
    return { shell: session.shell, args: ['-NoLogo'], shellBasename };
  }

  if (isLinuxX64()) {
    // Restart/restore keeps the shell the terminal was launched with; a shell
    // that has since been removed is reported, never swapped for another.
    const failure = linuxShellFailure(session.shell);
    if (failure !== null) {
      throw unavailableShellError(
        `This terminal's shell ${session.shell} ${failure}. Open a new terminal to choose another shell.`,
      );
    }
  }

  return { shell: session.shell, args: ['-l'], shellBasename };
}

function requireLinuxProfileShell(name: 'bash' | 'zsh'): ResolvedTerminalShell {
  const { shell, problem } = findLinuxShell(name);
  if (shell === null) {
    throw unavailableShellError(
      `${name} can't start: ${problem ?? "it isn't installed on this computer"}. Choose another shell and try again.`,
    );
  }
  return { shell, args: ['-l'], shellBasename: terminalShellBasename(shell) };
}

function resolveTerminalShellProfile(
  profileId: TerminalShellProfileId | undefined,
): ResolvedTerminalShell {
  if (profileId === undefined || profileId === 'default') {
    return resolveDefaultTerminalShell();
  }

  if (process.platform === 'win32') {
    if (profileId === 'cmd') {
      const shell = resolveWindowsCommandPrompt();
      return { shell, args: [], shellBasename: terminalShellBasename(shell) };
    }
    if (profileId === 'powershell') {
      const shell = resolveWindowsPowerShell();
      if (shell === null) {
        throw new Error('PowerShell is not available on this Windows machine.');
      }
      return {
        shell,
        args: shell.toLowerCase().endsWith('cmd.exe') ? [] : ['-NoLogo'],
        shellBasename: terminalShellBasename(shell),
      };
    }
    if (profileId === 'git-bash') {
      const shell = resolveWindowsGitBash();
      if (shell === null) {
        throw new Error('Git Bash is not available on this Windows machine.');
      }
      return {
        shell,
        args: ['--login'],
        shellBasename: terminalShellBasename(shell),
      };
    }
  }

  if (isLinuxX64() && (profileId === 'zsh' || profileId === 'bash')) {
    return requireLinuxProfileShell(profileId);
  }
  if (profileId === 'zsh') {
    const shell = firstExistingFile(['/bin/zsh', findExecutableOnPath('zsh')]);
    if (shell === null) {
      throw new Error('zsh is not available on this machine.');
    }
    return { shell, args: ['-l'], shellBasename: terminalShellBasename(shell) };
  }
  if (profileId === 'bash') {
    const shell = firstExistingFile([
      '/bin/bash',
      findExecutableOnPath('bash'),
    ]);
    if (shell === null) {
      throw new Error('bash is not available on this machine.');
    }
    return { shell, args: ['-l'], shellBasename: terminalShellBasename(shell) };
  }

  throw new Error(`Unsupported terminal profile: ${profileId}`);
}

function listLinuxTerminalProfiles(): TerminalShellProfile[] {
  const defaultShellPath = resolveLinuxDefaultShellPath();
  const defaultShellBasename =
    defaultShellPath === null ? '' : basename(defaultShellPath);
  const profiles: TerminalShellProfile[] = [];
  if (findLinuxShell('zsh').shell !== null) {
    profiles.push({
      id: 'zsh',
      label: 'zsh',
      isDefault: defaultShellBasename === 'zsh',
    });
  }
  if (findLinuxShell('bash').shell !== null) {
    profiles.push({
      id: 'bash',
      label: 'bash',
      isDefault: defaultShellBasename === 'bash',
    });
  }
  if (defaultShellPath !== null && !profiles.some((p) => p.isDefault)) {
    profiles.unshift({
      id: 'default',
      label: defaultShellBasename,
      isDefault: true,
    });
  }
  return markExactlyOneDefaultProfile(profiles);
}

/** Actual default shell used to render reviewed terminal command arguments. */
export function getDefaultTerminalShellBasename(): string {
  return resolveTerminalShellProfile(undefined).shellBasename;
}

export function listAvailableTerminalProfiles(): TerminalShellProfile[] {
  if (isLinuxX64()) {
    return listLinuxTerminalProfiles();
  }
  const defaultShell = resolveDefaultTerminalShell();
  const defaultShellBasename = terminalShellBasename(defaultShell.shell);
  if (process.platform === 'win32') {
    const profiles: TerminalShellProfile[] = [
      {
        id: 'cmd',
        label: 'Command Prompt',
        isDefault: defaultShell.shell.toLowerCase().endsWith('cmd.exe'),
      },
      {
        id: 'powershell',
        label: 'PowerShell',
        isDefault:
          defaultShell.shell.toLowerCase().endsWith('powershell.exe') ||
          defaultShell.shell.toLowerCase().endsWith('pwsh.exe'),
      },
    ];
    if (resolveWindowsGitBash() !== null) {
      profiles.push({
        id: 'git-bash',
        label: 'Git Bash',
        isDefault: false,
      });
    }
    return markExactlyOneDefaultProfile(profiles);
  }

  const profiles: TerminalShellProfile[] = [];
  const zsh = firstExistingFile(['/bin/zsh', findExecutableOnPath('zsh')]);
  if (zsh !== null) {
    profiles.push({
      id: 'zsh',
      label: 'zsh',
      isDefault: defaultShellBasename === 'zsh',
    });
  }
  const bash = firstExistingFile(['/bin/bash', findExecutableOnPath('bash')]);
  if (bash !== null) {
    profiles.push({
      id: 'bash',
      label: 'bash',
      isDefault: defaultShellBasename === 'bash',
    });
  }
  if (!profiles.some((profile) => profile.isDefault)) {
    profiles.unshift({
      id: 'default',
      label: defaultShellBasename || 'Default',
      isDefault: true,
    });
  }
  return markExactlyOneDefaultProfile(profiles);
}

function markExactlyOneDefaultProfile(
  profiles: TerminalShellProfile[],
): TerminalShellProfile[] {
  const defaultIndex = profiles.findIndex((profile) => profile.isDefault);
  const selectedDefaultIndex = defaultIndex >= 0 ? defaultIndex : 0;
  if (selectedDefaultIndex < 0) {
    return profiles;
  }
  return profiles.map((profile, index) => ({
    ...profile,
    isDefault: index === selectedDefaultIndex,
  }));
}

function attachResponseFromPersistedEntry(
  entry: PersistedTerminalEntry,
): TerminalAttachResponse {
  const replayText = entry.scrollbackLines.join('\n');
  const replayBuffer = Buffer.from(replayText, 'utf8');
  return {
    session: entry.session,
    replay: cloneBytes(replayBuffer),
    seq: Buffer.byteLength(replayText, 'utf8'),
  };
}

function clampInitialAttachReplay(record: TerminalRecord): void {
  if (
    record.initialAttachReplayChunks === null ||
    record.initialAttachReplayBytes <= TERMINAL_INITIAL_ATTACH_REPLAY_MAX_BYTES
  ) {
    return;
  }

  const marker = Buffer.from(TRUNCATION_MARKER, 'utf8');
  const combined = Buffer.concat(
    record.initialAttachReplayChunks,
    record.initialAttachReplayBytes,
  );
  const tailMaxBytes = Math.max(
    0,
    TERMINAL_INITIAL_ATTACH_REPLAY_MAX_BYTES - marker.length,
  );
  const tailSource =
    combined.length > tailMaxBytes
      ? combined.subarray(combined.length - tailMaxBytes)
      : combined;
  const tail = Buffer.from(tailSource);
  record.initialAttachReplayChunks = [marker, tail];
  record.initialAttachReplayBytes = marker.length + tail.length;
}

function appendInitialAttachChunk(record: TerminalRecord, chunk: Buffer): void {
  if (record.initialAttachReplayChunks === null) {
    return;
  }

  record.initialAttachReplayChunks.push(chunk);
  record.initialAttachReplayBytes += chunk.length;
  clampInitialAttachReplay(record);
}

function tryKillPid(pid: number): boolean {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function forceKillPtyProcessTree(pty: IPty): void {
  if (Number.isInteger(pty.pid) && pty.pid > 0) {
    if (process.platform === 'win32') {
      // The PTY can already be gone after taskkill fails; cleanup is best effort.
      startWindowsProcessTreeKill(pty.pid, true, () => pty.kill());
      return;
    }

    if (tryKillPid(-pty.pid)) {
      return;
    }
    if (tryKillPid(pty.pid)) {
      return;
    }
  }

  try {
    pty.kill();
  } catch {
    // The PTY can already be gone; cleanup is best effort.
  }
}

function destroyPtyIfAvailable(pty: IPty): void {
  if (!('destroy' in pty)) {
    return;
  }
  const destroy = pty.destroy;
  if (typeof destroy !== 'function') {
    return;
  }
  try {
    destroy.call(pty);
  } catch {
    // Best effort: node-pty may already have torn down its streams.
  }
}

class TerminalCapacityError extends Error {
  public readonly code = 'ERR_TERMINAL_CAPACITY';

  public constructor(limit: number) {
    super(
      `ERR_TERMINAL_CAPACITY: Refusing to spawn more than ${limit} live terminals.`,
    );
    this.name = 'TerminalCapacityError';
  }
}

export class PtyManager implements RunningDetectorStore {
  private readonly records = new Map<string, TerminalRecord>();

  private readonly createTerminalId: () => string;

  private readonly now: () => number;

  private readonly ptySpawn: typeof spawnPty;

  private readonly resolveWorktreeCwdFn: typeof resolveWorktreeCwd;

  private readonly buildWorktreeDataEnvFn: typeof buildWorktreeDataEnv;

  private readonly getEnhancedEnvFn: typeof getEnhancedEnv;

  private readonly runningDetector: RunningDetectorController;

  private readonly persistenceStore: TerminalPersistenceController;

  private readonly maxLiveTerminals: number;

  private readonly killExitGraceMs: number;

  private eventSender: TerminalEventSender = (): void => {};

  private readonly eventListeners = new Set<TerminalEventListener>();

  public constructor(options: PtyManagerOptions = {}) {
    this.createTerminalId = options.createTerminalId ?? randomUUID;
    this.now = options.now ?? getCurrentTime;
    this.ptySpawn = options.ptySpawn ?? spawnPty;
    this.resolveWorktreeCwdFn =
      options.resolveWorktreeCwdFn ?? resolveWorktreeCwd;
    this.buildWorktreeDataEnvFn =
      options.buildWorktreeDataEnvFn ?? buildWorktreeDataEnv;
    this.getEnhancedEnvFn = options.getEnhancedEnvFn ?? getEnhancedEnv;
    this.runningDetector =
      options.runningDetector ?? new TerminalRunningDetector({ store: this });
    this.persistenceStore =
      options.persistenceStore ?? terminalPersistenceStore;
    this.maxLiveTerminals =
      options.maxLiveTerminals ?? DEFAULT_MAX_LIVE_TERMINALS;
    this.killExitGraceMs =
      options.killExitGraceMs ?? TERMINAL_KILL_EXIT_GRACE_MS;
  }

  public setEventSender(sender: TerminalEventSender): void {
    this.eventSender = sender;
  }

  public addEventListener(listener: TerminalEventListener): () => void {
    this.eventListeners.add(listener);
    let subscribed = true;
    return (): void => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.eventListeners.delete(listener);
    };
  }

  private emitEvent(
    channel: TerminalEventChannel,
    payload: TerminalEventPayload,
  ): void {
    this.eventSender(channel, payload);
    this.eventListeners.forEach((listener) => {
      listener(channel, payload);
    });
  }

  private resolveRestoredCwd(
    projectId: string,
    worktreeId: string,
    persistedCwd: string,
  ): string {
    const fallbackCwd = this.resolveWorktreeCwdFn(projectId, worktreeId);
    if (!isAbsolutePath(persistedCwd)) {
      return fallbackCwd;
    }
    if (!isPathInside(fallbackCwd, persistedCwd)) {
      return fallbackCwd;
    }
    if (!existsSync(persistedCwd)) {
      return fallbackCwd;
    }
    return persistedCwd;
  }

  private createRecord(options: CreateTerminalRecordOptions): TerminalRecord {
    if (!isSupportedPlatform(process.platform)) {
      throw new TerminalUnsupportedPlatformError(process.platform);
    }

    const { projectId, worktreeId, cols, rows, terminalId, selectedRepoId } =
      options;
    assertWorkspaceTargetRuntimeStartAllowed(projectId, worktreeId);
    const managedCommand = options.managedCommand;
    const resolvedShell = managedCommand
      ? null
      : (options.restoredShell ??
        resolveTerminalShellProfile(options.terminalProfileId));
    const shell = managedCommand?.executable ?? resolvedShell?.shell ?? '';
    const shellArgs = managedCommand?.args ?? resolvedShell?.args ?? [];
    const shellBasename =
      managedCommand !== undefined
        ? basename(shell)
        : (resolvedShell?.shellBasename ?? basename(shell));
    const cwd =
      options.cwd ??
      this.resolveWorktreeCwdFn(projectId, worktreeId, selectedRepoId);
    const mergedEnv = options.environmentOverride ?? {
      ...this.getEnhancedEnvFn({ environment: false }),
      ...this.buildWorktreeDataEnvFn(projectId, worktreeId, undefined, {
        runtime: 'canopy',
      }),
    };
    const processEnv = managedCommand
      ? prependPathEntries(
          sanitizeManagedBaseEnv(mergedEnv),
          managedCommand.pathPrepend,
        )
      : mergedEnv;
    const shellEnv =
      managedCommand === undefined &&
      process.platform === 'darwin' &&
      shellBasename === 'bash'
        ? { BASH_SILENCE_DEPRECATION_WARNING: '1' }
        : {};
    const env = {
      ...processEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG ?? DEFAULT_LANG,
      ...shellEnv,
      ...(managedCommand?.env ?? {}),
    };

    let pty: IPty;
    try {
      pty = this.ptySpawn(
        shell,
        shellArgs,
        buildPtySpawnOptions({ cols, rows, cwd, env }),
      );
    } catch (error) {
      if (!isLinuxX64() || managedCommand) throw error;
      // Name the shell that failed; never retry another one on the user's behalf.
      const detail = error instanceof Error ? error.message : String(error);
      throw unavailableShellError(`${shell} couldn't start: ${detail}`);
    }

    const session: TerminalSession = {
      id: terminalId ?? this.createTerminalId(),
      projectId,
      worktreeId,
      shell,
      shellBasename,
      cwd,
      createdAt: this.now(),
      ...(options.initialCommand
        ? { initialCommand: options.initialCommand }
        : {}),
      ...(managedCommand
        ? {
            kind: managedCommand.kind,
            focusOnSpawn: managedCommand.focusOnSpawn,
            title: managedCommand.title,
            chatId: managedCommand.chatId,
            sessionKey: managedCommand.sessionKey,
          }
        : {}),
    };

    const initialCommandSubmission = options.initialCommand
      ? buildInitialCommandSubmission(options.initialCommand, shellBasename)
      : null;
    const record: TerminalRecord = {
      session,
      pty,
      dataDisposable: null,
      exitDisposable: null,
      forcedExitTimer: null,
      seq: 0,
      queue: [],
      queuedBytes: 0,
      flushScheduled: false,
      replayBuffer: Buffer.alloc(0),
      initialCommandSuppression: initialCommandSubmission
        ? {
            value: initialCommandSubmission,
            buffered: Buffer.alloc(0),
            sent: false,
            sendTimer: null,
          }
        : null,
      initialAttachReplayChunks: null,
      initialAttachReplayBytes: 0,
      running: false,
      lastProcessName: null,
      lastWindowsProcessProbeAt: Number.NEGATIVE_INFINITY,
      lastWindowsDescendantProcessName: null,
      windowsProcessProbeInFlight: false,
      windowsShellCommandActive: false,
      windowsActiveCommandName: null,
      windowsPendingInputLine: '',
      windowsPromptTail: '',
      exited: false,
      pendingExitSignalOverride: null,
      pendingUserInterruptAt: null,
      pendingUserInterruptProcessName: null,
    };

    return record;
  }

  private registerRecord(record: TerminalRecord): TerminalSession {
    const { session, pty } = record;

    if (this.records.size >= this.maxLiveTerminals) {
      forceKillPtyProcessTree(pty);
      destroyPtyIfAvailable(pty);
      throw new TerminalCapacityError(this.maxLiveTerminals);
    }

    this.records.set(session.id, record);

    try {
      record.dataDisposable = pty.onData((data: string): void => {
        this.handlePtyData(session.id, Buffer.from(data, 'utf8'));
      });

      record.exitDisposable = pty.onExit((event): void => {
        this.handlePtyExit(
          session.id,
          event.exitCode,
          normalizeSignal(event.signal),
        );
      });

      // node-pty 1.1.0 exposes onData/onExit for its output socket but leaves
      // the separate Windows input socket without an error listener. Keep this
      // narrowly scoped adapter with the pinned dependency; a public PTY error
      // listener does not receive input-socket EOF/EPIPE events.
      const input = getPtyInputSocket(pty);
      input?.on('error', (error) => {
        if (record.exited || this.records.get(session.id) !== record) return;
        logMainProcessWarn('Terminal input pipe failed', {
          terminalId: session.id,
          code: getErrnoDetail(error, 'code'),
          syscall: getErrnoDetail(error, 'syscall'),
        });
        // Finalize first: killing the PTY can synchronously emit onExit.
        this.handlePtyExit(session.id, null, 'pipe-error');
        forceKillPtyProcessTree(pty);
      });

      this.persistenceStore.registerLiveSession(session);
      record.resourceHandle = registerTerminalResource(session, pty.pid);
      if (session.kind === 'script') {
        this.emitEvent(IPC_CHANNELS.terminalSpawned, session);
      }
      this.runningDetector.syncLifecycle();
    } catch (error) {
      this.records.delete(session.id);
      record.exited = true;
      this.disposeRecordResources(record, { destroyPty: true });
      forceKillPtyProcessTree(pty);
      throw error;
    }

    return session;
  }

  public spawn(
    projectId: string,
    worktreeId: string,
    cols: number,
    rows: number,
    selectedRepoId?: string,
    managedCommand?: ManagedTerminalCommand,
    cwd?: string,
    terminalProfileId?: TerminalShellProfileId,
    initialCommand?: string,
  ): TerminalSession {
    const record = this.createRecord({
      projectId,
      worktreeId,
      cols,
      rows,
      selectedRepoId,
      managedCommand,
      cwd,
      terminalProfileId,
      initialCommand,
    });
    const session = this.registerRecord(record);
    if (initialCommand) {
      this.scheduleInitialCommand(record, INITIAL_COMMAND_FALLBACK_MS);
    }
    return session;
  }

  public spawnWithEnvironment(
    environmentOverride: NodeJS.ProcessEnv,
    projectId: string,
    worktreeId: string,
    cols: number,
    rows: number,
    selectedRepoId?: string,
    managedCommand?: ManagedTerminalCommand,
    cwd?: string,
    terminalProfileId?: TerminalShellProfileId,
    initialCommand?: string,
  ): TerminalSession {
    const record = this.createRecord({
      projectId,
      worktreeId,
      cols,
      rows,
      selectedRepoId,
      managedCommand,
      cwd,
      terminalProfileId,
      initialCommand,
      environmentOverride,
    });
    const session = this.registerRecord(record);
    if (initialCommand) {
      this.scheduleInitialCommand(record, INITIAL_COMMAND_FALLBACK_MS);
    }
    return session;
  }

  /** Lower a live PTY process after spawn when the platform cannot wrap it. */
  public lowerPriority(terminalId: string): void {
    const record = this.records.get(terminalId);
    if (!record || record.exited) return;
    lowerSpawnedProcessPriority(record.pty.pid);
  }

  public restore(
    terminalId: string,
    cols: number,
    rows: number,
    environmentOverride?: NodeJS.ProcessEnv,
  ): TerminalSession {
    const existing = this.records.get(terminalId);
    if (existing && !existing.exited) {
      existing.pty.resize(cols, rows);
      return existing.session;
    }

    const persistedEntry =
      this.persistenceStore.getPersistedTerminalEntry(terminalId);
    if (persistedEntry === null) {
      throw new Error(`Terminal not found: ${terminalId}`);
    }
    const persistedKind = persistedEntry.session.kind ?? 'shell';
    if (
      persistedKind !== 'shell' ||
      !isRestorableExitSignal(persistedEntry.signal)
    ) {
      throw new Error(`Terminal is not restorable: ${terminalId}`);
    }

    const record = this.createRecord({
      projectId: persistedEntry.session.projectId,
      worktreeId: persistedEntry.session.worktreeId,
      cols,
      rows,
      terminalId,
      cwd: this.resolveRestoredCwd(
        persistedEntry.session.projectId,
        persistedEntry.session.worktreeId,
        persistedEntry.session.cwd,
      ),
      restoredShell: resolvePersistedTerminalShell(persistedEntry.session),
      initialCommand: persistedEntry.session.initialCommand,
      environmentOverride,
    });
    const historicalReplay = Buffer.from(
      persistedEntry.scrollbackLines.join('\n'),
      'utf8',
    );
    const restoreMarker = buildRestoreMarker(historicalReplay.length > 0);

    record.initialAttachReplayChunks = [historicalReplay, restoreMarker];
    record.initialAttachReplayBytes =
      historicalReplay.length + restoreMarker.length;
    clampInitialAttachReplay(record);
    record.replayBuffer = appendReplayChunk(
      record.replayBuffer,
      historicalReplay,
    );
    record.replayBuffer = appendReplayChunk(record.replayBuffer, restoreMarker);
    record.seq = record.initialAttachReplayBytes;

    const session = this.registerRecord(record);
    this.persistenceStore.appendTerminalOutput(
      session.projectId,
      session.worktreeId,
      session.id,
      restoreMarker,
    );
    if (persistedEntry.session.initialCommand) {
      this.scheduleInitialCommand(record, INITIAL_COMMAND_FALLBACK_MS);
    }
    return session;
  }

  public attach(terminalId: string): TerminalAttachResponse {
    const record = this.records.get(terminalId);
    if (record) {
      if (record.initialAttachReplayChunks !== null) {
        const replay = Buffer.concat(
          record.initialAttachReplayChunks,
          record.initialAttachReplayBytes,
        );
        const seq = record.initialAttachReplayBytes;
        record.initialAttachReplayChunks = null;
        record.initialAttachReplayBytes = 0;
        return {
          session: record.session,
          replay: cloneBytes(replay),
          seq,
        };
      }

      return {
        session: record.session,
        replay: cloneBytes(record.replayBuffer),
        seq: record.seq,
      };
    }

    const persistedEntry =
      this.persistenceStore.getPersistedTerminalEntry(terminalId);
    if (persistedEntry !== null) {
      return attachResponseFromPersistedEntry(persistedEntry);
    }

    throw new Error(`Terminal not found: ${terminalId}`);
  }

  public getReplayBufferText(terminalId: string): string | null {
    const record = this.records.get(terminalId);
    if (record) {
      return record.replayBuffer.toString('utf8');
    }

    const persistedEntry =
      this.persistenceStore.getPersistedTerminalEntry(terminalId);
    if (persistedEntry !== null) {
      return persistedEntry.scrollbackLines.join('\n');
    }

    return null;
  }

  /** The chat a live managed terminal belongs to, if any. */
  public chatIdOf(terminalId: string): string | undefined {
    return this.records.get(terminalId)?.session.chatId;
  }

  public write(terminalId: string, data: string): void {
    const record = this.records.get(terminalId);
    if (!record || record.exited) {
      return;
    }

    if (record.running && data.includes(CTRL_C)) {
      record.pendingUserInterruptAt = this.now();
      record.pendingUserInterruptProcessName = record.lastProcessName;
    }

    const submittedWindowsCommand =
      process.platform === 'win32'
        ? this.updateWindowsPendingInputLine(record, data)
        : false;
    if (submittedWindowsCommand) {
      this.markWindowsShellCommandActive(record);
    }

    record.pty.write(data);
  }

  public resize(terminalId: string, cols: number, rows: number): void {
    const record = this.records.get(terminalId);
    if (!record || record.exited) {
      return;
    }

    record.pty.resize(cols, rows);
  }

  public kill(
    terminalId: string,
    options: { signalOverride?: string | null } = {},
  ): void {
    const record = this.records.get(terminalId);
    if (!record || record.exited) {
      return;
    }

    if (options.signalOverride) {
      record.pendingExitSignalOverride = options.signalOverride;
    }
    forceKillPtyProcessTree(record.pty);
    this.scheduleForcedExitCleanup(record);
  }

  private markWindowsShellCommandActive(record: TerminalRecord): void {
    record.windowsShellCommandActive = true;
    record.windowsActiveCommandName =
      windowsCommandFallbackName(
        record.windowsPendingInputLine,
        record.session.shellBasename,
      ) || 'command';
    record.windowsPendingInputLine = '';
    record.windowsPromptTail = '';
  }

  private updateWindowsPendingInputLine(
    record: TerminalRecord,
    data: string,
  ): boolean {
    let submitted = false;
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index];
      if (char === '\x1b') {
        const next = data[index + 1];
        if (next === '[') {
          index += 2;
          while (index < data.length && !/[@-~]/.test(data[index] ?? '')) {
            index += 1;
          }
          continue;
        }
        if (next === ']') {
          index += 2;
          while (
            index < data.length &&
            data[index] !== '\x07' &&
            !(data[index] === '\x1b' && data[index + 1] === '\\')
          ) {
            index += 1;
          }
          if (data[index] === '\x1b') {
            index += 1;
          }
          continue;
        }
        if (next !== undefined) {
          index += 1;
        }
        continue;
      }
      if (char === CTRL_C) {
        record.windowsPendingInputLine = '';
        record.windowsShellCommandActive = false;
        record.windowsActiveCommandName = null;
        record.windowsPromptTail = '';
        continue;
      }
      if (char === '\b' || char === '\x7f') {
        record.windowsPendingInputLine = record.windowsPendingInputLine.slice(
          0,
          -1,
        );
        continue;
      }
      if (char === '\r' || char === '\n') {
        submitted ||= record.windowsPendingInputLine.trim().length > 0;
        continue;
      }
      if (char >= ' ') {
        record.windowsPendingInputLine += char;
      }
    }
    return submitted;
  }

  private getWindowsShellCommandProcessName(
    record: TerminalRecord,
  ): string | null {
    return record.windowsShellCommandActive
      ? (record.windowsActiveCommandName ?? 'command')
      : null;
  }

  private scheduleWindowsProcessProbe(record: TerminalRecord): void {
    if (record.windowsProcessProbeInFlight) {
      return;
    }

    record.windowsProcessProbeInFlight = true;
    record.lastWindowsProcessProbeAt = this.now();
    void resolveWindowsForegroundProcessName(
      record.pty.pid,
      record.session.shellBasename,
    ).then(
      (processName) => {
        const currentRecord = this.records.get(record.session.id);
        if (currentRecord !== record || record.exited) {
          return;
        }

        record.lastWindowsDescendantProcessName = processName;
        record.windowsProcessProbeInFlight = false;
        this.updateRunningStateFromEffectiveProcessName(
          record,
          processName ?? this.getWindowsShellCommandProcessName(record),
        );
      },
      () => {
        const currentRecord = this.records.get(record.session.id);
        if (currentRecord !== record || record.exited) {
          return;
        }

        record.lastWindowsDescendantProcessName = null;
        record.windowsProcessProbeInFlight = false;
        this.updateRunningStateFromEffectiveProcessName(
          record,
          this.getWindowsShellCommandProcessName(record),
        );
      },
    );
  }

  private updateRunningStateFromEffectiveProcessName(
    record: TerminalRecord,
    effectiveProcessName: string | null | undefined,
  ): void {
    const running = computeTerminalRunningState({
      shellBasename: record.session.shellBasename,
      processName: effectiveProcessName,
    });
    const processName =
      running && typeof effectiveProcessName === 'string'
        ? effectiveProcessName
        : null;
    this.setTerminalStatus(record.session.id, running, processName);
  }

  private getEffectiveProcessName(
    record: TerminalRecord,
  ): string | null | undefined {
    const processName = record.pty.process;
    if (
      process.platform !== 'win32' ||
      !isTerminalTypeProcessName(processName)
    ) {
      return processName;
    }

    const now = this.now();
    if (
      now - record.lastWindowsProcessProbeAt >=
        WINDOWS_RUNNING_PROCESS_PROBE_INTERVAL_MS &&
      !record.windowsProcessProbeInFlight
    ) {
      this.scheduleWindowsProcessProbe(record);
    }

    return (
      record.lastWindowsDescendantProcessName ??
      this.getWindowsShellCommandProcessName(record)
    );
  }

  public list(): TerminalSession[] {
    const sessions = Array.from(this.records.values())
      .map((record) => record.session)
      .sort((left, right) => left.createdAt - right.createdAt);

    const updates = sessions.map((session) => {
      const record = this.records.get(session.id);
      if (!record) {
        return null;
      }

      const effectiveProcessName = this.getEffectiveProcessName(record);
      const running = computeTerminalRunningState({
        shellBasename: record.session.shellBasename,
        processName: effectiveProcessName,
      });
      const processName =
        running && typeof effectiveProcessName === 'string'
          ? effectiveProcessName
          : null;
      record.running = running;
      record.lastProcessName = processName;
      return { terminalId: session.id, running, processName };
    });

    queueMicrotask((): void => {
      for (const update of updates) {
        if (!update) continue;
        const record = this.records.get(update.terminalId);
        if (!record) {
          continue;
        }

        this.emitRunningChanged(record);
      }
    });

    const updatesByTerminalId = new Map(
      updates.flatMap((update) =>
        update === null ? [] : [[update.terminalId, update] as const],
      ),
    );
    return sessions.map((session) => {
      const update = updatesByTerminalId.get(session.id);
      return {
        ...session,
        running: update?.running ?? false,
        processName: update?.processName ?? null,
      };
    });
  }

  public killWorktreeTerminals(projectId: string, worktreeId: string): void {
    for (const record of Array.from(this.records.values())) {
      if (
        record.session.projectId === projectId &&
        record.session.worktreeId === worktreeId
      ) {
        record.pendingExitSignalOverride = TERMINAL_WORKTREE_CLEANUP_SIGNAL;
        forceKillPtyProcessTree(record.pty);
        this.scheduleForcedExitCleanup(record);
      }
    }
  }

  public async drainTerminal(terminalId: string): Promise<void> {
    const record = this.records.get(terminalId);
    if (!record) return;
    if (!record.archiveDrain) {
      record.pendingExitSignalOverride = TERMINAL_WORKTREE_CLEANUP_SIGNAL;
      const ownedPid = record.pty.pid;
      record.archiveDrain = drainOwnedProcess(
        ownedPid,
        () =>
          this.records.get(terminalId) === record &&
          !record.exited &&
          record.pty.pid === ownedPid,
      )
        .then(() => {
          this.handlePtyExit(
            terminalId,
            null,
            TERMINAL_WORKTREE_CLEANUP_SIGNAL,
          );
        })
        .catch((error: unknown) => {
          record.archiveDrain = undefined;
          throw error;
        });
    }
    await record.archiveDrain;
  }

  public async drainWorktreeTerminals(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    const terminals = Array.from(this.records.values()).filter(
      (record) =>
        record.session.projectId === projectId &&
        record.session.worktreeId === worktreeId,
    );
    const results = await Promise.allSettled(
      terminals.map((record) => this.drainTerminal(record.session.id)),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  public hasWorktreeTerminals(projectId: string, worktreeId: string): boolean {
    return Array.from(this.records.values()).some(
      (record) =>
        !record.exited &&
        record.session.projectId === projectId &&
        record.session.worktreeId === worktreeId,
    );
  }

  public killAll(): void {
    for (const record of Array.from(this.records.values())) {
      forceKillPtyProcessTree(record.pty);
      this.scheduleForcedExitCleanup(record);
    }
  }

  public getLiveTerminalCount(): number {
    return this.records.size;
  }

  public getRunningWorktreeTargets(): Array<{
    projectId: string;
    worktreeId: string;
  }> {
    return Array.from(this.records.values())
      .filter((record) => !record.exited && record.running)
      .map((record) => ({
        projectId: record.session.projectId,
        worktreeId: record.session.worktreeId,
      }));
  }

  public getTerminalSnapshots(): Iterable<RunningDetectorTerminalSnapshot> {
    return Array.from(this.records.values(), (record) => ({
      id: record.session.id,
      shellBasename: record.session.shellBasename,
      processName: this.getEffectiveProcessName(record),
      running: record.running,
      lastProcessName: record.lastProcessName,
    }));
  }

  public setTerminalStatus(
    id: string,
    running: boolean,
    processName: string | null,
  ): void {
    const record = this.records.get(id);
    if (!record || record.exited) {
      return;
    }
    if (record.running === running && record.lastProcessName === processName) {
      return;
    }

    let interruptedByUser = false;
    if (running) {
      if (
        record.pendingUserInterruptAt !== null &&
        processName !== record.pendingUserInterruptProcessName
      ) {
        this.clearPendingUserInterrupt(record);
      }
    } else {
      interruptedByUser = this.consumePendingUserInterrupt(
        record,
        record.lastProcessName,
      );
    }

    record.running = running;
    record.lastProcessName = processName;
    this.emitRunningChanged(record, interruptedByUser);
  }

  private handlePtyData(terminalId: string, chunk: Buffer): void {
    const record = this.records.get(terminalId);
    if (!record || record.exited) {
      return;
    }

    const visibleChunk = this.filterInitialCommandOutput(record, chunk);
    if (visibleChunk === null || visibleChunk.length === 0) {
      return;
    }
    chunk = visibleChunk;

    if (
      process.platform === 'win32' &&
      isTerminalTypeProcessName(record.pty.process) &&
      record.windowsShellCommandActive
    ) {
      record.windowsPromptTail = `${record.windowsPromptTail}${chunk.toString(
        'utf8',
      )}`.slice(-512);
      if (windowsOutputEndsWithPrompt(record.windowsPromptTail)) {
        record.windowsShellCommandActive = false;
        record.windowsActiveCommandName = null;
        record.windowsPromptTail = '';
      }
    }

    if (record.queuedBytes + chunk.length > TERMINAL_MAX_UNFLUSHED_BYTES) {
      if (record.queuedBytes > 0) {
        this.flushQueuedOutput(terminalId);
      }

      const truncationChunk = Buffer.from(TRUNCATION_MARKER, 'utf8');
      record.replayBuffer = appendReplayChunk(
        record.replayBuffer,
        truncationChunk,
      );
      appendInitialAttachChunk(record, truncationChunk);
      this.persistenceStore.appendTerminalOutput(
        record.session.projectId,
        record.session.worktreeId,
        record.session.id,
        truncationChunk,
      );
      record.queue = [truncationChunk];
      record.queuedBytes = record.queue[0].length;
      this.flushQueuedOutput(terminalId);
      return;
    }

    record.replayBuffer = appendReplayChunk(record.replayBuffer, chunk);
    appendInitialAttachChunk(record, chunk);
    this.persistenceStore.appendTerminalOutput(
      record.session.projectId,
      record.session.worktreeId,
      record.session.id,
      chunk,
    );
    record.queue.push(chunk);
    record.queuedBytes += chunk.length;

    if (record.queuedBytes >= TERMINAL_FLUSH_THRESHOLD_BYTES) {
      this.flushQueuedOutput(terminalId);
      return;
    }

    if (record.flushScheduled) {
      return;
    }

    record.flushScheduled = true;
    queueMicrotask((): void => {
      const queuedRecord = this.records.get(terminalId);
      if (!queuedRecord) {
        return;
      }

      queuedRecord.flushScheduled = false;
      this.flushQueuedOutput(terminalId);
    });
  }

  private filterInitialCommandOutput(
    record: TerminalRecord,
    chunk: Buffer,
  ): Buffer | null {
    const suppression = record.initialCommandSuppression;
    if (suppression === null) {
      return chunk;
    }
    if (!suppression.sent) {
      this.scheduleInitialCommand(record, INITIAL_COMMAND_READY_DEBOUNCE_MS);
      return null;
    }

    const buffered =
      suppression.buffered.length === 0
        ? chunk
        : Buffer.concat(
            [suppression.buffered, chunk],
            suppression.buffered.length + chunk.length,
          );
    const rawLineFeedIndex = buffered.indexOf(0x0a);
    if (rawLineFeedIndex >= 0) {
      record.initialCommandSuppression = null;
      return buffered.subarray(rawLineFeedIndex + 1);
    }

    if (buffered.length > INITIAL_COMMAND_SUPPRESSION_MAX_BYTES) {
      record.initialCommandSuppression = null;
      return buffered;
    }

    suppression.buffered = buffered;
    return null;
  }

  private scheduleInitialCommand(
    record: TerminalRecord,
    delayMs: number,
  ): void {
    const suppression = record.initialCommandSuppression;
    if (suppression === null || suppression.sent || record.exited) return;
    if (suppression.sendTimer !== null) {
      clearTimeout(suppression.sendTimer);
    }
    const timer = setTimeout((): void => {
      suppression.sendTimer = null;
      if (
        this.records.get(record.session.id) !== record ||
        record.exited ||
        record.initialCommandSuppression !== suppression
      ) {
        return;
      }
      suppression.sent = true;
      suppression.buffered = Buffer.alloc(0);
      this.write(record.session.id, `${suppression.value}\r`);
    }, delayMs);
    timer.unref?.();
    suppression.sendTimer = timer;
  }

  private flushQueuedOutput(terminalId: string): void {
    const record = this.records.get(terminalId);
    if (!record || record.queue.length === 0) {
      return;
    }

    record.flushScheduled = false;
    const payload = Buffer.concat(record.queue);
    record.queue = [];
    record.queuedBytes = 0;
    record.seq += payload.length;

    const event: TerminalOutputEvent = {
      projectId: record.session.projectId,
      worktreeId: record.session.worktreeId,
      terminalId: record.session.id,
      data: cloneBytes(payload),
      seq: record.seq,
    };
    this.emitEvent(IPC_CHANNELS.terminalOutput, event);
  }

  private handlePtyExit(
    terminalId: string,
    exitCode: number | null,
    signal: string | null,
  ): void {
    const record = this.records.get(terminalId);
    if (!record || record.exited) {
      return;
    }

    record.exited = true;
    this.disposeRecordResources(record, { destroyPty: true });
    this.flushQueuedOutput(terminalId);
    const resolvedSignal = record.pendingExitSignalOverride ?? signal;
    const shouldEmitRunningChanged =
      resolvedSignal !== TERMINAL_WORKTREE_CLEANUP_SIGNAL &&
      resolvedSignal !== TERMINAL_CANOPY_MANAGED_CLEANUP_SIGNAL;

    if (record.running || record.lastProcessName !== null) {
      const interruptedByUser = this.consumePendingUserInterrupt(
        record,
        record.lastProcessName,
      );
      record.running = false;
      record.lastProcessName = null;
      if (shouldEmitRunningChanged) {
        this.emitRunningChanged(record, interruptedByUser);
      }
    }

    const event: TerminalExitEvent = {
      projectId: record.session.projectId,
      worktreeId: record.session.worktreeId,
      terminalId: record.session.id,
      kind: record.session.kind ?? 'shell',
      exitCode,
      signal: resolvedSignal,
    };
    this.emitEvent(IPC_CHANNELS.terminalExit, event);
    this.persistenceStore.markTerminalExited(
      record.session.projectId,
      record.session.worktreeId,
      record.session.id,
      exitCode,
      resolvedSignal,
    );

    this.records.delete(terminalId);
    this.runningDetector.syncLifecycle();
  }

  private scheduleForcedExitCleanup(record: TerminalRecord): void {
    if (record.forcedExitTimer !== null || record.exited) {
      return;
    }

    const timer = setTimeout((): void => {
      record.forcedExitTimer = null;
      if (this.records.get(record.session.id) !== record || record.exited) {
        return;
      }

      this.handlePtyExit(
        record.session.id,
        null,
        record.pendingExitSignalOverride ?? 'forced-cleanup',
      );
    }, this.killExitGraceMs);
    timer.unref?.();
    record.forcedExitTimer = timer;
  }

  private disposeRecordResources(
    record: TerminalRecord,
    options: { destroyPty: boolean },
  ): void {
    if (record.forcedExitTimer !== null) {
      clearTimeout(record.forcedExitTimer);
      record.forcedExitTimer = null;
    }
    const initialCommandSuppression = record.initialCommandSuppression;
    if (initialCommandSuppression?.sendTimer) {
      clearTimeout(initialCommandSuppression.sendTimer);
      initialCommandSuppression.sendTimer = null;
    }

    try {
      record.dataDisposable?.dispose();
    } catch {
      // best effort
    }
    record.dataDisposable = null;

    try {
      record.exitDisposable?.dispose();
    } catch {
      // best effort
    }
    record.exitDisposable = null;
    record.resourceHandle?.unregister();
    record.resourceHandle = undefined;

    if (options.destroyPty) {
      destroyPtyIfAvailable(record.pty);
    }
  }

  private emitRunningChanged(
    record: TerminalRecord,
    interruptedByUser = false,
  ): void {
    const event: TerminalRunningChangedEvent = {
      projectId: record.session.projectId,
      worktreeId: record.session.worktreeId,
      terminalId: record.session.id,
      kind: record.session.kind ?? 'shell',
      running: record.running,
      processName: record.lastProcessName,
    };
    if (interruptedByUser) {
      event.interruptedByUser = true;
    }
    this.emitEvent(IPC_CHANNELS.terminalRunningChanged, event);
  }

  private consumePendingUserInterrupt(
    record: TerminalRecord,
    processName: string | null,
  ): boolean {
    if (
      record.pendingUserInterruptAt === null ||
      processName === null ||
      processName !== record.pendingUserInterruptProcessName
    ) {
      return false;
    }

    const elapsedMs = this.now() - record.pendingUserInterruptAt;
    this.clearPendingUserInterrupt(record);
    return elapsedMs <= TERMINAL_USER_INTERRUPT_SUPPRESS_MS;
  }

  private clearPendingUserInterrupt(record: TerminalRecord): void {
    record.pendingUserInterruptAt = null;
    record.pendingUserInterruptProcessName = null;
  }
}

export const ptyManager = new PtyManager();

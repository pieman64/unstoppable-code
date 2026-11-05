// The account proxy Canopy runs on this device (CAN-4023): downloads the
// pinned CLIProxyAPI release, writes its config, and owns its process the way
// the Ollama service owns a managed server. The service decides when to start
// or stop it; this module only runs it. See
// docs/planning/2026-10-14-account-proxy-local/README.md.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { hash as bcryptHash } from 'bcryptjs';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import type {
  AccountProxyLocalPhase,
  AccountProxyLocalRuntime,
  AccountProxyRoutingStrategy,
} from '@canopy/desktop-shared/types/account-proxy';
import {
  getAccountProxyLocalDir,
  getAccountProxyLocalRuntimeDir,
} from '../lib/paths';
import { ManagedRuntimeInstaller } from '../lib/managed-runtime-installer';
import { listeningInodes, netstatShowsListener } from './listener-owner';
import {
  closeLocalAccountProxyLaunchKeys,
  mintLocalAccountProxyLaunchKeys,
  type LocalAccountProxyLaunchKeys,
  type MintedLocalAccountProxyKeys,
} from './local-launch-keys';
import { registerLocalAccountProxyShutdown } from './local-shutdown';
import {
  accountProxyExecutableName,
  getAccountProxyRuntimeArtifact,
  type AccountProxyRuntimeArtifact,
} from './runtime-metadata';

const LABEL = 'Account proxy';
const STARTUP_TIMEOUT_MS = 20_000;
const HEALTH_POLL_MS = 250;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const OUTPUT_TAIL_CHARS = 4_000;

/**
 * What the proxy needs to start: the port it last used and its routing. Each
 * launch makes its own keys (CAN-4406).
 */
export interface LocalAccountProxyLaunch {
  /** Tried first, so a restart keeps the address sessions already know. */
  readonly preferredPort: number | null;
  /** `routing.strategy`; null leaves the proxy's default, round robin. */
  readonly routingStrategy: AccountProxyRoutingStrategy | null;
}

export class LocalAccountProxyError extends Error {
  constructor(
    readonly code: 'local-unsupported' | 'local-failed',
    message: string,
  ) {
    super(message);
    this.name = 'LocalAccountProxyError';
  }
}

/** The process a launch started, so a later launch can stop an orphan. */
interface ProcessRecord {
  readonly pid: number;
  readonly port: number;
  /** The launch's config; records from earlier versions used config.yaml. */
  readonly config?: string;
}

interface RuntimeDeps {
  readonly fetch: typeof fetch;
  readonly artifact: () => AccountProxyRuntimeArtifact | undefined;
  readonly allowLoopbackDownload: boolean;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  /** The command line of `pid`, or null where it cannot be read. */
  readonly commandLine: (pid: number) => Promise<string | null>;
  /** Whether `pid` holds the listening socket on loopback `port`. */
  readonly ownsListener: (pid: number, port: number) => Promise<boolean>;
  /** Opens the connection that probes whether a port is taken. */
  readonly connect: (options: { host: string; port: number }) => Socket;
}

function readCommandLine(pid: number): Promise<string | null> {
  const os = hostPlatformOperatingSystem();
  if (os === 'linux') {
    return readFile(`/proc/${String(pid)}/cmdline`, 'utf8').then(
      (raw) => raw.split('\0').join(' '),
      () => null,
    );
  }
  if (os === 'darwin') {
    return new Promise((resolve) => {
      execFile(
        '/bin/ps',
        ['-p', String(pid), '-o', 'command='],
        { timeout: 2_000 },
        (error, stdout) => resolve(error ? null : stdout),
      );
    });
  }
  // Windows: a crashed launch's proxy is not identified, so it is left alone
  // and the next start moves to another port.
  return Promise.resolve(null);
}

function runForOutput(
  file: string,
  args: readonly string[],
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: 5_000, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

/**
 * Whether `pid` is the process listening on loopback `port`. A health check
 * alone cannot tell: something else can answer on the port while the proxy
 * fails to bind it, and must not then be sent the key.
 */
async function readOwnsListener(pid: number, port: number): Promise<boolean> {
  const os = hostPlatformOperatingSystem();
  if (os === 'linux') {
    const tables = await Promise.all(
      ['/proc/net/tcp', '/proc/net/tcp6'].map((file) =>
        readFile(file, 'utf8').catch(() => ''),
      ),
    );
    const inodes = new Set<string>();
    for (const table of tables) {
      listeningInodes(table, port).forEach((inode) => inodes.add(inode));
    }
    if (inodes.size === 0) return false;
    const fdDir = `/proc/${String(pid)}/fd`;
    const fds = await readdir(fdDir).catch((): string[] => []);
    const links = await Promise.all(
      fds.map((fd) => readlink(join(fdDir, fd)).catch(() => '')),
    );
    return links.some((link) => {
      const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
      return inode !== undefined && inodes.has(inode);
    });
  }
  if (os === 'darwin') {
    const output = await runForOutput('/usr/sbin/lsof', [
      '-nP',
      '-a',
      '-p',
      String(pid),
      `-iTCP:${String(port)}`,
      '-sTCP:LISTEN',
      '-t',
    ]);
    return output?.trim().split('\n').includes(String(pid)) ?? false;
  }
  if (os === 'win32') {
    const output = await runForOutput(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netstat.exe'),
      ['-ano', '-p', 'TCP'],
    );
    return netstatShowsListener(output ?? '', pid, port);
  }
  return false;
}

/**
 * UI automation builds may serve a fixture release from loopback. The build
 * constant removes this from production builds, so no environment variable
 * can point a shipped app at another download.
 */
function e2eArtifact(
  pinned: AccountProxyRuntimeArtifact | undefined,
): AccountProxyRuntimeArtifact | undefined {
  if (!isE2eBuild()) return pinned;
  if (!pinned || !process.env.CANOPY_E2E_ACCOUNT_PROXY_RUNTIME) return pinned;
  const value: unknown = JSON.parse(
    process.env.CANOPY_E2E_ACCOUNT_PROXY_RUNTIME,
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    !('url' in value) ||
    typeof value.url !== 'string' ||
    !value.url.startsWith('http://127.0.0.1:') ||
    !('integrity' in value) ||
    typeof value.integrity !== 'string' ||
    !('executableSha256' in value) ||
    typeof value.executableSha256 !== 'string' ||
    !('archiveBytes' in value) ||
    typeof value.archiveBytes !== 'number'
  )
    throw new Error('Invalid account proxy runtime fixture.');
  return {
    ...pinned,
    url: value.url,
    archive: 'tgz',
    integrity: value.integrity,
    executableSha256: value.executableSha256,
    archiveBytes: value.archiveBytes,
  };
}

/**
 * True only in an E2E build. The Electron specs also load this module through
 * tsx, where the build define does not exist.
 */
function isE2eBuild(): boolean {
  return typeof __CANOPY_E2E__ !== 'undefined' && __CANOPY_E2E__;
}

const defaultDeps: RuntimeDeps = {
  fetch: (...args) => fetch(...args),
  artifact: () => {
    try {
      return e2eArtifact(
        getAccountProxyRuntimeArtifact(
          hostPlatformOperatingSystem(),
          process.arch,
        ),
      );
    } catch {
      // A platform with no platform services has no release either.
      return undefined;
    }
  },
  allowLoopbackDownload: isE2eBuild(),
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
  commandLine: readCommandLine,
  ownsListener: readOwnsListener,
  connect: (options) => connect(options),
};
let deps: RuntimeDeps = defaultDeps;

let phase: Exclude<AccountProxyLocalPhase, 'unsupported' | 'not-installed'> =
  'stopped';
let installProgress: AccountProxyLocalRuntime['install'] = null;
let runningPort: number | null = null;
let failureMessage: string | null = null;
let child: ChildProcess | null = null;
/** The config the child was started with, removed once it has exited. */
let childConfig: string | null = null;
let outputTail = '';
let installed: boolean | null = null;
/** The running proxy's keys, open while it serves its port. */
let launchKeys: LocalAccountProxyLaunchKeys | null = null;
/** Cancels the start in progress: Stop, quit, and turning the feature off. */
let startAbort: AbortController | null = null;
/** Set at quit; nothing starts after it. */
let shuttingDown = false;
/** Counts stops; a start queued before a stop does not run. */
let stopRequests = 0;
/** Start and stop never overlap; each waits for the one before it. */
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function changed(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A listener's failure must not stop the proxy's own bookkeeping.
    }
  });
}

/** Called after every change the status shows. */
export function onLocalAccountProxyChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function paths(): {
  root: string;
  /** Every launch's config path starts with this, as earlier ones did. */
  configPrefix: string;
  auths: string;
  record: string;
  legacyKey: string;
} {
  const root = getAccountProxyLocalDir();
  return {
    root,
    configPrefix: join(root, 'config'),
    auths: join(root, 'auths'),
    record: join(root, 'process.json'),
    // Written by earlier versions, which reused one stored key across
    // launches; removed on the next start.
    legacyKey: join(root, 'key.json'),
  };
}

function installer(
  artifact: AccountProxyRuntimeArtifact,
): ManagedRuntimeInstaller {
  const executableName = accountProxyExecutableName(
    hostPlatformOperatingSystem(),
  );
  return new ManagedRuntimeInstaller({
    root: getAccountProxyLocalRuntimeDir(),
    artifact,
    executableName,
    archivePath: executableName,
    archiveFormat: artifact.archive,
    source: 'github-release',
    label: LABEL,
    fetchArchive: deps.fetch,
    allowLoopback: deps.allowLoopbackDownload,
  });
}

/** The proxy's state for the status the settings show. */
export async function getLocalAccountProxyRuntime(
  startWithApp: boolean,
): Promise<AccountProxyLocalRuntime> {
  const artifact = deps.artifact();
  if (!artifact) {
    return {
      phase: 'unsupported',
      version: null,
      install: null,
      port: null,
      startWithApp,
      message: null,
    };
  }
  if (installed === null && phase === 'stopped') {
    installed = await installer(artifact)
      .isInstalled()
      .catch(() => false);
  }
  return {
    phase: phase === 'stopped' && !installed ? 'not-installed' : phase,
    version: artifact.version,
    install: phase === 'installing' ? installProgress : null,
    port: phase === 'running' ? runningPort : null,
    startWithApp,
    message: phase === 'error' ? failureMessage : null,
  };
}

/** The port the proxy listens on, while it runs. */
export function getLocalAccountProxyPort(): number | null {
  return phase === 'running' ? runningPort : null;
}

/**
 * The running proxy's keys and port, while it serves that port. The handles
 * reveal nothing once the process exits or is stopped.
 */
export function getLocalAccountProxyLaunch(): {
  readonly port: number;
  readonly keys: LocalAccountProxyLaunchKeys;
} | null {
  if (phase !== 'running' || runningPort === null || !launchKeys) return null;
  return { port: runningPort, keys: launchKeys };
}

/**
 * App start: stop a proxy an earlier run of the app left behind and remove
 * its config. Its keys died with that run, so nothing can use it. A proxy
 * that may still be running keeps its record and config, so a later start
 * can still find and stop it.
 */
export function clearLocalAccountProxyLeftovers(): Promise<void> {
  return serialize(async () => {
    if (child) return;
    await removeLeftoverConfigs(await stopOrphans());
  });
}

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

/** Whether a start in progress was cancelled, or the app is quitting. */
function cancelled(signal: AbortSignal): boolean {
  return signal.aborted || shuttingDown;
}

class LocalAccountProxyCancelled extends LocalAccountProxyError {
  constructor() {
    super('local-failed', 'The account proxy start was cancelled.');
  }
}

/** A JSON string is a valid YAML double-quoted scalar. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

async function readRecord(file: string): Promise<ProcessRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (
      typeof value === 'object' &&
      value !== null &&
      'pid' in value &&
      typeof value.pid === 'number' &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      'port' in value &&
      typeof value.port === 'number'
    ) {
      const config =
        'config' in value &&
        typeof value.config === 'string' &&
        value.config.startsWith(paths().configPrefix)
          ? value.config
          : `${paths().configPrefix}.yaml`;
      return { pid: value.pid, port: value.port, config };
    }
  } catch {
    // No record, or one this version cannot read: nothing to stop.
  }
  return null;
}

/** CLIProxyAPI's default bcrypt cost for its management secret. */
const MANAGEMENT_HASH_ROUNDS = 10;

/**
 * The config the proxy runs with. Loopback only, never advertised on the
 * network, no web panel download, usage statistics off (the broker attributes
 * requests), and session affinity on. The client key list is never empty: the
 * proxy treats an empty list as no auth.
 *
 * The management secret is a bcrypt hash made here, which the proxy accepts
 * as is, so the management key never reaches disk. The proxy reads client
 * keys only from this file, so the launch's client key is in it until the
 * process exits and the file is removed.
 */
async function writeConfig(
  launch: LocalAccountProxyLaunch,
  port: number,
  minted: MintedLocalAccountProxyKeys,
  config: string,
): Promise<void> {
  const { auths, root } = paths();
  const secretHash = await bcryptHash(
    minted.managementKey,
    MANAGEMENT_HASH_ROUNDS,
  );
  const body = [
    '# Written by the app on every start and removed when the proxy stops.',
    'config-version: 8',
    'server:',
    `  host: ${yamlString('127.0.0.1')}`,
    `  port: ${String(port)}`,
    '  discovery:',
    '    enabled: false',
    'management:',
    '  allow-remote: false',
    `  secret-key: ${yamlString(secretHash)}`,
    '  disable-control-panel: true',
    'access:',
    '  api-keys:',
    `    - ${yamlString(minted.clientKey)}`,
    'routing:',
    ...(launch.routingStrategy
      ? [`  strategy: ${yamlString(launch.routingStrategy)}`]
      : []),
    '  session-affinity: true',
    '  session-affinity-subagents: true',
    'oauth:',
    `  auth-dir: ${yamlString(auths)}`,
    'observability:',
    '  usage:',
    '    usage-statistics-enabled: false',
    'plugins:',
    '  enabled: false',
    '',
  ].join('\n');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(auths, { recursive: true, mode: 0o700 });
  // A new file, so always created with 0600.
  await writeFile(config, body, { mode: 0o600, flag: 'wx' });
}

/**
 * Each launch has its own config file. The proxy reloads its config when it
 * changes, so a proxy an earlier launch left running, which cannot always be
 * identified, never reads a later launch's keys.
 */
function launchConfigPath(minted: MintedLocalAccountProxyKeys): string {
  return `${paths().configPrefix}-${minted.keys.epoch}.yaml`;
}

/**
 * Removes a launch's config. Only once that proxy has exited: a config
 * without its client key would open it to every local program.
 */
async function removeLaunchConfig(config: string | null): Promise<void> {
  if (config) await rm(config, { force: true });
}

/**
 * Removes the launch configs and the key file earlier versions kept, except
 * the configs of proxies that may still be running. Only when this app runs
 * no proxy itself.
 */
async function removeLeftoverConfigs(keep: ReadonlySet<string>): Promise<void> {
  const { root, legacyKey } = paths();
  const names = await readdir(root).catch((): string[] => []);
  await Promise.all(
    names
      .filter((name) => /^config(-[0-9a-f-]+)?\.yaml$/.test(name))
      .map((name) => join(root, name))
      .filter((config) => !keep.has(config))
      .map((config) => rm(config, { force: true })),
  );
  await rm(legacyKey, { force: true });
}

/** Ends the running launch: its keys reveal nothing from now on. */
function closeLaunchKeys(): void {
  if (launchKeys) closeLocalAccountProxyLaunchKeys(launchKeys);
  launchKeys = null;
}

/** The proxy's output, with the launch's keys taken out. */
function redactKeys(text: string, minted: MintedLocalAccountProxyKeys): string {
  return text
    .split(minted.clientKey)
    .join('[redacted]')
    .split(minted.managementKey)
    .join('[redacted]');
}

/** Ports the proxy picks from when the last one is taken. */
const PORT_RANGE = { min: 20_000, max: 60_999 } as const;
const PORT_PICK_ATTEMPTS = 20;
const BIND_ATTEMPTS = 3;

/**
 * Whether anything answers on `port`. Checked by connecting, never by
 * listening, so finding a port opens no socket of the app's own. A proxy that
 * still loses the race for the port is started again on another one.
 */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = deps.connect({ host: '127.0.0.1', port });
    const done = (inUse: boolean): void => {
      socket.destroy();
      resolve(inUse);
    };
    // Windows refuses a closed loopback port only after SYN retries, so a
    // probe that times out found nothing listening. If something holds the
    // port anyway, the proxy fails to bind it and starts on another.
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      done(error.code !== 'ECONNREFUSED'),
    );
  });
}

function randomPort(): number {
  return (
    PORT_RANGE.min +
    Math.floor(Math.random() * (PORT_RANGE.max - PORT_RANGE.min + 1))
  );
}

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < PORT_PICK_ATTEMPTS; attempt++) {
    const port = randomPort();
    if (!(await isPortInUse(port))) return port;
  }
  throw new LocalAccountProxyError(
    'local-failed',
    'No free port was found for the account proxy.',
  );
}

/** A free loopback port to give a new local connection its address. */
export function pickLocalAccountProxyPort(): Promise<number> {
  return freePort();
}

async function choosePort(preferred: number | null): Promise<number> {
  if (preferred !== null && !(await isPortInUse(preferred))) return preferred;
  return freePort();
}

async function isHealthy(port: number, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await deps.fetch(
      `http://127.0.0.1:${String(port)}/healthz`,
      {
        signal: signal ?? AbortSignal.timeout(2_000),
      },
    );
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!deps.isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !deps.isProcessAlive(pid);
}

/**
 * A proxy a crashed launch left running still holds its port and auth
 * directory. It is stopped only when the recorded process is alive and its
 * command line names this device's config file, so a process that reused
 * the id is never signalled and nothing is sent to whatever holds the port.
 */
async function stopOrphan(
  record: ProcessRecord,
): Promise<'gone' | 'unconfirmed'> {
  if (!deps.isProcessAlive(record.pid)) return 'gone';
  const commandLine = await deps.commandLine(record.pid);
  // Where the command line cannot be read, the process may still be the proxy.
  if (commandLine === null) return 'unconfirmed';
  // The id now belongs to another program, so the proxy itself has exited.
  if (!commandLine.includes(paths().configPrefix)) return 'gone';
  try {
    deps.kill(record.pid, 'SIGTERM');
  } catch {
    return deps.isProcessAlive(record.pid) ? 'unconfirmed' : 'gone';
  }
  if (await waitForExit(record.pid, SHUTDOWN_TIMEOUT_MS)) return 'gone';
  try {
    deps.kill(record.pid, 'SIGKILL');
  } catch {
    // Already gone, or not ours to signal; checked below.
  }
  return (await waitForExit(record.pid, SHUTDOWN_TIMEOUT_MS))
    ? 'gone'
    : 'unconfirmed';
}

/**
 * Stops the proxies earlier runs left behind. A stopped one's record goes;
 * one that may still be running keeps a record of its own, out of the way of
 * the next launch's, and the config it reads. Resolves with those configs.
 */
async function stopOrphans(): Promise<ReadonlySet<string>> {
  const { root, record } = paths();
  const names = await readdir(root).catch((): string[] => []);
  const files = [
    record,
    ...names
      .filter((name) => /^orphan-\d+\.json$/.test(name))
      .map((name) => join(root, name)),
  ];
  const keep = new Set<string>();
  for (const file of files) {
    const found = await readRecord(file);
    if (!found) {
      await rm(file, { force: true }).catch(() => undefined);
      continue;
    }
    if ((await stopOrphan(found)) === 'gone') {
      await rm(file, { force: true }).catch(() => undefined);
      continue;
    }
    if (found.config) keep.add(found.config);
    if (file === record) {
      await rename(file, join(root, `orphan-${String(found.pid)}.json`)).catch(
        () => undefined,
      );
    }
  }
  return keep;
}

/**
 * Only what the proxy needs. It never sees provider API keys or other
 * secrets from the app's environment; network proxy settings pass through
 * so it can reach providers from behind one.
 */
function proxyEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TZ',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

async function terminate(target: ChildProcess): Promise<void> {
  if (target.exitCode !== null || target.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      target.kill('SIGKILL');
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
    target.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    target.kill('SIGTERM');
  });
}

async function startNow(
  launch: LocalAccountProxyLaunch,
  stopsBefore: number,
): Promise<number> {
  if (shuttingDown || stopRequests !== stopsBefore) {
    throw new LocalAccountProxyCancelled();
  }
  const artifact = deps.artifact();
  if (!artifact) {
    throw new LocalAccountProxyError(
      'local-unsupported',
      'The account proxy is not available for this device.',
    );
  }
  // A running proxy keeps its keys; only a stop or restart replaces them.
  if (child && phase === 'running' && runningPort !== null) return runningPort;
  const abort = new AbortController();
  startAbort = abort;
  // A stop requested while the previous proxy was terminated.
  if (stopRequests !== stopsBefore) abort.abort();
  failureMessage = null;
  const runtime = installer(artifact);
  let executable: string;
  try {
    if (await runtime.isInstalled()) {
      executable = await runtime.verify(
        AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
      );
    } else {
      phase = 'installing';
      installProgress = { step: 'downloading', percent: 0 };
      changed();
      executable = await runtime.install(
        AbortSignal.any([abort.signal, AbortSignal.timeout(10 * 60_000)]),
        (step, percent) => {
          installProgress = { step, percent: percent ?? null };
          changed();
        },
      );
    }
    installed = true;
  } catch (error) {
    if (cancelled(abort.signal)) throw new LocalAccountProxyCancelled();
    throw new LocalAccountProxyError(
      'local-failed',
      error instanceof Error ? error.message : 'The download failed.',
    );
  }
  if (cancelled(abort.signal)) throw new LocalAccountProxyCancelled();
  phase = 'starting';
  installProgress = null;
  changed();
  // A proxy that may still be running keeps its files; its config is not
  // the one this launch writes.
  await removeLeftoverConfigs(await stopOrphans()).catch(() => undefined);
  let port = await choosePort(launch.preferredPort);
  for (let attempt = 1; ; attempt++) {
    if (cancelled(abort.signal)) throw new LocalAccountProxyCancelled();
    const outcome = await launchOnce(executable, launch, port, abort.signal);
    if (outcome.ok) return port;
    if (cancelled(abort.signal)) throw new LocalAccountProxyCancelled();
    // Another program took the port between the check and the bind.
    if (!outcome.portTaken || attempt >= BIND_ATTEMPTS) {
      throw new LocalAccountProxyError(
        'local-failed',
        `The account proxy did not start: ${outcome.reason}.${
          outcome.output ? ` ${outcome.output}` : ''
        }`,
      );
    }
    port = await freePort();
  }
}

type LaunchOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      /** The last line the proxy printed, for the error shown. */
      readonly output: string;
      readonly portTaken: boolean;
    };

/** Spawn the proxy on `port` and wait until it answers or gives up. */
async function launchOnce(
  executable: string,
  launch: LocalAccountProxyLaunch,
  port: number,
  signal: AbortSignal,
): Promise<LaunchOutcome> {
  const minted = mintLocalAccountProxyLaunchKeys();
  const config = launchConfigPath(minted);
  try {
    await writeConfig(launch, port, minted, config);
  } catch (error) {
    closeLocalAccountProxyLaunchKeys(minted.keys);
    await removeLaunchConfig(config).catch(() => undefined);
    throw error;
  }
  outputTail = '';
  const started = spawn(executable, ['--config', config, '--local-model'], {
    cwd: paths().root,
    env: proxyEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child = started;
  childConfig = config;
  // Set from the process callbacks, which the loop below reads.
  const exit: { reason: string | null } = { reason: null };
  // Both streams are read, so the proxy's logging never fills a pipe.
  const keepTail = (chunk: Buffer | string): void => {
    outputTail = `${outputTail}${String(chunk)}`.slice(-OUTPUT_TAIL_CHARS);
  };
  started.stdout?.on('data', keepTail);
  started.stderr?.on('data', keepTail);
  started.once('error', (error) => {
    exit.reason = error.message;
  });
  started.once('exit', (code, signal) => {
    exit.reason = signal ? `signal ${signal}` : `code ${String(code)}`;
    // Whatever stopped it, its keys open nothing any more.
    closeLocalAccountProxyLaunchKeys(minted.keys);
    if (launchKeys === minted.keys) launchKeys = null;
    if (child !== started) return;
    child = null;
    childConfig = null;
    runningPort = null;
    if (phase === 'running') {
      phase = 'error';
      failureMessage = `The account proxy stopped (${exit.reason}).`;
      changed();
      void serialize(() => removeLaunchConfig(config)).catch(() => undefined);
    }
    void rm(paths().record, { force: true }).catch(() => undefined);
  });
  if (started.pid !== undefined) {
    try {
      await writeFile(
        paths().record,
        JSON.stringify({
          pid: started.pid,
          port,
          config,
        } satisfies ProcessRecord),
        { mode: 0o600 },
      );
    } catch (error) {
      // Unrecorded, a crash would leave it for no later launch to find.
      if (child === started) child = null;
      if (childConfig === config) childConfig = null;
      await terminate(started);
      closeLocalAccountProxyLaunchKeys(minted.keys);
      await removeLaunchConfig(config).catch(() => undefined);
      throw error;
    }
  }
  let foreignListener = false;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exit.reason !== null || cancelled(signal)) break;
    const healthy = await isHealthy(port);
    // The proxy can exit, or the start be cancelled, while the probe is
    // answered; its port is then released and must not be reported.
    if (child !== started || exit.reason !== null || cancelled(signal)) break;
    if (healthy) {
      // Whatever answered must be the proxy itself: another listener can
      // hold the port while the proxy fails to bind it, and would then be
      // sent the key.
      if (
        started.pid === undefined ||
        !(await deps.ownsListener(started.pid, port))
      ) {
        foreignListener = true;
        break;
      }
      if (child !== started || exit.reason !== null || cancelled(signal)) {
        break;
      }
      phase = 'running';
      runningPort = port;
      launchKeys = minted.keys;
      changed();
      return { ok: true };
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
  if (child === started) {
    child = null;
    await terminate(started);
  }
  // The process is gone, so its config can go.
  if (childConfig === config) childConfig = null;
  closeLocalAccountProxyLaunchKeys(minted.keys);
  await removeLaunchConfig(config).catch(() => undefined);
  // The last line is shown in the status; no key of this launch goes with it.
  const output = redactKeys(
    outputTail.trim().split('\n').slice(-1)[0] ?? '',
    minted,
  );
  return {
    ok: false,
    reason: foreignListener
      ? 'another program answered on its port'
      : exit.reason !== null
        ? `it exited (${exit.reason})`
        : 'it did not answer in time',
    output,
    portTaken:
      foreignListener ||
      /address already in use|only one usage of each socket address/i.test(
        outputTail,
      ),
  };
}

/**
 * Start the proxy, downloading it first if needed. Resolves with its port.
 * Rejects with {@link LocalAccountProxyError}; the status then shows why.
 */
export function startLocalAccountProxy(
  launch: LocalAccountProxyLaunch,
): Promise<number> {
  const stopsBefore = stopRequests;
  return serialize(async () => {
    try {
      return await startNow(launch, stopsBefore);
    } catch (error) {
      installProgress = null;
      if (error instanceof LocalAccountProxyCancelled) {
        phase = 'stopped';
        failureMessage = null;
        changed();
        throw error;
      }
      phase = 'error';
      failureMessage =
        error instanceof Error ? error.message : 'The account proxy failed.';
      changed();
      throw error instanceof LocalAccountProxyError
        ? error
        : new LocalAccountProxyError('local-failed', failureMessage);
    } finally {
      startAbort = null;
    }
  });
}

/** Whether a start is in progress, so turning the feature off can stop it. */
export function isLocalAccountProxyStarting(): boolean {
  return startAbort !== null;
}

/** Stop the proxy this launch started. Resolves once it has exited. */
export function stopLocalAccountProxy(): Promise<void> {
  // Starts queued before this stop never run, and one still downloading or
  // waiting on the proxy gives way at once.
  stopRequests += 1;
  startAbort?.abort();
  return serialize(async () => {
    const target = child;
    const config = childConfig;
    child = null;
    childConfig = null;
    runningPort = null;
    closeLaunchKeys();
    if (target) await terminate(target);
    await rm(paths().record, { force: true }).catch(() => undefined);
    await removeLaunchConfig(config).catch(() => undefined);
    phase = 'stopped';
    failureMessage = null;
    installProgress = null;
    changed();
  });
}

/**
 * App quit: cancel a start in progress, then stop the proxy. Nothing starts
 * after this.
 */
export async function shutdownLocalAccountProxy(): Promise<void> {
  // Set first, so a start still queued behind this one never begins.
  shuttingDown = true;
  const pendingStart = startAbort;
  // Nothing this launch started: quit does no other work.
  if (!child && !pendingStart) return;
  pendingStart?.abort();
  if (pendingStart) {
    // The cancelled start ends within one health poll or download chunk.
    await Promise.race([
      queue,
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
  }
  const target = child;
  const config = childConfig;
  child = null;
  childConfig = null;
  runningPort = null;
  closeLaunchKeys();
  phase = 'stopped';
  // Listeners cancel what is still on its way to the port before it is
  // released, as they do on Stop.
  changed();
  if (target) await terminate(target);
  await rm(paths().record, { force: true }).catch(() => undefined);
  await removeLaunchConfig(config).catch(() => undefined);
}

registerLocalAccountProxyShutdown(shutdownLocalAccountProxy);

export function setLocalAccountProxyDepsForTests(
  overrides: Partial<RuntimeDeps>,
): void {
  deps = { ...defaultDeps, ...overrides };
}

export function resetLocalAccountProxyForTests(): void {
  deps = defaultDeps;
  phase = 'stopped';
  installProgress = null;
  runningPort = null;
  failureMessage = null;
  child = null;
  childConfig = null;
  outputTail = '';
  installed = null;
  closeLaunchKeys();
  startAbort = null;
  shuttingDown = false;
  stopRequests = 0;
  queue = Promise.resolve();
  listeners.clear();
}

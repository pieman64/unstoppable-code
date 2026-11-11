import { execFile, execFileSync } from 'node:child_process';
import { getLinuxProbeEnv } from '@canopy/execution-engine/pipelines/config-paths';

type SecretServiceState = 'secure' | 'unavailable' | 'locked';

interface GdbusCall {
  readonly destination: string;
  readonly objectPath: string;
  readonly method: string;
  readonly args: readonly string[];
}

const PROBE_DEADLINE_MS = 1500;

function gdbusArgs(request: GdbusCall): string[] {
  return [
    'call',
    '--session',
    '--dest',
    request.destination,
    '--object-path',
    request.objectPath,
    '--method',
    request.method,
    '--timeout',
    '1',
    ...request.args,
  ];
}

function remainingTimeout(deadline: number): number {
  const timeout = Math.ceil(deadline - performance.now());
  if (timeout <= 0) throw new Error('Secret Service probe deadline');
  return timeout;
}

// Fixed OS adapter helper: intentionally bypass user/bundled binary lookup
// and getEnhancedEnv() to avoid PATH substitution and secret-injection recursion.
// See the fixed-system-helper exception in bundled-runtime-maintenance.md.
// No shell, activation, or secrets in argv/output.
function gdbusOptions(timeout: number): {
  encoding: 'utf8';
  timeout: number;
  killSignal: 'SIGKILL';
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
} {
  return {
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 4096,
    env: getLinuxProbeEnv(),
  };
}

/**
 * The probe's D-Bus conversation, shared by the synchronous and asynchronous
 * drivers. Each yield is one gdbus call; the driver sends back its trimmed reply.
 */
function* secretServiceProbe(): Generator<
  GdbusCall,
  SecretServiceState,
  string
> {
  const ownerReply = yield {
    destination: 'org.freedesktop.DBus',
    objectPath: '/org/freedesktop/DBus',
    method: 'org.freedesktop.DBus.GetNameOwner',
    args: ['org.freedesktop.secrets'],
  };
  const owner = /^\('(:[0-9]+\.[0-9]+)',\)$/.exec(ownerReply)?.[1];
  if (!owner) return 'unavailable';
  // Bind both observations to this provider. A daemon replacement must not
  // combine an old alias with a different provider's collection state.
  const aliasReply = yield {
    destination: owner,
    objectPath: '/org/freedesktop/secrets',
    method: 'org.freedesktop.Secret.Service.ReadAlias',
    args: ['default'],
  };
  const collection = /^\(objectpath '((?:\/[A-Za-z0-9_]+)+)',\)$/.exec(
    aliasReply,
  )?.[1];
  if (!collection) return 'unavailable';
  const locked = yield {
    destination: owner,
    objectPath: collection,
    method: 'org.freedesktop.DBus.Properties.Get',
    args: ['org.freedesktop.Secret.Collection', 'Locked'],
  };
  if (locked === '(<true>,)') return 'locked';
  if (locked === '(<false>,)') return 'secure';
  return 'unavailable';
}

function call(request: GdbusCall, deadline: number): string {
  // Keep this bounded: the native safeStorage facade is synchronous too.
  return execFileSync('/usr/bin/gdbus', gdbusArgs(request), {
    ...gdbusOptions(remainingTimeout(deadline)),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function callAsync(request: GdbusCall, deadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      '/usr/bin/gdbus',
      gdbusArgs(request),
      gdbusOptions(remainingTimeout(deadline)),
      (error, stdout) => {
        // Native diagnostics never leave this adapter.
        if (error) reject(new Error('Secret Service probe failed'));
        else resolve(stdout.trim());
      },
    );
    // gdbus never reads stdin; close it rather than leave a pipe open.
    child.stdin?.end();
  });
}

/** Read the real provider and default collection on every attempt. No unlock UI. */
export function getLinuxSecretServiceState(): SecretServiceState {
  try {
    const deadline = performance.now() + PROBE_DEADLINE_MS;
    const probe = secretServiceProbe();
    let step = probe.next();
    while (!step.done) step = probe.next(call(step.value, deadline));
    return step.value;
  } catch {
    // Includes absent service/helper, malformed replies and bounded failures.
    // Never expose native diagnostics to credential consumers or logs.
    return 'unavailable';
  }
}

/**
 * The same bounded probe without blocking the main thread on D-Bus replies.
 * Never rejects; failures classify as `unavailable` exactly like the sync probe.
 */
export async function getLinuxSecretServiceStateAsync(): Promise<SecretServiceState> {
  try {
    const deadline = performance.now() + PROBE_DEADLINE_MS;
    const probe = secretServiceProbe();
    let step = probe.next();
    while (!step.done) step = probe.next(await callAsync(step.value, deadline));
    return step.value;
  } catch {
    return 'unavailable';
  }
}

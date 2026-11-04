import { execFileSync } from 'node:child_process';
import { getLinuxProbeEnv } from '@canopy/desktop-shared/pipelines/config-paths';

type SecretServiceState = 'secure' | 'unavailable' | 'locked';

function call(
  destination: string,
  objectPath: string,
  method: string,
  args: readonly string[],
  deadline: number,
): string {
  const timeout = Math.ceil(deadline - performance.now());
  if (timeout <= 0) throw new Error('Secret Service probe deadline');
  // Fixed OS adapter helper: intentionally bypass user/bundled binary lookup
  // and getEnhancedEnv() to avoid PATH substitution and secret-injection recursion.
  // See the fixed-system-helper exception in bundled-runtime-maintenance.md.
  // No shell, activation, or secrets in argv/output.
  // Keep this bounded: the native safeStorage facade is synchronous too.
  return execFileSync(
    '/usr/bin/gdbus',
    [
      'call',
      '--session',
      '--dest',
      destination,
      '--object-path',
      objectPath,
      '--method',
      method,
      '--timeout',
      '1',
      ...args,
    ],
    {
      encoding: 'utf8',
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 4096,
      env: getLinuxProbeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

/** Read the real provider and default collection on every attempt. No unlock UI. */
export function getLinuxSecretServiceState(): SecretServiceState {
  try {
    const deadline = performance.now() + 1500;
    const ownerReply = call(
      'org.freedesktop.DBus',
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus.GetNameOwner',
      ['org.freedesktop.secrets'],
      deadline,
    );
    const owner = /^\('(:[0-9]+\.[0-9]+)',\)$/.exec(ownerReply)?.[1];
    if (!owner) return 'unavailable';
    // Bind both observations to this provider. A daemon replacement must not
    // combine an old alias with a different provider's collection state.
    const aliasReply = call(
      owner,
      '/org/freedesktop/secrets',
      'org.freedesktop.Secret.Service.ReadAlias',
      ['default'],
      deadline,
    );
    const collection = /^\(objectpath '((?:\/[A-Za-z0-9_]+)+)',\)$/.exec(
      aliasReply,
    )?.[1];
    if (!collection) return 'unavailable';
    const locked = call(
      owner,
      collection,
      'org.freedesktop.DBus.Properties.Get',
      ['org.freedesktop.Secret.Collection', 'Locked'],
      deadline,
    );
    if (locked === '(<true>,)') return 'locked';
    if (locked === '(<false>,)') return 'secure';
  } catch {
    // Includes absent service/helper, malformed replies and bounded failures.
    // Never expose native diagnostics to credential consumers or logs.
  }
  return 'unavailable';
}

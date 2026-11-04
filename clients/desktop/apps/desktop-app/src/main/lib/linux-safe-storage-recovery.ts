import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { SecureStorageFailure } from '@canopy/desktop-shared/types/secure-storage';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  encodeLinuxSafeStorageMessage,
  LINUX_SAFE_STORAGE_HELPER_MODE,
  LINUX_SAFE_STORAGE_HELPER_PROFILE,
  LINUX_SAFE_STORAGE_MAX_BYTES,
  LINUX_SAFE_STORAGE_PROFILE_PREFIX,
  parseLinuxSafeStorageResponse,
  type LinuxSafeStorageRequest,
  type LinuxSafeStorageResponse,
} from './linux-safe-storage-helper-protocol';
import { isRecord } from './type-guards';

function unavailable(
  operation: 'read' | 'write' = 'write',
  genuineDecryptFailure = false,
): Error {
  // Deliberately no native cause, command, stdout/stderr, ciphertext or plaintext.
  const secureStorageFailure: SecureStorageFailure = Object.freeze({
    version: 1,
    code: genuineDecryptFailure
      ? 'SECURE_STORAGE_DECRYPT_FAILED'
      : operation === 'read'
        ? 'SECURE_STORAGE_READ_UNAVAILABLE'
        : 'SECURE_STORAGE_WRITE_REFUSED',
    operation,
    state: genuineDecryptFailure ? 'secure' : 'unavailable',
    backend: 'gnome_libsecret',
    retryable: !genuineDecryptFailure,
  });
  return Object.assign(new Error('Secure storage recovery unavailable.'), {
    secureStorageFailure,
  });
}

interface RecoveryApp {
  isReady: () => unknown;
  readonly isPackaged: boolean;
  getAppPath: () => unknown;
}

function isRecoveryApp(value: unknown): value is RecoveryApp {
  return (
    isRecord(value) &&
    typeof value.isReady === 'function' &&
    typeof value.isPackaged === 'boolean' &&
    typeof value.getAppPath === 'function'
  );
}

function applicationArgs(): string[] | null {
  if (
    hostOperatingSystem() !== 'linux' ||
    typeof process.versions.electron !== 'string' ||
    Reflect.get(process, 'type') !== 'browser' ||
    !isAbsolute(process.execPath)
  )
    return null;
  // Keep Electron lazy: ordinary Node and unit-test Electron fakes must never spawn.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron: unknown = require('electron');
  if (!isRecord(electron) || !isRecoveryApp(electron.app)) return null;
  const app = electron.app;
  if (app.isReady() !== true) return null;
  if (app.isPackaged === true) return [];
  const path: unknown = app.getAppPath();
  return typeof path === 'string' && isAbsolute(path) ? [path] : null;
}

function helperEnvironment(profile: string): Record<string, string> {
  // This adapter must not run getEnhancedEnv: credential injection would recurse.
  // Only desktop/session/locale metadata is needed, never inherited app tokens or
  // Node, Electron, dynamic-loader or shell startup injection configuration.
  const allowed = new Set([
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_ADDRESS',
    'LC_COLLATE',
    'LC_CTYPE',
    'LC_IDENTIFICATION',
    'LC_MEASUREMENT',
    'LC_MESSAGES',
    'LC_MONETARY',
    'LC_NAME',
    'LC_NUMERIC',
    'LC_PAPER',
    'LC_TELEPHONE',
    'LC_TIME',
    'TMPDIR',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'XDG_CURRENT_DESKTOP',
    'DESKTOP_SESSION',
    'KDE_SESSION_VERSION',
    'XDG_DATA_DIRS',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(key)) {
      env[key] = value;
    }
  }
  env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  env[LINUX_SAFE_STORAGE_HELPER_MODE] = '1';
  env[LINUX_SAFE_STORAGE_HELPER_PROFILE] = profile;
  return env;
}

function invoke(
  request: LinuxSafeStorageRequest,
): LinuxSafeStorageResponse | null {
  let profile: string | undefined;
  try {
    const args = applicationArgs();
    if (args === null) return null;
    const input = encodeLinuxSafeStorageMessage(request);
    profile = mkdtempSync(join(tmpdir(), LINUX_SAFE_STORAGE_PROFILE_PREFIX));
    chmodSync(profile, 0o700);
    // Same trusted Electron executable/app.asar, no Chromium switches or external
    // script. Every call gets fresh native state and an isolated disposable profile.
    const child = spawnSync(process.execPath, args, {
      input,
      stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
      timeout: 8000,
      killSignal: 'SIGKILL',
      maxBuffer: LINUX_SAFE_STORAGE_MAX_BYTES,
      env: helperEnvironment(profile),
    });
    if (child.error || child.status !== 0 || child.signal !== null) return null;
    const wire = child.output[3];
    if (!Buffer.isBuffer(wire)) return null;
    const response = parseLinuxSafeStorageResponse(wire);
    if (response?.ok === false) {
      return response.reason === 'unavailable' ||
        request.operation === 'decrypt'
        ? response
        : null;
    }
    return response?.operation === request.operation ? response : null;
  } catch {
    return null;
  } finally {
    // Never remove an existing app profile or a path reported by the child.
    // spawnSync returns only after exit, including timeout/SIGKILL.
    if (profile !== undefined) {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Best effort, no diagnostics. */
      }
    }
  }
}

/** A fresh child probe, not a cache of native keys or plaintext. */
export function probeLinuxSafeStorageRecovery(): boolean {
  return invoke({ version: 1, operation: 'probe' })?.ok === true;
}

export function encryptWithLinuxSafeStorageRecovery(text: string): Buffer {
  if (typeof text !== 'string') throw unavailable();
  const response = invoke({ version: 1, operation: 'encrypt', text });
  if (response?.ok !== true || response.operation !== 'encrypt')
    throw unavailable();
  const ciphertext = Buffer.from(response.ciphertext, 'base64');
  if (text !== '' && ciphertext.subarray(0, 3).toString('ascii') !== 'v11')
    throw unavailable();
  if (text === '' && ciphertext.length !== 0) throw unavailable();
  return ciphertext;
}

export function decryptWithLinuxSafeStorageRecovery(
  ciphertext: Buffer,
): string {
  if (
    !Buffer.isBuffer(ciphertext) ||
    ciphertext.length > LINUX_SAFE_STORAGE_MAX_BYTES
  )
    throw unavailable('read');
  const response = invoke({
    version: 1,
    operation: 'decrypt',
    ciphertext: ciphertext.toString('base64'),
  });
  if (response?.ok === false && response.reason === 'decrypt-failed')
    throw unavailable('read', true);
  if (response?.ok !== true || response.operation !== 'decrypt')
    throw unavailable('read');
  return response.text;
}

// Standalone Electron entry. Never import the app facade, policy or bootstrap.
import { app, safeStorage } from 'electron';
import { fstatSync, lstatSync, readSync, writeSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { getRuntimeAppName } from './app-identity';
import { getLinuxSecretServiceState } from './linux-secret-service';
import {
  encodeLinuxSafeStorageMessage,
  LINUX_SAFE_STORAGE_HELPER_MODE,
  LINUX_SAFE_STORAGE_HELPER_PROFILE,
  LINUX_SAFE_STORAGE_MAX_BYTES,
  LINUX_SAFE_STORAGE_PROFILE_PREFIX,
  parseLinuxSafeStorageRequest,
  type LinuxSafeStorageResponse,
} from './linux-safe-storage-helper-protocol';

function readRequest(): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(
      Math.min(64 * 1024, LINUX_SAFE_STORAGE_MAX_BYTES + 1 - total),
    );
    const size = readSync(0, chunk, 0, chunk.length, null);
    if (size === 0) return Buffer.concat(chunks, total);
    total += size;
    if (total > LINUX_SAFE_STORAGE_MAX_BYTES)
      throw new Error('Invalid helper request.');
    chunks.push(chunk.subarray(0, size));
  }
}

function privateProfile(): string {
  const profile = process.env[LINUX_SAFE_STORAGE_HELPER_PROFILE];
  if (
    !profile ||
    !isAbsolute(profile) ||
    !basename(profile).startsWith(LINUX_SAFE_STORAGE_PROFILE_PREFIX)
  ) {
    throw new Error('Invalid helper profile.');
  }
  const stat = lstatSync(profile);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    typeof process.getuid !== 'function' ||
    stat.uid !== process.getuid()
  ) {
    throw new Error('Invalid helper profile.');
  }
  return profile;
}

async function perform(): Promise<LinuxSafeStorageResponse> {
  if (
    hostOperatingSystem() !== 'linux' ||
    typeof process.versions.electron !== 'string' ||
    Reflect.get(process, 'type') !== 'browser' ||
    process.env[LINUX_SAFE_STORAGE_HELPER_MODE] !== '1' ||
    app.isReady()
  ) {
    return { version: 1, ok: false, reason: 'unavailable' };
  }
  const request = parseLinuxSafeStorageRequest(readRequest());
  if (!request) return { version: 1, ok: false, reason: 'unavailable' };
  const profile = privateProfile();
  // Constructing safeStorage also schedules Chromium's async initialization.
  // Refuse before that construction as well as after readiness; neither check
  // requests an unlock prompt from a missing/locked provider.
  if (getLinuxSecretServiceState() !== 'secure')
    return { version: 1, ok: false, reason: 'unavailable' };
  // Identical native key identity, but never share the live Electron profile.
  // Build-time brand/release constants are the same as the normal app bundle.
  app.setName(getRuntimeAppName());
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  // Reuse the production backend policy, not an override or insecure fallback.
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
  safeStorage.setUsePlainTextEncryption(false);
  await app.whenReady();
  if (
    getLinuxSecretServiceState() !== 'secure' ||
    !safeStorage.isEncryptionAvailable() ||
    safeStorage.getSelectedStorageBackend() !== 'gnome_libsecret'
  ) {
    return { version: 1, ok: false, reason: 'unavailable' };
  }
  if (request.operation === 'probe') {
    return { version: 1, ok: true, operation: 'probe' };
  }
  if (request.operation === 'encrypt') {
    const ciphertext = safeStorage.encryptString(request.text);
    if (
      (request.text === '' && ciphertext.length !== 0) ||
      (request.text !== '' &&
        ciphertext.subarray(0, 3).toString('ascii') !== 'v11')
    ) {
      return { version: 1, ok: false, reason: 'unavailable' };
    }
    return {
      version: 1,
      ok: true,
      operation: 'encrypt',
      ciphertext: ciphertext.toString('base64'),
    };
  }
  const ciphertext = Buffer.from(request.ciphertext, 'base64');
  let text: string;
  try {
    // Only this native cipher exception, after all secure preflight checks,
    // identifies unreadable ciphertext. Setup/transport failures stay retryable.
    text = safeStorage.decryptString(ciphertext);
  } catch {
    return {
      version: 1,
      ok: false,
      reason: 'decrypt-failed',
      operation: 'decrypt',
    };
  }
  return { version: 1, ok: true, operation: 'decrypt', text };
}

/** One native operation and a synchronous private-pipe flush, then immediate exit. */
export async function runLinuxSafeStorageHelper(): Promise<void> {
  // fd 3 must be our inherited anonymous transport, never an accidentally
  // redirected regular file. Validate before reading any request/plaintext.
  try {
    const output = fstatSync(3);
    if (!output.isFIFO() && !output.isSocket()) {
      app.exit(1);
      return;
    }
  } catch {
    app.exit(1);
    return;
  }
  let response: LinuxSafeStorageResponse = {
    version: 1,
    ok: false,
    reason: 'unavailable',
  };
  let wire: string;
  try {
    response = await perform();
    wire = encodeLinuxSafeStorageMessage(response);
  } catch {
    response = { version: 1, ok: false, reason: 'unavailable' };
    wire = encodeLinuxSafeStorageMessage(response);
  }
  try {
    const bytes = Buffer.from(wire, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(3, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('Private helper pipe unavailable.');
      offset += written;
    }
  } catch {
    app.exit(1);
    return;
  }
  // Exit zero means the complete protocol response was flushed, not cipher success.
  app.exit(0);
}

// The generated main launcher dispatches here before loading the normal bundle.
if (process.env[LINUX_SAFE_STORAGE_HELPER_MODE] === '1') {
  void runLinuxSafeStorageHelper();
}

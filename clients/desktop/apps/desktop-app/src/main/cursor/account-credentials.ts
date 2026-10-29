import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../lib/type-guards';

const MAX_AUTH_BYTES = 64 * 1024;

/** Mirrors the pinned CLI's credential store. Never copies or persists tokens. */
export async function readCursorAccessToken(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  signal.throwIfAborted();
  if (platform === 'darwin') {
    return new Promise((resolve) => {
      execFile(
        '/usr/bin/security',
        [
          'find-generic-password',
          '-a',
          'cursor-user',
          '-s',
          'cursor-access-token',
          '-w',
        ],
        {
          env,
          signal,
          timeout: 10_000,
          maxBuffer: MAX_AUTH_BYTES,
          encoding: 'utf8',
        },
        (error, stdout) => resolve(error ? null : stdout.trim() || null),
      );
    });
  }
  // Windows' native CLI uses APPDATA/Cursor/auth.json, including the private
  // APPDATA overlay used by managed Connect. Never read a different installation.
  if (platform !== 'win32' || !env.APPDATA) return null;
  const file = await open(join(env.APPDATA, 'Cursor', 'auth.json'), 'r').catch(
    () => null,
  );
  if (!file) return null;
  try {
    const buffer = Buffer.alloc(MAX_AUTH_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    signal.throwIfAborted();
    if (bytesRead > MAX_AUTH_BYTES) return null;
    const value: unknown = JSON.parse(
      buffer.subarray(0, bytesRead).toString('utf8'),
    );
    return isRecord(value) && typeof value.accessToken === 'string'
      ? value.accessToken.trim() || null
      : null;
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

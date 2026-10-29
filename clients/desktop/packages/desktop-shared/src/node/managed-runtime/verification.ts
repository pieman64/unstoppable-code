import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat } from 'node:fs/promises';

/** Bounded streaming verification of the exact native binary pinned in the manifest. */
export async function verifyManagedExecutable(
  file: string,
  expectedSha256: string,
  signal: AbortSignal,
  label: string,
): Promise<void> {
  signal.throwIfAborted();
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.size > 600 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(expectedSha256)
  )
    throw new Error(
      `${label} runtime verification failed. Reconnect ${label} in Settings.`,
    );
  if (process.platform !== 'win32') await access(file, constants.X_OK);
  const hash = createHash('sha256');
  const stream = createReadStream(file, { signal });
  const chunks: AsyncIterable<unknown> = stream;
  let bytes = 0;
  for await (const chunk of chunks) {
    if (!Buffer.isBuffer(chunk))
      throw new Error(`${label} runtime verification received invalid bytes.`);
    bytes += chunk.length;
    if (bytes > 600 * 1024 * 1024)
      throw new Error(`${label} runtime exceeds its size limit.`);
    hash.update(chunk);
  }
  signal.throwIfAborted();
  if (hash.digest('hex') !== expectedSha256)
    throw new Error(
      `${label} runtime verification failed. Reconnect ${label} in Settings.`,
    );
}

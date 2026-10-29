import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';

export const MAX_FILE_BYTES = 64 * 1024;
export function validRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 2048 &&
    !isAbsolute(value) &&
    !win32.isAbsolute(value) &&
    !value.includes('\\') &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32) &&
    !value
      .split('/')
      .some((p) => !p || p === '.' || p === '..' || p.includes(':'))
  );
}
export function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}
/** Reject links at every component, including in-root aliases, to avoid cycles. */
export async function safePath(root: string, path: string): Promise<string> {
  if (!validRelativePath(path)) throw new Error('unsafe-path');
  const canonical = await realpath(root);
  let current = canonical;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('unsafe-path');
    if (!contained(canonical, await realpath(current)))
      throw new Error('unsafe-path');
  }
  return current;
}
export async function readBounded(
  root: string,
  path: string,
  limit = MAX_FILE_BYTES,
): Promise<string> {
  return (await readBoundedBytes(root, path, limit)).toString('utf8');
}
export async function readBoundedBytes(
  root: string,
  path: string,
  limit = MAX_FILE_BYTES,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await safePath(root, path);
  const expected = await lstat(file);
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let result: Buffer;
  try {
    const before = await handle.stat();
    if (before.dev !== expected.dev || before.ino !== expected.ino)
      throw new Error('changed');
    if (!before.isFile()) throw new Error('unsafe-path');
    if (before.size > limit) throw new Error('too-large');
    const data = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < data.length) {
      signal?.throwIfAborted();
      const read = await handle.read(
        data,
        length,
        data.length - length,
        length,
      );
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > limit) throw new Error('too-large');
    const after = await handle.stat();
    const reopened = await safePath(root, path)
      .then((file) => lstat(file))
      .catch(() => {
        throw new Error('changed');
      });
    if (
      before.dev !== reopened.dev ||
      before.ino !== reopened.ino ||
      after.size !== reopened.size ||
      after.mtimeMs !== reopened.mtimeMs ||
      after.ctimeMs !== reopened.ctimeMs ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      length !== before.size
    )
      throw new Error('changed');
    result = data.subarray(0, length);
  } finally {
    await handle.close();
  }
  signal?.throwIfAborted();
  return result;
}

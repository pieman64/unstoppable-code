import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';

/** Read bounded head/tail evidence even when B did not reach its first stage. */
export function readCredentialProfileDiagnostic(
  file: string,
  limit = 4096,
): string {
  const label = `credential-profile diagnostic=${basename(file)}`;
  try {
    const handle = openSync(file, 'r');
    try {
      const { size } = fstatSync(handle);
      if (size === 0) return `${label} state=empty`;
      const head = Buffer.alloc(Math.min(size, limit));
      if (size <= limit) {
        const count = readSync(handle, head, 0, head.length, 0);
        return `${label} state=content\n${head.toString('utf8', 0, count)}`;
      }
      const half = Math.floor(limit / 2);
      const first = readSync(handle, head, 0, half, 0);
      const last = readSync(handle, head, half, half, size - half);
      return `${label} state=truncated bytes=${size}\n${head.toString('utf8', 0, first)}\n[diagnostic truncated]\n${head.toString('utf8', half, half + last)}`;
    } finally {
      closeSync(handle);
    }
  } catch (error) {
    const code: unknown =
      typeof error === 'object' && error !== null
        ? Reflect.get(error, 'code')
        : undefined;
    return `${label} state=${code === 'ENOENT' ? 'missing' : 'read-refused'}`;
  }
}

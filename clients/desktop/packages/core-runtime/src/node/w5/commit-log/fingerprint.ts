import { createHash } from 'node:crypto';

/** The fingerprint of a file's contents; null stands for an absent file. */
export function fingerprintW5File(contents: string | null): string | null {
  return contents === null
    ? null
    : createHash('sha256').update(contents, 'utf8').digest('hex');
}

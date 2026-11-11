import { sep } from 'node:path';

/**
 * A root-relative path for this worker's filesystem, not a portable bundle.
 * POSIX backslashes are literal filename characters. Windows keeps the
 * canonical `/`-only spelling, so backslashes cannot hide path traversal.
 */
export function isSafeFilesystemRelativePath(
  value: string,
  maxLength = 4096,
): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    !value.startsWith('/') &&
    (sep !== '\\' || !value.includes('\\')) &&
    !value.includes('\0') &&
    // Retain refusal of legacy Windows traversal spellings on every host.
    !value.split('\\').includes('..') &&
    !/^[A-Za-z]:/.test(value) &&
    value
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

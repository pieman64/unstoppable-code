import { basename, dirname, normalize, parse, sep } from 'node:path';

/*
 * The folder a cloud project setup (CAN-5192) puts its project folder in.
 * A filesystem root (`/`, a Windows drive `D:\`, a UNC share
 * `\\server\share\`) keeps its separator: without it a drive is
 * drive-relative (`D:folder`) and a share root is not in normal form.
 */

const TRAILING_SEPARATORS = sep === '\\' ? /[\\/]+$/ : /\/+$/;

/** The destination in normal form, without a trailing separator unless it is a root. */
export function normalizeDestinationRoot(raw: string): string {
  const normalized = normalize(raw);
  return normalized === parse(normalized).root
    ? normalized
    : normalized.replace(TRAILING_SEPARATORS, '');
}

/** Whether `path` names a folder directly inside the destination `root`. */
export function isDestinationEntry(root: string, path: string): boolean {
  return (
    path !== root &&
    normalize(path) === path &&
    dirname(path) === root &&
    basename(path) !== ''
  );
}

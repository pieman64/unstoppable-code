/*
 * The deterministic, path-free retry identity of a trusted host path
 * (CAN-5428, W5a3). No host path crosses a W5 wire operation (D8): the
 * trusted host adapter that projects a picker selection or root grant to a
 * local path puts this token in the keyed parameters instead, so the
 * parameter fingerprint covers the path without core or the wire carrying
 * it. Existing in-process callers keep hashing their admitted paths
 * directly, so their saved receipt fingerprints are unchanged.
 *
 * The projection is lexical and only equates spellings the host's own path
 * resolution equates: repeated and trailing separators, `.` segments, and a
 * Windows drive letter's case. Win32 also folds `..`, as Windows does before
 * it resolves links; posix keeps `..`, since the kernel resolves it from a
 * symlink's target. It never reads the filesystem, so symlinks and case stay
 * distinct. A spelling it does not equate can only refuse a retry as
 * key-reused, never replay another folder's outcome.
 */
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';

/** How the trusted host spells its paths. */
export type W5HostPathFlavor = 'posix' | 'win32';

const TOKEN_PREFIX = 'host-path:v1:sha256:';
const DRIVE_ROOTED = /^[A-Za-z]:[\\/]/;
const UNC_ROOTED = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/;
/** `\\?\` and `\\.\`: Windows passes these through unnormalized. */
const DEVICE_NAMESPACE = /^[\\/]{2}[?.][\\/]/;

/** A trusted host passed a path it has not projected to an ordinary absolute one. */
export class W5HostPathProjectionError extends Error {
  constructor(readonly flavor: W5HostPathFlavor) {
    super(`A trusted ${flavor} host path must be an ordinary absolute path.`);
    this.name = 'W5HostPathProjectionError';
  }
}

function withoutTrailingSeparator(path: string, root: string): string {
  let end = path.length;
  while (end > root.length && (path[end - 1] === '/' || path[end - 1] === '\\'))
    end -= 1;
  return path.slice(0, end);
}

function normalizePosix(path: string): string {
  if (!path.startsWith('/') || path.includes('\0'))
    throw new W5HostPathProjectionError('posix');
  const segments = path
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  return `/${segments.join('/')}`;
}

/** Drive-absolute or UNC only: a rooted path without a drive is relative to one. */
function normalizeWin32(path: string): string {
  if (
    (!DRIVE_ROOTED.test(path) && !UNC_ROOTED.test(path)) ||
    DEVICE_NAMESPACE.test(path) ||
    path.includes('\0')
  )
    throw new W5HostPathProjectionError('win32');
  const normalized = win32.normalize(path);
  const drive = /^[a-z]:/.test(normalized)
    ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
    : normalized;
  return withoutTrailingSeparator(drive, win32.parse(drive).root);
}

/** The lexical form the fingerprint hashes; exported for diagnostics and tests. */
export function normalizeW5HostPath(
  path: string,
  flavor: W5HostPathFlavor,
): string {
  return flavor === 'posix' ? normalizePosix(path) : normalizeWin32(path);
}

/**
 * `host-path:v1:sha256:<hex>` over the flavor and normalized path. Throws
 * {@link W5HostPathProjectionError} for a relative path.
 */
export function projectW5HostPathFingerprint(
  path: string,
  flavor: W5HostPathFlavor,
): string {
  const normalized = normalizeW5HostPath(path, flavor);
  return `${TOKEN_PREFIX}${createHash('sha256')
    .update(`canopy.w5.host-path.v1\0${flavor}\0${normalized}`, 'utf8')
    .digest('hex')}`;
}

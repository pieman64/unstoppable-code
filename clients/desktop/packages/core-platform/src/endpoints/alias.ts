import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  PlatformOperatingSystem,
  PlatformSocketAlias,
} from '@canopy/core-runtime';

/*
 * Long data roots (CAN-5694). A Unix socket path is limited to about 104
 * bytes, so a root whose `runtime/core.sock` is longer is reached through a
 * short per-user link instead: `<tmp>/canopy-<uid>/<hash>` points at the
 * root's runtime directory, and the socket is bound and reached as
 * `<link>/core.sock`. The socket itself never leaves the private runtime
 * directory. The temporary root is fixed, never `TMPDIR`, so every client and
 * the daemon agree on the path whatever their environment.
 */

const ALIAS_ROOT: Record<'darwin' | 'linux', string> = {
  darwin: '/private/tmp',
  linux: '/tmp',
};

/** Fixed messages only: no paths or owners. */
export class EndpointAliasError extends Error {
  override readonly name = 'EndpointAliasError';
  readonly code = 'failed_precondition';
}

function code(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function socketAlias(
  os: Exclude<PlatformOperatingSystem, 'win32'>,
  dataRoot: string,
  runtimeDirectory: string,
  uid: number,
  aliasRoot: string = ALIAS_ROOT[os],
): PlatformSocketAlias {
  const directory = path.posix.join(aliasRoot, `canopy-${uid}`);
  const hash = createHash('sha256')
    .update(path.posix.resolve(dataRoot))
    .digest('hex')
    .slice(0, 16);
  return {
    directory,
    link: path.posix.join(directory, hash),
    runtimeDirectory,
  };
}

async function privateDirectory(directory: string, uid: number): Promise<void> {
  const refuse = (): never => {
    throw new EndpointAliasError('Endpoint alias directory is not private.');
  };
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (code(error) !== 'EEXIST') refuse();
  }
  const before = await lstat(directory).catch(refuse);
  if (!before.isDirectory() || before.uid !== uid) refuse();
  // A umask may narrow the mode of a directory this call created; never widen one it found.
  if (created) await chmod(directory, 0o700).catch(refuse);
  const stat = created ? await lstat(directory).catch(refuse) : before;
  if (
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700 ||
    stat.dev !== before.dev ||
    stat.ino !== before.ino
  )
    refuse();
}

async function verifyLink(
  alias: PlatformSocketAlias,
  uid: number,
): Promise<void> {
  const refuse = (): never => {
    throw new EndpointAliasError('Endpoint alias is foreign.');
  };
  const stat = await lstat(alias.link).catch(refuse);
  if (!stat.isSymbolicLink() || stat.uid !== uid) refuse();
  if ((await realpath(alias.link).catch(refuse)) !== alias.runtimeDirectory)
    refuse();
}

/**
 * Whether the runtime directory the alias names exists. Without it no socket
 * can be bound there, so callers report the endpoint absent instead of
 * linking to a missing directory.
 */
export async function socketAliasTargetPresent(
  alias: PlatformSocketAlias,
): Promise<boolean> {
  try {
    await lstat(alias.runtimeDirectory);
    return true;
  } catch (error) {
    return code(error) !== 'ENOENT';
  }
}

/**
 * Verifies the alias, creating the directory or link when absent. The
 * directory must be a real directory the user owns with mode 0700, and the
 * link must be the user's and resolve to exactly this root's runtime
 * directory. An existing link that resolves elsewhere is refused, never
 * repointed.
 */
export async function ensureSocketAlias(
  alias: PlatformSocketAlias,
  uid: number,
): Promise<void> {
  // Never leave a dangling link to a runtime directory that does not exist yet.
  if (!(await socketAliasTargetPresent(alias)))
    throw new EndpointAliasError('Endpoint alias target is absent.');
  await privateDirectory(alias.directory, uid);
  try {
    // Atomic and never replacing: a link already there is verified instead.
    await symlink(alias.runtimeDirectory, alias.link);
  } catch (error) {
    if (code(error) !== 'EEXIST')
      throw new EndpointAliasError('Endpoint alias could not be created.');
  }
  await verifyLink(alias, uid);
}

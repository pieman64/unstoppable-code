import type { RmOptions } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

/** The filesystem calls checkout cleanup makes on directories it removes. */
const nodeFs = { lstat, readdir, rm };

type AsarFreeFs = typeof nodeFs;

let originalFs: AsarFreeFs | null = null;

/** Shape check only: confirms the calls exist, not how they treat asar. */
function isAsarFreeFs(value: unknown): value is AsarFreeFs {
  return (
    typeof value === 'object' &&
    value !== null &&
    'lstat' in value &&
    typeof value.lstat === 'function' &&
    'readdir' in value &&
    typeof value.readdir === 'function' &&
    'rm' in value &&
    typeof value.rm === 'function'
  );
}

function loadOriginalFs(): AsarFreeFs {
  if (!originalFs) {
    // Resolved at runtime so the bundler leaves Electron's built-in
    // `original-fs` module as a plain require.
    const loaded: unknown = createRequire(__filename)('original-fs');
    if (
      typeof loaded !== 'object' ||
      loaded === null ||
      !('promises' in loaded) ||
      !isAsarFreeFs(loaded.promises)
    ) {
      // Deliberately no fallback to the patched `fs`: it would bring back the
      // ENOTEMPTY failure this module exists to prevent, with a worse message.
      throw new Error('Electron original-fs is unavailable.');
    }
    originalFs = loaded.promises;
  }
  return originalFs;
}

/**
 * Returns filesystem calls that treat `*.asar` files as plain files.
 *
 * Electron patches `fs` so `*.asar` files behave like read-only folders. Its
 * unpatched `original-fs` sees them as files. Plain Node (Jest, CLI) has no
 * asar patching, and a process that set `process.noAsar` has already turned
 * the redirection off, so the regular `fs` is used in both.
 */
export function fsWithoutAsar(): AsarFreeFs {
  if (process.versions.electron && !process.noAsar) {
    return loadOriginalFs();
  }
  return nodeFs;
}

/**
 * Removes a directory tree that may contain checkout contents.
 *
 * A patched recursive `rm` descends into `*.asar` files instead of unlinking
 * them, and the parent `rmdir` then fails with ENOTEMPTY (for example
 * `node_modules/electron/dist/.../default_app.asar`). Removing through
 * {@link fsWithoutAsar} unlinks them as plain files.
 */
export async function removeTreeWithoutAsar(
  path: string,
  options?: RmOptions,
): Promise<void> {
  await fsWithoutAsar().rm(path, options);
}

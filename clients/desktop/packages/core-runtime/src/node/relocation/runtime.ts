import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RelocationRefusedError,
  type RelocationTransition,
} from './transition';

import { assertRelocationWorkingRoot } from './working-root';

async function ordinaryDirectory(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path)
      throw new RelocationRefusedError('noncanonical-runtime-directory');
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return false;
    throw error;
  }
}

/** Cold worker effect only. Ordinary owners mint new endpoints/keys/config at next launch. */
export async function discardRelocatedRuntime(
  transition: RelocationTransition,
  workingRoot: string,
): Promise<void> {
  await assertRelocationWorkingRoot(transition, workingRoot);
  const dataRoot = workingRoot;
  if (!(await ordinaryDirectory(dataRoot)))
    throw new RelocationRefusedError('missing-destination');
  const runtime = join(dataRoot, 'runtime');
  if (await ordinaryDirectory(runtime)) {
    // W5 maintenance, cohort and permanent lock evidence also lives here.
    for (const file of await readdir(runtime)) {
      if (
        file === 'core.sock' ||
        file === 'core.json' ||
        /^core-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.token$/.test(file)
      )
        await rm(join(runtime, file));
    }
  }
  const proxy = join(dataRoot, 'account-proxy-local');
  if (await ordinaryDirectory(proxy)) {
    for (const file of await readdir(proxy)) {
      if (
        file === 'process.json' ||
        file === 'key.json' ||
        file === 'config.yaml' ||
        /^config-[A-Za-z0-9-]+\.yaml$/.test(file)
      )
        await rm(join(proxy, file));
    }
  }
}

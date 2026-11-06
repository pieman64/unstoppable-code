import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  isWithin,
  RelocationRefusedError,
  type RelocationTransition,
} from './transition';

/** A private sibling copy that B will publish by rename, never a canonical identity. */
export function relocationWorkingPath(
  transition: RelocationTransition,
  workingRoot: string,
  finalPath: string,
): string {
  const source = transition.from.canonicalDataRoot;
  const destination = transition.to.canonicalDataRoot;
  if (
    !isAbsolute(workingRoot) ||
    resolve(workingRoot) !== workingRoot ||
    workingRoot === destination ||
    dirname(workingRoot) !== dirname(destination) ||
    isWithin(source, workingRoot) ||
    isWithin(workingRoot, source)
  )
    throw new RelocationRefusedError('invalid-working-root');
  return isWithin(destination, finalPath)
    ? resolve(workingRoot, relative(destination, finalPath))
    : finalPath;
}

export async function assertRelocationWorkingRoot(
  transition: RelocationTransition,
  workingRoot: string,
): Promise<void> {
  relocationWorkingPath(
    transition,
    workingRoot,
    transition.to.canonicalDataRoot,
  );
  if (
    !(await lstat(workingRoot)).isDirectory() ||
    (await realpath(workingRoot)) !== workingRoot
  )
    throw new RelocationRefusedError('noncanonical-destination');
}

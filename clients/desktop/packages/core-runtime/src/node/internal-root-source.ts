import { isAbsolute, resolve } from 'node:path';
import { isWithin } from './relocation/transition';

/** Lexical only: completed startup must never reopen the retained source. */
export function internalRootSourceIsSeparate(
  source: string,
  protectedPaths: readonly string[],
): boolean {
  return (
    !source.includes('\0') &&
    isAbsolute(source) &&
    resolve(source) === source &&
    isWithin(source, source) &&
    protectedPaths.every(
      (path) => !isWithin(source, path) && !isWithin(path, source),
    )
  );
}

import { isAbsolute, relative, resolve, sep } from 'node:path';

export class RelocationRefusedError extends Error {
  override readonly name = 'RelocationRefusedError';
  constructor(
    readonly reason: string,
    detail?: string,
  ) {
    super(
      `Installation relocation refused: ${reason}${detail ? ` (${detail})` : ''}`,
    );
  }
}

/** Observed by the trusted bootstrap host, never supplied by a client. */
export interface RelocationAuthority {
  readonly authorityId: string;
  readonly canonicalDataRoot: string;
}

export interface RelocationTransition {
  readonly version: 1;
  readonly installationId: string;
  readonly brandId: string;
  readonly from: RelocationAuthority;
  readonly to: RelocationAuthority;
}

export function isWithin(root: string, path: string): boolean {
  if (
    sep === '\\' &&
    [root, path].some(
      (value) =>
        !isAbsolute(value) || /^[\\/](?![\\/])|^[\\/]{2}[?.][\\/]/.test(value),
    )
  )
    return false;
  const suffix = relative(root, path);
  return (
    suffix === '' ||
    (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  );
}

/** Exact mapping to persist in B's non-moving journal before any repair. */
export function relocationTransition(
  input: RelocationTransition,
): RelocationTransition {
  for (const identity of [input.from, input.to]) {
    if (
      !/^[a-f0-9]{64}$/.test(identity.authorityId) ||
      !isAbsolute(identity.canonicalDataRoot) ||
      !isWithin(identity.canonicalDataRoot, identity.canonicalDataRoot) ||
      resolve(identity.canonicalDataRoot) !== identity.canonicalDataRoot
    )
      throw new RelocationRefusedError('invalid-authority-observation');
  }
  if (
    input.version !== 1 ||
    !input.installationId ||
    !input.brandId ||
    input.from.authorityId === input.to.authorityId ||
    isWithin(input.from.canonicalDataRoot, input.to.canonicalDataRoot) ||
    isWithin(input.to.canonicalDataRoot, input.from.canonicalDataRoot)
  )
    throw new RelocationRefusedError('invalid-transition');
  return Object.freeze({
    ...input,
    from: Object.freeze({ ...input.from }),
    to: Object.freeze({ ...input.to }),
  });
}

/** Only an enumerated owner's path may be projected; never walk JSON strings. */
export function movedOwnedPath(
  transition: RelocationTransition,
  path: string,
): string {
  if (!isAbsolute(path) || !isWithin(path, path) || resolve(path) !== path)
    throw new RelocationRefusedError('noncanonical-owned-path');
  return isWithin(transition.from.canonicalDataRoot, path)
    ? resolve(
        transition.to.canonicalDataRoot,
        relative(transition.from.canonicalDataRoot, path),
      )
    : path;
}

import { isHostAbsolutePath } from '@canopy/protocol/canopy-core';

/*
 * The path-free message rule of the W5 metadata commands' wire errors (W5d1,
 * CAN-5522), which the `core.workspace.*` A7 mapping applies
 * (`../../workspace/metadata-wire-errors.ts`). Kept apart from the files that
 * call the one-decision runner, whose only `core.*` literals are operation
 * names (RX2).
 */

const GENERIC_MESSAGE = 'This change was refused.';

/**
 * Where a host path (`isHostAbsolutePath`) or a home-relative one can start
 * inside a message: at its start or after any character a path or a name
 * cannot continue, so `path=/Users/…` and `(C:\…)` match.
 */
const PATH_START = /(?:^|[^\w.~-])(?:\/|~\/|[A-Za-z]:[\\/]|\\|file:)/i;

/** A message that can name a host path is replaced; a false match costs only its text. */
export function w5PathFreeMessage(message: string): string {
  return PATH_START.test(message) || isHostAbsolutePath(message)
    ? GENERIC_MESSAGE
    : message;
}

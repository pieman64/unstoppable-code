import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  type PlatformOperatingSystem,
  PlatformTrashError,
  type PlatformTrashErrorCode,
  type PlatformTrashServices,
} from '@canopy/core-runtime';
import { fullyQualified } from '../supervision/owned-child';

/** What a backend reports for one entry, before the identity re-check. */
export type TrashAttempt =
  | { readonly kind: 'moved' }
  | {
      readonly kind: 'refused';
      readonly code: Exclude<PlatformTrashErrorCode, 'unconfirmed'>;
      readonly reason: string;
    }
  /** The backend ended without a report it stands behind. */
  | { readonly kind: 'unfinished'; readonly reason: string };

export type TrashAttempter = (path: string) => Promise<TrashAttempt>;

/** Opens the host's backend: its attempter, or the fixed reason it has none. */
export type TrashBackend = () => TrashAttempter | string;

export interface TrashIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** The identity of the entry at `path` itself; `null` once nothing is there. */
export type InspectTrashEntry = (path: string) => Promise<TrashIdentity | null>;

const INVALID = 'Trash needs a normalized absolute path.';
const UNREADABLE = "The entry couldn't be read; nothing was moved.";
const IN_PLACE =
  'The trash reported the move, but the entry is still in place.';
const NOT_IN_PLACE = 'The entry is no longer at its path.';
const STILL_IN_PLACE = 'The entry is still in place.';
const THREW = 'The trash backend ended without a report.';
const NO_BACKEND = "The trash backend couldn't start; nothing was moved.";

const lstatIdentity: InspectTrashEntry = async (entry) => {
  try {
    const { dev, ino } = await lstat(entry, { bigint: true });
    return { dev, ino };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return null;
    throw error;
  }
};

/**
 * Absolute, well-formed UTF-16 (a lone surrogate matches no name), without
 * `.` or `..` segments, repeated or trailing separators, or (win32) forward
 * slashes, so the backend and the identity re-check name the same entry and
 * a trailing separator never resolves a link.
 */
function lexical(os: PlatformOperatingSystem, entry: unknown): entry is string {
  if (
    typeof entry !== 'string' ||
    /\p{Cs}/u.test(entry) ||
    !fullyQualified(os, entry)
  )
    return false;
  // Normalizing keeps a trailing separator, so the check is explicit. On
  // POSIX a backslash is an ordinary name character.
  const [host, trailing] =
    os === 'win32' ? [path.win32, /[\\/]$/] : [path.posix, /\/$/];
  return host.normalize(entry) === entry && !trailing.test(entry);
}

/**
 * Trash over one backend. A move resolves only when the backend reports it
 * and the entry is no longer in place. Anything else rejects, classified by
 * re-reading the entry's identity: still in place is the backend's refusal
 * (`unavailable` or `failed`), and no longer in place is `unconfirmed`,
 * since a helper that ended without a report may have moved it.
 */
export function createTrashServices(
  os: PlatformOperatingSystem,
  backend: TrashBackend,
  inspect: InspectTrashEntry = lstatIdentity,
): PlatformTrashServices {
  return {
    trashItem: async (entry) => {
      if (!lexical(os, entry)) throw new PlatformTrashError('failed', INVALID);
      let attempt: TrashAttempter | string;
      try {
        attempt = backend();
      } catch {
        attempt = NO_BACKEND;
      }
      if (typeof attempt === 'string')
        throw new PlatformTrashError('unavailable', attempt);
      let before: TrashIdentity | null;
      try {
        before = await inspect(entry);
      } catch {
        before = null;
      }
      if (before === null) throw new PlatformTrashError('failed', UNREADABLE);
      let reported: TrashAttempt;
      try {
        reported = await attempt(entry);
      } catch {
        reported = { kind: 'unfinished', reason: THREW };
      }
      let after: TrashIdentity | null | undefined;
      try {
        after = await inspect(entry);
      } catch {
        // Unknown either way; only a confirmed identity counts as in place.
        after = undefined;
      }
      const inPlace =
        after !== null &&
        after !== undefined &&
        after.dev === before.dev &&
        after.ino === before.ino;
      if (reported.kind === 'moved') {
        if (inPlace) throw new PlatformTrashError('failed', IN_PLACE);
        return;
      }
      if (!inPlace)
        throw new PlatformTrashError(
          'unconfirmed',
          `${reported.reason} ${NOT_IN_PLACE}`,
        );
      if (reported.kind === 'refused')
        throw new PlatformTrashError(reported.code, reported.reason);
      throw new PlatformTrashError(
        'failed',
        `${reported.reason} ${STILL_IN_PLACE}`,
      );
    },
  };
}

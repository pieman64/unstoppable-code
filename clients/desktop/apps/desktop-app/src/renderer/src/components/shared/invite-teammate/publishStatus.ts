import type { SharedContainerPublicationState } from '@canopy/desktop-shared/types';

/**
 * Which publish state to actually assert, given a local record and the
 * server's revision count.
 *
 * Precedence, and the reason for each step:
 *
 * 1. Local `publishing` / `error` win. They describe an attempt happening (or
 *    just failed) on *this* machine right now, which is newer than anything
 *    the last committed revision can tell us.
 * 2. Otherwise a server `revision >= 1` means published, even with no local
 *    record. Publish state is persisted only under the runtime-mode-split data
 *    dir (`~/.canopy` vs `~/.canopy-dev`), so a share published from one build
 *    has no local record in another. The server is the authority on whether a
 *    revision was ever committed.
 * 3. Otherwise a local `published` record means published.
 * 4. A server `revision === 0` means the container exists and has genuinely
 *    never been published.
 * 5. Otherwise a local `not-published` record means not published. This is the
 *    mirror of step 3: with no server answer available, an explicit local
 *    record is still a real observation, and it is the only thing that
 *    distinguishes "we know this has never been published" from "we have not
 *    heard".
 *
 * Steps 4 and 5 both resolve to `not-published`, but they do not mean the same
 * thing, and callers that render pending work must tell them apart by looking
 * at the local record rather than at this status. Step 5's record is written
 * by `sharedContainersInvite` alongside `scheduler.schedule()` (and replayed by
 * `scheduler.recover()` after a restart), so a publish is genuinely queued on
 * this machine. Step 4 is a resting container - reachable via the
 * runtime-mode data-dir split, a share invited from another machine, or one
 * that never published and then had every recipient revoked - where nothing is
 * queued here at all. `SharePublishStatus` relies on exactly this distinction.
 *
 * 6. Everything else is `unknown` - no local record and no server answer. That
 *    is the absence of evidence, not evidence of absence, so nothing renders.
 *    Conflating the two is what made an already-published share announce
 *    "Not yet published".
 */
export type ResolvedPublishStatus =
  | 'publishing'
  | 'published'
  | 'error'
  | 'not-published'
  | 'unknown';

export function resolvePublishStatus(
  publicationState: SharedContainerPublicationState | undefined,
  serverRevision: number | null,
): ResolvedPublishStatus {
  if (publicationState?.status === 'publishing') return 'publishing';
  if (publicationState?.status === 'error') return 'error';
  if (serverRevision !== null && serverRevision >= 1) return 'published';
  if (publicationState?.status === 'published') return 'published';
  if (serverRevision === 0) return 'not-published';
  if (publicationState?.status === 'not-published') return 'not-published';
  return 'unknown';
}

/**
 * The revision to name, preferring the server's count. Returns null when
 * neither side knows one, so the caller omits it rather than rendering
 * "revision undefined".
 */
export function resolveRevision(
  publicationState: SharedContainerPublicationState | undefined,
  serverRevision: number | null,
): number | null {
  if (serverRevision !== null && serverRevision >= 1) return serverRevision;
  // An `error` record carries the revision recipients still hold, which is the
  // difference between "your teammates lost access to the contents" and "your
  // teammates are one revision behind". Both are worth answering.
  if (
    (publicationState?.status === 'published' ||
      publicationState?.status === 'error') &&
    publicationState.revision !== undefined
  ) {
    return publicationState.revision;
  }
  return null;
}

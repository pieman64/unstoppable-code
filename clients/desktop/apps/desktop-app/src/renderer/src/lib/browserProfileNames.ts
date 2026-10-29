import type { BrowserProfileRecord } from '@canopy/protocol/browser-profiles';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types';

/** The tab's profile name as the profile picker shows it. */
export function browserProfileDisplayName(
  snapshot: Pick<BrowserSessionSnapshot, 'profile' | 'profileInfo'>,
): string {
  return (
    snapshot.profileInfo?.displayName ??
    (snapshot.profile?.selection.kind === 'named'
      ? 'Unavailable profile'
      : 'Task')
  );
}

/**
 * Profile ids are opaque and long; six characters is enough to separate two
 * rows in a list the user is already looking at, and short enough not to
 * compete with the name it qualifies.
 */
const ID_QUALIFIER_LENGTH = 6;

/**
 * Names that more than one named profile in `profiles` is using.
 *
 * A profile's name is normally the whole of its identity, and repeating an id
 * beside every one of them is noise. But nothing enforces uniqueness — neither
 * create nor rename rejects a name already in use — so two profiles really can
 * render identically, and then the name alone cannot answer "which one is
 * this?". Collisions are the only case that earns a qualifier.
 *
 * Compared case-insensitively after trimming: "Work" and "work " read as the
 * same name to the person looking at them, whatever the stored bytes are.
 */
export function collidingProfileNames(
  profiles: readonly BrowserProfileRecord[],
): ReadonlySet<string> {
  const seen = new Set<string>();
  const colliding = new Set<string>();
  for (const profile of profiles) {
    if (profile.kind !== 'named') continue;
    const key = profile.displayName.trim().toLowerCase();
    if (seen.has(key)) colliding.add(key);
    else seen.add(key);
  }
  return colliding;
}

/**
 * The short id to show beside a named profile, or `undefined` when its name is
 * already unique in `colliding`.
 */
export function profileNameQualifier(
  profile: BrowserProfileRecord,
  colliding: ReadonlySet<string>,
): string | undefined {
  if (profile.kind !== 'named') return undefined;
  return colliding.has(profile.displayName.trim().toLowerCase())
    ? profile.profileId.slice(0, ID_QUALIFIER_LENGTH)
    : undefined;
}

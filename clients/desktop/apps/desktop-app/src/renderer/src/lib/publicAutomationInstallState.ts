import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  installedCopiesOf,
  type AutomationInstallSourceKind,
} from './automationShareRelationship';

/** A local automation installed from a given source. */
export interface InstalledAutomationByOrigin {
  activityId: string;
  /** True when the source's document changed since this copy was installed. */
  updateAvailable: boolean;
}

/**
 * Locate the local automation installed from a given source: a public share,
 * a team share, or a curated catalog entry.
 *
 * Provenance is `sourceKind` plus the id in that source's namespace. The id
 * namespaces do not overlap — `installedFrom.remoteId` holds a team-share id
 * for a scoped install, a public-share id for a public one, and a catalog key
 * for a curated one — so matching on the id alone would let a collision claim
 * an unrelated automation. Absent `sourceKind` means `'shared'`.
 *
 * Sibling of `publicShareInstallState.ts`, kept out of the landing hook so it
 * is unit-testable without rendering.
 */
export function findInstalledAutomationByOrigin(
  activities: readonly ScheduledActivity[],
  origin: { sourceKind: AutomationInstallSourceKind; remoteId: string },
  contentHash: string,
): InstalledAutomationByOrigin | null {
  const found = installedCopiesOf(activities, origin)[0];
  if (!found?.installedFrom) return null;
  return {
    activityId: found.id,
    updateAvailable: found.installedFrom.contentHash !== contentHash,
  };
}

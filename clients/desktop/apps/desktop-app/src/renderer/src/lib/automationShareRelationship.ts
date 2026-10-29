import type {
  AutomationInstalledFromMetadata,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type { SharedAutomationSummary } from '@canopy/protocol/automations';
import type { SharedAutomationLocalBadge } from '@/components/automations/SharedAutomationPreview';

/**
 * How local automations relate to the source they came from. The Automations
 * page and the Marketplace both read these, so "installed", "update
 * available" and "which copies are stale" mean one thing on both.
 */

/** Where a local copy was installed from. */
export type AutomationInstallSourceKind = NonNullable<
  AutomationInstalledFromMetadata['sourceKind']
>;

/** One installable source: a team share, a public share, or a curated entry. */
export interface AutomationInstallSource {
  sourceKind: AutomationInstallSourceKind;
  /** Team-share id, public-share id, or curated catalog key, per `sourceKind`. */
  remoteId: string;
  contentHash: string;
}

/**
 * Local copies installed from one source.
 *
 * `installedFrom.remoteId` holds a team-share id, a public-share id, or a
 * curated key depending on `sourceKind`. Those namespaces do not overlap, so
 * matching on the id alone would let a collision claim an unrelated
 * automation. An absent `sourceKind` means a team share.
 */
export function installedCopiesOf(
  activities: readonly ScheduledActivity[],
  source: Pick<AutomationInstallSource, 'sourceKind' | 'remoteId'>,
): ScheduledActivity[] {
  return activities.filter(
    (activity) =>
      activity.installedFrom?.remoteId === source.remoteId &&
      (activity.installedFrom.sourceKind ?? 'shared') === source.sourceKind,
  );
}

/** Installed copies whose source document changed since they were installed. */
export function staleCopiesOf(
  activities: readonly ScheduledActivity[],
  source: AutomationInstallSource,
): ScheduledActivity[] {
  return installedCopiesOf(activities, source).filter(
    (activity) => activity.installedFrom?.contentHash !== source.contentHash,
  );
}

/**
 * Whether a source is installed here, and whether any copy is out of date.
 * Any stale copy makes the update actionable: a single fresh copy must not
 * mask additional stale ones.
 */
export function installStateOf(
  activities: readonly ScheduledActivity[],
  source: AutomationInstallSource,
): 'installed' | 'update-available' | null {
  const copies = installedCopiesOf(activities, source);
  if (copies.length === 0) return null;
  return copies.some(
    (activity) => activity.installedFrom?.contentHash !== source.contentHash,
  )
    ? 'update-available'
    : 'installed';
}

/** The local relationship badge for a team-shared automation. */
export function localBadgeForSummary(
  summary: Pick<SharedAutomationSummary, 'id' | 'contentHash'>,
  activities: readonly ScheduledActivity[],
): SharedAutomationLocalBadge | null {
  if (activities.some((activity) => activity.remote?.remoteId === summary.id)) {
    return 'shared-by-you';
  }
  return installStateOf(activities, {
    sourceKind: 'shared',
    remoteId: summary.id,
    contentHash: summary.contentHash,
  });
}

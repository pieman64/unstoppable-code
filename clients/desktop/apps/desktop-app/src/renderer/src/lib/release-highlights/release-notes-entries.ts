import {
  parseReleaseVersion,
  type ReleaseNotesEntry,
} from '@canopy/protocol/release-notes';

/** Main authenticates the viewer and enforces the rollout before any read. */
export async function loadDesktopReleaseNotesEntries(
  installedVersion?: string,
): Promise<readonly ReleaseNotesEntry[] | null> {
  try {
    const version = parseReleaseVersion(
      installedVersion ?? (await window.api.update.getAppVersion()),
    );
    if (!version || version.rc !== null) return [];
    return await window.api.loadCloudReleaseNotes(version.normalized);
  } catch {
    return null;
  }
}

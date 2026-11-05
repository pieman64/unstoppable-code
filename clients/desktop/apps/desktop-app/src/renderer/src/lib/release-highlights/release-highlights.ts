import {
  applyReleaseNotesBrand,
  changelogUrl,
  compareReleaseVersions,
  isPresentableReleaseNotesEntry,
  parseReleaseVersion,
  resolveReleaseNotesEntry,
  type ReleaseNotesEntry,
} from '@canopy/protocol/release-notes';
import { brandText } from '@/lib/brand';
import { emitPreferencesUpdated } from '@/lib/preferences-events';

export function brandReleaseNotesEntry(
  entry: ReleaseNotesEntry,
): ReleaseNotesEntry {
  return applyReleaseNotesBrand(entry, { appName: brandText.appName });
}

/**
 * Settings shows published notes only for the exact installed stable version.
 */
export function resolveManualReleaseNotesEntry(
  appVersion: string | null,
  entries: readonly ReleaseNotesEntry[],
): ReleaseNotesEntry | null {
  if (!appVersion) return null;
  const current = parseReleaseVersion(appVersion);
  if (current) {
    const entry = resolveReleaseNotesEntry(appVersion, entries);
    return entry && isPresentableReleaseNotesEntry(entry, current)
      ? entry
      : null;
  }
  return null;
}

/**
 * Full release notes URL on the configured web origin, or `null` when the
 * origin is unavailable (the dialog then omits the action rather than linking
 * to a guessed production host).
 */
export async function resolveReleaseNotesUrl(
  entry: ReleaseNotesEntry,
): Promise<string | null> {
  if (typeof window.api?.getCanopyCloudBaseUrl !== 'function') return null;
  try {
    const origin = await window.api.getCanopyCloudBaseUrl();
    return origin ? changelogUrl(origin, entry) : null;
  } catch {
    return null;
  }
}

let writeChain: Promise<void> = Promise.resolve();
let highestWrittenVersion: string | null = null;

/**
 * Persist the release-highlights watermark through the main-owned partial
 * save, serialized per renderer. A write never lowers a watermark this
 * session already wrote. Failures are swallowed: the shell keeps working and
 * the worst case is the dialog showing again on a later launch (no
 * transactional exactly-once guarantee).
 */
export function recordReleaseHighlightsVersion(version: string): Promise<void> {
  const run = async (): Promise<void> => {
    const target = parseReleaseVersion(version);
    if (!target) return;
    const written =
      highestWrittenVersion === null
        ? null
        : parseReleaseVersion(highestWrittenVersion);
    if (written && compareReleaseVersions(written, target) >= 0) return;
    try {
      const saved = await window.api.savePreferences({
        releaseHighlightsLastSeenVersion: target.normalized,
      });
      // Main may have preserved a newer watermark from another queued save.
      highestWrittenVersion = saved.releaseHighlightsLastSeenVersion;
      emitPreferencesUpdated(saved);
    } catch {
      // See the doc comment: a failed write may repeat the dialog later.
    }
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

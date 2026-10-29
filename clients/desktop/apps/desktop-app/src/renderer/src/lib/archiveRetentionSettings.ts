/**
 * Pure days ⇄ persisted-value mapping for the deletion-retention settings
 * UIs (code-workspace, cowork, and App Advisor settings modals).
 *
 * Deletion retention is always on, so the editable state is just the number
 * of days a "Deleted" item is kept before the sweep removes it. The persisted
 * encoding still accepts the legacy values (see `resolveArchiveRetentionDays`):
 * - `undefined` (never set), `null` (legacy default), and `0` (legacy
 *   "retention off") all resolve to the 7-day default.
 * - a positive integer is the retention window in days.
 *
 * Saving always writes the resolved positive day count.
 */
import {
  DEFAULT_AUTO_ARCHIVE_DAYS,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
  resolveArchiveRetentionDays,
  type ArchiveRetentionSurface,
} from '@canopy/desktop-shared/lib/archive-retention';

export {
  DEFAULT_AUTO_ARCHIVE_DAYS,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  MAX_ARCHIVE_RETENTION_DAYS,
  resolveArchiveRetentionDays,
  type ArchiveRetentionSurface,
};

/** Editable modal state for a deletion-retention setting. */
export interface ArchiveRetentionDraft {
  /** Days a deleted item is kept before it is removed. */
  days: number;
}

/** Map a persisted `archiveRetentionDays` value to editable modal state. */
export function toArchiveRetentionDraft(
  surface: ArchiveRetentionSurface,
  persistedValue: number | null | undefined,
): ArchiveRetentionDraft {
  return { days: resolveArchiveRetentionDays(surface, persistedValue) };
}

/** Effective retention encoded by a draft. */
export function getDraftArchiveRetentionDays(
  draft: ArchiveRetentionDraft,
): number {
  return draft.days;
}

/** Value to persist for a draft: always the positive day count. */
export function toPersistedArchiveRetentionDays(
  _surface: ArchiveRetentionSurface,
  draft: ArchiveRetentionDraft,
): number {
  return draft.days;
}

/**
 * A draft is dirty when its day count differs from the resolved persisted
 * value — so a never-set surface left at the 7-day default is NOT dirty, and
 * nothing is written until the user actually changes it.
 */
export function isArchiveRetentionDraftDirty(
  surface: ArchiveRetentionSurface,
  persistedValue: number | null | undefined,
  draft: ArchiveRetentionDraft,
): boolean {
  return (
    getDraftArchiveRetentionDays(draft) !==
    resolveArchiveRetentionDays(surface, persistedValue)
  );
}

/**
 * Whether Save should write the retention value. Beyond ordinary dirtiness,
 * a persisted legacy value (`null`, absent, or `0`) on the cowork and
 * app-advisor surfaces must be re-persisted explicitly on the next Save: the
 * per-chat archive sweeps honor only explicit positive values (so legacy data
 * is never purged retroactively), and saving is the user action that arms
 * them to match what the settings UI already shows.
 */
export function shouldPersistArchiveRetention(
  surface: ArchiveRetentionSurface,
  persistedValue: number | null | undefined,
  draft: ArchiveRetentionDraft,
): boolean {
  if (isArchiveRetentionDraftDirty(surface, persistedValue, draft)) {
    return true;
  }
  return (
    (surface === 'cowork' || surface === 'app-advisor') &&
    (persistedValue === null ||
      persistedValue === undefined ||
      persistedValue === 0)
  );
}

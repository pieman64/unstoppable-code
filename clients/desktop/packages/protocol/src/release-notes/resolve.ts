import type {
  ParsedReleaseVersion,
  ReleaseHighlightsDecision,
  ReleaseHighlightsEligibility,
  ReleaseNotesEntry,
} from './types';

const VERSION_PATTERN =
  /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;

export function parseReleaseVersion(
  version: string,
): ParsedReleaseVersion | null {
  const match = VERSION_PATTERN.exec(version);
  if (!match || match[0] !== version) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const rc = match[4] === undefined ? null : Number(match[4]);
  if (
    ![major, minor, patch, ...(rc === null ? [] : [rc])].every(
      Number.isSafeInteger,
    )
  ) {
    return null;
  }
  return { major, minor, patch, rc, normalized: `${major}.${minor}.${patch}` };
}

/** Compare release identities, deliberately treating RC and stable as equal. */
export function compareReleaseVersions(
  left: ParsedReleaseVersion,
  right: ParsedReleaseVersion,
): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

function parseCatalogVersion(version: string): ParsedReleaseVersion | null {
  const parsed = parseReleaseVersion(version);
  return parsed?.rc === null && parsed.normalized === version ? parsed : null;
}

export function resolveReleaseNotesEntry(
  version: string,
  entries: readonly ReleaseNotesEntry[],
): ReleaseNotesEntry | null {
  const current = parseReleaseVersion(version);
  if (!current || current.rc !== null) return null;
  return entries.find((entry) => entry.version === current.normalized) ?? null;
}

export function decideReleaseHighlights(
  eligibility: ReleaseHighlightsEligibility,
  entries: readonly ReleaseNotesEntry[],
): ReleaseHighlightsDecision {
  const current = parseReleaseVersion(eligibility.currentVersion);
  if (!current || current.rc !== null) return { action: 'none' };
  const recorded =
    eligibility.lastSeenVersion === null
      ? null
      : parseReleaseVersion(eligibility.lastSeenVersion);
  if (recorded && compareReleaseVersions(current, recorded) <= 0)
    return { action: 'none' };
  const entry = resolveReleaseNotesEntry(current.normalized, entries);
  if (!entry) {
    // No entry for this exact version yet: preserve history so a later launch can
    // present an entry published after the app was installed.
    return { action: 'none' };
  }
  return isPresentableReleaseNotesEntry(entry, current)
    ? { action: 'show', entry, version: entry.version }
    : { action: 'none' };
}

/**
 * A stable build presents only published entries, so a release that ships
 * before its database entry is approved never shows draft copy.
 */
export function isPresentableReleaseNotesEntry(
  entry: ReleaseNotesEntry,
  current: ParsedReleaseVersion,
): boolean {
  return (
    current.rc === null &&
    entry.version === current.normalized &&
    isPublishedReleaseNotesEntry(entry)
  );
}

export function applyReleaseNotesBrand(
  entry: ReleaseNotesEntry,
  brand: { readonly appName: string },
): ReleaseNotesEntry {
  const replace = (text: string): string =>
    text.replace(/\{app\}/g, (): string => brand.appName);
  return {
    ...entry,
    ...(entry.headline === undefined
      ? {}
      : { headline: replace(entry.headline) }),
    highlights: entry.highlights.map((highlight) => ({
      title: replace(highlight.title),
      ...(highlight.description === undefined
        ? {}
        : { description: replace(highlight.description) }),
    })),
    ...(entry.details === undefined
      ? {}
      : {
          details: entry.details.map((detail) => ({
            heading: replace(detail.heading),
            items: detail.items.map(replace),
          })),
        }),
  };
}

function isCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}

/**
 * Whether an entry is approved for public publication: a canonical stable
 * version with a valid `releasedOn` date.
 */
export function isPublishedReleaseNotesEntry(
  entry: ReleaseNotesEntry,
): boolean {
  return (
    parseCatalogVersion(entry.version) !== null &&
    entry.releasedOn !== undefined &&
    isCalendarDate(entry.releasedOn)
  );
}

/**
 * Fail closed if malformed publication data reaches the public projection:
 * an entry without a valid date or a canonical version is omitted, so the
 * page never reaches `changelogAnchor` with a version it would reject.
 */
export function publishedReleaseNotesEntries(
  entries: readonly ReleaseNotesEntry[],
): readonly ReleaseNotesEntry[] {
  return entries.filter(isPublishedReleaseNotesEntry);
}

export function changelogAnchor(version: string): string {
  if (!parseCatalogVersion(version))
    throw new Error(`Invalid release notes version: ${version}`);
  return `v${version.replace(/\./g, '-')}`;
}

export function changelogPath(entry?: ReleaseNotesEntry | null): string {
  return entry && isPublishedReleaseNotesEntry(entry)
    ? `/changelog?version=${entry.version}#${changelogAnchor(entry.version)}`
    : '/changelog';
}

/** A root-relative route stays correct with trailing slashes or a base path. */
export function changelogUrl(
  origin: string,
  entry?: ReleaseNotesEntry | null,
): string | null {
  try {
    const url = new URL(changelogPath(entry), origin);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function validateReleaseNotesContent(entry: ReleaseNotesEntry): void {
  const validateText = (value: string): void => {
    if (!value.trim() || /[{}]/.test(value.replace(/\{app\}/g, ''))) {
      throw new Error(
        'Release notes text must be non-empty and use only {app} tokens',
      );
    }
  };
  if (entry.highlights.length < 3 || entry.highlights.length > 5) {
    throw new Error('Each release requires 3–5 highlights');
  }
  if (entry.headline !== undefined) validateText(entry.headline);
  for (const highlight of entry.highlights) {
    validateText(highlight.title);
    if (highlight.description !== undefined)
      validateText(highlight.description);
  }
  for (const detail of entry.details ?? []) {
    validateText(detail.heading);
    for (const item of detail.items) validateText(item);
  }
}

/** Validate maintained catalog content without relying on host-specific code. */
export function validateReleaseNotesCatalog(
  entries: readonly ReleaseNotesEntry[],
): void {
  let previous: ParsedReleaseVersion | null = null;
  for (const entry of entries) {
    const version = parseCatalogVersion(entry.version);
    if (
      !version ||
      (previous && compareReleaseVersions(previous, version) <= 0)
    ) {
      throw new Error(
        'Release notes versions must be unique canonical stable versions in descending order',
      );
    }
    previous = version;
    if (entry.releasedOn !== undefined && !isCalendarDate(entry.releasedOn)) {
      throw new Error(`Invalid release date: ${entry.releasedOn}`);
    }
    validateReleaseNotesContent(entry);
  }
}

/** Bound both hosted payloads and local review files before decoding. */
export const MAX_RELEASE_NOTES_BYTES = 1_048_576;
export const RELEASE_NOTES_API_PATH = '/api/v1/release-notes';

function notesRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Release notes must contain objects');
  }
  return Object.fromEntries(Object.entries(value));
}

function notesText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_000) {
    throw new Error('Invalid release notes text');
  }
  return value;
}

function notesArray(value: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new Error('Invalid release notes list');
  }
  return value;
}

/** Decode untrusted JSON into display-only fields; never evaluate content. */
export function parseReleaseNotesEntry(value: unknown): ReleaseNotesEntry {
  const data = notesRecord(value);
  const entry: ReleaseNotesEntry = {
    version: notesText(data.version),
    ...(data.releasedOn === undefined
      ? {}
      : { releasedOn: notesText(data.releasedOn) }),
    ...(data.headline === undefined
      ? {}
      : { headline: notesText(data.headline) }),
    highlights: notesArray(data.highlights, 5).map((value) => {
      const highlight = notesRecord(value);
      return {
        title: notesText(highlight.title),
        ...(highlight.description === undefined
          ? {}
          : { description: notesText(highlight.description) }),
      };
    }),
    ...(data.details === undefined
      ? {}
      : {
          details: notesArray(data.details, 6).map((value) => {
            const detail = notesRecord(value);
            const items = notesArray(detail.items, 12).map(notesText);
            if (items.length === 0)
              throw new Error('Empty release notes detail');
            return { heading: notesText(detail.heading), items };
          }),
        }),
  };
  validateReleaseNotesCatalog([entry]);
  return entry;
}

export interface ReleaseNotesFeed {
  readonly schemaVersion: 1;
  readonly entries: readonly ReleaseNotesEntry[];
  /** Exclusive stable-version cursor for the next history page. */
  readonly nextBefore?: string;
}

/** Public feeds contain only approved, published entries, newest first. */
export function parseReleaseNotesFeed(json: string): ReleaseNotesFeed {
  if (json.length > MAX_RELEASE_NOTES_BYTES)
    throw new Error('Release notes feed exceeds 1 MiB');
  const value: unknown = JSON.parse(json);
  const data = notesRecord(value);
  if (data.schemaVersion !== 1)
    throw new Error('Unsupported release notes schema');
  const entries = notesArray(data.entries, 500).map(parseReleaseNotesEntry);
  validateReleaseNotesCatalog(entries);
  if (entries.some((entry) => !isPublishedReleaseNotesEntry(entry))) {
    throw new Error('Public feeds cannot contain drafts');
  }
  if (
    data.nextBefore !== undefined &&
    (typeof data.nextBefore !== 'string' ||
      !parseCatalogVersion(data.nextBefore))
  ) {
    throw new Error('Invalid release notes cursor');
  }
  return {
    schemaVersion: 1,
    entries,
    ...(typeof data.nextBefore === 'string'
      ? { nextBefore: data.nextBefore }
      : {}),
  };
}

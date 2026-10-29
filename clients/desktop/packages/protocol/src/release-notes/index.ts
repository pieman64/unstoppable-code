export type {
  ReleaseHighlight,
  ReleaseNotesDetail,
  ReleaseNotesEntry,
  ParsedReleaseVersion,
  ReleaseHighlightsEligibility,
  ReleaseHighlightsDecision,
} from './types';
export type { ReleaseNotesFeed } from './resolve';
export {
  MAX_RELEASE_NOTES_BYTES,
  RELEASE_NOTES_API_PATH,
  parseReleaseNotesEntry,
  parseReleaseNotesFeed,
  parseReleaseVersion,
  compareReleaseVersions,
  resolveReleaseNotesEntry,
  decideReleaseHighlights,
  isPresentableReleaseNotesEntry,
  isPublishedReleaseNotesEntry,
  applyReleaseNotesBrand,
  publishedReleaseNotesEntries,
  changelogAnchor,
  changelogPath,
  changelogUrl,
  validateReleaseNotesCatalog,
} from './resolve';

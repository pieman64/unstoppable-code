import {
  boundedMarkdownSource,
  markdownToPlainText,
} from './markdown-plain-text';

const MAX_CARD_SUBTITLE_WORDS = 7;

/**
 * Only the opening of a catalog description can reach a seven-word subtitle,
 * so the Markdown parse is bounded to this prefix instead of the whole entry.
 */
const MAX_CARD_SUBTITLE_SOURCE_CHARS = 400;

/**
 * Purpose-written copy for the marketplace entries users see most often.
 * Detail surfaces keep the complete catalog description; these strings are
 * only for compact discovery rows where one quickly scannable line matters.
 */
const CARD_SUBTITLE_BY_NAME: Readonly<Record<string, string>> = {
  'atlassian rovo': 'Manage Jira and Confluence',
  canva: 'Create, review, and edit designs',
  figma: 'Turn designs into implementation context',
  fireflies: 'Search and analyze meeting transcripts',
  github: 'Triage PRs, issues, CI, and release workflows',
  gmail: 'Read and manage Gmail',
  'google calendar': 'Manage Google Calendar events',
  'google drive': 'Work across Drive, Docs, Sheets, and Slides',
  granola: 'Add your meeting context',
  linear: 'Manage issues, projects, and team workflows',
  notion: 'Plan and organize work in Notion',
  'otter ai': 'Search and review meeting transcripts',
  'outlook calendar': 'Manage Outlook schedules',
  plaud: 'Retrieve insights from Plaud recordings',
  slack: 'Read and manage Slack',
};

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The first `limit` words. A cut ends in `…`, after any comma, semicolon,
 * colon or stop the last kept word carried, so a row never reads as complete
 * when it is not.
 */
function firstWords(value: string, limit: number): string {
  const words = value.trim().replace(/\s+/g, ' ').split(' ');
  if (words.length <= limit) return words.join(' ');
  // A cut sentence ends in an ellipsis, never in a stray comma or a bare word.
  return `${words
    .slice(0, limit)
    .join(' ')
    .replace(/[\s,;:.–—-]+$/u, '')}…`;
}

/**
 * Return a concise subtitle for a compact marketplace card.
 *
 * Known products get edited copy. The fallback flattens the opening of the
 * author Markdown to plain text and caps third-party catalog prose at seven
 * words, ending a cut with an ellipsis, without mutating the full entry
 * description used by search matching and detail views.
 */
export function marketplaceCardSubtitle(
  name: string,
  description: string,
): string {
  const rewritten = CARD_SUBTITLE_BY_NAME[normalizeName(name)];
  return firstWords(
    rewritten ??
      markdownToPlainText(
        boundedMarkdownSource(description, MAX_CARD_SUBTITLE_SOURCE_CHARS),
      ),
    MAX_CARD_SUBTITLE_WORDS,
  );
}

import { markdownToPlainText } from './markdown-plain-text';

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
/**
 * Return a concise subtitle for a compact marketplace card.
 *
 * Known products get edited copy. The fallback flattens the author Markdown
 * to plain text; the row owns visual truncation so the subtitle uses all of
 * the width available to it.
 */
export function marketplaceCardSubtitle(
  name: string,
  description: string,
): string {
  const rewritten = CARD_SUBTITLE_BY_NAME[normalizeName(name)];
  return rewritten ?? markdownToPlainText(description);
}

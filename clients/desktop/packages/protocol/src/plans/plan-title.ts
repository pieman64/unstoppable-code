const UNTITLED_PLAN_TITLE = 'Untitled plan';
const MAX_PLAN_TITLE_LENGTH = 120;

/**
 * Derive a tracked plan's title from its markdown body: the first non-empty
 * line without leading heading, bullet, or numbering markers, capped at 120
 * characters. Desktop persistence titles new plans with it and the import
 * picker previews with it, so both always agree.
 */
export function derivePlanTitle(content: string): string {
  const firstLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return UNTITLED_PLAN_TITLE;
  }

  const cleaned = firstLine.replace(/^[-*#\d.\s]+/, '').trim();
  return cleaned.length > 0
    ? cleaned.slice(0, MAX_PLAN_TITLE_LENGTH)
    : UNTITLED_PLAN_TITLE;
}

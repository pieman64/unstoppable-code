/**
 * Join class tokens for the organization Settings cards, dropping empty ones
 * so an inert replay-privacy class (an empty string on web) leaves no stray
 * whitespace in the markup.
 */
export function joinClassNames(...names: readonly string[]): string {
  return names.filter((name) => name !== '').join(' ');
}

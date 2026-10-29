/**
 * Join class tokens, dropping empty ones so an inert replay-privacy class (an
 * empty string on web) leaves no stray whitespace in the markup.
 */
export function joinClassNames(
  ...names: ReadonlyArray<string | false | null | undefined>
): string {
  return names.filter((name): name is string => !!name).join(' ');
}

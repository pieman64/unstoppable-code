/**
 * Join class names, dropping empty parts so an inert privacy class (an empty
 * string on web) never leaves stray whitespace in the markup.
 */
export function joinClassNames(
  ...names: ReadonlyArray<string | false | null | undefined>
): string {
  return names.filter((name): name is string => !!name).join(' ');
}

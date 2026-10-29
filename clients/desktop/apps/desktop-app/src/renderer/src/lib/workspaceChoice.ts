/** Every sidebar entry is a workspace choice, regardless of code/cowork type. */
export function hasMultipleWorkspaces(entries: readonly unknown[]): boolean {
  return entries.length > 1;
}

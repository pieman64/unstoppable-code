/** The selection shape the composer editors report (a Slate range). */
export interface ComposerCaretRange {
  readonly anchor: {
    readonly path: readonly number[];
    readonly offset: number;
  };
  readonly focus: { readonly path: readonly number[]; readonly offset: number };
}

/**
 * True when a collapsed caret sits in the draft's first block (its first
 * line): the only place the `!` typeahead opens.
 */
export function caretOnFirstLine(
  selection: ComposerCaretRange | null | undefined,
): boolean {
  if (!selection) return false;
  const { anchor, focus } = selection;
  const collapsed =
    anchor.offset === focus.offset &&
    anchor.path.length === focus.path.length &&
    anchor.path.every((part, index) => focus.path[index] === part);
  return collapsed && anchor.path[0] === 0;
}

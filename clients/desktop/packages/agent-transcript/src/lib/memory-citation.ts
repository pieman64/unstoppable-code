/**
 * Local-memory citation tag matching, shared by display stripping (here) and
 * the desktop compliance parser (`citation-tracking.ts` in the desktop app).
 *
 * Two deliberately different strictness levels share one bounded tag syntax,
 * and the display STRIP form is a strict superset of the compliance PARSE
 * form:
 *
 * - `stripMemoryCitationTags` removes ANY bounded `<memory_citation ...>` tag
 *   — self-closed or not, with or without a `files` attribute — so a sloppily
 *   emitted tag (e.g. a missing trailing slash) never leaks into user-visible
 *   text.
 * - `findMemoryCitationFilesAttributes` matches only the documented format —
 *   a self-closing tag carrying a `files="..."` attribute — because
 *   compliance measures correct-format emission; sloppy variants that the
 *   strip removes from display deliberately do not count as citations.
 *
 * Both patterns bound the tag body with `[^>]*`, so a single tag can never
 * cross a `>`: an unclosed `<memory_citation ...` prefix never swallows
 * unrelated text up to a later element (e.g. `<br/>`).
 */

/**
 * Superset matcher: any bounded `<memory_citation ...>` opening tag or
 * `</memory_citation>` closing tag, up to the first `>`. The optional `/`
 * covers the paired form a model may emit instead of self-closing.
 */
const MEMORY_CITATION_TAG_SOURCE = String.raw`</?memory_citation\b[^>]*>`;

/** Strict compliance form: self-closing with a `files="..."` attribute. */
const STRICT_MEMORY_CITATION_TAG_SOURCE = String.raw`<memory_citation\b(?=[^>]*\/\s*>)[^>]*\bfiles\s*=\s*"([^"]*)"[^>]*\/\s*>`;

/**
 * Return the raw `files` attribute value of every strict-form citation tag in
 * `text`, in order of appearance. A non-empty result means the model emitted
 * at least one correctly formatted citation; values are raw attribute strings
 * whose comma-separated keys the caller still has to validate.
 */
export function findMemoryCitationFilesAttributes(text: string): string[] {
  const filesAttributes: string[] = [];
  const strictPattern = new RegExp(STRICT_MEMORY_CITATION_TAG_SOURCE, 'gi');
  let match = strictPattern.exec(text);
  while (match !== null) {
    filesAttributes.push(match[1] ?? '');
    match = strictPattern.exec(text);
  }
  return filesAttributes;
}

export interface StripMemoryCitationTagsOptions {
  /**
   * Trim trailing whitespace once a tag was removed (default `true`). Pass
   * `false` when the text is still being assembled from streamed deltas: the
   * stripped result feeds the next append, so trimming would glue the next
   * delta onto the previous line.
   */
  trimEnd?: boolean;
}

/**
 * Remove model-emitted local-memory citation control tags from display text.
 *
 * Providers that deliver self-contained items (Claude, Codex) strip once,
 * after the item is assembled, so a tag split across independently-rendered
 * events is only recognized once a later assembled item carries the full tag.
 * Cursor streams `canopy_assistant_patch` deltas instead; its reducer strips
 * each patched block, with `trimEnd: false`, whenever the patch could complete
 * a tag (a new block, or an append that carries a `>`), so a split tag
 * disappears as soon as the delta that closes it is applied. See
 * `stripCursorAssistantMemoryCitations` in `transcript-parser.ts` for the
 * exact rule.
 *
 * This strips the superset form described in the module docstring: any
 * bounded `<memory_citation ...>` tag, including non-self-closed tags and
 * tags without a `files` attribute, is removed so no variant leaks into
 * visible output. The case-insensitive prefix check mirrors the `/i` pattern
 * flag and skips the scan entirely for tag-free text.
 */
export function stripMemoryCitationTags(
  text: string,
  options: StripMemoryCitationTagsOptions = {},
): string {
  if (!/<\/?memory_citation/i.test(text)) {
    return text;
  }
  const stripped = text.replace(
    new RegExp(MEMORY_CITATION_TAG_SOURCE, 'gi'),
    '',
  );
  if (stripped === text) return text;
  return options.trimEnd === false ? stripped : stripped.trimEnd();
}

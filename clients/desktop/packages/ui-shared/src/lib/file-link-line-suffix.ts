/**
 * Line locations on agent-authored file links (CAN-4275).
 *
 * Agents cite code as `src/a.ts:12-20`, `src/a.ts#L12`, or editor-style
 * `src/a.ts:12:4`. This module is the single parser for those suffixes on
 * every platform, so desktop mentions, desktop markdown links, and web
 * markdown links agree on what is a location and what is part of a filename.
 *
 * Accepted suffixes, immediately after a nonempty path:
 *
 * | Form                      | Result                            |
 * | ------------------------- | --------------------------------- |
 * | `:N`, `#LN`               | line N                            |
 * | `:N-M`, `#LN-LM`, `#LN-M` | lines N through M                 |
 * | `:N:C`, `#LNCc`           | line N; the column is ignored     |
 * | `:N:C-M:D`                | lines N through M; columns ignored |
 *
 * Every number must be a positive safe integer (leading zeros allowed). A
 * reversed end is dropped and an end equal to the start collapses to one
 * line. Anything else — zero, overflow, whitespace, a dangling `-`/`:`, or a
 * longer run of suffix characters than the grammar allows — rejects the
 * whole suffix; a shorter valid prefix or tail is never recovered.
 *
 * Only literal `:` and `#` delimit a suffix: percent-encoded `%3A`/`%23`
 * remain filename characters, and nothing is decoded here.
 */

export interface FileLinkLineLocation {
  /** One-based first line. */
  readonly line: number;
  /** One-based last line; present only when it is after {@link line}. */
  readonly lineEnd?: number;
}

export interface ParsedFileLinkHref {
  /** The href without its suffix, or the unchanged input when unlocated. */
  readonly href: string;
  readonly location: FileLinkLineLocation | null;
}

export interface LeadingLineSuffixMatch {
  /** Number of characters of the suffix at the start of the text. */
  readonly length: number;
  readonly location: FileLinkLineLocation;
}

// Groups: 1 line, 2 range end, 3 column, 4 range end, 5 end column,
// 6 hash line, 7 hash range end, 8 hash column.
const SUFFIX_SOURCE =
  ':(\\d+)(?:-(\\d+)|:(\\d+)(?:-(\\d+):(\\d+))?)?|#L(\\d+)(?:-L?(\\d+)|C(\\d+))?';
const WHOLE_SUFFIX = new RegExp(`^(?:${SUFFIX_SOURCE})$`);
const LEADING_SUFFIX = new RegExp(`^(?:${SUFFIX_SOURCE})`);

/** Characters that can appear in a suffix; a trailing run of them is one unit. */
const SUFFIX_CHARACTER = /[0-9:#LC-]/;
const PROSE_SPACE = /\s/;
const CLOSING_DELIMITERS = new Set([
  ')',
  ']',
  '}',
  '>',
  '"',
  "'",
  '`',
  '’',
  '”',
]);
const SENTENCE_PUNCTUATION = new Set(['.', ',', ';', '!', '?']);

function positiveSafeInteger(digits: string | undefined): number | null {
  if (digits === undefined) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Validate the captured numbers of a {@link SUFFIX_SOURCE} match. Columns are
 * validated (a zero column is malformed) and then discarded.
 */
function locationFromMatch(
  match: RegExpExecArray,
): FileLinkLineLocation | null {
  const hash = match[6] !== undefined;
  const lineDigits = hash ? match[6] : match[1];
  const endDigits = hash ? match[7] : (match[2] ?? match[4]);
  const columnDigits = hash ? [match[8]] : [match[3], match[5]];

  const line = positiveSafeInteger(lineDigits);
  if (line === null) return null;
  for (const digits of columnDigits) {
    if (digits !== undefined && positiveSafeInteger(digits) === null)
      return null;
  }
  if (endDigits === undefined) return { line };
  const lineEnd = positiveSafeInteger(endDigits);
  if (lineEnd === null) return null;
  return lineEnd > line ? { line, lineEnd } : { line };
}

/**
 * Split a complete trailing line suffix from a file-link href. Returns the
 * unchanged href with a `null` location when the href has no valid suffix.
 * Callers classify external URLs before calling this; it does not know about
 * schemes.
 */
export function parseFileLinkLineSuffix(href: string): ParsedFileLinkHref {
  const unchanged: ParsedFileLinkHref = { href, location: null };
  let runStart = href.length;
  while (runStart > 0 && SUFFIX_CHARACTER.test(href.charAt(runStart - 1)))
    runStart -= 1;
  let suffixStart = -1;
  for (let index = runStart; index < href.length; index += 1) {
    const character = href.charAt(index);
    if (character === ':' || character === '#') {
      suffixStart = index;
      break;
    }
  }
  if (suffixStart <= 0) return unchanged;

  const match = WHOLE_SUFFIX.exec(href.slice(suffixStart));
  if (match === null) return unchanged;
  const location = locationFromMatch(match);
  if (location === null) return unchanged;
  return { href: href.slice(0, suffixStart), location };
}

function isClosingOrSpace(character: string): boolean {
  return (
    character === '' ||
    PROSE_SPACE.test(character) ||
    CLOSING_DELIMITERS.has(character)
  );
}

/**
 * Match a line suffix at the very start of `text` (the prose immediately after
 * a recognized file path). The suffix must end the text or be followed by a
 * prose boundary: whitespace, a closing delimiter, or sentence punctuation
 * that itself ends the text or precedes whitespace/a closing delimiter.
 * Continuation by letters, digits, underscore, path separators, or more
 * suffix syntax rejects the match entirely.
 */
export function matchLeadingLineSuffix(
  text: string,
): LeadingLineSuffixMatch | null {
  const match = LEADING_SUFFIX.exec(text);
  if (match === null) return null;
  const length = match[0].length;
  const next = text.charAt(length);
  const boundary =
    isClosingOrSpace(next) ||
    (SENTENCE_PUNCTUATION.has(next) &&
      isClosingOrSpace(text.charAt(length + 1)));
  if (!boundary) return null;
  const location = locationFromMatch(match);
  return location === null ? null : { length, location };
}

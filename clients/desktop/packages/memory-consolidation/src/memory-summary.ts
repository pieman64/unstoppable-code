/*
 * The title and excerpt a memory list row shows, from the head of a memory
 * file. Shared so the desktop explorer and the web explorer over synced
 * memory (CAN-5193) describe a memory the same way.
 */

/** How much of a memory a list row is described from: a file's first 4 KiB. */
export const MEMORY_SUMMARY_PROBE_BYTES = 4 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The first {@link MEMORY_SUMMARY_PROBE_BYTES} of a memory's text as UTF-8,
 * decoded as a read of that many bytes from its file would be, for hosts that
 * hold the whole memory rather than reading the file's head.
 */
export function memorySummaryProbeHead(content: string): string {
  // No UTF-16 unit encodes to fewer than one byte, so the probe lies within
  // that many units.
  const bytes = encoder.encode(content.slice(0, MEMORY_SUMMARY_PROBE_BYTES));
  return decoder.decode(bytes.subarray(0, MEMORY_SUMMARY_PROBE_BYTES));
}

const INBOX_TITLE_MAX_CHARS = 80;

/** Drops a leading YAML front matter block (`---` … `---`) from probe lines. */
function skipFrontMatter(lines: string[]): string[] {
  const start = lines.findIndex((line) => line.trim() !== '');
  if (start === -1 || lines[start].trim() !== '---') return lines;
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === '---',
  );
  // An unterminated block within the probe hides nothing usable anyway.
  return end === -1 ? [] : lines.slice(end + 1);
}

function isSpaceOrTab(character: string | undefined): boolean {
  return character === ' ' || character === '\t';
}

/**
 * Removes a closing `#` run the way CommonMark does: only when the run is
 * preceded by a space or tab (`Title #` → `Title`, `Title#` stays). A
 * remainder that is nothing but hashes has no title.
 */
function stripClosingHashes(text: string): string | undefined {
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end -= 1;
  if (end === text.length) return text.trim() || undefined;
  if (end === 0) return undefined;
  if (!isSpaceOrTab(text[end - 1])) return text.trim() || undefined;
  const stripped = text.slice(0, end).trim();
  return stripped === '' ? undefined : stripped;
}

/**
 * Level-1 ATX heading text, parsed without a regex: probe lines are attacker-
 * sized (up to 4 KiB of arbitrary whitespace) and this runs on the main
 * process for every listed file, so the walk must stay linear.
 */
function atxLevelOneTitle(line: string): string | undefined {
  // CommonMark allows up to three leading spaces; four is an indented code
  // block and never a heading.
  let indent = 0;
  while (indent < 4 && line[indent] === ' ') indent += 1;
  if (indent === 4) return undefined;
  const marker = line.slice(indent);
  if (marker[0] !== '#' || marker[1] === '#' || !isSpaceOrTab(marker[1]))
    return undefined;
  // Unicode whitespace is heading content, not CommonMark ATX padding.
  let start = 2;
  while (isSpaceOrTab(marker[start])) start += 1;
  let end = marker.length;
  while (end > start && isSpaceOrTab(marker[end - 1])) end -= 1;
  return stripClosingHashes(marker.slice(start, end));
}

/** Drops a `- `, `* `, `+ `, `1. ` or `1) ` list marker (space or tab). */
function stripListMarker(text: string): string {
  const first = text[0];
  if (
    (first === '-' || first === '*' || first === '+') &&
    isSpaceOrTab(text[1])
  )
    return text.slice(2).trimStart();
  let digits = 0;
  while (digits < text.length && text[digits] >= '0' && text[digits] <= '9')
    digits += 1;
  const delimiter = text[digits];
  if (
    digits > 0 &&
    (delimiter === '.' || delimiter === ')') &&
    isSpaceOrTab(text[digits + 1])
  )
    return text.slice(digits + 2).trimStart();
  return text;
}

/** Drops a one-to-six `#` heading marker followed by a space or tab. */
function stripHeadingMarker(text: string): string {
  let hashes = 0;
  while (hashes < text.length && text[hashes] === '#') hashes += 1;
  if (hashes >= 1 && hashes <= 6) {
    // A bare `##` line (marker with nothing after it) is an empty heading.
    if (hashes === text.length) return '';
    if (isSpaceOrTab(text[hashes])) return text.slice(hashes + 1).trimStart();
  }
  return text;
}

/** First body line as an inbox title: markers and heading hashes stripped. */
function inboxLineTitle(line: string): string | undefined {
  const text = stripHeadingMarker(stripListMarker(line.trim())).trim();
  if (!text) return undefined;
  const characters = Array.from(text);
  return characters.length > INBOX_TITLE_MAX_CHARS
    ? `${characters.slice(0, INBOX_TITLE_MAX_CHARS).join('').trimEnd()}…`
    : text;
}

/**
 * Title of a memory file from its decoded probe head: skips a leading front
 * matter block and returns the text of an ATX level-1 heading when it is the
 * first non-blank body line. Inbox notes rarely carry a heading, so for them
 * the first non-blank body line stands in (list marker stripped, clipped).
 */
export function titleFromProbeHead(
  probeHead: string,
  options: { inbox: boolean },
): string | undefined {
  const head = probeHead.replace(/^\uFEFF/, '');
  const firstLine = skipFrontMatter(head.split(/\r?\n/)).find(
    (line) => line.trim() !== '',
  );
  if (firstLine === undefined) return undefined;
  const heading = atxLevelOneTitle(firstLine);
  if (heading !== undefined) return heading;
  return options.inbox ? inboxLineTitle(firstLine) : undefined;
}

const EXCERPT_MAX_CHARS = 160;

function clip(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length > max
    ? `${characters.slice(0, max).join('').trimEnd()}…`
    : text;
}

/**
 * The index of the first `character` at or after each position asked, asked
 * in increasing order. Each search starts past the last one found, so a
 * whole line costs one pass however many positions ask.
 */
function nextIndexOf(
  text: string,
  character: string,
): (from: number) => number {
  let found = -1;
  return (from: number): number => {
    if (found !== Infinity && found < from) {
      const at = text.indexOf(character, from);
      found = at === -1 ? Infinity : at;
    }
    return found;
  };
}

/**
 * `[text](target)` and `![text](target)` reduced to their text, as
 * `/!?\[([^\]]*)\]\([^)]*\)/g` replaces with `$1`, in one pass: that
 * expression rescans the rest of the line from every unmatched `[`.
 */
function linkText(text: string): string {
  const closeBracket = nextIndexOf(text, ']');
  const closeParen = nextIndexOf(text, ')');
  const parts: string[] = [];
  let copied = 0;
  let at = 0;
  while (at < text.length) {
    const open = text[at] === '!' && text[at + 1] === '[' ? at + 1 : at;
    if (text[open] !== '[') {
      at += 1;
      continue;
    }
    const close = closeBracket(open + 1);
    const end =
      close !== Infinity && text[close + 1] === '('
        ? closeParen(close + 2)
        : Infinity;
    if (end === Infinity) {
      at += 1;
      continue;
    }
    parts.push(text.slice(copied, at), text.slice(open + 1, close));
    copied = end + 1;
    at = end + 1;
  }
  parts.push(text.slice(copied));
  return parts.join('');
}

/** Inline Markdown reduced to its text: links, emphasis and code ticks. */
function plainInline(text: string): string {
  return linkText(text)
    .replace(/(\*\*|__|`)/g, '')
    .trim();
}

/**
 * The line a list row shows under the title, as plain text: the first
 * non-blank body line, after the title line when the file has one. Fenced
 * code and rules are skipped.
 */
export function excerptFromProbeHead(
  probeHead: string,
  options: { titled: boolean },
): string | undefined {
  const lines = skipFrontMatter(
    probeHead.replace(/^\uFEFF/, '').split(/\r?\n/),
  );
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first === -1) return undefined;
  let fenced = false;
  for (const line of lines.slice(options.titled ? first + 1 : first)) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || trimmed === '' || /^(---|\*\*\*|___)$/.test(trimmed))
      continue;
    const text = plainInline(stripHeadingMarker(stripListMarker(trimmed)));
    if (text) return clip(text, EXCERPT_MAX_CHARS);
  }
  return undefined;
}

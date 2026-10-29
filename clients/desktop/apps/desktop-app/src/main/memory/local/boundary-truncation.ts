/** Appended where recalled memory was shortened, pointing at the full text. */
export const LOCAL_MEMORY_MORE_MARKER =
  '[More is saved; use SearchMemory or ReadMemory to see it.]';

export interface BoundaryLimits {
  maxBytes?: number;
  maxChars?: number;
  maxLines?: number;
}

export interface BoundaryClipOptions {
  /** Appended on its own line when anything is cut; counted in the limits. */
  marker?: string;
  /**
   * When not even one whole line fits, keep the leading whole sentences of
   * the first line instead of nothing. For free-text notes, whose body is
   * often a single paragraph.
   */
  sentences?: boolean;
}

export interface BoundaryClip {
  text: string;
  truncated: boolean;
}

const HEADING = /^#{1,6}\s/;
const FENCE = /^\s*(```|~~~)/;
const SENTENCE_END = /(?<=[.!?])\s+/;

/**
 * Lines in a memory file, the way the index limits count them: trailing
 * newlines end the last line rather than starting another.
 */
export function countMemoryLines(text: string): number {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n+$/g, '');
  return normalized.length === 0 ? 0 : normalized.split('\n').length;
}

function fits(text: string, limits: BoundaryLimits): boolean {
  return (
    (limits.maxBytes === undefined ||
      Buffer.byteLength(text, 'utf8') <= limits.maxBytes) &&
    (limits.maxChars === undefined || text.length <= limits.maxChars) &&
    (limits.maxLines === undefined || countMemoryLines(text) <= limits.maxLines)
  );
}

/** Splits at headings outside code fences; each section keeps its heading. */
function splitSections(lines: string[]): string[][] {
  const sections: string[][] = [[]];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    else if (
      !inFence &&
      HEADING.test(line) &&
      sections[sections.length - 1]?.length
    )
      sections.push([]);
    sections[sections.length - 1]?.push(line);
  }
  return sections;
}

function hasBody(lines: string[]): boolean {
  return lines.some((line) => line.trim() !== '' && !HEADING.test(line));
}

/** Drops a trailing unclosed code fence and trailing headings or blanks. */
function tidyCut(lines: string[]): string[] {
  const kept = [...lines];
  let openFence = -1;
  kept.forEach((line, index) => {
    if (FENCE.test(line)) openFence = openFence === -1 ? index : -1;
  });
  if (openFence !== -1) kept.length = openFence;
  while (
    kept.length > 0 &&
    (kept[kept.length - 1]?.trim() === '' ||
      HEADING.test(kept[kept.length - 1] ?? ''))
  ) {
    kept.pop();
  }
  return kept;
}

function leadingSentences(
  line: string,
  limitsFit: (text: string) => boolean,
): string {
  let kept = '';
  for (const sentence of line.split(SENTENCE_END)) {
    const candidate = kept ? `${kept} ${sentence}` : sentence;
    if (!/[.!?]$/.test(sentence) || !limitsFit(candidate)) break;
    kept = candidate;
  }
  return kept;
}

/**
 * Shortens Markdown to the limits without cutting inside a line. Whole
 * sections (a heading and its body) are kept in order; the first section
 * that does not fit is dropped with everything after it. Only when no
 * section body fits at all is that section cut at a line boundary, so a
 * single long section still yields its leading lines. Order is preserved;
 * nothing is reordered or skipped over.
 */
export function clipAtBoundaries(
  text: string,
  limits: BoundaryLimits,
  options: BoundaryClipOptions = {},
): BoundaryClip {
  if (fits(text, limits)) return { text, truncated: false };
  const marker =
    options.marker !== undefined && fits(options.marker, limits)
      ? options.marker
      : undefined;
  const suffix = marker ? `\n${marker}` : '';
  const withinLimits = (lines: string[]): boolean =>
    fits(`${lines.join('\n')}${suffix}`, limits);
  const kept: string[] = [];
  for (const section of splitSections(text.split('\n'))) {
    if (withinLimits([...kept, ...section])) {
      kept.push(...section);
      continue;
    }
    if (!hasBody(kept)) {
      kept.push(...leadingPartOf(section, kept, withinLimits, options));
    }
    break;
  }
  const body = tidyCut(kept).join('\n').trimEnd();
  const clipped = marker ? (body ? `${body}\n${marker}` : marker) : body;
  return { text: clipped, truncated: true };
}

/**
 * The leading whole lines of a section too big to keep whole, or with
 * `sentences`, the leading whole sentences of its first line when no line
 * fits.
 */
function leadingPartOf(
  section: string[],
  kept: string[],
  withinLimits: (lines: string[]) => boolean,
  options: BoundaryClipOptions,
): string[] {
  const lines: string[] = [];
  for (const line of section) {
    if (!withinLimits([...kept, ...lines, line])) break;
    lines.push(line);
  }
  if (hasBody(lines) || !options.sentences) return lines;
  const firstLine = section.find(
    (line) => line.trim() !== '' && !HEADING.test(line),
  );
  const sentences =
    firstLine === undefined
      ? ''
      : leadingSentences(firstLine, (candidate) =>
          withinLimits([...kept, ...lines, candidate]),
        );
  return sentences ? [...lines, sentences] : lines;
}

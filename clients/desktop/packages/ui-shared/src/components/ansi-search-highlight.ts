/**
 * Injects `<mark>` highlight tags into AnsiUp-produced HTML strings
 * for search-in-content highlighting.
 *
 * Handles matches that span across HTML tag boundaries
 * (e.g. `<span style="color:red">err</span>or` matching "error").
 */

interface HtmlSegment {
  kind: 'tag' | 'text';
  content: string;
}

interface HighlightResult {
  /** The HTML string with `<mark>` tags injected around matches. */
  html: string;
  /** Number of matches found in this line. */
  matchCount: number;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse an HTML string into a sequence of tag and text segments.
 * Tags are `<...>` sequences; text is everything between them.
 */
function parseHtmlSegments(html: string): HtmlSegment[] {
  const segments: HtmlSegment[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) {
        // Malformed — treat rest as text
        segments.push({ kind: 'text', content: html.slice(i) });
        break;
      }
      segments.push({ kind: 'tag', content: html.slice(i, end + 1) });
      i = end + 1;
    } else {
      const next = html.indexOf('<', i);
      const textEnd = next === -1 ? html.length : next;
      segments.push({ kind: 'text', content: html.slice(i, textEnd) });
      i = textEnd;
    }
  }
  return segments;
}

/**
 * Decode common HTML entities so we can match against the visible text.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, '\u00A0');
}

/**
 * Highlight all occurrences of `query` within a single HTML line.
 *
 * @param html        The AnsiUp-produced HTML string for one line.
 * @param query       The search query (plain text, case-insensitive).
 * @param globalStart Running match index counter (so data-match-index is globally unique).
 * @param activeIndex The globally active match index, or -1.
 * @returns The modified HTML and the number of matches found.
 */
function highlightHtmlLine(
  html: string,
  query: string,
  globalStart: number,
  activeIndex: number,
): HighlightResult {
  if (query.length === 0) {
    return { html, matchCount: 0 };
  }

  const segments = parseHtmlSegments(html);

  // Build a map from decoded-text offset to (segmentIndex, offsetWithinSegment)
  // We work with the raw (encoded) text for reconstruction but match against decoded text.
  const textSegmentIndices: number[] = [];
  const decodedTexts: string[] = [];
  let decodedFullText = '';

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (seg.kind === 'text') {
      const decoded = decodeEntities(seg.content);
      textSegmentIndices.push(si);
      decodedTexts.push(decoded);
      decodedFullText += decoded;
    }
  }

  // Find all match positions in the decoded full text
  const pattern = new RegExp(escapeRegExp(query), 'gi');
  const matches: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null = null;
  while ((m = pattern.exec(decodedFullText)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length });
  }

  if (matches.length === 0) {
    return { html, matchCount: 0 };
  }

  // Build a character-level map: for each char in decodedFullText,
  // which text segment does it belong to and at what offset within
  // that segment's *encoded* content?
  interface CharMapping {
    segIdx: number;
    encodedOffset: number;
  }

  const charMap: CharMapping[] = [];
  let decodedOffset = 0;

  for (let ti = 0; ti < textSegmentIndices.length; ti++) {
    const segIdx = textSegmentIndices[ti];
    const encoded = segments[segIdx].content;
    let ei = 0;
    while (ei < encoded.length) {
      // Check for HTML entity
      const entityMatch = /^&[a-zA-Z0-9#]+;/.exec(encoded.slice(ei));
      if (entityMatch) {
        const decoded = decodeEntities(entityMatch[0]);
        for (let ci = 0; ci < decoded.length; ci++) {
          charMap[decodedOffset++] = {
            segIdx,
            encodedOffset: ei,
          };
        }
        ei += entityMatch[0].length;
      } else {
        charMap[decodedOffset++] = {
          segIdx,
          encodedOffset: ei,
        };
        ei++;
      }
    }
  }

  // Now reconstruct the HTML, injecting <mark> around matches.
  // We process segment by segment, tracking which matches overlap each segment.

  // For each text segment, collect the mark insertions needed
  interface Insertion {
    encodedOffset: number;
    type: 'open' | 'close';
    matchIndex: number;
  }

  const segmentInsertions = new Map<number, Insertion[]>();

  for (let mi = 0; mi < matches.length; mi++) {
    const matchStart = matches[mi].start;
    const matchEnd = matches[mi].end;

    // Open mark at matchStart
    if (matchStart < charMap.length) {
      const startMap = charMap[matchStart];
      const insertions = segmentInsertions.get(startMap.segIdx) ?? [];
      insertions.push({
        encodedOffset: startMap.encodedOffset,
        type: 'open',
        matchIndex: mi,
      });
      segmentInsertions.set(startMap.segIdx, insertions);
    }

    // Close mark at matchEnd (after the last char of the match)
    if (matchEnd > 0 && matchEnd - 1 < charMap.length) {
      const endMap = charMap[matchEnd - 1];
      // The close goes AFTER this character. Find the end of this char in encoded.
      const seg = segments[endMap.segIdx];
      const encoded = seg.content;
      let closeOffset = endMap.encodedOffset + 1;
      // If the char is the start of an entity, skip past the entity
      if (encoded[endMap.encodedOffset] === '&') {
        const entityEnd = encoded.indexOf(';', endMap.encodedOffset);
        if (entityEnd !== -1) {
          closeOffset = entityEnd + 1;
        }
      }
      const insertions = segmentInsertions.get(endMap.segIdx) ?? [];
      insertions.push({
        encodedOffset: closeOffset,
        type: 'close',
        matchIndex: mi,
      });
      segmentInsertions.set(endMap.segIdx, insertions);
    }
  }

  // For matches that span multiple text segments, we need to close at segment end
  // and re-open at next segment start. Process each text segment.
  // Track which matches are "open" as we move through segments.
  const openMatches = new Set<number>();
  const result: string[] = [];

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];

    if (seg.kind === 'tag') {
      result.push(seg.content);
      continue;
    }

    const insertions = segmentInsertions.get(si) ?? [];
    // Sort: by offset ascending, closes before opens at same offset
    insertions.sort((a, b) => {
      if (a.encodedOffset !== b.encodedOffset)
        return a.encodedOffset - b.encodedOffset;
      // closes before opens at same position
      if (a.type === 'close' && b.type === 'open') return -1;
      if (a.type === 'open' && b.type === 'close') return 1;
      return 0;
    });

    const encoded = seg.content;
    let pos = 0;
    let out = '';

    // If there are open matches from a previous segment, re-open them
    const openArr: number[] = Array.from(openMatches);
    for (const mi of openArr) {
      const globalIdx = globalStart + mi;
      const cls =
        globalIdx === activeIndex
          ? 'search-match search-match-active'
          : 'search-match';
      out += `<mark class="${cls}" data-match-index="${String(globalIdx)}">`;
    }

    for (const ins of insertions) {
      // Emit text before this insertion
      if (ins.encodedOffset > pos) {
        out += encoded.slice(pos, ins.encodedOffset);
        pos = ins.encodedOffset;
      }

      if (ins.type === 'close') {
        out += '</mark>';
        openMatches.delete(ins.matchIndex);
      } else {
        openMatches.add(ins.matchIndex);
        const globalIdx = globalStart + ins.matchIndex;
        const cls =
          globalIdx === activeIndex
            ? 'search-match search-match-active'
            : 'search-match';
        out += `<mark class="${cls}" data-match-index="${String(globalIdx)}">`;
      }
    }

    // Emit remaining text
    if (pos < encoded.length) {
      out += encoded.slice(pos);
    }

    // If there are still open matches at segment end, close them
    // (they will be re-opened at the next text segment)
    for (let oi = 0; oi < openMatches.size; oi++) {
      out += '</mark>';
    }

    result.push(out);
  }

  return { html: result.join(''), matchCount: matches.length };
}

export interface HtmlLine {
  id: number;
  html: string;
}

export interface HighlightAllResult {
  lines: HtmlLine[];
  totalCount: number;
}

/**
 * Highlight all occurrences of `query` across an array of AnsiOutput HTML lines.
 * Returns new HtmlLine objects (same ids) with `<mark>` tags injected, plus total count.
 */
export function highlightAnsiHtml(
  htmlLines: HtmlLine[],
  query: string,
  activeIndex: number,
): HighlightAllResult {
  if (query.length === 0) {
    return { lines: htmlLines, totalCount: 0 };
  }

  let globalMatchIndex = 0;
  const resultLines: HtmlLine[] = [];

  for (const line of htmlLines) {
    const { html, matchCount } = highlightHtmlLine(
      line.html,
      query,
      globalMatchIndex,
      activeIndex,
    );
    resultLines.push({ id: line.id, html });
    globalMatchIndex += matchCount;
  }

  return { lines: resultLines, totalCount: globalMatchIndex };
}

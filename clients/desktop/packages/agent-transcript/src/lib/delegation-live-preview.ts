import {
  TOOL_OUTPUT_INLINE_BYTES,
  TOOL_OUTPUT_PREVIEW_HEAD_BYTES,
} from '../transcript-storage';

const LIVE_PREVIEW_MARKER =
  '\n[Preview: full text is kept when this item finishes]\n';

function utf8Size(point: number): number {
  return point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
}

function withinInlineBudget(text: string): boolean {
  // A UTF-16 unit takes at most three UTF-8 bytes; a pair takes four, not six.
  // Huge growing fields are rejected by length alone, so only the edges are scanned.
  if (text.length * 3 <= TOOL_OUTPUT_INLINE_BYTES) return true;
  if (text.length > TOOL_OUTPUT_INLINE_BYTES) return false;
  let bytes = 0;
  for (let index = 0; index < text.length; ) {
    const point = text.codePointAt(index);
    if (point === undefined) break;
    bytes += utf8Size(point);
    if (bytes > TOOL_OUTPUT_INLINE_BYTES) return false;
    index += point > 0xffff ? 2 : 1;
  }
  return true;
}

function utf8Prefix(
  text: string,
  budget: number,
): { text: string; bytes: number } {
  let end = 0;
  let bytes = 0;
  while (end < text.length) {
    const point = text.codePointAt(end);
    if (point === undefined) break;
    const size = utf8Size(point);
    if (bytes + size > budget) break;
    bytes += size;
    end += point > 0xffff ? 2 : 1;
  }
  return { text: text.slice(0, end), bytes };
}

function utf8Suffix(text: string, budget: number): string {
  let start = text.length;
  let bytes = 0;
  while (start > 0) {
    const last = text.charCodeAt(start - 1);
    const prior = start >= 2 ? text.charCodeAt(start - 2) : 0;
    const paired =
      last >= 0xdc00 && last <= 0xdfff && prior >= 0xd800 && prior <= 0xdbff;
    const size = paired ? 4 : utf8Size(last);
    if (bytes + size > budget) break;
    bytes += size;
    start -= paired ? 2 : 1;
  }
  return text.slice(start);
}

/** Bounded, code-point-safe live field preview; completed items retain their full text. */
export function delegationLivePreview(text: string): string {
  if (withinInlineBudget(text)) return text;
  const head = utf8Prefix(text, TOOL_OUTPUT_PREVIEW_HEAD_BYTES);
  // The marker is ASCII, so its code-unit count is also its UTF-8 byte count.
  const tailBudget =
    TOOL_OUTPUT_INLINE_BYTES - head.bytes - LIVE_PREVIEW_MARKER.length;
  return head.text + LIVE_PREVIEW_MARKER + utf8Suffix(text, tailBudget);
}

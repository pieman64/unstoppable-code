const META_TAG_OPEN_LENGTH = '<meta'.length;

interface StripResult {
  content: string;
  /** Characters read while parsing candidate tags. */
  examinedCharacters: number;
  /** True when the work budget ran out and the rest was neutralized. */
  usedFallback: boolean;
}

/**
 * Remove `<meta http-equiv>` tags whose pragma is in `httpEquivValues`
 * (lowercase keywords) from untrusted markup.
 *
 * Every `<meta` occurrence is examined, whatever surrounds it, so a real tag
 * is never missed and a textual look-alike may be removed too. A tag whose
 * removal could change how surrounding text parses is renamed to `<x-meta`
 * instead, which leaves it inert without moving any other character.
 */
export function stripHttpEquivMetaTags(
  content: string,
  httpEquivValues: ReadonlySet<string>,
): string {
  return stripHttpEquivMetaTagsWithStats(content, httpEquivValues).content;
}

/** Internal entry point that also reports how much parsing work was done. */
export function stripHttpEquivMetaTagsWithStats(
  content: string,
  httpEquivValues: ReadonlySet<string>,
): StripResult {
  if (httpEquivValues.size === 0) {
    return { content, examinedCharacters: 0, usedFallback: false };
  }

  const budget: CharacterBudget = {
    limit: 4 * content.length + 65_536,
    examined: 0,
  };
  const writer = createWriter(content);
  const occurrencePattern = /<meta(?=[\t\n\f\r />])/gi;
  // End of the furthest text an earlier kept tag's parse depended on.
  let keptExtent = 0;
  let scanFrom = 0;

  for (;;) {
    const tagStart = findNextOccurrence(content, occurrencePattern, scanFrom);
    if (tagStart === null) break;

    const decision = classifyOccurrence(
      content,
      tagStart,
      httpEquivValues,
      budget,
    );
    if (decision.kind === 'budget-exhausted') {
      neutralizeFrom(writer, tagStart, occurrencePattern);
      return finish(writer, budget, true);
    }
    scanFrom = tagStart + META_TAG_OPEN_LENGTH;
    if (decision.kind === 'keep') {
      keptExtent = Math.max(keptExtent, decision.extent);
      continue;
    }

    writer.copyThrough(tagStart);
    if (tagStart < keptExtent || endsWithMetaPrefix(writer.tail)) {
      // Removing text here could re-form a tag out of what surrounds it.
      writer.renameTagAt(tagStart);
      keptExtent = Math.max(keptExtent, decision.end);
    } else {
      writer.skipTo(decision.end);
      scanFrom = decision.end;
    }
  }

  return finish(writer, budget, false);
}

type OccurrenceDecision =
  | { kind: 'strip'; end: number }
  | { kind: 'keep'; extent: number }
  | { kind: 'budget-exhausted' };

function classifyOccurrence(
  content: string,
  tagStart: number,
  httpEquivValues: ReadonlySet<string>,
  budget: CharacterBudget,
): OccurrenceDecision {
  const parsed = parseMetaTag(content, tagStart, budget);
  if (parsed.kind === 'budget-exhausted') return parsed;
  // A tag that never closes is dropped by the parser, but its text runs on.
  if (parsed.kind === 'unterminated') {
    return { kind: 'keep', extent: content.length };
  }
  if (parsed.httpEquiv === null) return { kind: 'keep', extent: parsed.end };

  const value = decodeAndNormalizeValue(
    content,
    parsed.httpEquiv.start,
    parsed.httpEquiv.end,
    budget,
  );
  if (value === null) return { kind: 'budget-exhausted' };
  return httpEquivValues.has(value)
    ? { kind: 'strip', end: parsed.end }
    : { kind: 'keep', extent: parsed.end };
}

interface Writer {
  readonly source: string;
  readonly modified: boolean;
  /** Last characters written, enough to spot a dangling `<meta` prefix. */
  readonly tail: string;
  copyThrough(end: number): void;
  skipTo(end: number): void;
  renameTagAt(tagStart: number): void;
  toString(): string;
}

function createWriter(content: string): Writer {
  const output: string[] = [];
  let copied = 0;
  let tail = '';
  let modified = false;

  const copyThrough = (end: number): void => {
    if (end <= copied) return;
    output.push(content.slice(copied, end));
    const tailStart = Math.max(copied, end - META_TAG_OPEN_LENGTH);
    tail = `${tail}${content.slice(tailStart, end)}`.slice(
      -META_TAG_OPEN_LENGTH,
    );
    copied = end;
  };

  return {
    source: content,
    get modified(): boolean {
      return modified;
    },
    get tail(): string {
      return tail;
    },
    copyThrough,
    skipTo(end): void {
      copied = Math.max(copied, end);
      modified = true;
    },
    renameTagAt(tagStart): void {
      copyThrough(tagStart + 1);
      output.push('x-');
      tail = `${tail}x-`.slice(-META_TAG_OPEN_LENGTH);
      modified = true;
    },
    toString(): string {
      copyThrough(content.length);
      return output.join('');
    },
  };
}

function neutralizeFrom(writer: Writer, start: number, pattern: RegExp): void {
  const content = writer.source;
  pattern.lastIndex = start;
  for (
    let match = pattern.exec(content);
    match !== null;
    match = pattern.exec(content)
  ) {
    writer.renameTagAt(match.index);
  }
}

function finish(
  writer: Writer,
  budget: CharacterBudget,
  usedFallback: boolean,
): StripResult {
  return {
    content: writer.modified ? writer.toString() : writer.source,
    examinedCharacters: budget.examined,
    usedFallback,
  };
}

interface CharacterBudget {
  limit: number;
  examined: number;
}

interface ValueRange {
  start: number;
  end: number;
}

type TagParseResult =
  | { kind: 'complete'; end: number; httpEquiv: ValueRange | null }
  | { kind: 'unterminated' }
  | { kind: 'budget-exhausted' };

type AttributeNameResult =
  | { kind: 'complete'; end: number; isHttpEquiv: boolean }
  | { kind: 'unterminated' }
  | { kind: 'budget-exhausted' };

type AttributeValueResult =
  | { kind: 'complete'; end: number; value: ValueRange }
  | { kind: 'unterminated' }
  | { kind: 'budget-exhausted' };

type AttributeResult =
  | { kind: 'complete'; next: number; isHttpEquiv: boolean; value: ValueRange }
  | { kind: 'unterminated' }
  | { kind: 'budget-exhausted' };

interface CharacterReferenceResult {
  end: number;
  value: string;
}

interface NumericReferenceStart {
  digitStart: number;
  radix: number;
}

function findNextOccurrence(
  content: string,
  pattern: RegExp,
  start: number,
): number | null {
  pattern.lastIndex = start;
  const match = pattern.exec(content);
  return match === null ? null : match.index;
}

function parseMetaTag(
  content: string,
  tagStart: number,
  budget: CharacterBudget,
): TagParseResult {
  let cursor = tagStart + 5;
  let firstHttpEquiv: ValueRange | null = null;

  while (cursor < content.length) {
    const code = readCharacter(content, cursor, budget);
    if (code === undefined) {
      return { kind: 'budget-exhausted' };
    }
    if (code === 62) {
      return { kind: 'complete', end: cursor + 1, httpEquiv: firstHttpEquiv };
    }
    if (isAsciiWhitespace(code) || code === 47) {
      cursor++;
      continue;
    }

    const attribute = parseAttribute(content, cursor, budget);
    if (attribute.kind !== 'complete') {
      return attribute;
    }
    if (attribute.isHttpEquiv && firstHttpEquiv === null) {
      firstHttpEquiv = attribute.value;
    }
    cursor = attribute.next;
  }

  return { kind: 'unterminated' };
}

function parseAttribute(
  content: string,
  start: number,
  budget: CharacterBudget,
): AttributeResult {
  const name = scanAttributeName(content, start, budget);
  if (name.kind !== 'complete') {
    return name;
  }

  const afterWhitespace = skipWhitespace(content, name.end, budget);
  if (afterWhitespace === null) {
    return { kind: 'budget-exhausted' };
  }

  if (afterWhitespace >= content.length) {
    return {
      kind: 'complete',
      next: afterWhitespace,
      isHttpEquiv: name.isHttpEquiv,
      value: { start: afterWhitespace, end: afterWhitespace },
    };
  }

  const possibleEquals = readCharacter(content, afterWhitespace, budget);
  if (possibleEquals === undefined) {
    return { kind: 'budget-exhausted' };
  }
  if (possibleEquals !== 61) {
    return {
      kind: 'complete',
      next: afterWhitespace,
      isHttpEquiv: name.isHttpEquiv,
      value: { start: afterWhitespace, end: afterWhitespace },
    };
  }

  const valueStart = skipWhitespace(content, afterWhitespace + 1, budget);
  if (valueStart === null) {
    return { kind: 'budget-exhausted' };
  }
  const value = readAttributeValue(content, valueStart, budget);
  if (value.kind !== 'complete') {
    return value;
  }

  return {
    kind: 'complete',
    next: value.end,
    isHttpEquiv: name.isHttpEquiv,
    value: value.value,
  };
}

function scanAttributeName(
  content: string,
  start: number,
  budget: CharacterBudget,
): AttributeNameResult {
  // The first character always belongs to the name, even when it is `=`.
  let cursor = start + 1;
  while (cursor < content.length) {
    const code = readCharacter(content, cursor, budget);
    if (code === undefined) {
      return { kind: 'budget-exhausted' };
    }
    if (isAsciiWhitespace(code) || code === 47 || code === 61 || code === 62) {
      const isHttpEquiv = matchesHttpEquivName(content, start, cursor, budget);
      if (isHttpEquiv === null) {
        return { kind: 'budget-exhausted' };
      }
      return { kind: 'complete', end: cursor, isHttpEquiv };
    }
    cursor++;
  }

  return { kind: 'unterminated' };
}

function matchesHttpEquivName(
  content: string,
  start: number,
  end: number,
  budget: CharacterBudget,
): boolean | null {
  const name = 'http-equiv';
  if (end - start !== name.length) {
    return false;
  }

  for (let offset = 0; offset < name.length; offset++) {
    const code = readCharacter(content, start + offset, budget);
    if (code === undefined) {
      return null;
    }
    if (asciiLowerCode(code) !== name.charCodeAt(offset)) {
      return false;
    }
  }
  return true;
}

function skipWhitespace(
  content: string,
  start: number,
  budget: CharacterBudget,
): number | null {
  let cursor = start;
  while (cursor < content.length) {
    const code = readCharacter(content, cursor, budget);
    if (code === undefined) {
      return null;
    }
    if (!isAsciiWhitespace(code)) {
      return cursor;
    }
    cursor++;
  }
  return cursor;
}

function readAttributeValue(
  content: string,
  start: number,
  budget: CharacterBudget,
): AttributeValueResult {
  if (start >= content.length) {
    return { kind: 'complete', end: start, value: { start, end: start } };
  }

  const firstCode = readCharacter(content, start, budget);
  if (firstCode === undefined) {
    return { kind: 'budget-exhausted' };
  }

  if (firstCode === 34 || firstCode === 39) {
    return readQuotedValue(content, start, firstCode, budget);
  }
  return readUnquotedValue(content, start, budget);
}

function readQuotedValue(
  content: string,
  start: number,
  quote: number,
  budget: CharacterBudget,
): AttributeValueResult {
  const valueStart = start + 1;
  let cursor = valueStart;
  while (cursor < content.length) {
    const code = readCharacter(content, cursor, budget);
    if (code === undefined) {
      return { kind: 'budget-exhausted' };
    }
    if (code === quote) {
      return {
        kind: 'complete',
        end: cursor + 1,
        value: { start: valueStart, end: cursor },
      };
    }
    cursor++;
  }
  return { kind: 'unterminated' };
}

function readUnquotedValue(
  content: string,
  start: number,
  budget: CharacterBudget,
): AttributeValueResult {
  let cursor = start;
  while (cursor < content.length) {
    const code = readCharacter(content, cursor, budget);
    if (code === undefined) {
      return { kind: 'budget-exhausted' };
    }
    if (isAsciiWhitespace(code) || code === 62) {
      return { kind: 'complete', end: cursor, value: { start, end: cursor } };
    }
    cursor++;
  }
  return { kind: 'complete', end: cursor, value: { start, end: cursor } };
}

function decodeAndNormalizeValue(
  content: string,
  start: number,
  end: number,
  budget: CharacterBudget,
): string | null {
  const decoded: string[] = [];
  let cursor = start;

  while (cursor < end) {
    const code = readCharacter(content, cursor, budget);
    if (code === undefined) {
      return null;
    }
    if (code === 38) {
      const reference = readCharacterReference(content, cursor, end, budget);
      if (reference === null) {
        return null;
      }
      decoded.push(reference.value);
      cursor = reference.end;
    } else {
      decoded.push(String.fromCharCode(asciiLowerCode(code)));
      cursor++;
    }
  }

  return trimAsciiWhitespace(decoded.join(''), budget);
}

function readCharacterReference(
  content: string,
  start: number,
  valueEnd: number,
  budget: CharacterBudget,
): CharacterReferenceResult | null {
  if (start + 1 >= valueEnd) {
    return { end: start + 1, value: '&' };
  }

  const marker = readCharacter(content, start + 1, budget);
  if (marker === undefined) {
    return null;
  }
  // No other named reference adds an ASCII keyword character or ASCII whitespace.
  if (marker === 84) {
    return readNamedWhitespaceReference(
      content,
      start,
      valueEnd,
      '&Tab;',
      '\t',
      budget,
    );
  }
  if (marker === 78) {
    return readNamedWhitespaceReference(
      content,
      start,
      valueEnd,
      '&NewLine;',
      '\n',
      budget,
    );
  }
  if (marker !== 35) {
    return { end: start + 1, value: '&' };
  }

  const referenceStart = readNumericReferenceStart(
    content,
    start + 2,
    valueEnd,
    budget,
  );
  if (referenceStart === null) {
    return null;
  }
  return readNumericReferenceDigits(
    content,
    start,
    referenceStart.digitStart,
    referenceStart.radix,
    valueEnd,
    budget,
  );
}

function readNamedWhitespaceReference(
  content: string,
  start: number,
  valueEnd: number,
  name: string,
  value: string,
  budget: CharacterBudget,
): CharacterReferenceResult | null {
  for (let offset = 2; offset < name.length; offset++) {
    if (start + offset >= valueEnd) {
      return { end: start + 1, value: '&' };
    }
    const code = readCharacter(content, start + offset, budget);
    if (code === undefined) {
      return null;
    }
    if (code !== name.charCodeAt(offset)) {
      return { end: start + 1, value: '&' };
    }
  }
  return { end: start + name.length, value };
}

function readNumericReferenceStart(
  content: string,
  start: number,
  valueEnd: number,
  budget: CharacterBudget,
): NumericReferenceStart | null {
  if (start >= valueEnd) {
    return { digitStart: start, radix: 10 };
  }

  const possibleHex = readCharacter(content, start, budget);
  if (possibleHex === undefined) {
    return null;
  }
  if (possibleHex === 120 || possibleHex === 88) {
    return { digitStart: start + 1, radix: 16 };
  }
  return { digitStart: start, radix: 10 };
}

function readNumericReferenceDigits(
  content: string,
  referenceStart: number,
  digitStart: number,
  radix: number,
  valueEnd: number,
  budget: CharacterBudget,
): CharacterReferenceResult | null {
  let digitCount = 0;
  let codePoint = 0;
  let cursor = digitStart;
  while (cursor < valueEnd) {
    const code = readCharacter(content, cursor, budget);
    if (code === undefined) {
      return null;
    }
    const digit = numericDigit(code, radix);
    if (digit === null) {
      break;
    }
    digitCount++;
    codePoint = Math.min(0x110000, codePoint * radix + digit);
    cursor++;
  }

  if (digitCount === 0) {
    return {
      end: digitStart,
      value: asciiLowercase(content.slice(referenceStart, digitStart)),
    };
  }

  const referenceEnd = skipOptionalSemicolon(content, cursor, valueEnd, budget);
  if (referenceEnd === null) {
    return null;
  }
  return { end: referenceEnd, value: normalizeCodePoint(codePoint) };
}

function skipOptionalSemicolon(
  content: string,
  cursor: number,
  valueEnd: number,
  budget: CharacterBudget,
): number | null {
  if (cursor >= valueEnd) {
    return cursor;
  }
  const possibleSemicolon = readCharacter(content, cursor, budget);
  if (possibleSemicolon === undefined) {
    return null;
  }
  return possibleSemicolon === 59 ? cursor + 1 : cursor;
}

function numericDigit(code: number, radix: number): number | null {
  if (code >= 48 && code <= 57) {
    return code - 48;
  }
  if (radix === 16 && code >= 65 && code <= 70) {
    return code - 55;
  }
  if (radix === 16 && code >= 97 && code <= 102) {
    return code - 87;
  }
  return null;
}

/** Only ASCII can match a pragma keyword, so everything else collapses. */
function normalizeCodePoint(codePoint: number): string {
  if (codePoint === 0 || codePoint > 0x7f) return '\ufffd';
  return String.fromCharCode(asciiLowerCode(codePoint));
}

function trimAsciiWhitespace(
  value: string,
  budget: CharacterBudget,
): string | null {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const code = readCharacter(value, start, budget);
    if (code === undefined) {
      return null;
    }
    if (!isAsciiWhitespace(code)) {
      break;
    }
    start++;
  }
  while (end > start) {
    const code = readCharacter(value, end - 1, budget);
    if (code === undefined) {
      return null;
    }
    if (!isAsciiWhitespace(code)) {
      break;
    }
    end--;
  }
  return value.slice(start, end);
}

function asciiLowercase(value: string): string {
  const lower: string[] = [];
  for (let index = 0; index < value.length; index++) {
    lower.push(String.fromCharCode(asciiLowerCode(value.charCodeAt(index))));
  }
  return lower.join('');
}

function endsWithMetaPrefix(value: string): boolean {
  const metaPrefix = '<meta';
  const maxLength = Math.min(value.length, metaPrefix.length);
  for (let length = 1; length <= maxLength; length++) {
    let matches = true;
    for (let offset = 0; offset < length; offset++) {
      const valueCode = value.charCodeAt(value.length - length + offset);
      if (asciiLowerCode(valueCode) !== metaPrefix.charCodeAt(offset)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
}

function readCharacter(
  content: string,
  index: number,
  budget: CharacterBudget,
): number | undefined {
  if (budget.examined >= budget.limit) {
    return undefined;
  }
  budget.examined++;
  return content.charCodeAt(index);
}

function asciiLowerCode(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

function isAsciiWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

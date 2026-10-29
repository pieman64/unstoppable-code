import { LEDGER_LIMITS } from './limits';

export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export function containsDisallowedControlCharacters(
  value: string,
  options: { allowLineBreaks: boolean },
): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;

    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      if (
        options.allowLineBreaks &&
        (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d)
      ) {
        continue;
      }
      return true;
    }
  }

  return false;
}

/**
 * The title an entry gets when its author wrote none: the start of its
 * content on one line, cut to the title limit by code point. The content's
 * line breaks and tabs become single spaces.
 */
export function ledgerProvisionalTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  return Array.from(oneLine)
    .slice(0, LEDGER_LIMITS.titleMaxCodePoints)
    .join('')
    .trimEnd();
}

export function isPortableRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    containsDisallowedControlCharacters(path, { allowLineBreaks: false }) ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path)
  ) {
    return false;
  }

  return path
    .split('/')
    .every(
      (segment: string): boolean =>
        segment !== '' && segment !== '.' && segment !== '..',
    );
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function isWithinLedgerRequestLimit(value: unknown): boolean {
  try {
    const serialized: string | undefined = JSON.stringify(value);
    // UTF-8 never uses fewer bytes than UTF-16 code units, so a long string is
    // rejected without encoding it.
    return (
      serialized !== undefined &&
      serialized.length <= LEDGER_LIMITS.requestMaxBytes &&
      utf8ByteLength(serialized) <= LEDGER_LIMITS.requestMaxBytes
    );
  } catch {
    return false;
  }
}

export function normalizeLedgerFileRefs<
  T extends { rootId: string; path: string; startLine?: number },
>(refs: readonly T[]): T[] {
  const seen = new Map<string, Map<string, Set<number | null>>>();
  const normalized: T[] = [];

  for (const ref of refs) {
    let paths = seen.get(ref.rootId);
    if (paths === undefined) {
      paths = new Map<string, Set<number | null>>();
      seen.set(ref.rootId, paths);
    }

    let startLines = paths.get(ref.path);
    if (startLines === undefined) {
      startLines = new Set<number | null>();
      paths.set(ref.path, startLines);
    }

    const startLine = ref.startLine ?? null;
    if (startLines.has(startLine)) continue;
    startLines.add(startLine);
    normalized.push(ref);
  }

  return normalized;
}

export function resolveRichSelectionLines(
  raw: string,
  quote: string,
): { lineStart: number; lineEnd: number } | null {
  const offset = raw.indexOf(quote);
  if (offset < 0 || raw.indexOf(quote, offset + 1) >= 0) {
    return null;
  }
  const lineStart = raw.slice(0, offset).split(/\r?\n/).length;
  return {
    lineStart,
    lineEnd: lineStart + quote.split(/\r?\n/).length - 1,
  };
}

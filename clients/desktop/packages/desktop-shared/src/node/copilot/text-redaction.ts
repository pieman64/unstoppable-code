import {
  MaskedKeyAllocator,
  normalizedSecretRanges,
  redactStructuredValue,
  redactNormalizedPreservingFormat,
} from '../../lib/redaction';

/** Mask decoded tool values before JSON escaping can hide reflowed secrets. */
export function redactCopilotToolValue(
  value: unknown,
  secrets: readonly string[],
): unknown {
  if (!secrets.length) return value;
  const reflowed = (node: unknown): unknown => {
    if (typeof node === 'string')
      return redactNormalizedPreservingFormat(node, secrets);
    if (Array.isArray(node)) return node.map(reflowed);
    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node).map(
        ([key, entry]: [string, unknown]) => ({
          key,
          masked: redactNormalizedPreservingFormat(key, secrets),
          entry,
        }),
      );
      const keys = new MaskedKeyAllocator();
      for (const { key, masked } of entries)
        if (key === masked) keys.reserveIn(0, key);
      return Object.fromEntries(
        entries.map(({ key, masked, entry }) => [
          key === masked ? key : keys.allocateIn(0, masked, masked),
          reflowed(entry),
        ]),
      );
    }
    return node;
  };
  return reflowed(redactStructuredValue(value, secrets));
}

/** Preserve block ownership while masking values split across message boundaries. */
export function redactCopilotTextParts(
  parts: readonly string[],
  secrets: readonly string[],
): string[] {
  const spans = normalizedSecretRanges(parts.join(''), secrets);
  if (!spans.length) return [...parts];
  let start = 0;
  let nextSpan = 0;
  return parts.map((part) => {
    const end = start + part.length;
    let offset = start;
    let result = '';
    while (nextSpan < spans.length && spans[nextSpan].start < end) {
      const span = spans[nextSpan];
      if (span.start >= start)
        result += part.slice(offset - start, span.start - start) + '***';
      offset = Math.min(span.end, end);
      if (span.end <= end) nextSpan++;
      else break;
    }
    result += part.slice(offset - start);
    start = end;
    return result;
  });
}

/**
 * Deterministic JSON serialization shared by every protocol module that hashes
 * or compares JSON-only values (shared plans, desktop inventory sync).
 *
 * Object keys are sorted recursively, arrays keep their order, and `undefined`
 * members are dropped (and become `null` inside arrays) exactly as
 * `JSON.stringify` does, so two hosts serializing value-equal objects with
 * different insertion order produce identical bytes.
 */
function isStringKeyedRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (isStringKeyedRecord(val)) {
      // Object.fromEntries defines own data properties, so an own `__proto__`
      // key (legal JSON, produced by JSON.parse) is kept instead of being
      // swallowed by the inherited setter a plain assignment would hit.
      return Object.fromEntries(
        Object.keys(val)
          .sort()
          .map((key): [string, unknown] => [key, val[key]]),
      );
    }
    return val;
  });
}

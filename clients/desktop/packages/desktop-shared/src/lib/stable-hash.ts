/**
 * Serialize a JSON-only value with sorted object keys so value-equal objects
 * produce identical strings regardless of insertion order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) {
        sorted[key] = obj[key];
      }
      return sorted;
    }
    return val;
  });
}

/**
 * FNV-1a 32-bit hash. Fast, dependency-free, and stable across processes.
 * NOT a cryptographic hash; do not use for security decisions.
 */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function stableHash(value: unknown): string {
  return fnv1aHex(stableStringify(value));
}

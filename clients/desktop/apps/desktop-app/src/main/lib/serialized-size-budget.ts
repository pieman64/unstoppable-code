/**
 * Decide whether a value's JSON serialization would exceed `maxBytes`
 * without producing that serialization. `JSON.stringify` expands shared
 * references (a YAML alias parsed by js-yaml is one object referenced many
 * times) in full, so a small document can serialize to an exponential
 * amount of text; this walk stops the moment the running estimate passes
 * the budget, so its cost is bounded by the budget, never by the value.
 *
 * The estimate matches `JSON.stringify` exactly for strings (escaping
 * included), numbers, booleans, null, arrays and plain objects, and treats
 * nesting deeper than {@link MAX_SERIALIZED_DEPTH} or a cycle as exceeding
 * the budget.
 */
const MAX_SERIALIZED_DEPTH = 64;

/**
 * Exact byte length of `JSON.stringify(value)` for a string: the quotes,
 * two-byte escapes for `"`, `\\` and the short control escapes, six-byte
 * `\uXXXX` escapes for other control characters and lone surrogates, and
 * UTF-8 for everything else. Stops counting once `budget` is passed, so a
 * huge string costs at most the budget to reject.
 */
function escapedJsonByteLength(value: string, budget: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length && bytes <= budget; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes +=
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
          ? 2
          : 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export interface SerializedSizeMeasurement {
  /**
   * Bytes counted before the walk stopped: the exact serialized size when
   * `exceeded` is false, otherwise the work the walk spent (about
   * `maxBytes`). Callers keeping a scan-wide budget charge this either way.
   */
  bytes: number;
  exceeded: boolean;
}

export function measureSerializedBytes(
  value: unknown,
  maxBytes: number,
): SerializedSizeMeasurement {
  let bytes = 0;
  const ancestors = new Set<object>();

  const walk = (node: unknown, depth: number): boolean => {
    if (depth > MAX_SERIALIZED_DEPTH) return true;
    if (node === null || typeof node === 'boolean') {
      bytes += node === null ? 4 : node ? 4 : 5;
      return bytes > maxBytes;
    }
    if (typeof node === 'number') {
      bytes += Number.isFinite(node) ? String(node).length : 4;
      return bytes > maxBytes;
    }
    if (typeof node === 'string') {
      bytes += escapedJsonByteLength(node, maxBytes - bytes);
      return bytes > maxBytes;
    }
    if (typeof node !== 'object') {
      // undefined, functions and symbols serialize to nothing (or null in
      // arrays); either way they cannot push a value past the budget.
      bytes += 4;
      return bytes > maxBytes;
    }
    if (ancestors.has(node)) return true;
    ancestors.add(node);
    try {
      if (Array.isArray(node)) {
        bytes += 2 + Math.max(0, node.length - 1);
        if (bytes > maxBytes) return true;
        for (const item of node) {
          if (walk(item, depth + 1)) return true;
        }
        return false;
      }
      // Undefined properties are omitted by JSON.stringify entirely.
      const entries = Object.entries(node).filter(
        ([, item]) => item !== undefined,
      );
      bytes += 2 + Math.max(0, entries.length - 1);
      if (bytes > maxBytes) return true;
      for (const [key, item] of entries) {
        bytes += 1 + escapedJsonByteLength(key, maxBytes - bytes);
        if (bytes > maxBytes) return true;
        if (walk(item, depth + 1)) return true;
      }
      return false;
    } finally {
      ancestors.delete(node);
    }
  };

  const exceeded = walk(value, 0);
  return { bytes, exceeded };
}

export function exceedsSerializedBudget(
  value: unknown,
  maxBytes: number,
): boolean {
  return measureSerializedBytes(value, maxBytes).exceeded;
}

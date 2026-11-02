import { deepStrictEqual } from 'node:assert';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function omitUndefinedFields(value: unknown): void {
  if (Array.isArray(value)) {
    const entries: unknown[] = value;
    entries.forEach(omitUndefinedFields);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      Reflect.deleteProperty(value, key);
    } else {
      omitUndefinedFields(entry);
    }
  }
}

/** Verify a plain-data record survives JSON, allowing absent optional fields. */
export function jsonRecordRoundTrip<T>(value: T): T {
  const expected = structuredClone(value);
  omitUndefinedFields(expected);
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  // Native structuredClone and Jest's JSON.parse produce different-realm objects.
  const actual = structuredClone(parsed);
  deepStrictEqual(actual, expected);
  return actual;
}

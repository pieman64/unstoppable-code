/** Framework-neutral assertions; a failure throws, which any runner reports. */

export class AgentConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConformanceFailure';
  }
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Order-independent JSON text for deep comparison. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isJsonRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const text: string | undefined = JSON.stringify(value);
  return text ?? 'null';
}

export function check(condition: boolean, message: string): void {
  if (!condition) throw new AgentConformanceFailure(message);
}

export function checkEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  const actualJson = canonicalJson(actual);
  const expectedJson = canonicalJson(expected);
  check(
    actualJson === expectedJson,
    `${label}\nexpected: ${expectedJson}\nreceived: ${actualJson}`,
  );
}

/**
 * Whether `actual` contains `expected`: objects match on the expected keys,
 * arrays match element-wise with equal length, other values match exactly.
 */
export function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((entry, index) => matchesSubset(actual[index], entry))
    );
  }
  if (isJsonRecord(expected)) {
    return (
      isJsonRecord(actual) &&
      Object.entries(expected).every(([key, entry]) =>
        matchesSubset(actual[key], entry),
      )
    );
  }
  return canonicalJson(actual) === canonicalJson(expected);
}

export function checkSubset(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  check(
    matchesSubset(actual, expected),
    `${label}\nexpected to contain: ${canonicalJson(expected)}\nreceived: ${canonicalJson(actual)}`,
  );
}

/** The value at `path`, or undefined. */
export function at(value: unknown, ...path: (string | number)[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (typeof segment === 'number') {
      current = Array.isArray(current) ? current[segment] : undefined;
    } else {
      current = isJsonRecord(current) ? current[segment] : undefined;
    }
  }
  return current;
}

export function arrayAt(
  value: unknown,
  ...path: (string | number)[]
): unknown[] {
  const found = at(value, ...path);
  return Array.isArray(found) ? found : [];
}

export function stringAt(
  value: unknown,
  ...path: (string | number)[]
): string | undefined {
  const found = at(value, ...path);
  return typeof found === 'string' ? found : undefined;
}

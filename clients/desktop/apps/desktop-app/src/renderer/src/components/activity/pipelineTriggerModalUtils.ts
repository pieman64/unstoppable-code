/** Order-insensitive deep stringify used to compare plugin-collection drafts. */
export function stableStringify(value: unknown): string {
  if (value === undefined) {
    return '__undefined__';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? '__unserializable__';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
    )
    .join(',')}}`;
}

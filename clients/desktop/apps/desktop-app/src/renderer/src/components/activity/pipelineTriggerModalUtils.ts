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

/**
 * The draft to show after a merged save: the saved value, plus any entries
 * the user changed from `submitted` while the save was in flight.
 */
export function rebaseDraftOnSaved<T>(
  current: Record<string, T>,
  submitted: Record<string, T>,
  saved: Record<string, T>,
): Record<string, T> {
  if (current === submitted) return saved;
  const next = { ...saved };
  for (const key of new Set([
    ...Object.keys(current),
    ...Object.keys(submitted),
  ])) {
    if (stableStringify(current[key]) === stableStringify(submitted[key]))
      continue;
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      next[key] = current[key];
    } else {
      delete next[key];
    }
  }
  return next;
}

/*
 * A refresh that reads the same data keeps the objects a view already holds,
 * so subscribers and memoized rows see nothing change and nothing redraws.
 */

/** Deep equality for the plain JSON-shaped values the Ledger reads return. */
export function sameLedgerValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    left === null ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => sameLedgerValue(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      sameLedgerValue(Reflect.get(left, key), Reflect.get(right, key)),
  );
}

/**
 * The next list, reusing each item equal to the previous item with its key,
 * and the previous list itself when nothing changed.
 */
export function reuseLedgerItems<T>(
  previous: readonly T[],
  next: readonly T[],
  keyOf: (item: T) => string,
): readonly T[] {
  const byKey = new Map(previous.map((item) => [keyOf(item), item]));
  let changed = previous.length !== next.length;
  const merged = next.map((item, index) => {
    const prior = byKey.get(keyOf(item));
    const kept =
      prior !== undefined && sameLedgerValue(prior, item) ? prior : item;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? merged : previous;
}

/** The previous value when it equals the next one. */
export function reuseLedgerValue<T>(previous: T, next: T): T {
  return sameLedgerValue(previous, next) ? previous : next;
}

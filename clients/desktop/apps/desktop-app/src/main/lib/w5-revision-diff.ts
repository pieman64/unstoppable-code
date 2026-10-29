import { isDeepStrictEqual } from 'node:util';
import { isJsonObject } from './w5-file-store';

/** Compare persisted JSON, ignoring whitespace and object key order. */
export function equalW5Contents(
  previousRaw: string | null,
  nextRaw: string,
): boolean {
  return (
    previousRaw !== null &&
    isDeepStrictEqual(JSON.parse(previousRaw), JSON.parse(nextRaw))
  );
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

/** Index order is collection state, even when encoded on each entry. */
function rowContent(
  row: Record<string, unknown>,
  excludeOrder: boolean,
): object {
  return excludeOrder
    ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'order'))
    : row;
}

export function diffW5Rows(
  previous: unknown,
  next: unknown,
  index: boolean,
): {
  collectionChanged: boolean;
  changedIds: string[];
} {
  const before = rows(previous);
  const after = rows(next);
  const membership = (entries: Record<string, unknown>[]): unknown[] =>
    entries.map((entry) => (index ? [entry.id, entry.order] : entry.id));
  const byId = (entries: Record<string, unknown>[]): Map<string, object> =>
    new Map(
      entries.flatMap((entry) =>
        typeof entry.id === 'string'
          ? [[entry.id, rowContent(entry, index)]]
          : [],
      ),
    );
  const oldRows = byId(before);
  const newRows = byId(after);
  return {
    collectionChanged: !isDeepStrictEqual(
      membership(before),
      membership(after),
    ),
    changedIds: Array.from(
      new Set([...Array.from(oldRows.keys()), ...Array.from(newRows.keys())]),
    ).filter((id) => !isDeepStrictEqual(oldRows.get(id), newRows.get(id))),
  };
}

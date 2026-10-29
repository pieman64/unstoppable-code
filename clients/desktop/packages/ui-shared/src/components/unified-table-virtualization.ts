export function getUnifiedTableItemKey(
  rows: readonly { key: string }[],
  index: number,
): string | number {
  return rows[index]?.key ?? index;
}

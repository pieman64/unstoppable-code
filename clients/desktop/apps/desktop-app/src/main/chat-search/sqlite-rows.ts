export function isSqliteRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function requireSqliteRow(value: unknown): Record<string, unknown> {
  if (!isSqliteRow(value)) {
    throw new Error('Expected a row object from chat-search SQLite');
  }
  return value;
}

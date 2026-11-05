export function isOnboardingObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept complete ISO date-times, canonicalizing offsets to UTC. */
export function normalizeTimestamp(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return undefined;
  }
  const time = Date.parse(value);
  const date = Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(date) ||
    new Date(date).toISOString().slice(0, 10) !== value.slice(0, 10)
  ) {
    return undefined;
  }
  return new Date(time).toISOString();
}

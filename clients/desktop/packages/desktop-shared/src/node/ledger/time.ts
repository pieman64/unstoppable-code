import { LedgerTimeFilterSchema } from '@canopy/protocol/canopy-core';

/**
 * RFC 3339 instants in the shape `LedgerTimeFilterSchema` accepts: seconds and
 * fractional seconds are optional, and the offset is `Z` or `±HH:MM`.
 */
const RFC3339_INSTANT =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$/;

const MIN_STORED_INSTANT_MS = Date.parse('0000-01-01T00:00:00.000Z');
const MAX_STORED_INSTANT_MS = Date.parse('9999-12-31T23:59:59.999Z');

interface ParsedLedgerInstant {
  /** Milliseconds since the epoch, truncated to the millisecond. */
  readonly epochMs: number;
  /** Fraction digits beyond milliseconds, without trailing zeros. */
  readonly subMillisecondDigits: string;
}

function parseLedgerInstant(value: string): ParsedLedgerInstant | null {
  if (!LedgerTimeFilterSchema.safeParse(value).success) return null;
  const match = RFC3339_INSTANT.exec(value);
  if (match === null) return null;
  const [, date, hours, minutes, seconds = '00', fraction = '', offset] = match;
  const milliseconds = `${fraction}000`.slice(0, 3);
  const epochMs = Date.parse(
    `${date}T${hours}:${minutes}:${seconds}.${milliseconds}${offset}`,
  );
  if (!Number.isFinite(epochMs)) return null;
  return {
    epochMs,
    subMillisecondDigits: fraction.slice(3).replace(/0+$/, ''),
  };
}

function isStorableInstant(epochMs: number): boolean {
  return epochMs >= MIN_STORED_INSTANT_MS && epochMs <= MAX_STORED_INSTANT_MS;
}

/**
 * The storage format for every Ledger timestamp: UTC, millisecond precision,
 * `YYYY-MM-DDTHH:MM:SS.sssZ`. Strings in this format sort chronologically.
 */
export function toLedgerTimestamp(date: Date): string {
  return date.toISOString();
}

/**
 * Canonical UTC form of an RFC 3339 instant that preserves its full precision,
 * so two spellings of the same instant compare equal. Used for identity keys
 * such as a container's creation time. Returns null for invalid input.
 */
export function canonicalizeLedgerInstant(value: string): string | null {
  const parsed = parseLedgerInstant(value);
  if (parsed === null || !isStorableInstant(parsed.epochMs)) return null;
  const iso = toLedgerTimestamp(new Date(parsed.epochMs));
  return parsed.subMillisecondDigits.length === 0
    ? iso
    : `${iso.slice(0, -1)}${parsed.subMillisecondDigits}Z`;
}

/**
 * Normalizes a search time bound to the storage format. Stored timestamps
 * have millisecond precision, so a bound with sub-millisecond digits rounds up
 * to the next millisecond; that keeps an inclusive lower bound and an
 * exclusive upper bound exact. Bounds outside the storable range are clamped.
 * Returns null for invalid input.
 */
export function normalizeLedgerTimeBound(value: string): string | null {
  const parsed = parseLedgerInstant(value);
  if (parsed === null) return null;
  const ceiling =
    parsed.subMillisecondDigits.length === 0
      ? parsed.epochMs
      : parsed.epochMs + 1;
  const clamped = Math.min(
    MAX_STORED_INSTANT_MS,
    Math.max(MIN_STORED_INSTANT_MS, ceiling),
  );
  return toLedgerTimestamp(new Date(clamped));
}

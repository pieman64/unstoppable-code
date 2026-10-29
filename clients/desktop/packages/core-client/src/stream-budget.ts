// Browser-safe: no Node or host dependencies.

const MiB = 1024 * 1024;
export const STREAM_BUDGET_BYTES = 16 * MiB;
export const CONNECTION_BUDGET_BYTES = 64 * MiB;
/**
 * Held per active stream against both budgets, so its end always fits. Covers
 * the largest generated end: a 512-character epoch escaped to 6 bytes each.
 */
export const TERMINAL_RESERVATION_BYTES = 4_096;

const encoder = new TextEncoder();

/**
 * Canonical UTF-8 size of a value's JSON. An accounting measure: it ignores
 * the raw wire spelling and does not bound heap use.
 */
export function encodedSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/** A connection-wide byte pool shared by its streams. */
export class ByteBudget {
  private used = 0;

  constructor(private readonly limit: number) {}

  /** Never refuses a release (negative `bytes`). */
  fits(bytes: number): boolean {
    return this.used + bytes <= this.limit;
  }

  adjust(bytes: number): void {
    this.used += bytes;
  }
}

/** One stream's charges, applied to its own budget and its connection's. */
export class StreamBudget {
  private used = 0;

  private constructor(private readonly connection: ByteBudget) {}

  /** Reserves the terminal; undefined when the connection cannot hold it. */
  static open(connection: ByteBudget): StreamBudget | undefined {
    const budget = new StreamBudget(connection);
    return budget.admit(TERMINAL_RESERVATION_BYTES) ? budget : undefined;
  }

  /** Charges `bytes` in place of `freed` when both budgets have room. */
  admit(bytes: number, freed = 0): boolean {
    const delta = bytes - freed;
    if (this.used + delta > STREAM_BUDGET_BYTES || !this.connection.fits(delta))
      return false;
    this.used += delta;
    this.connection.adjust(delta);
    return true;
  }

  release(bytes: number): void {
    this.used -= bytes;
    this.connection.adjust(-bytes);
  }
}

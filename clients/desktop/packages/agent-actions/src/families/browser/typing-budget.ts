/** What one real keystroke costs besides its delay: key down, char, key up. */
const KEYSTROKE_OVERHEAD_MS = 15;

/**
 * The most a `browser.type` action's text and delay may add up to. Longer
 * runs are refused by validation, so no action can outlive its deadline by
 * typing alone.
 */
export const BROWSER_TYPING_BUDGET_MAX_MS = 60_000;

/**
 * Milliseconds a run of real keystrokes may take. The action lane and the
 * App Advisor bridge both add this to the deadline they already compute,
 * so a slow `type` is not cut off by a budget meant for one click.
 */
export function browserTypingBudgetMs(characters: number, delayMs = 0): number {
  if (!Number.isFinite(characters) || characters <= 0) return 0;
  const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
  return Math.ceil(characters) * (delay + KEYSTROKE_OVERHEAD_MS);
}

/** Delays from `minDelayMs` to `maxDelayMs` take text up to `maxLength`. */
export interface BrowserTypeTextLimit {
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxLength: number;
}

/**
 * The longest `browser.type` text for each range of delays. The longest text
 * of a band, at the band's longest delay, stays inside the typing budget.
 * Bands set the limit, not the budget itself, because the tool schema shown
 * to agents can list a few ranges but cannot multiply: one branch per delay
 * would add about 45 KB to every tool list.
 */
export const BROWSER_TYPE_TEXT_LIMITS: readonly BrowserTypeTextLimit[] = [
  { minDelayMs: 0, maxDelayMs: 0, maxLength: 4_000 },
  { minDelayMs: 1, maxDelayMs: 5, maxLength: 3_000 },
  { minDelayMs: 6, maxDelayMs: 15, maxLength: 2_000 },
  { minDelayMs: 16, maxDelayMs: 45, maxLength: 1_000 },
  { minDelayMs: 46, maxDelayMs: 105, maxLength: 500 },
  { minDelayMs: 106, maxDelayMs: 285, maxLength: 200 },
  { minDelayMs: 286, maxDelayMs: 500, maxLength: 100 },
];

/** The longest text `browser.type` takes at a delay; 0 for a delay it refuses. */
export function browserTypeTextLimit(delayMs = 0): number {
  return (
    BROWSER_TYPE_TEXT_LIMITS.find(
      (band) => delayMs >= band.minDelayMs && delayMs <= band.maxDelayMs,
    )?.maxLength ?? 0
  );
}

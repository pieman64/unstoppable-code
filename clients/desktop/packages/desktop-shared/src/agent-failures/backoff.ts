/**
 * Retry-cadence schedules for automatic retry of transient LLM provider errors
 * (overload, provider 5xx, connection drops) classified by
 * {@link classifyAgentFailure} as `provider_temporarily_unavailable`.
 *
 * These constants are the single source of truth shared by both main-process
 * consumers — the chat retry service and the pipeline auto-resume scheduler —
 * so the schedules and the chat event payload's `maxAttempts` stay in sync.
 *
 * Cadence semantics: the delay for attempt `A` (1-based) is index `A - 1`. Both
 * schedules follow a "2 tries per delay then double" shape.
 *
 * These values are internal (not user-facing copy) and are intentionally
 * excluded from the `brand:check-user-facing` scan.
 */

/**
 * Delay (ms) before each chat retry attempt: `[30s, 30s, 60s, 60s, 120s]` — 5
 * attempts, then give up.
 */
export const CHAT_TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [
  30_000, 30_000, 60_000, 60_000, 120_000,
];

/**
 * Delay (ms) before each pipeline retry attempt — the same "2 tries per delay
 * then double" shape extended to 10 attempts:
 * `[30s, 30s, 60s, 60s, 120s, 120s, 240s, 240s, 480s, 480s]`.
 */
export const PIPELINE_TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [
  30_000, 30_000, 60_000, 60_000, 120_000, 120_000, 240_000, 240_000, 480_000,
  480_000,
];

/** Number of chat retry attempts before giving up (= 5). */
export const CHAT_TRANSIENT_RETRY_MAX_ATTEMPTS =
  CHAT_TRANSIENT_RETRY_DELAYS_MS.length;

/** Number of pipeline retry attempts before giving up (= 10). */
export const PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS =
  PIPELINE_TRANSIENT_RETRY_DELAYS_MS.length;

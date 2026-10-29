/**
 * The hot-path entry points delivery sites call. Kept free of store and
 * React imports so the terminal client and chat subscriptions can import it
 * without pulling in the interest tracking that starts the aggregator.
 *
 * A delivery site reads `performance.now()` before applying and calls a
 * `record…Applied` function after; while diagnostics are not running these
 * return at once.
 */
import type {
  ChatEvent,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import type { RendererDiagnosticsAggregator } from './aggregator';

let active: RendererDiagnosticsAggregator | null = null;

/** Route deliveries to `aggregator` (or nowhere, with `null`). */
export function setActiveRendererDiagnostics(
  aggregator: RendererDiagnosticsAggregator | null,
): void {
  active = aggregator;
}

/** A `chat:state-changed` message was applied; `startedAt` from `performance.now()`. */
export function recordChatStateApplied(
  event: ChatStateChangedEvent,
  startedAt: number,
): void {
  if (active === null) return;
  active.recordChatState(event, performance.now() - startedAt);
}

/** A `chat:event` was applied; `startedAt` from `performance.now()`. */
export function recordChatEventApplied(
  event: ChatEvent,
  startedAt: number,
): void {
  if (active === null) return;
  active.recordChatEvent(event, performance.now() - startedAt);
}

/**
 * One terminal output subscriber handled a delivery; `startedAt` from
 * `performance.now()`. Counted once per delivery across subscribers.
 */
export function recordTerminalOutputApplied(
  terminalId: string,
  seq: number,
  startedAt: number,
): void {
  if (active === null) return;
  active.recordTerminalOutput(terminalId, seq, performance.now() - startedAt);
}

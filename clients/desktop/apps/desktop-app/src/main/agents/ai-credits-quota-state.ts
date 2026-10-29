// AI Credits on-quota fallback state (CAN-838).
//
// Tracks, per native provider, whether the account has currently reached its
// usage/rate limit. This state is account-wide (a provider quota is not tied to
// one chat), so it lives here as process-global state rather than per-session or
// per-surface. Detection is fed from the common provider event streams
// (claude-session / codex-session `emitEvent`), and the routing decision reads
// it from `resolveAiCreditsRoutingActivation`. Because both live in the shared
// agents layer, every chat surface — worktree, standalone, App Advisor, the
// pipeline editor, plan review, and any future surface — inherits on-quota
// routing without per-surface wiring.

import type { CanopyProxyError } from '@canopy/protocol';
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import { isNoBillingSourceFailureEvent } from '@canopy/agent-transcript';

// Pure quota-frame detection lives in desktop-shared so the portal projection
// shares the exact same rule (CAN-2601); re-exported for existing importers.
export {
  detectClaudeQuotaReached,
  detectCodexQuotaReached,
  readClaudeQuotaResetsAt,
} from '@canopy/desktop-shared/portal/provider-usage-limit';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Detect the marked hosted 402 in any string buffered inside a failure event.
 *
 * The gate and the recursive scan deliberately live in ONE place —
 * `isNoBillingSourceFailureEvent` in `@canopy/agent-transcript` — rather than
 * being mirrored here. This function is now only the outer-wrapper unwrap: the
 * live main-process signal and the renderer's persisted per-tab flag must agree
 * about the same turn, and two hand-maintained copies of the same
 * `turn.failed | error | result | assistant+error` rule are how they drift
 * (CAN-2413 review). Keep this a thin adapter; change the rule upstream.
 */
export function detectAiCreditsNoBillingSource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'codex') {
    return isNoBillingSourceFailureEvent(value.event, 'codex');
  }
  return isNoBillingSourceFailureEvent(value, 'claude');
}

/**
 * Marked hosted refusals, per session key, that no provider event will carry
 * the evidence for.
 *
 * Codex may discard response details and surface only `error.message`. The local proxy DOES see the marked body, and it knows the
 * session key the route belongs to, so it records the parsed failure here and
 * the session layer restores it onto that turn's failure event. Originally
 * only the no-billing-source 402 (CAN-2413); since CAN-3462 any marked 402 or
 * 403 (a refused work owner, a guest model outside the allowlist).
 *
 * Deliberately read-and-CLEAR ({@link consumeSessionProxyFailure}). A latch
 * that merely stayed set would outlive the turn it describes: the user tops up,
 * the next turn succeeds, and the following unrelated failure would inherit a
 * stale verdict and re-raise the recovery banner. Consuming it means one
 * recorded refusal arms exactly one turn, and a genuine repeat failure re-arms
 * it by recording again.
 *
 * Claude calls the hosted route directly and does not use this latch; its
 * session applies a narrow routing-gated fallback when response details are lost.
 *
 * Keyed by session key rather than route id because the route is torn down and
 * re-leased across a session's lifetime while the failure event is attributed
 * to the session.
 */
const proxyFailureBySession = new Map<string, CanopyProxyError>();

/** Record the marked hosted refusal this session's proxy relayed. */
export function recordSessionProxyFailure(
  sessionKey: string,
  failure: CanopyProxyError,
): void {
  if (!sessionKey) return;
  proxyFailureBySession.set(sessionKey, failure);
}

/**
 * Read and clear this session's proxy-observed refusal. Callers MUST only call
 * this once they have confirmed the event is failure-shaped, or they will
 * consume the signal on an unrelated event and lose the notice for the turn
 * that needed it.
 */
export function consumeSessionProxyFailure(
  sessionKey: string,
): CanopyProxyError | undefined {
  const failure = proxyFailureBySession.get(sessionKey);
  proxyFailureBySession.delete(sessionKey);
  return failure;
}

/** Drop a session's pending refusal when the session itself goes away. */
export function clearSessionProxyFailure(sessionKey: string): void {
  proxyFailureBySession.delete(sessionKey);
}

interface ProviderQuotaState {
  reachedAt: number;
  /** Soonest quota-window reset (ms since epoch), when the provider reports it. */
  resetsAt?: number;
}

const quotaByProvider = new Map<AgentProviderType, ProviderQuotaState>();

/**
 * Record that a provider has reached its usage/rate limit. `resetsAt` (when
 * known) lets {@link isProviderQuotaReached} auto-expire the state so routing
 * reverts to native auth once the window recharges.
 */
export function markProviderQuotaReached(
  provider: AgentProviderType,
  resetsAt?: number,
): void {
  quotaByProvider.set(provider, {
    reachedAt: Date.now(),
    ...(typeof resetsAt === 'number' && Number.isFinite(resetsAt)
      ? { resetsAt }
      : {}),
  });
}

/**
 * Whether a provider is currently quota-limited. When a `resetsAt` was recorded
 * and has passed, the state is cleared and `false` is returned so on-quota
 * routing reverts to native auth automatically. A provider limit without a
 * reported `resetsAt` stays reached for the process session, or until a native
 * account change clears it (CAN-4200).
 */
export function isProviderQuotaReached(provider: AgentProviderType): boolean {
  const state = quotaByProvider.get(provider);
  if (!state) {
    return false;
  }
  if (typeof state.resetsAt === 'number' && Date.now() >= state.resetsAt) {
    quotaByProvider.delete(provider);
    return false;
  }
  return true;
}

/** Clear a provider's quota-reached state (explicit invalidation). */
export function clearProviderQuotaReached(provider: AgentProviderType): void {
  quotaByProvider.delete(provider);
}

/** Reset all quota-reached state (test seam). */
export function clearAllProviderQuotaReached(): void {
  quotaByProvider.clear();
}

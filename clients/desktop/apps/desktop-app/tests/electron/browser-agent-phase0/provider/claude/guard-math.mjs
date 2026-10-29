// Pure arithmetic for the S0.2 context-guard recommendation. All token figures
// are byte-ratio ESTIMATES (no tokenizer is available against the loopback
// mock) and are labelled `estimate: true`.

export const REQUEST_TOKEN_BUDGET = 16_000;
export const TASK_LIMITS = Object.freeze({
  actions: 50,
  inferenceRequests: 100,
  activeWorkMs: 600_000,
});
/** Bytes-per-token ratios used as a conservative and a typical estimate. */
export const BYTES_PER_TOKEN = Object.freeze({ conservative: 3, typical: 4 });
/** Headroom kept below the budget so estimator error cannot cross it. */
export const GUARD_HEADROOM = 0.9;

export function median(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Token estimates for a byte count. Never a measurement. */
export function estimateTokens(bytes) {
  return {
    estimate: true,
    bytes,
    bytesDiv3: Math.ceil(bytes / BYTES_PER_TOKEN.conservative),
    bytesDiv4: Math.ceil(bytes / BYTES_PER_TOKEN.typical),
  };
}

/** How many observations of `perObservationBytes` fit after `fixedBytes` of overhead. */
export function observationsThatFit({
  fixedBytes,
  perObservationBytes,
  bytesPerToken,
  budgetTokens = REQUEST_TOKEN_BUDGET,
  headroom = 1,
}) {
  if (!(perObservationBytes > 0)) return null;
  const budgetBytes = Math.floor(budgetTokens * bytesPerToken * headroom);
  return Math.max(
    0,
    Math.floor((budgetBytes - fixedBytes) / perObservationBytes),
  );
}

/**
 * Per-observation growth from a growth series: deltas large enough to carry an
 * observation (filters out small acks).
 */
export function observationGrowth(series, minBytes = 5_000) {
  const deltas = series
    .map((entry) => entry.deltaBytes)
    .filter((delta) => typeof delta === 'number' && delta >= minBytes);
  return {
    samples: deltas,
    median: median(deltas),
    max: deltas.length ? Math.max(...deltas) : null,
  };
}

/**
 * Provisional per-page guard and epoch cap, or `unresolved` with the reason.
 *
 * @param {{ fixedBytes: number | null, growth: { median: number | null }, coldStartMs: number[] }} input
 */
export function recommendGuard({ fixedBytes, growth, coldStartMs = [] }) {
  const basis = {
    synthetic: true,
    estimate: true,
    label:
      'mock/loopback bytes, byte-ratio token estimates; not release performance or tokenizer output',
  };
  if (!(fixedBytes > 0) || !(growth?.median > 0)) {
    return {
      status: 'unresolved',
      reason:
        'no complete tool loop was captured, so fixed overhead or per-observation growth is unknown',
      basis,
    };
  }
  const perObservation = growth.median;
  const fitsBy = {};
  for (const [name, ratio] of Object.entries(BYTES_PER_TOKEN)) {
    fitsBy[name] = {
      bytesPerToken: ratio,
      budgetBytes: REQUEST_TOKEN_BUDGET * ratio,
      observationsAtFullBudget: observationsThatFit({
        fixedBytes,
        perObservationBytes: perObservation,
        bytesPerToken: ratio,
      }),
      observationsWithHeadroom: observationsThatFit({
        fixedBytes,
        perObservationBytes: perObservation,
        bytesPerToken: ratio,
        headroom: GUARD_HEADROOM,
      }),
    };
  }
  const conservative = fitsBy.conservative.observationsWithHeadroom;
  const coldMedian = median(coldStartMs);
  if (conservative < 1) {
    return {
      status: 'unresolved',
      reason:
        `Fixed overhead (${fixedBytes} B) plus one full observation (${Math.round(perObservation)} B) exceeds the ` +
        `${REQUEST_TOKEN_BUDGET}-token budget at bytes/${BYTES_PER_TOKEN.conservative} with ${Math.round((1 - GUARD_HEADROOM) * 100)}% headroom. ` +
        'A real tokenizer measurement or a smaller observation cap is required before a guard can be frozen.',
      fixedBytes,
      perObservationBytes: perObservation,
      fitsBy,
      coldStartMedianMs: coldMedian,
      basis,
    };
  }
  const actionsPerEpoch = Math.min(conservative, TASK_LIMITS.actions);
  const requestsPerEpoch = actionsPerEpoch + 1; // first request + one per action, final answer included
  const epochsForActions = Math.ceil(TASK_LIMITS.actions / actionsPerEpoch);
  const requestsForActions = epochsForActions * requestsPerEpoch;
  const rotations = Math.max(0, epochsForActions - 1);
  return {
    status: 'provisional',
    guardRule: `Rotate before any request whose estimated size would exceed ${Math.floor(REQUEST_TOKEN_BUDGET * BYTES_PER_TOKEN.conservative * GUARD_HEADROOM)} bytes (${GUARD_HEADROOM * 100}% of ${REQUEST_TOKEN_BUDGET} tokens at bytes/${BYTES_PER_TOKEN.conservative}).`,
    perPageGuardBytes: Math.floor(
      REQUEST_TOKEN_BUDGET * BYTES_PER_TOKEN.conservative * GUARD_HEADROOM,
    ),
    fixedBytes,
    perObservationBytes: perObservation,
    fitsBy,
    epochCap: {
      maxObservationActionsPerEpoch: actionsPerEpoch,
      maxRequestsPerEpoch: requestsPerEpoch,
      epochsNeededForActionLimit: epochsForActions,
      requestsNeededForActionLimit: requestsForActions,
      withinRequestLimit: requestsForActions <= TASK_LIMITS.inferenceRequests,
      rotationsNeeded: rotations,
    },
    rotationCost: {
      coldStartMedianMs: coldMedian,
      rotationsTimesColdStartMs:
        coldMedian === null ? null : Math.round(rotations * coldMedian),
      fractionOfActiveWorkDeadline:
        coldMedian === null
          ? null
          : Number(
              ((rotations * coldMedian) / TASK_LIMITS.activeWorkMs).toFixed(4),
            ),
      note: 'Loopback mock cold start (process spawn to first request), not release performance and excludes real model latency.',
    },
    basis,
  };
}

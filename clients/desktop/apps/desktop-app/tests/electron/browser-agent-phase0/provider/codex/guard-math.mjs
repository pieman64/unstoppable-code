// Guard arithmetic for S0.2: how many 100-control / 6,000-character
// observations fit under the 16,000-token request budget, from measured bytes.
// Conservative bytes-per-token values (3 and 4) are both shown; nothing here
// is a tokenizer result. Mock/loopback bytes, not release performance.

export const REQUEST_BUDGET_TOKENS = 16_000;
export const EPOCH_LIMITS = Object.freeze({
  requests: 100,
  actions: 50,
  minutes: 10,
});

/**
 * @param {{ baselineBytes: number, observationBytes: number, receiptStepBytes: number, bytesPerToken: number, budgetTokens?: number }} input
 *   baselineBytes: a request with no page content yet (system + tools + AGENTS + user prompt).
 *   observationBytes: bytes one observation adds to every later request (call + output items).
 *   receiptStepBytes: bytes a small non-observation action adds (call + receipt items).
 */
export function budgetFit({
  baselineBytes,
  observationBytes,
  receiptStepBytes,
  bytesPerToken,
  budgetTokens = REQUEST_BUDGET_TOKENS,
}) {
  const budgetBytes = Math.floor(budgetTokens * bytesPerToken);
  const headroomBytes = budgetBytes - baselineBytes;
  return {
    bytesPerToken,
    budgetBytes,
    baselineBytes,
    headroomBytes,
    baselineTokensEstimate: Math.ceil(baselineBytes / bytesPerToken),
    maxObservationsInContext:
      headroomBytes > 0 && observationBytes > 0
        ? Math.floor(headroomBytes / observationBytes)
        : 0,
    maxReceiptOnlyActions:
      headroomBytes > 0 && receiptStepBytes > 0
        ? Math.floor(headroomBytes / receiptStepBytes)
        : 0,
  };
}

/**
 * Provisional guard from the fits: the conservative (smallest) observation
 * count wins. Returns `unresolved` when not even one observation fits.
 */
export function recommendGuard({
  baselineBytes,
  observationBytes,
  receiptStepBytes,
  bytesPerTokenList = [3, 4],
  budgetTokens = REQUEST_BUDGET_TOKENS,
  limits = EPOCH_LIMITS,
}) {
  const inputsOk = [baselineBytes, observationBytes, receiptStepBytes].every(
    (n) => Number.isFinite(n) && n > 0,
  );
  if (!inputsOk)
    return {
      status: 'unresolved',
      reason: 'baseline/observation/receipt byte measurements are missing',
      fits: [],
    };
  const fits = bytesPerTokenList.map((bytesPerToken) =>
    budgetFit({
      baselineBytes,
      observationBytes,
      receiptStepBytes,
      bytesPerToken,
      budgetTokens,
    }),
  );
  const conservative = fits.reduce((min, fit) =>
    fit.maxObservationsInContext < min.maxObservationsInContext ? fit : min,
  );
  if (conservative.maxObservationsInContext < 1)
    return {
      status: 'unresolved',
      reason: `even one observation does not fit under ${budgetTokens} tokens at ${conservative.bytesPerToken} bytes/token with a ${baselineBytes}-byte baseline; the budget cannot hold a full-size page on this harness`,
      fits,
    };
  // With N observations retained in every later request, the remaining
  // headroom bounds receipt-sized actions; the plan limits cap everything.
  const observations = conservative.maxObservationsInContext;
  const remaining =
    conservative.headroomBytes - observations * observationBytes;
  const receiptActions =
    receiptStepBytes > 0 ? Math.floor(remaining / receiptStepBytes) : 0;
  const actionCap = Math.min(
    limits.actions,
    observations + Math.max(0, receiptActions),
  );
  return {
    status: 'measured',
    provisional: true,
    basis: `bytes/token in [${bytesPerTokenList.join(', ')}]; smallest fit used`,
    perPageObservationGuard: observations,
    epochActionCap: actionCap,
    epochRequestCap: Math.min(limits.requests, actionCap + 1),
    epochMinutesCap: limits.minutes,
    fits,
    caveat:
      'A guard must be enforced by the host before each tool result is returned; Codex resends the whole history every request.',
  };
}

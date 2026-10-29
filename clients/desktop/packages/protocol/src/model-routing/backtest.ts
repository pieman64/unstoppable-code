/**
 * Wire contracts for automatic model routing backtests: a replay of past
 * turns through the same routing decision Auto makes, repriced at the model
 * it would have picked. Shared by the web API and the Statistics/profile UI.
 */

export const MODEL_ROUTING_BACKTEST_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type ModelRoutingBacktestStatus =
  (typeof MODEL_ROUTING_BACKTEST_STATUSES)[number];

export const MODEL_ROUTING_BACKTEST_MODES = ['sample', 'full'] as const;
export type ModelRoutingBacktestMode =
  (typeof MODEL_ROUTING_BACKTEST_MODES)[number];

export type ModelRoutingBacktestSubject = 'organization' | 'user';

/** Filter within an organization run; profile runs are always `user`. */
export type ModelRoutingBacktestScope = 'organization' | 'team' | 'user';

/** Target number of replayed turns for a sampled run. */
export const MODEL_ROUTING_BACKTEST_SAMPLE_TARGET_TURNS = 2_000;
/** Largest eligible population a `full` run may replay. */
export const MODEL_ROUTING_BACKTEST_FULL_MAX_TURNS = 10_000;
/** Conservative per-turn routing evaluation cost used for the estimate. */
export const MODEL_ROUTING_BACKTEST_ESTIMATED_USD_PER_TURN = 0.0003;
/** New (uncached) runs allowed per subject in a rolling 24 hours. */
export const MODEL_ROUTING_BACKTEST_DAILY_RUN_LIMIT = 3;
/** Longest range a backtest may cover, in days. */
export const MODEL_ROUTING_BACKTEST_MAX_RANGE_DAYS = 366;

export type ModelRoutingBacktestFailureCode =
  | 'insufficient_credits'
  | 'policy_blocked'
  | 'transcripts_disabled'
  | 'no_eligible_turns'
  | 'time_limit'
  | 'attempt_limit'
  | 'internal';

/** Why a backtest can't be started for the selected range and subject. */
export type ModelRoutingBacktestUnavailableReason =
  | 'feature_disabled'
  /** The viewer can see results but only an org admin may start a run. */
  | 'admin_required'
  | 'policy_blocked'
  | 'transcripts_disabled'
  | 'no_eligible_turns';

export interface ModelRoutingBacktestCreateRequestV1 {
  startIso: string;
  endIso: string;
  mode: ModelRoutingBacktestMode;
  /** Organization runs only. Defaults to `organization`. */
  scope?: 'organization' | 'team';
  /** Required when `scope` is `team`. Team external id. */
  teamId?: string;
  /** Optional member external id filter for organization runs. */
  userId?: string;
}

export interface ModelRoutingBacktestEstimateV1 {
  /** Primary-work turns in range for the subject, with or without a body. */
  coverageTurnCount: number;
  /** Turns with a replayable transcript body. */
  eligibleTurnCount: number;
  /** Turns a run in each mode would replay. */
  plannedTurnCount: { sample: number; full: number | null };
  /** Estimated routing cost for each mode, in USD. */
  estimatedCostUsd: { sample: number; full: number | null };
  /** True when the payer's balance covers the sample estimate. */
  balanceSufficient: boolean;
  /** Runs still allowed today for this subject. */
  runsRemainingToday: number;
}

export interface ModelRoutingBacktestSeriesPointV1 {
  bucketStartIso: string;
  actualCostUsd: number;
  autoCostUsd: number;
}

export interface ModelRoutingBacktestModelShareV1 {
  /** Canonical gateway model id, for example `anthropic/claude-opus-5`. */
  modelId: string;
  actualTurnShare: number;
  autoTurnShare: number;
  actualCostShare: number;
  autoCostShare: number;
}

export interface ModelRoutingBacktestShiftV1 {
  fromModelId: string;
  toModelId: string;
  turnCount: number;
  /** Actual (baseline) cost of the turns that moved, in USD. */
  baselineCostUsd: number;
}

export interface ModelRoutingBacktestResultV1 {
  /** Extrapolated actual spend over the whole range. */
  baselineCostUsd: number;
  /** Extrapolated spend with automatic model routing, routing cost included. */
  autoCostUsd: number;
  /** Routing evaluation cost actually paid for the replayed turns. */
  routingCostUsd: number;
  savingsUsd: number;
  /** Savings as a fraction of the baseline (0.25 = 25%). */
  savingsFraction: number;
  savingsLowUsd: number;
  savingsHighUsd: number;
  coverageTurnCount: number;
  eligibleTurnCount: number;
  replayedTurnCount: number;
  /** Share of replayed turns kept on the current model for cache. */
  keptForCacheShare: number;
  /** Share of replayed turns that ran on a provider subscription. */
  subscriptionLaneShare: number;
  pricingRevision: string;
  bucketGranularity: 'day' | 'week';
  series: ModelRoutingBacktestSeriesPointV1[];
  modelShare: ModelRoutingBacktestModelShareV1[];
  shifts: ModelRoutingBacktestShiftV1[];
}

export interface ModelRoutingBacktestV1 {
  id: string;
  subject: ModelRoutingBacktestSubject;
  scope: ModelRoutingBacktestScope;
  status: ModelRoutingBacktestStatus;
  mode: ModelRoutingBacktestMode;
  rangeStartIso: string;
  rangeEndIso: string;
  createdAtIso: string;
  completedAtIso: string | null;
  estimatedCostUsd: number;
  progress: { replayedTurnCount: number; plannedTurnCount: number };
  failureCode: ModelRoutingBacktestFailureCode | null;
  result: ModelRoutingBacktestResultV1 | null;
}

/** `GET .../model-routing-backtests?start&end[&scope&teamId&userId]`. */
export interface ModelRoutingBacktestLookupResponseV1 {
  /** Latest run for this exact range and filter within the cache window. */
  backtest: ModelRoutingBacktestV1 | null;
  /** Null when `unavailableReason` is set. */
  estimate: ModelRoutingBacktestEstimateV1 | null;
  unavailableReason: ModelRoutingBacktestUnavailableReason | null;
}

/** `POST .../model-routing-backtests`. `cached` means no new run started. */
export interface ModelRoutingBacktestCreateResponseV1 {
  backtest: ModelRoutingBacktestV1;
  cached: boolean;
}

/** Machine-readable create errors (HTTP 402/409/429 bodies carry `code`). */
export type ModelRoutingBacktestCreateErrorCode =
  | ModelRoutingBacktestUnavailableReason
  | 'insufficient_credits'
  | 'daily_limit'
  | 'full_mode_unavailable';

// ---------------------------------------------------------------------------
// Stored-result validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseArray<T>(
  value: unknown,
  parseItem: (item: Record<string, unknown>) => T | null,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    const parsed = isRecord(item) ? parseItem(item) : null;
    if (parsed === null) return null;
    items.push(parsed);
  }
  return items;
}

function parseSeriesPoint(
  item: Record<string, unknown>,
): ModelRoutingBacktestSeriesPointV1 | null {
  const actualCostUsd = finiteNumber(item.actualCostUsd);
  const autoCostUsd = finiteNumber(item.autoCostUsd);
  if (
    typeof item.bucketStartIso !== 'string' ||
    actualCostUsd === null ||
    autoCostUsd === null
  ) {
    return null;
  }
  return { bucketStartIso: item.bucketStartIso, actualCostUsd, autoCostUsd };
}

function parseModelShare(
  item: Record<string, unknown>,
): ModelRoutingBacktestModelShareV1 | null {
  const actualTurnShare = finiteNumber(item.actualTurnShare);
  const autoTurnShare = finiteNumber(item.autoTurnShare);
  const actualCostShare = finiteNumber(item.actualCostShare);
  const autoCostShare = finiteNumber(item.autoCostShare);
  if (
    typeof item.modelId !== 'string' ||
    actualTurnShare === null ||
    autoTurnShare === null ||
    actualCostShare === null ||
    autoCostShare === null
  ) {
    return null;
  }
  return {
    modelId: item.modelId,
    actualTurnShare,
    autoTurnShare,
    actualCostShare,
    autoCostShare,
  };
}

function parseShift(
  item: Record<string, unknown>,
): ModelRoutingBacktestShiftV1 | null {
  const turnCount = finiteNumber(item.turnCount);
  const baselineCostUsd = finiteNumber(item.baselineCostUsd);
  if (
    typeof item.fromModelId !== 'string' ||
    typeof item.toModelId !== 'string' ||
    turnCount === null ||
    baselineCostUsd === null
  ) {
    return null;
  }
  return {
    fromModelId: item.fromModelId,
    toModelId: item.toModelId,
    turnCount,
    baselineCostUsd,
  };
}

const RESULT_NUMBER_FIELDS = [
  'baselineCostUsd',
  'autoCostUsd',
  'routingCostUsd',
  'savingsUsd',
  'savingsFraction',
  'savingsLowUsd',
  'savingsHighUsd',
  'coverageTurnCount',
  'eligibleTurnCount',
  'replayedTurnCount',
  'keptForCacheShare',
  'subscriptionLaneShare',
] as const;

type ResultNumberField = (typeof RESULT_NUMBER_FIELDS)[number];

/**
 * Validate a stored backtest result (for example a JSON column read back from
 * the database). Returns null for anything that isn't a complete V1 result so
 * callers can recompute instead of serving a malformed shape.
 */
export function parseModelRoutingBacktestResultV1(
  value: unknown,
): ModelRoutingBacktestResultV1 | null {
  if (!isRecord(value)) return null;
  const numbers: Partial<Record<ResultNumberField, number>> = {};
  for (const field of RESULT_NUMBER_FIELDS) {
    const parsed = finiteNumber(value[field]);
    if (parsed === null) return null;
    numbers[field] = parsed;
  }
  const granularity = value.bucketGranularity;
  if (granularity !== 'day' && granularity !== 'week') return null;
  if (typeof value.pricingRevision !== 'string') return null;
  const series = parseArray(value.series, parseSeriesPoint);
  const modelShare = parseArray(value.modelShare, parseModelShare);
  const shifts = parseArray(value.shifts, parseShift);
  if (series === null || modelShare === null || shifts === null) return null;
  const {
    baselineCostUsd,
    autoCostUsd,
    routingCostUsd,
    savingsUsd,
    savingsFraction,
    savingsLowUsd,
    savingsHighUsd,
    coverageTurnCount,
    eligibleTurnCount,
    replayedTurnCount,
    keptForCacheShare,
    subscriptionLaneShare,
  } = numbers;
  if (
    baselineCostUsd === undefined ||
    autoCostUsd === undefined ||
    routingCostUsd === undefined ||
    savingsUsd === undefined ||
    savingsFraction === undefined ||
    savingsLowUsd === undefined ||
    savingsHighUsd === undefined ||
    coverageTurnCount === undefined ||
    eligibleTurnCount === undefined ||
    replayedTurnCount === undefined ||
    keptForCacheShare === undefined ||
    subscriptionLaneShare === undefined
  ) {
    return null;
  }
  return {
    baselineCostUsd,
    autoCostUsd,
    routingCostUsd,
    savingsUsd,
    savingsFraction,
    savingsLowUsd,
    savingsHighUsd,
    coverageTurnCount,
    eligibleTurnCount,
    replayedTurnCount,
    keptForCacheShare,
    subscriptionLaneShare,
    pricingRevision: value.pricingRevision,
    bucketGranularity: granularity,
    series,
    modelShare,
    shifts,
  };
}

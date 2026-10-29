// Pure display helpers for the automatic model routing estimate. Kept free of
// React and the DOM so the node-environment jest harness covers them.

import { MODEL_ROUTING_BACKTEST_DAILY_RUN_LIMIT } from '@canopy/protocol/model-routing';
import type {
  ModelRoutingBacktestFailureCode,
  ModelRoutingBacktestModelShareV1,
  ModelRoutingBacktestResultV1,
  ModelRoutingBacktestStatus,
  ModelRoutingBacktestUnavailableReason,
} from '@canopy/protocol/model-routing';

export type RoutingBacktestSubjectKind = 'organization' | 'user';

/** Chart colors: fixed theme roles so both charts and legends agree. */
export const BACKTEST_ACTUAL_COLOR = 'var(--fg-tertiary)';
export const BACKTEST_AUTO_COLOR = 'var(--fg-accent)';

export interface RoutingBacktestCopy {
  spentLabel: string;
  ranLabel: string;
  autoLabel: string;
  /** What the start state says the estimate replays. */
  replayIntro: string;
}

/** Org runs speak to the team ("you"); profile runs speak as the person. */
export function routingBacktestCopy(
  subject: RoutingBacktestSubjectKind,
): RoutingBacktestCopy {
  return subject === 'organization'
    ? {
        spentLabel: 'What you spent',
        ranLabel: 'What you ran',
        autoLabel: 'Model routing',
        replayIntro:
          'We replay your team’s past conversations through model routing and price each one at the model it would have picked.',
      }
    : {
        spentLabel: 'What I spent',
        ranLabel: 'What I ran',
        autoLabel: 'Model routing',
        replayIntro:
          'We replay your past conversations through model routing and price each one at the model it would have picked.',
      };
}

/** A 0–1 share as a whole percent, with `<1%` for tiny non-zero shares. */
export function formatShare(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%';
  if (fraction < 0.005) return '<1%';
  return `${Math.round(fraction * 100)}%`;
}

/** `anthropic/claude-opus-5` → `claude-opus-5`. */
export function modelLabel(modelId: string): string {
  const slash = modelId.lastIndexOf('/');
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

export interface ModelShareRow {
  modelId: string;
  label: string;
  actual: number;
  auto: number;
  actualCost: number;
  autoCost: number;
}

/** Rows the "Which models answered" chart shows before folding the rest. */
export const MODEL_SHARE_MAX_ROWS = 10;
const OTHER_MODELS_ROW_ID = '__other__';

/**
 * Every model on either side gets a row, sorted by actual share then Auto
 * share, so the chart reads top-down from what the team ran most. Past
 * `maxRows` (at least 2), the models with the most combined share keep their
 * rows and the rest fold into one trailing `Other models` row.
 */
export function modelShareRows(
  shares: readonly ModelRoutingBacktestModelShareV1[],
  maxRows: number = MODEL_SHARE_MAX_ROWS,
): ModelShareRow[] {
  const rows = shares
    .filter((share) => share.actualTurnShare > 0 || share.autoTurnShare > 0)
    .map((share) => ({
      modelId: share.modelId,
      label: modelLabel(share.modelId),
      actual: share.actualTurnShare,
      auto: share.autoTurnShare,
      actualCost: share.actualCostShare,
      autoCost: share.autoCostShare,
    }));
  // One kept row plus the Other row is the smallest cap that still folds.
  const cap = Math.max(2, maxRows);
  if (rows.length <= cap) return rows.sort(compareShareRows);

  // Rank by combined share so a model only model routing picked still makes
  // the cut, then fold everything past the top `maxRows - 1`.
  const ranked = [...rows].sort(
    (a, b) => b.actual + b.auto - (a.actual + a.auto) || compareShareRows(a, b),
  );
  const kept = ranked.slice(0, cap - 1).sort(compareShareRows);
  const folded = ranked.slice(cap - 1);
  const other = folded.reduce<ModelShareRow>(
    (sum, row) => ({
      ...sum,
      actual: sum.actual + row.actual,
      auto: sum.auto + row.auto,
      actualCost: sum.actualCost + row.actualCost,
      autoCost: sum.autoCost + row.autoCost,
    }),
    {
      modelId: OTHER_MODELS_ROW_ID,
      label: `Other models (${folded.length})`,
      actual: 0,
      auto: 0,
      actualCost: 0,
      autoCost: 0,
    },
  );
  return [...kept, other];
}

function compareShareRows(a: ModelShareRow, b: ModelShareRow): number {
  return (
    b.actual - a.actual || b.auto - a.auto || a.label.localeCompare(b.label)
  );
}

export type RoutingBacktestProgressStage =
  | 'preparing'
  | 'replaying'
  | 'totaling';

/**
 * Where a queued or running estimate is: gathering turns before the replay
 * starts, replaying them, or totaling once every planned turn is back.
 */
export function routingBacktestProgressStage(
  status: ModelRoutingBacktestStatus,
  progress: { replayedTurnCount: number; plannedTurnCount: number },
): RoutingBacktestProgressStage {
  if (status === 'queued' || progress.plannedTurnCount <= 0) {
    return 'preparing';
  }
  return progress.replayedTurnCount >= progress.plannedTurnCount
    ? 'totaling'
    : 'replaying';
}

export function progressStageMessage(
  stage: RoutingBacktestProgressStage,
): string {
  switch (stage) {
    case 'preparing':
      return 'Preparing the data…';
    case 'replaying':
      return 'Replaying conversations through model routing…';
    case 'totaling':
      return 'Adding up the savings…';
  }
}

/** Savings never show as negative: a run where Auto cost more saved nothing. */
export function displayedSavings(result: ModelRoutingBacktestResultV1): {
  usd: number;
  fraction: number;
} {
  return {
    usd: Math.max(0, result.savingsUsd),
    fraction: Math.max(0, result.savingsFraction),
  };
}

export function unavailableMessage(
  reason: ModelRoutingBacktestUnavailableReason,
): string | null {
  switch (reason) {
    case 'feature_disabled':
      return null;
    case 'admin_required':
      return 'Ask an organization admin to run this estimate.';
    case 'policy_blocked':
      return 'Your organization’s model settings turn off model routing.';
    case 'transcripts_disabled':
      return 'Transcript sync is off for your organization, so there are no conversations to replay.';
    case 'no_eligible_turns':
      return 'No synced conversations in this range to replay. Try a longer range.';
    default:
      return null;
  }
}

export function failureMessage(code: ModelRoutingBacktestFailureCode): string {
  switch (code) {
    case 'insufficient_credits':
      return 'Ran out of AI Credits. Add credits to finish; turns already replayed aren’t charged again.';
    case 'policy_blocked':
      return 'Your organization’s model settings turn off model routing.';
    case 'transcripts_disabled':
      return 'Transcript sync is off, so there are no conversations to replay.';
    case 'no_eligible_turns':
      return 'No synced conversations in this range to replay.';
    case 'time_limit':
    case 'attempt_limit':
    case 'internal':
    default:
      return 'The estimate couldn’t finish. Try again.';
  }
}

export function createErrorMessage(
  // Server codes outside the known union fall through to `fallback`.
  code: string | undefined,
  fallback: string,
): string {
  switch (code) {
    case 'insufficient_credits':
      return 'Add AI Credits to run this estimate.';
    case 'daily_limit':
      return `You’ve run ${MODEL_ROUTING_BACKTEST_DAILY_RUN_LIMIT} estimates today. Try again tomorrow.`;
    case 'full_mode_unavailable':
      return 'This range has too many turns to replay every one. Use a sample.';
    case 'admin_required':
    case 'policy_blocked':
    case 'transcripts_disabled':
    case 'no_eligible_turns':
      return unavailableMessage(code) ?? fallback;
    default:
      return fallback;
  }
}

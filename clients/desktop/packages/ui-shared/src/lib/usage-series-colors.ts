import type { CostBillingBasis, CostSource } from '@canopy/protocol/cost-view';

/** One data-viz palette for the context meter, cost bars and breakdowns (approved primitive use, DESIGN.md). */
export const USAGE_SERIES_COLORS = {
  blue: 'var(--primitive-blue-500)',
  orange: 'var(--primitive-orange-500)',
  green: 'var(--primitive-green-500)',
  purple: 'var(--primitive-purple-500)',
  pink: 'var(--primitive-pink-500)',
  cyan: 'var(--primitive-cyan-500)',
  red: 'var(--primitive-red-500)',
} as const;

/** Neutral series: plan-covered usage and figures with no dollars. */
export const USAGE_SERIES_NEUTRALS = {
  secondary: 'var(--fg-secondary)',
  tertiary: 'var(--fg-tertiary)',
} as const;

/** The context meter's category order, unchanged from the composer popover. */
export const CONTEXT_SERIES_COLORS: readonly string[] = [
  USAGE_SERIES_COLORS.blue,
  USAGE_SERIES_COLORS.orange,
  USAGE_SERIES_COLORS.green,
  USAGE_SERIES_COLORS.purple,
  USAGE_SERIES_COLORS.pink,
  USAGE_SERIES_COLORS.cyan,
];

export const COST_SOURCE_COLORS: Readonly<Record<CostSource, string>> = {
  chat: USAGE_SERIES_COLORS.blue,
  pipeline: USAGE_SERIES_COLORS.cyan,
  subagents: USAGE_SERIES_COLORS.purple,
  delegations: USAGE_SERIES_COLORS.orange,
  background: USAGE_SERIES_COLORS.green,
};

export const COST_BILLING_COLORS: Readonly<Record<CostBillingBasis, string>> = {
  subscription: USAGE_SERIES_NEUTRALS.secondary,
  ai_credits: USAGE_SERIES_COLORS.pink,
  account_proxy: USAGE_SERIES_NEUTRALS.tertiary,
  api_key: USAGE_SERIES_COLORS.red,
  org_gateway: USAGE_SERIES_NEUTRALS.tertiary,
  local: USAGE_SERIES_NEUTRALS.tertiary,
  unknown: USAGE_SERIES_NEUTRALS.tertiary,
};

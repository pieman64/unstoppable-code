'use client';

import type { JSX, ReactNode } from 'react';
import { Info } from '@canopy/ui-shared/icons/AppIcons';
import { Tooltip } from '@canopy/ui-shared';
import { Button } from '@canopy/ui-shared/components';
import type { TelemetryHeadlineCard } from '@canopy/protocol/telemetry';
import { formatCardValue } from './format';
import { TrendIndicator, type TrendColorScheme } from './TrendIndicator';
import { Surface } from '@canopy/ui-shared/components';

export type { TrendColorScheme };

interface HeadlineCardsProps {
  cards: readonly TelemetryHeadlineCard[];
  /**
   * Per-key tooltip copy that overrides {@link CARD_DESCRIPTIONS}. Surfaces with
   * a different audience (e.g. the individual public profile vs. a team) pass
   * their own phrasing here; omitted keys fall back to the team-focused default.
   */
  descriptions?: Record<string, string>;
  /**
   * Trend-chip color semantics. Defaults to `'cost'` so the shared team/org
   * dashboards keep their attention-on-rising-cost signal; the public profile
   * opts into `'flex'` for its more-is-better framing.
   */
  trendColorScheme?: TrendColorScheme;
  /**
   * Per-key display overrides for cards that aren't a period-over-period
   * metric (e.g. an estimate's "Saved" tile): a preformatted value, a value
   * tone, and a caption that replaces the trend chip.
   */
  cardDetails?: Record<string, HeadlineCardDetail>;
  /** Grid test id; defaults to `usage-headline-cards`. */
  testId?: string;
}

export interface HeadlineCardDetail {
  value?: string;
  tone?: 'default' | 'success';
  caption?: ReactNode;
}

/**
 * Plain-language explanation per card key, surfaced via an info tooltip on the
 * card header. Keyed by the stable `TelemetryHeadlineCard.key`; cards without an
 * entry render no tooltip.
 */
const CARD_DESCRIPTIONS: Record<string, string> = {
  totalCostUsd:
    'Standard list-price cost of all AI interactions in this period.',
  billedCostUsd:
    'Estimated cost of the provider subscriptions your team used, amortized across this period.',
  savingsUsd:
    'Observed usage minus subscription cost — the estimated savings from using subscriptions instead of paying list price.',
  autoRoutingSavingsUsd:
    'What model routing saved by picking a cheaper model when it could, compared with always using your usual model. The small cost of picking is already taken out.',
  totalTokens: 'Total input and output tokens across all agent turns.',
  turns:
    'Agent turns completed — each turn is one prompt and the agent’s response.',
  subscriptions:
    'Distinct provider subscription accounts attributed to usage in this period.',
  worktrees: 'Worktrees created in this period.',
  plans: 'Plans created in this period.',
  pullRequests: 'Pull requests opened in this period.',
};

/** Grid of headline metric cards, each with a period-over-period trend chip. */
export function HeadlineCards({
  cards,
  descriptions,
  trendColorScheme = 'cost',
  cardDetails,
  testId = 'usage-headline-cards',
}: HeadlineCardsProps): JSX.Element {
  const resolvedDescriptions = descriptions
    ? { ...CARD_DESCRIPTIONS, ...descriptions }
    : CARD_DESCRIPTIONS;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid={testId}>
      {cards.map((card) => {
        const description = resolvedDescriptions[card.key];
        const detail = cardDetails?.[card.key];
        return (
          <Surface
            key={card.key}
            variant="raised"
            padding="default"
            data-testid={`usage-card-${card.key}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-medium fg-secondary">{card.label}</p>
              {description && (
                <Tooltip
                  label={
                    <span className="block max-w-60 whitespace-normal">
                      {description}
                    </span>
                  }
                >
                  <Button
                    variant="ghost"
                    size="compact"
                    iconOnly
                    aria-label={`What does ${card.label} mean?`}
                    // The 28px circle overhangs the 16px label line rather
                    // than growing the card's header.
                    className="-m-1.5"
                    data-testid={`usage-card-${card.key}-info`}
                  >
                    <Info size={13} aria-hidden="true" />
                  </Button>
                </Tooltip>
              )}
            </div>
            <p
              className={`mt-1 text-2xl font-semibold ${
                detail?.tone === 'success' ? 'fg-success' : 'fg-primary'
              }`}
              data-testid={`usage-card-${card.key}-value`}
            >
              {detail?.value ?? formatCardValue(card.value, card.unit)}
            </p>
            {detail?.caption !== undefined ? (
              <p className="mt-1 text-xs fg-secondary">{detail.caption}</p>
            ) : (
              <TrendIndicator
                current={card.value}
                previous={card.previousValue}
                scheme={trendColorScheme}
                comparisonLabel="vs. prior"
              />
            )}
          </Surface>
        );
      })}
    </div>
  );
}

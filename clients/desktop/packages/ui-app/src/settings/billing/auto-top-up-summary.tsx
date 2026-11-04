'use client';

import type { JSX, ReactNode } from 'react';
import { ProgressBar } from '@canopy/ui-shared/components';
import { formatUsd } from '@canopy/ui-shared/lib';
import {
  AI_CREDIT_AUTO_TOP_UP_DEFAULT_AMOUNT_USD,
  AI_CREDIT_AUTO_TOP_UP_DEFAULT_THRESHOLD_CREDITS,
} from '@canopy/protocol/settings/billing-plan-catalog';
import type { CreditsAutoTopUpSettings } from '@canopy/protocol/settings/billing';
import { BillingTogglePanel } from './billing-toggle-panel';

/**
 * The read-only half of the automatic top-up controls: the month-to-date
 * spend meter and the "Buys $X when your balance drops below N credits"
 * summary. The web editor (`AutoTopUpControls`) renders it with its "Adjust"
 * button; hosts without inline checkout render it through
 * {@link AutoTopUpSummary} with a handoff CTA instead. Neither path edits
 * anything here.
 */

/** The master switch's sentence, shared by the editor and the summary. */
export function autoTopUpToggleSentence(
  brandName: string,
  orgVariant: boolean,
): string {
  return orgVariant
    ? `Automatically buy credits to keep your team using ${brandName} when you run low.`
    : `Automatically buy credits to keep using ${brandName} when you run low.`;
}

/** The effective per-refill amount and trigger, defaulted from the catalog. */
export function autoTopUpEffectiveTuning(settings: CreditsAutoTopUpSettings): {
  amountUsd: number;
  thresholdCredits: number;
} {
  return {
    amountUsd: settings.amountUsd ?? AI_CREDIT_AUTO_TOP_UP_DEFAULT_AMOUNT_USD,
    thresholdCredits:
      settings.thresholdCredits ??
      AI_CREDIT_AUTO_TOP_UP_DEFAULT_THRESHOLD_CREDITS,
  };
}

export interface AutoTopUpSettingsDetailsProps {
  readonly settings: CreditsAutoTopUpSettings;
  /** Month-to-date auto-top-up spend, for the meter. */
  readonly monthlySpentUsd: number;
  /** Human-readable reset label (start of next month, e.g. "Aug 1"). */
  readonly monthlyResetAt: string;
  /** Prefix for test ids — `''` (account) or `'team-'` (org). */
  readonly testIdPrefix?: string;
  /** The control beside the summary ("Adjust" on web), when any. */
  readonly action?: ReactNode;
}

/** The meter and summary shown while automatic top-up is on. */
export function AutoTopUpSettingsDetails({
  settings,
  monthlySpentUsd,
  monthlyResetAt,
  testIdPrefix = '',
  action,
}: AutoTopUpSettingsDetailsProps): JSX.Element {
  const tid = (suffix: string): string => `${testIdPrefix}${suffix}`;
  const cap = settings.maxMonthlyUsd;
  const { amountUsd, thresholdCredits } = autoTopUpEffectiveTuning(settings);
  const pct =
    cap !== null && cap > 0
      ? Math.min(100, Math.round((monthlySpentUsd / cap) * 100))
      : 0;

  return (
    <>
      {/* Month-to-date spend meter */}
      <div className="mt-4" data-testid={tid('credits-auto-top-up-meter')}>
        <div className="flex items-center justify-between text-xs fg-secondary">
          <span>
            {formatUsd(monthlySpentUsd)} spent
            <span className="mx-1">·</span>
            Resets {monthlyResetAt}
          </span>
          {cap !== null ? (
            <span>{pct}% used</span>
          ) : (
            <span>No monthly limit</span>
          )}
        </div>
        {cap !== null ? (
          <ProgressBar
            className="mt-1"
            value={pct}
            label="Month-to-date auto top-up spend"
            hideLabel
          />
        ) : null}
      </div>

      {/* Current settings summary + adjust */}
      <div className="mt-4 flex items-center justify-between gap-3">
        <p
          className="min-w-0 text-s fg-secondary"
          data-testid={tid('credits-auto-top-up-summary')}
        >
          Buys{' '}
          <span className="font-medium fg-primary">{formatUsd(amountUsd)}</span>{' '}
          when your balance drops below{' '}
          <span className="font-medium fg-primary">
            {thresholdCredits} credits
          </span>
          {cap !== null ? (
            <>
              , up to{' '}
              <span className="font-medium fg-primary">{formatUsd(cap)}</span>
              /month.
            </>
          ) : (
            ', with no monthly limit.'
          )}
        </p>
        {action ?? null}
      </div>
    </>
  );
}

export interface AutoTopUpSummaryProps {
  readonly settings: CreditsAutoTopUpSettings;
  readonly monthlySpentUsd: number;
  readonly monthlyResetAt: string;
  readonly brandName: string;
  readonly orgVariant?: boolean;
  readonly testIdPrefix?: string;
  /** The handoff CTA, for viewers who may manage the settings. */
  readonly action?: ReactNode;
}

/**
 * The automatic top-up panel without its editor: the switch reflects the
 * saved state and cannot be changed here; changes happen on the web.
 */
export function AutoTopUpSummary({
  settings,
  monthlySpentUsd,
  monthlyResetAt,
  brandName,
  orgVariant = false,
  testIdPrefix = '',
  action,
}: AutoTopUpSummaryProps): JSX.Element {
  const tid = (suffix: string): string => `${testIdPrefix}${suffix}`;
  return (
    <BillingTogglePanel
      testId={tid('credits-auto-top-up')}
      toggleTestId={tid('credits-auto-top-up-toggle')}
      title="Automatic top-up"
      description={autoTopUpToggleSentence(brandName, orgVariant)}
      checked={settings.enabled}
      ariaLabel="Toggle automatic credit top-up"
      disabled
      onToggle={() => undefined}
      error={null}
    >
      {settings.enabled ? (
        <AutoTopUpSettingsDetails
          settings={settings}
          monthlySpentUsd={monthlySpentUsd}
          monthlyResetAt={monthlyResetAt}
          testIdPrefix={testIdPrefix}
          action={action}
        />
      ) : action ? (
        <div className="mt-4 flex justify-end">{action}</div>
      ) : null}
    </BillingTogglePanel>
  );
}

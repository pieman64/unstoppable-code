import { useId, useState, type JSX, type ReactNode } from 'react';
import { DEFAULT_DAILY_DRIP_CAP_CREDITS } from '@canopy/protocol/billing';
import { Notice, ToggleSwitch } from '@canopy/ui-shared/components';
import { SettingsRowsRow } from '@canopy/ui-shared/components/settings/SettingsRows';
import { CheckIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  dailyCreditsRowState,
  FIRST_RUN_DAILY_CREDITS_ENABLED,
  FIRST_RUN_DAILY_CREDITS_LABEL,
  firstRunDailyCreditsGranted,
  firstRunDailyCreditsOffer,
  type DailyCreditDripSaveOutcome,
} from './first-run-daily-credits-copy';

/** The host's daily credit drip opt-in, as the first-run row reads it. */
export interface FirstRunDailyCreditsDrip {
  /** The host's current view of the opt-in. */
  readonly live: {
    readonly state: 'unavailable' | 'loading' | 'undecided' | 'decided';
    readonly enabled: boolean;
    /** Plan cap offered; null falls back to the default cap. */
    readonly capCredits: number | null;
  };
  /** True while a save is in flight. */
  readonly busy: boolean;
  /** Inline error after a failed save, or null. */
  readonly error: string | null;
  /** The outcome of the last successful turn-on saved here, or null. */
  readonly outcome: DailyCreditDripSaveOutcome | null;
  /** Save `enabled: true`. Resolves once the save settles. */
  readonly turnOn: () => Promise<void>;
  /** Save `enabled: false`. Resolves once the save settles. */
  readonly notNow: () => Promise<void>;
}

export interface FirstRunAiCreditsRowProps {
  readonly drip: FirstRunDailyCreditsDrip;
  /** The host's brand mark, shown before the label. */
  readonly logo: ReactNode;
}

/**
 * The account's daily free AI Credits, offered as an opt-in to a user with
 * no Claude or Codex subscription. Off until the user turns it on; either
 * answer is saved as their decision, which also clears Home's "Claim…" step.
 *
 * The description is one region whose height never changes between the
 * offer and the confirmations: every variant sits in the same grid cell and
 * only the current one is visible, so the page (and Continue) never moves
 * at any width or text size.
 */
export function FirstRunAiCreditsRow({
  drip,
  logo,
}: FirstRunAiCreditsRowProps): JSX.Element {
  const { live, busy, error, outcome, turnOn, notNow } = drip;
  // Only the hook's current save may show an optimistic choice. Its busy
  // state also clears on account changes, before an old request settles.
  const [pending, setPending] = useState(false);
  const canSave = live.state === 'undecided' || live.state === 'decided';
  const capCredits = live.capCredits ?? DEFAULT_DAILY_DRIP_CAP_CREDITS;
  const onChange = (next: boolean): void => {
    if (busy) return;
    setPending(next);
    void (next ? turnOn() : notNow());
  };
  const id = useId();
  const switchId = `${id}-switch`;
  const offerId = `${id}-offer`;
  const confirmationId = `${id}-confirmation`;
  // A save in flight keeps the offer: success is announced once it settles.
  const state = busy
    ? 'offer'
    : dailyCreditsRowState(outcome, live.enabled === true);
  const offer = firstRunDailyCreditsOffer(capCredits);
  const confirmation =
    state === 'granted' && outcome
      ? firstRunDailyCreditsGranted(outcome.granted)
      : state === 'enabled'
        ? FIRST_RUN_DAILY_CREDITS_ENABLED
        : null;
  const cell = 'col-start-1 row-start-1';
  return (
    <SettingsRowsRow
      dataTestId="first-run-daily-credits"
      htmlFor={switchId}
      label={
        <span className="inline-flex items-center gap-2">
          {logo}
          {FIRST_RUN_DAILY_CREDITS_LABEL}
        </span>
      }
      description={
        <span
          className="grid"
          data-testid="first-run-daily-credits-description"
          data-state={state}
        >
          {/* Invisible sizers: the longest variants reserve their height. */}
          <span
            aria-hidden="true"
            className={`${cell} invisible flex items-start gap-1`}
          >
            <CheckIcon size={12} className="mt-0.5 shrink-0" />
            <span>{firstRunDailyCreditsGranted(capCredits)}</span>
          </span>
          <span aria-hidden="true" className={`${cell} invisible`}>
            {FIRST_RUN_DAILY_CREDITS_ENABLED}
          </span>
          <span
            id={offerId}
            className={`${cell} ${confirmation === null ? '' : 'invisible'}`}
            aria-hidden={confirmation === null ? undefined : true}
          >
            {offer}
          </span>
          {/* Always mounted, so screen readers hear each settled outcome. */}
          <span
            role="status"
            id={confirmationId}
            className={`${cell} flex items-start gap-1`}
          >
            {confirmation !== null && (
              <>
                {state === 'granted' && (
                  <CheckIcon
                    aria-hidden
                    size={12}
                    className="mt-0.5 shrink-0 fg-success"
                  />
                )}
                <span data-testid="first-run-daily-credits-confirmation">
                  {confirmation}
                </span>
              </>
            )}
          </span>
        </span>
      }
      control={
        <ToggleSwitch
          id={switchId}
          label={FIRST_RUN_DAILY_CREDITS_LABEL}
          describedBy={confirmation === null ? offerId : confirmationId}
          dataTestId="first-run-daily-credits-toggle"
          checked={busy ? pending : live.enabled === true}
          disabled={busy || !canSave}
          onChange={onChange}
        />
      }
    >
      {error && (
        <Notice intent="attention" data-testid="first-run-daily-credits-error">
          {error}
        </Notice>
      )}
    </SettingsRowsRow>
  );
}

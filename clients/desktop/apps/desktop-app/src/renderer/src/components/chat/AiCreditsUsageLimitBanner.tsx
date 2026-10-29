import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type {
  AiCreditsRoutingMode,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import {
  useAiCreditsBannerStore,
  useAiCreditsRoutingActive,
  useVisibleUsageLimitBanner,
  type ChatBannerTarget,
} from '@/stores/aiCreditsBannerStore';
import { brandText } from '@/lib/brand';
import {
  CONTACT_ORG_ADMIN_COPY,
  resolveAiCreditsCoverage,
} from '@/lib/openBillingPage';
import {
  Notice,
  NoticeButton,
  noticeButtonClassName,
} from '@canopy/ui-shared/components';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import { GetAiCreditsCta } from './GetAiCreditsCta';
import { useChatTargetAiCreditsScope } from '@/lib/aiCreditsScope';

/**
 * Every recovery action is a house `Button`: `secondary` for the alternative
 * and conservative choices (Resume at reset, Use credits now) and `primary`
 * for the single recommended action per state (Always use credits, Get
 * credits, Use AI Credits), so no state ever shows two equally weighted solid
 * actions.
 */
const PRIMARY_BUTTON_CLASS = noticeButtonClassName('primary');

/**
 * Worktree-only "Schedule Resume" affordance. Passed in by surfaces that support
 * scheduled automations; omitted elsewhere so the button is simply not shown.
 */
export interface UsageLimitScheduleResume {
  onSchedule: () => void;
  inFlight: boolean;
  disabled: boolean;
  error: string | null;
  scheduledForLabel: string | null;
}

interface AiCreditsUsageLimitBannerProps {
  /**
   * The chat this banner belongs to. Works on every surface because usage-limit
   * signals are keyed by target and fed centrally from the main process
   * (CAN-838). Pass `null` to render nothing.
   */
  target: ChatBannerTarget | null;
  /**
   * Worktree-only: route just this session through AI Credits ("just this
   * time"). Omit on surfaces without per-session override plumbing — the
   * persistent "Always use credits" action still works everywhere.
   */
  onUseJustThisTime?: () => void;
  /** Worktree-only "Schedule Resume" support. Omit to hide the button. */
  scheduleResume?: UsageLimitScheduleResume;
  /**
   * True while the composer shows the "Using AI Credits" card for this chat.
   * Picking credits (for example via "Use credits now") shows that card at
   * once, before any turn routes, so the limit notice yields to it instead of
   * offering the credits the user just chose (CAN-4757). Defaults to `false`.
   */
  aiCreditsCardVisible?: boolean;
}

/**
 * Shared usage-limit banner. Rendered once in the universal `ChatInput`, it
 * surfaces on every chat surface — worktree, standalone, App Advisor, pipeline
 * editor, plan-explore, and any future surface — driven by the target-keyed
 * banner store.
 *
 * The recovery CTA is now driven by native Canopy entitlements (CAN-1235): users
 * with a spendable personal balance (native OR already-linked UD) or an org with
 * spendable headroom get the switch-and-resume affordance; org members with no
 * headroom get a static "contact your org admin" message; fully-uncovered users
 * are pointed at the native pricing page. No UD-linking path is surfaced.
 */
export function AiCreditsUsageLimitBanner({
  target,
  onUseJustThisTime,
  scheduleResume,
  aiCreditsCardVisible = false,
}: AiCreditsUsageLimitBannerProps): JSX.Element | null {
  const banner = useVisibleUsageLimitBanner(target);
  const routingActive = useAiCreditsRoutingActive(target);
  // Coverage is a question about THIS chat's owner (CAN-3463).
  const creditsScope = useChatTargetAiCreditsScope(target);
  const dismissUsageLimit = useAiCreditsBannerStore((s) => s.dismissUsageLimit);

  const [availability, setAvailability] =
    useState<NativeAiCreditsAvailability | null>(null);
  // True once the coverage read has answered (or failed) for the current
  // scope, so the fallback action is not drawn and then swapped for the
  // offer a moment later.
  const [coverageSettled, setCoverageSettled] = useState(false);
  const [routingMode, setRoutingMode] = useState<AiCreditsRoutingMode | null>(
    null,
  );
  // Server-reported free app access. There is no plan to upgrade then, so the
  // purchase state offers credits instead (CAN-3926). Read with availability,
  // only while the banner is visible, so the copy never flips after showing.
  const [freeAccess, setFreeAccess] = useState(false);
  const [savingMode, setSavingMode] = useState(false);
  /**
   * Bumped to re-run the availability/preferences read below. Coverage can
   * appear while the banner is open (a purchase completed in the browser), and
   * the banner's own affordances are all derived from that read.
   */
  const [coverageToken, setCoverageToken] = useState(0);
  const refreshCoverage = useCallback((): void => {
    setCoverageToken((token) => token + 1);
  }, []);

  // Two signals hide the notice without dismissing it. `routingActive` is
  // main's report that a turn actually routed through credits.
  // `aiCreditsCardVisible` is the composer's local billing choice, which shows
  // the credits card before anything is sent. The store entry is kept, so
  // switching back to the subscription before a send brings the notice back.
  const bannerVisible =
    banner !== null && !routingActive && !aiCreditsCardVisible;

  // Load the consolidated native availability signal + persisted routing mode so
  // the recovery affordances are gated on real state. Runs only while visible.
  // Never let another owner's coverage stand in while this one loads.
  useEffect(() => {
    setAvailability(null);
    setCoverageSettled(false);
  }, [creditsScope]);

  useEffect(() => {
    if (!bannerVisible) {
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      // Best-effort: a failed or absent entitlements read keeps the tier copy
      // and never hides the recovery actions.
      const loadEntitlements = window.api.loadCanopyCloudEntitlements;
      const freeAccessRead: Promise<boolean> =
        typeof loadEntitlements === 'function'
          ? loadEntitlements()
              .then((next) => next.resolved && next.freeAccess === true)
              .catch(() => false)
          : Promise.resolve(false);
      try {
        const [native, prefs, nextFreeAccess] = await Promise.all([
          window.api.loadNativeAiCreditsAvailability(creditsScope),
          window.api.loadPreferences(),
          freeAccessRead,
        ]);
        if (cancelled) return;
        setAvailability(native);
        setRoutingMode(prefs.aiCreditsRoutingMode ?? 'off');
        setFreeAccess(nextFreeAccess);
        setCoverageSettled(true);
      } catch {
        if (!cancelled) {
          setAvailability(null);
          setCoverageSettled(true);
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [bannerVisible, coverageToken, creditsScope]);

  // Short enough to sit on a button: a clock time when the quota resets
  // today, a weekday plus time otherwise.
  const resetsLabel = useMemo(
    (): string | null => formatUsageLimitTimeLabel(banner?.resetsAt),
    [banner?.resetsAt],
  );

  if (!target || !banner || !bannerVisible) {
    return null;
  }

  const providerName = banner.provider === 'codex' ? 'Codex' : 'Claude';
  // Shared coverage decision (ECW-9091) so this banner and the
  // no-billing-source banner can never disagree about who may buy credits.
  const {
    canSpendCredits: canSwitchAndResume,
    showContactAdmin,
    showPurchase: showPricing,
  } = resolveAiCreditsCoverage(availability);
  const showOffer =
    canSwitchAndResume && routingMode === 'off' && !routingActive;

  const dismiss = (): void => dismissUsageLimit(target, banner.dismissKey);

  const enableOnQuota = (): void => {
    setSavingMode(true);
    void window.api
      .savePreferences({ aiCreditsRoutingMode: 'on-quota' })
      .catch(() => {
        // Swallow — preference save can fail if userData is unavailable.
      })
      .finally(() => {
        setSavingMode(false);
        dismiss();
      });
  };

  // One line, two inks (design owner, 2026-09-17): the title names the state
  // in a few words and the message that follows it names the choice the
  // buttons decide between, so each label can stay short. The offer state
  // spells out "credits now or wait for the reset", the pricing state names
  // the upgrade, and the no-headroom org state carries the admin copy
  // because it has no button at all.
  // Once a resume is scheduled the banner says what happens next instead of
  // re-asking the question (design owner, 2026-09-17): the sentence names
  // the scheduled time, the schedule button goes away, and only the actions
  // that would change the outcome (spend credits now) remain.
  const scheduledFor = scheduleResume?.scheduledForLabel ?? null;
  const showScheduleResume = Boolean(scheduleResume) && scheduledFor === null;
  // The "continue on credits or wait" sentence always gets a way to act on
  // its first half. When the offer cannot be shown (coverage unreadable or
  // inconclusive, or routing already set to something other than off), this
  // primary action routes just this chat through credits; main still checks
  // coverage when the turn is sent. It waits for the coverage read to settle
  // so the row does not draw this action and then swap it for the offer.
  const showUseAiCredits =
    Boolean(onUseJustThisTime) &&
    coverageSettled &&
    !showOffer &&
    !showPricing &&
    !showContactAdmin &&
    scheduledFor === null;
  const showActionRow =
    showOffer ||
    showContactAdmin ||
    showPricing ||
    showScheduleResume ||
    showUseAiCredits;
  const hasActionButton =
    showScheduleResume || showOffer || showPricing || showUseAiCredits;

  // The message after the title: the choice or the next step, one sentence.
  const continuation = scheduledFor ? (
    <span data-testid="chat-input-usage-limit-scheduled">
      This chat resumes automatically at {scheduledFor}
      {showOffer
        ? `, or continue on ${brandText.appName} credits now.`
        : showPricing
          ? freeAccess
            ? `, or get ${brandText.appName} credits to keep working now.`
            : `, or upgrade your ${brandText.appName} plan to keep working now.`
          : '.'}
    </span>
  ) : showPricing ? (
    freeAccess ? (
      `Get ${brandText.appName} credits to keep working when you hit your provider limits.`
    ) : (
      `Upgrade your ${brandText.appName} plan to keep working when you hit your provider limits.`
    )
  ) : showContactAdmin ? (
    <span data-testid="chat-input-usage-limit-contact-admin">
      {CONTACT_ORG_ADMIN_COPY}
    </span>
  ) : (
    `Continue on ${brandText.appName} credits or wait for your quota to reset${
      resetsLabel ? ` around ${resetsLabel}` : ''
    }.`
  );

  // Post-action feedback only (a failed schedule); never a standing subtitle.
  const detail = scheduleResume?.error ? (
    <div>{scheduleResume.error}</div>
  ) : undefined;

  // Actions order alternatives → recommended, left → right, so the single
  // accent action always sits at the far right: the delayed fallback (Resume
  // at reset) stays among the alternatives, and enabling routing (or getting
  // credits) is last. Three or more buttons move to their own row,
  // left-aligned with the message, instead of crowding the copy.
  const actionCount =
    (showOffer && onUseJustThisTime ? 1 : 0) +
    (showOffer ? 1 : 0) +
    (showPricing ? 1 : 0) +
    (showScheduleResume ? 1 : 0) +
    (showUseAiCredits ? 1 : 0);
  const actionsPlacement = actionCount >= 3 ? 'below' : 'trailing';
  const actions = hasActionButton ? (
    <span
      data-testid={
        showOffer ? 'chat-input-usage-limit-ai-credits-offer' : undefined
      }
      className="contents"
    >
      {showOffer && onUseJustThisTime && (
        <NoticeButton
          variant="secondary"
          onClick={onUseJustThisTime}
          data-testid="chat-input-usage-limit-ai-credits-once"
        >
          Use credits now
        </NoticeButton>
      )}
      {showScheduleResume && scheduleResume && (
        <NoticeButton
          variant="secondary"
          onClick={scheduleResume.onSchedule}
          disabled={scheduleResume.inFlight || scheduleResume.disabled}
          data-testid="chat-input-usage-limit-schedule-resume"
        >
          {resetsLabel ? `Resume at ${resetsLabel}` : 'Resume at reset'}
        </NoticeButton>
      )}
      {showOffer && (
        <NoticeButton
          variant="primary"
          onClick={enableOnQuota}
          disabled={savingMode}
          data-testid="chat-input-usage-limit-ai-credits-always-on-quota"
        >
          Always use credits
        </NoticeButton>
      )}
      {showUseAiCredits && onUseJustThisTime && (
        <NoticeButton
          variant="primary"
          onClick={onUseJustThisTime}
          data-testid="chat-input-usage-limit-use-ai-credits"
        >
          Use AI Credits
        </NoticeButton>
      )}
      {showPricing && (
        <GetAiCreditsCta
          label="Get credits"
          {...(creditsScope ? { aiCreditsScope: creditsScope } : {})}
          // NOT `enableOnQuota`. That writes the GLOBAL
          // `aiCreditsRoutingMode: 'on-quota'` preference, which until now
          // only ever happened when the user explicitly pressed "Whenever my
          // quota runs out". Buying credits must not silently also opt them
          // into automatic credit spend on every future quota exhaustion, in
          // every chat.
          //
          // The CTA already fires `announceAiCreditsChanged()` on coverage,
          // which re-reads availability and flips `showOffer` on — so the
          // explicit consent buttons appear right here and the user chooses
          // for themselves. Re-reading is all this needs to do.
          onCovered={refreshCoverage}
          buttonClassName={PRIMARY_BUTTON_CLASS}
          handoffLayout="compact"
          dataTestId="chat-input-usage-limit-view-plans"
        />
      )}
    </span>
  ) : undefined;

  return (
    <Notice
      intent="attention"
      title={`${providerName} usage limit reached`}
      data-testid="chat-input-usage-limit-banner"
      onDismiss={dismiss}
      dismissLabel="Dismiss usage limit notice"
      dismissTestId="chat-input-usage-limit-dismiss"
      {...(detail !== undefined ? { detail } : {})}
      {...(showActionRow ? { actions, actionsPlacement } : {})}
    >
      {continuation}
    </Notice>
  );
}

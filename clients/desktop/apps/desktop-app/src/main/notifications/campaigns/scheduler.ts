import type {
  ActivationCampaignId,
  ActivationQuietHours,
  CampaignDestination,
  CampaignSuppressionReason,
  OsNotificationShowRequest,
  PromotionalCampaignId,
} from '@canopy/desktop-shared/types';
import {
  PROMOTIONAL_SEND_INTERVAL_MS,
  resolveDueAt,
  resolvePromotionalCapLiftsAt,
} from './campaign-config';
import { getActiveCampaigns } from './served-config-sync';
import { buildCampaignNotificationId } from './click-router';
import { isWithinQuietHours } from './quiet-hours';
import type { VariantResolution } from './variant-resolver';
import { evaluateCampaign } from './eligibility';
import {
  releaseDeliveryFailures,
  latchCampaignSent,
  latchCampaignSuppressed,
  readActivationJourneyState,
  unlatchCampaignDeliveryFailure,
} from './journey-state';

/**
 * Activation campaign scheduler (CAN-1967).
 *
 * The load-bearing property is that the schedule is derived from persisted
 * wall-clock timestamps on every evaluation, never from elapsed timer state.
 * `setTimeout` does not survive system sleep: a laptop closed for six hours
 * fires an eight-hour timer late and unpredictably. So the timer is only a
 * hint about when to look again — `recomputeActivationSchedule` recomputes
 * from `Date.parse` on the stored anchor and is safe to call at any moment.
 */

/**
 * Grace period after a resume/unlock before evaluating. Waking a machine runs
 * login, unlock, and window restoration all at once; a banner delivered into
 * that is noise the user will dismiss without reading.
 */
export const POWER_RESUME_SETTLE_MS = 30_000;

/**
 * Reasons that resolve on their own with the passage of time: the user
 * unfocuses the window, quiet hours end, a probe that failed succeeds. These
 * MUST arm a retry, or the "a suppression is not terminal" invariant is true
 * in storage and false in practice -- the state stays re-deliverable while
 * nothing ever re-derives it.
 *
 * Reasons that resolve only on an EVENT live in
 * {@link EVENT_DRIVEN_SUPPRESSION_REASONS} and must NOT be polled. Every
 * other reason is terminal for this install: the campaign sent, the user is
 * in the holdout or has activated, the window elapsed, or their role resolves
 * to no copy branch.
 */
export const TRANSIENT_SUPPRESSION_REASONS: ReadonlySet<CampaignSuppressionReason> =
  new Set<CampaignSuppressionReason>([
    'no-anchor',
    'not-yet-due',
    'frequency-capped',
    'app-focused',
    'quiet-hours',
    'probe-failed',
  ]);

/**
 * Reasons that clear on an EVENT, never on their own. Polling for these
 * burned a main-thread preference read every five minutes, on every install,
 * for the process lifetime -- including with the feature dark, since a dark
 * flag makes `campaign-disabled` the first thing every campaign reports.
 *
 * They are re-checked when the thing that causes them changes: the feature
 * flag through `onSnapshotChanged`, notification preferences through
 * `applyPreferenceSideEffects`. Both call `requestActivationRecompute()`.
 */
export const EVENT_DRIVEN_SUPPRESSION_REASONS: ReadonlySet<CampaignSuppressionReason> =
  new Set<CampaignSuppressionReason>([
    'campaign-disabled',
    'notifications-disabled',
    'category-disabled',
    // OS authorization does not change on a timer, and Electron exposes no
    // way to observe it changing. Polling would spin every five minutes on a
    // machine where notifications are permanently denied. The natural
    // revivals -- next launch and a preference change -- already re-evaluate.
    'delivery-failed',
  ]);

/**
 * Retry spacing for a transient suppression.
 *
 * A single poll covers every transient reason rather than computing an exact
 * boundary per reason. Quiet-hours' end is computable, but focus, preference,
 * and flag changes are not, so per-reason math would still need this fallback
 * and would add a second code path to keep correct. Being at most five
 * minutes late on offsets of ten minutes and up is immaterial.
 */
const TRANSIENT_RETRY_MS = 5 * 60_000;

export interface ActivationNotificationPreferences {
  enabled: boolean;
  skipWhenFocused: boolean;
  /**
   * Gate for the activation campaigns: the promotional master AND its
   * "other promotional notifications" child (CAN-3013).
   */
  activationCategoryEnabled: boolean;
  quietHours: ActivationQuietHours;
}

export type CampaignOutcome =
  | {
      campaignId: PromotionalCampaignId;
      outcome: 'delivered';
      destination: string;
      variant: string;
    }
  | {
      campaignId: PromotionalCampaignId;
      outcome: 'suppressed';
      reason: CampaignSuppressionReason;
    };

export interface ActivationJourneyDeps {
  now: () => number;
  /**
   * Presents the notification. `onFailed` fires only if the OS accepts the
   * request and then refuses to present it -- see `showOsNotification`.
   */
  showNotification: (
    request: OsNotificationShowRequest,
    onFailed: (error: Error) => void,
  ) => void;
  /**
   * Instrumentation sink. Receives bounded enum ids only — campaign id,
   * suppression reason, destination page — never notification copy, per the
   * privacy rules in docs/desktop-instrumentation.md.
   */
  recordOutcome: (outcome: CampaignOutcome) => void;
  isCampaignFlagEnabled: () => boolean;
  readNotificationPreferences: () => Promise<ActivationNotificationPreferences>;
  isAppFocused: () => boolean;
  hasActivated: (campaignId: ActivationCampaignId) => Promise<boolean>;
  isCampaignEligible: (id: ActivationCampaignId) => Promise<boolean>;
  /**
   * Chooses the copy variant for a campaign. `null` means no variant applies
   * to this user, which suppresses rather than falling back — campaign 2 has
   * no neutral branch by design.
   */
  resolveVariantKey: (id: ActivationCampaignId) => Promise<VariantResolution>;
  /** Subscribe to OS resume/unlock; returns an unsubscribe function. */
  onPowerResume: (handler: () => void) => () => void;
}

let nextTimer: ReturnType<typeof setTimeout> | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribePower: (() => void) | null = null;

/** Serializes evaluations so a timer and a resume cannot interleave. */
let evaluationChain: Promise<void> = Promise.resolve();

function describeDestination(destination: CampaignDestination): string {
  return destination.kind === 'page' ? destination.page : destination.kind;
}

async function evaluateAllCampaigns(
  deps: ActivationJourneyDeps,
): Promise<number | null> {
  // Nothing is schedulable while the journey is dark, and returning before
  // the reads below keeps a dark install completely quiet -- no journey-state
  // read, no preference parse, no timer. The flag's `onSnapshotChanged`
  // listener recomputes when it flips on.
  if (!deps.isCampaignFlagEnabled()) return null;

  // `let`, not `const`: a send refreshes this snapshot (below), so the next
  // campaign's frequency-cap gate sees it. A pass reads state once, and the
  // module cache `latchCampaignSent` updates is not this object -- without
  // the refresh two campaigns due in the same pass would both send, and the
  // shared daily cap would hold everywhere except the one place two banners
  // are most likely to collide.
  let state = await readActivationJourneyState();
  const nowMs = deps.now();
  const preferences = await deps.readNotificationPreferences();
  let nextDueAt: number | null = null;

  for (const definition of getActiveCampaigns()) {
    const record = state.campaigns[definition.id];
    // Only a completed SEND is terminal. A suppressed campaign stays
    // re-evaluable on purpose: a user who suppressed as `category-disabled`
    // or `campaign-disabled` must still be reachable once they opt back in,
    // or a single bad evaluation would silently retire the campaign forever.
    if (record?.sentAt !== undefined) continue;

    const decision = await evaluateCampaign(definition, {
      state,
      nowMs,
      campaignFlagEnabled: deps.isCampaignFlagEnabled(),
      osNotificationsEnabled: preferences.enabled,
      activationCategoryEnabled: preferences.activationCategoryEnabled,
      skipWhenFocused: preferences.skipWhenFocused,
      appFocused: deps.isAppFocused(),
      inQuietHours: isWithinQuietHours(new Date(nowMs), preferences.quietHours),
      hasActivated: () => deps.hasActivated(definition.id),
      isEligible: () => deps.isCampaignEligible(definition.id),
    });

    if (decision.send) {
      const resolution = await deps.resolveVariantKey(definition.id).catch(
        (): VariantResolution => ({
          variantKey: null,
          reason: 'variant-unavailable',
        }),
      );
      const variantKey = resolution.variantKey;
      const variant =
        variantKey === null ? undefined : definition.variants[variantKey];
      if (variant === undefined || variantKey === null) {
        const reason =
          variantKey === null ? resolution.reason : 'variant-unavailable';
        const noVariant = await latchCampaignSuppressed(
          definition.id,
          reason,
          new Date(nowMs).toISOString(),
        );
        if (noVariant.changed) {
          deps.recordOutcome({
            campaignId: definition.id,
            outcome: 'suppressed',
            reason,
          });
        }
        continue;
      }
      const campaignId = definition.id;
      deps.showNotification(
        {
          id: buildCampaignNotificationId(campaignId, variantKey),
          title: variant.title,
          body: variant.body,
        },
        () => {
          // The OS took the request and then refused to present it. Undo the
          // send latch so the campaign is retried on the next evaluation,
          // and correct the funnel -- otherwise a banner nobody saw is
          // recorded as delivered and never sent again.
          void unlatchCampaignDeliveryFailure(
            campaignId,
            new Date(deps.now()).toISOString(),
          )
            .then((result) => {
              if (!result.changed) return;
              deps.recordOutcome({
                campaignId,
                outcome: 'suppressed',
                reason: 'delivery-failed',
              });
            })
            .catch(() => undefined);
        },
      );
      const sent = await latchCampaignSent(
        campaignId,
        new Date(nowMs).toISOString(),
      );
      state = sent.state;
      deps.recordOutcome({
        campaignId,
        outcome: 'delivered',
        destination: describeDestination(variant.destination),
        variant: variantKey,
      });
      continue;
    }

    // A campaign that is merely early is the ordinary "not yet" case: arm the
    // timer for its exact due time and leave no suppression record, so the
    // funnel counts only states the user actually reached.
    // `no-anchor` joins `not-yet-due` as a pre-start state rather than a
    // suppression the user reached: on a fresh install both abandonment
    // campaigns would otherwise write a record and emit telemetry once per
    // install, for a state that exists only until the first window focus.
    if (decision.reason === 'no-anchor') {
      // Bounded off first-open. Without this, a process whose window never
      // fires `focus` (hidden E2E window, autostart-minimized,
      // launch-then-switch-away) would poll for its whole lifetime -- the one
      // unbounded loop left after the poll removal.
      //
      // Stopping is safe not because a later-anchored campaign could never
      // send (it could: `expired` is measured from the campaign's OWN anchor),
      // but because writing an anchor calls `requestActivationRecompute()`,
      // which re-derives immediately. The poll is redundant with that event.
      //
      // An unreadable first-open is treated as expired rather than unbounded:
      // that is precisely the state a first-open-anchored campaign reports
      // `no-anchor` from, so leaving it null would exempt the campaigns this
      // guard names.
      const firstOpenMs =
        state.firstOpenAt === null ? NaN : Date.parse(state.firstOpenAt);
      const ceiling = Number.isNaN(firstOpenMs)
        ? null
        : firstOpenMs + definition.offsetMs + definition.maxLatenessMs;
      if (ceiling !== null && nowMs <= ceiling) {
        const retryAt = nowMs + TRANSIENT_RETRY_MS;
        nextDueAt = nextDueAt === null ? retryAt : Math.min(nextDueAt, retryAt);
      }
      continue;
    }

    if (decision.reason === 'not-yet-due') {
      const dueAt = resolveDueAt(definition, state);
      if (dueAt !== null) {
        nextDueAt = nextDueAt === null ? dueAt : Math.min(nextDueAt, dueAt);
      }
      continue;
    }

    // The shared daily cap lifts at a known instant, so arm that exact time
    // rather than the generic transient retry. Like `not-yet-due`, it is a
    // pre-start state the user has not "reached" and leaves no record.
    if (decision.reason === 'frequency-capped') {
      const liftsAt = resolvePromotionalCapLiftsAt(state);
      const dueAt = resolveDueAt(definition, state);
      const stillDeliverable =
        dueAt === null || liftsAt === null
          ? false
          : liftsAt <= dueAt + definition.maxLatenessMs;
      if (liftsAt !== null && stillDeliverable) {
        nextDueAt = nextDueAt === null ? liftsAt : Math.min(nextDueAt, liftsAt);
      }
      continue;
    }

    // Anything else transient still records the suppression (the funnel wants
    // to know the user was blocked) but must also arm a retry, or the
    // campaign is silently dead until the next launch or resume.
    //
    // The retry self-terminates: past the lateness bound the campaign can
    // never send again, so continuing to poll would keep the timer alive for
    // the process lifetime with no possible outcome.
    if (TRANSIENT_SUPPRESSION_REASONS.has(decision.reason)) {
      const dueAt = resolveDueAt(definition, state);
      const stillDeliverable =
        dueAt === null || nowMs <= dueAt + definition.maxLatenessMs;
      if (stillDeliverable) {
        const retryAt = nowMs + TRANSIENT_RETRY_MS;
        nextDueAt = nextDueAt === null ? retryAt : Math.min(nextDueAt, retryAt);
      }
    }

    const latched = await latchCampaignSuppressed(
      definition.id,
      decision.reason,
      new Date(nowMs).toISOString(),
    );
    if (latched.changed) {
      deps.recordOutcome({
        campaignId: definition.id,
        outcome: 'suppressed',
        reason: decision.reason,
      });
    }
  }

  return nextDueAt;
}

/**
 * Set by `stopActivationJourney()` and cleared by `startActivationJourney()`.
 * Guards against an evaluation that began before shutdown re-arming the timer
 * after it. Production always goes through `start`, so this is only ever
 * false during a live journey; tests that drive `recomputeActivationSchedule`
 * directly must call `resetActivationSchedulerForTests()`.
 */
let stopped = false;

/** Test-only: restore the pre-start state between cases. */
export function resetActivationSchedulerForTests(): void {
  stopped = false;
  activeDeps = null;
  clearNextTimer();
  evaluationChain = Promise.resolve();
}

/**
 * Deps of the running journey, so callers outside the composition root can
 * ask for a recompute without holding them.
 *
 * This lives here rather than in `wiring.ts` on purpose: `wiring.ts` imports
 * the portal session manager, and routing a recompute request through it
 * pulled that whole graph into `ipc/preferences.ts`, breaking an unrelated
 * test suite at import time. The scheduler is the Electron-free leaf.
 */
let activeDeps: ActivationJourneyDeps | null = null;

/**
 * Re-derive the schedule after something outside the journey changed an input
 * it depends on: the abandonment anchor, the feature flag, or notification
 * preferences. The latter two are why several suppression reasons are
 * event-driven rather than polled.
 *
 * No-ops before the journey starts and after it shuts down.
 */
export function requestActivationRecompute(): void {
  if (activeDeps === null) return;
  void recomputeActivationSchedule(activeDeps, { event: true });
}

/** Await any in-flight evaluation so shutdown cannot race a pending latch. */
export function drainActivationEvaluations(): Promise<void> {
  return evaluationChain.catch(() => undefined);
}

function clearNextTimer(): void {
  if (nextTimer !== null) {
    clearTimeout(nextTimer);
    nextTimer = null;
  }
}

/**
 * Re-derive every campaign's state from persisted timestamps and act on it.
 * Safe to call at any time; serialized so concurrent triggers cannot
 * double-fire a campaign.
 */
interface RecomputeOptions {
  /**
   * Events (launch, resume, preference changes, activity) can release refused
   * delivery holds. Timers cannot; OS authorization has no timer-driven signal.
   */
  event?: boolean;
}

export function recomputeActivationSchedule(
  deps: ActivationJourneyDeps,
  options: RecomputeOptions = {},
): Promise<void> {
  const run = async (): Promise<void> => {
    if (options.event === true) {
      await releaseDeliveryFailures(
        new Date(deps.now()).toISOString(),
        PROMOTIONAL_SEND_INTERVAL_MS,
      );
    }
    const nextDueAt = await evaluateAllCampaigns(deps);
    clearNextTimer();
    // An evaluation started before `stopActivationJourney()` can finish after
    // it. Without this guard it would re-arm the timer post-shutdown, leaving
    // a live handle the app never clears.
    if (stopped) return;
    if (nextDueAt === null) return;
    // Bound the delay: setTimeout saturates above ~24.8 days, which would
    // fire immediately in a loop.
    const delay = Math.min(
      Math.max(nextDueAt - deps.now(), 0),
      24 * 60 * 60 * 1000,
    );
    nextTimer = setTimeout(() => {
      void recomputeActivationSchedule(deps);
    }, delay);
  };
  const step = evaluationChain.then(run, run);
  evaluationChain = step.catch(() => undefined);
  return step;
}

export async function startActivationJourney(
  deps: ActivationJourneyDeps,
): Promise<void> {
  stopActivationJourney();
  stopped = false;
  activeDeps = deps;
  unsubscribePower = deps.onPowerResume(() => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      void recomputeActivationSchedule(deps, { event: true });
    }, POWER_RESUME_SETTLE_MS);
  });
  await recomputeActivationSchedule(deps, { event: true });
}

export function stopActivationJourney(): void {
  stopped = true;
  activeDeps = null;
  clearNextTimer();
  if (settleTimer !== null) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  if (unsubscribePower !== null) {
    unsubscribePower();
    unsubscribePower = null;
  }
}

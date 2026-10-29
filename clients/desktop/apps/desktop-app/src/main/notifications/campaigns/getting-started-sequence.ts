import { ONBOARDING_CHECKLIST_ITEM_IDS } from '@canopy/desktop-shared/types';
import type {
  ActivationJourneyPersistedState,
  CampaignDestination,
  CampaignSuppressionReason,
  OnboardingChecklistItemId,
  OnboardingChecklistState,
} from '@canopy/desktop-shared/types';
import {
  PROMOTIONAL_SEND_INTERVAL_MS,
  resolveLastPromotionalSendMs,
} from './campaign-config';

/**
 * Daily Getting Started notification sequence (CAN-3013).
 *
 * One campaign whose steps ARE the canonical checklist: the order comes from
 * `ONBOARDING_CHECKLIST_ITEM_IDS` and the copy table is keyed by
 * `OnboardingChecklistItemId`, so adding, removing, or reordering a checklist
 * item changes the sequence with it (and a new item without copy is a compile
 * error rather than a silent gap). Note this is the main-side checklist
 * model that `computeOnboardingChecklistState` derives from real product
 * state -- not the Home "Getting started" suggestion queue
 * (`HOME_ONBOARDING_SUGGESTION_ENTRY_IDS`), which is a different, renderer-
 * owned list. Headlines name the action each step completes.
 *
 * Semantics:
 *
 * - At most one send per {@link GETTING_STARTED_INTERVAL_MS}, measured from
 *   the most recent promotional send of ANY kind. The activation campaigns
 *   apply the same cap in `eligibility.ts`, so the guarantee is mutual: no
 *   two promotional banners within a day, from either side.
 * - Each step sends at most once per install. The sequence advances to the
 *   next incomplete, not-yet-sent item rather than repeating the one the user
 *   ignored; "select the next incomplete item" must not become a daily nag
 *   for a guest who never intends to create an account.
 * - Checklist state is read immediately before the send, so a step completed
 *   five minutes ago is skipped, and a reinstall or second device never
 *   prompts for something the live product state already shows as done.
 * - The sequence stops when the checklist is complete, when the user opts out
 *   (either promotional toggle, or dismissing the checklist itself), and
 *   {@link GETTING_STARTED_WINDOW_MS} after first open regardless.
 *
 * Electron-free and clock-free like `eligibility.ts`: every input arrives
 * through the context.
 */

const HOUR_MS = 60 * 60 * 1000;

export const GETTING_STARTED_INTERVAL_MS = PROMOTIONAL_SEND_INTERVAL_MS;

/**
 * Campaign expiration. Four daily steps need four days; two weeks leaves room
 * for quiet hours, weekends, and a closed laptop. Without a bound, shipping
 * this to an install that is months old would start onboarding nudges for a
 * user who left onboarding behind long ago.
 */
export const GETTING_STARTED_WINDOW_MS = 14 * 24 * HOUR_MS;

const MAX_HEADLINE_LENGTH = 60;
const MAX_SUBTITLE_LENGTH = 120;

export interface GettingStartedStep {
  itemId: OnboardingChecklistItemId;
  headline: string;
  subtitle: string;
  deepLink: CampaignDestination;
}

type GettingStartedStepContent = Omit<GettingStartedStep, 'itemId'>;

/**
 * Copy is brand-free on purpose (see the branding rules in CLAUDE.md). Deep
 * links reuse `CampaignDestination`, so they ride the click router's
 * buffer-until-startup-unlocked path and survive a relaunch or sign-in wall.
 */
const STEP_CONTENT: Record<
  OnboardingChecklistItemId,
  GettingStartedStepContent
> = {
  'create-account': {
    headline: 'Create an account',
    subtitle: 'Sign in to finish the first step of getting started.',
    deepLink: { kind: 'settings', section: 'account' },
  },
  'start-chat': {
    headline: 'Start a chat',
    subtitle: 'Describe a task and put an agent to work.',
    deepLink: { kind: 'page', page: 'home' },
  },
  'connect-accounts': {
    headline: 'Connect a tool',
    subtitle: 'Link an account you already use so agents can work with it.',
    deepLink: { kind: 'settings', section: 'account', target: 'integrations' },
  },
  'add-capability': {
    headline: 'Enable a skill or plugin',
    subtitle: 'Browse skills and plugins to get more done.',
    deepLink: { kind: 'plugins-discovery' },
  },
};

/** Shape accepted by validation: runtime data, not a trusted typed value. */
interface GettingStartedStepCandidate {
  headline: string;
  subtitle: string;
  deepLink: { kind: string; page?: string; section?: string };
}

function isNonBlankWithin(value: string, maxLength: number): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

function isRoutableDeepLink(
  deepLink: GettingStartedStepCandidate['deepLink'],
): boolean {
  switch (deepLink.kind) {
    case 'page':
      return typeof deepLink.page === 'string' && deepLink.page.length > 0;
    case 'settings':
      return (
        typeof deepLink.section === 'string' && deepLink.section.length > 0
      );
    case 'canopy-portal':
    case 'add-workspace':
    case 'plugins-discovery':
      return true;
    default:
      return false;
  }
}

/**
 * The three required fields, checked at send time. A step that fails is
 * suppressed rather than sent with a hole in it.
 */
export function isValidGettingStartedStep(
  step: GettingStartedStepCandidate,
): boolean {
  return (
    isNonBlankWithin(step.headline, MAX_HEADLINE_LENGTH) &&
    isNonBlankWithin(step.subtitle, MAX_SUBTITLE_LENGTH) &&
    isRoutableDeepLink(step.deepLink)
  );
}

function isChecklistItemId(value: string): value is OnboardingChecklistItemId {
  return ONBOARDING_CHECKLIST_ITEM_IDS.some((itemId) => itemId === value);
}

/** Resolve a step by id; `undefined` for ids this build's checklist lacks. */
export function getGettingStartedStep(
  itemId: string,
): GettingStartedStep | undefined {
  if (!isChecklistItemId(itemId)) return undefined;
  return { itemId, ...STEP_CONTENT[itemId] };
}

function parseTimestamp(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface GettingStartedSequenceContext {
  state: ActivationJourneyPersistedState;
  /** Epoch milliseconds, sampled by the scheduler immediately before the call. */
  nowMs: number;
  campaignFlagEnabled: boolean;
  osNotificationsEnabled: boolean;
  /** Promotional master AND the Getting Started child, already combined. */
  gettingStartedCategoryEnabled: boolean;
  skipWhenFocused: boolean;
  appFocused: boolean;
  inQuietHours: boolean;
  readChecklistState: () => Promise<OnboardingChecklistState>;
}

export type GettingStartedSequenceDecision =
  | {
      kind: 'send';
      step: GettingStartedStep;
      /** Unsent items passed over because they are already complete. */
      skippedItemIds: OnboardingChecklistItemId[];
    }
  /** Pre-start states the user has not "reached"; never recorded. */
  | {
      kind: 'wait';
      reason: 'no-anchor' | 'not-yet-due';
      retryAt: number | null;
    }
  | {
      kind: 'suppressed';
      reason: CampaignSuppressionReason;
      /** `null` when the gate failed before a step was chosen. */
      itemId: OnboardingChecklistItemId | null;
      skippedItemIds: OnboardingChecklistItemId[];
    }
  | { kind: 'finished'; skippedItemIds: OnboardingChecklistItemId[] };

function suppress(
  reason: CampaignSuppressionReason,
  itemId: OnboardingChecklistItemId | null = null,
  skippedItemIds: OnboardingChecklistItemId[] = [],
): GettingStartedSequenceDecision {
  return { kind: 'suppressed', reason, itemId, skippedItemIds };
}

/**
 * Ordered and fail-closed, mirroring `evaluateCampaign`: cheap local gates
 * run before the checklist probe, and the reported reason is the first
 * failure. One deliberate difference from the campaign gate: expiry is
 * checked BEFORE the probe. The window slides with nothing, so a long-expired
 * install should not pay for a checklist scan on every resume.
 *
 * Foreground suppression is the same `skipWhenFocused` rule every other OS
 * notification follows (on by default). The sequence only runs while the
 * checklist is live -- not complete, dismissed, or snoozed -- and a live
 * checklist is on screen whenever the app is foregrounded, so a focused app
 * already shows the guidance this would repeat.
 */
export async function evaluateGettingStartedSequence(
  context: GettingStartedSequenceContext,
): Promise<GettingStartedSequenceDecision> {
  // Kept so the function is self-contained, but unreachable in production:
  // `evaluateAllCampaigns` returns before evaluating anything while the flag
  // is dark, so the sequence never records `campaign-disabled` in the funnel.
  if (!context.campaignFlagEnabled) return suppress('campaign-disabled');
  if (context.state.holdout === true) return suppress('holdout');

  const firstOpenMs = parseTimestamp(context.state.firstOpenAt);
  if (firstOpenMs === null) {
    return { kind: 'wait', reason: 'no-anchor', retryAt: null };
  }

  const steps = context.state.gettingStarted?.steps ?? {};
  const unsentItemIds = ONBOARDING_CHECKLIST_ITEM_IDS.filter(
    (itemId) => steps[itemId]?.sentAt === undefined,
  );
  if (unsentItemIds.length === 0) {
    return { kind: 'finished', skippedItemIds: [] };
  }

  if (context.nowMs > firstOpenMs + GETTING_STARTED_WINDOW_MS) {
    return suppress('expired');
  }

  // The OS refused the last banner. That does not change on a timer, and
  // the next step would fail the same way, so the whole sequence holds on
  // the failed step until an event re-evaluates it -- the same
  // event-driven rule `delivery-failed` follows for campaigns. The scheduler
  // releases this hold on an event-driven recompute at most once a day,
  // never from its own heartbeat. Checked after expiry so a long-expired
  // install reports `expired`, not a hold it can never leave.
  const failedItemId = unsentItemIds.find(
    (itemId) => steps[itemId]?.suppressedReason === 'delivery-failed',
  );
  if (failedItemId !== undefined) {
    return suppress('delivery-failed', failedItemId);
  }

  const lastSendMs = resolveLastPromotionalSendMs(context.state);
  const dueAt = Math.max(
    firstOpenMs + GETTING_STARTED_INTERVAL_MS,
    lastSendMs === null ? 0 : lastSendMs + GETTING_STARTED_INTERVAL_MS,
  );
  if (context.nowMs < dueAt) {
    return { kind: 'wait', reason: 'not-yet-due', retryAt: dueAt };
  }

  if (!context.osNotificationsEnabled) {
    return suppress('notifications-disabled');
  }
  if (!context.gettingStartedCategoryEnabled) {
    return suppress('category-disabled');
  }
  if (context.skipWhenFocused && context.appFocused) {
    return suppress('app-focused');
  }
  if (context.inQuietHours) return suppress('quiet-hours');

  let checklist: OnboardingChecklistState;
  try {
    checklist = await context.readChecklistState();
  } catch {
    // Unknown is not "incomplete": never notify on a probe that cannot answer.
    return suppress('probe-failed');
  }

  if (checklist.dismissedAt !== null) return suppress('checklist-dismissed');

  const snoozedUntilMs = parseTimestamp(checklist.snoozedUntil);
  if (snoozedUntilMs !== null && context.nowMs < snoozedUntilMs) {
    return { kind: 'wait', reason: 'not-yet-due', retryAt: snoozedUntilMs };
  }

  const skippedItemIds: OnboardingChecklistItemId[] = [];
  for (const itemId of unsentItemIds) {
    const item = checklist.items.find((candidate) => candidate.id === itemId);
    // Absent from the computed state means the item does not apply here.
    if (item === undefined) continue;
    if (item.complete) {
      skippedItemIds.push(itemId);
      continue;
    }
    const step: GettingStartedStep = { itemId, ...STEP_CONTENT[itemId] };
    if (!isValidGettingStartedStep(step)) {
      return suppress('variant-unavailable', itemId, skippedItemIds);
    }
    return { kind: 'send', step, skippedItemIds };
  }

  return { kind: 'finished', skippedItemIds };
}

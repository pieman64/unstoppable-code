import {
  ACTIVATION_CAMPAIGN_IDS,
  GETTING_STARTED_SEQUENCE_CAMPAIGN_ID,
} from '@canopy/desktop-shared/types';
import type {
  ActivationCampaignId,
  CampaignDestination,
  OnboardingChecklistItemId,
  PromotionalCampaignId,
} from '@canopy/desktop-shared/types';
import { DEFAULT_VARIANT_KEY } from './campaign-config';
import { getGettingStartedStep } from './getting-started-sequence';
import { getCampaignVariant } from './served-config-sync';

/**
 * Activation campaign click routing (CAN-1967).
 *
 * A campaign normally fires while the app has no visible window — the ten
 * minute nudge lands after the user closed it — so a click cannot assume a
 * renderer exists. The payload is buffered until the renderer reports
 * startup-unlocked and delivery is confirmed, mirroring
 * `deep-link/deep-link-service.ts`: on a failed send the payload stays
 * buffered and a later flush retries instead of silently dropping the user's
 * click.
 *
 * Deliberately Electron-free so Jest can exercise the whole
 * parse -> buffer -> flush pipeline; `index.ts` injects the callback that
 * creates/focuses the window and pushes the payload over IPC.
 */

export const NOTIFICATION_ID_PREFIX = 'activation-campaign:';

export interface CampaignClickPayload {
  campaignId: PromotionalCampaignId;
  /** The checklist step, for Getting Started sequence clicks (CAN-3013). */
  itemId?: OnboardingChecklistItemId;
  destination: CampaignDestination;
}

interface ParsedNotificationId {
  campaignId: PromotionalCampaignId;
  /** For the Getting Started sequence this slot carries the item id. */
  variantKey: string;
}

/**
 * Returns `true` only when the payload reached a live window; `false` keeps
 * it buffered for a later retry.
 */
export type CampaignClickSender = (payload: CampaignClickPayload) => boolean;

/** Notified as soon as a valid click arrives, regardless of delivery. */
export type CampaignClickObserver = (
  campaignId: PromotionalCampaignId,
  itemId?: OnboardingChecklistItemId,
) => void;

interface ClickRouterState {
  pending: CampaignClickPayload | null;
  unlocked: boolean;
  sender: CampaignClickSender | null;
  observer: CampaignClickObserver | null;
}

const state: ClickRouterState = {
  pending: null,
  unlocked: false,
  sender: null,
  observer: null,
};

/**
 * The id carries the variant because a click arrives long after the send, and
 * the variant determines where it lands. Encoding it keeps routing stateless
 * rather than requiring a journey-state read on the click path.
 */
export function buildCampaignNotificationId(
  id: PromotionalCampaignId,
  variantKey: string = DEFAULT_VARIANT_KEY,
): string {
  return `${NOTIFICATION_ID_PREFIX}${id}:${variantKey}`;
}

/**
 * Resolve a notification id back to a campaign. Returns `null` for ids from
 * other notification sources and for well-shaped ids naming a campaign this
 * build does not define — a stale banner from a previous version must not
 * route anywhere.
 */
export function parseCampaignNotificationId(
  notificationId: string,
): ParsedNotificationId | null {
  if (!notificationId.startsWith(NOTIFICATION_ID_PREFIX)) return null;
  const rest = notificationId.slice(NOTIFICATION_ID_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;
  const campaignId = rest.slice(0, separator);
  const variantKey = rest.slice(separator + 1);
  if (variantKey.length === 0) return null;
  if (campaignId === GETTING_STARTED_SEQUENCE_CAMPAIGN_ID) {
    // Same fail-closed rule as below, against the checklist instead of the
    // campaign table: a step this build's checklist lacks routes nowhere.
    if (getGettingStartedStep(variantKey) === undefined) return null;
    return { campaignId, variantKey };
  }
  if (!isActivationCampaignId(campaignId)) return null;
  // Resolving through the definition table, not the id union alone, so an id
  // naming a campaign or variant this build does not define fails closed
  // rather than routing a stale banner into a dead destination.
  if (getCampaignVariant(campaignId, variantKey) === undefined) return null;
  return { campaignId, variantKey };
}

function isActivationCampaignId(value: string): value is ActivationCampaignId {
  return (ACTIVATION_CAMPAIGN_IDS as readonly string[]).includes(value);
}

function flushPendingClick(): void {
  if (!state.unlocked || state.pending === null || state.sender === null) {
    return;
  }
  const payload = state.pending;
  if (state.sender(payload) && state.pending === payload) {
    state.pending = null;
  }
}

export function handleCampaignNotificationClick(notificationId: string): void {
  const parsed = parseCampaignNotificationId(notificationId);
  if (parsed === null) return;

  if (parsed.campaignId === GETTING_STARTED_SEQUENCE_CAMPAIGN_ID) {
    const step = getGettingStartedStep(parsed.variantKey);
    if (step === undefined) return;
    state.observer?.(parsed.campaignId, step.itemId);
    state.pending = {
      campaignId: parsed.campaignId,
      itemId: step.itemId,
      destination: step.deepLink,
    };
    flushPendingClick();
    return;
  }

  const variant = getCampaignVariant(parsed.campaignId, parsed.variantKey);
  if (variant === undefined) return;

  state.observer?.(parsed.campaignId);
  state.pending = {
    campaignId: parsed.campaignId,
    destination: variant.destination,
  };
  flushPendingClick();
}

export function setCampaignClickSender(sender: CampaignClickSender): void {
  state.sender = sender;
  flushPendingClick();
}

export function setCampaignClickObserver(
  observer: CampaignClickObserver,
): void {
  state.observer = observer;
}

/**
 * Wired to the renderer's startup-unlocked IPC, which every fresh renderer
 * sends once — so a click buffered while the app sat windowless is retried
 * when a new window's renderer comes up.
 */
export function notifyCampaignClickStartupUnlocked(): void {
  state.unlocked = true;
  flushPendingClick();
}

export function resetCampaignClickRouterForTests(): void {
  state.pending = null;
  state.unlocked = false;
  state.sender = null;
  state.observer = null;
}

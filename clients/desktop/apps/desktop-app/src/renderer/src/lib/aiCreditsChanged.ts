import { invalidateAiCreditsAvailabilityCache } from '@/hooks/useAiCreditsAvailability';
import { announceCanopyCloudAccountChanged } from '@/lib/canopyCloudAccountChange';

/**
 * The common notification for a purchase-related AI Credits change: a fresh
 * read confirmed usable credits, or a confirmed model unlock (CAN-5026) moved
 * the balance. The billing toggle, banners, subscription status, and composer
 * balance converge on it.
 *
 * It drops the retained availability answer and dispatches a
 * `same-account-refresh` account change. Each subscriber re-reads on its own
 * schedule, so this does not complete any read synchronously. Post-turn
 * settlement and drip refreshes keep their own mechanisms.
 *
 * A credits change, never an identity change: every caller follows an
 * authoritative read, and sign-in or sign-out announce themselves.
 */
export function announceAiCreditsChanged(): void {
  invalidateAiCreditsAvailabilityCache();
  announceCanopyCloudAccountChanged('same-account-refresh');
}

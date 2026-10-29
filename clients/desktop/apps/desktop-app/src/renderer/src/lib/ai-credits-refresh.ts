import {
  readAiCreditsAvailabilityFresh,
  type AiCreditsAvailability,
} from '@/hooks/useAiCreditsAvailability';
import { invalidateAiCreditsUsageCache } from '@/hooks/useAiCreditsUsage';
import { invalidateSharedAiCreditsRead } from './openBillingPage';

/**
 * Refresh every renderer AI-credits cache after the daily free-credit drip
 * preference changes (Home card, Settings toggle, `needs-credits` Turn on, App
 * Advisor). Desktop does not subscribe to the web realtime credit signal, so
 * the availability and usage caches, and the shared per-episode read the
 * model recovery and Get AI Credits flows use, are cleared explicitly here;
 * main clears its own routing cache in the save IPC handler.
 *
 * Resolves with the settled fresh availability read so callers that must act on
 * the new balance (the `needs-credits` recovery) can await it. Never rejects:
 * callers that only invalidate can fire and forget.
 */
export function refreshAiCreditsAfterDripChange(): Promise<AiCreditsAvailability> {
  invalidateAiCreditsUsageCache();
  invalidateSharedAiCreditsRead();
  return readAiCreditsAvailabilityFresh();
}

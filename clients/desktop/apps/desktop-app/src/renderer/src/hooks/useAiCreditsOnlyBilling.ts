import { useSyncExternalStore } from 'react';
import { isAiCreditsOnlyBilling } from '@canopy/desktop-shared/lib/default-model-lane';
import {
  getRendererBillingLaneAvailability,
  subscribeRendererBillingLaneFacts,
} from '@/stores/billingLaneRuntime';

// Derived inside the snapshot so the rendered value is the subscribed value.
const getSnapshot = (): boolean =>
  isAiCreditsOnlyBilling(getRendererBillingLaneAvailability());

/**
 * Whether every turn this account can run bills to AI Credits (CAN-5028).
 * False while any billing-lane fact is still unknown, so a subscriber keeps
 * cost displays until the probes settle.
 */
export function useAiCreditsOnlyBilling(): boolean {
  return useSyncExternalStore(
    subscribeRendererBillingLaneFacts,
    getSnapshot,
    getSnapshot,
  );
}

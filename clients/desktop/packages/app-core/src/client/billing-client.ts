import type {
  BillingPaymentMethodSummary,
  BillingTopUpResponse,
  ModelLibraryUnlockSource,
} from '@canopy/protocol/billing';

/** Host-bound billing operations. Server authorization remains authoritative. */
export interface BillingClient {
  createSetupIntent(input?: {
    orgId?: string;
  }): Promise<{ clientSecret: string }>;
  confirmPaymentMethod(
    setupIntentId: string,
    input?: { orgId?: string },
  ): Promise<BillingPaymentMethodSummary>;
  topUp(input: {
    amountUsd: number;
    requestId: string;
    source?: ModelLibraryUnlockSource;
    /** Explicit organization wallet; omission selects the personal wallet. */
    orgId?: string;
  }): Promise<BillingTopUpResponse>;
  getFeePercent(): Promise<number>;
}

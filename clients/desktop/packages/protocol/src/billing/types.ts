/**
 * Which grant source is the primary one, by precedence
 * (subscription > trial > org_seat > none). Serializable wire value shared by
 * the web resolver and every consumer (incl. desktop over
 * `/api/v1/entitlements`).
 */
export type EntitlementSource = 'trial' | 'subscription' | 'org_seat' | 'none';

/** Display/navigation-only billing owner and conversion state. */
export type BillingPresentation =
  | {
      plan: { key: string; displayName: string };
      owner: { type: 'user' };
      lifecycle: 'trial' | 'paid';
      trialEndsAt: string | null;
      action: 'subscribe' | 'manage';
    }
  | {
      plan: { key: string; displayName: string };
      owner: { type: 'organization'; id: string; name: string };
      lifecycle: 'trial' | 'paid';
      trialEndsAt: string | null;
      action: 'subscribe' | 'manage' | 'view';
    };

/** Provider payment lifecycle, independent of credits and model eligibility. */
export type BillingTopUpPaymentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded';
export interface BillingTopUpResponse {
  paymentIntentId: string;
  status: BillingTopUpPaymentStatus;
  /** Actual charged account's external id, never inferred from the payer. */
  billingAccountId: string;
  totalChargeUsd: number;
  /** The webhook posted this payment's owner-scoped credit grant. */
  creditsAvailable?: boolean;
  /** Only returned to the authorized owner for authentication recovery. */
  clientSecret?: string;
}

import { isPaidBillingPlanKey, type PaidBillingPlanKey } from './plan-keys';
import { isBillingRequestId, isBillingWebReturnPath } from './top-up-intent';

/**
 * Whose payment settings a desktop handoff opens. Always explicit: a handoff
 * never infers an organization from membership order or the selected
 * workspace context.
 */
export type SettingsPaymentOwner =
  | { readonly kind: 'personal' }
  | { readonly kind: 'organization'; readonly organizationId: string };

/** The financial modals a billing page can open on arrival. */
export const BILLING_PAYMENT_MODALS = [
  'payment-method',
  'auto-top-up',
  'subscription',
] as const;

export type BillingPaymentModal = (typeof BILLING_PAYMENT_MODALS)[number];

/**
 * A one-shot request to open a billing modal after the page loads. Opening a
 * modal never submits a financial mutation; the modal keeps its own explicit
 * confirmation.
 */
export type BillingPaymentModalIntent =
  | { modal: 'payment-method'; requestId: string }
  | { modal: 'auto-top-up'; requestId: string }
  | { modal: 'subscription'; requestId: string; plan?: PaidBillingPlanKey };

export const BILLING_PAYMENT_MODAL_PARAM = 'paymentModal';
export const BILLING_PAYMENT_REQUEST_ID_PARAM = 'paymentRequestId';
const PLAN_PARAM = 'plan';
const TOP_UP_PARAM = 'topUp';

/** Parameters a consumed modal intent strips from the URL. `plan` is
 * included because a subscription intent carries it; a plan-only URL (the
 * existing `/subscribe` handoff) is not a modal intent and keeps its own
 * consumer. */
export const BILLING_PAYMENT_MODAL_INTENT_PARAMS: readonly string[] = [
  BILLING_PAYMENT_MODAL_PARAM,
  BILLING_PAYMENT_REQUEST_ID_PARAM,
  PLAN_PARAM,
];

export function isBillingPaymentModal(
  value: unknown,
): value is BillingPaymentModal {
  return BILLING_PAYMENT_MODALS.some((modal) => modal === value);
}

/**
 * Parse a modal intent from billing page query parameters. Returns `null`
 * when no intent is present and for every malformed or conflicting intent:
 * duplicate parameters, an unknown modal, an invalid request id, a plan on a
 * modal other than `subscription`, an unpaid plan, or a `topUp` intent
 * alongside `paymentModal`.
 */
export function parseBillingPaymentModalIntent(
  params: URLSearchParams,
): BillingPaymentModalIntent | null {
  if (
    [BILLING_PAYMENT_MODAL_PARAM, BILLING_PAYMENT_REQUEST_ID_PARAM, PLAN_PARAM]
      .map((key) => params.getAll(key).length)
      .some((count) => count > 1)
  )
    return null;
  const modal = params.get(BILLING_PAYMENT_MODAL_PARAM);
  if (modal === null || !isBillingPaymentModal(modal)) return null;
  if (params.has(TOP_UP_PARAM)) return null;
  const requestId = params.get(BILLING_PAYMENT_REQUEST_ID_PARAM);
  if (!isBillingRequestId(requestId)) return null;
  const plan = params.get(PLAN_PARAM);
  if (modal === 'subscription') {
    if (plan === null) return { modal, requestId };
    if (!isPaidBillingPlanKey(plan)) return null;
    return { modal, requestId, plan };
  }
  if (plan !== null) return null;
  return { modal, requestId };
}

/**
 * Append a modal intent to an owner-specific billing path such as
 * `accountBillingPath()` or `organizationBillingPath(id)`, retaining unrelated
 * query parameters and the hash. Throws when the result would not parse back
 * to the same intent (for example a path that already carries `topUp`, or a
 * plan on a non-subscription intent).
 */
export function buildBillingPaymentModalIntentPath(
  billingPath: string,
  intent: BillingPaymentModalIntent,
): string {
  if (!isBillingWebReturnPath(billingPath))
    throw new Error('Invalid billing path');
  const url = new URL(billingPath, 'https://billing.invalid');
  url.searchParams.delete(BILLING_PAYMENT_MODAL_PARAM);
  url.searchParams.delete(BILLING_PAYMENT_REQUEST_ID_PARAM);
  url.searchParams.set(BILLING_PAYMENT_MODAL_PARAM, intent.modal);
  url.searchParams.set(BILLING_PAYMENT_REQUEST_ID_PARAM, intent.requestId);
  if (intent.modal === 'subscription' && intent.plan !== undefined)
    url.searchParams.set(PLAN_PARAM, intent.plan);
  const parsed = parseBillingPaymentModalIntent(url.searchParams);
  if (
    parsed === null ||
    parsed.modal !== intent.modal ||
    parsed.requestId !== intent.requestId ||
    (parsed.modal === 'subscription' &&
      intent.modal === 'subscription' &&
      parsed.plan !== intent.plan)
  )
    throw new Error('Invalid payment modal intent');
  return url.pathname + url.search + url.hash;
}

/**
 * Remove a consumed modal intent's parameters from a URL, keeping every
 * unrelated parameter and the hash. Returns the relative path to pass to a
 * history replacement.
 */
export function stripBillingPaymentModalIntentParams(href: string): string {
  const url = new URL(href, 'https://billing.invalid');
  for (const key of BILLING_PAYMENT_MODAL_INTENT_PARAMS)
    url.searchParams.delete(key);
  return url.pathname + url.search + url.hash;
}

import type { ModelLibraryAccess } from '../models/model-library-access';
import type { WorkOwner } from '../llm-gateway';
export type DailyDripBlockedReason = 'network_limit' | 'network_unidentified';

export function isDailyDripBlockedReason(
  value: unknown,
): value is DailyDripBlockedReason {
  return value === 'network_limit' || value === 'network_unidentified';
}

import type { BillingPresentation, EntitlementSource } from './types';
import {
  selectedContextOrganization,
  type WorkspaceContext,
  type WorkspaceContextOrganization,
} from '../workspace-context';

export type {
  BillingPresentation,
  EntitlementSource,
  BillingTopUpResponse,
  BillingTopUpPaymentStatus,
} from './types';

/**
 * Capability keys that plans grant (billing_plans.capabilities). APPEND-ONLY:
 * add new perks to the end, never remove/renumber. Consumers (incl. desktop
 * over /api/v1/entitlements) MUST ignore unknown keys for forward compat.
 */
export const BILLING_CAPABILITIES = [
  // Deprecated: no longer gates sharing on current clients; retained for older
  // desktop builds, which still floor sharing to Just me without it.
  'data_sync_control',
  'teams', // org business features (org-side gate)
  'org_credit_pool', // org shared overage credit pool
  'priority_support', // elevated support tier (above community)
  'remote_control', // Remote Control (Portal) from the web (Pro + Business)
  'enforce_sharing_transcripts', // org may require/prohibit member transcript sharing
  'enforce_sharing_plans', // org may require/prohibit member plan sharing
  'enforce_sharing_summaries', // org may require/prohibit member session-summary sharing
  'enforce_sharing_metadata', // org may require/prohibit member usage-metadata sharing
  'enforce_model_policy', // org may restrict which AI models members can use
  'custom_model_gateway', // org may route members through its own model gateway
] as const;

export type BillingCapability = (typeof BILLING_CAPABILITIES)[number];

/**
 * Free AI credits an opted-in user wallet tops up to each Pacific day. The daily
 * drip is off by default; users turn it on explicitly. Mirrors
 * billing_plans.daily_drip_cap_credits (the plan cap, shown even to opted-out
 * users so they can see what turning it on gets them).
 */
export const DEFAULT_DAILY_DRIP_CAP_CREDITS = 10;

const BILLING_CAPABILITY_SET: ReadonlySet<string> = new Set(
  BILLING_CAPABILITIES,
);

/** Type guard + forward-compat filter for untrusted capability values (Json / wire). */
export function isBillingCapability(
  value: unknown,
): value is BillingCapability {
  return typeof value === 'string' && BILLING_CAPABILITY_SET.has(value);
}

/**
 * Canonical organization billing settings path shared by web and desktop.
 *
 * The helper owns the WHOLE query string, including the optional `?plan=`
 * upgrade intent that `/subscribe` hands off. Callers must not append their own
 * `&plan=` to the returned value: doing so silently depends on this function
 * always emitting a `?`, so changing the shape here (renaming the param, moving
 * billing back to its own route, adding a hash) would produce malformed URLs at
 * those call sites with no type error and no test failure. Keeping the query
 * under this function is the point of sharing it.
 */
export function organizationBillingPath(
  orgId: string,
  options?: { plan?: string },
): string {
  const params = new URLSearchParams({ tab: 'billing' });
  // Truthiness, not `!== undefined`: an empty plan would emit a bare `plan=`,
  // which is meaningless in the URL and would have to be matched-and-ignored by
  // every consumer. (Today's consumer compares `intentPlanKey === targetPlanKey`
  // and so treats it as inert rather than misfiring — this is hygiene, not a
  // live bug being fixed.) No caller can produce one now, since `/subscribe`
  // validates `planKey` first, but this is a shared protocol helper with an
  // open contract and should not depend on every caller pre-validating.
  if (options?.plan) {
    params.set('plan', options.plan);
  }
  return `/organization/${encodeURIComponent(orgId)}/settings?${params.toString()}`;
}

/** Canonical personal billing path, optionally carrying a conversion intent. */
export function accountBillingPath(options?: { plan?: string }): string {
  if (!options?.plan) return '/account/billing';
  const params = new URLSearchParams({ plan: options.plan });
  return `/account/billing?${params.toString()}`;
}

/**
 * Whose AI Credits the account menu's AI Credits row stands for: the selected
 * organization's credit pool, or the person's own wallet.
 */
export type CreditsBillingTarget =
  | { readonly kind: 'personal' }
  | { readonly kind: 'organization'; readonly organizationId: string };

/**
 * Where the AI Credits hand-off goes for the selected navigation context. Only
 * an OWNER can fund the selected organization's pool, so only an OWNER is sent
 * to that organization's credits; everyone else, and the Personal context, gets
 * their own wallet. Hosts show the balance of the same target, so the number
 * in the menu is the one the destination page manages.
 */
export function resolveCreditsBillingTarget(
  context: WorkspaceContext,
  organizations: readonly WorkspaceContextOrganization[],
): CreditsBillingTarget {
  const organization = selectedContextOrganization(context, organizations);
  return organization?.role === 'OWNER'
    ? { kind: 'organization', organizationId: organization.id }
    : { kind: 'personal' };
}

/** The billing page that manages a {@link CreditsBillingTarget}. */
export function creditsBillingTargetPath(target: CreditsBillingTarget): string {
  return target.kind === 'organization'
    ? organizationBillingPath(target.organizationId)
    : accountBillingPath();
}

/** Stable key for a {@link CreditsBillingTarget}, for keying balance reads. */
export function creditsBillingTargetKey(target: CreditsBillingTarget): string {
  return target.kind === 'organization'
    ? `org:${target.organizationId.toLowerCase()}`
    : 'personal';
}

/** {@link creditsBillingTargetPath} of {@link resolveCreditsBillingTarget}. */
export function resolveCreditsBillingPath(
  context: WorkspaceContext,
  organizations: readonly WorkspaceContextOrganization[],
): string {
  return creditsBillingTargetPath(
    resolveCreditsBillingTarget(context, organizations),
  );
}

/**
 * The caller's resolved billing entitlements: primary plan + capability union +
 * trial state + covering orgs. Pure/serializable wire contract (no Prisma/Node
 * deps). Gates are written against `capabilities` (capability keys), never plan
 * names; consumers MUST ignore unknown capability keys for forward compat.
 */
export * from './top-up-intent';
export * from './plan-keys';
export * from './payment-intent';

export interface Entitlements {
  /** Personal context only. Organization work uses its owner-scoped response. */
  modelLibrary?: ModelLibraryAccess;
  /** Authorized request work owner; never replaces personal `modelLibrary`. */
  workModelLibrary?: { owner: WorkOwner; access: ModelLibraryAccess };
  /** Authoritative server free access; older servers omit this field. */
  freeAccess?: boolean;
  /** Primary plan by precedence (subscription > trial > org_seat > none). */
  plan: { key: string; displayName: string } | null;
  source: EntitlementSource;
  /** Trial state, or null when there is no trial. `active` indicates whether that trial is currently running (`false` once it has ended). */
  trial: { active: boolean; endsAt: string } | null;
  /** De-duped UNION of capabilities across all grant sources. */
  capabilities: BillingCapability[];
  /** Billing-active orgs granting this user a personal-scope cap (org externalId). */
  coveringOrgs: Array<{ id: string; name: string }>;
  /**
   * Whether at least one `coveringOrgs` entry covers this user through a
   * GENUINELY PAID org seat (an `ACTIVE` org subscription) rather than an org
   * free-trial window or a `TRIALING` org subscription. `coveringOrgs`
   * intentionally INCLUDES trial-only orgs — a trialing Business org grants the
   * non-paid-only `remote_control` cap — but a user's own paid personal plan is
   * only truly REDUNDANT when a durable paid org seat covers it; a trial may
   * lapse. Consumers that tell a user "your personal plan is not needed" MUST
   * gate on this, NOT on `coveringOrgs.length`.
   * APPEND-ONLY / optional on the wire: older servers omit it, so consumers MUST
   * default a missing value to `false`.
   */
  hasPaidOrgSeatCoverage?: boolean;
  /**
   * Org this user can manage billing for (OWNER/ADMIN), for deep-link routing
   * (e.g. desktop → {@link organizationBillingPath}). The `id` is the org
   * externalId. Present only when the user manages exactly one org. Null when
   * the user manages zero or multiple orgs (or the route did not request it).
   * APPEND-ONLY / backward compatible: optional on the wire — older servers may
   * omit it entirely — so consumers MUST default a missing value to `null`.
   */
  billingManageableOrg?: { id: string; name: string } | null;
  /**
   * The highest-priced plan the caller should SEE (e.g. the desktop subscription
   * badge), ranked by the plan's face `monthlyPriceUsd` across the caller's own
   * live subscription and the orgs they MANAGE (OWNER/ADMIN) — including an org
   * that is only on trial. This lets an owner of a pricier (even trialing) org
   * see that plan even when their cheaper personal subscription is the
   * wallet-primary `plan`/`source` above. `source` here is the grant it came from
   * (`'subscription'` or `'org_seat'`). The caller's personal free-trial window
   * is excluded — a plain trial stays represented by `trial`/`source: 'trial'`.
   *
   * DISTINCT from `plan`/`source`, which remain the personal-primary grant that
   * credit-allotment and gating logic depend on — do NOT use `displayPlan` for
   * wallet or capability decisions. APPEND-ONLY / optional on the wire: older
   * servers omit it, so consumers MUST default a missing value to `null` and
   * fall back to `plan`/`source`.
   */
  displayPlan?: {
    key: string;
    displayName: string;
    source: EntitlementSource;
  } | null;
  /**
   * Conversion-tier presentation and its exact billing owner. Display and
   * navigation only; never use this field for capability or authorization.
   * Optional for compatibility with older servers.
   */
  billingPresentation?: BillingPresentation | null;
  /**
   * The per-credit SALE price (USD) the caller pays when buying AI credits —
   * their primary plan's `creditPriceUsd`, or the free list price ($0.60) when
   * there is no active paid plan. Distinct from the global burn valuation: this
   * is what a credit COSTS to buy for this caller (Pro $0.40, Business $0.30,
   * free/no plan $0.60), so a top-up UI can render "you'll get ~N credits" from
   * an entered USD amount.
   * APPEND-ONLY / optional on the wire: older servers omit it, so consumers MUST
   * default a missing value to the free list price ($0.60).
   */
  aiCreditPriceUsd?: number;
}

/** Does the entitlement set grant capability `c`? */
export function can(
  e: { capabilities: readonly BillingCapability[] },
  c: BillingCapability,
): boolean {
  return e.capabilities.includes(c);
}

// ---------------------------------------------------------------------------
// Daily free AI-credit drip opt-in
// ---------------------------------------------------------------------------

/**
 * A user's daily free-credit drip preference. `decidedAt` is non-null once the
 * user answered (either way) on any device; it hides the onboarding opt-in card.
 * `capCredits` is the PLAN cap (ungated), so an opted-out user can be shown what
 * turning the drip on gets them.
 */
export interface DailyCreditDripPreference {
  enabled: boolean;
  /** ISO-8601 timestamp of the user's last answer, or `null` if undecided. */
  decidedAt: string | null;
  capCredits: number;
}

/** Body of a daily-drip preference save (PUT). */
export interface DailyCreditDripPreferenceInput {
  enabled: boolean;
}

/**
 * Response of a daily-drip preference save. The preference write is committed
 * whenever this is returned; `balanceCredits` is `null` when the post-save
 * balance read failed (the client should re-fetch), and `granted` is the drip
 * amount minted by the save (`0` when disabling or already granted today).
 */
export type DailyCreditDripPreferenceSaveResult = DailyCreditDripPreference & {
  blockedReason?: DailyDripBlockedReason;
  balanceCredits: number | null;
  granted: number;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Narrow an unknown decoded JSON value to a {@link DailyCreditDripPreference}.
 * Unknown extra keys are ignored (forward compat); every known field must have
 * its exact type. Returns `null` on any mismatch.
 */
export function parseDailyCreditDripPreference(
  value: unknown,
): DailyCreditDripPreference | null {
  if (!isPlainRecord(value)) return null;
  const { enabled, decidedAt, capCredits } = value;
  if (typeof enabled !== 'boolean') return null;
  if (decidedAt !== null && !isIsoTimestamp(decidedAt)) return null;
  if (!isNonNegativeFiniteNumber(capCredits)) return null;
  return { enabled, decidedAt, capCredits };
}

/**
 * Narrow an unknown decoded request body to a
 * {@link DailyCreditDripPreferenceInput}. Strict: `enabled` must be a boolean
 * and no other keys are accepted, so a malformed or misdirected body is
 * rejected instead of partially applied.
 */
export function parseDailyCreditDripPreferenceInput(
  value: unknown,
): DailyCreditDripPreferenceInput | null {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'enabled') return null;
  const { enabled } = value;
  if (typeof enabled !== 'boolean') return null;
  return { enabled };
}

/**
 * Narrow an unknown decoded JSON value to a
 * {@link DailyCreditDripPreferenceSaveResult}. Returns `null` on any mismatch.
 */
export function parseDailyCreditDripPreferenceSaveResult(
  value: unknown,
): DailyCreditDripPreferenceSaveResult | null {
  const preference = parseDailyCreditDripPreference(value);
  if (preference === null || !isPlainRecord(value)) return null;
  const { balanceCredits, granted, blockedReason } = value;
  if (blockedReason !== undefined && !isDailyDripBlockedReason(blockedReason))
    return null;
  if (
    balanceCredits !== null &&
    (typeof balanceCredits !== 'number' || !Number.isFinite(balanceCredits))
  ) {
    return null;
  }
  if (!isNonNegativeFiniteNumber(granted)) return null;
  return {
    ...preference,
    balanceCredits,
    granted,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
  };
}
export {
  computeSubscriptionStatus,
  type SubscriptionStatus,
  type SubscriptionStatusInput,
  type SubscriptionStatusKind,
  type SubscriptionStatusTone,
} from './subscription-status';

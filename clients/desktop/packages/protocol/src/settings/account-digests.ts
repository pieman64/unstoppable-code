// ---------------------------------------------------------------------------
// Personal Work Digest settings contracts. The archive, profile-feature and
// report shapes below moved verbatim from
// `apps/web/src/lib/digests/digest-profile-contracts.ts`, which re-exports
// them. The cadence preferences contract lives in `@canopy/protocol/digests`.
// ---------------------------------------------------------------------------

export type DigestArchiveCadence = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ON_DEMAND';

export type DigestArchiveStatus =
  | 'PENDING'
  | 'GENERATING'
  | 'READY'
  | 'SKIPPED_EMPTY'
  | 'SKIPPED_INELIGIBLE'
  | 'FAILED';

export type DigestArchiveVariant = 'FULL' | 'NUDGE';

/** The canonical serialized row returned by personal and organization archives. */
export interface DigestArchiveItem {
  externalId: string;
  cadence: DigestArchiveCadence;
  periodStart: string;
  periodEnd: string;
  headline: string | null;
  variant: DigestArchiveVariant;
  status: DigestArchiveStatus;
  billedCredits: number | null;
  createdAt: string;
}

export interface DigestProfileAudience {
  organizationId: string;
  organizationName: string;
  featured: boolean;
  /**
   * The org has lost the `teams` capability, so its members cannot open a
   * featured digest even if one is granted.
   *
   * Reported rather than used to filter the org out of the list: a lapsed org
   * that is already `featured` still needs its toggle so the owner can
   * un-feature it. The UI disables only the OFF→ON direction, matching
   * `setDigestProfileFeature`, which gates granting but never revocation.
   */
  lapsed: boolean;
}

export interface MemberProfileDigestListResponse {
  items: DigestArchiveItem[];
}

export interface DigestProfileFeatureResponse {
  organizationId: string;
  featured: boolean;
}

/**
 * Browser-safe report shape used by protected profile detail reads.
 *
 * Deliberately has no `sharingEnabled`: that field describes whether the
 * OWNER's anonymous capability link is live, which is the owner's sharing
 * posture rather than anything about the featured report. It is withheld here
 * for the same reason `shareSlug`/`sharePath` are — see `serializeDigest`.
 */
export interface DigestReportData {
  externalId: string;
  subjectType: string;
  cadence: string;
  periodStart: string;
  periodEnd: string;
  headline: string | null;
  executiveSummaryMarkdown: string | null;
  bodyMarkdown: string | null;
  metrics: unknown;
  variant: string;
}

/**
 * The owner's view of one personal digest (`GET /api/account/digests/[id]` and
 * the `/account/digests/[id]` page). The report fields plus the owner's
 * sharing posture. `shareSlug`/`sharePath` are optional because the shared
 * serializer omits them for viewers who cannot manage sharing; a personal
 * digest always has a single owner, so they are present in practice.
 */
export interface AccountDigestDetail extends DigestReportData {
  sharingEnabled?: boolean;
  shareSlug?: string;
  sharePath?: string;
}

/** `PATCH /api/account/digests/[id]` body. */
export type DigestShareUpdateRequest =
  | { action: 'rotate' }
  | { action: 'set-sharing'; sharingEnabled: boolean };

/** `POST /api/account/digests` body: inclusive UTC calendar dates. */
export interface DigestOnDemandRequest {
  /** `YYYY-MM-DD`. */
  startDate: string;
  /** `YYYY-MM-DD`; at most 90 days after `startDate`, never after today. */
  endDate: string;
}

/** `200`/`202` body of `POST /api/account/digests`. */
export interface DigestOnDemandRequestResult {
  status: 'already_exists' | 'enqueued' | 'publishing_disabled';
  digestExternalId: string;
}

/** Server-read funding for an on-demand digest request form. */
export interface DigestRequestCredits {
  /** Whether the payer has anything to spend right now. */
  spendable: boolean;
  /** The payer wallet's balance, in credits. */
  balanceCredits: number;
  /** Change key over every source the payer may draw on. */
  fundingKey: number;
  /** Organization whose pool backs the wallet once it empties, or null. */
  fundingLabel: string | null;
}
